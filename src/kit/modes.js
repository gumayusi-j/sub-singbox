// Clash-style mode switching (规则判定 / 全局代理 / 直接连接).
//
// Ported from Tower's SingBoxDNSPolicy. sing-box exposes a dashboard through
// `experimental.clash_api`, and the `clash_mode` predicate on a route or DNS
// rule matches whatever the user picks there. That only works if three things
// agree:
//
//   1. `default_mode` names a mode that actually exists,
//   2. a route rule branches on each mode,
//   3. a DNS rule branches on each mode, so resolution follows the mode too.
//
// Without all three the dashboard offers a selector wired to nothing, which is
// exactly what a bare `default_mode: "Enhanced"` used to be here.
//
// Mode names are exported identifiers and deliberately not localised at
// runtime: they are written into configs, so they must not change with the UI
// language.

import { onlyLeaves } from "./dns-policy";

export const RULE_MODE = "规则判定";
export const GLOBAL_MODE = "全局代理";
export const DIRECT_MODE = "直接连接";

// The selector global mode routes through. Named so the dashboard shows a
// familiar label rather than an internal identifier.
const GLOBAL_TAG = "全局代理";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function allTags(outbounds) {
    const tags = new Set();
    for (const outbound of outbounds || []) {
        if (isPlainObject(outbound) && typeof outbound.tag === "string") {
            tags.add(outbound.tag);
        }
    }
    return tags;
}

function uniqueTag(base, used) {
    let candidate = base;
    let i = 0;
    while (used.has(candidate)) {
        i += 1;
        candidate = base + " " + i;
    }
    used.add(candidate);
    return candidate;
}

// Where the mode branches go. They must beat the CN-direct *destination* rules
// (otherwise global mode would still send Chinese traffic direct) but must sit
// behind the private-IP rule, so switching to global does not cut off the LAN.
// Falls back to just after the DNS hijack when there is no private-IP rule.
function insertionIndex(routeRules) {
    let index = -1;
    routeRules.forEach((rule, i) => {
        if (isPlainObject(rule) && rule.ip_is_private !== undefined) index = i;
    });
    if (index >= 0) return index + 1;
    routeRules.forEach((rule, i) => {
        if (isPlainObject(rule) && rule.action === "hijack-dns") index = i;
    });
    return index + 1;
}

// Which group the remote DNS should be reached through: the first candidate
// whose members are all real nodes. A group that could resolve to DIRECT would
// answer DNS in the clear, which is the failure mode this guards against
// (Tower's `onlyLeaves` check). Returns null when no candidate qualifies.
export function pickDnsDetour(outbounds, nodeTags, candidates) {
    if (!Array.isArray(outbounds)) return null;
    const nodes = Array.isArray(nodeTags) ? nodeTags : [];
    if (nodes.length === 0) return null;

    // The walk itself lives in dns-policy, so this leak check and the
    // directness test the DNS projection uses cannot drift apart.
    const allowed = new Set(nodes);
    for (const candidate of candidates || []) {
        if (typeof candidate !== "string" || candidate === "") continue;
        if (onlyLeaves(candidate, allowed, outbounds)) return candidate;
    }
    return null;
}

// applyClashModes(config, options) -> boolean (true when the config changed)
//
//   nodeTags ...... tags of the real proxy nodes (required)
//   autoTag ....... tag of a urltest group over all nodes, if one exists
//   directTag ..... tag of the direct outbound (required)
//   localDnsTag ... tag of the plain resolver, if the config has one
//   remoteDnsTag .. tag of the remote resolver to clone for global mode
export function applyClashModes(config, options) {
    options = options || {};
    if (!isPlainObject(config)) return false;

    const outbounds = config.outbounds;
    const route = config.route;
    if (!Array.isArray(outbounds) || !isPlainObject(route)) return false;
    if (!Array.isArray(route.rules)) route.rules = [];

    const nodeTags = Array.isArray(options.nodeTags)
        ? options.nodeTags.filter((tag) => typeof tag === "string")
        : [];
    const directTag = options.directTag;
    if (nodeTags.length === 0 || typeof directTag !== "string" || directTag === "") {
        return false;
    }

    const used = allTags(outbounds);

    // A `全局代理` selector, inserted first so it is what the dashboard shows
    // at the top. It defaults to the automatic group, so flipping to global
    // mode still picks a healthy node, while any single node can be pinned.
    const globalMembers = [];
    if (
        typeof options.autoTag === "string" &&
        outbounds.some((outbound) => outbound.tag === options.autoTag)
    ) {
        globalMembers.push(options.autoTag);
    }
    globalMembers.push(...nodeTags);
    const globalTag = uniqueTag(GLOBAL_TAG, used);
    outbounds.unshift({
        type: "selector",
        tag: globalTag,
        outbounds: globalMembers,
        default: globalMembers[0],
        // Otherwise a mode switch leaves established connections on the old
        // route until they happen to close.
        interrupt_exist_connections: true,
    });

    // DNS must follow the mode too, or global mode would resolve through the
    // direct resolver and hand back polluted answers.
    const dns = isPlainObject(config.dns) ? config.dns : null;
    let globalDnsTag = null;
    if (dns && Array.isArray(dns.servers)) {
        const remote = dns.servers.find(
            (server) => isPlainObject(server) && server.tag === options.remoteDnsTag,
        );
        if (remote) {
            const dnsUsed = new Set(
                dns.servers
                    .map((server) => (isPlainObject(server) ? server.tag : undefined))
                    .filter(Boolean),
            );
            globalDnsTag = uniqueTag(String(remote.tag) + "-global", dnsUsed);
            const clone = Object.assign({}, remote, { tag: globalDnsTag, detour: globalTag });
            dns.servers.push(clone);
        }

        const modeDnsRules = [];
        if (typeof options.localDnsTag === "string" && options.localDnsTag !== "") {
            modeDnsRules.push({
                clash_mode: DIRECT_MODE,
                action: "route",
                server: options.localDnsTag,
            });
        }
        modeDnsRules.push(
            globalDnsTag
                ? { clash_mode: GLOBAL_MODE, action: "route", server: globalDnsTag }
                : { clash_mode: GLOBAL_MODE, action: "reject" },
        );
        dns.rules = modeDnsRules.concat(Array.isArray(dns.rules) ? dns.rules : []);
    }

    // `resolve` comes first so user destinations go through the DNS module (and
    // therefore through the rules above) rather than through the separate
    // resolver that bootstraps outbound server names.
    const modeRules = [
        { action: "resolve" },
        { clash_mode: GLOBAL_MODE, action: "route", outbound: globalTag },
        { clash_mode: DIRECT_MODE, action: "route", outbound: directTag },
    ];
    route.rules.splice(insertionIndex(route.rules), 0, ...modeRules);

    // Rule mode needs no branch of its own: route.final already points at the
    // proxy selector, so it is the fallthrough.
    const experimental = isPlainObject(config.experimental) ? config.experimental : {};
    const clashApi = isPlainObject(experimental.clash_api) ? experimental.clash_api : {};
    clashApi.default_mode = RULE_MODE;
    experimental.clash_api = clashApi;
    config.experimental = experimental;

    return true;
}

export default { RULE_MODE, GLOBAL_MODE, DIRECT_MODE, applyClashModes, pickDnsDetour };
