// sing-box route-rule serializer.
//
// Internal rules are modeled after Sub-Store rule-utils descriptors:
//   { type: "DOMAIN-SUFFIX", content: "example.com", options: ["no-resolve"] }
// sing-box has no no-resolve equivalent for ip rules, so options is ignored.
//
// There are two ways in. TYPE_TO_MATCHER below is the flat path: one matcher
// key per rule, values kept scalar so foldSingboxRules can collapse a run of
// same-target rules into one array-shaped rule. The condition path further
// down handles everything the flat table cannot - most importantly the
// AND/OR/NOT trees an imported rule file may contain.

import { parseRuleLine, portRanges } from "./syntax";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

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

// `process_name` is understood by the standalone builds only. On the App Store
// iPhone client every connection it sees logs "Not implemented" - and, worse,
// when the matcher is grouped with a domain condition the whole rule stops
// matching, silently. Tower's generator leaves it out for the same reason, and
// so does this one unless the caller asks for it explicitly.
export const OPT_IN_TYPES = new Set(["PROCESS-NAME"]);

export function isSupportedType(type, options) {
    if (!SUPPORTED.has(type)) return false;
    if (OPT_IN_TYPES.has(type) && !(options && options.allowProcessName)) return false;
    return true;
}

// Route rules that mean "drop this traffic". sing-box 1.11+ rejects via a
// route action, not an outbound (the legacy `block` outbound only survives as
// a selector member). Mapping an outbound of "reject" to `action: reject`
// lets rule files keep a readable policy word while emitting the modern form.
//
// The policy word arrives as a family, not one spelling. Every member means
// "reject"; they differ in *how*, and sing-box can express two of those
// differences directly:
//
//   REJECT            plain reject
//   REJECT-DROP       drop silently          -> method: "drop"
//   REJECT-NO-DROP    never degrade to drop  -> no_drop: true
//   REJECT-TINYGIF    a tiny image instead      no equivalent; a plain reject
//   (any other REJECT-*)                        is the closest readable result
//
// Leaving an unrecognised member as an outbound name is not an option: it
// would reference a tag nothing declares, and sing-box refuses to start on a
// dangling reference.
const REJECT = "reject";
const REJECT_FAMILY = /^REJECT(-[A-Z0-9-]+)?$/;

// The action fields for a reject policy word, or null when the word is not a
// reject at all. Callers that only need the yes/no use isRejectTarget.
export function rejectAction(target) {
    if (typeof target !== "string") return null;
    const name = target.trim().toUpperCase();
    if (!REJECT_FAMILY.test(name)) return null;
    if (name === "REJECT-DROP") return { action: REJECT, method: "drop" };
    if (name === "REJECT-NO-DROP") return { action: REJECT, no_drop: true };
    return { action: REJECT };
}

