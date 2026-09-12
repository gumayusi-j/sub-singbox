// Build the body of a /sub/<token> response.
//
// The stored snapshot is the raw subscription body, so every client dialect is
// re-derived here on demand: sing-box is assembled into a full config, and the
// other targets go through whichever ProxyUtils producer the target table
// names. Nothing is cached on disk - a render is cheap, and the ETag already
// lets a client skip a body it has.

import crypto from "crypto";
import { ProxyUtils } from "@/core/proxy-utils";
import { fromNodes, parseNodes } from "../kit/convert";
import { mergeParsed, dedupeNodeNames } from "../kit/merge";
import assemble from "../kit/assemble";
import { assembleAcl } from "../kit/acl4ssr/build";
import { findScheme } from "../kit/schemes";
import { filterNodeNames, normalizeNodeFilter } from "../kit/nodes/filter";
import { CompatError } from "../kit/compat";
import { formatUserInfoHeader } from "./usage";

// The name a node is known by - what the user sees in a client, and what a
// name filter is written against.
function nodeName(node) {
    return node && typeof node.name === "string" ? node.name : "";
}

function isNonNegative(value) {
    return Number.isFinite(value) && value >= 0;
}

// Sum the byte counters and take the earliest expiry, so a merged view shows
// the quota that will actually run out first. Only sources that reported
// something contribute; a source with no usage leaves the rest alone.
export function aggregateUsage(sources) {
    let upload = null;
    let download = null;
    let total = null;
    let expire = null;
    const notices = [];
    for (const source of sources) {
        const usage = source && source.usage;
        if (!usage) continue;
        if (isNonNegative(usage.upload)) upload = (upload || 0) + usage.upload;
        if (isNonNegative(usage.download)) download = (download || 0) + usage.download;
        if (isNonNegative(usage.total)) total = (total || 0) + usage.total;
        if (isNonNegative(usage.expire)) {
            expire = expire == null ? usage.expire : Math.min(expire, usage.expire);
        }
        if (Array.isArray(usage.notices)) notices.push(...usage.notices);
    }
    if (upload == null && download == null && total == null && expire == null) {
        return null;
    }
    return { upload, download, total, expire, origin: "merged", notices };
}

