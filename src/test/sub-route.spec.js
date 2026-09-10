import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { createStore } from "@/subscription/store";
import { createCoordinator } from "@/subscription/coordinator";
import { createServer } from "@/web/server";
import { createMockFetch } from "./helpers/mock-fetch";

function nodesJson(names) {
    return JSON.stringify(
        names.map((name, i) => ({
            name,
            type: "ss",
            server: "10.0.0." + (i + 1),
            port: 8388,
            cipher: "aes-256-gcm",
            password: "pw",
        })),
    );
}

const NODES = nodesJson(["香港 01", "日本 02"]);

function baseConfig(dataPath, extra) {
    return Object.assign(
        {
            listen: { host: "127.0.0.1", port: 0 },
            maxBodyBytes: 1048576,
            defaultOut: "config",
            remoteDns: "",
            dataPath,
            apiToken: "",
            subscription: {
                defaultTarget: "sing-box",
                unknownUaTarget: "reject",
                allowedTargets: [],
                cacheSeconds: 0,
                exposeUsageHeader: true,
            },
        },
        extra || {},
    );
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// A live server over a temp store, pre-seeded with one refreshed source.
async function serve(options) {
    options = options || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-route-"));
    const dataPath = path.join(dir, "singbox-web.data.json");
    const store = createStore({
        dataPath,
        now: () => new Date("2026-09-10T00:00:00.000Z"),
    });
    const source = store.addSource({
        name: "主机场",
        kind: "url",
        url: "https://panel.test/sub?token=secret",
    });
    if (options.seed !== false) {
        store.writeSnapshot(source.id, options.body || NODES);
        store.patchSource(source.id, {
            lastUpdatedAt: "2026-09-09T12:00:00.000Z",
            lastCheckedAt: "2026-09-09T12:00:00.000Z",
            nodeCount: options.nodeCount === undefined ? 2 : options.nodeCount,
            contentHash: "sha256:test",
            usage:
                options.usage === undefined
                    ? { upload: 100, download: 200, total: 1000, expire: 1790000000 }
                    : options.usage,
        });
    }

    const server = createServer(baseConfig(dataPath, options.config), {
        store,
        coordinator: createCoordinator(),
        fetchImpl: options.fetchImpl || createMockFetch({}),
        now: () => new Date("2026-09-10T00:00:00.000Z"),
    });
    await listen(server);

    return {
        base: "http://127.0.0.1:" + server.address().port,
        server,
        store,
        source,
        token: source.token,
        globalToken: store.getSettings().globalToken,
        async request(pathname, init) {
            const response = await fetch(this.base + pathname, init);
            const text = await response.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch (_e) {
                // Not every route answers JSON - the dialect targets do not.
            }
            return { response, text, json, status: response.status };
        },
        async close() {
            await closeServer(server);
            await store.flush();
        },
    };
}

describe("/sub/<token> — reaching a client", function () {
    let ctx;
    afterEach(async function () {
        if (ctx) await ctx.close();
        ctx = null;
    });

    it("serves a full sing-box config to a sing-box User-Agent", async function () {
        ctx = await serve();
        const { response, text, status } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(status).to.equal(200);
        expect(response.headers.get("content-type")).to.match(/application\/json/);

        const config = JSON.parse(text);
        expect(config.outbounds.map((o) => o.tag)).to.include.members([
            "香港 01",
            "日本 02",
        ]);
        expect(config.route).to.be.an("object");
    });

    it("serves Clash YAML to a Clash User-Agent without any ?target=", async function () {
        ctx = await serve();
        const { response, text, status } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "clash-verge/1.6.0" },
        });
        expect(status).to.equal(200);
        expect(response.headers.get("content-type")).to.match(/yaml/);
        expect(text).to.contain("proxies:");
        expect(text).to.contain("香港 01");
        expect(text).to.not.contain("outbounds");
    });

    it("serves a proxy list, not a sing-box config, to Shadowrocket", async function () {
        ctx = await serve();
        const { response, text, status } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "Shadowrocket/3378" },
        });
        expect(status).to.equal(200);
        expect(response.headers.get("content-type")).to.match(/text\/plain/);
        expect(text).to.contain("香港 01");
        expect(text).to.not.contain("outbounds");
    });

    it("serves URI lines when the uri dialect is asked for explicitly", async function () {
        ctx = await serve();
        const { text, status } = await ctx.request("/sub/" + ctx.token + "?target=uri", {
            headers: { "user-agent": "curl/8.0" },
        });
        expect(status).to.equal(200);
        expect(text).to.match(/^(ss|vmess|trojan):\/\//m);
    });

    it("lets ?target= pick the dialect for an unknown User-Agent", async function () {
        ctx = await serve();
        const { text, status } = await ctx.request(
            "/sub/" + ctx.token + "?target=clash",
            { headers: { "user-agent": "curl/8.0" } },
        );
        expect(status).to.equal(200);
        expect(text).to.contain("proxies:");
    });

    it("rejects an unknown User-Agent with the list of usable targets", async function () {
        ctx = await serve();
        const { json, status } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "curl/8.0" },
        });
        expect(status).to.equal(400);
        expect(json.ok).to.equal(false);
        expect(json.targets.map((t) => t.id)).to.include("sing-box");
        expect(json.targets.map((t) => t.id)).to.include("clash");
    });

    it("404s an unknown token", async function () {
        ctx = await serve();
        const { json, status } = await ctx.request("/sub/not-a-token");
        expect(status).to.equal(404);
        expect(json.error).to.match(/unknown subscription token/);
    });

    it("409s when nothing has been refreshed yet, which is distinguishable from a bad token", async function () {
        ctx = await serve({ seed: false });
        const { json, status } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(status).to.equal(409);
        expect(json.error).to.match(/no snapshot yet/);
    });

    it("switches to outbounds-only output on ?out=outbounds", async function () {
        ctx = await serve();
        const { text } = await ctx.request("/sub/" + ctx.token + "?out=outbounds", {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        const payload = JSON.parse(text);
        expect(payload).to.have.keys(["outbounds", "endpoints"]);
        expect(payload.outbounds.map((o) => o.tag)).to.include("香港 01");
    });

    it("assembles an ACL4SSR preset when ?acl= is given", async function () {
        ctx = await serve();
        const { text, status } = await ctx.request(
            "/sub/" + ctx.token + "?acl=acl4ssr-mini",
            { headers: { "user-agent": "sing-box/1.14.0" } },
        );
        expect(status).to.equal(200);
        const tags = JSON.parse(text).outbounds.map((o) => o.tag);
        // The preset names its own selector group rather than the default one.
        expect(tags.some((tag) => tag !== "proxy" && tag !== "auto")).to.equal(true);
    });

    it("honours ?mode=proxy", async function () {
        ctx = await serve();
        const { text } = await ctx.request("/sub/" + ctx.token + "?mode=proxy", {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        const config = JSON.parse(text);
        expect(config.inbounds.some((i) => i.type === "tun")).to.equal(false);
    });

    it("serves the merged view through the global token", async function () {
        ctx = await serve();
        const second = ctx.store.addSource({
            name: "备用",
            kind: "url",
            url: "https://other.test/sub",
        });
        ctx.store.writeSnapshot(second.id, nodesJson(["美国 03"]));

        const { text } = await ctx.request("/sub/" + ctx.globalToken, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(JSON.parse(text).outbounds.map((o) => o.tag)).to.include.members([
            "香港 01",
            "美国 03",
        ]);
    });

    it("excludes a disabled source from the global view but not from its own token", async function () {
        ctx = await serve();
        ctx.store.updateSource(ctx.source.id, { enabled: false });

        const global = await ctx.request("/sub/" + ctx.globalToken, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(global.status).to.equal(409);

        // The per-source URL was handed out on purpose, so it keeps working.
        const own = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(own.status).to.equal(200);
    });
});

describe("/sub/<token> — caching and HEAD", function () {
    let ctx;
    afterEach(async function () {
        if (ctx) await ctx.close();
        ctx = null;
    });

    it("answers HEAD with the same headers and no body", async function () {
        ctx = await serve();
        const get = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        const head = await ctx.request("/sub/" + ctx.token, {
            method: "HEAD",
            headers: { "user-agent": "sing-box/1.14.0" },
        });

        expect(head.status).to.equal(200);
        expect(head.text).to.equal("");
        expect(head.response.headers.get("etag")).to.equal(
            get.response.headers.get("etag"),
        );
        expect(head.response.headers.get("content-length")).to.equal(
            String(Buffer.byteLength(get.text, "utf8")),
        );
        expect(head.response.headers.get("last-modified")).to.equal(
            get.response.headers.get("last-modified"),
        );
    });

    it("returns 304 for a matching If-None-Match", async function () {
        ctx = await serve();
        const first = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        const etag = first.response.headers.get("etag");
        expect(etag).to.be.a("string");

        const second = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0", "if-none-match": etag },
        });
        expect(second.status).to.equal(304);
        expect(second.text).to.equal("");
        expect(second.response.headers.get("etag")).to.equal(etag);

        const changed = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0", "if-none-match": '"stale"' },
        });
        expect(changed.status).to.equal(200);
    });

    it("returns 304 for an If-Modified-Since at or after the last refresh", async function () {
        ctx = await serve();
        const lastModified = "Wed, 09 Sep 2026 12:00:00 GMT";
        const first = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(first.response.headers.get("last-modified")).to.equal(lastModified);

        const notModified = await ctx.request("/sub/" + ctx.token, {
            headers: {
                "user-agent": "sing-box/1.14.0",
                "if-modified-since": lastModified,
            },
        });
        expect(notModified.status).to.equal(304);

        const stale = await ctx.request("/sub/" + ctx.token, {
            headers: {
                "user-agent": "sing-box/1.14.0",
                "if-modified-since": "Tue, 01 Jan 2019 00:00:00 GMT",
            },
        });
        expect(stale.status).to.equal(200);
    });

    it("sends the plan quota so a client shows the traffic and expiry", async function () {
        ctx = await serve();
        const { response } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(response.headers.get("subscription-userinfo")).to.equal(
            "upload=100; download=200; total=1000; expire=1790000000",
        );
    });

    it("omits the quota header when it is switched off", async function () {
        ctx = await serve({ config: { subscription: { exposeUsageHeader: false } } });
        const { response } = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(response.headers.get("subscription-userinfo")).to.equal(null);
    });

    it("rejects a write method on the subscription address", async function () {
        ctx = await serve();
        const { status } = await ctx.request("/sub/" + ctx.token, { method: "DELETE" });
        expect(status).to.equal(405);
    });
});

