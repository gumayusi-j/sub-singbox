// sing-box 1.14 → 1.16 config compatibility layer.
//
// sing-box 1.14.0 deprecated a batch of fields/behaviors scheduled for removal
// in 1.16.0. kit/assemble normally produces none of them, but route/dns/extra
// options are passed through verbatim, so caller-injected config could carry
// legacy fields that a modern sing-box will refuse at startup.
//
// This module inspects a complete config and either auto-migrates the
// auto-safe deprecations or raises a hard (startup-rejection) error for the
// ones that need information a static pass cannot safely guess. analyzeConfig
// is read-only; migrateConfig never mutates its argument.

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
    if (!isPlainObject(value) && !Array.isArray(value)) return value;
    try {
        return structuredClone(value);
    } catch (_e) {
        return JSON.parse(JSON.stringify(value));
    }
}

function uniqueTag(tag, existing) {
    let candidate = tag;
    let i = 0;
    while (existing.has(candidate)) {
        i += 1;
        candidate = tag + "-" + i;
    }
    existing.add(candidate);
    return candidate;
}

// Deterministic key-sorted serialization, used to compare object contents
// regardless of insertion order.
function canonical(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

function withoutKeys(obj, excluded) {
    const out = {};
    for (const key of Object.keys(obj)) {
        if (!excluded.includes(key)) out[key] = obj[key];
    }
    return out;
}

// Small stable hash so auto-generated tags are reproducible across runs.
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function finding(code, severity, path, message, suggestion) {
    return { code, severity, path, message, suggestion };
}

function emptyReport() {
    return { findings: [], warnings: [], errors: [] };
}

function partition(report, findings) {
    report.findings = findings;
    report.warnings = findings.filter((f) => f.severity === "warn");
    report.errors = findings.filter((f) => f.severity === "error");
    return report;
}

function outboundTags(config) {
    const tags = new Set();
    for (const o of config.outbounds || []) {
        if (o && typeof o.tag === "string") tags.add(o.tag);
    }
    return tags;
}

// Is this a remotely-downloaded rule-set (the only kind that used an HTTP
// client to fetch)?
function isRemoteRuleSetEntry(entry) {
    if (!isPlainObject(entry)) return false;
    if (entry.type === "remote") return true;
    return entry.type == null && typeof entry.url === "string";
}

// Walk dns/route rule lists, descending into logical compound rules.
function walkRules(rules, path, cb) {
    if (!Array.isArray(rules)) return;
    rules.forEach((rule, i) => {
        const p = path + "[" + i + "]";
        cb(rule, p);
        if (isPlainObject(rule) && rule.type === "logical" && Array.isArray(rule.rules)) {
            walkRules(rule.rules, p + ".rules", cb);
        }
    });
}

// ---------------------------------------------------------------------------
// Inspection (read-only). Every rule pushes findings into `out`.
// ---------------------------------------------------------------------------

// R1a — download_detour on remote rule-sets.
function inspectRuleSetDownloadDetour(config, out) {
    const route = config.route;
    if (!isPlainObject(route) || !Array.isArray(route.rule_set)) return;
    const tags = outboundTags(config);
    route.rule_set.forEach((entry, i) => {
        if (!isRemoteRuleSetEntry(entry) || entry.download_detour === undefined) return;
        const detour = entry.download_detour;
        const path = "route.rule_set[" + i + "].download_detour";
        if (entry.http_client != null) {
            out.push(finding("rule_set_download_detour", "warn", path,
                "download_detour on a remote rule-set was removed in sing-box 1.16; http_client is already set, dropping download_detour.",
                "Remove the download_detour field (http_client takes precedence)."));
        } else if (typeof detour !== "string" || !tags.has(detour)) {
            out.push(finding("rule_set_download_detour", "warn", path,
                "download_detour on a remote rule-set was removed in sing-box 1.16; the referenced outbound no longer exists, so the entry falls back to the default HTTP client.",
                "Ensure the outbound exists, or configure http_clients / route.default_http_client explicitly."));
        } else {
            out.push(finding("rule_set_download_detour", "warn", path,
                "download_detour on a remote rule-set was removed in sing-box 1.16; migrating to an explicit http_client.",
                "Uses http_clients with detour '" + detour + "' and points the rule-set at it."));
        }
    });
}

// R1b — remote rule-sets with no explicit HTTP client (implicit default).
function inspectImplicitHttpClient(config, out) {
    const route = config.route;
    if (!isPlainObject(route) || !Array.isArray(route.rule_set)) return;
    const hasRemote = route.rule_set.some(isRemoteRuleSetEntry);
    if (!hasRemote) return;
    const clients = config.http_clients;
    const hasClients = Array.isArray(clients) && clients.length > 0;
    const hasDefault = typeof route.default_http_client === "string" && route.default_http_client !== "";
    if (hasClients && hasDefault) return;
    out.push(finding("rule_set_implicit_http_client", "warn",
        hasClients ? "route.default_http_client" : "http_clients",
        "Remote rule-set downloads used the implicit default HTTP client, which was removed in sing-box 1.16; configuring http_clients and route.default_http_client explicitly.",
        "Declare http_clients and set route.default_http_client to one of their tags."));
}

// R2 — inline tls.acme.
function inspectInlineAcme(config, out) {
    const inbounds = config.inbounds;
    if (!Array.isArray(inbounds)) return;
    inbounds.forEach((inbound, i) => {
        if (!isPlainObject(inbound)) return;
        const tls = inbound.tls;
        if (!isPlainObject(tls) || !isPlainObject(tls.acme)) return;
        out.push(finding("inbound_inline_acme", "warn", "inbounds[" + i + "].tls.acme",
            "Inline tls.acme was removed in sing-box 1.16; migrating to a certificate_providers entry.",
            "Hoists the ACME options into certificate_providers and references them via tls.certificate_provider."));
    });
}

// R3 — legacy strategy on DNS rules.
function inspectDnsStrategy(config, out) {
    const dns = config.dns;
    if (!isPlainObject(dns)) return;
    walkRules(dns.rules, "dns.rules", (rule, p) => {
        if (!isPlainObject(rule)) return;
        if (rule.strategy !== undefined) {
            out.push(finding("dns_rule_strategy", "error", p + ".strategy",
                "legacy 'strategy' on a DNS rule was removed in sing-box 1.16.",
                "Move the domain strategy (prefer_ipv4|prefer_ipv6|ipv4_only|ipv6_only) onto the DNS server this rule routes to (dns.servers[*].strategy), or remove the field; auto-migration is skipped because the server may be shared by other rules."));
        }
        const action = rule.action;
        if (isPlainObject(action) && action.strategy !== undefined) {
            out.push(finding("dns_rule_strategy", "error", p + ".action.strategy",
                "legacy 'strategy' inside a DNS rule action was removed in sing-box 1.16.",
                "Move the strategy to the target DNS server (dns.servers[*].strategy), or remove the field."));
        }
    });
}

// R4 — legacy rule_set_ip_cidr_accept_empty DNS rule item.
function inspectDnsRuleSetAcceptEmpty(config, out) {
    const dns = config.dns;
    if (!isPlainObject(dns)) return;
    walkRules(dns.rules, "dns.rules", (rule, p) => {
        if (!isPlainObject(rule)) return;
        if (rule.rule_set_ip_cidr_accept_empty !== undefined) {
            out.push(finding("dns_rule_rule_set_ip_cidr_accept_empty", "warn",
                p + ".rule_set_ip_cidr_accept_empty",
                "rule_set_ip_cidr_accept_empty on a DNS rule was removed in sing-box 1.16; the flag is dropped.",
                "Remove the field; ip_cidr matching is used directly."));
        }
    });
}

// R5 — dns.independent_cache.
function inspectIndependentCache(config, out) {
    const dns = config.dns;
    if (!isPlainObject(dns) || dns.independent_cache === undefined) return;
    out.push(finding("dns_independent_cache", "warn", "dns.independent_cache",
        "dns.independent_cache was removed in sing-box 1.16; the DNS cache now always keys by transport.",
        "Remove the field."));
}

// R6 — experimental.cache_file.store_rdrc.
function inspectStoreRdrc(config, out) {
    const cache = config.experimental && config.experimental.cache_file;
    if (!isPlainObject(cache) || cache.store_rdrc === undefined) return;
    out.push(finding("cache_file_store_rdrc", "warn", "experimental.cache_file.store_rdrc",
        "store_rdrc was removed in sing-box 1.16; store_dns persists the full DNS cache.",
        "Rename to store_dns."));
}

// R7 — legacy address filtering in DNS rules (no match_response).
function inspectLegacyAddressFilter(config, out) {
    const dns = config.dns;
    if (!isPlainObject(dns)) return;
    walkRules(dns.rules, "dns.rules", (rule, p) => {
        if (!isPlainObject(rule)) return;
        if (rule.match_response != null) return; // response matching is legal
        for (const key of ["ip_cidr", "ip_is_private"]) {
            if (rule[key] !== undefined) {
                out.push(finding("dns_rule_legacy_address_filter", "error", p + "." + key,
                    "DNS rule filters the response address (" + key + ") without match_response; legacy address filtering in DNS rules was removed in sing-box 1.16.",
                    "Split into two rules: (1) { \"action\": \"evaluate\", \"server\": \"<the DNS server resolving this query>\" }, (2) { \"match_response\": true, <original matchers>, \"action\": \"route\", ... }. Verify ordering against respond/reject and the ip_version/query_type startup-rejection rule first."));
            }
        }
    });
}

const INSPECTIONS = [
    inspectRuleSetDownloadDetour,
    inspectImplicitHttpClient,
    inspectInlineAcme,
    inspectDnsStrategy,
    inspectDnsRuleSetAcceptEmpty,
    inspectIndependentCache,
    inspectStoreRdrc,
    inspectLegacyAddressFilter,
];

// ---------------------------------------------------------------------------
// Migration (mutates a draft copy).
// ---------------------------------------------------------------------------

function applyRuleSetHttpClients(cfg) {
    const route = cfg.route;
    if (!isPlainObject(route) || !Array.isArray(route.rule_set)) return;
    const tags = outboundTags(cfg);

    let clients = cfg.http_clients;
    const hadClients = Array.isArray(clients) && clients.length > 0;
    if (!hadClients) clients = Array.isArray(clients) ? clients : [];
    const clientTags = new Set(clients.filter((c) => c && typeof c.tag === "string").map((c) => c.tag));
    const clientByDetour = new Map();
    for (const c of clients) {
        if (isPlainObject(c) && typeof c.tag === "string" && typeof c.detour === "string") {
            if (!clientByDetour.has(c.detour)) clientByDetour.set(c.detour, c.tag);
        }
    }
    let added = false;

    // R1a — rewrite each download_detour into an http_client reference.
    route.rule_set.forEach((entry) => {
        if (!isRemoteRuleSetEntry(entry) || entry.download_detour === undefined) return;
        const detour = entry.download_detour;
        delete entry.download_detour;
        added = true;
        if (entry.http_client != null) return; // http_client wins
        if (typeof detour !== "string" || !tags.has(detour)) return; // fall back to default client
        let tag = clientByDetour.get(detour);
        if (!tag) {
            tag = uniqueTag("rule-set-" + detour, clientTags);
            clients.push({ tag, detour });
            clientByDetour.set(detour, tag);
        }
        entry.http_client = tag;
    });

    // R1b — make the default HTTP client explicit whenever remote rule-sets exist.
    const hasRemote = route.rule_set.some(isRemoteRuleSetEntry);
    if (hasRemote) {
        const hasDefault = typeof route.default_http_client === "string" && route.default_http_client !== "";
        if (clients.length === 0 && !hasDefault) {
            const tag = uniqueTag("default-rule-set-client", clientTags);
            const client = { tag };
            if (typeof route.final === "string" && tags.has(route.final)) client.detour = route.final;
            clients.push(client);
            route.default_http_client = tag;
            added = true;
        } else if (clients.length > 0 && !hasDefault) {
            route.default_http_client = clients[0].tag;
            added = true;
        } else if (clients.length === 0 && hasDefault) {
            const client = { tag: route.default_http_client };
            if (typeof route.final === "string" && tags.has(route.final)) client.detour = route.final;
            clients.push(client);
            added = true;
        }
    }

    if (added) cfg.http_clients = clients;
}

function applyInlineAcme(cfg) {
    const inbounds = cfg.inbounds;
    if (!Array.isArray(inbounds)) return;
    let providers = cfg.certificate_providers;
    if (providers == null) providers = [];
    if (!Array.isArray(providers)) return; // invalid caller data; leave alone
    const providerTags = new Set(providers.filter((p) => p && typeof p.tag === "string").map((p) => p.tag));
    const providerByContent = new Map();
    for (const p of providers) {
        if (isPlainObject(p) && typeof p.tag === "string") {
            providerByContent.set(canonical(withoutKeys(p, ["tag", "type"])), p.tag);
        }
    }

    inbounds.forEach((inbound) => {
        const tls = inbound && isPlainObject(inbound) ? inbound.tls : null;
        if (!isPlainObject(tls) || !isPlainObject(tls.acme)) return;
        const content = canonical(withoutKeys(tls.acme, ["tag", "type"]));
        let tag = providerByContent.get(content);
        if (!tag) {
            tag = uniqueTag("acme-" + hash(content).slice(0, 6), providerTags);
            providers.push({ type: "acme", tag, ...tls.acme });
            providerByContent.set(content, tag);
        }
        tls.certificate_provider = tag;
        delete tls.acme;
    });

    if (providers.length > 0) cfg.certificate_providers = providers;
}

function dropDnsField(obj, key) {
    if (isPlainObject(obj) && obj[key] !== undefined) delete obj[key];
}

function applyDnsRuleSetAcceptEmpty(cfg) {
    const dns = cfg.dns;
    if (!isPlainObject(dns)) return;
    walkRules(dns.rules, "dns.rules", (rule) => {
        dropDnsField(rule, "rule_set_ip_cidr_accept_empty");
    });
}

function applyIndependentCache(cfg) {
    dropDnsField(cfg.dns, "independent_cache");
}

function applyStoreRdrc(cfg) {
    const cache = cfg.experimental && cfg.experimental.cache_file;
    if (!isPlainObject(cache) || cache.store_rdrc === undefined) return;
    const value = cache.store_rdrc;
    delete cache.store_rdrc;
    if (value === true && cache.store_dns === undefined) cache.store_dns = true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeConfig(config) {
    const report = emptyReport();
    if (!isPlainObject(config)) return report;
    const findings = [];
    for (const inspect of INSPECTIONS) inspect(config, findings);
    return partition(report, findings);
}

// Never mutates its argument. When only warnings (auto migrations) are found,
// returns a migrated deep copy; otherwise the original reference is returned
// unchanged so callers that choose to ignore errors keep exact input.
export function migrateConfig(config) {
    const pre = analyzeConfig(config);
    if (pre.warnings.length === 0) {
        return { config, findings: pre.findings, warnings: pre.warnings, errors: pre.errors };
    }
    const draft = deepClone(config);
    applyRuleSetHttpClients(draft);
    applyInlineAcme(draft);
    applyDnsRuleSetAcceptEmpty(draft);
    applyIndependentCache(draft);
    applyStoreRdrc(draft);
    const post = analyzeConfig(draft);
    return { config: draft, findings: post.findings, warnings: pre.warnings, errors: post.errors };
}

export function formatErrors(errors) {
    const lines = [
        "singbox-kit: config is not compatible with sing-box 1.16 (cannot be auto-migrated).",
    ];
    for (const e of errors || []) {
        lines.push("  - " + e.path + ": " + e.message);
        if (e.suggestion) lines.push("    fix: " + e.suggestion);
    }
    return lines.join("\n");
}

export class CompatError extends Error {
    constructor(errors, warnings) {
        super(formatErrors(errors));
        this.name = "CompatError";
        this.statusCode = 422;
        this.errors = errors || [];
        this.warnings = warnings || [];
    }
}

// Throws CompatError when the config contains startup-rejection findings.
export function assertCompatible(config) {
    const report = analyzeConfig(config);
    if (report.errors.length > 0) {
        throw new CompatError(report.errors, report.warnings);
    }
    return report.warnings;
}

export default {
    analyzeConfig,
    migrateConfig,
    assertCompatible,
    CompatError,
    formatErrors,
};
