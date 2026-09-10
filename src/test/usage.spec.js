import { expect } from "chai";
import { Base64 } from "js-base64";
import {
    parseUserInfoHeader,
    parseStatusLine,
    parseNoticeUsage,
    mergeUsage,
    extractUsage,
    normalizeExpire,
    formatUserInfoHeader,
    usageSummary,
} from "@/subscription/usage";

const EXPIRY = 1790000000; // 2026-09-22T04:53:20Z

describe("subscription usage — header", function () {
    it("reads the four fields a panel sends", function () {
        const usage = parseUserInfoHeader(
            "upload=1024; download=2048; total=1073741824; expire=" + EXPIRY,
        );
        expect(usage).to.deep.equal({
            origin: "userinfo",
            upload: 1024,
            download: 2048,
            total: 1073741824,
            expire: EXPIRY,
        });
    });

    it("tolerates spacing, ordering and a trailing semicolon", function () {
        const usage = parseUserInfoHeader("total=100 ; upload=1 ;download=2;");
        expect(usage.upload).to.equal(1);
        expect(usage.download).to.equal(2);
        expect(usage.total).to.equal(100);
    });

    it("fills only the fields that are present", function () {
        const usage = parseUserInfoHeader("total=100");
        expect(usage.total).to.equal(100);
        expect(usage.upload).to.equal(undefined);
        expect(usage.expire).to.equal(undefined);
    });

    it("floors a float byte count and rejects a negative one", function () {
        expect(parseUserInfoHeader("upload=1024.9").upload).to.equal(1024);
        expect(parseUserInfoHeader("upload=-5; total=10").upload).to.equal(undefined);
        expect(parseUserInfoHeader("upload=-5; total=10").total).to.equal(10);
    });

    it("returns null for an empty or unparseable header", function () {
        expect(parseUserInfoHeader("")).to.equal(null);
        expect(parseUserInfoHeader("   ")).to.equal(null);
        expect(parseUserInfoHeader("nonsense")).to.equal(null);
        expect(parseUserInfoHeader(undefined)).to.equal(null);
        expect(parseUserInfoHeader(null)).to.equal(null);
    });
});

describe("subscription usage — STATUS line", function () {
    it("reads the key=value form", function () {
        const usage = parseStatusLine("STATUS=upload=1; download=2; total=3; expire=" + EXPIRY);
        expect(usage.origin).to.equal("status");
        expect(usage.upload).to.equal(1);
        expect(usage.total).to.equal(3);
        expect(usage.expire).to.equal(EXPIRY);
    });

    it("reads the sentence form a Chinese panel writes", function () {
        const usage = parseStatusLine(
            "STATUS=剩余流量：100 GB，已用 20 GB，到期时间：2026-09-30",
        );
        expect(usage.origin).to.equal("status");
        expect(usage.total).to.equal(100 * 1024 ** 3);
        expect(usage.download).to.equal(20 * 1024 ** 3);
        expect(usage.expire).to.equal(Date.UTC(2026, 8, 30) / 1000);
    });

    it("finds a STATUS line inside a base64-encoded body", function () {
        const body = Base64.encode("STATUS=upload=7; download=8; total=9\nvmess://keepme");
        const usage = parseStatusLine(body);
        expect(usage.upload).to.equal(7);
        expect(usage.total).to.equal(9);
    });

    it("returns null when there is no STATUS line", function () {
        expect(parseStatusLine("vmess://AAAA\nss://BBBB")).to.equal(null);
        expect(parseStatusLine("")).to.equal(null);
    });

    it("does not mistake an ordinary base64 node list for a STATUS body", function () {
        const body = Base64.encode("ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#香港01");
        expect(parseStatusLine(body)).to.equal(null);
    });
});

describe("subscription usage — notice nodes", function () {
    it("reads the plan summary out of a notice node name", function () {
        const usage = parseNoticeUsage([
            { name: "剩余流量：100 GB" },
            { name: "到期时间：2026-09-30" },
        ]);
        // The first notice that parses wins, and it is recorded verbatim.
        expect(usage.origin).to.equal("notice");
        expect(usage.total).to.equal(100 * 1024 ** 3);
        expect(usage.notices).to.deep.equal(["剩余流量：100 GB"]);
    });

    it("ignores nodes with nothing to parse", function () {
        expect(parseNoticeUsage([{ name: "香港 01" }, { name: "日本 02" }])).to.equal(null);
        expect(parseNoticeUsage([])).to.equal(null);
        expect(parseNoticeUsage(null)).to.equal(null);
    });
});

