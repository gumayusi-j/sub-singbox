/**
 * SS + ShadowTLS 节点的导入、保存与分享支持测试
 *
 * 对应 Tower 1.0.21 更新：
 *   - 新增 Shadowsocks + ShadowTLS 节点的导入（SIP003 URI 格式与转义处理）
 *   - 补充各客户端的 ShadowTLS 导出支持（Clash, Mihomo, Surge, Loon, Egern, Shadowrocket, Stash, sing-box, Karing）
 *   - 支持向 Shadowrocket、Hiddify 导出 ShadowTLS 仅节点订阅
 *   - 改进节点参数保留与兼容性检查，避免导出不完整配置
 *   - 辅助通道（ShadowTLS）不进入策略组
 */
import { expect } from "chai";
import { ProxyUtils } from "@/core/proxy-utils";
import Surge_Producer from "@/core/proxy-utils/producers/surge";
import Loon_Producer from "@/core/proxy-utils/producers/loon";
import { fromNodes } from "@/kit/convert";
import assemble from "@/kit/assemble";
import { assembleAcl, findPreset } from "@/kit/acl4ssr/build";
import { renderSubscription } from "@/subscription/render";
import { TARGETS } from "@/subscription/targets";

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Base SS+ShadowTLS node in Clash/Mihomo YAML format
const SS_ST_NODE = {
    type: "ss",
    name: "ss-shadowtls",
    server: "1.2.3.4",
    port: 443,
    cipher: "aes-128-gcm",
    password: "sspassword",
    plugin: "shadow-tls",
    "plugin-opts": {
        host: "sni.example.com",
        password: "stpassword",
        version: 3,
    },
};

// ─── URI 解析测试 ────────────────────────────────────────────────────────────

describe("SS+ShadowTLS URI (SIP003) import", function () {
    function parseURI(uri) {
        const parsed = ProxyUtils.parse(`${uri}\n`);
        return parsed[0] ?? null;
    }

    it("parses a plain SIP003 shadow-tls URI", function () {
        const userinfo = Buffer.from("aes-128-gcm:sspass").toString("base64");
        const plugin = encodeURIComponent("shadow-tls;host=sni.example.com;password=stpass;version=3");
        const uri = `ss://${userinfo}@1.2.3.4:443?plugin=${plugin}#test-node`;
        const proxy = parseURI(uri);
        expect(proxy).to.not.equal(null);
        expect(proxy.plugin).to.equal("shadow-tls");
        expect(proxy["plugin-opts"].host).to.equal("sni.example.com");
        expect(proxy["plugin-opts"].password).to.equal("stpass");
        expect(proxy["plugin-opts"].version).to.equal(3);
    });

    it("handles backslash-escaped semicolons in SIP003 shadow-tls values", function () {
        const userinfo = Buffer.from("aes-128-gcm:sspass").toString("base64");
        const rawPlugin = "shadow-tls;host=sni.example.com;password=pass\\;word;version=3";
        const plugin = encodeURIComponent(rawPlugin);
        const uri = `ss://${userinfo}@1.2.3.4:443?plugin=${plugin}#test-node`;
        const proxy = parseURI(uri);
        expect(proxy).to.not.equal(null);
        expect(proxy.plugin).to.equal("shadow-tls");
        expect(proxy["plugin-opts"].password).to.equal("pass;word");
    });

    it("parses skip-cert-verify from SIP003 shadow-tls URI", function () {
        const userinfo = Buffer.from("aes-128-gcm:sspass").toString("base64");
        const plugin = encodeURIComponent("shadow-tls;host=sni.example.com;password=stpass;version=3;skip-cert-verify=true");
        const uri = `ss://${userinfo}@1.2.3.4:443?plugin=${plugin}#test-node`;
        const proxy = parseURI(uri);
        expect(proxy).to.not.equal(null);
        expect(proxy["plugin-opts"]["skip-cert-verify"]).to.equal(true);
    });

    it("parses backslash-escaped backslash in SIP003 values", function () {
        const userinfo = Buffer.from("aes-128-gcm:sspass").toString("base64");
        const rawPlugin = "shadow-tls;host=sni.example.com;password=pass\\\\word;version=3";
        const plugin = encodeURIComponent(rawPlugin);
        const uri = `ss://${userinfo}@1.2.3.4:443?plugin=${plugin}#test-node`;
        const proxy = parseURI(uri);
        expect(proxy).to.not.equal(null);
        expect(proxy["plugin-opts"].password).to.equal("pass\\word");
    });
});

// ─── URI 生成测试 ────────────────────────────────────────────────────────────

