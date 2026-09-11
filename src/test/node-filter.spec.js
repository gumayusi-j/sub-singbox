import { expect } from "chai";
import {
    serializeFilter,
    parseFilterPattern,
    compileFilter,
    filterNodeNames,
    normalizeNodeFilter,
    emptyDraft,
} from "@/kit/nodes/filter";

function draft(overrides) {
    return Object.assign(emptyDraft(), overrides || {});
}

const NODES = ["🇭🇰 香港 01", "🇯🇵 日本 01", "🇺🇸 美国 01", "直连", "HK-02 (2x)"];

describe("kit/nodes/filter", function () {
    describe("serializeFilter", function () {
        it("joins several keywords as alternatives", function () {
            expect(serializeFilter(draft({ keywords: "港\nhk" }))).to.equal("(?i)(?:港|hk)");
        });

        it("escapes a keyword's regular-expression metacharacters", function () {
            // `.*` typed as a keyword is a literal two-character string, not a
            // wildcard - that is the whole reason the keyword form exists.
            expect(serializeFilter(draft({ keywords: ".*" }))).to.equal("(?i)(?:\\.\\*)");
            expect(serializeFilter(draft({ keywords: "a+b(c)" }))).to.equal(
                "(?i)(?:a\\+b\\(c\\))",
            );
        });

        it("wraps the anchor around the whole alternation", function () {
            // `^a|b$` would anchor only the first and last branch.
            expect(serializeFilter(draft({ keywords: "a\nb", style: "exact" }))).to.equal(
                "(?i)^(?:a|b)$",
            );
            expect(serializeFilter(draft({ keywords: "a", style: "prefix" }))).to.equal(
                "(?i)^(?:a)",
            );
            expect(serializeFilter(draft({ keywords: "a", style: "suffix" }))).to.equal(
                "(?i)(?:a)$",
            );
        });

        it("writes the case flag inline", function () {
            expect(serializeFilter(draft({ keywords: "hk", ignoresCase: false }))).to.equal(
                "(?-i)(?:hk)",
            );
        });

        it("returns an empty expression for no keywords", function () {
            expect(serializeFilter(draft({ keywords: "  \n \n" }))).to.equal("");
            expect(serializeFilter(draft({ usesRegex: true, regex: "(?i)hk" }))).to.equal("(?i)hk");
        });
    });

    describe("serialize and parse round trip", function () {
        it("returns the same expression for everything it writes", function () {
            const cases = [
                draft({ keywords: "港\nhk" }),
                draft({ keywords: ".*" }),
                draft({ keywords: "a+b(c)" }),
                draft({ keywords: "a\nb", style: "exact" }),
                draft({ keywords: "香港", style: "prefix" }),
                draft({ keywords: "JP", style: "suffix", ignoresCase: false }),
            ];
            for (const value of cases) {
                const pattern = serializeFilter(value);
                expect(serializeFilter(parseFilterPattern(pattern, true)), pattern).to.equal(
                    pattern,
                );
            }
        });
    });

    describe("parseFilterPattern", function () {
        it("recovers keywords, style and case", function () {
            expect(parseFilterPattern("(?i)^(?:港|hk)$", true)).to.deep.equal({
                keywords: "港\nhk",
                style: "exact",
                ignoresCase: true,
                usesRegex: false,
                regex: "(?i)^(?:港|hk)$",
            });
        });

        it("falls back to the caller's case default when the pattern is silent", function () {
            expect(parseFilterPattern("(?:hk)", true).ignoresCase).to.equal(true);
            expect(parseFilterPattern("(?:hk)", false).ignoresCase).to.equal(false);
        });

        it("refuses an anchor that binds to one branch of an alternation", function () {
            // `^HK|JP$` is not `^(?:HK|JP)$` and cannot be shown as if it were.
            expect(parseFilterPattern("^HK|JP$", true)).to.equal(null);
        });

        it("refuses the constructs the keyword form cannot say", function () {
            expect(parseFilterPattern("[A-Z]+", true)).to.equal(null);
            expect(parseFilterPattern("(?!)", true)).to.equal(null);
            expect(parseFilterPattern("a{1,3}", true)).to.equal(null);
            expect(parseFilterPattern("", true)).to.equal(null);
            expect(parseFilterPattern("a\nb", true)).to.equal(null);
        });

        it("refuses to trim a literal that has whitespace in it", function () {
            expect(parseFilterPattern("(?i)(?: 港 )", true)).to.equal(null);
        });
    });

    describe("compileFilter", function () {
        it("strips the inline case flag JavaScript cannot accept", function () {
            // `new RegExp("(?i)a")` throws; the flag is mapped to a real one.
            expect(compileFilter("(?i)hk", false).re.flags).to.contain("i");
            expect(compileFilter("(?-i)hk", true).re.flags).to.not.contain("i");
            expect(compileFilter("hk", true).re.flags).to.contain("i");
            expect(compileFilter("hk", false).re.flags).to.equal("");
        });

        it("rejects an expression with a nested quantifier", function () {
            const result = compileFilter("(a+)+$", true);
            expect(result.re).to.equal(undefined);
            expect(result.error).to.match(/嵌套量词/);
        });

        it("accepts the ordinary patterns a user would write", function () {
            for (const pattern of [
                "(?i)^(?!.*(?:港|hk)).*",
                "(?i)^(?:港|hk|Hong Kong)$",
                "(ab)*",
                "^(?:a|b)+$",
                "HK|JP",
            ]) {
                expect(compileFilter(pattern, true).error, pattern).to.equal(undefined);
            }
        });

        it("reports an invalid expression instead of throwing", function () {
            expect(compileFilter("a(", true).error).to.match(/无效/);
            expect(compileFilter("[", true).error).to.match(/无效/);
        });

        it("refuses an empty or oversized expression", function () {
            expect(compileFilter("", true).error).to.match(/不能为空/);
            expect(compileFilter("a".repeat(1001), true).error).to.match(/过长/);
        });
    });

    describe("filterNodeNames", function () {
        it("keeps everything when there is no expression", function () {
            expect(filterNodeNames(NODES, "", {}).names).to.deep.equal(NODES);
            expect(filterNodeNames(NODES, null, {}).names).to.deep.equal(NODES);
        });

        it("matches a substring by default", function () {
            const result = filterNodeNames(NODES, "(?i)(?:香港|hk)", {});
            expect(result.names).to.deep.equal(["🇭🇰 香港 01", "HK-02 (2x)"]);
            expect(result.error).to.equal(null);
        });

        it("matches any one of several keywords", function () {
            const result = filterNodeNames(
                NODES,
                serializeFilter(draft({ keywords: "日本\n美国" })),
                {},
            );
            expect(result.names).to.deep.equal(["🇯🇵 日本 01", "🇺🇸 美国 01"]);
        });

        it("anchors per style", function () {
            const exact = filterNodeNames(
                NODES,
                serializeFilter(draft({ keywords: "直连", style: "exact" })),
                {},
            );
            expect(exact.names).to.deep.equal(["直连"]);
            const prefix = filterNodeNames(
                NODES,
                serializeFilter(draft({ keywords: "HK", style: "prefix" })),
                {},
            );
            expect(prefix.names).to.deep.equal(["HK-02 (2x)"]);
        });

        it("treats an escaped keyword as a literal, not a wildcard", function () {
            const literal = filterNodeNames(NODES, serializeFilter(draft({ keywords: ".*" })), {});
            expect(literal.names).to.deep.equal([]);
        });

        it("tries every candidate of a paired entry", function () {
            const entries = [
                ["香港 01", "HK-01"],
                ["日本 01", "JP-01"],
            ];
            const result = filterNodeNames(entries, "JP-01", {});
            expect(result.names).to.deep.equal([["日本 01", "JP-01"]]);
        });

        it("reports an error rather than an empty match list", function () {
            // "nothing matched" and "we could not tell you" are different
            // answers, and the caller has to be able to tell them apart.
            const result = filterNodeNames(NODES, "[", {});
            expect(result.names).to.deep.equal([]);
            expect(result.error).to.match(/无效/);
        });

        it("gives up when the time budget is already spent", function () {
            const result = filterNodeNames(NODES, "(?i)港", { timeoutMs: 0 });
            expect(result.names).to.deep.equal([]);
            expect(result.error).to.match(/超时/);
        });

        it("does not read past the candidate length cap", function () {
            const long = "a".repeat(500) + "香港";
            // The match sits past the cap, so it is not found - and the run
            // stays bounded, which is the point of the cap.
            expect(filterNodeNames([long], "香港", {}).names).to.deep.equal([]);
            expect(filterNodeNames(["香港" + "a".repeat(500)], "香港", {}).names).to.have.length(1);
        });
    });

    describe("normalizeNodeFilter", function () {
        it("accepts the stored shape", function () {
            expect(
                normalizeNodeFilter({ pattern: "(?i)港", caseInsensitive: true }),
            ).to.deep.equal({ pattern: "(?i)港", caseInsensitive: true });
        });

        it("treats an empty pattern as no filter at all", function () {
            expect(normalizeNodeFilter({ pattern: "  " })).to.equal(null);
            expect(normalizeNodeFilter(null)).to.equal(null);
            expect(normalizeNodeFilter("(?i)港")).to.equal(null);
        });

        it("defaults case-insensitivity on", function () {
            expect(normalizeNodeFilter({ pattern: "港" }).caseInsensitive).to.equal(true);
        });
    });
});
