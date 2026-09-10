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

// Status codes a panel uses to gate non-client traffic ("wrong client"), plus
// the UA a fallback attempt sends. Mirrors Tower's
// SubscriptionRequestBuilder.clientGatingStatusCodes, though the fallback runs
// the other way round: Tower defaults to a Shadowrocket UA and falls back to
// clash.meta, while this kit defaults to clash.meta (which yields the Clash
// node list it parses) and falls back to the Shadowrocket UA (which yields a
// base64 URI list it parses just as well).
export const CLIENT_GATING_STATUS_CODES = [403, 406, 421, 426];
export const FALLBACK_USER_AGENT =
    "Shadowrocket/3378 CFNetwork/3892.100.1 Darwin/27.0.0";

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

// Parse subscription text into mihomo-style node objects, without producing any
// client dialect. `fromText` uses this, and the subscription refresh engine
// needs the same nodes to count protocols and to decide whether a fallback
// User-Agent is worth trying.
export function parseNodes(text) {
    if (typeof text !== "string") return [];
    const doc = tryLoadNodeDocument(text);
    const nodes = doc ? doc : ProxyUtils.parse(text);
    return Array.isArray(nodes) ? nodes : [];
}

// text: URI subscription text, or a YAML/JSON document (see tryLoadNodeDocument).
export function fromText(text, opts) {
    if (typeof text !== "string") {
        throw new TypeError("fromText expects a string");
    }
    const nodes = parseNodes(text);
    if (nodes.length === 0) {
        return { outbounds: [], endpoints: [] };
    }
    return produceToObject(nodes, opts);
}

// Merge the download headers: defaults (UA, optional bearer token) plus any
// caller-supplied opts.headers (name -> value; case-insensitive, overrides).
export function buildHeaders(opts) {
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

// Fetch a remote http(s) subscription and return the *raw* response, without
// parsing it. This is the seam the subscription refresh engine needs: it wants
// the status code (to decide whether a UA fallback is warranted), the response
// headers (subscription-userinfo carries the plan quota) and the untouched
// body (Tower's download store keeps the original so any client dialect can be
// re-derived from it later, not just sing-box).
//
// Network failures and timeouts throw, with the same wording `fromUrl` has
// always used. A non-2xx status does NOT throw here - callers that want the
// old hard-failure behaviour check `status` themselves (see `fromUrl`).
//
// options (all optional):
//   userAgent ... request User-Agent (default DEFAULT_USER_AGENT)
//   token ...... send `Authorization: Bearer <token>`
//   headers .... extra request headers, { name: value } (overrides defaults)
//   timeout .... fetch timeout in ms (default DEFAULT_TIMEOUT_MS)
//   fetchImpl .. fetch implementation to use (default: globalThis.fetch)
export async function downloadText(url, opts) {
    opts = opts || {};
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS;
    const fetchImpl = opts.fetchImpl || fetch;
    const headers = buildHeaders(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let resp;
    try {
        resp = await fetchImpl(url, {
            redirect: "follow",
            headers,
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
    const buf = Buffer.from(await resp.arrayBuffer());
    return {
        text: buf.toString("utf8"),
        status: resp.status,
        statusText: resp.statusText || "",
        headers: responseHeadersToObject(resp.headers),
        finalUrl: resp.url || url,
        usedUserAgent: headers["user-agent"],
    };
}

// fetch() hands back a Headers instance. Flatten it to a lowercase-keyed plain
// object so callers can read `headers["subscription-userinfo"]` without caring
// which implementation produced it (mock fetches in tests are plain objects).
function responseHeadersToObject(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === "function") {
        headers.forEach((value, name) => {
            out[String(name).toLowerCase()] = value;
        });
        return out;
    }
    for (const name of Object.keys(headers)) {
        out[String(name).toLowerCase()] = headers[name];
    }
    return out;
}

// url: remote http(s) subscription. Local file paths are not handled here; see
// the CLI, which resolves a path to text first.
//
// options: see downloadText, plus
//   fetchImpl .. fetch implementation to use (default: globalThis.fetch)
export async function fromUrl(url, opts) {
    opts = opts || {};
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(
            "singbox-kit: fromUrl expects an http(s) URL; got: " + url,
        );
    }
    const resp = await downloadText(url, opts);
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
            "singbox-kit: subscription download failed HTTP " +
                resp.status +
                " " +
                url,
        );
    }
    return fromText(resp.text, opts);
}

export default {
    fromNodes,
    fromText,
    fromUrl,
    downloadText,
    parseNodes,
    tryLoadNodeDocument,
    buildHeaders,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT_MS,
    CLIENT_GATING_STATUS_CODES,
    FALLBACK_USER_AGENT,
};
