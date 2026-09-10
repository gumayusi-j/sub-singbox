// HTTP surface of the subscription store.
//
// Two families of route live here:
//
//   /sub/<token>       the stable address a client is pointed at once and then
//                      polls forever. The client dialect comes from the
//                      request's User-Agent (or an explicit ?target=), which is
//                      what makes one URL work for sing-box, Clash, Surge, ...
//   /api/subscript…    the management API the web UI drives.
//
// handle() returns true when it dealt with the request, so the caller can fall
// through to the static assets without knowing anything about subscriptions.

import { refreshMany, refreshSource } from "./refresh";
import { renderSubscription, isNotModified } from "./render";
import { resolveTarget, listTargets } from "./targets";
import { usageSummary } from "./usage";
import { parseNodes } from "../kit/convert";
import { findPreset } from "../kit/acl4ssr/build";

const API_ROOT = "/api/subscriptions";
const SUB_ROOT = "/sub/";

// The options a saved default may carry. Only the ACL4SSR preset: a config's
// run shape is not a choice here. Tower hardcodes one (a TUN `tun-in`, the DNS
// skeleton, CN-direct rules) and so does this - see kit/defaults.js, whose
// "client" profile is the fallthrough whenever no mode is passed.
//
// `out` and `tun` are deliberately absent for a second reason: `out` decides
// the response shape (a full config versus a bare outbounds fragment), so a
// stray "outbounds" saved here would silently strip every client's config down
// to that fragment, with no way back from the URL.
const SETTINGS_KEYS = ["aclPreset"];

// The options a client-visible render is made from: the saved server-side
// defaults first, then whatever the caller overrides. /sub/<token> and
// /api/export both go through here on purpose - keeping only one of them in
// sync with the saved settings was the original bug, where a choice made in the
// UI reached the export page but never the address the client actually polls.
function renderOptionsFor(store, overrides) {
    const defaults = (store.getSettings() || {}).defaultOptions || {};
    const merged = {};
    for (const key of SETTINGS_KEYS) {
        if (defaults[key] !== undefined && defaults[key] !== null) {
            merged[key] = defaults[key];
        }
    }
    const overlay = overrides || {};
    for (const key of Object.keys(overlay)) {
        if (overlay[key] !== undefined && overlay[key] !== null) {
            merged[key] = overlay[key];
        }
    }
    return merged;
}

// Filter an API settings body down to what may be persisted. A null means
// "clear this field"; the store deletes the key for it.
//
// Only the rule preset survives. Everything the rules page used to expose
// besides it (run shape, mixed fallback, inbound port, remote DNS, extra
// rules) is either Tower's default or belongs to the deployment config, so a
// stored value for it would be a knob with no UI left to turn it back.
function sanitizeSettingsPatch(body) {
    const raw = body && typeof body === "object" ? body : {};
    const patch = {};
    if (raw.aclPreset !== undefined) {
        patch.aclPreset = findPreset(raw.aclPreset) ? raw.aclPreset : null;
    }
    return patch;
}

function redactUrl(value) {
    if (typeof value !== "string" || value === "") return value;
    try {
        const parsed = new URL(value);
        const names = Array.from(parsed.searchParams.keys());
        if (names.length === 0) return value;
        // Query strings carry subscription tokens; show the keys, hide values.
        return (
            parsed.origin +
            parsed.pathname +
            "?" +
            names.map((name) => name + "=***").join("&")
        );
    } catch (_e) {
        return value;
    }
}

