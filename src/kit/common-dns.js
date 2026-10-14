// Common Public DNS filtering and private DNS extraction utilities.
// Reference: AIsouler/MyClash (Script/mihomoScript.js)
//
// Extracts airport-specific private DNS servers and node-domain policies while filtering
// out common public DNS servers that airports generically inject into subscriptions.
// Also provides safe hosts-to-proxies rewriting and domain policy simplification.

export const COMMON_DNS_LIST = [
    // ==================== Domestic ====================
    // Ali AliDNS
    "223.5.5.5",
    "223.6.6.6",
    "2400:3200::1",
    "2400:3200:baba::1",
    "alidns",

    // Tencent DNSPod
    "119.29.29.29",
    "182.254.116.116",
    "1.12.12.12",
    "120.53.53.53",
    "2402:4e00::",
    "doh.pub",
    "dot.pub",
    "dns.pub",
    "dnspod",

    // 114DNS
    "114.114.114.114",
    "114.114.115.115",

    // Baidu BaiduDNS
    "180.76.76.76",
    "2400:da00::6666",
    "dns.baidu",

    // CNNIC SDNS
    "1.2.4.8",
    "210.2.4.8",
    "2001:dc7:1000::1",
    "cnnic",

    // 360 Safe DNS
    "101.226.4.6",
    "218.30.118.6",
    "123.125.81.6",
    "2400:8800:1::6",
    "2400:8800:2::6",
    "doh.360",
    "dot.360",

    // ByteDance Volcano Engine
    "180.184.1.1",
    "180.184.2.2",

    // ==================== International ====================
    // Cloudflare
    "1.1.1.1",
    "1.0.0.1",
    "1.1.1.2",
    "1.0.0.2",
    "1.1.1.3",
    "1.0.0.3",
    "2606:4700:4700::1111",
    "2606:4700:4700::1001",
    "2606:4700:4700::1112",
    "2606:4700:4700::1002",
    "2606:4700:4700::1113",
    "2606:4700:4700::1003",
    "dns.cloudflare",
    "cloudflare-dns",
    "one.one.one.one",

    // Google Public DNS
    "8.8.8.8",
    "8.8.4.4",
    "2001:4860:4860::8888",
    "2001:4860:4860::8844",
    "dns.google",

    // Quad9
    "9.9.9.9",
    "9.9.9.10",
    "9.9.9.11",
    "149.112.112.112",
    "149.112.112.10",
    "149.112.112.11",
    "2620:fe::fe",
    "2620:fe::9",
    "quad9",

    // Cisco OpenDNS
    "208.67.222.222",
    "208.67.220.220",
    "208.67.222.123",
    "208.67.220.123",
    "2620:119:35::35",
    "2620:119:53::53",
    "2620:119:35::123",
    "2620:119:53::123",
    "opendns",

    // AdGuard DNS
    "94.140.14.14",
    "94.140.15.15",
    "94.140.14.15",
    "94.140.15.16",
    "2a10:50c0::ad1:ff",
    "2a10:50c0::ad2:ff",
    "2a10:50c0::bad1:ff",
    "2a10:50c0::bad2:ff",
    "adguard",

    // Control D
    "76.76.2.0",
    "76.76.10.0",
    "76.76.19.19",
    "76.223.122.150",
    "2a0d:2a00:1::2",
    "2a0d:2a00:2::2",

    // CleanBrowsing
    "185.228.168.9",
    "185.228.169.9",
    "185.228.168.10",
    "185.228.169.11",
    "185.228.168.168",
    "185.228.169.168",

    // Yandex DNS
    "77.88.8.8",
    "77.88.8.1",
    "2a02:6b8::feed:0ff",
    "2a02:6b8:0:1::feed:0ff",

    // Neustar UltraDNS
    "156.154.70.1",
    "156.154.71.1",
    "156.154.70.2",
    "156.154.71.2",
    "2610:a1:1018::1",
    "2610:a1:1019::1",

    // Mullvad DNS
    "194.242.2.2",
    "2a07:e340::2",

    // Hurricane Electric
    "74.82.42.42",
    "2001:470:20::2",

    // NextDNS
    "nextdns",

    // Apple
    "dns.apple",
];

export const COMMON_DNS_REGEX = new RegExp(
    COMMON_DNS_LIST.map((dns) => dns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "i",
);

/**
 * Checks whether a DNS server address belongs to known public DNS or system DNS.
 */
export function isCommonDns(dns) {
    if (!dns) return true;
    const raw = String(dns).trim().toLowerCase();
    if (raw === "system" || raw === "system://" || raw === "dhcp" || raw === "") return true;

    let stripped = raw;
    const hashIdx = stripped.indexOf("#");
    if (hashIdx !== -1) stripped = stripped.slice(0, hashIdx).trim();

    return COMMON_DNS_REGEX.test(stripped);
}

/**
 * Strips '#' proxy group suffix from DNS address, converting '#direct' or '#直连' to '#DIRECT'.
 */
export function stripDnsSuffix(dns) {
    const str = String(dns || "").trim();
    const hashIndex = str.indexOf("#");
    if (hashIndex === -1) return str;

    const prefix = str.slice(0, hashIndex).trim();
    const suffix = str.slice(hashIndex + 1).toLowerCase().trim();

    if (suffix.includes("direct") || suffix.includes("直连")) {
        return prefix + "#DIRECT";
    }

    return prefix;
}

/**
 * Checks whether a server address is IPv4 or IPv6.
 */
export function isIpAddress(server) {
    if (typeof server !== "string") return false;
    const s = server.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
        return s.split(".").every((part) => {
            const n = Number(part);
            return n >= 0 && n <= 255;
        });
    }
    return s.includes(":") || s.startsWith("[");
}

