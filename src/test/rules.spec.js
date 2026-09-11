import { expect } from "chai";
import {
    splitFields,
    unquote,
    removingComment,
    portRanges,
    condition,
    parseRuleLine,
    formatCondition,
    MAX_FIELD_BYTES,
} from "@/kit/rules/syntax";

// A condition body nested `levels` deep. `AND` with a single branch is legal,
// which makes it the cheapest way to reach a specific recursion depth.
function nest(levels) {
    let body = "DOMAIN,a.com";
    for (let i = 0; i < levels; i += 1) body = "AND,((" + body + "))";
    return body;
}

describe("rules/syntax", function () {
    describe("splitFields", function () {
        it("splits a plain rule into its fields", function () {
            expect(splitFields("DOMAIN-SUFFIX,example.com")).to.deep.equal([
                "DOMAIN-SUFFIX",
                "example.com",
            ]);
        });

        it("trims each field and keeps a trailing empty one", function () {
            expect(splitFields(" a , b ")).to.deep.equal(["a", "b"]);
            expect(splitFields("a,")).to.deep.equal(["a", ""]);
        });

        it("does not split on a comma inside quotes", function () {
            expect(splitFields('DOMAIN,"a,b",Proxy')).to.deep.equal([
                "DOMAIN",
                '"a,b"',
                "Proxy",
            ]);
        });

        it("keeps the escape backslash in the value", function () {
            expect(splitFields("DOMAIN,a\\,b,Proxy")).to.deep.equal([
                "DOMAIN",
                "a\\,b",
                "Proxy",
            ]);
        });

        it("refuses an unclosed quote", function () {
            expect(splitFields('DOMAIN,"abc,Proxy')).to.equal(null);
        });

        it("refuses a line longer than the byte budget", function () {
            // The limit is UTF-8 bytes, not characters: 43690 three-byte
            // characters fit, one more does not.
            const fits = "中".repeat(43690);
            expect(Buffer.byteLength(fits, "utf8")).to.be.at.most(MAX_FIELD_BYTES);
            expect(splitFields(fits)).to.deep.equal([fits]);

            const tooLong = "中".repeat(43691);
            expect(Buffer.byteLength(tooLong, "utf8")).to.be.above(MAX_FIELD_BYTES);
            expect(splitFields(tooLong)).to.equal(null);
        });

        it("refuses input spanning more than one line", function () {
            expect(splitFields("a,b\nc,d")).to.equal(null);
            // The CR matters on its own: the bundled .list snapshots are CRLF,
            // so a caller that forgets to trim loses every rule silently.
            expect(splitFields("a,b\r")).to.equal(null);
        });

        it("only splits at paren depth zero", function () {
            expect(splitFields("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT")).to.deep.equal([
                "AND",
                "((NETWORK,UDP),(DST-PORT,443))",
                "REJECT",
            ]);
        });

        it("refuses an unbalanced paren", function () {
            expect(splitFields("AND,((NETWORK,UDP)")).to.equal(null);
            expect(splitFields("NETWORK,UDP)")).to.equal(null);
        });

        it("refuses paren nesting past the limit", function () {
            expect(splitFields("(".repeat(64) + "a" + ")".repeat(64))).to.deep.equal([
                "(".repeat(64) + "a" + ")".repeat(64),
            ]);
            expect(splitFields("(".repeat(65) + "a" + ")".repeat(65))).to.equal(null);
        });

        it("does not count a paren inside quotes", function () {
            expect(splitFields('DOMAIN,"(a,b",Proxy')).to.deep.equal([
                "DOMAIN",
                '"(a,b"',
                "Proxy",
            ]);
        });
    });

    describe("unquote", function () {
        it("strips one matching pair of quotes", function () {
            expect(unquote('"a,b"')).to.equal("a,b");
            expect(unquote("'a,b'")).to.equal("a,b");
        });

        it("leaves mismatched or unquoted values alone", function () {
            expect(unquote('"abc')).to.equal('"abc');
            expect(unquote("\"abc'")).to.equal("\"abc'");
            expect(unquote("abc")).to.equal("abc");
            expect(unquote("")).to.equal("");
        });
    });

    describe("removingComment", function () {
        it("drops a comment that starts the line", function () {
            expect(removingComment("# hello")).to.equal("");
            expect(removingComment("; hello")).to.equal("");
            expect(removingComment("// hello")).to.equal("");
        });

        it("drops a trailing comment after whitespace", function () {
            expect(removingComment("DOMAIN,one.example,REJECT # comment")).to.equal(
                "DOMAIN,one.example,REJECT",
            );
        });

        it("keeps a delimiter that is not preceded by whitespace", function () {
            const line = "DOMAIN,one.example,REJECT; comment";
            expect(removingComment(line)).to.equal(line);
        });

        it("does not mistake a URL scheme for a comment", function () {
            const line = "https://dns.google/dns-query";
            expect(removingComment(line)).to.equal(line);
        });

        it("ignores delimiters inside quotes", function () {
            const line = "URL-REGEX,'^https://example.com/a{1,3}#x',OpenAI // comment";
            expect(removingComment(line)).to.equal(
                "URL-REGEX,'^https://example.com/a{1,3}#x',OpenAI",
            );
        });

        it("does not open a quote on an apostrophe mid-word", function () {
            const line = "DOMAIN,Alice's.example,REJECT # comment";
            expect(removingComment(line)).to.equal("DOMAIN,Alice's.example,REJECT");
        });
    });

    describe("portRanges", function () {
        it("passes a single port through", function () {
            expect(portRanges("80")).to.deep.equal(["80"]);
            expect(portRanges("8000-8100")).to.deep.equal(["8000-8100"]);
        });

        it("expands each comparator", function () {
            expect(portRanges(">=100")).to.deep.equal(["100-65535"]);
            expect(portRanges(">100")).to.deep.equal(["101-65535"]);
            expect(portRanges("<=100")).to.deep.equal(["0-100"]);
            expect(portRanges("<100")).to.deep.equal(["0-99"]);
        });

        it("splits a slash-separated list", function () {
            expect(portRanges("80/443/8000-8100")).to.deep.equal([
                "80",
                "443",
                "8000-8100",
            ]);
        });

        it("refuses anything that is not a port", function () {
            expect(portRanges(">65535")).to.equal(null);
            expect(portRanges("70000")).to.equal(null);
            expect(portRanges("8100-8000")).to.equal(null);
            expect(portRanges("-1")).to.equal(null);
            expect(portRanges("abc")).to.equal(null);
            expect(portRanges("80/")).to.equal(null);
            expect(portRanges("")).to.equal(null);
        });
    });

    describe("condition", function () {
        it("reads a leaf condition", function () {
            expect(condition("DOMAIN-SUFFIX,example.com")).to.deep.equal({
                type: "DOMAIN-SUFFIX",
                content: "example.com",
                options: [],
            });
        });

        it("uppercases the type", function () {
            expect(condition("domain,example.com").type).to.equal("DOMAIN");
        });

        it("refuses FINAL and MATCH", function () {
            expect(condition("FINAL,Proxy")).to.equal(null);
            expect(condition("MATCH,Proxy")).to.equal(null);
        });

        it("refuses an empty type or an empty value", function () {
            expect(condition(",x")).to.equal(null);
            expect(condition("DOMAIN,")).to.equal(null);
            expect(condition("DOMAIN")).to.equal(null);
            expect(condition("")).to.equal(null);
        });

        it("parses a logical tree", function () {
            const parsed = condition(
                "AND,((NETWORK,UDP),(DST-PORT,443),(DOMAIN-SUFFIX,openai.com))",
            );
            expect(parsed.type).to.equal("AND");
            expect(parsed.options).to.deep.equal([]);
            expect(parsed.children.map((c) => c.type)).to.deep.equal([
                "NETWORK",
                "DST-PORT",
                "DOMAIN-SUFFIX",
            ]);
            expect(parsed.children[2].content).to.equal("openai.com");
        });

        it("nests logical nodes recursively", function () {
            const parsed = condition(
                "AND,((NOT,((SRC-IP,192.168.1.10))),(OR,((PROTOCOL,UDP),(DEST-PORT,80-90))))",
            );
            expect(parsed.children[0].type).to.equal("NOT");
            expect(parsed.children[0].children).to.have.length(1);
            expect(parsed.children[0].children[0].type).to.equal("SRC-IP");
            expect(parsed.children[1].type).to.equal("OR");
            expect(parsed.children[1].children.map((c) => c.content)).to.deep.equal([
                "UDP",
                "80-90",
            ]);
        });

        it("requires NOT to take exactly one branch", function () {
            expect(condition("NOT,((NETWORK,UDP),(DST-PORT,443))")).to.equal(null);
            expect(condition("NOT,((NETWORK,UDP))")).to.not.equal(null);
        });

        it("refuses an unbracketed or empty branch list", function () {
            expect(condition("AND,()")).to.equal(null);
            expect(condition("AND,(NETWORK,UDP)")).to.equal(null);
            expect(condition("AND,((NETWORK,UDP)")).to.equal(null);
        });

        it("refuses a logical node containing MATCH", function () {
            expect(condition("AND,((MATCH,OpenAI))")).to.equal(null);
        });

        it("stops at the recursion limit", function () {
            expect(condition(nest(10))).to.not.equal(null);
            expect(condition(nest(11))).to.equal(null);
        });
    });

    describe("parseRuleLine", function () {
        it("splits condition from policy", function () {
            expect(parseRuleLine("DOMAIN-SUFFIX,example.com,Proxy")).to.deep.equal({
                condition: {
                    type: "DOMAIN-SUFFIX",
                    content: "example.com",
                    options: [],
                },
                policy: "Proxy",
                options: [],
            });
        });

        it("reads the policy from a fixed slot, not the last field", function () {
            // The regression that motivated the rewrite: a policy containing
            // "=" used to be stripped as a parameter, leaving the value in the
            // policy slot.
            const parsed = parseRuleLine("DOMAIN,example.com,My=Group");
            expect(parsed.policy).to.equal("My=Group");
            expect(parsed.condition.content).to.equal("example.com");
        });

        it("keeps parameters out of the condition", function () {
            const parsed = parseRuleLine("DOMAIN,one.example,REJECT,no-resolve");
            expect(parsed.policy).to.equal("REJECT");
            expect(parsed.options).to.deep.equal(["no-resolve"]);
            expect(parsed.condition.options).to.deep.equal(["no-resolve"]);
        });

        it("treats a leading option word as an option, not a policy", function () {
            // A bare `.list` line has no policy column at all.
            const parsed = parseRuleLine("IP-CIDR,10.0.0.0/8,no-resolve");
            expect(parsed.policy).to.equal(null);
            expect(parsed.condition).to.deep.equal({
                type: "IP-CIDR",
                content: "10.0.0.0/8",
                options: ["no-resolve"],
            });
        });

        it("reports no policy for a two-field line", function () {
            const parsed = parseRuleLine("DOMAIN-SUFFIX,example.com");
            expect(parsed.policy).to.equal(null);
            expect(parsed.options).to.deep.equal([]);
        });

        it("handles each line ending the snapshots actually use", function () {
            for (const ending of ["\r\n", "\n", "\r", ""]) {
                const parsed = parseRuleLine("IP-CIDR,10.0.0.0/8,no-resolve" + ending);
                expect(parsed, JSON.stringify(ending)).to.not.equal(null);
                expect(parsed.condition.content).to.equal("10.0.0.0/8");
            }
        });

        it("reads FINAL with its policy in the first slot", function () {
            expect(parseRuleLine("FINAL,Proxy")).to.deep.equal({
                condition: null,
                policy: "Proxy",
                options: [],
            });
            expect(parseRuleLine("MATCH,Proxy,no-resolve").options).to.deep.equal([
                "no-resolve",
            ]);
        });

        it("keeps a quoted value whole", function () {
            const parsed = parseRuleLine('DOMAIN,"a,b.com",Group');
            expect(parsed.condition.content).to.equal("a,b.com");
            expect(parsed.policy).to.equal("Group");
        });

        it("parses a logical rule with a policy", function () {
            const parsed = parseRuleLine("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");
            expect(parsed.condition.type).to.equal("AND");
            expect(parsed.policy).to.equal("REJECT");
            // The policy must not leak into the matcher's options.
            expect(parsed.condition.options).to.deep.equal([]);
        });

        it("returns null for a comment-only or malformed line", function () {
            expect(parseRuleLine("# just a comment")).to.equal(null);
            expect(parseRuleLine("")).to.equal(null);
            expect(parseRuleLine("   ")).to.equal(null);
            expect(parseRuleLine("DOMAIN")).to.equal(null);
        });
    });

    describe("formatCondition", function () {
        it("round-trips through the parser", function () {
            const lines = [
                "DOMAIN-SUFFIX,example.com",
                "IP-CIDR,10.0.0.0/8,no-resolve",
                "AND,((NETWORK,UDP),(DST-PORT,443))",
                "AND,((NOT,((SRC-IP,192.168.1.10))),(OR,((PROTOCOL,UDP),(DEST-PORT,80-90))))",
            ];
            for (const line of lines) {
                expect(formatCondition(condition(line))).to.equal(line);
            }
        });
    });
});
