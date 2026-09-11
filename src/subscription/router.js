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
import { resolveTarget, listTargets, listExportTargets } from "./targets";
import { usageSummary } from "./usage";
import { parseNodes, downloadText } from "../kit/convert";
import { findScheme, normalizeScheme, schemeFromImport, CUSTOM_PREFIX, MAX_SCHEMES } from "../kit/schemes";
import { normalizeNodeFilter } from "../kit/nodes/filter";
import { importRules } from "../kit/rules/import";
import crypto from "crypto";

// What the rules page shows after an import. The counts are the honest part -
// a rule the target cannot express is dropped, and saying so is the difference
// between "imported" and "imported the half of it that fit".
function importReport(imported) {
    return {
        format: imported.format,
        rules: imported.stats.rules,
        skipped: imported.stats.skipped,
        groups: imported.groups.length,
        final: imported.final,
        droppedByType: imported.stats.droppedByType,
        warnings: imported.warnings.slice(0, 20),
    };
}

// A name for an import that the user did not name. The source's own label
// where there is one, and never embellished - a plain name stays plain.
function defaultSchemeName(imported, url) {
    if (typeof url === "string" && url !== "") {
        try {
            const parsed = new URL(url);
            const last = parsed.pathname.split("/").filter(Boolean).pop();
            if (last) return last.slice(0, 80);
            if (parsed.hostname) return parsed.hostname.slice(0, 80);
        } catch (_e) {
            // Fall through to the format-based name.
        }
    }
    if (imported.format === "mihomo") return "导入的 Clash 规则";
    if (imported.format === "surge") return "导入的 Surge 规则";
    return "导入的规则";
}

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
const SETTINGS_KEYS = ["aclPreset", "nodeFilter", "ipv6Enabled"];

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
function sanitizeSettingsPatch(body, customSchemes) {
    const raw = body && typeof body === "object" ? body : {};
    const patch = {};
    if (raw.aclPreset !== undefined) {
        // An id has to name something that exists right now, or clearing it
        // leaves a saved pointer at a scheme the user has since deleted.
        patch.aclPreset = findScheme(raw.aclPreset, customSchemes) ? raw.aclPreset : null;
    }
    if (raw.nodeFilter !== undefined) {
        patch.nodeFilter = normalizeNodeFilter(raw.nodeFilter);
    }
    if (raw.ipv6Enabled !== undefined) {
        patch.ipv6Enabled = raw.ipv6Enabled === true;
    }
    return patch;
}

// The address the export page shows a client link on. Display-only: it never
// reaches the renderer, so it lives beside globalToken rather than inside the
// render options (see the note in store.js).
//
// Returns undefined for "not this key / unusable value", null for "clear it",
// and a normalised origin otherwise. The caller turns undefined into a 400
// rather than storing a wrong address silently - the whole point of the field
// is that someone will paste this into a client.
const PUBLIC_URL_MAX = 200;

export function sanitizePublicUrl(value) {
    // null is the project-wide "clear this field" signal, not a bad value.
    // Checked before the type test because typeof null is "object".
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    const raw = value.trim();
    if (raw === "") return null;
    if (raw.length > PUBLIC_URL_MAX) return undefined;
    // A bare host:port is what people actually type, so accept it.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
    let parsed;
    try {
        parsed = new URL(withScheme);
    } catch (_e) {
        return undefined;
    }
    // Anything but http(s) is refused rather than normalised: "javascript:" and
    // "data:" parse fine and would end up as a link in the page.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!parsed.hostname) return undefined;
    // origin drops any trailing slash and path for free, so the frontend can
    // concatenate without doing its own cleanup.
    return parsed.origin;
}

