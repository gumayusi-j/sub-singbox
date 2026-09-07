// Default building blocks for the generated sing-box config. Each can be
// replaced wholesale via assemble() options. Defaults target sing-box 1.14+
// (fields removed in 1.14 - legacy DNS server `address`, `outbound` DNS-rule
// items - are avoided); validate against your target version before shipping.

const DNS_DEFAULT_PORTS = {
    udp: 53,
    tcp: 53,
    tls: 853,
    https: 443,
    quic: 443,
    h3: 443,
};

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

function dnsServer(address, tag, detour) {
    const parsed = parseDnsAddress(address);
    const server = { type: parsed.type, tag };
    if (parsed.type !== "local") {
        server.server = parsed.server;
        server.server_port = parsed.server_port;
        if (parsed.path) server.path = parsed.path;
        server.detour = detour;
    }
    return server;
}

export function defaultInbounds(options) {
    options = options || {};
    const port = options.inboundPort || options.inbound_port || 1080;
    const inbounds = [
        {
            type: "mixed",
            tag: "mixed-in",
            listen: "127.0.0.1",
            listen_port: port,
        },
    ];
    if (options.tun) {
        inbounds.unshift({
            type: "tun",
            tag: "tun-in",
            inet4_address: options.inet4_address || "172.19.0.1/30",
            auto_route: options.auto_route !== false,
            strict_route: !!options.strict_route,
        });
    }
    return inbounds;
}

export function defaultDns(options) {
    options = options || {};
    const remoteAddress =
        options.remoteDns || "https://dns.alidns.com/dns-query";
    return {
        // Modern server objects (legacy `address` strings were removed in
        // sing-box 1.14). The "local" server backs route.default_domain_resolver.
        servers: [
            dnsServer(remoteAddress, "remote", "proxy"),
            { type: "local", tag: "local" },
        ],
        // Domain resolution for outbounds now lives on route.default_domain_resolver
        // (added in assemble); legacy `outbound` DNS-rule items are gone in 1.14.
        rules: [],
        final: "remote",
    };
}

export function defaultRoute(options) {
    options = options || {};
    const route = {
        auto_detect_interface: options.autoDetectInterface !== false,
        rules: [],
        final: options.final || "proxy",
    };
    if (options.defaultDirectRules !== false) {
        route.rules.push({ ip_is_private: true, outbound: "direct" });
    }
    return route;
}

export default { defaultInbounds, defaultDns, defaultRoute };
