// Build a complete sing-box config from a bundled ACL4SSR preset.
//
// The presets (ACL4SSR 默认 / 全分组 / 精简) mirror Tower's bundled
// ACL4SSR_Online*.ini: they define proxy groups (select / url-test, with node
// name regexes for region groups) and route every `.list` rule file to one of
// those groups. This module re-expresses that model for sing-box:
//
//   - select/url-test groups become real outbounds. Node-name regex members
//     (".*", region patterns) are expanded against the subscription's node
//     tags; groups that end up empty are dropped and all references to them
//     removed, so no config ever points at a group that does not exist.
//   - "reject" groups (members are only REJECT/DIRECT) are NOT emitted: the
//     rules routed to them become `action: reject`, matching sing-box 1.11+.
//   - every rule line is serialized through rules/singbox.js and the whole
//     route rule list is folded (adjacent same-target rules collapse into
//     array matchers), so a 7k-line GFW list becomes a handful of rules.
//
// assemble.js is left untouched; the web layer calls assembleAcl() only when
// an aclPreset is selected.
import { LISTS, PRESETS } from "./presets.generated";
import {
    defaultLog,
    defaultInbounds,
    defaultExperimental,
    defaultHttpClients,
    parseDnsAddress,
    applyBootstrapResolver,
    localDnsTag,
} from "../defaults";
import { toRouteRule, foldSingboxRules, rejectAction, policyToTarget } from "../rules/singbox";
import { parseRuleLine } from "../rules/syntax";
import { defaultsToDirect, projectDnsRules } from "../dns-policy";
import { applyClashModes } from "../modes";
import { migrateConfig, CompatError } from "../compat";

const AUTO_GROUP = "♻️ 自动选择";
const CN_GEOIP_URL =
    "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// Can a rule's policy actually be emitted? `direct` always exists (assembleAcl
// appends it), a reject word becomes an action rather than a tag, and anything
// else has to name a group this run managed to create. An imported config
// routinely references groups that resolved to zero nodes, and a rule pointing
// at a tag nothing declares stops sing-box from starting at all.
function isResolvableTarget(target, emitted) {
    if (typeof target !== "string" || target === "") return false;
    if (rejectAction(target) !== null) return true;
    if (target === "direct") return true;
    return emitted.has(target);
}

// What a drop group stands for. Its members are built-in policies rather than
// nodes, so the group is never emitted and the rules routed to it have to
// carry the policy themselves. REJECT wins when both are present, matching how
// the bundled `🛑 全球拦截` group reads.
function dropGroupTarget(group) {
    const members = Array.isArray(group.memberTokens) ? group.memberTokens : [];
    return members.some((token) => /^\[\]REJECT/i.test(token)) ? "REJECT" : "direct";
}

export function findPreset(id) {
    return PRESETS.find((p) => p.id === id) || null;
}

export function presetList() {
    return PRESETS.map((p) => ({ id: p.id, name: p.name, summary: p.summary }));
}

// Parse a ".list" snapshot into condition descriptors (cached).
//
// Anchors, quotes and parens all live in the shared rule syntax parser, so a
// `URL-REGEX,\/\/.*twitter\.com\/` keeps its slashes and an `IP-CIDR` line
// keeps the `no-resolve` that follows it - previously both were cut at the
// second comma. Lines this parser rejects are skipped, not fatal: a snapshot
// is thousands of lines and the odd malformed one should not sink the rest.
const listCache = new Map();
function listRules(name) {
    if (listCache.has(name)) return listCache.get(name);
    const text = LISTS[name] || "";
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        const parsed = parseRuleLine(raw);
        if (parsed === null || parsed.condition === null) continue;
        out.push(parsed.condition);
    }
    listCache.set(name, out);
    return out;
}

function matchTags(pattern, tags) {
    if (!pattern || pattern === ".*") return tags.slice();
    let re;
    try {
        re = new RegExp(pattern, "iu");
    } catch (_e) {
        return [];
    }
    return tags.filter((t) => re.test(t));
}

function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

