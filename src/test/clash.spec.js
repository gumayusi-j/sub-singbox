import { expect } from "chai";
import assembleClash from "@/kit/assemble-clash";
import { findPreset } from "@/kit/acl4ssr/build";

const DUMMY_PROXIES = `
proxies:
  - name: "🇭🇰 香港-01"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇯🇵 日本-01 0.5x"
    type: ss
    server: 1.2.3.5
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇺🇲 美国-01 2.0x"
    type: ss
    server: 1.2.3.6
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;

describe("assembleClash", function () {
    it("generates clash config with hosts mapping, modern settings, and QUIC reject rule in fallback mode", function () {
        const yaml = assembleClash(DUMMY_PROXIES);
        expect(yaml).to.include("tcp-concurrent: true");
        expect(yaml).to.include("unified-delay: true");
        expect(yaml).to.include("global-client-fingerprint: chrome");
        expect(yaml).to.include("find-process-mode: strict");
        expect(yaml).to.include("profile:");
        expect(yaml).to.include("store-selected: true");
        expect(yaml).to.include("proxy-server-nameserver:");
        expect(yaml).to.include("direct-nameserver:");
        expect(yaml).to.include("cache-algorithm: arc");

        // Hosts
        expect(yaml).to.include("hosts:");
        expect(yaml).to.include("'services.googleapis.cn': 'services.googleapis.com'");
        expect(yaml).to.include("'dns.google': ['8.8.8.8', '8.8.4.4']");
        expect(yaml).to.include("'+.mcdn.bilivideo.com': '0.0.0.0'");
        expect(yaml).to.include("- AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOIP,CN)))),REJECT");
        expect(yaml).to.include("- MATCH,🚀 节点选择");
    });

    it("assembles clash config with ACL4SSR full preset, region auto groups and multiplier groups", function () {
        const preset = findPreset("acl4ssr-full");
        const yaml = assembleClash(DUMMY_PROXIES, preset);

        // Hosts
        expect(yaml).to.include("hosts:");
        expect(yaml).to.include("'services.googleapis.cn': 'services.googleapis.com'");
        expect(yaml).to.include("'+.mcdn.bilivideo.com': '0.0.0.0'");

        // Proxy groups
        expect(yaml).to.include("name: \"🇭🇰 香港自动\"");
        expect(yaml).to.include("type: url-test");
        expect(yaml).to.not.include("name: \"🇭🇰 香港节点\"");
        expect(yaml).to.include("- \"🇭🇰 香港自动\"");

        expect(yaml).to.include("name: \"💰 低倍率节点\"");
        expect(yaml).to.include("name: \"💎 高倍率节点\"");
        expect(yaml).to.not.include("name: \"☕ 正常倍率节点\"");
        expect(yaml).to.include("name: \"💬 Ai平台\"");

        // Rules
        expect(yaml).to.include("- AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOIP,CN)))),REJECT");
        expect(yaml).to.include("- MATCH,🐟 漏网之鱼");
    });

    it("assembles clash config with ACL4SSR default preset, region auto groups and multiplier groups", function () {
        const preset = findPreset("acl4ssr-default");
        const yaml = assembleClash(DUMMY_PROXIES, preset);

        // Proxy groups
        expect(yaml).to.include("name: \"🇭🇰 香港自动\"");
        expect(yaml).to.include("type: url-test");
        expect(yaml).to.not.include("name: \"🇭🇰 香港节点\"");
        expect(yaml).to.include("name: \"🇯🇵 日本自动\"");
        expect(yaml).to.include("name: \"🇺🇲 美国自动\"");

        // Multiplier groups
        expect(yaml).to.include("name: \"💰 低倍率节点\"");
        expect(yaml).to.include("name: \"💎 高倍率节点\"");

        // Node select contains country groups
        expect(yaml).to.include("- \"🇭🇰 香港自动\"");
        expect(yaml).to.include("- \"🇯🇵 日本自动\"");
        expect(yaml).to.include("- \"🇺🇲 美国自动\"");

        // Rules
        expect(yaml).to.include("- MATCH,🐟 漏网之鱼");
    });

    it("assembles clash config with ☕ 正常倍率节点 when no < 1x nodes exist and > 1x nodes exist", function () {
        const NORMAL_RATE_PROXIES = `
proxies:
  - name: "🇭🇰 香港-01"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇯🇵 日本-01 1.0x"
    type: ss
    server: 1.2.3.5
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇺🇲 美国-01 2.0x"
    type: ss
    server: 1.2.3.6
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;
        const preset = findPreset("acl4ssr-full");
        const yaml = assembleClash(NORMAL_RATE_PROXIES, preset);

        // Low-rate is dropped, normal-rate is emitted, high-rate is emitted
        expect(yaml).to.not.include("name: \"💰 低倍率节点\"");
        expect(yaml).to.include("name: \"☕ 正常倍率节点\"");
        expect(yaml).to.include("name: \"💎 高倍率节点\"");

        // ☕ 正常倍率节点 contains both plain standard node and explicit 1.0x node
        expect(yaml).to.include("- \"🇭🇰 香港-01\"");
        expect(yaml).to.include("- \"🇯🇵 日本-01 1.0x\"");

        // Ai platform and node select include ☕ 正常倍率节点
        expect(yaml).to.include("- \"☕ 正常倍率节点\"");
    });

    it("assembles clash config with ☕ 正常倍率节点 for pure plain nodes without 1x label", function () {
        const PLAIN_PROXIES = `
proxies:
  - name: "🇭🇰 香港-01"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇯🇵 日本-01"
    type: ss
    server: 1.2.3.5
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "🇺🇲 美国-01 2.0x"
    type: ss
    server: 1.2.3.6
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "剩余流量 0.00x"
    type: ss
    server: 1.2.3.7
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;
        const preset = findPreset("acl4ssr-default");
        const yaml = assembleClash(PLAIN_PROXIES, preset);

        expect(yaml).to.not.include("name: \"💰 低倍率节点\"");
        expect(yaml).to.include("name: \"☕ 正常倍率节点\"");
        expect(yaml).to.include("name: \"💎 高倍率节点\"");

        expect(yaml).to.include("- \"🇭🇰 香港-01\"");
        expect(yaml).to.include("- \"🇯🇵 日本-01\"");
    });

    it("supports ruleProviders option with modern rule-providers format", function () {
        const yaml = assembleClash(DUMMY_PROXIES, null, { ruleProviders: true });
        expect(yaml).to.include("rule-providers:");
        expect(yaml).to.include("format: mrs");
        expect(yaml).to.include("private:");
        expect(yaml).to.include("cn_ip:");
        expect(yaml).to.include("ai:");
        expect(yaml).to.include("youtube:");
    });

    it("filters notice/announcement nodes from operational proxy groups", function () {
        const MIXED_PROXIES = `
proxies:
  - name: "🇭🇰 香港-01"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "套餐到期: 2029-01-01"
    type: ss
    server: 1.2.3.5
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "官网: https://example.com"
    type: ss
    server: 1.2.3.6
    port: 8388
    cipher: aes-128-gcm
    password: pass
`;
        const yaml = assembleClash(MIXED_PROXIES);
        // Fallback manual and auto test groups should only contain actual node
        expect(yaml).to.include("- \"🇭🇰 香港-01\"");
        expect(yaml).to.not.include("- \"套餐到期: 2029-01-01\"");
        expect(yaml).to.not.include("- \"官网: https://example.com\"");
    });
});
