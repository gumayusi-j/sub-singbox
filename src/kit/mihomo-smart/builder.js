// Mihomo Smart Preset Builder
// Produces complete Clash/Mihomo and sing-box configurations with modern SVG icons,
// single-layer flat region groups, load balancing, and concise core service routing.

import { safeLoad, safeDump } from "@/utils/yaml";
import { applyHostsToProxies, extractPrivateDns } from "../common-dns";
import {
    ICON_BASE_URL,
    REGION_DEFINITIONS,
    RATE_REGION_DEFINITIONS,
    ALL_REGION_DEFINITIONS,
    EXCLUDE_FILTER,
    BASE_RULE_PROVIDERS,
    SERVICE_CONFIGS,
    PREFIX_RULES,
    BLOCK_FOREIGN_QUIC,
    FALLBACK_RULES,
    GROUP_BASE_OPTION,
    LOW_RATE_REGION_NAME,
    HIGH_RATE_REGION_NAME,
    toMatchableName,
} from "./constants";

function q(s) {
    return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const item of arr || []) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

export function filterNodeNames(nodeNames) {
    return (nodeNames || []).filter((name) => {
        if (!name || typeof name !== "string") return false;
        const matchableName = toMatchableName(name);
        return !EXCLUDE_FILTER.test(matchableName);
    });
}

export function extractNodeNames(proxyYaml) {
    try {
        const doc = safeLoad(proxyYaml);
        if (doc && Array.isArray(doc.proxies)) {
            return doc.proxies
                .map((p) => (p && typeof p.name === "string" ? p.name : null))
                .filter(Boolean);
        }
    } catch (_e) {
        /* fallback to regex */
    }
    const names = [];
    const re = /(?:^|\n)\s*-\s*name\s*:\s*["']?([^"'\n]+?)["']?\s*(?:\n|$)/g;
    let m;
    while ((m = re.exec(proxyYaml))) {
        names.push(m[1].trim());
    }
    return names;
}

function classifyNodes(nodeNames) {
    const regionMap = {};
    for (const r of REGION_DEFINITIONS) {
        regionMap[r.name] = [];
    }
    let lowRateNodes = [];
    let highRateNodes = [];
    const otherNodes = [];

    const lowRateDef = RATE_REGION_DEFINITIONS.find((r) => r.name === LOW_RATE_REGION_NAME);
    const highRateDef = RATE_REGION_DEFINITIONS.find((r) => r.name === HIGH_RATE_REGION_NAME);

    for (const name of nodeNames) {
        const matchableName = toMatchableName(name);
        let matchedRegion = false;
        for (const r of REGION_DEFINITIONS) {
            if (r.regex.test(matchableName)) {
                regionMap[r.name].push(name);
                matchedRegion = true;
            }
        }

        if (lowRateDef && lowRateDef.regex.test(matchableName)) {
            lowRateNodes.push(name);
        }
        if (highRateDef && highRateDef.regex.test(matchableName)) {
            highRateNodes.push(name);
        }

        if (!matchedRegion) {
            otherNodes.push(name);
        }
    }

    return {
        regionMap,
        lowRateNodes: dedupe(lowRateNodes),
        highRateNodes: dedupe(highRateNodes),
        otherNodes: dedupe(otherNodes),
    };
}

function formatClashProxyGroup(g) {
    const lines = [];
    lines.push("  - name: " + q(g.name));
    lines.push("    type: " + g.type);
    if (g.icon) lines.push("    icon: " + q(g.icon));
    if (g.url) lines.push("    url: " + q(g.url));
    if (g.interval !== undefined) lines.push("    interval: " + g.interval);
    if (g.timeout !== undefined) lines.push("    timeout: " + g.timeout);
    if (g.tolerance !== undefined) lines.push("    tolerance: " + g.tolerance);
    if (g.strategy) lines.push("    strategy: " + g.strategy);
    if (g.lazy !== undefined) lines.push("    lazy: " + (g.lazy ? "true" : "false"));
    if (g["max-failed-times"] !== undefined) {
        lines.push("    max-failed-times: " + g["max-failed-times"]);
    }
    if (g["empty-fallback"]) {
        lines.push("    empty-fallback: " + q(g["empty-fallback"]));
    }
    if (g.hidden) lines.push("    hidden: true");

    lines.push("    proxies:");
    const proxies = Array.isArray(g.proxies) && g.proxies.length > 0 ? g.proxies : ["DIRECT"];
    for (const p of dedupe(proxies)) {
        lines.push("      - " + q(p));
    }
    return lines.join("\n");
}

