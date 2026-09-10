// Which client dialect a /sub/<token> request wants.
//
// A subscription URL is entered into a client once and then polled forever, so
// the server has to work out the dialect from whatever the client sends. That
// is the User-Agent, which every client sets to its own name.
//
// The table mirrors Tower's LANSubscriptionTargetResolver: application names
// are checked before the core they embed, so Shadowrocket and sing-box come
// before Clash, and an unknown UA is rejected rather than guessed at (a client
// silently handed the wrong format just shows an empty node list).
//
// `?target=` always wins over the UA, and `?target=nonsense` is an error - not
// a fallback - so a typo in a hand-written URL is visible instead of silent.

// Every `produce` value here must be a key registered in
// src/core/proxy-utils/producers/index.js. `mode: "singbox"` marks the one
// target assembled into a full config rather than emitted as a node list; see
// render.js. `exportable: true` marks the entry as a client a user would pick
// by name - see listExportTargets().
export const TARGETS = [
    {
        id: "shadowrocket",
        label: "Shadowrocket",
        exportable: true,
        produce: "shadowrocket",
        contentType: "text/plain; charset=utf-8",
        ua: /shadowrocket/i,
    },
    {
        id: "quantumultx",
        label: "Quantumult X",
        exportable: true,
        produce: "qx",
        contentType: "text/plain; charset=utf-8",
        ua: /quantumult\s?x|quantumultx|quanx/i,
    },
    {
        id: "hiddify",
        label: "Hiddify",
        exportable: true,
        produce: "sing-box",
        mode: "singbox",
        contentType: "application/json; charset=utf-8",
        ua: /hiddify/i,
    },
    {
        id: "sing-box",
        label: "sing-box",
        exportable: true,
        produce: "sing-box",
        mode: "singbox",
        contentType: "application/json; charset=utf-8",
        ua: /sing-?box|singbox|\bsfa\b|\bsfi\b|\bsfm\b|\bsft\b/i,
    },
    {
        id: "karing",
        label: "Karing",
        produce: "clashmeta",
        contentType: "text/yaml; charset=utf-8",
        ua: /karing/i,
    },
    {
        id: "stash",
        label: "Stash",
        produce: "stash",
        contentType: "text/yaml; charset=utf-8",
        ua: /\bstash\b/i,
    },
    {
        id: "clash",
        label: "Clash / mihomo",
        exportable: true,
        produce: "clashmeta",
        contentType: "text/yaml; charset=utf-8",
        ua: /clash|mihomo|nikki|verge|flclash|mihomo\s*party/i,
    },
    {
        id: "surfboard",
        label: "Surfboard",
        exportable: true,
        produce: "surfboard",
        contentType: "text/plain; charset=utf-8",
        ua: /surfboard/i,
    },
    {
        id: "surge",
        label: "Surge",
        exportable: true,
        produce: "surge",
        contentType: "text/plain; charset=utf-8",
        ua: /surge/i,
    },
    {
        id: "loon",
        label: "Loon",
        exportable: true,
        // The producer registry only registers this one capitalised.
        produce: "Loon",
        contentType: "text/plain; charset=utf-8",
        ua: /loon/i,
    },
    {
        id: "v2ray",
        label: "V2Ray",
        produce: "v2ray",
        contentType: "text/plain; charset=utf-8",
        ua: /v2ray|v2rayng/i,
    },
    {
        id: "egern",
        label: "Egern",
        exportable: true,
        produce: "egern",
        contentType: "text/plain; charset=utf-8",
        ua: /egern/i,
    },
    {
        // Never matched from a UA (the pattern only accepts an empty agent, and
        // an empty agent short-circuits before the scan); reachable only via an
        // explicit ?target=uri.
        id: "uri",
        label: "URI list",
        produce: "uri",
        contentType: "text/plain; charset=utf-8",
        ua: /^$/,
    },
];

export const DEFAULT_TARGET_ID = "sing-box";