describe("SS+ShadowTLS URI (SIP003) export", function () {
    function produceURI(proxy) {
        return ProxyUtils.produce(clone([proxy]), "uri", "external");
    }

    it("generates a correctly escaped SIP003 shadow-tls URI", function () {
        const uri = produceURI(SS_ST_NODE);
        expect(uri).to.include("plugin=");
        expect(uri).to.include("shadow-tls");
        const pluginMatch = uri.match(/plugin=([^&\s#]+)/);
        expect(pluginMatch).to.not.equal(null);
        const rawPlugin = decodeURIComponent(pluginMatch[1]);
        expect(rawPlugin).to.include("shadow-tls;");
        expect(rawPlugin).to.include("host=sni.example.com");
        expect(rawPlugin).to.include("password=stpassword");
        expect(rawPlugin).to.include("version=3");
    });

    it("escapes semicolons in shadow-tls password in generated URI", function () {
        const proxy = clone(SS_ST_NODE);
        proxy["plugin-opts"].password = "pass;word";
        const uri = produceURI(proxy);
        const pluginMatch = uri.match(/plugin=([^&\s#]+)/);
        const rawPlugin = decodeURIComponent(pluginMatch[1]);
        expect(rawPlugin).to.include("password=pass\\;word");
    });

    it("escapes backslashes in shadow-tls host in generated URI", function () {
        const proxy = clone(SS_ST_NODE);
        proxy["plugin-opts"].host = "sni\\example.com";
        const uri = produceURI(proxy);
        const pluginMatch = uri.match(/plugin=([^&\s#]+)/);
        const rawPlugin = decodeURIComponent(pluginMatch[1]);
        expect(rawPlugin).to.include("host=sni\\\\example.com");
    });

    it("includes skip-cert-verify in generated URI when set", function () {
        const proxy = clone(SS_ST_NODE);
        proxy["plugin-opts"]["skip-cert-verify"] = true;
        const uri = produceURI(proxy);
        const pluginMatch = uri.match(/plugin=([^&\s#]+)/);
        const rawPlugin = decodeURIComponent(pluginMatch[1]);
        expect(rawPlugin).to.include("skip-cert-verify=true");
    });

    it("omits skip-cert-verify when not set", function () {
        const uri = produceURI(SS_ST_NODE);
        const pluginMatch = uri.match(/plugin=([^&\s#]+)/);
        const rawPlugin = decodeURIComponent(pluginMatch[1]);
        expect(rawPlugin).to.not.include("skip-cert-verify");
    });
});

// ─── 各平台兼容性过滤测试 ──────────────────────────────────────────────────

describe("SS+ShadowTLS platform compatibility", function () {
    // ── Clash (original, non-Meta) ──────────────────────────────────────────
    describe("Clash", function () {
        it("exports a valid SS+ShadowTLS v2 node", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].version = 2;
            const list = ProxyUtils.produce(clone([proxy]), "Clash", "internal");
            expect(list.length).to.equal(1);
        });

        it("exports a valid SS+ShadowTLS v3 node", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "Clash", "internal");
            expect(list.length).to.equal(1);
        });

        it("filters out SS+ShadowTLS v1 (not supported by original Clash)", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].version = 1;
            const list = ProxyUtils.produce(clone([proxy]), "Clash", "internal");
            expect(list.length).to.equal(0);
        });

        it("filters out SS+ShadowTLS with client-fingerprint", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["client-fingerprint"] = "chrome";
            const list = ProxyUtils.produce(clone([proxy]), "Clash", "internal");
            expect(list.length).to.equal(0);
        });
    });

    // ── Stash ────────────────────────────────────────────────────────────────
    describe("Stash", function () {
        it("exports a valid SS+ShadowTLS v2/v3 node", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].version = 2;
            const list = ProxyUtils.produce(clone([proxy]), "stash", "internal");
            expect(list.length).to.equal(1);
        });

        it("filters out SS+ShadowTLS v1 (Stash requires v2+)", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].version = 1;
            const list = ProxyUtils.produce(clone([proxy]), "stash", "internal");
            expect(list.length).to.equal(0);
        });
    });

    // ── Mihomo (ClashMeta) ──────────────────────────────────────────────────
    describe("Mihomo (ClashMeta)", function () {
        it("exports a valid SS+ShadowTLS v3 node", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "clash.meta", "internal");
            expect(list.length).to.equal(1);
        });

        it("filters out SS+ShadowTLS with skip-cert-verify (not supported)", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"]["skip-cert-verify"] = true;
            const list = ProxyUtils.produce(clone([proxy]), "clash.meta", "internal");
            expect(list.length).to.equal(0);
        });
    });

    // ── Karing ───────────────────────────────────────────────────────────────
    describe("Karing", function () {
        it("skips ShadowTLS completely for Karing (as revoked in Tower 1.0.21)", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "karing", "internal");
            expect(list.length).to.equal(0);
        });
    });

    // ── Shadowrocket ─────────────────────────────────────────────────────────
    describe("Shadowrocket", function () {
        it("exports a valid SS+ShadowTLS v3 node", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "shadowrocket", "internal");
            expect(list.length).to.equal(1);
        });

        it("filters out SS+ShadowTLS v2 (Shadowrocket requires v3)", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].version = 2;
            const list = ProxyUtils.produce(clone([proxy]), "shadowrocket", "internal");
            expect(list.length).to.equal(0);
        });

        it("filters out SS+ShadowTLS with skip-cert-verify", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"]["skip-cert-verify"] = true;
            const list = ProxyUtils.produce(clone([proxy]), "shadowrocket", "internal");
            expect(list.length).to.equal(0);
        });

        it("filters out SS+ShadowTLS with client-fingerprint", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["client-fingerprint"] = "chrome";
            const list = ProxyUtils.produce(clone([proxy]), "shadowrocket", "internal");
            expect(list.length).to.equal(0);
        });
    });

    // ── Surge ─────────────────────────────────────────────────────────────────
    describe("Surge", function () {
        it("exports a valid SS+ShadowTLS v3 node", function () {
            const output = ProxyUtils.produce(clone([SS_ST_NODE]), "surge", "external");
            expect(output).to.include('shadow-tls-password="stpassword"');
            expect(output).to.include("shadow-tls-sni=sni.example.com");
            expect(output).to.include("shadow-tls-version=3");
        });

        it("Surge_Producer throws for SS+ShadowTLS with skip-cert-verify", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"]["skip-cert-verify"] = true;
            expect(() => Surge_Producer().produce(proxy, "external")).to.throw(
                /skip-cert-verify is not supported/,
            );
            expect(ProxyUtils.produce(clone([proxy]), "surge", "external")).to.equal("");
        });

        it("Surge_Producer throws for SS+ShadowTLS with client-fingerprint", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["client-fingerprint"] = "chrome";
            expect(() => Surge_Producer().produce(proxy, "external")).to.throw(
                /client-fingerprint is not supported/,
            );
            expect(ProxyUtils.produce(clone([proxy]), "surge", "external")).to.equal("");
        });

        it("Surge_Producer throws for SS+ShadowTLS with 2022-blake3-chacha20-poly1305 cipher", function () {
            const proxy = clone(SS_ST_NODE);
            proxy.cipher = "2022-blake3-chacha20-poly1305";
            expect(() => Surge_Producer().produce(proxy, "external")).to.throw(
                /2022-blake3-chacha20-poly1305 is not supported/,
            );
            expect(ProxyUtils.produce(clone([proxy]), "surge", "external")).to.equal("");
        });
    });

    // ── Loon ──────────────────────────────────────────────────────────────────
    describe("Loon", function () {
        it("exports a valid SS+ShadowTLS v3 node", function () {
            const output = ProxyUtils.produce(clone([SS_ST_NODE]), "Loon", "external");
            expect(output).to.include("shadow-tls-password=stpassword");
            expect(output).to.include("shadow-tls-sni=sni.example.com");
            expect(output).to.include("shadow-tls-version=3");
        });

        it("throws when shadow-tls password contains a delimiter", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].password = "pass;word";
            expect(() => Loon_Producer().produce(proxy, "external")).to.throw(
                /Loon config format/,
            );
        });

        it("throws when shadow-tls host contains a delimiter", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"].host = "host,with,commas";
            expect(() => Loon_Producer().produce(proxy, "external")).to.throw(
                /Loon config format/,
            );
        });
    });

    // ── sing-box ──────────────────────────────────────────────────────────────
    describe("sing-box", function () {
        it("splits SS+ShadowTLS into shadowsocks + shadowtls detour", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "sing-box", "internal");
            expect(list.length).to.equal(2);
            const ss = list.find((o) => o.type === "shadowsocks");
            const st = list.find((o) => o.type === "shadowtls");
            expect(ss).to.not.equal(undefined);
            expect(st).to.not.equal(undefined);
            expect(ss.detour).to.equal(st.tag);
            expect(st.server).to.equal(SS_ST_NODE.server);
            expect(st.server_port).to.equal(SS_ST_NODE.port);
            expect(st.version).to.equal(3);
            expect(st.password).to.equal("stpassword");
            expect(st.tls.server_name).to.equal("sni.example.com");
        });

        it("includes utls fingerprint in shadowtls detour when client-fingerprint set", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["client-fingerprint"] = "chrome";
            const list = ProxyUtils.produce(clone([proxy]), "sing-box", "internal");
            const st = list.find((o) => o.type === "shadowtls");
            expect(st.tls.utls).to.deep.equal({ enabled: true, fingerprint: "chrome" });
        });

        it("marks tls as insecure when skip-cert-verify set in plugin-opts", function () {
            const proxy = clone(SS_ST_NODE);
            proxy["plugin-opts"]["skip-cert-verify"] = true;
            const list = ProxyUtils.produce(clone([proxy]), "sing-box", "internal");
            const st = list.find((o) => o.type === "shadowtls");
            expect(st.tls.insecure).to.equal(true);
        });

        it("supports hideHelpers: true to prefix shadowtls detour tag with §hide§", function () {
            const list = ProxyUtils.produce(clone([SS_ST_NODE]), "sing-box", "internal", {
                hideHelpers: true,
            });
            expect(list.length).to.equal(2);
            const ss = list.find((o) => o.type === "shadowsocks");
            const st = list.find((o) => o.type === "shadowtls");
            expect(st.tag).to.equal("§hide§ss-shadowtls_shadowtls");
            expect(ss.detour).to.equal("§hide§ss-shadowtls_shadowtls");
        });

        it("ensures helper shadowtls detours never enter proxy groups in assemble()", function () {
            const parsed = fromNodes([SS_ST_NODE]);
            const config = assemble(parsed);
            // Check outbounds has both ss and shadowtls
            expect(config.outbounds.some((o) => o.type === "shadowtls")).to.equal(true);
            // Check urltest/selector groups do NOT contain the shadowtls tag
            for (const o of config.outbounds) {
                if (["selector", "urltest"].includes(o.type)) {
                    expect(o.outbounds).to.not.include("ss-shadowtls_shadowtls");
                    expect(o.outbounds).to.include("ss-shadowtls");
                }
            }
        });

        it("ensures helper shadowtls detours never enter groups in assembleAcl()", function () {
            const parsed = fromNodes([SS_ST_NODE]);
            const preset = findPreset("acl4ssr-default");
            const config = assembleAcl(parsed, { aclPreset: "acl4ssr-default" });
            for (const o of config.outbounds) {
                if (["selector", "urltest"].includes(o.type)) {
                    expect(o.outbounds).to.not.include("ss-shadowtls_shadowtls");
                }
            }
        });
    });
});

