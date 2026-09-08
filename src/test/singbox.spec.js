import { expect } from "chai";
import { ProxyUtils } from "@/core/proxy-utils";
import { fromText, fromNodes } from "@/kit/convert";
import assemble from "@/kit/assemble";
import { toSingboxRule, toSingboxRules } from "@/kit/rules/singbox";
import { CompatError } from "@/kit/compat";

const UUID = "11111111-1111-4111-8111-111111111111";

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function produceInternal(proxies, opts) {
    return ProxyUtils.produce(clone(proxies), "sing-box", "internal", opts);
}

function loadProducedJson(proxies, opts) {
    const external = ProxyUtils.produce(
        clone(proxies),
        "sing-box",
        "external",
        opts,
    );
    return JSON.parse(external);
}

function expectSubset(actual, expected, path) {
    path = path || "value";
    if (Array.isArray(expected)) {
        expect(actual, path).to.deep.equal(expected);
        return;
    }
    if (expected && typeof expected === "object") {
        expect(actual, path).to.be.an("object");
        for (const key of Object.keys(expected)) {
            expectSubset(actual[key], expected[key], path + "." + key);
        }
        return;
    }
    expect(actual, path).to.deep.equal(expected);
}

describe("sing-box producer (vendored kernel)", function () {
    it("exports ss / trojan / vmess nodes to sing-box outbounds", function () {
        const proxies = [
            { type: "ss", name: "ss1", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "pw", udp: true },
            { type: "trojan", name: "tj", server: "b.com", port: 443, password: "pw", tls: true, sni: "b.com", udp: true },
            {
                type: "vmess", name: "vm", server: "a.com", port: 443, uuid: UUID,
                network: "ws", alterId: 0, cipher: "auto", tls: true, udp: true,
                "ws-opts": { path: "/p", headers: { Host: "a.com" } },
            },
        ];
        const list = produceInternal(proxies);
        expect(list.length).to.equal(3);
        expectSubset(list[0], {
            tag: "ss1", type: "shadowsocks", server: "1.2.3.4",
            server_port: 8388, method: "aes-128-gcm", password: "pw",
        });
        expectSubset(list[1], {
            tag: "tj", type: "trojan", server: "b.com", server_port: 443,
            tls: { enabled: true, server_name: "b.com", insecure: false },
        });
        const vm = list[2];
        expectSubset(vm, {
            tag: "vm", type: "vmess", uuid: UUID, security: "auto", alter_id: 0,
        });
        expectSubset(vm.transport, { type: "ws", path: "/p", headers: { Host: "a.com" } });
        expectSubset(vm.tls, { enabled: true, server_name: "a.com", insecure: false });
    });

    it("classifies wireguard into endpoints (external output)", function () {
        const output = loadProducedJson([
            { type: "ss", name: "ss1", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "pw" },
            {
                type: "wireguard", name: "wg", server: "203.0.113.1", port: 51820,
                ip: "10.0.0.2", "private-key": "k1", "public-key": "k2", mtu: 1420,
            },
        ]);
        expect(output.outbounds.length).to.equal(1);
        expect(output.endpoints.length).to.equal(1);
        expect(output.endpoints[0].type).to.equal("wireguard");
        expect(output.endpoints[0].tag).to.equal("wg");
    });

    it("keeps supported Snell versions and maps v5 to v4 by default", function () {
        const proxies = [4, 5, 6].map((version) => ({
            type: "snell", name: "snell" + version, server: "s.example.com",
            port: 44046, psk: "p", version, udp: true, reuse: true,
        }));
        const list = produceInternal(proxies);
        expect(list.map((p) => p.version)).to.deep.equal([4, 4, 6]);
    });

    it("drops unsupported Snell versions unless include-unsupported-proxy", function () {
        const mk = (version) => ({
            type: "snell", name: "snell" + version, server: "s.example.com",
            port: 44046, psk: "p", version, udp: true,
        });
        const list = produceInternal([mk(4), mk(1), mk(5)]);
        expect(list.length).to.equal(2);
        const withUnsupported = produceInternal([mk(1), mk(2)], {
            "include-unsupported-proxy": true,
        });
        expect(withUnsupported.map((p) => p.version)).to.deep.equal([1, 2]);
    });

    it("splits ss + shadow-tls plugin into chained outbounds", function () {
        const output = loadProducedJson([
            {
                type: "ss", name: "ss-st", server: "s.example.com", port: 443,
                cipher: "aes-128-gcm", password: "pw", udp: true,
                plugin: "shadow-tls",
                "plugin-opts": { host: "mask.example.com", password: "sp", version: 3 },
            },
        ]);
        expect(output.outbounds.length).to.equal(2);
        expectSubset(output.outbounds[0], {
            tag: "ss-st", type: "shadowsocks", method: "aes-128-gcm",
            detour: "ss-st_shadowtls",
        });
        expectSubset(output.outbounds[1], {
            tag: "ss-st_shadowtls", type: "shadowtls",
            server: "s.example.com", server_port: 443, version: 3, password: "sp",
            tls: { enabled: true, server_name: "mask.example.com" },
        });
    });
});

