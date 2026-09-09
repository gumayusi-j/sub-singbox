// sing-box route-rule serializer.
//
// Internal rules are modeled after Sub-Store rule-utils descriptors:
//   { type: "DOMAIN-SUFFIX", content: "example.com", options: ["no-resolve"] }
// sing-box has no no-resolve equivalent for ip rules, so options is ignored.

// internal rule type -> sing-box route rule matcher key
const TYPE_TO_MATCHER = {
    DOMAIN: "domain",
    "DOMAIN-SUFFIX": "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "DOMAIN-REGEX": "domain_regex",
    "IP-CIDR": "ip_cidr",
    "IP-CIDR6": "ip_cidr",
    GEOIP: "geoip",
    GEOSITE: "geosite",
    "PROCESS-NAME": "process_name",
    "DEST-PORT": "port",
    "SRC-PORT": "source_port",
    "SRC-IP": "source_ip_cidr",
    NETWORK: "network",
    "RULE-SET": "rule_set",
};

export const SUPPORTED = new Set(Object.keys(TYPE_TO_MATCHER));

// Route rules that mean "drop this traffic". sing-box 1.11+ rejects via a
// route action, not an outbound (the legacy `block` outbound only survives as
// a selector member). Mapping an outbound of "reject" to `action: reject`
// lets rule files keep a readable policy word while emitting the modern form.
const REJECT = "reject";

export function isRejectTarget(target) {
    return typeof target === "string" && target.toLowerCase() === REJECT;
}

export function toSingboxMatcher(rule) {
    if (!rule || typeof rule !== "object") {
        throw new TypeError("rule must be an object like { type, content }");
    }
    if (!SUPPORTED.has(rule.type)) {
        throw new Error(
            "singbox-kit: unsupported route rule type: " + rule.type,
        );
    }
    const matcher = {};
    matcher[TYPE_TO_MATCHER[rule.type]] = String(rule.content);
    return matcher;
}

export function toSingboxRule(rule, outbound) {
    const matcher = toSingboxMatcher(rule);
    if (isRejectTarget(outbound)) {
        return Object.assign({}, matcher, { action: REJECT });
    }
    return Object.assign({}, matcher, { outbound: outbound || "proxy" });
}

export function toSingboxRules(rules, outbound) {
    if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
    return rules.map(function (rule) {
        return toSingboxRule(rule, outbound);
    });
}

// Keys that carry the rule's target instead of a matcher field.
const TARGET_KEYS = { outbound: true, action: true };

function ruleTarget(rule) {
    if (rule.action !== undefined) {
        return { type: "action", value: String(rule.action) };
    }
    if (rule.outbound !== undefined) {
        return { type: "outbound", value: String(rule.outbound) };
    }
    return { type: "none", value: null };
}

// A rule is foldable when every matcher field holds a scalar (strings,
// numbers, booleans). Array-valued fields (a prior fold, or a hand-written
// matcher) are already as collapsed as they can be.
function isFoldable(rule) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    for (const key of Object.keys(rule)) {
        if (Object.prototype.hasOwnProperty.call(TARGET_KEYS, key)) continue;
        if (Array.isArray(rule[key])) return false;
    }
    return true;
}

function sameTarget(a, b) {
    return Boolean(a && b) && a.type === b.type && a.value === b.value;
}

// Fold adjacent sing-box route rules that share the same target
// (outbound or action) into one rule whose matcher fields become arrays.
// Non-adjacent targets keep their relative order, so rule precedence is
// preserved. This mirrors how Tower's generator collapses a whole ACL4SSR
// snapshot into a handful of array-shaped rules instead of one entry per
// line.
//
//   { domain_suffix: "a.com", outbound: "proxy" }
//   { domain_suffix: "b.com", outbound: "proxy" }
//       -> { domain_suffix: ["a.com", "b.com"], outbound: "proxy" }
//
// A field whose run yields a single value stays a scalar, so folding a small
// rule set changes nothing about the output shape.
export function foldSingboxRules(rules) {
    if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
    const out = [];
    let bucket = null;

    function flush() {
        if (!bucket) return;
        const rule = {};
        if (bucket.target.type === "action") rule.action = bucket.target.value;
        else if (bucket.target.type === "outbound") rule.outbound = bucket.target.value;
        for (const key of bucket.order) {
            const entry = bucket.maps.get(key);
            rule[key] = entry.values.length === 1 ? entry.values[0] : entry.values;
        }
        out.push(rule);
        bucket = null;
    }

    function startBucket(target) {
        bucket = { target, order: [], maps: new Map() };
    }

    for (const rule of rules) {
        if (!isFoldable(rule)) {
            flush();
            if (rule != null) out.push(rule);
            continue;
        }
        const target = ruleTarget(rule);
        if (!bucket || !sameTarget(bucket.target, target)) {
            flush();
            startBucket(target);
        }
        for (const key of Object.keys(rule)) {
            if (Object.prototype.hasOwnProperty.call(TARGET_KEYS, key)) continue;
            if (!bucket.maps.has(key)) {
                bucket.maps.set(key, { values: [], seen: new Set() });
                bucket.order.push(key);
            }
            const entry = bucket.maps.get(key);
            const value = rule[key];
            const signature = typeof value + ":" + String(value);
            if (entry.seen.has(signature)) continue;
            entry.seen.add(signature);
            entry.values.push(value);
        }
    }
    flush();
    return out;
}

export default {
    toSingboxMatcher,
    toSingboxRule,
    toSingboxRules,
    foldSingboxRules,
    isRejectTarget,
    SUPPORTED,
};