// Emit the preset's non-reject groups as outbounds, resolving regex members
// against the node tags. Reference members are only kept when their target
// group is itself emitted, computed as a fixed point so a group that appears
// later in the ini can still be referenced (e.g. 节点选择 -> 地区组).
function buildGroups(preset, tags) {
    const specs = preset.groups.filter((g) => !g.drop);
    const emitted = new Set();
    const outbounds = [];

    const resolveGroup = (spec, emittedNow) => {
        if (spec.kind === "url-test") {
            const nodeRegex = spec.memberTokens[0] || ".*";
            const url = spec.memberTokens[1];
            const param = spec.memberTokens[2] || "";
            const matched = matchTags(nodeRegex, tags);
            if (matched.length === 0) return null;
            const group = {
                type: "urltest",
                tag: spec.tag,
                outbounds: matched,
            };
            if (url) group.url = url;
            // param is "interval,,tolerance" in the upstream ini (seconds).
            const nums = param.split(",");
            const interval = Number(nums[0]);
            const tolerance = Number(nums[2]);
            if (Number.isInteger(interval) && interval > 0) group.interval = interval + "s";
            if (Number.isInteger(tolerance) && tolerance > 0) group.tolerance = tolerance;
            return group;
        }
        // select: []ref members are group/builtin references, others are node
        // name regexes.
        const members = [];
        for (const token of spec.memberTokens) {
            if (!token) continue;
            if (token.startsWith("[]")) {
                const ref = token.slice(2);
                if (/^DIRECT$/i.test(ref)) members.push("direct");
                else if (/^REJECT$/i.test(ref)) continue;
                else if (emittedNow.has(ref)) members.push(ref);
                continue;
            }
            members.push(...matchTags(token, tags));
        }
        const list = dedupe(members);
        if (list.length === 0) return null;
        return { type: "selector", tag: spec.tag, outbounds: list };
    };

    // Fixed point: grow `emitted` until no new group can be resolved.
    for (let pass = 0; pass <= specs.length; pass += 1) {
        let changed = false;
        outbounds.length = 0;
        const nextEmitted = new Set();
        for (const spec of specs) {
            const group = resolveGroup(spec, emitted);
            if (group) {
                outbounds.push(group);
                nextEmitted.add(spec.tag);
            }
        }
        for (const tag of nextEmitted) {
            if (!emitted.has(tag)) changed = true;
        }
        emitted.clear();
        for (const tag of nextEmitted) emitted.add(tag);
        if (!changed) break;
    }

    return { outbounds, emitted };
}

function assembleRoute(preset, emitted, options) {
    const warnings = [];
    let skipped = 0;
    let usedGeoCn = false;

    const anchor = (group) => (emitted.has(group) ? group : null);
    const rules = [];

    // User-supplied extra rules go first so they can override the preset.
    const extra = Array.isArray(options.rules) ? options.rules : [];
    for (const rule of extra) {
        if (rule == null) continue;
        const normalized = toRouteRule(rule, options.ruleOutbound || "proxy", options);
        if (normalized == null) {
            skipped += 1;
            continue;
        }
        rules.push(normalized);
    }

    let finalTag = null;
    for (const entry of preset.rules) {
        if (entry.final) {
            // A group the preset never emitted cannot be route.final - that is
            // a dangling reference sing-box refuses to start on. Leaving it
            // null lets the fallback below pick something that exists.
            finalTag = anchor(entry.group);
            continue;
        }
        // An imported scheme carries its rules inline, each tagged with the
        // policy it was written against. Unlike a bundled `.list` those names
        // come from a foreign config, so every target is checked against the
        // outbounds this run actually produced before it is emitted.
        if (Array.isArray(entry.descriptors)) {
            // A group whose members are all built-in policies is never emitted
            // as an outbound - it is a stand-in for the policy itself. The
            // rules routed to it become that action, the same way the bundled
            // `🛑 全球拦截` group works.
            const dropGroup = preset.groups.find((g) => g.drop && g.tag === entry.group);
            for (const descriptor of entry.descriptors) {
                const target = dropGroup ? dropGroupTarget(dropGroup) : descriptor.outbound;
                if (!isResolvableTarget(target, emitted)) {
                    skipped += 1;
                    continue;
                }
                // The descriptor carries the policy it was imported under, and
                // toRouteRule lets that win over the target argument - which is
                // right for a caller-supplied rule and wrong here, where a drop
                // group is replacing that policy outright. Drop it so the
                // decision above is the one that takes effect.
                const stripped = Object.assign({}, descriptor);
                delete stripped.outbound;
                const rule = toRouteRule(stripped, target, options);
                if (rule === null) {
                    skipped += 1;
                    continue;
                }
                rules.push(rule);
            }
            continue;
        }
        if (entry.geoCn) {
            const outbound = anchor(entry.group);
            if (!outbound) {
                skipped += 1;
                continue;
            }
            usedGeoCn = true;
            rules.push({ rule_set: "geoip-cn", outbound: outbound });
            continue;
        }
        const reject = preset.groups.some((g) => g.drop && g.tag === entry.group);
        const outbound = reject ? "reject" : anchor(entry.group);
        if (!outbound) {
            skipped += 1;
            continue;
        }
        for (const descriptor of listRules(entry.list)) {
            const rule = toRouteRule(descriptor, outbound, options);
            if (rule === null) {
                // PROCESS-NAME (opt-in only) and types with no sing-box
                // equivalent such as URL-REGEX.
                skipped += 1;
                continue;
            }
            rules.push(rule);
        }
    }
    if (skipped > 0) {
        warnings.push({
            message:
                skipped + " 条规则无 sing-box 等价写法已跳过" +
                "（如 URL-REGEX、PROCESS-NAME 与空目标组）",
            path: "acl4ssr",
        });
    }

    // An imported scheme may carry a scheme-level `final` - the policy its
    // MATCH/FINAL line named. It resolves by the same conservative rules as a
    // rule target, and a reject fallthrough is spelled as a trailing rule
    // because route.final has to name an outbound.
    if (finalTag === null && typeof preset.final === "string") {
        const target = policyToTarget(preset.final);
        if (rejectAction(target) !== null) {
            rules.push({ action: "reject" });
        } else if (target === "direct" || (target !== null && emitted.has(target))) {
            finalTag = target;
        }
    }

    const folded = foldSingboxRules(rules.filter(Boolean));
    const route = {
        auto_detect_interface: options.autoDetectInterface !== false,
        rules: [
            { action: "sniff" },
            {
                type: "logical",
                mode: "or",
                rules: [{ protocol: "dns" }, { port: 53 }],
                action: "hijack-dns",
            },
            { ip_is_private: true, outbound: "direct" },
        ].concat(folded),
        final: finalTag || "direct",
        default_domain_resolver: { server: "local" },
    };
    if (usedGeoCn) {
        route.rule_set = [
            {
                type: "remote",
                tag: "geoip-cn",
                format: "binary",
                url: CN_GEOIP_URL,
                http_client: "default-client",
            },
        ];
        route.default_http_client = "default-client";
    }
    return { route, warnings };
}

