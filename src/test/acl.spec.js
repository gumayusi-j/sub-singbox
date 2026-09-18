import { expect } from "chai";
import { assembleAcl, findPreset, presetList } from "@/kit/acl4ssr/build";

// Synthetic node tags covering a couple of ACL4SSR region patterns (香港 / JP /
// US) plus one that should match no region group.
const NODES = [
    { type: "shadowsocks", tag: "🇭🇰 香港-01" },
    { type: "trojan", tag: "JP-01" },
    { type: "trojan", tag: "US-02" },
    { type: "trojan", tag: "无名节点" },
];

function parsed(tags) {
    return {
        outbounds: (tags || NODES.map((n) => n.tag)).map((tag) => ({ type: "trojan", tag })),
        endpoints: [],
    };
}

// Every reference the config makes (group members, rule outbounds, final) must
// resolve to an outbound tag that actually exists.
function assertReferencesResolve(config) {
    const tags = new Set(config.outbounds.map((o) => o.tag));
    expect(tags.size).to.equal(config.outbounds.length, "duplicate outbound tags");
    for (const o of config.outbounds) {
        for (const ref of o.outbounds || []) {
            expect(tags.has(ref), "outbound " + o.tag + " -> missing " + ref).to.equal(true);
        }
    }
    const ruleSets = new Set((config.route.rule_set || []).map((r) => r.tag));
    for (const rule of config.route.rules) {
        if (rule.rule_set && !Array.isArray(rule.rule_set)) {
            expect(ruleSets.has(rule.rule_set), "missing rule_set " + rule.rule_set).to.equal(true);
        }
        if (rule.outbound) {
            expect(tags.has(rule.outbound), "rule -> missing " + rule.outbound).to.equal(true);
        }
    }
    expect(tags.has(config.route.final), "final -> missing " + config.route.final).to.equal(true);
}

