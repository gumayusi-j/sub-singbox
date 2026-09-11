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
        // The rules page saves its choices to the server; both the export page
        // and the address a client polls are rendered from that saved copy.
        expect(html).to.include("/api/settings");
        // The address moved off the subscriptions page to the export page.
        expect(html).to.not.include("subTargetSel");
        // The export address carries an optional public base and a pinned
        // client. The select ships with only the "auto" entry on purpose - its
        // other options come from the server's target list, so a hardcoded one
        // here would drift.
        expect(html).to.include('v-model="publicUrlInput"');
        expect(html).to.include('v-model="exportTarget"');
        expect(html).to.include('v-for="t in targets"');
        // The feature was specified without one; this keeps it that way.
        expect(html).to.not.include("二维码");
    });

    it("keeps the page's start-up path reachable", async function () {
        // Everything the page needs to come alive - the subscription list, the
        // target list, the polling address - hangs off loadSubs(), which is
        // called from the onMounted callback. A top-level early `return` there
        // (e.g. guarding on the map canvas, which lives behind v-if="last" and
        // so never exists at mount time) skips it and leaves the page sitting
        // on its loading spinner forever. Returns nested inside the event
        // handlers of the same callback are fine.
        const html = await (await fetch(base + "/")).text();
        const start = html.indexOf("Vue.onMounted(function() {");
        const end = html.indexOf("\n    });", start);
        expect(start, "页面里应有 Vue.onMounted 初始化块").to.be.greaterThan(-1);
        expect(end, "onMounted 块应有闭合的结尾").to.be.greaterThan(start);
        // De-indent the callback body so the check does not depend on how
        // deeply setup() itself happens to be nested.
        const body = html
            .slice(start, end)
            .split("\n")
            .map((line) => (line.startsWith("      ") ? line.slice(6) : line))
            .join("\n");
        expect(body, "onMounted 里不应有顶层早退，否则 loadSubs() 不会执行").to.not
            .match(/^(if \(.*\) )?return;/m);
        expect(body).to.include("loadSubs()");
    });

    it("keeps node reordering wired to the exported order", async function () {
        // The preview table's ⠿ handle is the only way to set nodeOrder, and
        // the export path sorts the stored nodes by it. Dropping the handle
        // during a markup rewrite disables the feature silently, while
        // saveNodeSelection keeps reporting success.
        const html = await (await fetch(base + "/")).text();
        expect(html).to.include('class="drag-handle"');
        expect(html).to.include("draggable=");
        expect(html).to.include("onNodeDrop");
        expect(html).to.include("nodeOrder");
    });

    it("keeps the world map wired to its tab", async function () {
        // The map canvas only exists while its output tab is shown, so the
        // draw has to be triggered by switching to that tab - generate() only
        // covers the case where the map was already the active tab. Without
        // the handler the map renders blank and never binds its zoom/pan
        // listeners.
        const html = await (await fetch(base + "/")).text();
        expect(html).to.include('@tab-change="onOutTabChange"');
        expect(html).to.include("drawWorldMap");
        expect(html).to.include("bindMapEvents");
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

    it("applies options like rules, and ignores run-shape ones", async function () {
        const resp = await fetch(base + "/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: sampleText,
                options: {
                    rules: ["DOMAIN-SUFFIX,doubleclick.net,block"],
                    // Gone from the API surface. A caller still sending them
                    // must get the one profile, not a half-applied shape.
                    mode: "proxy",
                    tun: false,
                    inboundPort: 7890,
                    addMixed: true,
                },
            }),
        });
        const json = await resp.json();
        const config = json.data.output;
        expect(config.inbounds.map((i) => i.type)).to.deep.equal(["tun"]);
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
                options: { aclPreset: "acl4ssr-mini" },
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
