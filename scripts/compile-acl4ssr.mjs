// Compile the bundled ACL4SSR presets into a single self-contained module.
//
// Reads the ACL4SSR_Online{,_Full,_Mini}.ini snapshots in
// src/kit/acl4ssr/data/ and every .list they reference, then writes
// src/kit/acl4ssr/presets.generated.js exporting:
//
//   LISTS:   { "<ACL4SSR_*.list name>": "<line text>" }
//   PRESETS: [{ id, name, summary, rules: [{...}], groups: [{...}] }]
//
// Both dev (babel) and the esbuild single-file bundle import the generated
// module, so no filesystem access is needed at runtime.
//
// Re-run after updating the rule snapshots:
//   node scripts/compile-acl4ssr.mjs
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "src", "kit", "acl4ssr", "data");
const OUT = path.join(ROOT, "src", "kit", "acl4ssr", "presets.generated.js");

const PRESET_DEFS = [
    {
        ini: "ACL4SSR_Online.ini",
        id: "acl4ssr-default",
        name: "ACL4SSR 默认",
        summary: "去广告、自动测速，含国外媒体、电报、微软和苹果分流。",
    },
    {
        ini: "ACL4SSR_Online_Full.ini",
        id: "acl4ssr-full",
        name: "ACL4SSR 全分组",
        summary:
            "最完整分组：流媒体、AI、游戏、音乐，并按节点名自动分出香港/日本/美国/台湾/狮城/韩国地区组（完整 GFW 列表）。",
    },
    {
        ini: "ACL4SSR_Online_Mini.ini",
        id: "acl4ssr-mini",
        name: "ACL4SSR 精简",
        summary: "只保留节点选择、自动选择、全球直连与拦截，策略组最少、规则最省。",
    },
];

function cleanLines(text) {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
}

// Upstream URL e.g. .../Clash/Ruleset/GoogleFCM.list -> ACL4SSR_Ruleset_GoogleFCM.list
function dataNameForUpstreamUrl(url) {
    const m = url.match(/\/Clash\/(.+)\.list$/);
    if (!m) return null;
    return "ACL4SSR_" + m[1].replace(/\//g, "_") + ".list";
}

// Parse one [custom] ini into ordered { rules, groups }.
function parseIni(text) {
    const rules = [];
    const groups = [];
    for (const line of cleanLines(text)) {
        if (line.startsWith("#") || line.startsWith(";")) continue;
        if (line.startsWith("ruleset=")) {
            const val = line.slice("ruleset=".length);
            const comma = val.indexOf(",");
            if (comma <= 0) continue;
            const group = val.slice(0, comma).trim();
            const rest = val.slice(comma + 1).trim();
            if (rest.startsWith("[]")) {
                const inner = rest.slice(2);
                if (/^GEOIP,CN$/i.test(inner)) rules.push({ geoCn: true, group });
                else if (/^FINAL$/i.test(inner)) rules.push({ final: true, group });
                // e.g. []GEOIP,LAN is commented out upstream; ignore anything else.
                continue;
            }
            const list = dataNameForUpstreamUrl(rest);
            if (list) rules.push({ list, group });
        } else if (line.startsWith("custom_proxy_group=")) {
            const val = line.slice("custom_proxy_group=".length);
            const parts = val.split("`");
            const tag = parts.shift().trim();
            const kind = parts.shift().trim(); // select | url-test
            if (!tag || !kind) continue;
            groups.push({ tag, kind, memberTokens: parts });
        }
    }
    return { rules, groups };
}

// Group names whose only semantic is reject (members are just REJECT/DIRECT).
// They never become outbounds; rules targeting them become `action: reject`.
function isRejectGroup(group) {
    if (group.kind !== "select") return false;
    const regex = group.memberTokens.filter((t) => !t.startsWith("[]"));
    if (regex.length !== 0) return false; // any node-matching member means it holds nodes
    const refs = group.memberTokens.map((t) => t.slice(2));
    return refs.some((r) => /^REJECT$/i.test(r));
}

function main() {
    const available = new Set(readdirSync(DATA).filter((f) => f.endsWith(".list")));
    const presets = [];
    const usedLists = new Set();

    for (const def of PRESET_DEFS) {
        const text = readFileSync(path.join(DATA, def.ini), "utf8");
        const { rules, groups } = parseIni(text);
        presets.push({
            id: def.id,
            name: def.name,
            summary: def.summary,
            groups: groups.map((g) => {
                const drop = g.kind === "select" && isRejectGroup(g);
                return { tag: g.tag, kind: g.kind, drop, memberTokens: g.memberTokens };
            }),
            rules: rules.map((r) => {
                if (r.list) {
                    if (!available.has(r.list)) {
                        throw new Error("missing rule file for " + def.id + ": " + r.list);
                    }
                    usedLists.add(r.list);
                }
                return r;
            }),
        });
    }

    const lists = {};
    for (const name of [...usedLists].sort()) {
        lists[name] = readFileSync(path.join(DATA, name), "utf8");
    }

    const banner =
        "// AUTO-GENERATED by scripts/compile-acl4ssr.mjs - do not edit by hand.\n" +
        "// ACL4SSR rule snapshots bundled under src/kit/acl4ssr/data (see NOTICE.md).\n";
    const body =
        "export const LISTS = " +
        JSON.stringify(lists) +
        ";\n\nexport const PRESETS = " +
        JSON.stringify(presets) +
        ";\n";
    writeFileSync(OUT, banner + body);
    console.log(
        "[compile-acl4ssr] wrote " + OUT +
            " (" + Object.keys(lists).length + " lists, " +
            presets.length + " presets)",
    );
}

main();
