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
    it("generates clash config with hosts mapping and QUIC reject rule in fallback mode", function () {
        const yaml = assembleClash(DUMMY_PROXIES);
        expect(yaml).to.include("hosts:");
        expect(yaml).to.include("'services.googleapis.cn': 'services.googleapis.com'");
        expect(yaml).to.include("'+.mcdn.bilivideo.com': '0.0.0.0'");
        expect(yaml).to.include("- AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");
        expect(yaml).to.include("- MATCH,🚀 节点选择");
    });

    it("assembles clash config with ACL4SSR full preset, dual-level region groups and multiplier groups", function () {
        const preset = findPreset("acl4ssr-full");
        const yaml = assembleClash(DUMMY_PROXIES, preset);

        // Hosts
        expect(yaml).to.include("hosts:");
        expect(yaml).to.include("'services.googleapis.cn': 'services.googleapis.com'");
        expect(yaml).to.include("'+.mcdn.bilivideo.com': '0.0.0.0'");

        // Proxy groups
        expect(yaml).to.include("name: \"🇭🇰 香港自动\"");
        expect(yaml).to.include("type: url-test");
        expect(yaml).to.include("name: \"🇭🇰 香港节点\"");
        expect(yaml).to.include("- \"🇭🇰 香港自动\"");
        expect(yaml).to.include("- \"🇭🇰 香港-01\"");

        expect(yaml).to.include("name: \"💰 低倍率节点\"");
        expect(yaml).to.include("name: \"💎 高倍率节点\"");
        expect(yaml).to.include("name: \"💬 Ai平台\"");

        // Rules
        expect(yaml).to.include("- AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");
        expect(yaml).to.include("- MATCH,🐟 漏网之鱼");
    });
});
