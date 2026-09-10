import http from "http";
import net from "net";
import os from "os";
import { loadConfig, resolveDataPath } from "./config";
import { readStatic } from "./static";
import { fromText, fromUrl } from "../kit/convert";
import { mergeParsed } from "../kit/merge";
import assemble from "../kit/assemble";
import { assembleAcl, findPreset } from "../kit/acl4ssr/build";
import { createStore } from "../subscription/store";
import { createCoordinator } from "../subscription/coordinator";
import { createSubscriptionRouter } from "../subscription/router";

export { loadConfig };

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, type) {
    res.statusCode = status;
    if (Buffer.isBuffer(body)) {
        if (type) res.setHeader("content-type", type);
        res.end(body);
        return;
    }
    if (typeof body === "string") {
        res.setHeader("content-type", type || "text/plain; charset=utf-8");
        res.end(body);
        return;
    }
    if (body && typeof body === "object") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body, null, 2));
        return;
    }
    res.end(String(body == null ? "" : body));
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) ? n : fallback;
}

// TCP ping: connect to host:port and measure the round-trip time.
// Returns { host, port, delay } on success, or { host, port, delay: -1, error } on failure.
function tcpPing(host, port, timeout) {
    return new Promise((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();
        let settled = false;
        const done = (delay, error) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_e) { /* ignore */ }
            resolve({ host, port, delay, error: error || undefined });
        };
        socket.setTimeout(timeout || 5000);
        socket.once("connect", () => done(Date.now() - start));
        socket.once("timeout", () => done(-1, "timeout"));
        socket.once("error", (e) => done(-1, e && e.message ? e.message : "error"));
        try {
            socket.connect(port, host);
        } catch (e) {
            done(-1, e && e.message ? e.message : "connect failed");
        }
    });
}

// Run TCP pings with concurrency control (Promise pool).
async function pingMany(targets, timeout, concurrency) {
    const limit = Math.max(1, Math.min(concurrency || 32, 128));
    const results = new Array(targets.length);
    let index = 0;
    async function worker() {
        while (index < targets.length) {
            const i = index++;
            const t = targets[i];
            results[i] = await tcpPing(t.host, Number(t.port) || 443, timeout);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, () => worker()));
    return results;
}

// Detect LAN IP addresses (non-internal IPv4).
function getLanIps() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === "IPv4" && !iface.internal) {
                ips.push({ name, address: iface.address });
            }
        }
    }
    return ips;
}

function collectNodes(parsed) {
    const nodes = [];
    const push = (o, kind) => {
        if (!o || typeof o.tag !== "string") return;
        const server =
            o.server || (o.peers && o.peers[0] && o.peers[0].address) || "";
        const port =
            o.server_port || (o.peers && o.peers[0] && o.peers[0].port) || "";
        nodes.push({ tag: o.tag, type: o.type, server, port, kind });
    };
    (parsed.outbounds || []).forEach((o) => push(o, "outbound"));
    (parsed.endpoints || []).forEach((o) => push(o, "endpoint"));
    return nodes;
}

function normalizeRules(raw) {
    if (raw == null) return undefined;
    if (typeof raw === "string") {
        return raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
    }
    return raw;
}

function normalizeOptions(options, config) {
    options = options || {};
    // No run shape is forwarded: the kit has one profile and it is Tower's.
    // A caller passing mode/addMixed/inboundPort/tun just gets that shape;
    // see SETTINGS_KEYS in subscription/router.js for the same call at the
    // saved-settings level.
    return {
        includeUnsupportedProxy: options.includeUnsupportedProxy === true,
        final: options.final || undefined,
        proxyGroupTag: options.proxyGroupTag || undefined,
        userAgent: options.userAgent || undefined,
        timeout: asNumber(options.timeout, undefined),
        headers:
            options.headers &&
            typeof options.headers === "object" &&
            !Array.isArray(options.headers)
                ? options.headers
                : undefined,
        remoteDns: options.remoteDns || config.remoteDns || undefined,
        addAutoGroup: options.addAutoGroup,
        addDirect: options.addDirect,
        addBlock: options.addBlock,
        // A known ACL4SSR preset switches assembly to the ACL builder; an
        // unknown id is ignored so a stale client falls back to the default
        // skeleton instead of erroring.
        aclPreset: findPreset(options.aclPreset) ? options.aclPreset : undefined,
        rules: normalizeRules(options.rules),
    };
}

