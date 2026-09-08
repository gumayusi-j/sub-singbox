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
            remoteDns: "https://dns.alidns.com/dns-query",
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
        expect(html).to.include("api/convert");
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
    });

    it("applies options like tun and rules", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: sampleText,
                options: {
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
});