function formatRuleProviders(providers) {
    const lines = ["rule-providers:"];
    for (const [key, p] of Object.entries(providers)) {
        lines.push("  " + key + ":");
        lines.push("    type: " + p.type);
        lines.push("    format: " + p.format);
        lines.push("    behavior: " + p.behavior);
        lines.push("    interval: " + p.interval);
        lines.push("    url: " + q(p.url));
        lines.push("    path: " + q(p.path));
    }
    return lines.join("\n");
}

/**
 * Build a complete modern Clash/Mihomo configuration with SVG icons,
 * load balancing, flat single-layer region groups, rate groups, and concise service routing.
 */
export function buildMihomoSmartClash(proxyYaml, options) {
    const opts = options || {};

    let originalDoc = null;
    try {
        originalDoc = safeLoad(proxyYaml);
    } catch (_e) {}

    const originalDns = opts.originalDns || (originalDoc && originalDoc.dns);
    const originalHosts = opts.originalHosts || (originalDoc && originalDoc.hosts);
    const rawProxies = (originalDoc && Array.isArray(originalDoc.proxies)) ? originalDoc.proxies : [];

    let extractedDns = opts.extractedDns;
    if (!extractedDns && originalDns) {
        extractedDns = extractPrivateDns(originalDns, rawProxies, originalHosts);
    }

    let processedYaml = proxyYaml;
    if (originalHosts && rawProxies.length > 0) {
        const mapped = applyHostsToProxies(rawProxies, originalHosts);
        processedYaml = safeDump({ proxies: mapped });
    }

    const rawNames = extractNodeNames(processedYaml);

    if (rawNames.length === 0) {
        return (
            header(opts, extractedDns) +
            "\nproxies:\n  []\n\nproxy-groups:\n  - name: " +
            q("🚀 节点选择") +
            "\n    type: select\n    proxies:\n      - DIRECT\n\nrules:\n  - MATCH,DIRECT\n"
        );
    }

    const filteredNames = filterNodeNames(rawNames);
    const validNames = filteredNames.length > 0 ? filteredNames : rawNames;

    const { regionMap, lowRateNodes, highRateNodes, otherNodes } = classifyNodes(validNames);

    // 1. Build Flat Region Groups (Single-layer url-test auto-select groups)
    const generatedRegionGroups = [];
    const availableRegionNames = [];

    for (const r of REGION_DEFINITIONS) {
        const nodes = regionMap[r.name];
        if (!nodes || nodes.length === 0) continue;

        generatedRegionGroups.push({
            ...GROUP_BASE_OPTION,
            name: r.name,
            type: "url-test",
            tolerance: 50,
            icon: r.icon,
            proxies: nodes,
        });

        availableRegionNames.push(r.name);
    }

    // Other nodes group if present
    if (otherNodes.length > 0) {
        generatedRegionGroups.push({
            ...GROUP_BASE_OPTION,
            name: "🌍 其他节点",
            type: "url-test",
            tolerance: 50,
            icon: `${ICON_BASE_URL}WorldMap.svg`,
            proxies: otherNodes,
        });
        availableRegionNames.push("🌍 其他节点");
    }

    // Rate groups if present
    if (lowRateNodes.length > 0) {
        generatedRegionGroups.push({
            ...GROUP_BASE_OPTION,
            name: LOW_RATE_REGION_NAME,
            type: "url-test",
            tolerance: 50,
            icon: `${ICON_BASE_URL}Available.svg`,
            proxies: lowRateNodes,
        });
        availableRegionNames.push(LOW_RATE_REGION_NAME);
    }

    if (highRateNodes.length > 0) {
        generatedRegionGroups.push({
            ...GROUP_BASE_OPTION,
            name: HIGH_RATE_REGION_NAME,
            type: "select",
            icon: `${ICON_BASE_URL}Airport.svg`,
            proxies: highRateNodes,
        });
        availableRegionNames.push(HIGH_RATE_REGION_NAME);
    }

    // 2. Base Groups (🚀 节点选择, ♻️ 自动选择, ⚖️ 负载均衡)
    const baseGroupObjects = [
        {
            ...GROUP_BASE_OPTION,
            name: "🚀 节点选择",
            type: "select",
            icon: `${ICON_BASE_URL}Static.svg`,
            proxies: dedupe([
                "♻️ 自动选择",
                "⚖️ 负载均衡",
                ...availableRegionNames,
                ...validNames,
            ]),
        },
        {
            ...GROUP_BASE_OPTION,
            name: "♻️ 自动选择",
            type: "url-test",
            tolerance: 50,
            icon: `${ICON_BASE_URL}Auto.svg`,
            proxies: validNames,
        },
        {
            ...GROUP_BASE_OPTION,
            name: "⚖️ 负载均衡",
            type: "load-balance",
            strategy: "sticky-sessions",
            icon: `${ICON_BASE_URL}RoundRobin.svg`,
            proxies: validNames,
        },
    ];

    // 3. Functional Core Service Groups (AI, YouTube, Netflix, Telegram, AdBlock)
    const functionalGroups = [];
    const functionalRules = [];
    const activeRuleProviders = { ...BASE_RULE_PROVIDERS };

    for (const svc of SERVICE_CONFIGS) {
        if (svc.providers) {
            Object.assign(activeRuleProviders, svc.providers);
        }
        if (svc.rules) {
            functionalRules.push(...svc.rules);
        }

        let groupProxies = [];
        if (svc.reject) {
            groupProxies = ["REJECT", "DIRECT"];
        } else {
            const candidates = [];
            if (svc.defaultSelected && availableRegionNames.includes(svc.defaultSelected)) {
                candidates.push(svc.defaultSelected);
            }
            candidates.push("🚀 节点选择");
            candidates.push("♻️ 自动选择");
            candidates.push(...availableRegionNames);
            groupProxies = dedupe(candidates);
        }

        functionalGroups.push({
            ...GROUP_BASE_OPTION,
            name: svc.name,
            type: svc.type || "select",
            icon: svc.icon,
            proxies: groupProxies,
        });
    }

    // 4. Fallback Group (🐟 漏网之鱼)
    const finalFallbackGroup = {
        ...GROUP_BASE_OPTION,
        name: "🐟 漏网之鱼",
        type: "select",
        icon: `${ICON_BASE_URL}Stack.svg`,
        proxies: dedupe(["🚀 节点选择", "DIRECT", ...availableRegionNames]),
    };

    // Aggregate all groups in structured, logical order
    const allGroups = [
        ...baseGroupObjects,
        ...functionalGroups,
        finalFallbackGroup,
        ...generatedRegionGroups,
    ];

    const proxyGroupsYaml = allGroups.map(formatClashProxyGroup).join("\n\n");

    // Aggregate rules
    const allRules = [
        ...PREFIX_RULES,
        ...(opts.blockForeignQuic !== false ? BLOCK_FOREIGN_QUIC : []),
        ...functionalRules,
        ...FALLBACK_RULES,
    ].map((r) => "  - " + r);

    const rulesYaml = "rules:\n" + allRules.join("\n");
    const ruleProvidersYaml = formatRuleProviders(activeRuleProviders);

    // Merge proxies: subscription proxies (filtered)
    let cleanedProxiesSection = "";
    try {
        const doc = safeLoad(processedYaml);
        if (doc && Array.isArray(doc.proxies)) {
            const filtered = doc.proxies.filter(
                (p) => p && typeof p.name === "string" && !EXCLUDE_FILTER.test(p.name)
            );
            cleanedProxiesSection = safeDump({ proxies: filtered });
        }
    } catch (_e) {}

    if (!cleanedProxiesSection) {
        cleanedProxiesSection = processedYaml.trimEnd() + "\n";
    }

    return (
        header(opts, extractedDns) +
        "\n" +
        cleanedProxiesSection.trimEnd() +
        "\n\nproxy-groups:\n" +
        proxyGroupsYaml +
        "\n\n" +
        ruleProvidersYaml +
        "\n\n" +
        rulesYaml +
        "\n"
    );
}