describe("/api/subscriptions — management", function () {
    let ctx;
    afterEach(async function () {
        if (ctx) await ctx.close();
        ctx = null;
    });

    it("creates, lists, reads, edits and deletes a source", async function () {
        ctx = await serve();
        const created = await ctx.request("/api/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                name: "新机场",
                kind: "url",
                url: "https://new.test/sub?token=hidden",
            }),
        });
        expect(created.status).to.equal(200);
        const id = created.json.data.source.id;
        expect(created.json.data.source.url).to.contain("token=hidden");

        const listed = await ctx.request("/api/subscriptions");
        const row = listed.json.data.sources.find((s) => s.id === id);
        // The list redacts the query string but keeps the rest of the URL.
        expect(row.url).to.equal("https://new.test/sub?token=***");
        // subUrl carries the token, so it is the address the UI copies.
        expect(row.subUrl).to.equal(created.json.data.source.subUrl);
        expect(row.subUrl).to.match(/^\/sub\/\S+$/);
        expect(listed.json.data.globalSubUrl).to.match(/^\/sub\/\S+$/);
        expect(listed.json.data.targets.map((t) => t.id)).to.include("sing-box");

        const detail = await ctx.request("/api/subscriptions/" + id);
        expect(detail.json.data.source.url).to.contain("token=hidden");

        const edited = await ctx.request("/api/subscriptions/" + id, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "改名", enabled: false }),
        });
        expect(edited.json.data.source.name).to.equal("改名");
        expect(edited.json.data.source.enabled).to.equal(false);

        const removed = await ctx.request("/api/subscriptions/" + id, {
            method: "DELETE",
        });
        expect(removed.json.data.removed).to.equal(true);
        expect(ctx.store.get(id)).to.equal(null);
    });

    it("rejects a source with no url", async function () {
        ctx = await serve();
        const { status, json } = await ctx.request("/api/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "空", kind: "url", url: "" }),
        });
        expect(status).to.equal(400);
        expect(json.error).to.match(/non-empty url/);
    });

    it("refreshes one source through the API", async function () {
        const fresh = nodesJson(["新节点 01"]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-route-"));
        const dataPath = path.join(dir, "singbox-web.data.json");
        const store = createStore({ dataPath });
        const source = store.addSource({
            name: "A",
            kind: "url",
            url: "https://panel.test/sub",
        });
        const server = createServer(baseConfig(dataPath), {
            store,
            coordinator: createCoordinator(),
            fetchImpl: createMockFetch({
                "https://panel.test/sub": { status: 200, body: fresh },
            }),
        });
        await listen(server);
        const base = "http://127.0.0.1:" + server.address().port;

        try {
            const response = await fetch(
                base + "/api/subscriptions/" + source.id + "/refresh",
                { method: "POST" },
            );
            const payload = await response.json();
            expect(response.status).to.equal(200);
            expect(payload.data.ok).to.equal(true);
            expect(payload.data.source.nodeCount).to.equal(1);
            expect(store.readSnapshot(source.id)).to.equal(fresh);
        } finally {
            await closeServer(server);
            await store.flush();
        }
    });

    it("previews from cache without touching the network", async function () {
        ctx = await serve();
        const { json, status } = await ctx.request(
            "/api/subscriptions/" + ctx.source.id + "/preview",
        );
        expect(status).to.equal(200);
        expect(json.data.nodeCount).to.equal(2);
        expect(json.data.protocols).to.deep.equal({ ss: 2 });
        expect(json.data.nodes[0]).to.have.keys(["tag", "type", "server", "port", "kind"]);
    });

    it("409s a preview for a source that has never been refreshed", async function () {
        ctx = await serve({ seed: false });
        const { status } = await ctx.request(
            "/api/subscriptions/" + ctx.source.id + "/preview",
        );
        expect(status).to.equal(409);
    });

    it("rotates a token and stops serving the old address", async function () {
        ctx = await serve();
        const rotated = await ctx.request(
            "/api/subscriptions/" + ctx.source.id + "/rotate-token",
            { method: "POST" },
        );
        expect(rotated.json.data.subUrl).to.match(/^\/sub\//);

        const old = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(old.status).to.equal(404);

        const fresh = await ctx.request(rotated.json.data.subUrl, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(fresh.status).to.equal(200);
    });

    it("rejects an unknown id and an unknown action", async function () {
        ctx = await serve();
        expect((await ctx.request("/api/subscriptions/nope")).status).to.equal(404);
        expect(
            (await ctx.request("/api/subscriptions/" + ctx.source.id + "/nope")).status,
        ).to.equal(404);
    });

    it("guards the API when apiToken is set, leaving /sub open", async function () {
        ctx = await serve({ config: { apiToken: "s3cret" } });

        expect((await ctx.request("/api/subscriptions")).status).to.equal(401);

        const allowed = await ctx.request("/api/subscriptions", {
            headers: { authorization: "Bearer s3cret" },
        });
        expect(allowed.status).to.equal(200);

        // The subscription URL is a capability URL and stays reachable.
        const sub = await ctx.request("/sub/" + ctx.token, {
            headers: { "user-agent": "sing-box/1.14.0" },
        });
        expect(sub.status).to.equal(200);
    });
});

describe("/api/export — assembling from the store", function () {
    let ctx;
    afterEach(async function () {
        if (ctx) await ctx.close();
        ctx = null;
    });

    it("produces the same config as feeding the nodes to /api/convert", async function () {
        ctx = await serve();
        const exported = await ctx.request("/api/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [ctx.source.id] }),
        });
        expect(exported.status).to.equal(200);
        expect(exported.json.data.nodes).to.have.length(2);

        const converted = await ctx.request("/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: NODES, url: false }),
        });
        expect(converted.status).to.equal(200);
        expect(exported.json.data.output).to.deep.equal(converted.json.data.output);
    });

    it("honours an explicit id list, including a disabled source", async function () {
        ctx = await serve();
        const off = ctx.store.addSource({
            name: "停用",
            kind: "url",
            url: "https://off.test/sub",
            enabled: false,
        });
        ctx.store.writeSnapshot(off.id, nodesJson(["停用节点"]));

        const { json } = await ctx.request("/api/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [off.id] }),
        });
        expect(json.data.nodes.map((n) => n.tag)).to.deep.equal(["停用节点"]);
    });

    it("409s when the selected sources have no snapshot", async function () {
        ctx = await serve({ seed: false });
        const { status, json } = await ctx.request("/api/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [ctx.source.id] }),
        });
        expect(status).to.equal(409);
        expect(json.ok).to.equal(false);
    });

    it("exports a non-sing-box dialect as text", async function () {
        ctx = await serve();
        const { json } = await ctx.request("/api/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [ctx.source.id], target: "clash" }),
        });
        expect(json.data.output).to.be.a("string");
        expect(json.data.output).to.contain("proxies:");
    });
});
