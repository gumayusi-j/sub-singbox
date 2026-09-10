import http from "http";
import { loadConfig } from "./config";
import { readStatic } from "./static";
import { fromText, fromUrl } from "../kit/convert";
import assemble from "../kit/assemble";
import { assembleAcl, findPreset } from "../kit/acl4ssr/build";

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
    return {
        mode: options.mode === "client" || options.mode === "proxy"
            ? options.mode
            : undefined,
        addMixed: options.addMixed === true,
        includeUnsupportedProxy: options.includeUnsupportedProxy === true,
        inboundPort: asNumber(options.inboundPort, undefined),
        // client profile turns TUN on by default; only forward an explicit
        // true so the default is never disabled from here.
        tun: options.tun === true ? true : undefined,
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

// A document whose tag space carries duplicates would assemble into a config
// sing-box refuses to boot (duplicate outbound/endpoint tags), so multi-source
// merges rename colliding tags with the same "-N" suffix the assembler uses
// for its synthetic groups. Single-source documents pass through untouched so
// their tags never drift from what the caller pasted.
function mergeParsed(parsedList, warnings) {
    if (!Array.isArray(parsedList) || parsedList.length <= 1) {
        return {
            outbounds: (parsedList && parsedList[0] && parsedList[0].outbounds) || [],
            endpoints: (parsedList && parsedList[0] && parsedList[0].endpoints) || [],
        };
    }
    const outbounds = [];
    const endpoints = [];
    const seenOut = new Set();
    const seenEp = new Set();
    const append = (coll, o, seen, label) => {
        if (!o) return;
        let item = o;
        const tag = item.tag;
        if (typeof tag === "string" && seen.has(tag)) {
            let i = 2;
            let candidate = tag + "-" + i;
            while (seen.has(candidate)) {
                i += 1;
                candidate = tag + "-" + i;
            }
            item = Object.assign({}, o, { tag: candidate });
            warnings.push({
                message:
                    "duplicate " + label + " tag '" + tag +
                    "' across subscriptions renamed to '" + candidate + "'",
                path: "merge",
            });
        }
        coll.push(item);
        if (typeof item.tag === "string") seen.add(item.tag);
    };
    for (const parsed of parsedList) {
        for (const o of (parsed && parsed.outbounds) || []) {
            append(outbounds, o, seenOut, "node");
        }
        for (const o of (parsed && parsed.endpoints) || []) {
            append(endpoints, o, seenEp, "endpoint");
        }
    }
    return { outbounds, endpoints };
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

export function createServer(config) {
    config = config || loadConfig();

    return http.createServer(async (req, res) => {
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
            send(res, 200, body, MIME[ext] || "application/octet-stream");
        } catch (e) {
            send(res, 500, {
                ok: false,
                error: e && e.message ? e.message : String(e),
            });
        }
    });
}

export function start(config) {
    config = config || loadConfig();
    const server = createServer(config);
    const { host, port } = config.listen;
    return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
    });
}

export default { createServer, start, convertRequest, inspectRequest, loadConfig };