export function header(options, dnsContext) {
    const opts = options || {};
    const tunEnabled = opts.tun === true;
    const ctx = dnsContext || opts.extractedDns || {};

    const localDnsList = (function () {
        const raw = typeof opts.localDns === "string" && opts.localDns.trim()
            ? opts.localDns.trim()
            : null;
        if (!raw) return ["223.5.5.5#DIRECT", "119.29.29.29#DIRECT"];
        return raw.split(",").map((s) => s.trim() + (s.includes("#") ? "" : "#DIRECT")).filter(Boolean);
    })();

    const proxyFakeIpFilter = Array.isArray(ctx.proxyFakeIpFilter) ? ctx.proxyFakeIpFilter : [];
    const proxyServerPolicy = ctx.proxyServerPolicy && typeof ctx.proxyServerPolicy === "object"
        ? ctx.proxyServerPolicy
        : {};

    const lines = [
        "# Generated by sub-singbox (Mihomo Smart Preset)",
        "mixed-port: 7890",
        "allow-lan: " + (opts.allowLan === true ? "true" : "false"),
        "bind-address: '*'",
        "mode: rule",
        "log-level: " + (opts.logLevel || "info"),
        "ipv6: " + (opts.ipv6 !== false ? "true" : "false"),
        "tcp-concurrent: true",
        "unified-delay: true",
        "find-process-mode: strict",
        "global-client-fingerprint: chrome",
        "external-controller: 127.0.0.1:9090",
        "external-ui: ui",
        "external-ui-url: " +
            q("https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip"),
        "",
        "profile:",
        "  store-selected: true",
        "  store-fake-ip: true",
        "",
        "tun:",
        "  enable: " + (tunEnabled ? "true" : "false"),
        "  stack: system",
        "  auto-route: true",
        "  strict-route: true",
        "  auto-redirect: true",
        "  auto-detect-interface: true",
        "  dns-hijack:",
        "    - any:53",
        "    - tcp://any:53",
        "",
        "hosts:",
        "  'doh.pub': ['1.12.12.12', '120.53.53.53']",
        "  'cloudflare-dns.com': ['1.1.1.1', '1.0.0.1']",
        "  'dns.google': ['8.8.8.8', '8.8.4.4']",
        "  'services.googleapis.cn': 'services.googleapis.com'",
        "  '+.mcdn.bilivideo.com': '0.0.0.0'",
        "  '+.mcdn.bilivideo.cn': '0.0.0.0'",
        "  '+.edge.mountaintoys.cn': '0.0.0.0'",
        "  '+.h2.smtcdns.net': '0.0.0.0'",
        "",
        "dns:",
        "  enable: true",
        "  ipv6: " + (opts.ipv6 !== false ? "true" : "false"),
        "  use-hosts: true",
        "  use-system-hosts: true",
        "  cache-algorithm: arc",
        "  enhanced-mode: fake-ip",
        "  fake-ip-range: 198.18.0.1/15",
        "  fake-ip-range6: 2001:2::1/48",
        "  fake-ip-filter:",
        '    - "rule-set:private"',
        '    - "rule-set:fakeip_filter"',
        '    - "rule-set:geolocation-cn"',
    ];

    for (const f of proxyFakeIpFilter) {
        lines.push("    - " + q(f));
    }

    lines.push(
        "  default-nameserver:",
        "    - 114.114.114.114#DIRECT",
        "    - tls://223.5.5.5#DIRECT",
        "    - https://1.12.12.12/dns-query#DIRECT",
        "  proxy-server-nameserver:",
        "    - 114.114.114.114#DIRECT",
        "    - tls://223.5.5.5#DIRECT",
        "    - https://doh.pub/dns-query#DIRECT",
    );

    const policyKeys = Object.keys(proxyServerPolicy);
    if (policyKeys.length > 0) {
        lines.push("  proxy-server-nameserver-policy:");
        for (const dom of policyKeys) {
            const target = proxyServerPolicy[dom];
            if (Array.isArray(target)) {
                lines.push("    " + q(dom) + ":");
                for (const t of target) {
                    lines.push("      - " + q(t));
                }
            } else {
                lines.push("    " + q(dom) + ": " + q(target));
            }
        }
    }

    lines.push(
        "  nameserver:",
        "    - https://cloudflare-dns.com/dns-query",
        "    - https://dns.google/dns-query",
        "  direct-nameserver:",
        ...localDnsList.map((d) => "    - " + d),
        "  direct-nameserver-follow-policy: true",
        "  nameserver-policy:",
        "    'rule-set:private': system",
        "    'rule-set:douyin':",
        "      - system",
        "      - 180.184.1.1",
        "      - 180.184.2.2",
        "    'rule-set:geolocation-cn':",
        ...localDnsList.map((d) => "      - " + d),
    );

    return lines.join("\n");
}