/**
 * Hosts pattern specificity priority: exact (3) > +. (2) > . (1) > * (0).
 */
export function hostSpecificity(pattern) {
    if (typeof pattern !== "string") return 0;
    if (pattern.startsWith("+.")) return 2;
    if (pattern.startsWith(".")) return 1;
    if (pattern.includes("*")) return 0;
    return 3;
}

/**
 * Matches a domain against an exact or wildcard pattern (supports +., ., *).
 */
export function matchDomainPattern(pattern, domains) {
    if (!pattern || !domains) return false;
    const pat = String(pattern).toLowerCase();
    const domainList = typeof domains === "string"
        ? [domains.toLowerCase()]
        : [...domains].map((d) => String(d).toLowerCase());

    // Exact match
    if (!pat.includes("*") && !pat.startsWith("+.") && !pat.startsWith(".")) {
        return domainList.some((d) => d === pat);
    }

    // +.example.com -> matches example.com and *.example.com
    if (pat.startsWith("+.")) {
        const suffix = pat.slice(2);
        return domainList.some((d) => d === suffix || d.endsWith("." + suffix));
    }

    // .example.com -> matches only subdomains
    if (pat.startsWith(".")) {
        const suffix = pat.slice(1);
        return domainList.some((d) => d !== suffix && d.endsWith("." + suffix));
    }

    // *.example.com
    const patParts = pat.split(".");
    return domainList.some((d) => {
        const parts = d.split(".");
        return (
            patParts.length === parts.length &&
            patParts.every((part, i) => part === "*" || part === parts[i])
        );
    });
}

/**
 * Rewrites proxy.server to target IP if hosts mappings match the node server domain.
 * Automatically preserves the original domain in servername/sni to avoid TLS failures.
 */
export function applyHostsToProxies(proxies, hosts) {
    if (!Array.isArray(proxies) || proxies.length === 0) return proxies;
    if (!hosts || typeof hosts !== "object") return proxies;

    const hostEntries = Object.entries(hosts)
        .filter(
            ([, val]) =>
                (typeof val === "string" && val.length > 0) ||
                (Array.isArray(val) && val.length > 0),
        )
        .sort((a, b) => hostSpecificity(b[0]) - hostSpecificity(a[0]));

    if (hostEntries.length === 0) return proxies;

    const targetOf = (val) => {
        if (Array.isArray(val)) val = val.find((v) => typeof v === "string" && v.length > 0);
        return typeof val === "string" && val.length > 0 ? val : null;
    };

    const resolveCache = new Map();
    const resolve = (server) => {
        const cached = resolveCache.get(server);
        if (cached !== undefined) return cached;

        const seen = new Set();
        let current = server.toLowerCase();
        let result = server;
        while (!seen.has(current)) {
            seen.add(current);
            const entry = hostEntries.find(([pat]) => matchDomainPattern(pat, current));
            const target = entry && targetOf(entry[1]);
            if (!target) break;
            result = target;
            current = target.toLowerCase();
        }
        resolveCache.set(server, result);
        return result;
    };

    return proxies.map((proxy) => {
        if (!proxy || typeof proxy.server !== "string") return proxy;
        const originalServer = proxy.server;
        const resolvedServer = resolve(originalServer);
        if (resolvedServer === originalServer) return proxy;

        const updated = { ...proxy, server: resolvedServer };
        // If domain was rewritten to an IP, preserve original domain for SNI / Host
        if (isIpAddress(resolvedServer) && !isIpAddress(originalServer)) {
            if (!updated.servername && !updated.sni) {
                updated.servername = originalServer;
            }
            if (updated["ws-opts"] && updated["ws-opts"].headers && !updated["ws-opts"].headers.Host) {
                updated["ws-opts"] = {
                    ...updated["ws-opts"],
                    headers: {
                        ...updated["ws-opts"].headers,
                        Host: originalServer,
                    },
                };
            }
        }
        return updated;
    });
}

/**
 * Simplifies domain policy map by merging $\ge 3$ segment subdomains sharing the same DNS
 * into wildcard `+.suffix` rules.
 */
