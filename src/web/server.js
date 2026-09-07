import http from "http";
import { loadConfig } from "./config";
import { readStatic } from "./static";
import { fromText, fromUrl } from "../kit/convert";
import assemble from "../kit/assemble";

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
        includeUnsupportedProxy: options.includeUnsupportedProxy === true,
        inboundPort: asNumber(options.inboundPort, undefined),
        tun: options.tun === true,
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
        remoteDns: options.remoteDns || config.remoteDns,
        addAutoGroup: options.addAutoGroup,
        addDirect: options.addDirect,
        addBlock: options.addBlock,
        addDnsOut: options.addDnsOut,
        rules: normalizeRules(options.rules),
    };
}

// Core handler, exported for tests.
export async function convertRequest(body, config) {
    if (!body || typeof body.input !== "string") {
        return {
            status: 400,
            payload: { ok: false, error: "missing string field: input" },
        };
    }
    const input = body.input;
    if (input.trim() === "") {
        return { status: 400, payload: { ok: false, error: "input is empty" } };
    }
    const normalized = normalizeOptions(body.options, config);
    // Surface sing-box 1.16 auto-migrations on the success payload.
    const warnings = [];
    normalized.onWarning = (ws) => {
        for (const w of ws) warnings.push(w);
    };
    const outMode =
        body.out === "outbounds" ? "outbounds" : config.defaultOut || "config";

    let parsed;
    try {
        const urlMode =
            body.url === true || /^https?:\/\//i.test(input.trim());
        parsed = urlMode
            ? await fromUrl(input.trim(), normalized)
            : fromText(input, normalized);
    } catch (e) {
        return {
            status: 400,
            payload: { ok: false, error: e && e.message ? e.message : String(e) },
        };
    }

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
            configJson = assemble(parsed, normalized);
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

export function createServer(config) {
    config = config || loadConfig();

    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            const pathname = decodeURIComponent(url.pathname);

            if (req.method === "POST" && pathname === "/api/convert") {
                const raw = await readBody(req, config.maxBodyBytes || 1048576);
                let body;
                try {
                    body = JSON.parse(raw.toString("utf8") || "{}");
                } catch (e) {
                    send(res, 400, { ok: false, error: "invalid JSON body" });
                    return;
                }
                const result = await convertRequest(body, config);
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

export default { createServer, start, convertRequest, loadConfig };
