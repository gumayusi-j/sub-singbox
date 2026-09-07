import { ProxyUtils } from "@/core/proxy-utils";
import { safeLoad } from "@/utils/yaml";

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

// url: remote http(s) subscription. Local file paths are not handled here; see
// the CLI, which resolves a path to text first.
export async function fromUrl(url, opts) {
    opts = opts || {};
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(
            "singbox-kit: fromUrl expects an http(s) URL; got: " + url,
        );
    }
    const headers = { "user-agent": opts.userAgent || "singbox-kit/0.1" };
    if (opts.token) headers.authorization = "Bearer " + opts.token;
    let resp;
    try {
        resp = await fetch(url, { redirect: "follow", headers: headers });
    } catch (e) {
        throw new Error("singbox-kit: subscription download failed: " + url);
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

export default { fromNodes, fromText, fromUrl, tryLoadNodeDocument };