// Settings that are not render options. Returns null when the body carries
// none, false when the value is unusable, and a patch otherwise - the caller
// answers 400 for false rather than storing nothing and looking like it worked.
function sanitizeTopLevelSettings(body) {
    const raw = body && typeof body === "object" ? body : {};
    const patch = {};

    if (raw.publicUrl !== undefined) {
        const value = sanitizePublicUrl(raw.publicUrl);
        if (value === undefined) return false;
        patch.publicUrl = value;
    }

    if (raw.customSchemes !== undefined) {
        // Entries that do not normalize are dropped individually rather than
        // failing the whole request: one card the user cannot render should
        // not block them from saving the rest.
        const list = Array.isArray(raw.customSchemes) ? raw.customSchemes : [];
        const schemes = [];
        for (const item of list) {
            const scheme = normalizeScheme(item);
            if (scheme !== null) schemes.push(scheme);
            if (schemes.length >= MAX_SCHEMES) break;
        }
        // An empty list clears the field, matching the null-means-delete
        // convention the store uses everywhere else.
        patch.customSchemes = schemes.length > 0 ? schemes : null;
    }

    return Object.keys(patch).length > 0 ? patch : null;
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
            excludedNodes: source.excludedNodes || [],
            nodeOrder: source.nodeOrder || [],
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
        // The dropdown offers the exportable subset, minus anything the
        // deployment disallows. Without the intersection the UI could hand out
        // a ?target= the server answers 400 to, which is a link that looks
        // fine right up until a client polls it.
        const allowed = (settings.allowedTargets || []).filter(
            (id) => typeof id === "string",
        );
        return {
            sources: model.sources.map((source) => summarize(source, false)),
            settings: model.settings.defaultOptions || {},
            customSchemes: model.settings.customSchemes || [],
            publicUrl: model.settings.publicUrl || "",
            globalSubUrl: SUB_ROOT + model.settings.globalToken,
            targets: listExportTargets().filter(
                (t) => allowed.length === 0 || allowed.indexOf(t.id) !== -1,
            ),
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
                    if (body.excludedNodes !== undefined) {
                        patch.excludedNodes = Array.isArray(body.excludedNodes)
                            ? body.excludedNodes.filter((n) => typeof n === "string")
                            : [];
                    }
                    if (body.nodeOrder !== undefined) {
                        patch.nodeOrder = Array.isArray(body.nodeOrder)
                            ? body.nodeOrder.filter((n) => typeof n === "string")
                            : [];
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
            const top = sanitizeTopLevelSettings(body);
            if (top === false) {
                sendJson(res, 400, {
                    ok: false,
                    error: "publicUrl must be an http(s) address",
                });
                return;
            }
            // Top-level settings first: a single request may both add a
            // custom scheme and select it, and the selection is validated
            // against what is stored.
            const model = top ? store.setSettings(top) : store.getSettings();
            const saved = store.setDefaultOptions(
                sanitizeSettingsPatch(body, model.customSchemes),
            );
            sendJson(res, 200, {
                ok: true,
                data: {
                    settings: saved,
                    publicUrl: model.publicUrl || "",
                    customSchemes: model.customSchemes || [],
                },
            });
            return;
        }

        if (pathname === "/api/schemes/import" && method === "POST") {
            const body = (await readJsonBody()) || {};
            let text = typeof body.input === "string" ? body.input : "";

            if (typeof body.url === "string" && body.url.trim() !== "") {
                const target = body.url.trim();
                if (!/^https?:\/\//i.test(target)) {
                    sendJson(res, 400, { ok: false, error: "规则链接必须是 http(s) 地址" });
                    return;
                }
                try {
                    const downloaded = await downloadText(target, { fetchImpl });
                    text = downloaded.text;
                } catch (e) {
                    sendJson(res, 400, {
                        ok: false,
                        error: "规则下载失败：" + (e && e.message ? e.message : e),
                    });
                    return;
                }
            }

            if (text.trim() === "") {
                sendJson(res, 400, { ok: false, error: "没有可导入的规则内容" });
                return;
            }

            const imported = importRules(text);
            const name =
                typeof body.name === "string" && body.name.trim() !== ""
                    ? body.name.trim()
                    : defaultSchemeName(imported, body.url);
            const scheme = schemeFromImport(imported, {
                id: CUSTOM_PREFIX + crypto.randomUUID().slice(0, 8),
                name,
                summary:
                    imported.format === "mihomo"
                        ? "导入自 Clash/Mihomo 配置"
                        : imported.format === "surge"
                          ? "导入自 Surge 配置"
                          : "导入自规则文本",
            });

            if (scheme === null) {
                sendJson(res, 400, {
                    ok: false,
                    error: "这份配置里没有能转换成 sing-box 的规则",
                    report: importReport(imported),
                });
                return;
            }

            const existing = (store.getSettings() || {}).customSchemes || [];
            const next = existing.concat([scheme]).slice(-MAX_SCHEMES);
            store.setSettings({ customSchemes: next });
            sendJson(res, 200, {
                ok: true,
                data: { scheme, report: importReport(imported), customSchemes: next },
            });
            return;
        }

        const schemePath = /^\/api\/schemes\/([^/]+)$/.exec(pathname);
        if (schemePath && method === "DELETE") {
            const id = decodeURIComponent(schemePath[1]);
            const existing = (store.getSettings() || {}).customSchemes || [];
            const next = existing.filter((entry) => !(entry && entry.id === id));
            store.setSettings({ customSchemes: next.length > 0 ? next : null });
            // A saved selection pointing at a scheme that no longer exists
            // would fall back to the default skeleton with no way to tell why.
            const defaults = (store.getSettings() || {}).defaultOptions || {};
            if (defaults.aclPreset === id) store.setDefaultOptions({ aclPreset: null });
            sendJson(res, 200, { ok: true, data: { customSchemes: next } });
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
            pathname.startsWith("/api/schemes/") ||
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
