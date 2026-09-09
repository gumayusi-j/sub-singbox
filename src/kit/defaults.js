// Default building blocks for the generated sing-box config. Each can be
// replaced wholesale via assemble() options. Defaults target sing-box 1.14+
// (fields removed in 1.14 - legacy DNS server `address`, `outbound` DNS-rule
// items - are avoided; validate against your target version before shipping).
//
// Two output profiles drive assemble():
//
//   mode: "client" (default) — a full client skeleton mirroring the common
//     reference config: a tun inbound, clash_api dashboard, split DNS
//     (google over the proxy + a local CN resolver), sniff + hijack-dns
//     route rules and remote geosite/geoip-CN rule-sets for China direct.
//
//   mode: "proxy"            — a minimal local mixed (socks/http) proxy on
//     127.0.0.1:<port> with plain private/direct routing.

const DNS_DEFAULT_PORTS = {
    udp: 53,
    tcp: 53,
    tls: 853,
    https: 443,
    quic: 443,
    h3: 443,
};

export const CLIENT_REMOTE_DNS = "tls://8.8.8.8";
export const PROXY_REMOTE_DNS = "https://dns.alidns.com/dns-query";
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

function isProxyMode(options) {
    return !!(options && options.mode === "proxy");
}

export function defaultLog(options) {
    const log = { level: (options && options.logLevel) || "info" };
    if (!isProxyMode(options)) log.timestamp = true;
    return log;
}

export function defaultInbounds(options) {
    options = options || {};
    const mode = isProxyMode(options);
    const port = options.inboundPort || options.inbound_port || 1080;
    const wantTun =
        mode === true ? options.tun === true : options.tun !== false;
    const inbounds = [];

    if (wantTun) {
        const rawAddress =
            options.tunAddress || options.inet4_address || ["172.19.0.1/30"];
        const address = Array.isArray(rawAddress)
            ? rawAddress.slice()
            : [String(rawAddress)];
        inbounds.push({
            type: "tun",
            tag: options.tunTag || "tun-in",
            address,
            auto_route: options.autoRoute !== false,
            strict_route: options.strictRoute !== false,
        });
    }

    // The proxy profile keeps a loopback mixed inbound; the client profile
    // only adds one on request (options.addMixed).
    if (mode === true || options.addMixed === true || wantTun === false) {
        inbounds.push({
            type: "mixed",
            tag: "mixed-in",
            listen: "127.0.0.1",
            listen_port: port,
        });
    }
    return inbounds;
}

export function defaultDns(options) {
    options = options || {};
    const mode = isProxyMode(options);
    const remoteDefault = mode ? PROXY_REMOTE_DNS : CLIENT_REMOTE_DNS;
    const supplied = options.remoteDns;
    const remoteAddress =
        supplied != null && supplied !== ""
            ? isPlainObject(supplied)
                ? supplied
                : String(supplied).trim() || remoteDefault
            : remoteDefault;
    const remoteTag = mode ? "remote" : "google";

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
        !mode && String(remoteAddress) === CLIENT_REMOTE_DNS
            ? { tls: { enabled: true, server_name: "dns.google" } }
            : undefined;

    if (mode) {
        // Minimal proxy profile: a DoH remote over the proxy plus a local
        // system resolver (backs route.default_domain_resolver).
        return {
            servers: [
                remoteServer("proxy", builtInOverride),
                { type: "local", tag: "local" },
            ],
            rules: [],
            final: "remote",
        };
    }

    // Client profile (mirrors the reference template): encrypted resolver
    // reached through the proxy + a plain CN resolver for domestic domains.
    return {
        servers: [
            remoteServer("proxy", builtInOverride),
            {
                type: "udp",
                tag: "local",
                server: options.localDns || CLIENT_LOCAL_DNS,
            },
        ],
        rules: [
            { action: "route", server: "local", rule_set: "geosite-geolocation-cn" },
        ],
        final: "google",
        strategy: "ipv4_only",
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

    if (isProxyMode(options)) {
        // Minimal profile: keep private/loopback traffic on direct.
        if (options.defaultDirectRules !== false) {
            route.rules.push({ ip_is_private: true, outbound: "direct" });
        }
        return route;
    }

    // Client profile: sniff first, hijack DNS (DNS protocol or classic
    // port-53 traffic, matching Tower's route prelude), then route CN
    // traffic direct. Non-final actions run before destination rules so
    // domain rules can match on the sniffed host/SNI.
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

export function defaultHttpClients() {
    return [{ tag: "default-client", detour: "direct" }];
}

export function defaultExperimental() {
    return {
        cache_file: { enabled: true, store_dns: true },
        clash_api: { default_mode: "Enhanced" },
    };
}

export default {
    defaultLog,
    defaultInbounds,
    defaultDns,
    defaultRoute,
    defaultHttpClients,
    defaultExperimental,
    parseDnsAddress,
    CLIENT_REMOTE_DNS,
    PROXY_REMOTE_DNS,
    CLIENT_LOCAL_DNS,
};