describe("subscription usage — merging", function () {
    it("prefers the header field by field, not source by source", function () {
        const merged = mergeUsage([
            { origin: "userinfo", total: 100 },
            { origin: "status", total: 999, download: 5 },
        ]);
        expect(merged.total).to.equal(100); // header wins
        expect(merged.download).to.equal(5); // status fills the gap
        expect(merged.origin).to.equal("userinfo");
    });

    it("collects notices from every source", function () {
        const merged = mergeUsage([
            { total: 1, notices: ["a"] },
            { download: 2, notices: ["b"] },
        ]);
        expect(merged.notices).to.deep.equal(["a", "b"]);
    });

    it("returns null when nothing was found at all", function () {
        expect(mergeUsage([null, undefined, {}])).to.equal(null);
    });

    it("extractUsage falls back from header to body to notices", function () {
        const fromHeader = extractUsage(
            { "subscription-userinfo": "total=100; expire=" + EXPIRY },
            "STATUS=total=999",
        );
        expect(fromHeader.total).to.equal(100);

        const fromBody = extractUsage({}, "STATUS=total=999");
        expect(fromBody.total).to.equal(999);

        const fromNotice = extractUsage({}, "vmess://x", [{ name: "剩余流量：1 GB" }]);
        expect(fromNotice.total).to.equal(1024 ** 3);
        expect(fromNotice.origin).to.equal("notice");

        expect(extractUsage({}, "", [])).to.equal(null);
    });
});

describe("subscription usage — expiry normalisation", function () {
    it("accepts unix seconds and milliseconds", function () {
        expect(normalizeExpire(EXPIRY)).to.equal(EXPIRY);
        expect(normalizeExpire(String(EXPIRY))).to.equal(EXPIRY);
        expect(normalizeExpire(EXPIRY * 1000)).to.equal(EXPIRY);
    });

    it("accepts a bare date as UTC midnight and an ISO timestamp", function () {
        expect(normalizeExpire("2026-09-30")).to.equal(Date.UTC(2026, 8, 30) / 1000);
        expect(normalizeExpire("2026-09-30T00:00:00Z")).to.equal(
            Date.UTC(2026, 8, 30) / 1000,
        );
    });

    it("rejects zero, negative and unparseable values", function () {
        expect(normalizeExpire(0)).to.equal(null);
        expect(normalizeExpire(-1)).to.equal(null);
        expect(normalizeExpire("soon")).to.equal(null);
        expect(normalizeExpire(null)).to.equal(null);
        expect(normalizeExpire("")).to.equal(null);
    });
});

describe("subscription usage — presentation", function () {
    it("round-trips through the client header, omitting absent fields", function () {
        const header = formatUserInfoHeader({
            upload: 1,
            download: 2,
            total: 3,
            expire: EXPIRY,
        });
        expect(header).to.equal("upload=1; download=2; total=3; expire=" + EXPIRY);
        expect(formatUserInfoHeader({ total: 5 })).to.equal("total=5");
        expect(formatUserInfoHeader(null)).to.equal(null);
        expect(formatUserInfoHeader({})).to.equal(null);
    });

    it("treats a zero total as unlimited rather than as zero bytes", function () {
        const summary = usageSummary({ upload: 5, download: 5, total: 0 }, new Date());
        expect(summary.unlimited).to.equal(true);
        expect(summary.ratio).to.equal(null);
        expect(summary.used).to.equal(10);
    });

    it("reports the ratio, the days left and an expired flag", function () {
        const now = new Date(EXPIRY * 1000 - 2 * 86400 * 1000);
        const summary = usageSummary(
            { upload: 25, download: 25, total: 100, expire: EXPIRY },
            now,
        );
        expect(summary.used).to.equal(50);
        expect(summary.ratio).to.equal(0.5);
        expect(summary.daysLeft).to.equal(2);
        expect(summary.expired).to.equal(false);
        expect(summary.expireAt).to.equal(new Date(EXPIRY * 1000).toISOString());

        const past = usageSummary(
            { total: 100, expire: EXPIRY },
            new Date((EXPIRY + 60) * 1000),
        );
        expect(past.expired).to.equal(true);
        expect(past.daysLeft).to.equal(0);
    });

    it("caps the ratio at 1 when a panel overshoots the quota", function () {
        const summary = usageSummary({ download: 500, total: 100 }, new Date());
        expect(summary.ratio).to.equal(1);
    });
});
