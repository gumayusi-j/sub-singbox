import { expect } from "chai";
import { createServer } from "@/web/server";

describe("singbox-kit web API", function () {
    let server;
    let base;

    before(function (done) {
        const config = {
            listen: { host: "127.0.0.1", port: 0 },
            maxBodyBytes: 1048576,
            defaultOut: "config",
            remoteDns: "",
        };
        server = createServer(config);
        server.listen(0, "127.0.0.1", function () {
            const addr = server.address();
            base = "http://127.0.0.1:" + addr.port;
            done();
        });
    });

    after(function (done) {
        if (server) server.close(done);
        else done();
    });

    const sampleText = [
        "ss://YWVzLTEyOC1nY206cGFzc0AxLjIuMy40OjgzODg=#ss-one",
        "trojan://secret@b.example.com:443?sni=b.example.com#trojan-node",
    ].join("\n");

    it("serves the page at GET /", async function () {
        const resp = await fetch(base + "/");
        expect(resp.status).to.equal(200);
        const html = await resp.text();
        expect(resp.headers.get("content-type")).to.include("text/html");
        expect(html).to.include("singbox-kit");
        // The page drives the subscription store; /api/convert still exists and
        // is covered below, but the UI no longer calls it.
        expect(html).to.include("/api/subscriptions");
        expect(html).to.include("/api/export");
    });

    it("returns 404 for unknown static paths", async function () {
        const resp = await fetch(base + "/nope.css");
        expect(resp.status).to.equal(404);
    });

    it("converts text into a complete config by default", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: sampleText }),
        });
        expect(resp.status).to.equal(200);
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        const data = json.data;
        expect(data.mode).to.equal("config");
        expect(data.outbounds.length).to.equal(2);
        expect(data.nodes.length).to.equal(2);
        expect(data.nodes[0]).to.have.property("tag");
        const config = data.output;
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("proxy");
        expect(tags).to.include("direct");
        expect(tags).to.include("block");
        // the legacy special `dns` outbound was removed in sing-box 1.13.0
        expect(tags).to.not.include("dns-out");
        const selector = config.outbounds.find((o) => o.type === "selector");
        expect(selector.outbounds).to.include("ss-one");
        expect(config.route.final).to.equal("proxy");
        // default output is the client skeleton
        expect(config.inbounds.map((i) => i.type)).to.include("tun");
        expect(config.experimental).to.have.property("clash_api");
        expect(config.http_clients).to.have.length(1);
    });

    it("applies options like mode/proxy, tun and rules", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: sampleText,
                options: {
                    mode: "proxy",
                    tun: true,
                    inboundPort: 7890,
                    rules: ["DOMAIN-SUFFIX,doubleclick.net,block"],
                },
            }),
        });
        const json = await resp.json();
        const config = json.data.output;
        expect(config.inbounds.map((i) => i.type)).to.include("tun");
        expect(config.inbounds.find((i) => i.type === "mixed").listen_port).to.equal(7890);
        expect(config.route.rules[0]).to.deep.equal({
            domain_suffix: "doubleclick.net",
            outbound: "block",
        });
    });

    it("returns outbounds-only output when requested", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: sampleText, out: "outbounds" }),
        });
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        expect(json.data.mode).to.equal("outbounds");
        expect(json.data.output.outbounds.length).to.equal(2);
        expect(json.data.output).to.not.have.property("route");
    });

    it("rejects empty input with 400", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: "" }),
        });
        expect(resp.status).to.equal(400);
        const json = await resp.json();
        expect(json.ok).to.equal(false);
    });

    it("merges multiple sources into one config and renames duplicate tags", async function () {
        // Second source re-uses the same node remark (#ss-one), so the merge
        // must rename the collision (ss-one -> ss-one-2) to keep the config
        // bootable - sing-box rejects duplicate outbound tags.
        const secondSource = "ss://YWVzLTEyOC1nY206cGFzc0AxLjIuMy40OjgzODg=#ss-one";
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sources: [{ input: sampleText }, { input: secondSource }],
            }),
        });
        expect(resp.status).to.equal(200);
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        const data = json.data;
        expect(data.nodes.length).to.equal(3);
        const tags = data.output.outbounds.map((o) => o.tag);
        expect(tags).to.include("ss-one");
        expect(tags).to.include("ss-one-2");
        expect(tags).to.include("proxy");
        expect(tags).to.include("direct");
        expect(tags).to.include("block");
        expect(data.warnings.length).to.be.greaterThan(0);
        const rename = data.warnings.find((w) =>
            w && typeof w.message === "string" && w.message.indexOf("'ss-one-2'") !== -1);
        expect(rename).to.not.equal(undefined);
    });

    it("inspects a source and reports node/protocol counts without assembling", async function () {
        const resp = await fetch(base + "/api/inspect", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: sampleText }),
        });
        expect(resp.status).to.equal(200);
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        expect(json.data.totalNodes).to.equal(2);
        expect(json.data.sources).to.have.length(1);
        const rec = json.data.sources[0];
        expect(rec.nodeCount).to.equal(2);
        expect(rec.protocols).to.deep.equal({ shadowsocks: 1, trojan: 1 });
        expect(rec.error).to.equal(undefined);
    });

    it("inspection keeps HTTP 200 and flags a bad source on its own row", async function () {
        const resp = await fetch(base + "/api/inspect", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sources: [{ input: "   " }, { input: sampleText }],
            }),
        });
        expect(resp.status).to.equal(200);
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        const sources = json.data.sources;
        expect(sources).to.have.length(2);
        expect(sources[0].nodeCount).to.equal(0);
        expect(sources[0].error).to.equal("input is empty");
        expect(sources[1].nodeCount).to.equal(2);
        expect(sources[1].error).to.equal(undefined);
        expect(json.data.totalNodes).to.equal(2);
    });

    it("assembles an ACL4SSR preset when aclPreset is given", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: sampleText,
                options: { mode: "proxy", aclPreset: "acl4ssr-mini" },
            }),
        });
        expect(resp.status).to.equal(200);
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        const config = json.data.output;
        const tags = config.outbounds.map((o) => o.tag);
        expect(tags).to.include("🚀 节点选择");
        expect(tags).to.include("♻️ 自动选择");
        expect(tags).to.include("🐟 漏网之鱼");
        expect(new Set(tags).size).to.equal(tags.length);
        expect(config.route.final).to.equal("🐟 漏网之鱼");
        expect((config.route.rule_set || []).map((r) => r.tag)).to.deep.equal(["geoip-cn"]);
    });

    it("falls back to the default skeleton for an unknown aclPreset", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: sampleText, options: { aclPreset: "bogus" } }),
        });
        const json = await resp.json();
        expect(json.ok).to.equal(true);
        expect(json.data.output.outbounds.map((o) => o.tag)).to.include("proxy");
    });
});
