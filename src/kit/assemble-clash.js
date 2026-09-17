// Assemble a complete clash (mihomo) config from a produced proxy YAML list.
//
// When an ACL4SSR preset is provided, its groups and rule lists are expanded
// into proper clash proxy-groups and rules — the same structure Tower exports.
// Without a preset, a minimal skeleton with direct/proxy catch-all is used.

import { safeLoad } from "@/utils/yaml";
import { LISTS } from "./acl4ssr/presets.generated";

// ── helpers ──────────────────────────────────────────────────────────

function extractNodeNames(proxyYaml) {
    try {
        const doc = safeLoad(proxyYaml);
        if (doc && Array.isArray(doc.proxies)) {
            return doc.proxies
                .map((p) => p && typeof p.name === "string" ? p.name : null)
                .filter(Boolean);
        }
    } catch (_e) { /* fall through */ }
    const names = [];
    const re = /(?:^|\n)\s*-\s*name\s*:\s*["']?([^"'\n]+?)["']?\s*(?:\n|$)/g;
    let m;
    while ((m = re.exec(proxyYaml))) {
        names.push(m[1].trim());
    }
    return names;
}

function matchTags(pattern, tags) {
    if (!pattern || pattern === ".*") return tags.slice();
    let re;
    try { re = new RegExp(pattern, "iu"); } catch (_e) { return []; }
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

function q(s) { return '"' + s + '"'; }

function selectGroup(name, members, opts) {
    const lines = [];
    lines.push("  - name: " + q(name));
    lines.push("    type: select");
    if (opts && opts.hidden) lines.push("    hidden: true");
    lines.push("    proxies:");
    if (members.length === 0) lines.push("      - DIRECT");
    for (const m of members) lines.push("      - " + q(m));
    return lines.join("\n");
}

function urlTestGroup(name, url, interval, tolerance, members, opts) {
    const lines = [];
    lines.push("  - name: " + q(name));
    lines.push("    type: url-test");
    lines.push("    url: " + q(url));
    lines.push("    interval: " + interval);
    lines.push("    tolerance: " + tolerance);
    if (opts && opts.hidden) lines.push("    hidden: true");
    lines.push("    proxies:");
    for (const m of members) lines.push("      - " + q(m));
    return lines.join("\n");
}

// Build clash proxy-groups from a preset's group definitions.
// Returns { groups: string[], groupSet: Set<string> }.
function buildClashGroups(preset, nodeNames) {
    const specs = preset.groups.filter((g) => !g.drop);
    const emitted = new Set();
    const groupLines = [];

    // Fixed-point: resolve reference members (like sing-box builder does).
    for (let pass = 0; pass <= specs.length; pass += 1) {
        let changed = false;
        groupLines.length = 0;
        const nextEmitted = new Set();

        for (const spec of specs) {
            const members = [];
            for (const token of spec.memberTokens || []) {
                if (!token) continue;
                if (token.startsWith("[]")) {
                    const ref = token.slice(2);
                    if (/^DIRECT$/i.test(ref)) members.push("DIRECT");
                    else if (/^REJECT$/i.test(ref)) members.push("REJECT");
                    else if (emitted.has(ref)) members.push(ref);
                    continue;
                }
                // Regex pattern → match against node names
                members.push(...matchTags(token, nodeNames));
            }
            const unique = dedupe(members);
            if (unique.length === 0) continue;

            if (spec.kind === "url-test") {
                const url = (spec.memberTokens || [])[1] || "http://www.gstatic.com/generate_204";
                const param = (spec.memberTokens || [])[2] || "";
                const nums = param.split(",");
                const interval = Number(nums[0]) || 300;
                const tolerance = Number(nums[2]) || 50;
                groupLines.push(urlTestGroup(spec.tag, url, interval, tolerance, unique));
            } else {
                groupLines.push(selectGroup(spec.tag, unique));
            }
            nextEmitted.add(spec.tag);
        }

        for (const tag of nextEmitted) {
            if (!emitted.has(tag)) changed = true;
        }
        emitted.clear();
        for (const tag of nextEmitted) emitted.add(tag);
        if (!changed) break;
    }

    return { groupLines, emitted };
}

// Convert an ACL4SSR .list file into clash rule lines.
// Returns an array of "  - TYPE,value,GROUP" strings.
// Skips lines that clash cannot express (PROCESS-NAME, URL-REGEX, etc.).
function listToClashRules(listName, groupName) {
    const text = LISTS[listName] || "";
    const rules = [];
    const SKIP = new Set(["PROCESS-NAME", "URL-REGEX", "USER-AGENT", "AND", "OR", "NOT"]);
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        // Format: TYPE,value[,no-resolve]
        const parts = line.split(",");
        const type = (parts[0] || "").toUpperCase().trim();
        if (SKIP.has(type)) continue;
        if (!type || !parts[1]) continue;
        // Reconstruct: TYPE,value,GROUP[,no-resolve]
        const value = parts[1].trim();
        const flags = parts.slice(2).map((s) => s.trim()).filter(Boolean);
        const ruleLine = [type, value, groupName, ...flags].join(",");
        rules.push("  - " + ruleLine);
    }
    return rules;
}

