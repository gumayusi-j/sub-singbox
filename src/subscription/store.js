// Persistent subscription store.
//
// One JSON document holds every source's *metadata*; each source's raw
// subscription text lives in its own snapshot file next to it. The split is
// deliberate: a single subscription body runs to hundreds of kilobytes, and
// inlining it would make every metadata edit rewrite the whole array.
//
// The snapshot holds the untouched response body rather than a parse result.
// That body is the one invariant from which *any* client dialect can be
// re-derived later (ProxyUtils.parse + produce), so keeping it is what lets
// /sub/<token> serve Clash, Surge and sing-box from the same stored data.
//
// Everything here is injectable (fs, clock, id/token generators) so the store
// can be exercised against a temp directory without touching the real one.

import nodeFs from "fs";
import nodePath from "path";
import nodeCrypto from "crypto";

export const STORE_VERSION = 1;

// How long the store keeps retrying an atomic replace that the OS refuses.
// On Windows a virus scanner or the search indexer can hold a handle on the
// target file for a few milliseconds right after it is written, and rename
// fails with EPERM/EBUSY. Three tries over ~60ms clears that in practice.
const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 20;

export function generateToken(crypto) {
    return (crypto || nodeCrypto).randomBytes(32).toString("base64url");
}

function generateId(crypto) {
    const c = crypto || nodeCrypto;
    if (typeof c.randomUUID === "function") {
        return c.randomUUID().replace(/-/g, "").slice(0, 12);
    }
    return c.randomBytes(9).toString("hex").slice(0, 12);
}

function emptyModel() {
    return {
        version: STORE_VERSION,
        updatedAt: null,
        settings: {
            globalToken: null,
            defaultOptions: {},
        },
        sources: [],
    };
}

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Fill in anything a store written by an older build (or a hand-edited file)
// may be missing, so callers never have to guard every field access.
function normalizeModel(raw) {
    const model = emptyModel();
    if (!isPlainObject(raw)) return model;
    model.version = STORE_VERSION;
    model.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
    if (isPlainObject(raw.settings)) {
        if (typeof raw.settings.globalToken === "string") {
            model.settings.globalToken = raw.settings.globalToken;
        }
        if (isPlainObject(raw.settings.defaultOptions)) {
            model.settings.defaultOptions = deepClone(raw.settings.defaultOptions);
        }
    }
    if (Array.isArray(raw.sources)) {
        model.sources = raw.sources.filter(isPlainObject).map(normalizeSource);
    }
    return model;
}

function normalizeSource(raw) {
    return {
        id: typeof raw.id === "string" ? raw.id : "",
        name: typeof raw.name === "string" ? raw.name : "",
        kind: raw.kind === "text" ? "text" : "url",
        url: typeof raw.url === "string" ? raw.url : "",
        content: typeof raw.content === "string" ? raw.content : null,
        enabled: raw.enabled !== false,
        token: typeof raw.token === "string" ? raw.token : "",
        requestOptions: normalizeRequestOptions(raw.requestOptions),
        createdAt: raw.createdAt || null,
        lastAttemptAt: raw.lastAttemptAt || null,
        lastCheckedAt: raw.lastCheckedAt || null,
        lastUpdatedAt: raw.lastUpdatedAt || null,
        lastError: normalizeError(raw.lastError),
        contentHash: typeof raw.contentHash === "string" ? raw.contentHash : null,
        nodeCount: Number.isInteger(raw.nodeCount) ? raw.nodeCount : 0,
        protocols: isPlainObject(raw.protocols) ? raw.protocols : {},
        usage: isPlainObject(raw.usage) ? raw.usage : null,
    };
}

function normalizeRequestOptions(raw) {
    if (!isPlainObject(raw)) return { userAgent: null, headers: {}, timeout: null };
    const headers = {};
    if (isPlainObject(raw.headers)) {
        for (const name of Object.keys(raw.headers)) {
            if (raw.headers[name] != null) headers[name] = String(raw.headers[name]);
        }
    }
    return {
        userAgent:
            typeof raw.userAgent === "string" && raw.userAgent.trim() !== ""
                ? raw.userAgent
                : null,
        headers,
        timeout: Number.isFinite(raw.timeout) && raw.timeout > 0 ? raw.timeout : null,
    };
}