// DNS: remote resolver reached through the auto group + a local fallback. No
// geosite rule-set is referenced, so the config carries no dangling remote
// dependency beyond the optional CN geoip used by the GEOIP,CN rule.
function buildDns(options, context) {
    const supplied = options.remoteDns;
    const defaultAddress = "tls://8.8.8.8";

    let remote;
    if (isPlainObject(supplied)) {
        remote = Object.assign({}, supplied, { tag: "remote" });
    } else {
        const address = supplied != null && String(supplied).trim() !== ""
            ? String(supplied).trim()
            : defaultAddress;
        const parsed = parseDnsAddress(address);
        remote = { type: parsed.type, tag: "remote" };
        if (parsed.type !== "local") {
            remote.server = parsed.server;
            remote.server_port = parsed.server_port;
            if (parsed.path) remote.path = parsed.path;
            remote.detour = AUTO_GROUP;
        }
    }
    if (remote.detour === undefined && remote.type !== "local") {
        remote.detour = AUTO_GROUP;
    }
    // A bare-IP DoT endpoint cannot verify its certificate without an SNI.
    if (
        remote.type === "tls" &&
        remote.server === "8.8.8.8" &&
        remote.tls === undefined
    ) {
        remote.tls = { enabled: true, server_name: "dns.google" };
    }

    const local = {
        type: "udp",
        tag: "local",
        server: options.localDns || "223.5.5.5",
    };

    const servers = [remote, local];
    // A remote resolver addressed by a hostname has to be resolvable before it
    // can answer anything; point it at the plain resolver (no-op when the
    // address is already a literal IP, which is the normal case).
    applyBootstrapResolver(servers, { servers });

    // The preset routes every domestic domain - ACL4SSR_ChinaDomain,
    // ACL4SSR_GoogleCN, the GEOIP,CN catch-all - to `🎯 全球直连`. Resolving
    // those through the remote resolver would answer a direct connection with
    // a far-away address, which is exactly the slowness this projection
    // removes: the route decision and the resolution decision now agree.
    const routeRules = context && Array.isArray(context.routeRules) ? context.routeRules : [];
    const outbounds = context ? context.outbounds : [];
    const directFinal = context ? defaultsToDirect(context.final, outbounds) : false;

    return {
        servers,
        rules: projectDnsRules(routeRules, outbounds, { localServer: "local" }),
        // The fallthrough has to agree with the route's too. A preset whose
        // final group ships selecting DIRECT should not resolve the rest of
        // the world through the proxy.
        final: directFinal ? "local" : "remote",
        strategy: dnsStrategy(options),
        reverse_mapping: true,
    };
}