describe("ACL4SSR presets", function () {
    it("exposes the three built-in presets", function () {
        const list = presetList();
        const ids = list.map((p) => p.id);
        expect(ids).to.include("acl4ssr-default");
        expect(ids).to.include("acl4ssr-full");
        expect(ids).to.include("acl4ssr-mini");
        expect(findPreset("acl4ssr-mini").name).to.equal("ACL4SSR 精简");
        expect(findPreset("nope")).to.equal(null);
    });

    it("builds the mini preset with base groups and folded reject rules", function () {
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-mini" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🚀 节点选择");
        expect(tags).to.include("♻️ 自动选择");
        expect(tags).to.include("🎯 全球直连");
        expect(tags).to.include("🐟 漏网之鱼");
        expect(tags).to.include("direct");
        // mini has no service groups
        expect(tags).to.not.include("💬 Ai平台");
        expect(config.route.final).to.equal("🐟 漏网之鱼");
        // BanAD is part of mini -> some rule must be a reject action
        const rejects = config.route.rules.filter((r) => r.action === "reject");
        expect(rejects.length).to.be.greaterThan(0);
        // GEOIP,CN pulls in the remote geoip rule-set
        expect((config.route.rule_set || []).map((r) => r.tag)).to.deep.equal(["geoip-cn"]);
        assertReferencesResolve(config);
    });

    it("adds service groups for the default preset", function () {
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-default" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🌍 国外媒体");
        expect(tags).to.include("📲 电报信息");
        expect(tags).to.include("Ⓜ️ 微软服务");
        expect(tags).to.include("🍎 苹果服务");
        expect(tags).to.include("💬 Ai平台");
        // no region groups in the default preset
        expect(tags).to.not.include("🇭🇰 香港节点");
        assertReferencesResolve(config);
    });

    it("only creates region groups whose node-name regex actually matches", function () {
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-full" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🇭🇰 香港节点");
        expect(tags).to.include("🇭🇰 香港自动");
        expect(tags).to.include("🇯🇵 日本节点");
        expect(tags).to.include("🇯🇵 日本自动");
        expect(tags).to.include("🇺🇲 美国节点");
        expect(tags).to.include("🇺🇲 美国自动");
        expect(tags).to.include("🚀 手动切换");
        // no node matches these -> the group must not exist at all
        expect(tags).to.not.include("🇨🇳 台湾节点");
        expect(tags).to.not.include("🇨🇳 台湾自动");
        expect(tags).to.not.include("🇸🇬 狮城节点");
        expect(tags).to.not.include("🇸🇬 狮城自动");
        expect(tags).to.not.include("🎥 奈飞节点");
        // and nothing may reference a dropped group
        const allRefs = config.outbounds.reduce((acc, o) => acc.concat(o.outbounds || []), []);
        expect(allRefs).to.not.include("🇨🇳 台湾节点");
        expect(allRefs).to.not.include("🇨🇳 台湾自动");
        // region groups carry auto sub-group and matching node tags
        const hk = config.outbounds.find((o) => o.tag === "🇭🇰 香港节点");
        expect(hk.outbounds).to.deep.equal(["🇭🇰 香港自动", "🇭🇰 香港-01"]);
        const hkAuto = config.outbounds.find((o) => o.tag === "🇭🇰 香港自动");
        expect(hkAuto.outbounds).to.deep.equal(["🇭🇰 香港-01"]);
        expect(hkAuto.type).to.equal("urltest");
        assertReferencesResolve(config);
    });

    // The parser rewrite must not cost the folding pass. A snapshot holds
    // ~10k rule lines; if a matcher field ever came out array-valued at the
    // top level, foldSingboxRules would refuse every one of them and the
    // config would carry one route rule per line.
    it("keeps every preset's rule list folded and free of parser artefacts", function () {
        const sizes = { "acl4ssr-mini": 11, "acl4ssr-default": 17, "acl4ssr-full": 26 };
        for (const [id, expected] of Object.entries(sizes)) {
            const config = assembleAcl(parsed(), { aclPreset: id });
            expect(config.route.rules.length, id).to.equal(expected);
            const blob = JSON.stringify(config.route.rules);
            // `no-resolve` is parsed now but has no sing-box equivalent, so it
            // must not reach the output under any spelling.
            expect(blob, id).to.not.match(/no[-_]resolve/i);
            expect(blob, id).to.not.contain("undefined");
            // A reject policy word is an action, never an outbound tag.
            for (const rule of config.route.rules) {
                expect(String(rule.outbound || ""), id).to.not.match(/^REJECT/i);
            }
            assertReferencesResolve(config);
        }
    });

    it("always reaches the final group even when no region matches", function () {
        const config = assembleAcl(parsed(["随便一个节点"]), {
            aclPreset: "acl4ssr-full",
            
        });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.not.include("🇭🇰 香港节点");
        expect(config.route.final).to.equal("🐟 漏网之鱼");
        assertReferencesResolve(config);
    });

    it("emits a bootable direct profile for zero nodes", function () {
        const config = assembleAcl({ outbounds: [], endpoints: [] }, {
            aclPreset: "acl4ssr-mini",
            
        });
        expect(config.outbounds.map((o) => o.tag)).to.deep.equal(["direct"]);
        expect(config.route.final).to.equal("direct");
    });

    it("emits low-multiplier url-test and high-multiplier selector groups when matching nodes exist", function () {
        const testNodes = [
            "香港 01 - 0.2x",
            "台湾 02 [1x]",
            "日本 03 1.0倍",
            "省流 04",
            "专线 05 - 1.5x",
            "专线 06 [2X]",
            "专线 07 10倍",
            "高倍率 08",
            "普通节点 09",
        ];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full"]) {
            const config = assembleAcl(parsed(testNodes), { aclPreset: presetId });
            const outbounds = config.outbounds;
            const tags = outbounds.map((o) => o.tag);

            expect(tags, presetId).to.include("💰 低倍率节点");
            const lowGroup = outbounds.find((o) => o.tag === "💰 低倍率节点");
            expect(lowGroup.type, presetId).to.equal("urltest");
            expect(lowGroup.outbounds, presetId).to.deep.equal([
                "香港 01 - 0.2x",
                "省流 04",
            ]);
            expect(tags, presetId).to.not.include("☕ 正常倍率（1x）");

            expect(tags, presetId).to.include("💎 高倍率节点");
            const highGroup = outbounds.find((o) => o.tag === "💎 高倍率节点");
            expect(highGroup.type, presetId).to.equal("selector");
            expect(highGroup.outbounds, presetId).to.deep.equal([
                "专线 05 - 1.5x",
                "专线 06 [2X]",
                "专线 07 10倍",
                "高倍率 08",
            ]);

            const nodeSelect = outbounds.find((o) => o.tag === "🚀 节点选择");
            expect(nodeSelect.outbounds, presetId).to.include("💰 低倍率节点");
            expect(nodeSelect.outbounds, presetId).to.include("💎 高倍率节点");
            expect(nodeSelect.outbounds, presetId).to.not.include("☕ 正常倍率（1x）");

            assertReferencesResolve(config);
        }
    });

    it("drops low/high/normal multiplier groups cleanly when no nodes match", function () {
        const noMultiplierNodes = ["香港 01", "日本 02", "台湾 03"];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full"]) {
            const config = assembleAcl(parsed(noMultiplierNodes), { aclPreset: presetId });
            const tags = config.outbounds.map((o) => o.tag);
            expect(tags, presetId).to.not.include("💰 低倍率节点");
            expect(tags, presetId).to.not.include("☕ 正常倍率（1x）");
            expect(tags, presetId).to.not.include("💎 高倍率节点");
            const nodeSelect = config.outbounds.find((o) => o.tag === "🚀 节点选择");
            expect(nodeSelect.outbounds, presetId).to.not.include("💰 低倍率节点");
            expect(nodeSelect.outbounds, presetId).to.not.include("☕ 正常倍率（1x）");
            expect(nodeSelect.outbounds, presetId).to.not.include("💎 高倍率节点");
            assertReferencesResolve(config);
        }
    });

    it("emits normal-multiplier group when no < 1x nodes exist and > 1x nodes exist", function () {
        const testNodes = [
            "台湾 02 [1x]",
            "日本 03 1.0倍",
            "专线 05 - 1.5x",
            "专线 06 [2X]",
            "普通节点 09",
        ];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full", "acl4ssr-mini"]) {
            const config = assembleAcl(parsed(testNodes), { aclPreset: presetId });
            const outbounds = config.outbounds;
            const tags = outbounds.map((o) => o.tag);

            // < 1x does not exist -> low rate group dropped
            expect(tags, presetId).to.not.include("💰 低倍率节点");

            // Normal rate group emitted with explicit 1x nodes
            expect(tags, presetId).to.include("☕ 正常倍率（1x）");
            const normalGroup = outbounds.find((o) => o.tag === "☕ 正常倍率（1x）");
            expect(normalGroup.type, presetId).to.equal("selector");
            expect(normalGroup.outbounds, presetId).to.deep.equal([
                "台湾 02 [1x]",
                "日本 03 1.0倍",
                "普通节点 09",
            ]);

            const nodeSelect = outbounds.find((o) => o.tag === "🚀 节点选择");
            expect(nodeSelect.outbounds, presetId).to.include("☕ 正常倍率（1x）");
            expect(nodeSelect.outbounds, presetId).to.not.include("💰 低倍率节点");

            if (presetId !== "acl4ssr-mini") {
                expect(tags, presetId).to.include("💎 高倍率节点");
                expect(nodeSelect.outbounds, presetId).to.include("💎 高倍率节点");
                const aiGroup = outbounds.find((o) => o.tag === "💬 Ai平台");
                if (aiGroup) {
                    expect(aiGroup.outbounds, presetId).to.include("☕ 正常倍率（1x）");
                    expect(aiGroup.outbounds, presetId).to.not.include("💰 低倍率节点");
                }
            }

            assertReferencesResolve(config);
        }
    });

    it("falls back to ordinary plain nodes for normal-multiplier group when no explicit 1x labels exist", function () {
        const testNodes = [
            "香港 01",
            "日本 02",
            "专线 05 - 1.5x",
            "专线 06 [2X]",
        ];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full"]) {
            const config = assembleAcl(parsed(testNodes), { aclPreset: presetId });
            const outbounds = config.outbounds;
            const tags = outbounds.map((o) => o.tag);

            expect(tags, presetId).to.not.include("💰 低倍率节点");
            expect(tags, presetId).to.include("☕ 正常倍率（1x）");
            const normalGroup = outbounds.find((o) => o.tag === "☕ 正常倍率（1x）");
            expect(normalGroup.outbounds, presetId).to.deep.equal([
                "香港 01",
                "日本 02",
            ]);

            assertReferencesResolve(config);
        }
    });

    it("ignores announcement nodes like 0.0x / 0.00x when determining low-multiplier nodes", function () {
        const testNodes = [
            "香港 01",
            "日本 02",
            "专线 05 - 2.0x",
            "剩余流量 0.00x",
            "公告 0.0x",
        ];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full"]) {
            const config = assembleAcl(parsed(testNodes), { aclPreset: presetId });
            const tags = config.outbounds.map((o) => o.tag);

            // 0.00x announcements should NOT trigger low-multiplier group
            expect(tags, presetId).to.not.include("💰 低倍率节点");

            // Normal rate group should be formed
            expect(tags, presetId).to.include("☕ 正常倍率（1x）");
            const normalGroup = config.outbounds.find((o) => o.tag === "☕ 正常倍率（1x）");
            expect(normalGroup.outbounds, presetId).to.include("香港 01");
            expect(normalGroup.outbounds, presetId).to.include("日本 02");
            expect(normalGroup.outbounds, presetId).to.not.include("专线 05 - 2.0x");

            assertReferencesResolve(config);
        }
    });

    it("drops normal-multiplier group when no > 1x nodes exist", function () {
        const testNodes = [
            "香港 01",
            "台湾 02 [1x]",
            "日本 03 1.0倍",
        ];
        for (const presetId of ["acl4ssr-default", "acl4ssr-full", "acl4ssr-mini"]) {
            const config = assembleAcl(parsed(testNodes), { aclPreset: presetId });
            const tags = config.outbounds.map((o) => o.tag);
            expect(tags, presetId).to.not.include("💰 低倍率节点");
            expect(tags, presetId).to.not.include("☕ 正常倍率（1x）");
            expect(tags, presetId).to.not.include("💎 高倍率节点");
            assertReferencesResolve(config);
        }
    });

    it("emits low-multiplier group for mini preset when matching nodes exist", function () {
        const testNodes = [
            "香港 01 - 0.2x",
            "台湾 02 [1x]",
            "日本 03 1.0倍",
            "普通节点 04",
        ];
        const config = assembleAcl(parsed(testNodes), { aclPreset: "acl4ssr-mini" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("💰 低倍率节点");
        expect(tags).to.not.include("💎 高倍率节点");
        expect(tags).to.not.include("☕ 正常倍率（1x）");
        const lowGroup = config.outbounds.find((o) => o.tag === "💰 低倍率节点");
        expect(lowGroup.outbounds).to.deep.equal(["香港 01 - 0.2x"]);
        const nodeSelect = config.outbounds.find((o) => o.tag === "🚀 节点选择");
        expect(nodeSelect.outbounds).to.include("💰 低倍率节点");
        expect(nodeSelect.outbounds).to.not.include("☕ 正常倍率（1x）");
        const finalGroup = config.outbounds.find((o) => o.tag === "🐟 漏网之鱼");
        expect(finalGroup.outbounds).to.include("💰 低倍率节点");
        expect(finalGroup.outbounds).to.not.include("☕ 正常倍率（1x）");
        assertReferencesResolve(config);

        // When no multiplier matches, mini drops low-multiplier group cleanly
        const noMatch = assembleAcl(parsed(["香港 01", "日本 02"]), { aclPreset: "acl4ssr-mini" });
        expect(noMatch.outbounds.map((o) => o.tag)).to.not.include("💰 低倍率节点");
        expect(noMatch.outbounds.map((o) => o.tag)).to.not.include("☕ 正常倍率（1x）");
        assertReferencesResolve(noMatch);
    });

    it("rejects an unknown preset id", function () {
        expect(function () {
            assembleAcl(parsed(), { aclPreset: "bogus" });
        }).to.throw(/unknown ACL4SSR preset/);
    });
});