// ─── Shadowrocket & Hiddify 仅节点导出测试 ──────────────────────────────────

describe("Shadowrocket & Hiddify node-only export with ShadowTLS", function () {
    const PLAIN_SS_NODE = {
        type: "ss",
        name: "ss-plain",
        server: "1.2.3.4",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "pw",
    };

    function makeStore(nodes) {
        return {
            list: () => [{ id: "src1", enabled: true, name: "Source 1" }],
            readSnapshot: () => JSON.stringify({ proxies: nodes }),
            getSettings: () => ({}),
        };
    }

    it("Shadowrocket node-only export with ShadowTLS outputs proxies-only YAML", function () {
        const store = makeStore([SS_ST_NODE]);
        const target = TARGETS.find((t) => t.id === "shadowrocket");
        const rendered = renderSubscription(store, { kind: "global" }, {
            target,
            out: "outbounds",
        });
        expect(rendered.status).to.equal(200);
        expect(rendered.content).to.equal("text/yaml; charset=utf-8");
        expect(rendered.body).to.include("proxies:");
        expect(rendered.body).to.include("ss-shadowtls");
        expect(rendered.body).to.include("plugin: shadow-tls");
    });

    it("Shadowrocket node-only export without ShadowTLS outputs URI list", function () {
        const store = makeStore([PLAIN_SS_NODE]);
        const target = TARGETS.find((t) => t.id === "shadowrocket");
        const rendered = renderSubscription(store, { kind: "global" }, {
            target,
            out: "outbounds",
        });
        expect(rendered.status).to.equal(200);
        expect(rendered.content).to.equal("text/plain; charset=utf-8");
        expect(rendered.body).to.include("ss://");
    });

    it("Hiddify node-only export with ShadowTLS outputs outbounds-only JSON with §hide§", function () {
        const store = makeStore([SS_ST_NODE]);
        const target = TARGETS.find((t) => t.id === "hiddify");
        const rendered = renderSubscription(store, { kind: "global" }, {
            target,
            out: "outbounds",
        });
        expect(rendered.status).to.equal(200);
        expect(rendered.content).to.equal("application/json; charset=utf-8");
        const json = JSON.parse(rendered.body);
        expect(json).to.have.property("outbounds");
        const stOutbound = json.outbounds.find((o) => o.type === "shadowtls");
        expect(stOutbound).to.not.equal(undefined);
        expect(stOutbound.tag).to.include("§hide§");
    });

    it("Hiddify node-only export without ShadowTLS outputs plain URI list", function () {
        const store = makeStore([PLAIN_SS_NODE]);
        const target = TARGETS.find((t) => t.id === "hiddify");
        const rendered = renderSubscription(store, { kind: "global" }, {
            target,
            out: "outbounds",
        });
        expect(rendered.status).to.equal(200);
        expect(rendered.content).to.equal("text/plain; charset=utf-8");
        expect(rendered.body).to.include("ss://");
    });
});
