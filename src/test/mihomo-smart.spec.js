import { expect } from "chai";
import assembleClash from "@/kit/assemble-clash";
import { findPreset, presetList, assembleAcl } from "@/kit/acl4ssr/build";
import { fromText } from "@/kit/convert";

const SAMPLE_PROXIES_YAML = `proxies:
  - name: "🇭🇰 香港 01"
    type: ss
    server: 1.1.1.1
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇯🇵 东京 01"
    type: ss
    server: 2.2.2.2
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇺🇸 美国 01"
    type: ss
    server: 3.3.3.3
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇸🇬 新加坡 01 [0.2x]"
    type: ss
    server: 4.4.4.4
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇹🇼 台湾 01 [2.0倍]"
    type: ss
    server: 5.5.5.5
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇰🇷 韩国 01"
    type: ss
    server: 8.8.8.8
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "德国 01"
    type: ss
    server: 6.6.6.6
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "剩余流量：100GB | 到期时间：2027"
    type: ss
    server: 7.7.7.7
    port: 8388
    cipher: aes-128-gcm
    password: test
`;

describe("Mihomo Smart Preset (AIsouler/MyClash reference - streamlined)", function () {
    it("is exposed in findPreset and presetList", function () {
        const preset = findPreset("mihomo-smart");
        expect(preset).to.not.equal(null);
        expect(preset.id).to.equal("mihomo-smart");
        expect(preset.name).to.equal("Mihomo 现代智能分组");

        const list = presetList();
        expect(list.some((p) => p.id === "mihomo-smart")).to.equal(true);
    });

    describe("Clash / Mihomo configuration assembly", function () {
        it("assembles complete config with modern SVG icons, load balancing, and single-layer flat region groups", function () {
            const preset = findPreset("mihomo-smart");
            const configYaml = assembleClash(SAMPLE_PROXIES_YAML, preset);

            // 1. Notice/expired junk node should be filtered out from proxy groups
            expect(configYaml).to.not.include("剩余流量");

            // 2. Base groups (unified, clean 🚀 节点选择, ♻️ 自动选择, ⚖️ 负载均衡)
            expect(configYaml).to.include('- name: "🚀 节点选择"');
            expect(configYaml).to.include('- name: "🎯 手动选择"');
            expect(configYaml).to.include('- name: "♻️ 自动选择"');
            expect(configYaml).to.include('- name: "⚖️ 负载均衡"');
            expect(configYaml).to.include("type: load-balance");
            expect(configYaml).to.include("strategy: sticky-sessions");

            // 3. SVG icons are present
            expect(configYaml).to.include('icon: "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/Static.svg"');
            expect(configYaml).to.include('icon: "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/RoundRobin.svg"');
            expect(configYaml).to.include('icon: "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/HongKong.svg"');
            expect(configYaml).to.include('icon: "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/OpenAI.svg"');

            // 4. Single-layer flat region groups with flag emojis
            expect(configYaml).to.include('- name: "🇭🇰 香港"');
            expect(configYaml).to.include('- name: "🇯🇵 日本"');
            expect(configYaml).to.include('- name: "🇺🇸 美国"');
            expect(configYaml).to.include('- name: "🇸🇬 新加坡"');
            expect(configYaml).to.include('- name: "🧋 台湾"');
            expect(configYaml).to.include('- name: "🇰🇷 韩国"');
            expect(configYaml).to.include('- name: "🌍 其他地区"');
            expect(configYaml).to.not.include('- name: "🌍 其他节点"');
            expect(configYaml).to.not.include('- name: "香港-自动选择"');
            expect(configYaml).to.not.include('- name: "其他节点-自动选择"');

            // 5. Rate groups
            expect(configYaml).to.include('- name: "💰 低倍率节点"');
            expect(configYaml).to.include('- name: "💎 高倍率节点"');

            // 6. Core service routing groups (streamlined high-value groups)
            expect(configYaml).to.include('- name: "AI"');
            expect(configYaml).to.include('- name: "YouTube"');
            expect(configYaml).to.include('- name: "Telegram"');
            expect(configYaml).to.include('- name: "Netflix"');
            expect(configYaml).to.include('- name: "AdBlock"');

            // 7. Rule providers and rules
            expect(configYaml).to.include("rule-providers:");
            expect(configYaml).to.include("ai:");
            expect(configYaml).to.include("youtube:");
            expect(configYaml).to.include("rules:");
            expect(configYaml).to.include("- RULE-SET,ai,AI");
            expect(configYaml).to.include("- RULE-SET,category-ads,AdBlock");
            expect(configYaml).to.include("- MATCH,🐟 漏网之鱼");
            expect(configYaml).to.include("AND,((NETWORK,UDP),(DST-PORT,443)");
        });

        it("works when triggered via options.aclPreset", function () {
            const configYaml = assembleClash(SAMPLE_PROXIES_YAML, null, {
                aclPreset: "mihomo-smart",
            });
            expect(configYaml).to.include('- name: "⚖️ 负载均衡"');
            expect(configYaml).to.include('icon: "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/OpenAI.svg"');
        });
    });

    describe("sing-box configuration assembly", function () {
        it("assembles valid sing-box config when mihomo-smart is selected", function () {
            const parsed = fromText(SAMPLE_PROXIES_YAML);
            const config = assembleAcl(parsed, { aclPreset: "mihomo-smart" });

            expect(config).to.be.an("object");
            expect(config.outbounds).to.be.an("array");
            const tags = config.outbounds.map((o) => o.tag);

            expect(tags).to.include("🚀 节点选择");
            expect(tags).to.include("🎯 手动选择");
            expect(tags).to.include("♻️ 自动选择");
            expect(tags).to.include("🇭🇰 香港");
            expect(tags).to.include("🇯🇵 日本");
            expect(tags).to.include("🇺🇸 美国");
            expect(tags).to.include("🇸🇬 新加坡");
            expect(tags).to.include("🧋 台湾");
            expect(tags).to.include("🇰🇷 韩国");
            expect(tags).to.include("🌍 其他地区");
            expect(tags).to.include("💬 AI");
            expect(tags).to.include("📹 YouTube");
            expect(tags).to.include("direct");

            expect(config.route).to.be.an("object");
            expect(config.route.rules).to.be.an("array");
            expect(config.route.final).to.equal("🐟 漏网之鱼");

            // geoip-cn rule-set must be defined because dns.rules uses it (and geoCn routes direct)
            expect(config.route.rule_set).to.be.an("array");
            const ruleSetTags = config.route.rule_set.map((r) => r.tag);
            expect(ruleSetTags).to.include("geoip-cn");

            // Direct route rules and geoip-cn route rule should be present
            const geoipRule = config.route.rules.find((r) => r.rule_set === "geoip-cn");
            expect(geoipRule).to.not.equal(undefined);
            expect(geoipRule.outbound).to.equal("direct");

            const directRules = config.route.rules.filter((r) => r.outbound === "direct");
            expect(directRules.length).to.be.greaterThan(0);
        });
    });

    describe("Zero-width character stripping & rate matching precision", function () {
        it("strips invisible characters while preserving emoji presentation", function () {
            const { toMatchableName } = require("@/kit/mihomo-smart/constants");
            expect(toMatchableName("H\u200BK\u200B 01")).to.equal("HK 01");
            expect(toMatchableName("\u3164SG\uFFA0 03")).to.equal("SG 03");
            expect(toMatchableName("\uFEFFHK\u2060 01")).to.equal("HK 01");
            expect(toMatchableName("H\u200CK\u200DJ")).to.equal("H\u200CK\u200DJ"); // ZWJ / ZWNJ preserved
            expect(toMatchableName("❤️\uFE0F HK")).to.equal("❤️\uFE0F HK"); // Variation selector preserved
        });

        it("correctly classifies proxies with zero-width characters and preserves raw name", function () {
            const zwHk = "H\u200BK\u200B 01";
            const zwNotice = "官\u200B网\u200B公\u200B告：剩余流量";
            const zwProxiesYaml = `proxies:
  - name: "${zwHk}"
    type: ss
    server: 1.1.1.1
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "${zwNotice}"
    type: ss
    server: 2.2.2.2
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇯🇵 节点 1.0倍率"
    type: ss
    server: 3.3.3.3
    port: 8388
    cipher: aes-128-gcm
    password: test
  - name: "🇺🇸 节点 0.2x 省流"
    type: ss
    server: 4.4.4.4
    port: 8388
    cipher: aes-128-gcm
    password: test
`;
            const preset = findPreset("mihomo-smart");
            const configYaml = assembleClash(zwProxiesYaml, preset);

            // Notice with zero-width chars should still be dropped
            expect(configYaml).to.not.include("剩余流量");
            expect(configYaml).to.not.include("官网公告");

            // Zero-width node name should be matched to HK region group, preserving raw name with \u200B
            expect(configYaml).to.include('- name: "🇭🇰 香港"');
            const hkSection = configYaml.split('- name: "🇭🇰 香港"')[1]?.split('- name:')[0] || "";
            expect(hkSection).to.include(`- "${zwHk}"`);

            // 1.0x should NOT be classified as low-rate node
            const lowRateSection = configYaml.split('- name: "💰 低倍率节点"')[1]?.split('- name:')[0] || "";
            expect(lowRateSection).to.not.include("1.0倍率");
            expect(lowRateSection).to.include("0.2x 省流");
        });
    });
});