// Normalise the request body into a list of subscription sources. Two shapes
// are accepted so the legacy single-input contract stays intact:
//   { input: <string>, url?: true }                    (single source)
//   { sources: [{ input: <string>, url?: true }, ...] } (multi-source merge)
// A `sources` array wins when present and non-empty; anything else falls back
// to the legacy `input` field.
function resolveSourceList(body) {
    body = body || {};
    if (Array.isArray(body.sources) && body.sources.length > 0) {
        return body.sources.map((s) => ({
            input: s && typeof s.input === "string" ? s.input : "",
            url: !!(s && s.url),
        }));
    }
    if (typeof body.input === "string") {
        return [{ input: body.input, url: !!body.url }];
    }
    return [];
}

// Download-aware subset of the options inspection previews honour, so a URL
// subscription is fetched with the same UA/headers/timeout as a real convert.
function inspectOptions(options) {
    options = options || {};
    return {
        userAgent: options.userAgent || undefined,
        headers: options.headers,
        timeout: asNumber(options.timeout, undefined),
    };
}

// Parse one resolved source (input + optional url flag) into a parsed doc.
async function parseSource(source, options) {
    const input = source.input;
    const urlMode = source.url === true || /^https?:\/\//i.test(input.trim());
    return urlMode
        ? await fromUrl(input.trim(), options)
        : fromText(input, options);
}

// Core convert handler, exported for tests. Accepts either a single `input`
// (legacy) or a `sources` array; multi-source documents are tag-deduped before
// being assembled into one config.
export async function convertRequest(body, config) {
    const sources = resolveSourceList(body);
    if (sources.length === 0) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: "missing input: provide a string field 'input' or a non-empty 'sources' array",
            },
        };
    }
    const normalized = normalizeOptions(body.options, config);
    // Surface sing-box 1.16 auto-migrations on the success payload.
    const warnings = [];
    normalized.onWarning = (ws) => {
        for (const w of ws) warnings.push(w);
    };
    const outMode =
        body.out === "outbounds" ? "outbounds" : config.defaultOut || "config";

    const parsedList = [];
    for (let i = 0; i < sources.length; i += 1) {
        const input = sources[i].input;
        if (typeof input !== "string" || input.trim() === "") {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: "source #" + (i + 1) + " input is empty",
                },
            };
        }
        try {
            parsedList.push(await parseSource(sources[i], normalized));
        } catch (e) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error:
                        "source #" + (i + 1) + ": " +
                        (e && e.message ? e.message : String(e)),
                },
            };
        }
    }

    const parsed = mergeParsed(parsedList, warnings);
    const outbounds = parsed.outbounds || [];
    const endpoints = parsed.endpoints || [];
    if (outbounds.length === 0 && endpoints.length === 0) {
        return {
            status: 400,
            payload: { ok: false, error: "no nodes parsed from input" },
        };
    }

    const data = {
        outbounds,
        endpoints,
        nodes: collectNodes(parsed),
    };
    if (outMode === "outbounds") {
        data.output = { outbounds, endpoints };
    } else {
        let configJson;
        try {
            configJson = normalized.aclPreset
                ? assembleAcl(parsed, normalized)
                : assemble(parsed, normalized);
        } catch (e) {
            // Startup-rejection findings surface as 4xx so the client can act
            // on the migration hints, not as a server fault.
            const compat = !!(e && e.name === "CompatError");
            return {
                status: compat ? 422 : 500,
                payload: {
                    ok: false,
                    error: e && e.message ? e.message : String(e),
                },
            };
        }
        data.output = configJson;
    }
    if (warnings.length > 0) data.warnings = warnings;
    data.mode = outMode;
    return { status: 200, payload: { ok: true, data } };
}

// Lightweight inspection handler (exported for tests): parses each source and
// reports node counts + protocol distribution WITHOUT assembling a config, so
// the subscription tab can show what a source contains before it is exported.
// A failing source reports an error on its own row rather than failing the
// whole preview (HTTP stays 200) - the UI can flag that row instead of dying.
export async function inspectRequest(body, config) {
    const sources = resolveSourceList(body);
    if (sources.length === 0) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: "missing input: provide a string field 'input' or a non-empty 'sources' array",
            },
        };
    }
    const opts = inspectOptions(body.options);
    const perSource = [];
    let totalNodes = 0;
    for (let i = 0; i < sources.length; i += 1) {
        const rec = { nodeCount: 0, outboundCount: 0, endpointCount: 0, protocols: {} };
        const input = sources[i].input;
        if (typeof input !== "string" || input.trim() === "") {
            rec.error = "input is empty";
            perSource.push(rec);
            continue;
        }
        try {
            const parsed = await parseSource(sources[i], opts);
            rec.outboundCount = (parsed.outbounds || []).length;
            rec.endpointCount = (parsed.endpoints || []).length;
            for (const n of collectNodes(parsed)) {
                rec.nodeCount += 1;
                rec.protocols[n.type] = (rec.protocols[n.type] || 0) + 1;
            }
        } catch (e) {
            rec.error = e && e.message ? e.message : String(e);
        }
        totalNodes += rec.nodeCount;
        perSource.push(rec);
    }
    return {
        status: 200,
        payload: { ok: true, data: { sources: perSource, totalNodes } },
    };
}

