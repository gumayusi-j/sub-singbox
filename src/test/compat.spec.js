import { expect } from "chai";
import { fromNodes } from "@/kit/convert";
import assemble from "@/kit/assemble";
import {
    analyzeConfig,
    migrateConfig,
    CompatError,
    assertCompatible,
} from "@/kit/compat";

const SS_NODE = {
    name: "s1",
    type: "ss",
    server: "1.2.3.4",
    port: 8388,
    cipher: "aes-128-gcm",
    password: "x",
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// A syntactically ordinary, fully legal 1.16-style config.
function baseConfig(overrides) {
    const config = {
        log: { level: "info" },
        dns: {
            servers: [
                { type: "https", tag: "remote", server: "dns.example.com", server_port: 443, detour: "proxy" },
            ],
            rules: [],
            final: "remote",
        },
        inbounds: [
            { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 1080 },
        ],
        outbounds: [
            { type: "direct", tag: "direct" },
            { type: "selector", tag: "proxy", outbounds: ["direct"] },
        ],
        route: { auto_detect_interface: true, rules: [], final: "proxy" },
    };
    if (overrides) Object.assign(config, overrides);
    return config;
}

const REMOTE_SET = (downloadDetour) => ({
    type: "remote",
    url: "https://example.com/geo.dat",
    ...(downloadDetour ? { download_detour: downloadDetour } : {}),
});

describe("compat layer", function () {
    it("reports nothing for a default assemble() output", function () {
        const config = assemble(fromNodes([SS_NODE]));
        const report = analyzeConfig(config);
        expect(report.errors).to.deep.equal([]);
        expect(report.warnings).to.deep.equal([]);
        // the client profile ships explicit http_clients/default_http_client so
        // the remote rule-sets do not need auto-migration. domain_resolver is
        // pinned to the plain resolver so a rule-set hostname resolves before
        // anything is dialled; there is deliberately no detour, which sing-box
        // rejects when it points at an empty direct outbound.
        expect(config.http_clients).to.deep.equal([
            { tag: "default-client", domain_resolver: "local" },
        ]);
        expect(config.certificate_providers).to.equal(undefined);
        expect(config.route.default_http_client).to.equal("default-client");
    });

    it("keeps the same reference when there is nothing to migrate", function () {
        const config = assemble(fromNodes([SS_NODE]));
        const result = migrateConfig(config);
        expect(result.config).to.equal(config);
        expect(result.warnings).to.deep.equal([]);
    });

    it("does not mutate the caller's object when auto-migrating", function () {
        const cfg = baseConfig({
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("direct")],
            },
        });
        const before = clone(cfg);
        const result = migrateConfig(cfg);
        expect(result.config).to.not.equal(cfg);
        expect(cfg).to.deep.equal(before);
    });

    it("rewrites download_detour into shared http_clients (R1a)", function () {
        const cfg = baseConfig({
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [
                    REMOTE_SET("direct"),
                    REMOTE_SET("proxy"),
                    REMOTE_SET("proxy"),
                ],
            },
        });
        const { config, warnings } = migrateConfig(cfg);
        expect(warnings.some((w) => w.code === "rule_set_download_detour")).to.equal(true);
        expect(config.http_clients).to.be.an("array");
        const viaProxy = config.http_clients.find((c) => c.detour === "proxy");
        expect(viaProxy).to.be.an("object");
        // "direct" here resolves to baseConfig's bare direct outbound. A
        // detour to that is what sing-box refuses to start on, so the entry
        // gets no client of its own and falls back to the default one.
        expect(config.http_clients.some((c) => c.detour === "direct")).to.equal(false);

        const byTag = {};
        for (const e of config.route.rule_set) {
            if (e.http_client !== undefined) {
                byTag[e.http_client] = (byTag[e.http_client] || 0) + 1;
            }
            expect(e.download_detour).to.equal(undefined);
        }
        // only the two "proxy" entries got a client, and they share it
        expect(Object.keys(byTag)).to.deep.equal([viaProxy.tag]);
        expect(byTag[viaProxy.tag]).to.equal(2);
        expect(config.route.default_http_client).to.equal(config.http_clients[0].tag);
    });

    it("drops a download_detour that would detour to an empty direct outbound", function () {
        // The exact shape that stopped a real deployment from booting: a
        // legacy config routing its rule-set downloads through a direct
        // outbound that carries nothing but its tag.
        const cfg = baseConfig({
            outbounds: [
                { type: "direct", tag: "direct" },
                { type: "selector", tag: "proxy", outbounds: ["direct"] },
            ],
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("direct")],
            },
        });
        const { config } = migrateConfig(cfg);
        const entry = config.route.rule_set[0];
        expect(entry.download_detour).to.equal(undefined);
        expect(entry.http_client).to.equal(undefined);
        expect(config.http_clients.every((c) => c.detour !== "direct")).to.equal(true);

        // A direct outbound that does override something is a real hop and
        // still gets a client - the guard keys on "empty", not on "direct".
        const overridden = baseConfig({
            outbounds: [
                { type: "direct", tag: "direct", override_address: "1.2.3.4" },
                { type: "selector", tag: "proxy", outbounds: ["direct"] },
            ],
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("direct")],
            },
        });
        const kept = migrateConfig(overridden).config;
        expect(kept.route.rule_set[0].http_client).to.be.a("string");
        expect(kept.http_clients.some((c) => c.detour === "direct")).to.equal(true);
    });

    it("falls back to the default client when download_detour is gone (boundary)", function () {
        const cfg = baseConfig({
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("ghost-outbound")],
            },
        });
        const { config } = migrateConfig(cfg);
        const entry = config.route.rule_set[0];
        expect(entry.http_client).to.equal(undefined);
        expect(entry.download_detour).to.equal(undefined);
        // a default client is still injected so the remote fetch is explicit
        expect(config.route.default_http_client).to.be.a("string");
        expect(config.http_clients.some((c) => c.tag === config.route.default_http_client)).to.equal(true);
    });

    it("injects http_clients / default_http_client for remote rule-sets (R1b)", function () {
        // neither clients nor default
        const none = baseConfig({
            route: { auto_detect_interface: true, rules: [], final: "proxy", rule_set: [REMOTE_SET()] },
        });
        const migrated = migrateConfig(none).config;
        expect(migrated.http_clients).to.be.an("array");
        expect(migrated.route.default_http_client).to.be.a("string");
        expect(migrated.http_clients[0].detour).to.equal("proxy");

        // clients exist but no default -> default points at the first client
        const clientsOnly = baseConfig({
            http_clients: [{ tag: "hc", detour: "direct" }],
            route: { auto_detect_interface: true, rules: [], final: "proxy", rule_set: [REMOTE_SET()] },
        });
        const m2 = migrateConfig(clientsOnly).config;
        expect(m2.route.default_http_client).to.equal("hc");

        // default exists but no clients -> clients injected around it
        const defaultOnly = baseConfig({
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                default_http_client: "mych",
                rule_set: [REMOTE_SET()],
            },
        });
        const m3 = migrateConfig(defaultOnly).config;
        expect(m3.http_clients.some((c) => c.tag === "mych")).to.equal(true);
    });

    it("hoists inline tls.acme into shared certificate_providers (R2)", function () {
        const acme = { domain: ["example.com"], email: "a@example.com" };
        const makeInbound = (tag) => ({
            type: "trojan",
            tag,
            listen: "127.0.0.1",
            listen_port: 443,
            tls: { enabled: true, acme: clone(acme) },
        });
        const cfg = baseConfig({
            inbounds: [makeInbound("a"), makeInbound("b")],
        });
        const { config, warnings } = migrateConfig(cfg);
        expect(warnings.some((w) => w.code === "inbound_inline_acme")).to.equal(true);
        expect(config.certificate_providers).to.have.length(1);
        const tag = config.certificate_providers[0].tag;
        expect(config.certificate_providers[0].type).to.equal("acme");
        expect(config.inbounds[0].tls.certificate_provider).to.equal(tag);
        expect(config.inbounds[1].tls.certificate_provider).to.equal(tag);
        expect(config.inbounds[0].tls.acme).to.equal(undefined);
    });

    it("produces separate providers for different acme content and reuses existing ones", function () {
        const cfg = baseConfig({
            inbounds: [
                {
                    type: "trojan", tag: "a", listen: "127.0.0.1", listen_port: 443,
                    tls: { enabled: true, acme: { domain: ["a.example.com"], email: "a@example.com" } },
                },
                {
                    type: "trojan", tag: "b", listen: "127.0.0.1", listen_port: 443,
                    tls: { enabled: true, acme: { domain: ["b.example.com"], email: "b@example.com" } },
                },
                {
                    type: "trojan", tag: "c", listen: "127.0.0.1", listen_port: 443,
                    tls: { enabled: true, acme: { domain: ["a.example.com"], email: "a@example.com" } },
                },
            ],
        });
        const { config } = migrateConfig(cfg);
        expect(config.certificate_providers).to.have.length(2);
        const tagA = config.inbounds[0].tls.certificate_provider;
        const tagB = config.inbounds[1].tls.certificate_provider;
        expect(tagA).to.not.equal(tagB);
        expect(config.inbounds[2].tls.certificate_provider).to.equal(tagA);
    });

    it("reuses a pre-existing provider with identical content", function () {
        const cfg = baseConfig({
            certificate_providers: [
                { type: "acme", tag: "my-cert", domain: ["a.example.com"], email: "a@example.com" },
            ],
            inbounds: [
                {
                    type: "trojan", tag: "a", listen: "127.0.0.1", listen_port: 443,
                    tls: { enabled: true, acme: { domain: ["a.example.com"], email: "a@example.com" } },
                },
            ],
        });
        const { config } = migrateConfig(cfg);
        expect(config.certificate_providers).to.have.length(1);
        expect(config.inbounds[0].tls.certificate_provider).to.equal("my-cert");
    });

    it("drops rule_set_ip_cidr_accept_empty and independent_cache (R4/R5)", function () {
        const cfg = baseConfig({
            dns: {
                servers: [{ type: "local", tag: "local" }],
                independent_cache: true,
                rules: [
                    { domain_suffix: "cn", rule_set_ip_cidr_accept_empty: true, server: "local" },
                ],
                final: "remote",
            },
        });
        const { config } = migrateConfig(cfg);
        expect(config.dns.independent_cache).to.equal(undefined);
        expect(config.dns.rules[0].rule_set_ip_cidr_accept_empty).to.equal(undefined);
    });

    it("renames store_rdrc to store_dns, preserving an explicit store_dns (R6)", function () {
        const cfg = baseConfig({
            experimental: {
                cache_file: { enabled: true, store_rdrc: true },
            },
        });
        const { config } = migrateConfig(cfg);
        expect(config.experimental.cache_file.store_rdrc).to.equal(undefined);
        expect(config.experimental.cache_file.store_dns).to.equal(true);

        const conflict = baseConfig({
            experimental: {
                cache_file: { enabled: true, store_rdrc: false, store_dns: true },
            },
        });
        const m2 = migrateConfig(conflict).config;
        expect(m2.experimental.cache_file.store_rdrc).to.equal(undefined);
        expect(m2.experimental.cache_file.store_dns).to.equal(true);
    });

    it("errors on legacy address filtering in DNS rules and never mutates (R7)", function () {
        const cfg = baseConfig({
            dns: {
                servers: [{ type: "local", tag: "local" }],
                rules: [{ ip_is_private: true, server: "local" }],
                final: "remote",
            },
        });
        const result = migrateConfig(cfg);
        expect(result.errors.some((e) => e.code === "dns_rule_legacy_address_filter")).to.equal(true);
        expect(result.config).to.equal(cfg); // error-only path keeps the reference

        expect(() => assertCompatible(cfg)).to.throw(CompatError);
        try {
            assertCompatible(cfg);
        } catch (e) {
            expect(e).to.be.instanceof(CompatError);
            expect(e.message).to.include("dns.rules[0].ip_is_private");
            expect(e.message).to.include("fix:");
            expect(e.name).to.equal("CompatError");
        }
    });

    it("accepts match_response address matching and route-level ip_is_private (R7 scope)", function () {
        const legal = baseConfig({
            dns: {
                servers: [{ type: "local", tag: "local" }],
                rules: [{ ip_is_private: true, match_response: true, server: "local" }],
                final: "remote",
            },
        });
        expect(analyzeConfig(legal).errors).to.deep.equal([]);

        // route-level private address rule is a legitimate route matcher
        const routeOnly = baseConfig({
            route: { auto_detect_interface: true, rules: [{ ip_is_private: true, outbound: "direct" }], final: "proxy" },
        });
        expect(analyzeConfig(routeOnly).errors).to.deep.equal([]);
    });

    it("errors on legacy strategy on DNS rules, recursing into logical rules (R3)", function () {
        const cfg = baseConfig({
            dns: {
                servers: [{ type: "https", tag: "remote", server: "dns.example.com", server_port: 443, detour: "proxy" }],
                rules: [
                    { domain_suffix: "cn", strategy: "ipv4_only", server: "remote" },
                    {
                        type: "logical",
                        mode: "or",
                        rules: [{ domain_suffix: "ads.cn", strategy: "ipv6_only", server: "remote" }],
                    },
                ],
                final: "remote",
            },
        });
        const { errors } = migrateConfig(cfg);
        expect(errors.filter((e) => e.code === "dns_rule_strategy").length).to.equal(2);
        expect(errors[0].suggestion).to.include("dns.servers[*].strategy");
    });

    it("throws CompatError from assemble() for legacy dns options", function () {
        const parsed = fromNodes([SS_NODE]);
        const legacyDns = {
            servers: [{ tag: "remote", address: "https://dns.example.com/dns-query", detour: "proxy" }],
            rules: [{ domain_suffix: "cn", strategy: "ipv4_only", server: "remote" }],
            final: "remote",
        };
        try {
            assemble(parsed, { dns: legacyDns });
            expect.fail("expected CompatError");
        } catch (e) {
            expect(e).to.be.instanceof(CompatError);
            expect(e.name).to.equal("CompatError");
            expect(e.message).to.include("dns.rules[0].strategy");
            expect(e.message).to.include("fix:");
        }
    });

    it("reports auto-migrations through options.onWarning from assemble()", function () {
        const parsed = fromNodes([SS_NODE]);
        const warnings = [];
        const config = assemble(parsed, {
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("direct")],
            },
            onWarning: (ws) => {
                for (const w of ws) warnings.push(w);
            },
        });
        expect(warnings.length).to.be.greaterThan(0);
        expect(config.http_clients).to.be.an("array");
        expect(config.route.rule_set[0].download_detour).to.equal(undefined);
    });

    it("is deterministic across runs", function () {
        const input = baseConfig({
            route: {
                auto_detect_interface: true,
                rules: [],
                final: "proxy",
                rule_set: [REMOTE_SET("direct"), REMOTE_SET("proxy")],
            },
        });
        const a = migrateConfig(clone(input)).config;
        const b = migrateConfig(clone(input)).config;
        expect(a).to.deep.equal(b);
    });

    it("migrates legacy address-string DNS servers to the modern form (R8)", function () {
        const cfg = baseConfig({
            dns: {
                servers: [
                    { tag: "remote", address: "https://dns.example.com/dns-query", detour: "proxy" },
                    { tag: "local", address: "local" },
                ],
                rules: [],
                final: "remote",
            },
        });
        const { config, warnings } = migrateConfig(cfg);
        expect(warnings.some((w) => w.code === "dns_server_legacy_format")).to.equal(true);
        expect(config.dns.servers[0]).to.deep.equal({
            type: "https",
            tag: "remote",
            server: "dns.example.com",
            server_port: 443,
            detour: "proxy",
        });
        expect(config.dns.servers[1]).to.deep.equal({ type: "local", tag: "local" });
        expect(config.dns.servers[0].address).to.equal(undefined);
    });

    it("errors when a legacy DNS server address cannot be parsed (R8)", function () {
        const cfg = baseConfig({
            dns: {
                servers: [{ tag: "bad", address: "foo://1.1.1.1" }],
                rules: [],
                final: "remote",
            },
        });
        const { errors } = migrateConfig(cfg);
        expect(errors.some((e) => e.code === "dns_server_legacy_format")).to.equal(true);
    });

    it("default assemble() emits a modern client DNS skeleton and resolver", function () {
        const config = assemble(fromNodes([SS_NODE]));
        const google = config.dns.servers.find((s) => s.tag === "google");
        const local = config.dns.servers.find((s) => s.tag === "local");
        expect(google).to.deep.equal({
            type: "tls",
            tag: "google",
            server: "8.8.8.8",
            server_port: 853,
            detour: "proxy",
            tls: { enabled: true, server_name: "dns.google" },
        });
        expect(local).to.deep.equal({
            type: "udp",
            tag: "local",
            server: "223.5.5.5",
        });
        expect(config.dns.servers.some((s) => s.address !== undefined)).to.equal(false);
        expect(config.route.default_domain_resolver).to.deep.equal({ server: "local" });
        // The legacy special `dns` outbound was removed in sing-box 1.13.0, so
        // a default assembly must not emit one.
        expect(config.outbounds.some((o) => o.type === "dns")).to.equal(false);
        expect(config.outbounds.map((o) => o.tag)).to.not.include("dns-out");
    });

    it("reports an error for a legacy special `dns` outbound (R9)", function () {
        const cfg = baseConfig({
            outbounds: [
                { type: "direct", tag: "direct" },
                { type: "selector", tag: "proxy", outbounds: ["direct"] },
                { type: "dns", tag: "dns-out", address: "local" },
            ],
        });
        const { errors } = migrateConfig(cfg);
        expect(errors.some((e) => e.code === "dns_outbound_removed")).to.equal(true);
        expect(() =>
            assemble({
                outbounds: [{ type: "dns", tag: "dns-out", address: "local" }],
                endpoints: [],
            }),
        ).to.throw(CompatError);
    });
});
