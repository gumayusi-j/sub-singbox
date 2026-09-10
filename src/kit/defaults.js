// Default building blocks for the generated sing-box config. Each can be
// replaced wholesale via assemble() options. Defaults target sing-box 1.14+
// (fields removed in 1.14 - legacy DNS server `address`, `outbound` DNS-rule
// items - are avoided; validate against your target version before shipping).
//
// There is exactly one output profile and it is Tower's: a tun inbound, a
// clash_api dashboard, split DNS (google over the proxy + a local CN
// resolver), sniff + hijack-dns route rules and remote geosite/geoip-CN
// rule-sets for China direct. A run shape is not a choice this kit offers -
// Tower hardcodes the same one, and the local mixed-proxy variant that used to
// live here as `mode: "proxy"` is gone.

import { RULE_MODE } from "./modes";

const DNS_DEFAULT_PORTS = {
    udp: 53,
    tcp: 53,
    tls: 853,
    https: 443,
    quic: 443,
    h3: 443,
};

export const CLIENT_REMOTE_DNS = "tls://8.8.8.8";
export const CLIENT_LOCAL_DNS = "223.5.5.5";

// Legacy sing-box (<1.12) spelled a DNS server as a single `address` string,
// e.g. "local", "udp://8.8.8.8", "tls://1.1.1.1", "https://host/dns-query".
// sing-box 1.14 removed that form; parse it into the modern
// { type, server, server_port, path? } object used by defaultDns and by the
// compat migration layer for caller-injected legacy servers.
export function parseDnsAddress(address) {
    const s = String(address == null ? "" : address).trim();
    if (s === "local") return { type: "local" };
    const m = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/);
    if (m) {
        const proto = m[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(DNS_DEFAULT_PORTS, proto)) {
            throw new Error("singbox-kit: unsupported DNS server scheme: " + proto);
        }
        const authority = m[2] || "";
        const host = authority.split(":")[0];
        const explicitPort = Number(authority.split(":")[1]);
        const serverPort =
            Number.isInteger(explicitPort) && explicitPort > 0
                ? explicitPort
                : DNS_DEFAULT_PORTS[proto];
        const parsed = { type: proto, server: host, server_port: serverPort };
        const path = m[3] || "";
        if (
            (proto === "https" || proto === "h3") &&
            path &&
            path !== "/" &&
            path !== "/dns-query"
        ) {
            parsed.path = path;
        }
        return parsed;
    }
    // A bare host without a scheme was treated as plain UDP.
    return { type: "udp", server: s, server_port: 53 };
}

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// Is this address already usable without a DNS lookup? A DNS server or an
// outbound addressed by a hostname needs one resolved *before* it can be
// dialled, which is a chicken-and-egg problem unless something points at a
// plain resolver - see needsBootstrapResolver.
export function isLiteralAddress(value) {
    if (typeof value !== "string" || value === "") return false;
    const host = value.replace(/^\[|\]$/g, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return host.split(".").every((part) => Number(part) <= 255);
    }
    // A colon can only mean IPv6 here: hostnames cannot contain one.
    return host.indexOf(":") >= 0;
}

// A DNS server whose own address is a hostname cannot be reached until that
// hostname resolves, and the resolver it would use is itself. Point it at the
// plain local resolver instead. Tower's generator does the same thing with a
// dedicated "bootstrap" server.
export function needsBootstrapResolver(server) {
    if (!isPlainObject(server)) return false;
    if (server.type === "local") return false;
    if (typeof server.server !== "string" || server.server === "") return false;
    if (server.domain_resolver !== undefined) return false;
    return !isLiteralAddress(server.server);
}

// Tag of the plain resolver used to bootstrap everything else, or null when
// the config has none (nothing to point at, so no domain_resolver is added).
//
// The client profile's bootstrap is a plain UDP server *tagged* "local" rather
// than a `type: "local"` system resolver, so match on either.
export function localDnsTag(dns) {
    if (!isPlainObject(dns) || !Array.isArray(dns.servers)) return null;
    const byType = dns.servers.find(
        (server) => isPlainObject(server) && server.type === "local" && server.tag,
    );
    if (byType) return byType.tag;
    const byTag = dns.servers.find(
        (server) => isPlainObject(server) && server.tag === "local",
    );
    return byTag ? byTag.tag : null;
}

// Build a DNS server entry from an `address` string (see parseDnsAddress) and
// attach a tag + optional detour. `override` (optional) merges extra fields,
// e.g. the TLS server_name a DoT server bound to a bare IP needs for cert
// verification.
function dnsServer(address, tag, detour, override) {
    const parsed = parseDnsAddress(address);
    const server = { type: parsed.type, tag };
    if (parsed.type !== "local") {
        server.server = parsed.server;
        server.server_port = parsed.server_port;
        if (parsed.path) server.path = parsed.path;
        server.detour = detour;
        if (isPlainObject(override)) Object.assign(server, override);
    }
    return server;
}

// Attach the bootstrap resolver to any DNS server addressed by a hostname, so
// a `--dns https://dns.google/dns-query` cannot turn into a resolution loop.
export function applyBootstrapResolver(servers, dns) {
    if (!Array.isArray(servers)) return servers;
    const bootstrap = localDnsTag(dns);
    if (!bootstrap) return servers;
    for (const server of servers) {
        if (needsBootstrapResolver(server)) server.domain_resolver = bootstrap;
    }
    return servers;
}

export function defaultLog(options) {
    return {
        level: (options && options.logLevel) || "info",
        timestamp: true,
    };
}