// IPv6 is opt-in, and off unless asked for. On a network that advertises IPv6
// without carrying it, a dual-stack tunnel hands the client an address family
// that cannot be reached; the connection stalls before falling back, which
// reads as "some sites are slow". `prefer_ipv4` keeps v6 available for the
// networks that do work.
function dnsStrategy(options) {
    if (options.dnsStrategy) return options.dnsStrategy;
    return options.ipv6Enabled === true ? "prefer_ipv4" : "ipv4_only";
}

// Zero-node documents still need a bootable profile; mirror assemble.js's
// minimal direct fallback.
function directOnly(options) {
    return {
        log: defaultLog(options),
        dns: { servers: [{ type: "local", tag: "local" }], rules: [], final: "local" },
        inbounds: defaultInbounds(options),
        outbounds: [{ type: "direct", tag: "direct" }],
        route: {
            auto_detect_interface: options.autoDetectInterface !== false,
            rules: [
                { action: "sniff" },
                {
                    type: "logical",
                    mode: "or",
                    rules: [{ protocol: "dns" }, { port: 53 }],
                    action: "hijack-dns",
                },
                { ip_is_private: true, outbound: "direct" },
            ],
            final: "direct",
            default_domain_resolver: { server: "local" },
        },
        // No proxy exists to switch modes between, so no dashboard either.
        experimental: defaultExperimental({ clashApi: false }),
        http_clients: defaultHttpClients(),
    };
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

// assembleAcl(parsed, options): parsed = { outbounds, endpoints } as produced
// by kit/convert after any multi-source merge.
//
// options.aclScheme takes an already-resolved scheme object and wins over
// options.aclPreset, which is only an id. The caller resolves it - a custom
// scheme lives in the store, and kit/schemes.js already imports findPreset
// from here, so resolving it in this direction would close a require cycle.
export function assembleAcl(parsed, options) {
    options = options || {};
    const preset = options.aclScheme || findPreset(options.aclPreset);
    if (!preset) {
        throw new Error("singbox-kit: unknown ACL4SSR preset: " + options.aclPreset);
    }
    const source = isPlainObject(parsed) ? parsed : {};
    const nodes = (source.outbounds || []).slice();
    const endpoints = (source.endpoints || []).slice();

    if (nodes.length === 0 && endpoints.length === 0) {
        return migrateAndWarn(directOnly(options), options);
    }

    const tags = nodes.map((o) => o && o.tag).filter((t) => typeof t === "string");
    const { outbounds: groups, emitted } = buildGroups(preset, tags);
    const { route, warnings } = assembleRoute(preset, emitted, options);

    const outbounds = nodes.concat(groups, [{ type: "direct", tag: "direct" }]);
    const dns = buildDns(options, {
        routeRules: route.rules,
        outbounds,
        final: route.final,
    });
    const config = {
        log: defaultLog(options),
        dns,
        inbounds: defaultInbounds(options),
        outbounds: outbounds,
        route: route,
        experimental: defaultExperimental(options),
        http_clients: defaultHttpClients(dns),
    };
    if (endpoints.length > 0) config.endpoints = endpoints;

    // Clash-style mode switching, applied before `extra` so a caller override
    // still wins outright.
    if (options.clashModes !== false) {
        const localTag = localDnsTag(dns);
        const remoteDns = (dns.servers || []).find((s) => s && s.tag !== localTag);
        const autoGroup = groups.find((g) => g.type === "urltest");
        applyClashModes(config, {
            nodeTags: tags,
            autoTag: autoGroup ? autoGroup.tag : null,
            directTag: "direct",
            localDnsTag: localTag,
            remoteDnsTag: remoteDns ? remoteDns.tag : null,
        });
    }

    if (options.extra) {
        for (const key of Object.keys(options.extra)) config[key] = options.extra[key];
    }

    if (typeof options.onWarning === "function" && warnings.length > 0) {
        options.onWarning(warnings);
    }
    return migrateAndWarn(config, options);
}

export default { assembleAcl, findPreset, presetList };