// Names a human might type into ?target= that are not a table id.
const ALIASES = {
    clashmeta: "clash",
    "clash-meta": "clash",
    "clash.meta": "clash",
    mihomo: "clash",
    "mihomo-party": "clash",
    openclash: "clash",
    nikki: "clash",
    "clash-verge": "clash",
    clashverge: "clash",
    flclash: "clash",
    "clash-mi": "clash",
    clashmi: "clash",
    quantumult: "quantumultx",
    quanx: "quantumultx",
    singbox: "sing-box",
    sfm: "sing-box",
    sfi: "sing-box",
    sfa: "sing-box",
    sft: "sing-box",
    "shadow-rocket": "shadowrocket",
    v2rayng: "v2ray",
};

const BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

export function findTarget(id) {
    if (typeof id !== "string") return null;
    const key = id.trim().toLowerCase();
    if (key === "") return null;
    return BY_ID.get(key) || BY_ID.get(ALIASES[key]) || null;
}

// The list a 400 response hands back so the caller can fix its URL. Deliberately
// every target, not the exportable subset: the point of the body is to tell a
// caller what the server can actually serve, and narrowing it would hide the
// answer to "why was my ?target= rejected".
export function listTargets() {
    return TARGETS.map((t) => ({ id: t.id, label: t.label }));
}

// The subset the export page offers as a fixed ?target=. Narrower than
// listTargets() on purpose: only the dialects a user would recognise as a
// client they own, so the dropdown stays a choice between apps rather than a
// list of output formats. A marker on each entry rather than a list of ids
// here, so renaming a target moves the fact along with it.
export function listExportTargets() {
    return TARGETS.filter((t) => t.exportable === true).map((t) => ({
        id: t.id,
        label: t.label,
    }));
}

export function contentTypeFor(target) {
    const entry = typeof target === "string" ? findTarget(target) : target;
    return (entry && entry.contentType) || "text/plain; charset=utf-8";
}

// resolveTarget({ userAgent, queryTarget, unknownUaTarget, allowedTargets })
//
//   queryTarget ..... the ?target= value, if any (wins outright)
//   unknownUaTarget . "reject" (default) -> null; a dialect id -> use it
//   allowedTargets .. optional whitelist of ids; anything else is rejected
//                     exactly like an unknown ?target=
//
// Returns { target, reason } where reason is "query" | "ua" | "default", or
// null when nothing acceptable could be determined.
export function resolveTarget(options) {
    options = options || {};
    const allowed =
        Array.isArray(options.allowedTargets) && options.allowedTargets.length > 0
            ? new Set(options.allowedTargets)
            : null;
    const permitted = (entry) => !!entry && (!allowed || allowed.has(entry.id));

    const explicit =
        typeof options.queryTarget === "string" ? options.queryTarget.trim() : "";
    if (explicit !== "" && explicit.toLowerCase() !== "auto") {
        const entry = findTarget(explicit);
        // A miss here is a hard error upstream: silently serving a different
        // dialect than the one asked for is worse than a 400.
        return permitted(entry) ? { target: entry, reason: "query" } : null;
    }

    // Clients percent-encode the space in "Quantumult X", so "Quantumult%20X"
    // is a common spelling of the same client. Tower decodes before matching
    // (LANSubscriptionTargetResolver.normalized); do the same, and fall back to
    // the raw value when the agent is not valid percent-encoding.
    let agent = typeof options.userAgent === "string" ? options.userAgent : "";
    if (agent.indexOf("%") >= 0) {
        try {
            agent = decodeURIComponent(agent);
        } catch (_e) {
            // Malformed encoding; match against what the client sent.
        }
    }
    if (agent.trim() !== "") {
        for (const entry of TARGETS) {
            if (entry.ua.test(agent) && permitted(entry)) {
                return { target: entry, reason: "ua" };
            }
        }
    }

    const fallback = options.unknownUaTarget;
    if (typeof fallback === "string" && fallback !== "" && fallback !== "reject") {
        const entry = findTarget(fallback);
        if (permitted(entry)) return { target: entry, reason: "default" };
    }
    return null;
}

export default {
    TARGETS,
    DEFAULT_TARGET_ID,
    findTarget,
    listTargets,
    contentTypeFor,
    resolveTarget,
};
