import { expect } from "chai";
import {
    importRules,
    detectRuleFormat,
    importRuleLines,
    importSurgeText,
    normalizeResourceLines,
} from "@/kit/rules/import";

const MIHOMO = [
    "rules:",
    "  - DOMAIN-SUFFIX,example.com,Proxy",
    "  - DOMAIN,ads.example,REJECT",
    "  - MATCH,Proxy",
    "",
].join("\n");

const SURGE = [
    "[General]",
    "loglevel = notify",
    "",
    "[Rule]",
    "DOMAIN-SUFFIX,example.com,Proxy",
    "HOST-SUFFIX,foo.com,DIRECT",
    "DEST-PORT,443,Proxy",
    "FINAL,Proxy",
    "",
    "[Proxy Group]",
    "DOMAIN,ignored.example,Proxy",
    "",
].join("\n");

describe("rules/import", function () {
    describe("detectRuleFormat", function () {
        it("recognises a mihomo document", function () {
            expect(detectRuleFormat(MIHOMO)).to.equal("mihomo");
            expect(detectRuleFormat("rule-providers:\n  a:\n    type: http\n")).to.equal("mihomo");
        });

        it("recognises a Surge configuration", function () {
            expect(detectRuleFormat(SURGE)).to.equal("surge");
        });

        it("falls back to bare lines", function () {
            expect(detectRuleFormat("DOMAIN-SUFFIX,a.com,Proxy")).to.equal("text");
            expect(detectRuleFormat("")).to.equal("text");
        });

        it("checks the structured shape before the section shape", function () {
            // A mihomo document may well contain a line that looks like a
            // Surge section; only the YAML parse can tell them apart.
            const doc = "rules:\n  - DOMAIN,a.com,Proxy\n";
            expect(detectRuleFormat(doc)).to.equal("mihomo");
        });
    });

    describe("mihomo documents", function () {
        it("imports rules and reads MATCH as the fallthrough policy", function () {
            const result = importRules(MIHOMO);
            expect(result.format).to.equal("mihomo");
            expect(result.rules).to.deep.equal([
                { type: "DOMAIN-SUFFIX", content: "example.com", options: [], outbound: "Proxy" },
                { type: "DOMAIN", content: "ads.example", options: [], outbound: "REJECT" },
            ]);
            expect(result.final).to.equal("Proxy");
            expect(result.stats.rules).to.equal(2);
        });

        it("reads the policy from a fixed slot, not the last field", function () {
            // The regression that motivated the parser rewrite: a policy
            // containing "=" used to be stripped as a parameter.
            const result = importRules("rules:\n  - DOMAIN,example.com,My=Group\n");
            expect(result.rules[0].outbound).to.equal("My=Group");
            expect(result.rules[0].content).to.equal("example.com");
        });

        it("keeps a quoted value whole", function () {
            const rule = importRules('rules:\n  - DOMAIN,"a,b.com",Group\n').rules[0];
            expect(rule.content).to.equal("a,b.com");
            expect(rule.outbound).to.equal("Group");
        });

        it("does not mistake a lookahead regex for unbalanced parens", function () {
            const rule = importRules(
                "rules:\n  - DOMAIN-REGEX,(?i)^(?!.*(?:hk|jp)).*,Group\n",
            ).rules[0];
            expect(rule).to.deep.equal({
                type: "DOMAIN-REGEX",
                content: "(?i)^(?!.*(?:hk|jp)).*",
                options: [],
                outbound: "Group",
            });
        });

        it("expands an inline rule-provider and inherits its policy", function () {
            const doc = [
                "rule-providers:",
                "  ads:",
                "    type: inline",
                "    behavior: domain",
                "    payload:",
                "      - '+.ads.example'",
                "      - tracker.example",
                "rules:",
                "  - RULE-SET,ads,REJECT",
                "",
            ].join("\n");
            const result = importRules(doc);
            expect(result.rules.map((r) => [r.type, r.content, r.outbound])).to.deep.equal([
                ["DOMAIN-SUFFIX", "ads.example", "REJECT"],
                ["DOMAIN", "tracker.example", "REJECT"],
            ]);
        });

        it("inherits a RULE-SET's own parameters onto its payload", function () {
            const doc = [
                "rule-providers:",
                "  cn:",
                "    type: inline",
                "    behavior: ipcidr",
                "    payload:",
                "      - 10.0.0.0/8",
                "rules:",
                "  - RULE-SET,cn,DIRECT,no-resolve,update-interval=86400",
                "",
            ].join("\n");
            const rule = importRules(doc).rules[0];
            expect(rule.type).to.equal("IP-CIDR");
            // no-resolve reaches an address matcher; update-interval is
            // provider plumbing and must not become a rule option.
            expect(rule.options).to.deep.equal(["no-resolve"]);
            expect(rule.outbound).to.equal("direct");
        });

        it("records a remote provider instead of fetching it", function () {
            const doc = [
                "rule-providers:",
                "  remote1:",
                "    type: http",
                "    behavior: domain",
                "    url: https://example.com/rules.yaml",
                "    interval: 86400",
                "rules:",
                "  - RULE-SET,remote1,Proxy",
                "",
            ].join("\n");
            const result = importRules(doc);
            expect(result.rules).to.have.length(0);
            expect(result.providers.map((p) => p.name)).to.deep.equal(["remote1"]);
            expect(result.warnings.some((w) => /rule_set/.test(w.message))).to.equal(true);
        });

        it("expands a remote provider when its content is in downloadedContent", function () {
            const doc = [
                "rule-providers:",
                "  remote1:",
                "    type: http",
                "    behavior: domain",
                "    url: https://example.com/rules.yaml",
                "    interval: 86400",
                "rules:",
                "  - RULE-SET,remote1,Proxy",
                "  - DOMAIN,direct.example,DIRECT",
                "",
            ].join("\n");
            const downloadedContent = new Map();
            downloadedContent.set("remote1", "+.cdn.example\ntracker.example");
            const result = importRules(doc, { downloadedContent });
            // The remote provider's content was expanded inline.
            expect(result.rules.map((r) => [r.type, r.content, r.outbound])).to.deep.equal([
                ["DOMAIN-SUFFIX", "cdn.example", "Proxy"],
                ["DOMAIN", "tracker.example", "Proxy"],
                ["DOMAIN", "direct.example", "direct"],
            ]);
            // No providers left to declare — the remote one was consumed.
            expect(result.providers).to.have.length(0);
            expect(result.stats.skipped).to.equal(0);
        });

        it("refuses a RULE-SET naming an undeclared provider", function () {
            const result = importRules("rules:\n  - RULE-SET,ghost,Proxy\n");
            expect(result.rules).to.have.length(0);
            expect(result.warnings.some((w) => /未声明/.test(w.message))).to.equal(true);
        });

        it("drops a rule whose policy sing-box cannot express", function () {
            const result = importRules("rules:\n  - DOMAIN,a.com,PASS\n  - DOMAIN,b.com,Proxy\n");
            expect(result.rules).to.have.length(1);
            expect(result.rules[0].content).to.equal("b.com");
            // Counted, so the summary reports it rather than looking complete.
            expect(result.stats.droppedByType.PASS).to.equal(1);
            expect(result.stats.skipped).to.equal(1);
        });

        it("resolves the YAML anchors and merge keys the yaml package supports", function () {
            const doc = [
                "defaults: &defaults",
                "  type: inline",
                "  behavior: domain",
                "rule-providers:",
                "  a:",
                "    <<: *defaults",
                "    payload: ['a.example']",
                "rules:",
                "  - RULE-SET,a,Proxy",
                "",
            ].join("\n");
            const result = importRules(doc);
            expect(result.rules.map((r) => r.content)).to.deep.equal(["a.example"]);
        });

        it("maps proxy groups, widening node names to every node", function () {
            const doc = [
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
                "  - name: 拦截",
                "    type: select",
                "    proxies: [REJECT, DIRECT]",
                "rules:",
                "  - DOMAIN,a.com,节点选择",
                "",
            ].join("\n");
            const result = importRules(doc);
            const byTag = new Map(result.groups.map((g) => [g.tag, g]));
            // Group references stay references; the unresolvable node name
            // becomes "any node" so the group is not imported empty.
            expect(byTag.get("节点选择").memberTokens).to.deep.equal([
                "[]自动选择",
                "[]DIRECT",
                ".*",
            ]);
            expect(byTag.get("自动选择").kind).to.equal("url-test");
            expect(byTag.get("自动选择").memberTokens[1]).to.equal(
                "http://www.gstatic.com/generate_204",
            );
            expect(byTag.get("拦截").drop).to.equal(true);
            expect(result.warnings.some((w) => /全部节点/.test(w.message))).to.equal(true);
        });
    });

    describe("surge configurations", function () {
        it("reads only the [Rule] section", function () {
            const result = importRules(SURGE);
            expect(result.format).to.equal("surge");
            expect(result.rules.map((r) => r.content)).to.deep.equal([
                "example.com",
                "foo.com",
                "443",
            ]);
            expect(result.rules.some((r) => r.content === "ignored.example")).to.equal(false);
            expect(result.final).to.equal("Proxy");
        });

        it("aliases the HOST and DEST-PORT spellings", function () {
            const result = importSurgeText(SURGE, {});
            // Surge's spelling, rewritten to the canonical one so the
            // sing-box mapper recognises it instead of dropping the rule.
            expect(result.rules[1].type).to.equal("DOMAIN-SUFFIX");
            expect(result.rules[1].outbound).to.equal("direct");
            expect(result.rules[2].type).to.equal("DST-PORT");
        });

        it("records a [Remote Rule] entry as a provider", function () {
            const text =
                "[Remote Rule]\nhttps://example.com/r.sgmodule,Proxy,86400\n[Rule]\nDOMAIN,a.com,Proxy\n";
            const result = importSurgeText(text, {});
            expect(result.providers).to.have.length(1);
            expect(result.rules).to.have.length(1);
        });
    });

    describe("bare rule lines", function () {
        it("skips comments and blanks", function () {
            const result = importRuleLines("# a comment\n\nDOMAIN,a.com,Proxy\n", {});
            expect(result.rules).to.have.length(1);
        });

        it("uses the caller's default when a line names no policy", function () {
            const result = importRuleLines("DOMAIN-SUFFIX,a.com\n", { defaultOutbound: "direct" });
            expect(result.rules[0].outbound).to.equal("direct");
        });

        it("reads a pasted .list line without inventing a policy", function () {
            const result = importRuleLines("IP-CIDR,10.0.0.0/8,no-resolve\n", {
                defaultOutbound: "direct",
            });
            expect(result.rules[0].outbound).to.equal("direct");
            expect(result.rules[0].options).to.deep.equal(["no-resolve"]);
        });

        it("imports a logical rule", function () {
            const result = importRuleLines("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT\n", {});
            expect(result.rules[0].type).to.equal("AND");
            expect(result.rules[0].children.map((c) => c.type)).to.deep.equal([
                "NETWORK",
                "DST-PORT",
            ]);
        });
    });

    describe("normalizeResourceLines", function () {
        it("reads bare domains by behavior", function () {
            expect(
                normalizeResourceLines(["+.a.example", "b.example", "*.c.example"], "domain"),
            ).to.deep.equal([
                "DOMAIN-SUFFIX,a.example",
                "DOMAIN,b.example",
                "DOMAIN-WILDCARD,*.c.example",
            ]);
        });

        it("reads bare addresses by family", function () {
            expect(normalizeResourceLines(["10.0.0.0/8", "2001:db8::/32"], "ipcidr")).to.deep.equal([
                "IP-CIDR,10.0.0.0/8",
                "IP-CIDR6,2001:db8::/32",
            ]);
        });

        it("aliases a dialect spelling and drops any policy column", function () {
            expect(
                normalizeResourceLines(["HOST-SUFFIX,a.example,SomePolicy"], "classical"),
            ).to.deep.equal(["DOMAIN-SUFFIX,a.example"]);
        });
    });
});
