import { expect } from "chai";
import {
    normalizeScheme,
    schemeFromImport,
    findScheme,
    listSchemes,
    CUSTOM_PREFIX,
} from "@/kit/schemes";
import { importRules } from "@/kit/rules/import";
import { assembleAcl, presetList } from "@/kit/acl4ssr/build";

const NODES = [
    { type: "shadowsocks", tag: "🇭🇰 香港-01" },
    { type: "trojan", tag: "JP-01" },
];

function parsed() {
    return { outbounds: NODES.map((node) => ({ type: node.type, tag: node.tag })), endpoints: [] };
}

// Same invariant acl.spec.js checks: every reference the config makes has to
// resolve to an outbound that exists, or sing-box will not start.
function assertReferencesResolve(config) {
    const tags = new Set(config.outbounds.map((o) => o.tag));
    expect(tags.size).to.equal(config.outbounds.length, "duplicate outbound tags");
    for (const rule of config.route.rules) {
        if (rule.outbound) {
            expect(tags.has(rule.outbound), "rule -> missing " + rule.outbound).to.equal(true);
        }
    }
    expect(tags.has(config.route.final), "final -> missing " + config.route.final).to.equal(true);
}

const DOC = [
    "proxy-groups:",
    "  - name: 节点选择",
    "    type: select",
    "    proxies: [自动选择, DIRECT, 香港01]",
    "  - name: 自动选择",
    "    type: url-test",
    "    url: http://www.gstatic.com/generate_204",
    "    interval: 300",
    "    tolerance: 50",
    "    proxies: [香港01]",
    "  - name: 广告拦截",
    "    type: select",
    "    proxies: [REJECT]",
    "rules:",
    "  - DOMAIN-SUFFIX,example.com,节点选择",
    "  - DOMAIN,ads.example,广告拦截",
    "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "  - AND,((NETWORK,UDP),(DST-PORT,443)),节点选择",
    "  - MATCH,节点选择",
    "",
].join("\n");

function buildScheme(overrides) {
    const imported = importRules(DOC);
    return schemeFromImport(
        imported,
        Object.assign({ id: CUSTOM_PREFIX + "test1", name: "我的规则" }, overrides || {}),
    );
}

