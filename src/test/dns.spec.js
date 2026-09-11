import { expect } from "chai";
import { onlyLeaves, defaultsToDirect, projectDnsRules } from "@/kit/dns-policy";
import assemble from "@/kit/assemble";
import { assembleAcl } from "@/kit/acl4ssr/build";
import { fromNodes } from "@/kit/convert";
import { IPV6_TUN_ADDRESS } from "@/kit/defaults";

const NODES = [
    { name: "香港 01", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-128-gcm", password: "x" },
    { name: "日本 01", type: "ss", server: "5.6.7.8", port: 8388, cipher: "aes-128-gcm", password: "y" },
];

describe("kit/dns-policy", function () {
    describe("onlyLeaves", function () {
        const config = [
            { type: "direct", tag: "direct" },
            { type: "ss", tag: "node" },
            { type: "selector", tag: "纯节点", outbounds: ["node"] },
            { type: "selector", tag: "可能直连", outbounds: ["node", "direct"] },
            { type: "urltest", tag: "自动", outbounds: ["node"] },
        ];

        it("accepts a tag that is itself allowed", function () {
            expect(onlyLeaves("direct", ["direct"], config)).to.equal(true);
        });

        it("accepts a group whose every path is a node", function () {
            expect(onlyLeaves("纯节点", ["node"], config)).to.equal(true);
            expect(onlyLeaves("自动", ["node"], config)).to.equal(true);
        });

        it("refuses a group that could resolve outside the allowed set", function () {
            expect(onlyLeaves("可能直连", ["node"], config)).to.equal(false);
        });

        it("refuses a tag it cannot reach", function () {
            expect(onlyLeaves("不存在", ["node"], config)).to.equal(false);
            // A system outbound is not a proxy path.
            expect(onlyLeaves("direct", ["node"], config)).to.equal(false);
        });

        it("survives a cycle", function () {
            const cyclic = [
                { type: "selector", tag: "a", outbounds: ["b"] },
                { type: "selector", tag: "b", outbounds: ["a"] },
            ];
            expect(onlyLeaves("a", ["node"], cyclic)).to.equal(false);
        });
    });

    describe("defaultsToDirect", function () {
        it("follows a selector's declared default", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "ss", tag: "node" },
                { type: "selector", tag: "本地", outbounds: ["direct", "node"], default: "direct" },
            ];
            expect(defaultsToDirect("本地", config)).to.equal(true);
        });

        it("falls back to the first member when no default is declared", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "ss", tag: "node" },
                { type: "selector", tag: "本地", outbounds: ["direct", "node"] },
            ];
            expect(defaultsToDirect("本地", config)).to.equal(true);
        });

        it("follows a nested selector", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "ss", tag: "node" },
                { type: "selector", tag: "内层", outbounds: ["node", "direct"], default: "direct" },
                { type: "selector", tag: "外层", outbounds: ["内层"] },
            ];
            expect(defaultsToDirect("外层", config)).to.equal(true);
        });

        it("says no when the default is not a member", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "ss", tag: "node" },
                { type: "selector", tag: "g", outbounds: ["node"], default: "direct" },
            ];
            expect(defaultsToDirect("g", config)).to.equal(false);
        });

        it("refuses a default that reaches a node, not direct", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "ss", tag: "node" },
                { type: "selector", tag: "代理", outbounds: ["direct", "node"], default: "node" },
            ];
            expect(defaultsToDirect("代理", config)).to.equal(false);
        });

        it("falls back to the conservative test for a non-selector group", function () {
            const config = [
                { type: "direct", tag: "direct" },
                { type: "urltest", tag: "自动", outbounds: ["direct"] },
            ];
            // A urltest has no fixed selection, so only an all-direct group counts.
            expect(defaultsToDirect("自动", config)).to.equal(true);
        });

        it("refuses an unknown tag and a cycle", function () {
            expect(defaultsToDirect("不存在", [])).to.equal(false);
            const cyclic = [
                { type: "selector", tag: "a", outbounds: ["b"], default: "b" },
                { type: "selector", tag: "b", outbounds: ["a"], default: "a" },
            ];
            expect(defaultsToDirect("a", cyclic)).to.equal(false);
        });
    });

    describe("projectDnsRules", function () {
        const config = [
            { type: "direct", tag: "direct" },
            { type: "ss", tag: "node" },
            { type: "selector", tag: "本地", outbounds: ["direct", "node"], default: "direct" },
            { type: "selector", tag: "代理", outbounds: ["node"] },
        ];

        it("routes a direct-routed domain to the local resolver", function () {
            const rules = projectDnsRules(
                [{ domain_suffix: "qq.com", outbound: "本地" }],
                config,
                {},
            );
            expect(rules).to.deep.equal([
                { action: "route", server: "local", domain_suffix: "qq.com" },
            ]);
        });

        it("leaves a proxied domain alone", function () {
            expect(
                projectDnsRules([{ domain_suffix: "google.com", outbound: "代理" }], config, {}),
            ).to.deep.equal([]);
        });

        it("projects a reject as a reject", function () {
            expect(
                projectDnsRules([{ domain_keyword: "ads", action: "reject" }], config, {}),
            ).to.deep.equal([{ action: "reject", domain_keyword: "ads" }]);
        });

        it("ignores a rule with no domain matcher", function () {
            // An address or port matcher has no meaning to a resolver.
            expect(
                projectDnsRules([{ ip_cidr: "10.0.0.0/8", outbound: "本地" }], config, {}),
            ).to.deep.equal([]);
            expect(projectDnsRules([{ port: 443, outbound: "本地" }], config, {})).to.deep.equal([]);
            expect(
                projectDnsRules([{ ip_is_private: true, outbound: "direct" }], config, {}),
            ).to.deep.equal([]);
        });

        it("skips a logical rule", function () {
            // The domains inside an AND are not the set of names the query is
            // answered under, so projecting one would widen it.
            const logical = {
                type: "logical",
                mode: "and",
                rules: [{ domain_suffix: ["a.com"] }, { network: ["udp"] }],
                outbound: "本地",
            };
            expect(projectDnsRules([logical], config, {})).to.deep.equal([]);
        });

        it("keeps the route list's order", function () {
            const rules = projectDnsRules(
                [
                    { domain_suffix: "a.com", outbound: "本地" },
                    { domain: "b.com", outbound: "代理" },
                    { domain_suffix: "c.com", outbound: "本地" },
                ],
                config,
                {},
            );
            expect(rules.map((r) => r.domain_suffix || r.domain)).to.deep.equal(["a.com", "c.com"]);
        });
    });

    // The point of all of it: a domestic domain that routes direct must not be
    // resolved by the proxy's resolver.
    describe("assembled configs", function () {
        it("resolves the preset's direct domains locally", function () {
            const config = assembleAcl(fromNodes(NODES), { aclPreset: "acl4ssr-default" });
            const local = config.dns.rules.filter((rule) => rule.server === "local");
            expect(local.length).to.be.greaterThan(0);
            const suffixes = local.reduce(
                (sum, rule) =>
                    sum + (Array.isArray(rule.domain_suffix) ? rule.domain_suffix.length : 0),
                0,
            );
            // ACL4SSR_ChinaDomain alone is hundreds of entries.
            expect(suffixes).to.be.greaterThan(100);
            expect(
                local.some(
                    (rule) => rule.domain_suffix && rule.domain_suffix.indexOf("qq.com") !== -1,
                ),
            ).to.equal(true);
        });

        it("keeps the clash-mode DNS branches ahead of the projection", function () {
            const config = assembleAcl(fromNodes(NODES), { aclPreset: "acl4ssr-default" });
            const modes = config.dns.rules.filter((rule) => rule.clash_mode !== undefined);
            expect(modes.length).to.be.greaterThan(0);
            const firstProjected = config.dns.rules.findIndex(
                (rule) => rule.clash_mode === undefined,
            );
            expect(firstProjected).to.equal(modes.length);
        });

        it("leaves the fallthrough on the proxy for a preset that ends on one", function () {
            const config = assembleAcl(fromNodes(NODES), { aclPreset: "acl4ssr-default" });
            // 漏网之鱼 ships selecting 节点选择, so the rest of the world is
            // still resolved through the proxy.
            expect(config.route.final).to.equal("🐟 漏网之鱼");
            expect(config.dns.final).to.equal("remote");
        });

        it("does not touch a caller-supplied dns document", function () {
            const dns = { servers: [{ type: "local", tag: "local" }], rules: [], final: "local" };
            const config = assemble(fromNodes(NODES), { dns });
            expect(config.dns).to.equal(dns);
        });
    });

    describe("IPv6", function () {
        function tunAddress(config) {
            const tun = config.inbounds.find((inbound) => inbound.type === "tun");
            return tun.address;
        }

        it("defaults to IPv4-only, unchanged from before", function () {
            for (const options of [{}, { ipv6Enabled: false }]) {
                const config = assemble(fromNodes(NODES), options);
                expect(config.dns.strategy).to.equal("ipv4_only");
                expect(tunAddress(config)).to.deep.equal(["172.19.0.1/30"]);
            }
        });

        it("turns on a dual-stack tunnel and prefer_ipv4 when asked", function () {
            const config = assemble(fromNodes(NODES), { ipv6Enabled: true });
            // prefer_ipv4 rather than ipv6_only: v6 stays reachable on the
            // networks that carry it, and v4 is still tried first.
            expect(config.dns.strategy).to.equal("prefer_ipv4");
            expect(tunAddress(config)).to.deep.equal(["172.19.0.1/30", IPV6_TUN_ADDRESS]);
        });

        it("carries the switch into the ACL path too", function () {
            const config = assembleAcl(fromNodes(NODES), {
                aclPreset: "acl4ssr-mini",
                ipv6Enabled: true,
            });
            expect(config.dns.strategy).to.equal("prefer_ipv4");
            expect(tunAddress(config)).to.deep.equal(["172.19.0.1/30", IPV6_TUN_ADDRESS]);
        });

        it("still lets an explicit strategy win", function () {
            const config = assemble(fromNodes(NODES), {
                ipv6Enabled: true,
                dnsStrategy: "ipv6_only",
            });
            expect(config.dns.strategy).to.equal("ipv6_only");
        });
    });
});
