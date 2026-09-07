import { ProxyUtils } from "@/core/proxy-utils";
import { safeLoad } from "@/utils/yaml";

// UA used when downloading a remote subscription. Many subscribe panels
// (e.g. V2Board) pick the response format by User-Agent: a UA containing
// "singbox" yields a ready-made sing-box config (which this converter cannot
// ingest), while a Clash client UA yields a Clash `proxies:` node list - the
// format this tool parses. Aligned with upstream Sub-Store's default
// (backend/src/utils/download.js). Override via options.userAgent.
export const DEFAULT_USER_AGENT = "clash.meta/v1.19.23";

export const DEFAULT_TIMEOUT_MS = 30000;

// Whole-document YAML/JSON that carries nodes directly:
//   - a JSON/YAML array of proxy objects
//   - a mihomo-style document with a `proxies:` array
// Returns an array of node objects, or undefined when the text is not such a
// document (e.g. a URI list).
export function tryLoadNodeDocument(text) {
    if (typeof text !== "string") return undefined;
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    let value;
    try {
        value = JSON.parse(trimmed);
    } catch (_e) {
        try {
            value = safeLoad(trimmed);
        } catch (_e2) {
            return undefined;
        }
    }
    if (value == null) return undefined;
    let nodes;
    if (Array.isArray(value)) nodes = value;
    else if (Array.isArray(value.proxies)) nodes = value.proxies;
    if (
        Array.isArray(nodes) &&
        nodes.length > 0 &&
        nodes.every((n) => n && typeof n === "object" && !Array.isArray(n))
    ) {
        return nodes;
    }
    return undefined;
}

function produceToObject(nodes, opts) {
    const external = ProxyUtils.produce(nodes, "sing-box", "external", {
        "include-unsupported-proxy": !!(opts && opts.includeUnsupportedProxy),
    });
    return JSON.parse(external); // { outbounds, endpoints }
}

// nodes: array of mihomo-style proxy objects (already parsed/normalized).
export function fromNodes(nodes, opts) {
    if (!Array.isArray(nodes)) {
        throw new TypeError("fromNodes expects an array of proxy node objects");
    }
    if (nodes.length === 0) return { outbounds: [], endpoints: [] };
    return produceToObject(nodes, opts);
}

// text: URI subscription text, or a YAML/JSON document (see tryLoadNodeDocument).
export function fromText(text, opts) {
    if (typeof text !== "string") {
        throw new TypeError("fromText expects a string");
    }
    const doc = tryLoadNodeDocument(text);
    const nodes = doc ? doc : ProxyUtils.parse(text);
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return { outbounds: [], endpoints: [] };
    }
    return produceToObject(nodes, opts);
}

// Merge the download headers: defaults (UA, optional bearer token) plus any
// caller-supplied opts.headers (name -> value; case-insensitive, overrides).
function buildHeaders(opts) {
    const headers = {};
    const set = (name, value) => {
        headers[name.toLowerCase()] = String(value);
    };
    set("user-agent", opts.userAgent || DEFAULT_USER_AGENT);
    if (opts.token) set("authorization", "Bearer " + opts.token);
    if (opts.headers && typeof opts.headers === "object" && !Array.isArray(opts.headers)) {
        for (const name of Object.keys(opts.headers)) {
            const value = opts.headers[name];
            if (value != null) set(name, value);
        }
    }
    return headers;
}

// url: remote http(s) subscription. Local file paths are not handled here; see
// the CLI, which resolves a path to text first.
//
// options:
//   userAgent ... request User-Agent (default DEFAULT_USER_AGENT)
//   token ...... send `Authorization: Bearer <token>`
//   headers .... extra request headers, { name: value } (overrides defaults)
//   timeout .... fetch timeout in ms (default DEFAULT_TIMEOUT_MS)
export async function fromUrl(url, opts) {
    opts = opts || {};
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(
            "singbox-kit: fromUrl expects an http(s) URL; got: " + url,
        );
    }
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let resp;
    try {
        resp = await fetch(url, {
            redirect: "follow",
            headers: buildHeaders(opts),
            signal: controller.signal,
        });
    } catch (e) {
        const timedOut = controller.signal.aborted;
        throw new Error(
            "singbox-kit: subscription download failed" +
                (timedOut ? " (timeout after " + timeout + "ms)" : "") +
                ": " +
                url,
        );
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        throw new Error(
            "singbox-kit: subscription download failed HTTP " +
                resp.status +
                " " +
                url,
        );
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = buf.toString("utf8");
    return fromText(text, opts);
}

export default {
    fromNodes,
    fromText,
    fromUrl,
    tryLoadNodeDocument,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT_MS,
};