export function simplifyDomainPolicy(policy) {
    if (!policy || typeof policy !== "object") return {};
    const groups = new Map();

    for (const [domain, dns] of Object.entries(policy)) {
        const dnsKey = JSON.stringify(Array.isArray(dns) ? [...dns].sort() : dns);

        if (domain.startsWith("+.") || domain.startsWith(".") || domain.includes("*")) {
            groups.set(`keep:${domain}`, [{ domain, dns, dnsKey }]);
            continue;
        }

        const parts = domain.split(".");
        if (parts.length < 3) {
            groups.set(`keep:${domain}`, [{ domain, dns, dnsKey }]);
            continue;
        }

        const suffix = parts.slice(-2).join(".");
        if (!groups.has(suffix)) {
            groups.set(suffix, []);
        }
        groups.get(suffix).push({ domain, dns, dnsKey });
    }

    const result = {};
    for (const [suffix, domains] of groups) {
        const firstDnsKey = domains[0].dnsKey;
        const sameDns = domains.every(({ dnsKey }) => dnsKey === firstDnsKey);

        if (domains.length >= 2 && sameDns) {
            result[`+.${suffix}`] = domains[0].dns;
        } else {
            for (const { domain, dns } of domains) {
                result[domain] = dns;
            }
        }
    }
    return result;
}

/**
 * Extracts genuinely private DNS servers, policies, and fake-ip-filters for node domains,
 * filtering out generic public DNS.
 */
export function extractPrivateDns(originalDns, proxies, hosts) {
    if (!originalDns || typeof originalDns !== "object") {
        return {
            privateDNS: [],
            proxyServerPolicy: {},
            proxyFakeIpFilter: [],
            shouldRewriteByHosts: false,
        };
    }

    const proxyServerNameservers = Array.isArray(originalDns["proxy-server-nameserver"])
        ? originalDns["proxy-server-nameserver"]
        : [];
    const listenValue = typeof originalDns.listen === "string" ? originalDns.listen : "";

    // Hosts rewriting condition: single proxy-server-nameserver matching listen or 127.0.0.1
    const shouldRewriteByHosts =
        proxyServerNameservers.length === 1 &&
        listenValue.length > 0 &&
        (proxyServerNameservers.some((dns) =>
            String(dns).toLowerCase().includes(listenValue.toLowerCase()),
        ) ||
            (listenValue.includes("0.0.0.0") &&
                proxyServerNameservers.some((dns) =>
                    String(dns).toLowerCase().includes("127.0.0.1"),
                )));

    const effectiveProxies = shouldRewriteByHosts && hosts
        ? applyHostsToProxies(proxies, hosts)
        : proxies;

    const proxyDomains = new Set(
        (effectiveProxies || [])
            .filter((p) => p && typeof p.server === "string")
            .map((p) => p.server.toLowerCase())
            .filter((server) => !isIpAddress(server)),
    );

    const privateProxyServerNameservers = shouldRewriteByHosts ? [] : proxyServerNameservers;

    const nameservers = Array.isArray(originalDns.nameserver) ? originalDns.nameserver : [];
    const privateDNS = [
        ...new Set(
            [...nameservers, ...privateProxyServerNameservers]
                .map(stripDnsSuffix)
                .filter((dns) => dns.length > 0 && !isCommonDns(dns)),
        ),
    ];

    const matchedProxyPolicy = {};
    const policySources = {
        ...(originalDns["nameserver-policy"] || {}),
        ...(originalDns["proxy-server-nameserver-policy"] || {}),
    };

    for (const [domain, dns] of Object.entries(policySources)) {
        if (!matchDomainPattern(domain, proxyDomains)) continue;
        const stripedDns = Array.isArray(dns)
            ? dns.map(stripDnsSuffix).filter((d) => d.length > 0)
            : stripDnsSuffix(dns);
        if (Array.isArray(stripedDns) && stripedDns.length === 0) continue;
        matchedProxyPolicy[domain] = stripedDns;
    }

    if (privateDNS.length > 0 && Object.keys(matchedProxyPolicy).length === 0) {
        for (const domain of proxyDomains) {
            matchedProxyPolicy[domain] = privateDNS;
        }
    }

    const matchedPolicyDomains = Object.keys(matchedProxyPolicy);
    const proxyServerPolicy =
        proxyDomains.size > 0 &&
        proxyDomains.size === matchedPolicyDomains.length &&
        matchedPolicyDomains.every((domain) => proxyDomains.has(domain.toLowerCase()))
            ? simplifyDomainPolicy(matchedProxyPolicy)
            : matchedProxyPolicy;

    const originalFakeIpFilter = Array.isArray(originalDns["fake-ip-filter"])
        ? originalDns["fake-ip-filter"]
        : [];
    const proxyFakeIpFilter = originalFakeIpFilter.filter((pattern) => {
        const p = String(pattern);
        return matchDomainPattern(p, proxyDomains);
    });

    return {
        privateDNS,
        proxyServerPolicy,
        proxyFakeIpFilter,
        shouldRewriteByHosts,
    };
}

export default {
    COMMON_DNS_LIST,
    COMMON_DNS_REGEX,
    isCommonDns,
    stripDnsSuffix,
    isIpAddress,
    hostSpecificity,
    matchDomainPattern,
    applyHostsToProxies,
    simplifyDomainPolicy,
    extractPrivateDns,
};