function normalizeError(raw) {
    if (!isPlainObject(raw) || typeof raw.message !== "string") return null;
    return {
        message: raw.message,
        status: Number.isInteger(raw.status) ? raw.status : null,
        at: raw.at || null,
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// createStore({ dataPath, snapshotsDir, now, fs, crypto, logger })
//
//   dataPath ..... path to the JSON document (required)
//   snapshotsDir  defaults to "<dataPath without .json>.snapshots"
//   now ......... () => Date, for tests
//   fs .......... fs module (default: node fs)
//   crypto ...... crypto module (default: node crypto)
export function createStore(options) {
    options = options || {};
    const fs = options.fs || nodeFs;
    const crypto = options.crypto || nodeCrypto;
    const now = options.now || (() => new Date());
    const dataPath = options.dataPath;
    if (!dataPath) throw new Error("createStore: dataPath is required");
    const snapshotsDir =
        options.snapshotsDir ||
        nodePath.join(
            nodePath.dirname(dataPath),
            nodePath.basename(dataPath).replace(/\.json$/i, "") + ".snapshots",
        );
    const logger = options.logger || ((msg) => process.stderr.write(msg + "\n"));

    let model = null;
    // Identity of the file as we last saw it, so a second process writing the
    // same document is noticed instead of silently overwritten.
    let loadedStamp = null;
    // Every mutation appends to this chain, which is what keeps concurrent
    // refreshes from interleaving their writes.
    let writeQueue = Promise.resolve();

    function stampOf() {
        try {
            const st = fs.statSync(dataPath);
            return st.mtimeMs + ":" + st.size;
        } catch (_e) {
            return null;
        }
    }

    function load() {
        if (model) return model;
        if (!fs.existsSync(dataPath)) {
            model = emptyModel();
            model.settings.globalToken = generateToken(crypto);
            loadedStamp = null;
            return model;
        }
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        } catch (e) {
            const backup = dataPath + ".corrupt-" + Date.now();
            try {
                fs.renameSync(dataPath, backup);
            } catch (_e2) {
                // Nothing else to try; the parse error is still reported.
            }
            logger(
                "[singbox-kit] data file is not valid JSON (" +
                    (e && e.message ? e.message : e) +
                    "); moved to " + backup + " and starting empty",
            );
            model = emptyModel();
            model.settings.globalToken = generateToken(crypto);
            loadedStamp = null;
            return model;
        }
        model = normalizeModel(raw);
        if (!model.settings.globalToken) model.settings.globalToken = generateToken(crypto);
        for (const source of model.sources) {
            if (!source.id) source.id = generateId(crypto);
            if (!source.token) source.token = generateToken(crypto);
        }
        loadedStamp = stampOf();
        return model;
    }

    function stampChangedSinceLoad() {
        const current = stampOf();
        if (current === null) return false; // file removed; treat as ours to write
        return loadedStamp !== null && current !== loadedStamp;
    }

    async function renameWithRetry(from, to) {
        let lastError;
        for (let i = 0; i < RENAME_RETRIES; i += 1) {
            try {
                fs.renameSync(from, to);
                return;
            } catch (e) {
                lastError = e;
                if (i < RENAME_RETRIES - 1) await delay(RENAME_RETRY_DELAY_MS);
            }
        }
        throw lastError;
    }

    // Write the model out. Only the retry sleep is asynchronous, so a caller
    // that awaits the returned promise knows the bytes reached the disk.
    async function writeModel() {
        if (stampChangedSinceLoad()) {
            logger(
                "[singbox-kit] data file changed on disk since it was loaded; " +
                    "this process is the writer of record and will overwrite it",
            );
        }
        fs.mkdirSync(nodePath.dirname(dataPath), { recursive: true });
        model.updatedAt = now().toISOString();
        const tmp = dataPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(model, null, 2), {
            encoding: "utf8",
            mode: 0o600,
        });
        // Keep one previous revision so a bad edit stays recoverable.
        if (fs.existsSync(dataPath)) {
            try {
                fs.copyFileSync(dataPath, dataPath + ".bak");
            } catch (_e) {
                // A missing backup is not worth failing the write over.
            }
        }
        await renameWithRetry(tmp, dataPath);
        try {
            fs.chmodSync(dataPath, 0o600);
        } catch (_e) {
            // Windows ignores POSIX modes; nothing to do.
        }
        loadedStamp = stampOf();
    }

    function enqueueWrite() {
        writeQueue = writeQueue.then(writeModel, writeModel);
        return writeQueue;
    }

    // mutate(fn): fn receives the live model, edits it in place, and its return
    // value is handed back. The disk write queues behind any in-flight one.
    function mutate(fn) {
        const live = load();
        const result = fn(live);
        enqueueWrite().catch((e) => {
            logger(
                "[singbox-kit] failed to persist data file: " +
                    (e && e.message ? e.message : e),
            );
        });
        return result;
    }

    function snapshotPath(id) {
        // The id is generated by this module, but never trust a path segment
        // that came out of a JSON document.
        const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_");
        return nodePath.join(snapshotsDir, safe + ".txt");
    }

    const store = {
        get dataPath() {
            return dataPath;
        },
        get snapshotsDir() {
            return snapshotsDir;
        },

        load,
        // Read-only deep copy, so API handlers cannot mutate live state.
        read() {
            return deepClone(load());
        },
        flush() {
            return writeQueue;
        },

        list() {
            return load().sources;
        },
        get(id) {
            if (typeof id !== "string") return null;
            return load().sources.find((s) => s.id === id) || null;
        },
        getSettings() {
            return load().settings;
        },

        addSource(input) {
            input = input || {};
            const kind = input.kind === "text" ? "text" : "url";
            const body = kind === "text" ? input.content : input.url;
            if (typeof body !== "string" || body.trim() === "") {
                throw new Error(
                    "source requires a non-empty " +
                        (kind === "text" ? "content" : "url"),
                );
            }
            return mutate((live) => {
                const source = normalizeSource({
                    id: generateId(crypto),
                    name:
                        typeof input.name === "string" && input.name.trim() !== ""
                            ? input.name.trim()
                            : "订阅 " + (live.sources.length + 1),
                    kind,
                    url: kind === "url" ? input.url.trim() : "",
                    content: kind === "text" ? input.content : null,
                    enabled: input.enabled !== false,
                    token: generateToken(crypto),
                    requestOptions: input.requestOptions,
                    createdAt: now().toISOString(),
                });
                // Guard against the (vanishingly unlikely) id collision, so a
                // new source can never adopt another one's snapshot file.
                while (live.sources.some((s) => s.id === source.id)) {
                    source.id = generateId(crypto);
                }
                live.sources.push(source);
                return source;
            });
        },

        updateSource(id, patch) {
            return mutate((live) => {
                const index = live.sources.findIndex((s) => s.id === id);
                if (index < 0) return null;
                const current = live.sources[index];
                const next = normalizeSource(Object.assign({}, current, patch));
                next.id = current.id;
                next.token = current.token;
                next.createdAt = current.createdAt;
                // A different URL or body invalidates the stored content hash,
                // so the next refresh re-parses instead of short-circuiting.
                if (patch && (patch.url !== undefined || patch.content !== undefined)) {
                    const changed =
                        (patch.url !== undefined && patch.url !== current.url) ||
                        (patch.content !== undefined && patch.content !== current.content);
                    if (changed) next.contentHash = null;
                }
                live.sources[index] = next;
                return next;
            });
        },

        // Refresh-engine path: merge fields into a source without the edit-time
        // normalisation updateSource applies (a refresh must not clear the
        // content hash it just computed).
        patchSource(id, patch) {
            return mutate((live) => {
                const index = live.sources.findIndex((s) => s.id === id);
                if (index < 0) return null;
                const next = Object.assign({}, live.sources[index], patch);
                next.id = live.sources[index].id;
                next.token = live.sources[index].token;
                live.sources[index] = next;
                return next;
            });
        },

        removeSource(id) {
            const removed = mutate((live) => {
                const index = live.sources.findIndex((s) => s.id === id);
                if (index < 0) return false;
                live.sources.splice(index, 1);
                return true;
            });
            if (removed) store.removeSnapshot(id);
            return removed;
        },

        // A null value removes the key rather than storing a null. Callers use
        // null to mean "the user cleared this field"; without this the null
        // would linger in the data file and read back as if it were a value.
        setDefaultOptions(patch) {
            return mutate((live) => {
                const next = Object.assign({}, live.settings.defaultOptions);
                for (const key of Object.keys(patch || {})) {
                    if (patch[key] === null) delete next[key];
                    else next[key] = patch[key];
                }
                live.settings.defaultOptions = next;
                return next;
            });
        },

        rotateToken(id) {
            return mutate((live) => {
                const token = generateToken(crypto);
                if (id == null) {
                    live.settings.globalToken = token;
                    return { scope: "global", token };
                }
                const source = live.sources.find((s) => s.id === id);
                if (!source) return null;
                source.token = token;
                return { scope: "source", id, token };
            });
        },

        // Map a /sub/<token> path segment back to what it addresses. The global
        // token is checked first so the merged view can never be shadowed by a
        // source whose token happens to collide.
        resolveToken(token) {
            if (typeof token !== "string" || token === "") return null;
            const live = load();
            if (live.settings.globalToken && live.settings.globalToken === token) {
                return { kind: "global" };
            }
            const source = live.sources.find((s) => s.token === token);
            return source ? { kind: "source", source } : null;
        },

        readSnapshot(id) {
            try {
                return fs.readFileSync(snapshotPath(id), "utf8");
            } catch (_e) {
                return null;
            }
        },

        writeSnapshot(id, text) {
            fs.mkdirSync(snapshotsDir, { recursive: true });
            const path = snapshotPath(id);
            const tmp = path + ".tmp";
            fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
            fs.renameSync(tmp, path);
            return path;
        },

        removeSnapshot(id) {
            try {
                fs.unlinkSync(snapshotPath(id));
            } catch (_e) {
                // Already gone; nothing to clean up.
            }
        },
    };

    return store;
}

export default { createStore, generateToken, STORE_VERSION };
