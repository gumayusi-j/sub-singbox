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
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-mini", mode: "proxy" });
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
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-default", mode: "proxy" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🌍 国外媒体");
        expect(tags).to.include("📲 电报信息");
        expect(tags).to.include("Ⓜ️ 微软服务");
        expect(tags).to.include("🍎 苹果服务");
        // no region groups in the default preset
        expect(tags).to.not.include("🇭🇰 香港节点");
        assertReferencesResolve(config);
    });

    it("only creates region groups whose node-name regex actually matches", function () {
        const config = assembleAcl(parsed(), { aclPreset: "acl4ssr-full", mode: "proxy" });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🇭🇰 香港节点");
        expect(tags).to.include("🇯🇵 日本节点");
        expect(tags).to.include("🇺🇲 美国节点");
        expect(tags).to.include("🚀 手动切换");
        // no node matches these -> the group must not exist at all
        expect(tags).to.not.include("🇨🇳 台湾节点");
        expect(tags).to.not.include("🇸🇬 狮城节点");
        expect(tags).to.not.include("🎥 奈飞节点");
        // and nothing may reference a dropped group
        const allRefs = config.outbounds.reduce((acc, o) => acc.concat(o.outbounds || []), []);
        expect(allRefs).to.not.include("🇨🇳 台湾节点");
        // region groups only carry matching node tags
        const hk = config.outbounds.find((o) => o.tag === "🇭🇰 香港节点");
        expect(hk.outbounds).to.deep.equal(["🇭🇰 香港-01"]);
        assertReferencesResolve(config);
    });

    it("always reaches the final group even when no region matches", function () {
        const config = assembleAcl(parsed(["随便一个节点"]), {
            aclPreset: "acl4ssr-full",
            mode: "proxy",
        });
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.not.include("🇭🇰 香港节点");
        expect(config.route.final).to.equal("🐟 漏网之鱼");
        assertReferencesResolve(config);
    });

    it("emits a bootable direct profile for zero nodes", function () {
        const config = assembleAcl({ outbounds: [], endpoints: [] }, {
            aclPreset: "acl4ssr-mini",
            mode: "proxy",
        });
        expect(config.outbounds.map((o) => o.tag)).to.deep.equal(["direct"]);
        expect(config.route.final).to.equal("direct");
    });

    it("rejects an unknown preset id", function () {
        expect(function () {
            assembleAcl(parsed(), { aclPreset: "bogus" });
        }).to.throw(/unknown ACL4SSR preset/);
    });
});
