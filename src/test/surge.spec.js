import { expect } from "chai";
import assembleSurge, { extractSurgeNodeNames } from "@/kit/assemble-surge";
import { findPreset } from "@/kit/acl4ssr/build";

const DUMMY_SURGE_PROXIES = `
🇭🇰 香港-01 = ss, 1.2.3.4, 8388, encrypt-method=aes-128-gcm, password=pass
🇯🇵 日本-01 0.5x = ss, 1.2.3.5, 8388, encrypt-method=aes-128-gcm, password=pass
🇺🇲 美国-01 2.0x = ss, 1.2.3.6, 8388, encrypt-method=aes-128-gcm, password=pass
AnyTLS-Node = anytls, 1.2.3.7, 443, password=pass, sni=example.com, alpn=h2,http/1.1
`;

describe("assembleSurge", function () {
    it("extracts node names correctly", function () {
        const names = extractSurgeNodeNames(DUMMY_SURGE_PROXIES);
        expect(names).to.deep.equal([
            "🇭🇰 香港-01",
            "🇯🇵 日本-01 0.5x",
            "🇺🇲 美国-01 2.0x",
            "AnyTLS-Node",
        ]);
    });

    it("generates a complete Surfboard/Surge .conf with [General], [Proxy], [Proxy Group], and [Rule] sections in fallback mode", function () {
        const conf = assembleSurge(DUMMY_SURGE_PROXIES);
        expect(conf).to.include("[General]");
        expect(conf).to.include("dns-server = 223.5.5.5, 119.29.29.29");
        expect(conf).to.include("skip-proxy = 127.0.0.1, localhost, *.local");

        expect(conf).to.include("[Proxy]");
        expect(conf).to.include("🇭🇰 香港-01 = ss, 1.2.3.4, 8388");
        expect(conf).to.include("AnyTLS-Node = anytls, 1.2.3.7, 443");

        expect(conf).to.include("[Proxy Group]");
        expect(conf).to.include("🚀 节点选择 = select, ♻️ 自动选择, 🎯 直连, 手动切换");
        expect(conf).to.include("手动切换 = select, 🇭🇰 香港-01, 🇯🇵 日本-01 0.5x, 🇺🇲 美国-01 2.0x, AnyTLS-Node");
        expect(conf).to.include("♻️ 自动选择 = url-test, 🇭🇰 香港-01, 🇯🇵 日本-01 0.5x, 🇺🇲 美国-01 2.0x, AnyTLS-Node, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50");
        expect(conf).to.include("🎯 直连 = select, DIRECT");

        expect(conf).to.include("[Rule]");
        expect(conf).to.include("DOMAIN-SUFFIX,local,🎯 直连");
        expect(conf).to.include("GEOIP,CN,🎯 直连,no-resolve");
        expect(conf).to.include("FINAL,🚀 节点选择");
    });

    it("assembles complete config with ACL4SSR default preset", function () {
        const preset = findPreset("acl4ssr-default");
        const conf = assembleSurge(DUMMY_SURGE_PROXIES, preset);

        expect(conf).to.include("[General]");
        expect(conf).to.include("[Proxy]");
        expect(conf).to.include("[Proxy Group]");
        expect(conf).to.include("节点选择 = select");
        expect(conf).to.include("自动选择 = url-test");
        expect(conf).to.include("[Rule]");
        expect(conf).to.include("GEOIP,CN,");
        expect(conf).to.include("FINAL,");
    });
});
