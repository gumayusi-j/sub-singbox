import { expect } from "chai";
import {
    TARGETS,
    findTarget,
    listTargets,
    listExportTargets,
    contentTypeFor,
    resolveTarget,
} from "@/subscription/targets";
import producers from "@/core/proxy-utils/producers";

function ua(agent) {
    return resolveTarget({ userAgent: agent });
}

describe("subscription targets — resolution", function () {
    it("reads the client out of a User-Agent, case-insensitively", function () {
        expect(ua("sing-box/1.14.0").target.id).to.equal("sing-box");
        expect(ua("SING-BOX/1.14.0").target.id).to.equal("sing-box");
        expect(ua("singbox/1.9").target.id).to.equal("sing-box");
        expect(ua("clash-verge/1.6.0").target.id).to.equal("clash");
        expect(ua("mihomo/1.18.0").target.id).to.equal("clash");
        expect(ua("Shadowrocket/3378 CFNetwork/3892.100.1").target.id).to.equal(
            "shadowrocket",
        );
        expect(ua("Surge/5.0").target.id).to.equal("surge");
        expect(ua("Loon/3.2.1").target.id).to.equal("loon");
        expect(ua("Quantumult%20X/1.0.30").target.id).to.equal("quantumultx");
        expect(ua("Surfboard/2.0").target.id).to.equal("surfboard");
        expect(ua("Egern/1.0").target.id).to.equal("egern");
    });

    it("checks an app before the core it embeds", function () {
        // Hiddify and Karing both wrap another core; naming them should win.
        expect(ua("Hiddify/2.0.0 (sing-box 1.10)").target.id).to.equal("hiddify");
        expect(ua("Karing/1.0 (mihomo)").target.id).to.equal("karing");
        // Shadowrocket ships its own stack and must not be read as Clash.
        expect(ua("Shadowrocket/1.0 clash").target.id).to.equal("shadowrocket");
    });

    it("rejects an unknown or missing User-Agent by default", function () {
        expect(ua("curl/8.0")).to.equal(null);
        expect(ua("Mozilla/5.0")).to.equal(null);
        expect(resolveTarget({})).to.equal(null);
        expect(resolveTarget({ userAgent: "  " })).to.equal(null);
    });

    it("falls back to a configured dialect instead of rejecting", function () {
        const resolved = resolveTarget({ userAgent: "curl/8.0", unknownUaTarget: "clash" });
        expect(resolved.target.id).to.equal("clash");
        expect(resolved.reason).to.equal("default");
    });

    it("lets ?target= override a recognised User-Agent", function () {
        const resolved = resolveTarget({
            userAgent: "sing-box/1.14.0",
            queryTarget: "clash",
        });
        expect(resolved.target.id).to.equal("clash");
        expect(resolved.reason).to.equal("query");
    });

    it("lets ?target= rescue an unrecognised User-Agent", function () {
        const resolved = resolveTarget({ userAgent: "curl/8.0", queryTarget: "surge" });
        expect(resolved.target.id).to.equal("surge");
        expect(resolved.reason).to.equal("query");
    });

    it("treats ?target=auto as 'use the User-Agent'", function () {
        const resolved = resolveTarget({ userAgent: "Loon/3.0", queryTarget: "auto" });
        expect(resolved.target.id).to.equal("loon");
        expect(resolved.reason).to.equal("ua");
    });

    it("hard-fails on a ?target= typo rather than serving a different dialect", function () {
        expect(resolveTarget({ userAgent: "sing-box/1.0", queryTarget: "clsh" })).to.equal(
            null,
        );
        expect(resolveTarget({ queryTarget: "nonsense" })).to.equal(null);
    });

    it("honours an allowed-targets whitelist", function () {
        const allowedTargets = ["sing-box"];
        expect(resolveTarget({ userAgent: "clash-verge/1.0", allowedTargets })).to.equal(
            null,
        );
        expect(
            resolveTarget({ userAgent: "sing-box/1.0", allowedTargets }).target.id,
        ).to.equal("sing-box");
        // The whitelist constrains ?target= too.
        expect(resolveTarget({ queryTarget: "clash", allowedTargets })).to.equal(null);
    });
});

describe("subscription targets — table integrity", function () {
    it("maps every alias to a real table entry", function () {
        for (const id of ["clash.meta", "mihomo", "openclash", "quanx", "singbox", "v2rayng"]) {
            expect(findTarget(id), id).to.be.an("object");
        }
        expect(findTarget("")).to.equal(null);
        expect(findTarget()).to.equal(null);
    });

    it("only names producers that actually exist", function () {
        for (const target of TARGETS) {
            expect(producers[target.produce], target.id + " -> " + target.produce).to.be.an(
                "object",
            );
        }
    });

    it("gives every target a distinct id and a content type", function () {
        const ids = TARGETS.map((t) => t.id);
        expect(new Set(ids).size).to.equal(ids.length);
        for (const target of TARGETS) {
            expect(contentTypeFor(target)).to.be.a("string").with.length.above(0);
        }
        expect(contentTypeFor("nope")).to.equal("text/plain; charset=utf-8");
    });

    it("lists the targets for a 400 response body", function () {
        const listed = listTargets();
        expect(listed).to.have.length(TARGETS.length);
        expect(listed[0]).to.have.keys(["id", "label"]);
        expect(listed.map((t) => t.id)).to.deep.equal(TARGETS.map((t) => t.id));
    });

    it("marks sing-box as the only target assembled into a full config", function () {
        const configTargets = TARGETS.filter((t) => t.mode === "singbox").map((t) => t.id);
        expect(configTargets).to.deep.equal(["hiddify", "sing-box"]);
    });

    it("lists the clients the export page can pin an address to", function () {
        const listed = listExportTargets();
        expect(listed).to.have.length(9);
        expect(listed[0]).to.have.keys(["id", "label"]);
        // Membership, not order: the table's order is a UA-matching concern.
        expect(listed.map((t) => t.id)).to.have.members([
            "clash",
            "surge",
            "surfboard",
            "shadowrocket",
            "loon",
            "quantumultx",
            "sing-box",
            "hiddify",
            "egern",
        ]);
        // URI list is an output format rather than a client a user picks.
        expect(listed.map((t) => t.id)).to.not.include("uri");
        // Every id must still resolve, or the dropdown could hand out a 400.
        for (const entry of listed) {
            expect(findTarget(entry.id), entry.id).to.not.equal(null);
        }
    });
});
