import {
    defaultLog,
    defaultInbounds,
    defaultDns,
    defaultRoute,
    defaultHttpClients,
    defaultExperimental,
} from "./defaults";
import { toSingboxRule } from "./rules/singbox";
import { migrateConfig, CompatError } from "./compat";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function dnsHasServer(dns, tag) {
    return (
        isPlainObject(dns) &&
        Array.isArray(dns.servers) &&
        dns.servers.some((s) => s && typeof s === "object" && s.tag === tag)
    );
}

function collectTags(outbounds) {
    const tags = new Set();
    for (const o of outbounds || []) {
        if (o && typeof o.tag === "string") tags.add(o.tag);
    }
    return tags;
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

function addProxyGroups(outbounds, options, existing) {
    const tags = [];
    for (const o of outbounds || []) {
        if (o && typeof o.tag === "string") tags.push(o.tag);
    }
    const groups = [];
    let autoTag;
    if (options.addAutoGroup !== false && tags.length > 0) {
        autoTag = uniqueTag(options.autoGroupTag || "auto", existing);
        groups.push({ type: "urltest", tag: autoTag, outbounds: tags.slice() });
    }
    const proxyTag = uniqueTag(options.proxyGroupTag || "proxy", existing);
    const selectorOutbounds = tags.slice();
    if (autoTag) selectorOutbounds.push(autoTag);
    const selector = {
        type: "selector",
        tag: proxyTag,
        outbounds: selectorOutbounds,
    };
    if (options.defaultSelector) selector.default = options.defaultSelector;
    groups.push(selector);
    return groups;
}

// System outbounds. The legacy special `dns` outbound ("dns-out") is NOT
// emitted: it was deprecated in sing-box 1.11.0 and removed in sing-box
// 1.13.0 (use the `hijack-dns` route-rule action instead), and nothing in
// the assembled config routes `protocol: dns` to it anyway.
function addSystemOutbounds(existing, options) {
    const outbounds = [];
    if (options.addDirect !== false) {
        const tag = uniqueTag("direct", existing);
        outbounds.push({ type: "direct", tag: tag });
    }
    if (options.addBlock !== false) {
        const tag = uniqueTag("block", existing);
        outbounds.push({ type: "block", tag: tag });
    }
    return outbounds;
}

// Normalize a single provided rule into a sing-box route rule object.
function normalizeProvidedRule(rule, defaultOutbound) {
    if (typeof rule === "string") {
        const parts = rule.split(",").map((p) => p.trim());
        const outbound = parts[2] || defaultOutbound;
        return toSingboxRule({ type: parts[0], content: parts[1] }, outbound);
    }
    if (!isPlainObject(rule)) return rule;
    if (rule.type && rule.content !== undefined) {
        // internal descriptor { type, content, outbound? }
        return toSingboxRule(rule, rule.outbound || defaultOutbound);
    }
    // already a sing-box matcher, e.g. { ip_is_private: true, outbound: "direct" }
    return rule;
}

function normalizeProvidedRules(rules, defaultOutbound) {
    if (!Array.isArray(rules) || rules.length === 0) return [];
    return rules.map((rule) =>
        normalizeProvidedRule(rule, defaultOutbound),
    );
}

// assemble(parsed, options):
//   parsed = { outbounds: [], endpoints: [] } (as produced by kit/convert) or a
//            plain array of outbound objects.
// Returns a complete sing-box config object ({ log, dns, inbounds, outbounds,
// endpoints?, route }).
export default function assemble(parsed, options) {
    options = options || {};
    // "client" (default) emits the full tun + clash_api + CN-direct skeleton;
    // "proxy" keeps the minimal local mixed-proxy config.
    const proxyMode = options.mode === "proxy";
    let source;
    if (isPlainObject(parsed) && Array.isArray(parsed.outbounds)) {
        source = parsed;
    } else if (Array.isArray(parsed)) {
        source = { outbounds: parsed, endpoints: [] };
    } else {
        source = { outbounds: [], endpoints: (parsed && parsed.endpoints) || [] };
    }
    const outbounds = (source.outbounds || []).slice();

    const existing = collectTags(outbounds);
    const groups = addProxyGroups(outbounds, options, existing);
    const system = addSystemOutbounds(existing, options);

    const configOutbounds = outbounds.concat(groups, system);

    const providedRules = normalizeProvidedRules(
        options.rules,
        options.ruleOutbound || "proxy",
    );

    const route = options.route
        ? options.route
        : defaultRoute(options);
    if (!Array.isArray(route.rules)) route.rules = [];
    if (providedRules.length > 0) {
        route.rules = providedRules.concat(route.rules);
    }

    const config = {
        log: options.log || defaultLog(options),
        dns: options.dns || defaultDns(options),
        inbounds: options.inbounds || defaultInbounds(options),
        outbounds: configOutbounds,
        route: route,
    };

    const endpoints = (source.endpoints || []).concat(options.endpoints || []);
    if (endpoints.length > 0) config.endpoints = endpoints;

    // Client profile ships the dashboard + HTTP client plumbing needed by the
    // remote rule-sets and clash_api skeleton. options.extra can still
    // override http_clients / experimental afterwards.
    if (!proxyMode) {
        if (config.http_clients === undefined) {
            config.http_clients = defaultHttpClients();
        }
        if (config.experimental === undefined) {
            config.experimental = defaultExperimental();
        }
    }

    if (options.extra) {
        for (const key of Object.keys(options.extra)) {
            config[key] = options.extra[key];
        }
    }

    // sing-box 1.14 removed `outbound` DNS-rule items; resolution for
    // outbound/dial domains now needs route.default_domain_resolver (or a
    // per-outbound domain_resolver). When using the default route and a
    // "local" DNS server exists, default to the local system resolver for
    // bootstrapping, avoiding proxy self-recursion. Options can opt out with
    // defaultDomainResolver: false or provide options.route wholesale.
    if (
        options.defaultDomainResolver !== false &&
        !options.route &&
        config.route === route &&
        config.route &&
        config.route.default_domain_resolver === undefined &&
        dnsHasServer(config.dns, "local")
    ) {
        config.route.default_domain_resolver = { server: "local" };
    }

    // Keep the emitted config aligned with sing-box 1.16: auto-migrate
    // 1.14-deprecated fields and reject what cannot be migrated safely.
    const result = migrateConfig(config);
    if (result.errors.length > 0) {
        throw new CompatError(result.errors, result.warnings);
    }
    if (typeof options.onWarning === "function" && result.warnings.length > 0) {
        options.onWarning(result.warnings);
    }
    return result.config;
}