describe("kit/schemes", function () {
    describe("normalizeScheme", function () {
        it("accepts a scheme it built itself", function () {
            const scheme = buildScheme();
            expect(scheme).to.not.equal(null);
            expect(normalizeScheme(scheme)).to.deep.equal(scheme);
        });

        it("refuses an id without the custom prefix", function () {
            const scheme = Object.assign(buildScheme(), { id: "acl4ssr-default" });
            expect(normalizeScheme(scheme)).to.equal(null);
        });

        it("refuses a scheme with no name or no rules", function () {
            const scheme = buildScheme();
            expect(normalizeScheme(Object.assign({}, scheme, { name: "  " }))).to.equal(null);
            expect(normalizeScheme(Object.assign({}, scheme, { rules: [] }))).to.equal(null);
            expect(normalizeScheme(null)).to.equal(null);
            expect(normalizeScheme("nope")).to.equal(null);
        });

        it("drops a rule entry it cannot rebuild rather than the whole scheme", function () {
            const scheme = buildScheme();
            const broken = Object.assign({}, scheme, {
                rules: [{ descriptors: [{ type: "AND", children: [] }] }].concat(scheme.rules),
            });
            const normalized = normalizeScheme(broken);
            // The empty logical node is refused; the rest survives.
            expect(normalized).to.not.equal(null);
            expect(normalized.rules.length).to.equal(scheme.rules.length);
        });

        it("keeps a condition tree intact through a round trip", function () {
            const scheme = buildScheme();
            const normalized = normalizeScheme(JSON.parse(JSON.stringify(scheme)));
            const logical = normalized.rules
                .reduce((acc, entry) => acc.concat(entry.descriptors), [])
                .find((d) => d.type === "AND");
            expect(logical.children.map((c) => c.type)).to.deep.equal(["NETWORK", "DST-PORT"]);
        });
    });

    describe("schemeFromImport", function () {
        it("groups rules by policy, preserving first-appearance order", function () {
            const scheme = buildScheme();
            expect(scheme.rules.map((entry) => entry.group)).to.deep.equal([
                "节点选择",
                "广告拦截",
                "direct",
            ]);
        });

        it("carries the MATCH policy as the scheme final", function () {
            expect(buildScheme().final).to.equal("节点选择");
        });

        it("carries the imported groups", function () {
            const scheme = buildScheme();
            expect(scheme.groups.map((g) => g.tag)).to.deep.equal([
                "节点选择",
                "自动选择",
                "广告拦截",
            ]);
            expect(scheme.groups[2].drop).to.equal(true);
        });

        it("refuses an import with nothing usable in it", function () {
            const empty = importRules("rules:\n  - DOMAIN,a.com,PASS\n");
            expect(schemeFromImport(empty, { id: "custom:x", name: "x" })).to.equal(null);
        });
    });

    describe("findScheme", function () {
        it("finds a built-in preset by id", function () {
            expect(findScheme("acl4ssr-mini", []).name).to.equal("ACL4SSR 精简");
        });

        it("finds a custom scheme", function () {
            const scheme = buildScheme();
            expect(findScheme(scheme.id, [scheme]).name).to.equal("我的规则");
        });

        it("prefers a built-in over a custom entry claiming its id", function () {
            const impostor = Object.assign(buildScheme(), { id: "acl4ssr-mini" });
            expect(findScheme("acl4ssr-mini", [impostor]).name).to.equal("ACL4SSR 精简");
        });

        it("skips an entry that cannot be normalized", function () {
            expect(findScheme("custom:x", [{ id: "custom:x" }])).to.equal(null);
            expect(findScheme("nope", [])).to.equal(null);
        });
    });

    describe("listSchemes", function () {
        it("lists the presets and then the custom schemes", function () {
            const scheme = buildScheme();
            const list = listSchemes([scheme], presetList);
            expect(list.slice(0, 3).map((s) => s.custom)).to.deep.equal([false, false, false]);
            expect(list[3].id).to.equal(scheme.id);
            expect(list[3].custom).to.equal(true);
        });

        it("omits a corrupt entry", function () {
            expect(listSchemes([{ id: "custom:bad" }], presetList)).to.have.length(3);
        });
    });

    // The whole point of the shape: an imported scheme renders through exactly
    // the same path as a bundled preset.
    describe("end to end", function () {
        it("assembles a bootable config from an imported scheme", function () {
            const config = assembleAcl(parsed(), { aclScheme: buildScheme() });
            expect(config.route.rules.length).to.be.greaterThan(0);
            expect(config.route.final).to.equal("节点选择");
            assertReferencesResolve(config);

            const reject = config.route.rules.filter((r) => r.action === "reject");
            expect(reject.length).to.be.greaterThan(0);
            // `no-resolve` has no sing-box equivalent and must not leak out.
            expect(JSON.stringify(config.route.rules)).to.not.match(/no[-_]resolve/i);
        });

        it("routes a logical rule into the config as a logical rule", function () {
            const config = assembleAcl(parsed(), { aclScheme: buildScheme() });
            // The route prelude carries a logical rule of its own (the DNS
            // hijack, an OR), so pick ours out by its target.
            const logical = config.route.rules.find(
                (r) => r.type === "logical" && r.outbound,
            );
            expect(logical).to.not.equal(undefined);
            expect(logical.mode).to.equal("and");
            expect(logical.outbound).to.equal("节点选择");
        });

        it("drops a rule whose group never got created", function () {
            // A rule pointing at a tag nothing declares stops sing-box from
            // starting, so an unresolvable target has to be skipped instead.
            const doc = [
                "proxy-groups:",
                "  - name: 空组",
                "    type: select",
                "    proxies: [DIRECT]",
                "rules:",
                "  - DOMAIN,a.com,空组",
                "  - DOMAIN,b.com,DIRECT",
                "",
            ].join("\n");
            const scheme = schemeFromImport(importRules(doc), {
                id: CUSTOM_PREFIX + "empty",
                name: "空组",
            });
            const config = assembleAcl(parsed(), { aclScheme: scheme });
            assertReferencesResolve(config);
        });

        it("falls back to direct when the fallthrough policy resolves to nothing", function () {
            const doc = ["rules:", "  - DOMAIN,a.com,Proxy", "  - MATCH,不存在的组", ""].join("\n");
            const scheme = schemeFromImport(importRules(doc), {
                id: CUSTOM_PREFIX + "final",
                name: "坏 final",
            });
            const config = assembleAcl(parsed(), { aclScheme: scheme });
            expect(config.route.final).to.equal("direct");
            assertReferencesResolve(config);
        });

        it("spells a reject fallthrough as a trailing rule", function () {
            // route.final has to name an outbound, so a reject MATCH cannot
            // live there; it becomes the last rule instead.
            const doc = ["rules:", "  - DOMAIN,a.com,Proxy", "  - MATCH,REJECT", ""].join("\n");
            const scheme = schemeFromImport(importRules(doc), {
                id: CUSTOM_PREFIX + "rej",
                name: "全拦",
            });
            const config = assembleAcl(parsed(), { aclScheme: scheme });
            const last = config.route.rules[config.route.rules.length - 1];
            expect(last.action).to.equal("reject");
            assertReferencesResolve(config);
        });
    });
});