describe("kit API", function () {
    const b64 = (s) => Buffer.from(s).toString("base64");

    it("fromText parses mixed URI subscription and produces outbounds", function () {
        const text = [
            "ss://" + b64("aes-128-gcm:pw@1.2.3.4:8388") + "#s1",
            "trojan://tp@b.com:443?sni=b.com#t1",
        ].join("\n");
        const { outbounds } = fromText(text);
        expect(outbounds.length).to.equal(2);
        expect(outbounds.map((o) => o.type)).to.have.members(["shadowsocks", "trojan"]);
    });

    it("fromNodes accepts mihomo node objects (incl wireguard -> endpoints)", function () {
        const nodes = [
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
            { name: "w1", type: "wireguard", server: "203.0.113.1", port: 51820, ip: "10.0.0.2", "private-key": "k", "public-key": "p" },
        ];
        const parsed = fromNodes(nodes);
        expect(parsed.outbounds.length).to.equal(1);
        expect(parsed.endpoints.length).to.equal(1);
    });

    it("assembles a complete client skeleton around produced outbounds (default)", function () {
        const parsed = fromNodes([
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        ]);
        const config = assemble(parsed);
        // client profile: tun + dashboard + CN-direct plumbing
        expect(config.log).to.deep.equal({ level: "info", timestamp: true });
        expect(config.inbounds.map((i) => i.type)).to.include("tun");
        expect(config.http_clients).to.deep.equal([
            { tag: "default-client", detour: "direct" },
        ]);
        expect(config.experimental.clash_api).to.deep.equal({
            default_mode: "Enhanced",
        });
        expect(config.dns.final).to.equal("google");
        expect(config.dns.servers.find((s) => s.tag === "google").server).to.equal("8.8.8.8");
        expect(config.dns.servers.find((s) => s.tag === "local").server).to.equal("223.5.5.5");
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("proxy");
        expect(tags).to.include("auto");
        expect(tags).to.include("direct");
        expect(tags).to.include("block");
        // the legacy special `dns` outbound was removed in sing-box 1.13.0
        expect(tags).to.not.include("dns-out");
        const selector = config.outbounds.find((o) => o.type === "selector");
        expect(selector.outbounds).to.include("s1");
        expect(config.route.final).to.equal("proxy");
        expect(config.route.default_http_client).to.equal("default-client");
        expect(config.route.rule_set.length).to.equal(2);
        expect(config.route.rules.some((r) => r.action === "hijack-dns")).to.equal(true);
        expect(config.endpoints).to.equal(undefined);
    });

    it("emits a minimal proxy profile when mode is 'proxy'", function () {
        const parsed = fromNodes([
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        ]);
        const config = assemble(parsed, { mode: "proxy" });
        expect(config.inbounds[0].type).to.equal("mixed");
        expect(config.http_clients).to.equal(undefined);
        expect(config.experimental).to.equal(undefined);
        expect(config.route.default_http_client).to.equal(undefined);
        expect(config.route.rule_set).to.equal(undefined);
        expect(config.dns.final).to.equal("remote");
    });

    it("rejects legacy dns options that cannot be auto-migrated", function () {
        const parsed = fromNodes([
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        ]);
        expect(() => assemble(parsed, {
            dns: {
                servers: [{ tag: "remote", address: "https://dns.example.com/dns-query", detour: "proxy" }],
                rules: [{ domain_suffix: "cn", strategy: "ipv4_only", server: "remote" }],
                final: "remote",
            },
        })).to.throw(CompatError);
    });

    it("merges provided route rules ahead of built-in defaults", function () {
        const parsed = fromNodes([
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        ]);
        const config = assemble(parsed, {
            rules: [
                { type: "DOMAIN-SUFFIX", content: "doubleclick.net", outbound: "block" },
            ],
        });
        expect(config.route.rules[0]).to.deep.equal({
            domain_suffix: "doubleclick.net", outbound: "block",
        });
        // user rules are prepended ahead of the client skeleton's built-ins
        const sniff = config.route.rules.findIndex((r) => r.action === "sniff");
        expect(sniff).to.be.greaterThan(0);
        expect(
            config.route.rules.some(
                (r) => r.ip_is_private === true && r.outbound === "direct",
            ),
        ).to.equal(true);
    });
});

describe("sing-box rule serializer", function () {
    it("maps internal rule types to sing-box matchers", function () {
        expect(toSingboxRule({ type: "DOMAIN-SUFFIX", content: "x.com" })).to.deep.equal({
            domain_suffix: "x.com", outbound: "proxy",
        });
        expect(toSingboxRule({ type: "IP-CIDR", content: "1.2.3.0/24" }, "direct")).to.deep.equal({
            ip_cidr: "1.2.3.0/24", outbound: "direct",
        });
        expect(toSingboxRule({ type: "GEOSITE", content: "category-ads-all" }, "block")).to.deep.equal({
            geosite: "category-ads-all", outbound: "block",
        });
        const rules = toSingboxRules([
            { type: "DOMAIN", content: "a.com" },
            { type: "DOMAIN-KEYWORD", content: "ads" },
        ], "proxy");
        expect(rules.length).to.equal(2);
    });

    it("rejects unsupported rule types with a clear error", function () {
        expect(() => toSingboxRule({ type: "URL-REGEX", content: "x" })).to.throw(
            /unsupported route rule type: URL-REGEX/,
        );
    });
});
