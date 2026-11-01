// Assemble a complete Surge / Surfboard .conf profile from produced proxy lines.
//
// When an ACL4SSR preset is provided, its groups and rule lists are expanded
// into proper [Proxy Group] and [Rule] sections — the same structure Tower exports.
// Without a preset, a minimal skeleton with direct/proxy catch-all is used.

import { LISTS } from "./acl4ssr/presets.generated";
import {
    NOTICE_NODE_REGEX,
    isLowRateGroup,
    isNormalRateGroup,
    resolveMultiplierGroupNodes,
} from "./acl4ssr/multiplier";

function filterNoticeNodeNames(names) {
    const re = new RegExp(NOTICE_NODE_REGEX, "iu");
    return names.filter((n) => !re.test(n));
}

export function extractSurgeNodeNames(raw) {
    const names = [];
    for (const line of (raw || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("[")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
            const name = trimmed.slice(0, eqIdx).trim();
            if (name) names.push(name);
        }
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

function localDnsString(opts) {
    const raw = opts && typeof opts.localDns === "string" && opts.localDns.trim()
        ? opts.localDns.trim()
        : null;
    return raw || "223.5.5.5, 119.29.29.29";
}

function buildSurgeGroups(preset, nodeNames) {
    const specs = preset.groups.filter((g) => !g.drop);
    const emitted = new Set();
    const groupLines = [];

    // Fixed-point: resolve reference members (like sing-box and clash builders do).
    for (let pass = 0; pass <= specs.length; pass += 1) {
        let changed = false;
        groupLines.length = 0;
        const nextEmitted = new Set();

        for (const spec of specs) {
            let unique;
            const rateMatched = resolveMultiplierGroupNodes(spec.tag, nodeNames);
            if (rateMatched !== undefined) {
                if (!rateMatched || rateMatched.length === 0) continue;
                unique = dedupe(rateMatched);
            } else {
                const members = [];
                for (const token of spec.memberTokens || []) {
                    if (!token) continue;
                    if (token.startsWith("[]")) {
                        const ref = token.slice(2);
                        if (/^DIRECT$/i.test(ref)) members.push("DIRECT");
                        else if (/^REJECT$/i.test(ref)) members.push("REJECT");
                        else if (emitted.has(ref)) members.push(ref);
                        else if (isLowRateGroup(ref)) {
                            const emittedNormal = Array.from(emitted).find(isNormalRateGroup);
                            if (emittedNormal && !members.includes(emittedNormal)) {
                                members.push(emittedNormal);
                            }
                        }
                        continue;
                    }
                    // Regex pattern → match against node names
                    members.push(...matchTags(token, nodeNames));
                }
                unique = dedupe(members);
                if (unique.length === 0) continue;
            }

            if (spec.kind === "url-test") {
                const url = (spec.memberTokens || [])[1] || "http://www.gstatic.com/generate_204";
                const param = (spec.memberTokens || [])[2] || "";
                const nums = param.split(",");
                const interval = Number(nums[0]) || 300;
                const tolerance = Number(nums[2]) || 50;
                groupLines.push(spec.tag + " = url-test, " + unique.join(", ") + ", url=" + url + ", interval=" + interval + ", tolerance=" + tolerance);
            } else {
                groupLines.push(spec.tag + " = select, " + unique.join(", "));
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

function listToSurgeRules(listName, groupName) {
    const text = LISTS[listName] || "";
    const rules = [];
    const SKIP = new Set(["PROCESS-NAME", "URL-REGEX", "USER-AGENT", "AND", "OR", "NOT"]);
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(",");
        const type = (parts[0] || "").toUpperCase().trim();
        if (SKIP.has(type)) continue;
        if (!type || !parts[1]) continue;
        const value = parts[1].trim();
        const flags = parts.slice(2).map((s) => s.trim()).filter(Boolean);
        const ruleLine = [type, value, groupName, ...flags].join(",");
        rules.push(ruleLine);
    }
    return rules;
}

export function surgeGeneralHeader(options) {
    const opts = options || {};
    const localDns = localDnsString(opts);
    return [
        "# Generated by sub-singbox (Surfboard / Surge edition)",
        "[General]",
        "loglevel = notify",
        "ipv6 = " + (opts.ipv6 !== false ? "true" : "false"),
        "dns-server = " + localDns,
        "encrypted-dns-server = https://223.5.5.5/dns-query, https://doh.pub/dns-query",
        "skip-proxy = 127.0.0.1, localhost, *.local",
        "test-timeout = 5",
        "",
    ].join("\n");
}

export default function assembleSurge(proxyLines, preset, options) {
    const opts = options || {};
    const nodeNames = extractSurgeNodeNames(proxyLines);

    if (nodeNames.length === 0) {
        return (
            surgeGeneralHeader(opts) +
            "[Proxy]\n\n" +
            "[Proxy Group]\n" +
            "🚀 节点选择 = select, DIRECT\n\n" +
            "[Rule]\n" +
            "FINAL,🚀 节点选择\n"
        );
    }

    const filteredNames = filterNoticeNodeNames(nodeNames);
    const effectiveNodeNames = filteredNames.length > 0 ? filteredNames : nodeNames;

    let proxyGroups;
    let ruleLines;

    if (preset && Array.isArray(preset.groups) && Array.isArray(preset.rules)) {
        // ACL4SSR preset mode
        const { groupLines, emitted } = buildSurgeGroups(preset, effectiveNodeNames);
        proxyGroups = groupLines.join("\n");

        const rules = [];
        let finalGroup = null;

        for (const entry of preset.rules) {
            if (entry.final) {
                finalGroup = emitted.has(entry.group) ? entry.group : null;
                continue;
            }
            const groupName = entry.group;
            if (!emitted.has(groupName)) continue;

            if (entry.geoCn) {
                rules.push("GEOIP,CN," + groupName + ",no-resolve");
                continue;
            }
            if (entry.list) {
                rules.push(...listToSurgeRules(entry.list, groupName));
            }
        }

        const finalName = finalGroup || (emitted.has("🚀 节点选择") ? "🚀 节点选择" : "DIRECT");
        rules.push("FINAL," + finalName);
        ruleLines = rules.join("\n");
    } else {
        // Minimal fallback
        const SELECT = "🚀 节点选择";
        const AUTO   = "♻️ 自动选择";
        const MANUAL = "手动切换";
        const DIRECT = "🎯 直连";

        proxyGroups = [
            SELECT + " = select, " + AUTO + ", " + DIRECT + ", " + MANUAL,
            MANUAL + " = select, " + effectiveNodeNames.join(", "),
            AUTO + " = url-test, " + effectiveNodeNames.join(", ") + ", url=http://www.gstatic.com/generate_204, interval=300, tolerance=50",
            DIRECT + " = select, DIRECT",
        ].join("\n");

        ruleLines = [
            "DOMAIN-SUFFIX,local," + DIRECT,
            "DOMAIN-SUFFIX,localhost," + DIRECT,
            "IP-CIDR,127.0.0.0/8," + DIRECT + ",no-resolve",
            "IP-CIDR,172.16.0.0/12," + DIRECT + ",no-resolve",
            "IP-CIDR,192.168.0.0/16," + DIRECT + ",no-resolve",
            "IP-CIDR,10.0.0.0/8," + DIRECT + ",no-resolve",
            "GEOIP,CN," + DIRECT + ",no-resolve",
            "FINAL," + SELECT,
        ].join("\n");
    }

    return (
        surgeGeneralHeader(opts) +
        "[Proxy]\n" +
        proxyLines.trim() +
        "\n\n[Proxy Group]\n" +
        proxyGroups +
        "\n\n[Rule]\n" +
        ruleLines +
        "\n"
    );
}