// createServer(config, deps)
//
// `deps` is optional and exists so tests can inject a temp store, a mock fetch
// and a fixed clock. Production callers keep using createServer(config) and the
// subscription store is built from the config's dataPath.
export function createServer(config, deps) {
    config = config || loadConfig();
    deps = deps || {};
    const store = deps.store || createStore({ dataPath: resolveDataPath(config) });
    const coordinator = deps.coordinator || createCoordinator();
    const subscriptions = createSubscriptionRouter({
        store,
        coordinator,
        config,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
    });

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            const pathname = decodeURIComponent(url.pathname);

            // Read + JSON-parse the POST body once for every JSON API route.
            async function readJsonBody() {
                const raw = await readBody(req, config.maxBodyBytes || 1048576);
                try {
                    return JSON.parse(raw.toString("utf8") || "{}");
                } catch (e) {
                    return null;
                }
            }

            if (
                req.method === "POST" &&
                (pathname === "/api/convert" || pathname === "/api/inspect")
            ) {
                const body = await readJsonBody();
                if (body === null) {
                    send(res, 400, { ok: false, error: "invalid JSON body" });
                    return;
                }
                const result =
                    pathname === "/api/inspect"
                        ? await inspectRequest(body, config)
                        : await convertRequest(body, config);
                send(res, result.status, result.payload);
                return;
            }

            // TCP ping: measure latency to proxy servers.
            if (req.method === "POST" && pathname === "/api/ping") {
                const body = await readJsonBody();
                if (body === null || !Array.isArray(body.targets)) {
                    send(res, 400, { ok: false, error: "invalid JSON body; expects { targets: [{host, port}] }" });
                    return;
                }
                const timeout = asNumber(body.timeout, 5000);
                const concurrency = asNumber(body.concurrency, 32);
                const results = await pingMany(body.targets, timeout, concurrency);
                send(res, 200, { ok: true, data: { results } });
                return;
            }

            // LAN info: returns local network IPs for sharing.
            if (req.method === "GET" && pathname === "/api/lan") {
                const lanIps = getLanIps();
                const port = config.listen.port;
                const urls = lanIps.map((iface) => ({
                    name: iface.name,
                    url: "http://" + iface.address + ":" + port,
                }));
                send(res, 200, { ok: true, data: { lanIps: urls } });
                return;
            }

            // Subscription store: GET|HEAD /sub/<token> plus the management
            // API. Runs before the method check below because it answers
            // PATCH/DELETE/PUT as well as GET/HEAD.
            const handled = await subscriptions.handle(req, res, {
                url,
                pathname,
                readJsonBody,
                sendJson: send,
            });
            if (handled) return;

            if (req.method !== "GET" && req.method !== "HEAD") {
                send(res, 405, { ok: false, error: "method not allowed" });
                return;
            }

            // static assets: embedded into the single-file bundle, or read from
            // public/ when running from source (see static.js / static.embedded.js)
            const rel = pathname === "/" ? "/index.html" : pathname;
            const body = readStatic(rel);
            if (body == null) {
                send(res, 404, "not found");
                return;
            }
            const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
            if (ext === ".html") {
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Pragma", "no-cache");
            }
            send(res, 200, body, MIME[ext] || "application/octet-stream");
        } catch (e) {
            send(res, 500, {
                ok: false,
                error: e && e.message ? e.message : String(e),
            });
        }
    });

    // Exposed so callers (and tests) can close the store's write queue before
    // exiting instead of losing a queued write.
    server.subscriptionStore = store;
    return server;
}

export function start(config, deps) {
    config = config || loadConfig();
    const server = createServer(config, deps);
    const { host, port } = config.listen;
    return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
    });
}

export default {
    createServer,
    start,
    convertRequest,
    inspectRequest,
    loadConfig,
};