export function createSubscriptionRouter(options) {
    options = options || {};
    const store = options.store;
    const coordinator = options.coordinator;
    const config = options.config || {};
    const settings = config.subscription || {};
    const fetchImpl = options.fetchImpl;
    const now = options.now || (() => new Date());

    function apiGuard(req) {
        const required = config.apiToken;
        if (!required) return true;
        return (req.headers["authorization"] || "") === "Bearer " + required;
    }

    function summarize(source, reveal) {
        const record = {
            id: source.id,
            name: source.name,
            kind: source.kind,
            enabled: source.enabled,
            createdAt: source.createdAt,
            lastAttemptAt: source.lastAttemptAt,
            lastCheckedAt: source.lastCheckedAt,
            lastUpdatedAt: source.lastUpdatedAt,
            lastError: source.lastError,
            nodeCount: source.nodeCount,
            protocols: source.protocols,
            usage: source.usage,
            usageSummary: usageSummary(source.usage, now()),
            requestOptions: source.requestOptions,
            // The stable per-source address, relative so the client can prefix
            // whatever host it actually reached the server on.
            subUrl: SUB_ROOT + source.token,
            hasContent: typeof source.content === "string" && source.content !== "",
        };
        if (reveal) {
            record.url = source.url;
            record.content = source.content;
        } else {
            record.url = redactUrl(source.url);
        }
        return record;
    }

    function collectionPayload() {
        const model = store.read();
        return {
            sources: model.sources.map((source) => summarize(source, false)),
            settings: model.settings.defaultOptions || {},
            globalSubUrl: SUB_ROOT + model.settings.globalToken,
            targets: listTargets(),
            dataPath: store.dataPath,
        };
    }

    // Nodes in the shape the existing web UI already renders for /api/convert.
    function displayNodes(nodeLists) {
        const out = [];
        for (const nodes of nodeLists) {
            for (const node of nodes) {
                if (!node || typeof node !== "object") continue;
                out.push({
                    tag: node.name,
                    type: node.type,
                    server: node.server || "",
                    port: node.port || node.server_port || "",
                    kind: "outbound",
                });
            }
        }
        return out;
    }

    // ---- /sub/<token> ------------------------------------------------------

    async function serveSubscription(req, res, url, token) {
        const resolved = store.resolveToken(token);
        if (!resolved) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ ok: false, error: "unknown subscription token" }));
            return;
        }

        const resolvedTarget = resolveTarget({
            userAgent: req.headers["user-agent"],
            queryTarget: url.searchParams.get("target"),
            unknownUaTarget: settings.unknownUaTarget,
            allowedTargets: settings.allowedTargets,
        });
        if (!resolvedTarget) {
            // Deliberately loud: a client handed a dialect it did not ask for
            // would just show an empty list, which is far harder to diagnose.
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(
                JSON.stringify({
                    ok: false,
                    error: "unrecognised User-Agent; pass ?target=<id>",
                    targets: listTargets(),
                }),
            );
            return;
        }

        const srcParam = url.searchParams.get("src");
        // Saved defaults first, URL parameters over them: an address handed out
        // earlier keeps working, and ?acl= still forces a one-off preset.
        const options = renderOptionsFor(store, {
            out: url.searchParams.get("out") || undefined,
            aclPreset: url.searchParams.get("acl") || undefined,
        });
        if (options.out === undefined) options.out = config.defaultOut;
        if (options.remoteDns === undefined) options.remoteDns = config.remoteDns;

        const rendered = renderSubscription(
            store,
            resolved,
            Object.assign(options, {
                target: resolvedTarget.target,
                sourceIds: srcParam
                    ? srcParam.split(",").map((value) => value.trim()).filter(Boolean)
                    : null,
                usageHeader: settings.exposeUsageHeader,
            }),
        );

        if (settings.cacheSeconds > 0) {
            rendered.headers["Cache-Control"] =
                "public, max-age=" + settings.cacheSeconds;
        }

        if (rendered.status === 200 && isNotModified(rendered, req.headers)) {
            res.statusCode = 304;
            for (const [name, value] of Object.entries(rendered.headers)) {
                if (name === "Content-Type") continue;
                res.setHeader(name, value);
            }
            res.end();
            return;
        }

        const payload =
            typeof rendered.body === "string"
                ? rendered.body
                : JSON.stringify(rendered.body, null, 2);
        const buffer = Buffer.from(payload, "utf8");

        res.statusCode = rendered.status;
        for (const [name, value] of Object.entries(rendered.headers)) {
            res.setHeader(name, value);
        }
        res.setHeader("Content-Length", String(buffer.length));
        // HEAD runs the whole path so its headers match GET byte for byte; only
        // the body is dropped.
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        res.end(buffer);
    }

    // ---- /api/subscriptions* ----------------------------------------------

    async function handleApi(req, res, url, pathname, readJsonBody, sendJson) {
        const method = req.method === "HEAD" ? "GET" : req.method;

        if (pathname === API_ROOT) {
            if (method === "GET") {
                sendJson(res, 200, { ok: true, data: collectionPayload() });
                return;
            }
            if (method === "POST") {
                const body = await readJsonBody();
                if (body === null) {
                    sendJson(res, 400, { ok: false, error: "invalid JSON body" });
                    return;
                }
                let created;
                try {
                    created = store.addSource({
                        name: body.name,
                        kind: body.kind,
                        url: body.url,
                        content: body.content,
                        enabled: body.enabled,
                        requestOptions: body.requestOptions,
                    });
                } catch (e) {
                    sendJson(res, 400, { ok: false, error: e.message });
                    return;
                }
                sendJson(res, 200, { ok: true, data: { source: summarize(created, true) } });
                return;
            }
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
        }

        // POST /api/subscriptions/refresh — a batch, or every enabled source.
        if (pathname === API_ROOT + "/refresh" && method === "POST") {
            const body = (await readJsonBody()) || {};
            const result = await refreshMany(store, body.ids, {
                fetchImpl,
                coordinator,
                now,
            });
            sendJson(res, 200, {
                ok: true,
                data: {
                    refreshed: result.results.length,
                    failed: result.failed,
                    skipped: result.skipped,
                    sources: result.results.map((entry) =>
                        summarize(store.get(entry.id) || { id: entry.id }, false),
                    ),
                },
            });
            return;
        }

        if (pathname.startsWith(API_ROOT + "/")) {
            const rest = pathname.slice(API_ROOT.length + 1);
            const slash = rest.indexOf("/");
            const rawId = slash < 0 ? rest : rest.slice(0, slash);
            const action = slash < 0 ? null : rest.slice(slash + 1);
            const id = decodeURIComponent(rawId || "");
            const source = store.get(id);

            if (action === null) {
                if (!source) {
                    sendJson(res, 404, { ok: false, error: "unknown subscription id" });
                    return;
                }
                if (method === "GET") {
                    sendJson(res, 200, { ok: true, data: { source: summarize(source, true) } });
                    return;
                }
                if (method === "PATCH" || method === "POST") {
                    const body = await readJsonBody();
                    if (body === null) {
                        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
                        return;
                    }
                    const patch = {};
                    for (const key of ["name", "kind", "url", "content", "enabled"]) {
                        if (body[key] !== undefined) patch[key] = body[key];
                    }
                    if (body.requestOptions !== undefined) {
                        patch.requestOptions = body.requestOptions;
                    }
                    const updated = store.updateSource(id, patch);
                    if (!updated) {
                        sendJson(res, 404, { ok: false, error: "unknown subscription id" });
                        return;
                    }
                    sendJson(res, 200, { ok: true, data: { source: summarize(updated, true) } });
                    return;
                }
                if (method === "DELETE") {
                    coordinator.invalidate(id);
                    const removed = store.removeSource(id);
                    sendJson(res, 200, { ok: true, data: { removed } });
                    return;
                }
                sendJson(res, 405, { ok: false, error: "method not allowed" });
                return;
            }

            if (action === "refresh" && method === "POST") {
                if (coordinator.isRunning(id)) {
                    sendJson(res, 409, {
                        ok: false,
                        error: "a refresh for this source is already running",
                    });
                    return;
                }
                const result = await refreshSource(store, id, { fetchImpl, coordinator, now });
                const latest = store.get(id);
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        ok: result.ok,
                        changed: result.changed === true,
                        error: result.error || null,
                        source: latest ? summarize(latest, false) : null,
                    },
                });
                return;
            }

            if (action === "rotate-token" && method === "POST") {
                const rotated = store.rotateToken(id);
                if (!rotated) {
                    sendJson(res, 404, { ok: false, error: "unknown subscription id" });
                    return;
                }
                sendJson(res, 200, { ok: true, data: { subUrl: SUB_ROOT + rotated.token } });
                return;
            }

            if (action === "preview" && method === "GET") {
                if (!source) {
                    sendJson(res, 404, { ok: false, error: "unknown subscription id" });
                    return;
                }
                // Cache-only: no network, so this is instant and cannot fail
                // because a panel happens to be down right now.
                const text = store.readSnapshot(id);
                if (typeof text !== "string" || text.trim() === "") {
                    sendJson(res, 409, {
                        ok: false,
                        error: "no snapshot yet; refresh the subscription first",
                    });
                    return;
                }
                const nodes = parseNodes(text);
                const protocols = {};
                for (const node of nodes) {
                    const type =
                        node && typeof node.type === "string" ? node.type : "unknown";
                    protocols[type] = (protocols[type] || 0) + 1;
                }
                sendJson(res, 200, {
                    ok: true,
                    data: {
                        source: summarize(source, false),
                        nodeCount: nodes.length,
                        protocols,
                        nodes: displayNodes([nodes]),
                        usageSummary: usageSummary(source.usage, now()),
                    },
                });
                return;
            }

            sendJson(res, 404, { ok: false, error: "unknown subscription action" });
            return;
        }

        // ---------------------------------------------------------------- misc

        if (pathname === "/api/settings/rotate-token" && method === "POST") {
            const rotated = store.rotateToken(null);
            sendJson(res, 200, { ok: true, data: { subUrl: SUB_ROOT + rotated.token } });
            return;
        }

        if (pathname === "/api/settings" && (method === "PUT" || method === "POST")) {
            const body = (await readJsonBody()) || {};
            const saved = store.setDefaultOptions(sanitizeSettingsPatch(body));
            sendJson(res, 200, { ok: true, data: { settings: saved } });
            return;
        }

        if (pathname === "/api/export" && method === "POST") {
            const body = (await readJsonBody()) || {};
            const resolvedTarget =
                resolveTarget({ queryTarget: body.target || settings.defaultTarget }) ||
                resolveTarget({ queryTarget: "sing-box" });

            const bodyOptions = body.options || {};
            // Same defaults and same precedence as /sub/<token>: what the
            // export page shows and what a client polls must never disagree.
            const options = renderOptionsFor(store, {
                out: body.out || undefined,
                aclPreset: bodyOptions.aclPreset,
            });
            if (options.out === undefined) options.out = config.defaultOut;
            if (options.remoteDns === undefined) options.remoteDns = config.remoteDns;

            const rendered = renderSubscription(
                store,
                { kind: "global" },
                Object.assign(options, {
                    target: resolvedTarget.target,
                    sourceIds: Array.isArray(body.ids) ? body.ids : null,
                    idsExact: true,
                    usageHeader: false,
                }),
            );
            if (rendered.status !== 200) {
                sendJson(res, rendered.status, rendered.body);
                return;
            }

            // Shape the payload exactly like /api/convert, so the existing UI
            // result renderer needs no changes at all.
            const nodes = [];
            for (const source of rendered.sources) {
                const text = store.readSnapshot(source.id);
                if (typeof text !== "string") continue;
                nodes.push(...displayNodes([parseNodes(text)]));
            }
            const data = {
                nodes,
                output:
                    resolvedTarget.target.mode === "singbox"
                        ? JSON.parse(rendered.body)
                        : rendered.body,
                mode: body.out === "outbounds" ? "outbounds" : "config",
            };
            if (rendered.warnings && rendered.warnings.length > 0) {
                data.warnings = rendered.warnings;
            }
            sendJson(res, 200, { ok: true, data });
            return;
        }

        sendJson(res, 404, { ok: false, error: "not found" });
    }

    // handle() -> true when the request was answered here.
    async function handle(req, res, ctx) {
        const pathname = ctx.pathname;

        if (pathname === "/sub" || pathname.startsWith(SUB_ROOT)) {
            if (req.method !== "GET" && req.method !== "HEAD") {
                ctx.sendJson(res, 405, { ok: false, error: "method not allowed" });
                return true;
            }
            await serveSubscription(req, res, ctx.url, decodeURIComponent(pathname.slice(SUB_ROOT.length)));
            return true;
        }

        const isApiRoute =
            pathname === API_ROOT ||
            pathname.startsWith(API_ROOT + "/") ||
            pathname === "/api/settings" ||
            pathname.startsWith("/api/settings/") ||
            pathname === "/api/export";
        if (isApiRoute) {
            if (!apiGuard(req)) {
                ctx.sendJson(res, 401, { ok: false, error: "unauthorized" });
                return true;
            }
            await handleApi(req, res, ctx.url, pathname, ctx.readJsonBody, ctx.sendJson);
            return true;
        }

        return false;
    }

    return { handle, collectionPayload, summarize };
}

export default { createSubscriptionRouter };
