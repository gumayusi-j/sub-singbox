import { expect } from "chai";
import { ProxyUtils } from "@/core/proxy-utils";
import { fromText, fromNodes } from "@/kit/convert";
import assemble from "@/kit/assemble";
import {
    toSingboxRule,
    toSingboxRules,
    foldSingboxRules,
} from "@/kit/rules/singbox";
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

    const oneSS = function () {
        return [
            {
                name: "s1", type: "ss", server: "1.2.3.4", port: 8388,
                cipher: "aes-128-gcm", password: "x",
            },
        ];
    };

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
            { tag: "default-client", domain_resolver: "local" },
        ]);
        expect(config.experimental.clash_api).to.deep.equal({
            default_mode: "规则判定",
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

    it("ignores a mode, keeping the one profile", function () {
        const parsed = fromNodes([
            { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        ]);
        // The kit used to grow a minimal local mixed proxy under this option.
        // Tower has one shape, so the option is inert rather than absent - a
        // caller still passing it must not get a config that cannot route.
        const config = assemble(parsed, { mode: "proxy" });
        expect(config.inbounds.map((i) => i.type)).to.deep.equal(["tun"]);
        expect(config.http_clients).to.be.an("array");
        expect(config.experimental.clash_api.default_mode).to.equal("规则判定");
        expect(config.route.rule_set).to.be.an("array");
        expect(config.dns.final).to.equal("google");
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

    it("hardens client DNS/route defaults (reverse_mapping + logical hijack + DoT SNI)", function () {
        const config = assemble(fromNodes(oneSS()));
        // DNS answers keep their original domain so IP-only TUN connections
        // can still match domain rules; the DoT remote over a bare IP needs
        // an explicit TLS server_name.
        expect(config.dns.reverse_mapping).to.equal(true);
        const google = config.dns.servers.find((s) => s.tag === "google");
        expect(google.tls).to.deep.equal({ enabled: true, server_name: "dns.google" });
        // DNS hijack is a logical OR of protocol=dns and classic port 53,
        // and runs after sniffing.
        const hijack = config.route.rules.find((r) => r.action === "hijack-dns");
        expect(hijack.type).to.equal("logical");
        expect(hijack.rules).to.deep.include({ protocol: "dns" });
        expect(hijack.rules).to.deep.include({ port: 53 });
        const sniffIdx = config.route.rules.findIndex((r) => r.action === "sniff");
        const hijackIdx = config.route.rules.findIndex((r) => r.action === "hijack-dns");
        expect(sniffIdx).to.be.greaterThan(-1);
        expect(hijackIdx).to.be.greaterThan(sniffIdx);
    });

    it("assembles an empty subscription into a bootable direct config", function () {
        const config = assemble({ outbounds: [], endpoints: [] });
        expect(config.route.final).to.equal("direct");
        expect(config.dns.final).to.equal("local");
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("direct");
        expect(tags).to.not.include("proxy");
        expect(config.route.rule_set).to.equal(undefined);
    });

    it("configures the urltest group and allows dropping it", function () {
        const withAuto = assemble(fromNodes(oneSS()));
        const auto = withAuto.outbounds.find((o) => o.type === "urltest");
        expect(auto).to.be.an("object");
        expect(auto.url).to.equal("https://www.gstatic.com/generate_204");
        expect(auto.interval).to.equal("300s");
        expect(auto.tolerance).to.equal(50);
        const noAuto = assemble(fromNodes(oneSS()), { addAutoGroup: false });
        expect(noAuto.outbounds.some((o) => o.type === "urltest")).to.equal(false);
        const selector = noAuto.outbounds.find((o) => o.type === "selector");
        expect(selector.outbounds).to.include("s1");
    });

    it("maps provided 'reject' rules to a route action", function () {
        const config = assemble(fromNodes(oneSS()), {
            rules: [{ type: "DOMAIN-SUFFIX", content: "ads.io", outbound: "reject" }],
        });
        expect(config.route.rules[0]).to.deep.equal({
            domain_suffix: "ads.io",
            action: "reject",
        });
    });

    it("folds same-target provided rules when foldRules is set", function () {
        const config = assemble(fromNodes(oneSS()), {
            rules: [
                { type: "DOMAIN-SUFFIX", content: "a.io" },
                { type: "DOMAIN-SUFFIX", content: "b.io" },
            ],
            foldRules: true,
        });
        expect(config.route.rules[0]).to.deep.equal({
            domain_suffix: ["a.io", "b.io"],
            outbound: "proxy",
        });
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

    it("maps an outbound of 'reject' to the route action; 'block' stays an outbound", function () {
        expect(toSingboxRule({ type: "DOMAIN-SUFFIX", content: "ads.com" }, "reject")).to.deep.equal({
            domain_suffix: "ads.com",
            action: "reject",
        });
        expect(toSingboxRule({ type: "DOMAIN-SUFFIX", content: "ads.com" }, "REJECT")).to.deep.equal({
            domain_suffix: "ads.com",
            action: "reject",
        });
        expect(toSingboxRule({ type: "GEOSITE", content: "category-ads-all" }, "block")).to.deep.equal({
            geosite: "category-ads-all",
            outbound: "block",
        });
    });

    it("folds adjacent same-target rules into array matcher fields", function () {
        const folded = foldSingboxRules([
            { domain_suffix: "a.com", outbound: "proxy" },
            { domain_suffix: "b.com", outbound: "proxy" },
            { domain: "c.org", outbound: "proxy" },
            { domain_suffix: "d.net", outbound: "direct" },
            { domain_suffix: "e.io", action: "reject" },
            { domain_keyword: "ad", action: "reject" },
        ]);
        expect(folded).to.deep.equal([
            { domain_suffix: ["a.com", "b.com"], domain: "c.org", outbound: "proxy" },
            { domain_suffix: "d.net", outbound: "direct" },
            { domain_suffix: "e.io", domain_keyword: "ad", action: "reject" },
        ]);
    });

    it("keeps array-valued and non-adjacent rules untouched by folding", function () {
        const folded = foldSingboxRules([
            { domain_suffix: "a.com", outbound: "proxy" },
            { domain_suffix: "b.com", outbound: "direct" },
            { domain_suffix: "c.com", outbound: "proxy" },
            { domain_suffix: ["d.com", "e.com"], outbound: "proxy" },
        ]);
        expect(folded).to.deep.equal([
            { domain_suffix: "a.com", outbound: "proxy" },
            { domain_suffix: "b.com", outbound: "direct" },
            { domain_suffix: "c.com", outbound: "proxy" },
            { domain_suffix: ["d.com", "e.com"], outbound: "proxy" },
        ]);
    });
});

describe("sing-box generator — Clash mode switching", function () {
    const NODES = [
        { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
        { name: "s2", type: "ss", server: "5.6.7.8", port: 8388, cipher: "aes-128-gcm", password: "y" },
    ];

    function clientConfig(options) {
        return assemble(fromNodes(NODES), options);
    }

    it("puts a global selector first, defaulting to the automatic group", function () {
        const config = clientConfig();
        const first = config.outbounds[0];
        expect(first.tag).to.equal("全局代理");
        expect(first.type).to.equal("selector");
        expect(first.default).to.equal("auto");
        expect(first.outbounds[0]).to.equal("auto");
        expect(first.outbounds).to.include.members(["s1", "s2"]);
        // Switching mode must not leave connections on the old route.
        expect(first.interrupt_exist_connections).to.equal(true);
    });

    it("branches the route rules on global and direct mode", function () {
        const config = clientConfig();
        const global = config.route.rules.find((r) => r.clash_mode === "全局代理");
        const direct = config.route.rules.find((r) => r.clash_mode === "直接连接");
        expect(global).to.deep.equal({
            clash_mode: "全局代理",
            action: "route",
            outbound: "全局代理",
        });
        expect(direct).to.deep.equal({
            clash_mode: "直接连接",
            action: "route",
            outbound: "direct",
        });
        // Resolve through the DNS module, not the bootstrap resolver.
        const resolve = config.route.rules.findIndex((r) => r.action === "resolve");
        expect(resolve).to.be.above(-1);
        expect(resolve).to.be.below(config.route.rules.indexOf(global));
        // Rule mode is the fallthrough, so it needs no branch of its own.
        expect(config.route.rules.some((r) => r.clash_mode === "规则判定")).to.equal(false);
        expect(config.route.final).to.equal("proxy");
    });

    it("places the mode branches behind the private-IP rule but ahead of the CN rules", function () {
        const config = clientConfig();
        const rules = config.route.rules;
        const privateIndex = rules.findIndex((r) => r.ip_is_private !== undefined);
        const globalIndex = rules.findIndex((r) => r.clash_mode === "全局代理");
        const cnIndex = rules.findIndex((r) => r.rule_set === "geosite-geolocation-cn");
        // Global mode must not cut off the LAN...
        expect(globalIndex).to.be.above(privateIndex);
        // ...but must override the China-direct destination rules.
        expect(globalIndex).to.be.below(cnIndex);
    });

    it("branches the DNS rules and clones the remote resolver per mode", function () {
        const config = clientConfig();
        const modeDns = config.dns.rules.filter((r) => r.clash_mode);
        expect(modeDns).to.have.length(2);
        expect(modeDns[0]).to.deep.equal({
            clash_mode: "直接连接",
            action: "route",
            server: "local",
        });

        const globalDnsRule = modeDns[1];
        expect(globalDnsRule.clash_mode).to.equal("全局代理");

        const cloned = config.dns.servers.find((s) => s.tag === globalDnsRule.server);
        expect(cloned).to.be.an("object");
        // The clone keeps the transport settings but follows the mode.
        expect(cloned.detour).to.equal("全局代理");
        const original = config.dns.servers.find((s) => s.tag === "google");
        expect(cloned.type).to.equal(original.type);
        expect(cloned.server).to.equal(original.server);
    });

    it("keeps default_mode in step with the branches", function () {
        expect(clientConfig().experimental.clash_api.default_mode).to.equal("规则判定");
    });

    it("can be switched off", function () {
        const off = clientConfig({ clashModes: false });
        expect(off.outbounds.some((o) => o.tag === "全局代理")).to.equal(false);
        expect(off.route.rules.some((r) => r.clash_mode)).to.equal(false);
    });

    it("leaves a caller-supplied dns or route document alone", function () {
        const custom = {
            servers: [{ type: "local", tag: "local" }],
            rules: [],
            final: "local",
        };
        const config = clientConfig({ dns: custom });
        expect(config.dns.rules).to.deep.equal([]);
        expect(config.route.rules.some((r) => r.clash_mode)).to.equal(false);
    });

    it("applies to the ACL4SSR builder too", function () {
        const { assembleAcl } = require("@/kit/acl4ssr/build");
        const config = assembleAcl(fromNodes(NODES), { aclPreset: "acl4ssr-mini" });
        expect(config.outbounds[0].tag).to.equal("全局代理");
        expect(config.route.rules.some((r) => r.clash_mode === "全局代理")).to.equal(true);
        expect(config.experimental.clash_api.default_mode).to.equal("规则判定");
    });
});

describe("sing-box generator — hardening from Tower's generator", function () {
    const NODES = [
        { name: "s1", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
    ];

    function clientConfig(options) {
        return assemble(fromNodes(NODES), options);
    }

    it("pins the rule-set downloader's resolver without detouring to direct", function () {
        const config = clientConfig();
        // No detour: the download is direct either way, and naming the bare
        // direct outbound is what sing-box refuses to start on.
        expect(config.http_clients).to.deep.equal([
            { tag: "default-client", domain_resolver: "local" },
        ]);
        expect(config.route.default_http_client).to.equal("default-client");

        // Guard the shape that broke a real deployment, not just the literal
        // object above: every client's detour must resolve to a real outbound
        // that is not an empty direct one.
        const tags = new Set(config.outbounds.map((o) => o.tag));
        for (const client of config.http_clients) {
            if (client.detour === undefined) continue;
            expect(tags.has(client.detour), "dangling detour " + client.detour).to.equal(true);
            const target = config.outbounds.find((o) => o.tag === client.detour);
            expect(target.type, "detour to a bare direct " + client.detour).to.not.equal("direct");
        }
    });

    it("breaks the resolution loop for a remote resolver addressed by a hostname", function () {
        const config = clientConfig({ remoteDns: "https://dns.google/dns-query" });
        const remote = config.dns.servers.find((s) => s.tag === "google");
        expect(remote.server).to.equal("dns.google");
        expect(remote.domain_resolver).to.equal("local");
    });

    it("does not add a bootstrap resolver to a literal-IP resolver", function () {
        const config = clientConfig({ remoteDns: "tls://9.9.9.9" });
        const remote = config.dns.servers.find((s) => s.tag === "google");
        expect(remote.server).to.equal("9.9.9.9");
        expect(remote.domain_resolver).to.equal(undefined);
    });

    it("fixes the tun stack rather than trusting the core default", function () {
        const tun = clientConfig().inbounds.find((i) => i.type === "tun");
        expect(tun.stack).to.equal("mixed");
    });

    it("turns the fakeip cache off, since the profile resolves real names", function () {
        expect(clientConfig().experimental.cache_file).to.deep.equal({
            enabled: true,
            store_dns: true,
            store_fakeip: false,
        });
    });

    it("keeps ipv4_only by default and allows another strategy", function () {
        expect(clientConfig().dns.strategy).to.equal("ipv4_only");
        expect(clientConfig({ dnsStrategy: "prefer_ipv4" }).dns.strategy).to.equal(
            "prefer_ipv4",
        );
    });

    it("drops PROCESS-NAME unless it is asked for", function () {
        const rules = ["PROCESS-NAME,curl,proxy", "DOMAIN-SUFFIX,example.com,direct"];
        const dropped = clientConfig({ rules });
        expect(dropped.route.rules.some((r) => r.process_name !== undefined)).to.equal(false);
        expect(dropped.route.rules.some((r) => r.domain_suffix === "example.com")).to.equal(
            true,
        );

        const kept = clientConfig({ rules, allowProcessName: true });
        expect(kept.route.rules.some((r) => r.process_name === "curl")).to.equal(true);
    });

    it("drops PROCESS-NAME from an ACL4SSR preset list too", function () {
        const { assembleAcl } = require("@/kit/acl4ssr/build");
        const config = assembleAcl(fromNodes(NODES), { aclPreset: "acl4ssr-mini" });
        const all = JSON.stringify(config.route.rules);
        expect(all).to.not.contain("process_name");
    });

    it("emits no dashboard when there is no proxy to switch between", function () {
        const config = assemble({ outbounds: [], endpoints: [] });
        expect(config.experimental.clash_api).to.equal(undefined);
        expect(config.outbounds).to.deep.equal([{ type: "direct", tag: "direct" }]);
    });
});