/**
 * Sing-box preset adapter definition so that `assembleAcl` also recognizes
 * `mihomo-smart` with clean, concise groups and rules.
 */
export const MIHOMO_SMART_PRESET = {
    id: "mihomo-smart",
    name: "Mihomo 现代智能分组",
    summary:
        "现代智能精炼分组：精美 SVG 图标、负载均衡、单层地区优选、高低倍率与核心服务（AI/流媒体/电报/广告拦截）成熟分流。",
    groups: [
        {
            tag: "🚀 节点选择",
            kind: "select",
            memberTokens: [
                "[]♻️ 自动选择",
                "[]🇭🇰 香港",
                "[]🇯🇵 日本",
                "[]🇺🇸 美国",
                "[]🇸🇬 新加坡",
                "[]🇹🇼 台湾",
                ".*",
            ],
        },
        {
            tag: "♻️ 自动选择",
            kind: "url-test",
            memberTokens: [".*", "http://www.gstatic.com/generate_204", "300,,50"],
        },
        {
            tag: "🇭🇰 香港",
            kind: "url-test",
            memberTokens: [
                "🇭🇰|香港|(?<![A-Za-z])HKG?(?![A-Za-z])|hong\\s*kong",
                "http://www.gstatic.com/generate_204",
                "300,,50",
            ],
        },
        {
            tag: "🇯🇵 日本",
            kind: "url-test",
            memberTokens: [
                "🇯🇵|日本|东京|大阪|京都|(?<![A-Za-z])JPN?(?![A-Za-z])|japan",
                "http://www.gstatic.com/generate_204",
                "300,,50",
            ],
        },
        {
            tag: "🇺🇸 美国",
            kind: "url-test",
            memberTokens: [
                "🇺🇸|美国|纽约|洛杉矶|旧金山|芝加哥|休斯顿|迈阿密|西雅图|波士顿|华盛顿|(?<![A-Za-z])USA?(?![A-Za-z])|america",
                "http://www.gstatic.com/generate_204",
                "300,,50",
            ],
        },
        {
            tag: "🇸🇬 新加坡",
            kind: "url-test",
            memberTokens: [
                "🇸🇬|新加坡|狮城|(?<![A-Za-z])SGP?(?![A-Za-z])|singapore",
                "http://www.gstatic.com/generate_204",
                "300,,50",
            ],
        },
        {
            tag: "🇹🇼 台湾",
            kind: "url-test",
            memberTokens: [
                "🇹🇼|台湾|台北|高雄|(?<![A-Za-z])TWN?(?![A-Za-z])|taiwan",
                "http://www.gstatic.com/generate_204",
                "300,,50",
            ],
        },
        {
            tag: "💬 AI",
            kind: "select",
            memberTokens: ["[]🇺🇸 美国", "[]🇯🇵 日本", "[]🇸🇬 新加坡", "[]🚀 节点选择", "[]♻️ 自动选择"],
        },
        {
            tag: "📹 YouTube",
            kind: "select",
            memberTokens: ["[]🚀 节点选择", "[]♻️ 自动选择", "[]🇭🇰 香港", "[]🇺🇸 美国", "[]🇸🇬 新加坡"],
        },
        {
            tag: "🎥 Netflix",
            kind: "select",
            memberTokens: ["[]🚀 节点选择", "[]🇸🇬 新加坡", "[]🇭🇰 香港", "[]🇯🇵 日本", "[]🇺🇸 美国"],
        },
        {
            tag: "📲 Telegram",
            kind: "select",
            memberTokens: ["[]🚀 节点选择", "[]🇸🇬 新加坡", "[]🇭🇰 香港", "[]🇯🇵 日本"],
        },
        {
            tag: "🛑 广告拦截",
            kind: "select",
            drop: true,
            memberTokens: ["[]REJECT"],
        },
        {
            tag: "🐟 漏网之鱼",
            kind: "select",
            memberTokens: ["[]🚀 节点选择", "[]DIRECT"],
        },
    ],
    rules: [
        { list: "ACL4SSR_LocalAreaNetwork.list", group: "direct" },
        { list: "ACL4SSR_UnBan.list", group: "direct" },
        { list: "ACL4SSR_BanAD.list", group: "🛑 广告拦截" },
        { list: "ACL4SSR_BanProgramAD.list", group: "🛑 广告拦截" },
        { list: "ACL4SSR_Ruleset_GoogleFCM.list", group: "direct" },
        { list: "ACL4SSR_GoogleCN.list", group: "direct" },
        { list: "ACL4SSR_Ruleset_SteamCN.list", group: "direct" },
        { list: "ACL4SSR_Ruleset_OpenAi.list", group: "💬 AI" },
        { list: "ACL4SSR_Ruleset_AI.list", group: "💬 AI" },
        { list: "ACL4SSR_Ruleset_YouTube.list", group: "📹 YouTube" },
        { list: "ACL4SSR_Ruleset_Telegram.list", group: "📲 Telegram" },
        { list: "ACL4SSR_Ruleset_Netflix.list", group: "🎥 Netflix" },
        { geoCn: true, group: "direct" },
        { final: true, group: "🐟 漏网之鱼" },
    ],
};