// ── main ─────────────────────────────────────────────────────────────

/**
 * assembleClash(proxyYaml, preset?)
 *
 * @param {string} proxyYaml  YAML text from ProxyUtils.produce (proxies section).
 * @param {object} [preset]   Optional ACL4SSR preset object with { groups, rules }.
 * @returns {string}          Complete clash YAML config.
 */
export default function assembleClash(proxyYaml, preset) {
    const nodeNames = extractNodeNames(proxyYaml);

    if (nodeNames.length === 0) {
        return header() + "proxies:\n  []\n";
    }

    let proxyGroups;
    let ruleLines;

    if (preset && Array.isArray(preset.groups) && Array.isArray(preset.rules)) {
        // ── ACL4SSR preset mode ───────────────────────────────────
        const { groupLines, emitted } = buildClashGroups(preset, nodeNames);
        proxyGroups = groupLines.join("\n\n");

        // Build rules from the preset's .list → group mappings.
        const rules = [];
        let finalGroup = null;

        for (const entry of preset.rules) {
            if (entry.final) {
                finalGroup = emitted.has(entry.group) ? entry.group : null;
                continue;
            }
            const groupName = entry.group;
            // Skip rules whose target group was not emitted (empty/failed).
            if (!emitted.has(groupName)) continue;

            if (entry.geoCn) {
                rules.push("  - GEOIP,CN," + groupName + ",no-resolve");
                continue;
            }
            if (entry.list) {
                rules.push(...listToClashRules(entry.list, groupName));
            }
        }

        // Reject foreign QUIC (UDP 443) before MATCH fallback to force TCP fallback
        rules.push("  - AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");

        // Final catch-all
        const finalName = finalGroup || "🚀 节点选择";
        rules.push("  - MATCH," + finalName);

        ruleLines = rules.join("\n");
    } else {
        // ── Minimal fallback (no preset) ──────────────────────────
        const SELECT = "🚀 节点选择";
        const AUTO   = "♻️ 自动选择";
        const MANUAL = "手动切换";
        const DIRECT = "🎯 直连";

        proxyGroups = [
            selectGroup(SELECT, [AUTO, DIRECT, MANUAL]),
            selectGroup(MANUAL, nodeNames),
            urlTestGroup(AUTO, "http://www.gstatic.com/generate_204", 300, 50, nodeNames),
            selectGroup(DIRECT, ["DIRECT"], { hidden: true }),
        ].join("\n\n");

        ruleLines = [
            "  - DOMAIN-SUFFIX,local," + DIRECT,
            "  - DOMAIN-SUFFIX,localhost," + DIRECT,
            "  - IP-CIDR,127.0.0.0/8," + DIRECT + ",no-resolve",
            "  - IP-CIDR,172.16.0.0/12," + DIRECT + ",no-resolve",
            "  - IP-CIDR,192.168.0.0/16," + DIRECT + ",no-resolve",
            "  - IP-CIDR,10.0.0.0/8," + DIRECT + ",no-resolve",
            "  - GEOIP,CN," + DIRECT + ",no-resolve",
            "  - AND,((NETWORK,UDP),(DST-PORT,443)),REJECT",
            "  - MATCH," + SELECT,
        ].join("\n");
    }

    return header() + "\n" + proxyYaml.trimEnd() + "\n\nproxy-groups:\n" + proxyGroups + "\n\nrules:\n" + ruleLines + "\n";
}

function header() {
    return [
        "# Generated by singbox-kit",
        "mixed-port: 7890",
        "allow-lan: false",
        "mode: rule",
        "log-level: warning",
        "ipv6: true",
        "",
        "hosts:",
        "  'services.googleapis.cn': 'services.googleapis.com'",
        "  '+.mcdn.bilivideo.com': '0.0.0.0'",
        "  '+.mcdn.bilivideo.cn': '0.0.0.0'",
        "  '+.edge.mountaintoys.cn': '0.0.0.0'",
        "  '+.h2.smtcdns.net': '0.0.0.0'",
        "",
        "dns:",
        "  enable: true",
        "  enhanced-mode: fake-ip",
        "  fake-ip-range: 198.18.0.1/16",
        "  fake-ip-filter:",
        '    - "*.lan"',
        '    - "+.local"',
        '    - "+.msftconnecttest.com"',
        '    - "+.msftncsi.com"',
        "  default-nameserver:",
        "    - 223.5.5.5",
        "    - 119.29.29.29",
        "  proxy-server-nameserver:",
        "    - https://223.5.5.5/dns-query",
        "  nameserver:",
        "    - https://223.5.5.5/dns-query",
        "    - https://doh.pub/dns-query",
        "  fallback:",
        "    - https://1.1.1.1/dns-query",
        "    - https://dns.google/dns-query",
        "  fallback-filter:",
        "    geoip: true",
        "    geoip-code: CN",
        "",
    ].join("\n") + "\n";
}
