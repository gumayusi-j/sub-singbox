import {
    defaultLog,
    defaultInbounds,
    defaultDns,
    defaultRoute,
    defaultHttpClients,
    defaultExperimental,
    localDnsTag,
} from "./defaults";
import { toRouteRule, foldSingboxRules } from "./rules/singbox";
import { defaultsToDirect, projectDnsRules } from "./dns-policy";
import { applyClashModes } from "./modes";
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

// A urltest group needs a probe target plus cadence or it silently falls back
// to the reference defaults sing-box ships. These mirror the values Tower's
// generator uses for its automatic groups.
const DEFAULT_AUTO_URL = "https://www.gstatic.com/generate_204";
const DEFAULT_AUTO_INTERVAL = "300s";
const DEFAULT_AUTO_TOLERANCE = 50;

function autoGroupEnabled(options) {
    return options.addAutoGroup !== false && options.autoGroup !== false;
}

function pickScalar(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

function addProxyGroups(outbounds, options, existing) {
    const tags = [];
    for (const o of outbounds || []) {
        if (o && typeof o.tag === "string") tags.push(o.tag);
    }
    const groups = [];
    let autoTag;
    if (autoGroupEnabled(options) && tags.length > 0) {
        autoTag = uniqueTag(options.autoGroupTag || "auto", existing);
        const auto = {
            type: "urltest",
            tag: autoTag,
            outbounds: tags.slice(),
        };
        if (options.autoGroupUrl !== false) {
            auto.url = pickScalar(options.autoGroupUrl, DEFAULT_AUTO_URL);
        }
        if (options.autoInterval !== false) {
            auto.interval = pickScalar(options.autoInterval, DEFAULT_AUTO_INTERVAL);
        }
        if (options.autoTolerance !== false) {
            auto.tolerance = pickScalar(options.autoTolerance, DEFAULT_AUTO_TOLERANCE);
        }
        groups.push(auto);
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

// Normalize a single provided rule into a sing-box route rule object. Returns
// null for a rule whose matcher this target cannot express, so the caller can
// drop it and report the omission instead of emitting a rule that never fires.
//
// Every rule source funnels through the shared dispatcher so a raw line, a
// parsed condition, a descriptor object and a ready-made matcher all behave
// the same wherever they arrive from. The condition tree case is what makes a
// logical rule safe here: an AND tree has no `content`, so without it the rule
// would fall through to the "already a matcher" branch below and land in
// route.rules as an object sing-box refuses to start on.
function normalizeProvidedRule(rule, defaultOutbound, options) {
    return toRouteRule(rule, defaultOutbound, options);
}

function normalizeProvidedRules(rules, defaultOutbound, options) {
    if (!Array.isArray(rules) || rules.length === 0) return [];
    const out = [];
    for (const rule of rules) {
        const normalized = normalizeProvidedRule(rule, defaultOutbound, options);
        if (normalized == null) {
            if (typeof options.onSkip === "function") options.onSkip(rule);
            continue;
        }
        out.push(normalized);
    }
    return out;
}

// Clash-mode DNS branches sit first and are unconditional when their mode is
// active, so anything projected from a destination rule has to land behind
// them - otherwise a direct-routed domain would resolve locally even under
// 全局代理.
function insertAfterClashModes(rules, inserted) {
    let index = 0;
    while (
        index < rules.length &&
        isPlainObject(rules[index]) &&
        rules[index].clash_mode !== undefined
    ) {
        index += 1;
    }
    return rules.slice(0, index).concat(inserted, rules.slice(index));
}

// Merge caller-supplied overrides after all defaults have been applied so
// `options.extra` can always win (route/dns/outbounds/... wholesale).
function applyExtras(config, options) {
    if (options.extra) {
        for (const key of Object.keys(options.extra)) {
            config[key] = options.extra[key];
        }
    }
    return config;
}

function migrateAndWarn(config, options) {
    const result = migrateConfig(config);
    if (result.errors.length > 0) {
        throw new CompatError(result.errors, result.warnings);
    }
    if (typeof options.onWarning === "function" && result.warnings.length > 0) {
        options.onWarning(result.warnings);
    }
    return result.config;
}

// A document with no proxies at all (empty subscription, or every node was
// skipped) still assembles to a bootable config. The normal skeleton would
// otherwise dangle a DNS detour and route.final on a `proxy` selector that
// never gets created - and sing-box refuses to start on dangling references.
// Mirroring Tower, fall back to a minimal direct profile instead.
function directOnlyConfig(options) {
    const config = {
        log: options.log || defaultLog(options),
        dns: {
            servers: [{ type: "local", tag: "local" }],
            rules: [],
            final: "local",
        },
        inbounds: options.inbounds || defaultInbounds(options),
        outbounds: [{ type: "direct", tag: "direct" }],
        route: {
            auto_detect_interface: options.autoDetectInterface !== false,
            rules: [
                { action: "sniff" },
                {
                    type: "logical",
                    mode: "or",
                    rules: [
                        { protocol: "dns" },
                        { port: 53 },
                    ],
                    action: "hijack-dns",
                },
                { ip_is_private: true, outbound: "direct" },
            ],
            final: "direct",
            default_domain_resolver: { server: "local" },
        },
    };
    if (config.experimental === undefined) {
        // No proxy exists to switch to, so no dashboard either.
        config.experimental = defaultExperimental({ clashApi: false });
    }
    return applyExtras(config, options);
}

// assemble(parsed, options):
//   parsed = { outbounds: [], endpoints: [] } (as produced by kit/convert) or a
//            plain array of outbound objects.
// Returns a complete sing-box config object ({ log, dns, inbounds, outbounds,
// endpoints?, route }).
export default function assemble(parsed, options) {
    options = options || {};
    let source;
    if (isPlainObject(parsed) && Array.isArray(parsed.outbounds)) {
        source = parsed;
    } else if (Array.isArray(parsed)) {
        source = { outbounds: parsed, endpoints: [] };
    } else {
        source = { outbounds: [], endpoints: (parsed && parsed.endpoints) || [] };
    }
    const outbounds = (source.outbounds || []).slice();
    const endpoints = (source.endpoints || []).concat(options.endpoints || []);

    // Zero-node documents produce no proxy groups; emit a minimal direct
    // profile instead of a config that cannot boot.
    if (outbounds.length === 0 && endpoints.length === 0) {
        return migrateAndWarn(directOnlyConfig(options), options);
    }

    const existing = collectTags(outbounds);
    const groups = addProxyGroups(outbounds, options, existing);
    const system = addSystemOutbounds(existing, options);

    const configOutbounds = outbounds.concat(groups, system);

    let providedRules = normalizeProvidedRules(
        options.rules,
        options.ruleOutbound || "proxy",
        Object.assign({ onSkip: options.onSkipRule }, options),
    );
    if (options.foldRules) {
        providedRules = foldSingboxRules(providedRules);
    }

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

    if (endpoints.length > 0) config.endpoints = endpoints;

    // The dashboard + HTTP client plumbing needed by the remote rule-sets and
    // clash_api skeleton. options.extra can still override http_clients /
    // experimental afterwards.
    if (config.http_clients === undefined) {
        config.http_clients = defaultHttpClients(config.dns);
    }
    if (config.experimental === undefined) {
        config.experimental = defaultExperimental(options);
    }

    // Clash-style mode switching. Applied before applyExtras so a caller that
    // passes `extra` still wins outright. A caller supplying their own `dns` or
    // `route` is replacing the skeleton the mode branches belong to, so leave
    // their document exactly as they wrote it.
    if (options.clashModes !== false && !options.dns && !options.route) {
        const dnsServers = (config.dns && config.dns.servers) || [];
        const localTag = localDnsTag(config.dns);
        const remoteDns = dnsServers.find((s) => s && s.tag !== localTag);
        const directOutbound = system.find((o) => o.type === "direct");
        const autoGroup = groups.find((g) => g.type === "urltest");
        applyClashModes(config, {
            nodeTags: outbounds.map((o) => o && o.tag).filter((t) => typeof t === "string"),
            autoTag: autoGroup ? autoGroup.tag : null,
            directTag: directOutbound ? directOutbound.tag : null,
            localDnsTag: localTag,
            remoteDnsTag: remoteDns ? remoteDns.tag : null,
        });
    }

    // A caller-supplied rule that routes a domain direct needs the resolver to
    // agree, or a nearby connection gets an answer from the far side of the
    // proxy. Same projection the ACL builder does; only the destination rules
    // carry domain matchers, so it stays a short list.
    //
    // It goes after the clash-mode branches: under 全局代理 a direct-routed
    // domain still has to resolve through the proxy.
    if (
        !options.dns &&
        isPlainObject(config.dns) &&
        Array.isArray(config.dns.rules) &&
        dnsHasServer(config.dns, "local")
    ) {
        const projected = projectDnsRules(config.route.rules, configOutbounds, {
            localServer: "local",
        });
        if (projected.length > 0) {
            config.dns.rules = insertAfterClashModes(config.dns.rules, projected);
        }
        if (defaultsToDirect(config.route.final, configOutbounds)) {
            config.dns.final = "local";
        }
    }

    applyExtras(config, options);

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

    return migrateAndWarn(config, options);
}