// Which sources the token addresses. A source token always means exactly that
// one source, whether or not it is enabled - the URL was handed out on purpose.
//
// A global token means every enabled source, narrowed by ?src= when given. The
// one exception is an explicit export (`idsExact`), which honours the ids
// verbatim - including disabled sources, because the user picked them by hand.
export function selectSources(store, resolved, options) {
    options = options || {};
    if (!resolved) return [];
    if (resolved.kind === "source") return [resolved.source];

    const all = store.list();
    const ids = Array.isArray(options.sourceIds) ? options.sourceIds : null;
    if (ids && options.idsExact) {
        const byId = new Map(all.map((source) => [source.id, source]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
    }

    const enabled = all.filter((s) => s.enabled);
    if (!ids || ids.length === 0) return enabled;

    // When ?src= explicitly names sources, return them even if disabled.
    // This keeps per-source subscription links stable across enable/disable
    // toggles — the client keeps working as long as the source exists.
    const byId = new Map(all.map((source) => [source.id, source]));
    const wanted = ids.map((id) => byId.get(id)).filter(Boolean);
    return wanted.length > 0 ? wanted : enabled.filter((s) => ids.includes(s.id));
}

// No `mode` is forwarded: leaving it unset is what selects the "client"
// profile in kit/defaults.js, which is Tower's one and only run shape (TUN
// tun-in, DNS skeleton, CN-direct). The same goes for the knobs that only mean
// anything to the other profile (addMixed, inboundPort, tun).
function normalizeOptions(options, customSchemes) {
    options = options || {};
    // A scheme id may name a bundled preset or one the user imported. The
    // resolved object is what the builder wants; an id that names neither is
    // dropped so the run falls back to the default skeleton rather than
    // throwing on a stale saved value.
    const scheme = options.aclPreset ? findScheme(options.aclPreset, customSchemes) : null;
    return {
        out: options.out === "outbounds" ? "outbounds" : "config",
        aclPreset: scheme !== null ? options.aclPreset : undefined,
        aclScheme: scheme || undefined,
        // A list of nodes to keep, by name. Distinct from a source's
        // excludedNodes, which is a per-source deny list of exact names.
        nodeFilter: normalizeNodeFilter(options.nodeFilter),
        ipv6Enabled: options.ipv6Enabled === true ? true : options.ipv6Enabled === false ? false : undefined,
        remoteDns: options.remoteDns || undefined,
        // Everything below is only ever read by assemble()/assembleAcl().
        final: options.final || undefined,
        proxyGroupTag: options.proxyGroupTag || undefined,
        addAutoGroup: options.addAutoGroup,
        foldRules: options.foldRules === true,
        rules: Array.isArray(options.rules) ? options.rules : undefined,
        includeUnsupportedProxy:
            options.includeUnsupportedProxy === true ||
            options.includeUnsupportedProxy === "true",
    };
}

function sha256(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function etagFor(body) {
    return '"' + sha256(body).slice(0, 32) + '"';
}

function errorResponse(status, message, extra) {
    return {
        status,
        headers: { "Cache-Control": "no-store" },
        body: Object.assign({ ok: false, error: message }, extra || {}),
        content: "application/json",
        sources: [],
    };
}

// renderSubscription(store, resolved, options)
//   resolved ... { kind: "global" } | { kind: "source", source } (store.resolveToken)
//   options .... { target, out, aclPreset, mode, sourceIds, remoteDns, usageHeader }
//
// Returns { status, headers, body, content, sources, usage, warnings }.
// `body` is a string for the dialect targets and a plain object for errors.
export function renderSubscription(store, resolved, options) {
    options = options || {};
    const target = options.target;
    if (!target) return errorResponse(400, "no client dialect resolved");

    const sources = selectSources(store, resolved, options);
    if (sources.length === 0) {
        return errorResponse(
            409,
            resolved && resolved.kind === "global"
                ? "no enabled subscription sources"
                : "subscription source not found",
        );
    }

    // A source that has never been refreshed has no snapshot yet. That is a
    // different failure from a wrong token, so it gets its own status.
    const withSnapshots = [];
    for (const source of sources) {
        const text = store.readSnapshot(source.id);
        if (typeof text === "string" && text.trim() !== "") {
            withSnapshots.push({ source, text });
        }
    }
    if (withSnapshots.length === 0) {
        return errorResponse(409, "no snapshot yet; refresh the subscription first");
    }

    const warnings = [];
    const normalized = normalizeOptions(options, (store.getSettings() || {}).customSchemes);
    // Each body is parsed twice on the sing-box path (once into nodes, once
    // into outbounds); parseNodes is the expensive half and is memoised by the
    // caller's snapshot, so keep one list and reuse it.
    const parsedNodes = withSnapshots.map((entry) => {
        let nodes = parseNodes(entry.text);
        // Filter out excluded nodes for this source
        const excluded = entry.source.excludedNodes;
        if (Array.isArray(excluded) && excluded.length > 0) {
            const excludedSet = new Set(excluded);
            nodes = nodes.filter((node) => !excludedSet.has(node && node.name));
        }
        // Keep only the nodes the name filter selects. An expression that
        // cannot be evaluated leaves the node list alone and says so: a saved
        // filter going bad should not silently empty someone's subscription.
        if (normalized.nodeFilter) {
            const filtered = filterNodeNames(
                nodes.map((node) => [nodeName(node)]),
                normalized.nodeFilter.pattern,
                normalized.nodeFilter,
            );
            if (filtered.error) {
                warnings.push({
                    message: "节点名称筛选未生效：" + filtered.error,
                    path: "nodeFilter",
                });
            } else {
                const keep = new Set(filtered.names.map((pair) => pair[0]));
                nodes = nodes.filter((node) => keep.has(nodeName(node)));
            }
        }
        // Apply custom node order if set
        const order = entry.source.nodeOrder;
        if (Array.isArray(order) && order.length > 0) {
            const orderIndex = new Map(order.map((name, i) => [name, i]));
            nodes.sort((a, b) => {
                const ai = orderIndex.has(a && a.name) ? orderIndex.get(a.name) : Infinity;
                const bi = orderIndex.has(b && b.name) ? orderIndex.get(b.name) : Infinity;
                return ai - bi;
            });
        }
        return nodes;
    });
    const nodeCount = parsedNodes.reduce((sum, list) => sum + list.length, 0);
    if (nodeCount === 0) {
        return errorResponse(409, "stored snapshot contains no supported nodes");
    }

    let body;

    try {
        if (target.mode === "singbox") {
            const parsed = mergeParsed(
                parsedNodes.map((nodes) => fromNodes(nodes, normalized)),
                warnings,
            );
            if (normalized.out === "outbounds") {
                body = JSON.stringify(
                    { outbounds: parsed.outbounds, endpoints: parsed.endpoints },
                    null,
                    2,
                );
            } else {
                const config = normalized.aclPreset
                    ? assembleAcl(parsed, normalized)
                    : assemble(parsed, normalized);
                body = JSON.stringify(config, null, 2);
            }
        } else {
            // Every other dialect keys entries by display name, so dedupe on
            // name rather than on the sing-box tag.
            const nodes = dedupeNodeNames(parsedNodes, warnings);
            const produced = ProxyUtils.produce(nodes, target.produce, "external");
            body = typeof produced === "string" ? produced : JSON.stringify(produced, null, 2);
        }
    } catch (e) {
        if (e instanceof CompatError) return errorResponse(422, e.message);
        return errorResponse(500, e && e.message ? e.message : String(e));
    }

    // Last-Modified is the newest refresh among the sources that contributed.
    let lastModifiedMs = 0;
    for (const { source } of withSnapshots) {
        const stamp = Date.parse(source.lastUpdatedAt || source.lastCheckedAt || "");
        if (Number.isFinite(stamp) && stamp > lastModifiedMs) lastModifiedMs = stamp;
    }

    const headers = {
        "Content-Type": target.contentType,
        ETag: etagFor(body),
        "Cache-Control": "no-store",
    };
    if (lastModifiedMs > 0) {
        headers["Last-Modified"] = new Date(lastModifiedMs).toUTCString();
    }

    const usage = aggregateUsage(withSnapshots.map((entry) => entry.source));
    if (usage && options.usageHeader !== false) {
        const header = formatUserInfoHeader(usage);
        if (header) headers["Subscription-Userinfo"] = header;
    }

    return {
        status: 200,
        headers,
        body,
        content: target.contentType,
        sources: withSnapshots.map((entry) => entry.source),
        usage,
        warnings,
        lastModifiedMs,
    };
}

// RFC 7232 precedence: If-None-Match wins outright when present, and
// If-Modified-Since is only consulted when it is absent.
export function isNotModified(rendered, headers) {
    headers = headers || {};
    const inm = headers["if-none-match"];
    if (typeof inm === "string" && inm.trim() !== "") {
        const candidates = inm.split(",").map((value) => value.trim());
        return candidates.includes("*") || candidates.includes(rendered.headers.ETag);
    }
    const ims = headers["if-modified-since"];
    if (typeof ims === "string" && rendered.lastModifiedMs > 0) {
        const since = Date.parse(ims);
        if (Number.isFinite(since)) {
            // HTTP dates have one-second resolution.
            return Math.floor(rendered.lastModifiedMs / 1000) <= Math.floor(since / 1000);
        }
    }
    return false;
}

export default {
    renderSubscription,
    selectSources,
    aggregateUsage,
    isNotModified,
    etagFor,
};
