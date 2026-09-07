// Default building blocks for the generated sing-box config. Each can be
// replaced wholesale via assemble() options. Defaults assume sing-box 1.9+;
// validate against your target sing-box version before shipping.

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
        servers: [
            { tag: "remote", address: remoteAddress, detour: "proxy" },
            { tag: "local", address: "local", detour: "direct" },
        ],
        rules: [
            { outbound: "direct", server: "local" },
            { outbound: "block", server: "local" },
        ],
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