export function isRejectTarget(target) {
    return rejectAction(target) !== null;
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
    const action = rejectAction(outbound);
    if (action) return Object.assign({}, matcher, action);
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

// ---------------------------------------------------------------------------
// Condition trees
//
// These work on the shape rules/syntax.js parses to:
//   leaf     { type, content, options }
//   logical  { type: "AND"|"OR"|"NOT", options, children: [...] }
// ---------------------------------------------------------------------------

const PROTOCOL_ALIASES = {
    http: "http",
    https: "tls",
    tls: "tls",
    quic: "quic",
    stun: "stun",
};

const REGEX_SPECIALS = new Set("\\^$.*+?()[]{}|".split(""));

const DIRECT_TARGET = "direct";

// Policy words describing a behaviour sing-box has no counterpart for:
// mihomo's PASS/PASS-RULE/COMPATIBLE, Surge's CELLULAR/HYBRID. They resolve to
// null so the caller drops the rule and reports it, rather than emitting an
// outbound tag nothing ever declares.
const UNREPRESENTABLE_POLICIES = new Set([
    "PASS",
    "PASS-RULE",
    "COMPATIBLE",
    "CELLULAR",
    "CELLULAR-ONLY",
    "HYBRID",
    "NO-HYBRID",
]);

// What a route rule's target slot should hold for a policy word, or null when
// the word cannot be expressed and the rule has to go.
export function policyToTarget(policy) {
    if (typeof policy !== "string") return null;
    const name = policy.trim();
    if (name === "") return null;
    const upper = name.toUpperCase();
    if (UNREPRESENTABLE_POLICIES.has(upper)) return null;
    if (upper === DIRECT_TARGET.toUpperCase()) return DIRECT_TARGET;
    // A reject variant keeps its spelling so rejectAction can pick the closest
    // method; the word itself is never emitted as a tag.
    if (rejectAction(name)) return upper;
    return name;
}

function leaf(key, value) {
    return { [key]: [value] };
}

// DOMAIN-WILDCARD is a glob, not a regex: `*` and `?` are its only
// metacharacters, and everything else - including `.` and `+` - is literal.
function wildcardToRegex(value) {
    let out = "";
    for (const ch of value) {
        if (ch === "*") out += ".*";
        else if (ch === "?") out += ".";
        else if (REGEX_SPECIALS.has(ch)) out += "\\" + ch;
        else out += ch;
    }
    return "(?i)^" + out + "$";
}

function protocolMatcher(value) {
    const name = value.toLowerCase();
    // Surge spells TCP/UDP as a protocol; sing-box models both as `network`.
    if (name === "tcp" || name === "udp") return leaf("network", name);
    const protocol = PROTOCOL_ALIASES[name];
    if (protocol === undefined) return null;
    return leaf("protocol", protocol);
}

function portMatcher(value, portKey, rangeKey) {
    const ranges = portRanges(value);
    if (ranges === null) return null;
    const ports = [];
    const spans = [];
    for (const item of ranges) {
        const dash = item.indexOf("-");
        if (dash < 0) {
            ports.push(Number(item));
            continue;
        }
        const low = item.slice(0, dash);
        const high = item.slice(dash + 1);
        // A range that collapsed to one port is just a port.
        if (low === high) ports.push(Number(low));
        else spans.push(low + ":" + high);
    }
    const out = {};
    if (ports.length > 0) out[portKey] = ports;
    if (spans.length > 0) out[rangeKey] = spans;
    return Object.keys(out).length > 0 ? out : null;
}

function leafMatcher(cond, options) {
    const type = String(cond.type || "").toUpperCase();
    const value = String(cond.content == null ? "" : cond.content);
    if (value === "") return null;
    const hasSrc = (cond.options || []).some(
        (opt) => String(opt).toLowerCase() === "src",
    );

    switch (type) {
        case "DOMAIN":
            return leaf("domain", value);
        case "DOMAIN-SUFFIX":
            return leaf("domain_suffix", value);
        case "DOMAIN-KEYWORD":
            return leaf("domain_keyword", value);
        case "DOMAIN-REGEX":
            return leaf("domain_regex", value);
        case "DOMAIN-WILDCARD":
            return leaf("domain_regex", wildcardToRegex(value));
        case "IP-CIDR":
        case "IP-CIDR6":
        case "IP6-CIDR":
            // `src` flips a destination CIDR into a source one.
            return hasSrc ? leaf("source_ip_cidr", value) : leaf("ip_cidr", value);
        case "SRC-IP":
        case "SRC-IP-CIDR":
            return leaf("source_ip_cidr", value);
        case "NETWORK":
            return leaf("network", value.toLowerCase());
        case "PROTOCOL":
            return protocolMatcher(value);
        case "DST-PORT":
        case "DEST-PORT":
            return portMatcher(value, "port", "port_range");
        case "SRC-PORT":
            return portMatcher(value, "source_port", "source_port_range");
        // Understood by the standalone builds only, and actively harmful on
        // the App Store client, where it stops a grouped rule matching at
        // all. Same opt-in gate as the flat path.
        case "PROCESS-NAME":
            return options && options.allowProcessName
                ? leaf("process_name", value)
                : null;
        default:
            return null;
    }
}

// Option words that only ever meant something to the client doing its own
// resolution. `no-resolve` has no sing-box equivalent and is dropped; `src`
// is applied per-leaf. Anything else on a compound rule would be silently
// discarded, which is worse than not emitting the rule at all.
const MATCHER_SAFE_OPTIONS = new Set(["src", "no-resolve"]);

// Condition -> sing-box matcher, or null when it cannot be expressed.
//
// Null is deliberate rather than an exception: importers walk thousands of
// rules and need to drop the odd untranslatable one, not abandon the file.
//
// A branch that cannot be mapped fails the whole tree. Narrowing an AND by
// dropping a branch widens the rule - a REJECT meant for one host would catch
// everything else it matched.
export function conditionToSingboxMatcher(cond, options) {
    if (!isPlainObject(cond)) return null;

    if (Array.isArray(cond.children)) {
        const declared = cond.options || [];
        if (!declared.every((opt) => MATCHER_SAFE_OPTIONS.has(String(opt)))) return null;
        const rules = [];
        for (const child of cond.children) {
            const mapped = conditionToSingboxMatcher(child, options);
            if (mapped === null) return null;
            rules.push(mapped);
        }
        if (rules.length === 0) return null;
        const logical = {
            type: "logical",
            mode: cond.type === "OR" ? "or" : "and",
            rules,
        };
        // sing-box has no NOT: "none of these" is an AND group inverted.
        if (cond.type === "NOT") logical.invert = true;
        return logical;
    }

    return leafMatcher(cond, options);
}

export function isSupportedCondition(cond, options) {
    return conditionToSingboxMatcher(cond, options) !== null;
}

function attachTarget(matcher, target) {
    const action = rejectAction(target);
    if (action) return Object.assign({}, matcher, action);
    return Object.assign({}, matcher, { outbound: target || "proxy" });
}

// A single-element array collapses back to a scalar. Only the top level does
// this. Inside a logical rule the arrays stay, both because sing-box accepts
// them and because an array-valued field is what stops foldSingboxRules from
// merging two logical rules into one wider AND.
function unlist(matcher) {
    const out = {};
    for (const key of Object.keys(matcher)) {
        const value = matcher[key];
        out[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
    }
    return out;
}

// Condition + target -> a complete route rule, or null.
export function conditionToSingboxRule(cond, target, options) {
    if (!isPlainObject(cond)) return null;
    if (Array.isArray(cond.children)) {
        const matcher = conditionToSingboxMatcher(cond, options);
        if (matcher === null) return null;
        return attachTarget(matcher, target);
    }
    const matcher = leafMatcher(cond, options);
    if (matcher === null) return null;
    return attachTarget(unlist(matcher), target);
}

// The single entry point every rule source funnels through: a raw rule line, a
// parsed condition, an internal descriptor, or an object that is already a
// sing-box matcher. Returns null for anything that cannot be emitted, so
// callers can count it as skipped instead of writing a broken rule.
export function toRouteRule(rule, target, options) {
    if (typeof rule === "string") {
        const parsed = parseRuleLine(rule);
        // A FINAL/MATCH line carries no matcher - a caller wanting one sets
        // options.final instead.
        if (parsed === null || parsed.condition === null) return null;
        const policy = parsed.policy === null ? target : policyToTarget(parsed.policy);
        if (policy === null) return null;
        return conditionToSingboxRule(parsed.condition, policy, options);
    }
    if (!isPlainObject(rule)) return null;

    if (Array.isArray(rule.children)) {
        const policy = rule.outbound === undefined ? target : policyToTarget(rule.outbound);
        if (policy === null) return null;
        return conditionToSingboxRule(rule, policy, options);
    }

    if (rule.type !== undefined && rule.content !== undefined) {
        const policy = rule.outbound === undefined ? target : policyToTarget(rule.outbound);
        if (policy === null) return null;
        if (isSupportedType(rule.type, options)) return toSingboxRule(rule, policy);
        return conditionToSingboxRule(
            { type: rule.type, content: rule.content, options: rule.options || [] },
            policy,
            options,
        );
    }

    return rule; // already a sing-box matcher
}

export default {
    toSingboxMatcher,
    toSingboxRule,
    toSingboxRules,
    foldSingboxRules,
    toRouteRule,
    isRejectTarget,
    rejectAction,
    policyToTarget,
    isSupportedType,
    isSupportedCondition,
    conditionToSingboxMatcher,
    conditionToSingboxRule,
    SUPPORTED,
    OPT_IN_TYPES,
};
