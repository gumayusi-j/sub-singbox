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
    return Object.assign({}, toSingboxMatcher(rule), {
        outbound: outbound || "proxy",
    });
}

export function toSingboxRules(rules, outbound) {
    if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
    return rules.map(function (rule) {
        return toSingboxRule(rule, outbound);
    });
}

export default { toSingboxMatcher, toSingboxRule, toSingboxRules, SUPPORTED };