// The one inbound Tower emits: a TUN that takes over system traffic. The field
// overrides are for callers tuning the interface, not for picking a different
// shape - a loopback mixed inbound used to be reachable from here and is gone.
export function defaultInbounds(options) {
    options = options || {};
    const rawAddress =
        options.tunAddress || options.inet4_address || ["172.19.0.1/30"];
    const address = Array.isArray(rawAddress)
        ? rawAddress.slice()
        : [String(rawAddress)];
    return [
        {
            type: "tun",
            tag: options.tunTag || "tun-in",
            address,
            auto_route: options.autoRoute !== false,
            strict_route: options.strictRoute !== false,
            // Written out rather than left to sing-box's current default, so a
            // future core changing it cannot silently alter behaviour. Tower
            // pins the same value.
            stack: options.tunStack || "mixed",
        },
    ];
}

export function defaultDns(options) {
    options = options || {};
    const supplied = options.remoteDns;
    const remoteAddress =
        supplied != null && supplied !== ""
            ? isPlainObject(supplied)
                ? supplied
                : String(supplied).trim() || CLIENT_REMOTE_DNS
            : CLIENT_REMOTE_DNS;
    const remoteTag = "google";

    // A structured server object (user-supplied) passes through as-is, only
    // defaulting tag/detour. A string goes through parseDnsAddress + the
    // caller-supplied `override` (e.g. a TLS server_name for a bare-IP DoT).
    function remoteServer(detour, override) {
        if (isPlainObject(remoteAddress)) {
            const server = Object.assign({}, remoteAddress);
            server.tag = remoteTag;
            if (detour && server.detour === undefined) server.detour = detour;
            return server;
        }
        return dnsServer(String(remoteAddress), remoteTag, detour, override);
    }

    // The built-in remote is a DoT server addressed by bare IP; it needs an
    // explicit TLS server_name or sing-box cannot verify the certificate.
    const builtInOverride =
        String(remoteAddress) === CLIENT_REMOTE_DNS
            ? { tls: { enabled: true, server_name: "dns.google" } }
            : undefined;

    // Encrypted resolver reached through the proxy + a plain CN resolver for
    // domestic domains (mirrors the reference template).
    const servers = [
        remoteServer("proxy", builtInOverride),
        {
            type: "udp",
            tag: "local",
            server: options.localDns || CLIENT_LOCAL_DNS,
        },
    ];
    applyBootstrapResolver(servers, { servers });
    return {
        servers,
        rules: [
            { action: "route", server: "local", rule_set: "geosite-geolocation-cn" },
        ],
        final: "google",
        strategy: options.dnsStrategy || "ipv4_only",
        // Preserve DNS answer metadata so TUN connections addressed only by
        // IP can still match the domain rules that originally routed them.
        reverse_mapping: true,
    };
}

const CN_GEOSITE_URL =
    "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-cn.srs";
const CN_GEOIP_URL =
    "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs";

function cnRuleSet(tag, url) {
    return { type: "remote", tag, format: "binary", url, http_client: "default-client" };
}

export function defaultRoute(options) {
    options = options || {};
    const route = {
        auto_detect_interface: options.autoDetectInterface !== false,
        rules: [],
        final: options.final || "proxy",
    };

    // Sniff first, hijack DNS (DNS protocol or classic port-53 traffic,
    // matching Tower's route prelude), then route CN traffic direct. Non-final
    // actions run before destination rules so domain rules can match on the
    // sniffed host/SNI.
    route.rules = [
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
        { rule_set: "geosite-geolocation-cn", outbound: "direct" },
        { rule_set: "geoip-cn", outbound: "direct" },
    ];
    route.default_domain_resolver = {
        server: options.defaultDomainResolverServer || "local",
    };
    if (options.defaultHttpClient !== false) {
        route.default_http_client = "default-client";
        route.rule_set = [
            cnRuleSet("geosite-geolocation-cn", CN_GEOSITE_URL),
            cnRuleSet("geoip-cn", CN_GEOIP_URL),
        ];
    }
    return route;
}

// Remote rule-set downloads. sing-box 1.14 deprecated the implicit downloader
// and 1.16 removes it, so the client is declared explicitly. The field that
// carries weight is `domain_resolver`: the rule-set host must resolve *before*
// the detour is dialled, and the outbound being detoured through may have no
// working DNS during a cold start (Tower's generator makes the same point).
// No `engine` is written - "go" is already the default, so it would be a field
// that documents nothing.
//
// No `detour` either, and that one is load-bearing: the rule-set downloads go
// direct anyway, and naming the bare direct outbound explicitly is a config
// sing-box refuses to start on - "detour to an empty direct outbound makes no
// sense". Tower reaches the same place by only ever writing a detour when it
// has a proxy to route the download through.
export function defaultHttpClients(dns) {
    const client = { tag: "default-client" };
    const bootstrap = localDnsTag(dns || {});
    if (bootstrap) client.domain_resolver = bootstrap;
    return [client];
}

export function defaultExperimental(options) {
    options = options || {};
    const experimental = {
        cache_file: {
            enabled: true,
            store_dns: true,
            // This profile resolves real names rather than using fakeip, so a
            // persisted fakeip table would only hold mappings nothing reads.
            store_fakeip: options.storeFakeip === true,
        },
    };
    // The dashboard is only useful when something branches on clash_mode; a
    // profile with no proxy to switch to (the zero-node fallback) would be
    // offering a mode selector wired to nothing, so it opts out.
    if (options.clashApi !== false) {
        experimental.clash_api = { default_mode: RULE_MODE };
    }
    return experimental;
}

export default {
    defaultLog,
    defaultInbounds,
    defaultDns,
    defaultRoute,
    defaultHttpClients,
    defaultExperimental,
    parseDnsAddress,
    isLiteralAddress,
    needsBootstrapResolver,
    applyBootstrapResolver,
    localDnsTag,
    CLIENT_REMOTE_DNS,
    CLIENT_LOCAL_DNS,
};
