import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { createStore } from "@/subscription/store";
import { createCoordinator } from "@/subscription/coordinator";
import { refreshSource, refreshMany, groupByHost, LOCAL_LANE } from "@/subscription/refresh";
import { createMockFetch, pendingForever } from "./helpers/mock-fetch";

// A JSON array is the simplest body tryLoadNodeDocument accepts, and it lets a
// test state its node count exactly.
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

const NODES_A = nodesJson(["香港 01", "香港 02"]);
const NODES_B = nodesJson(["日本 01"]);
// Parses cleanly to an empty node list, which is what triggers a UA retry.
const NO_NODES = JSON.stringify({ proxies: [] });

const UA_HEADER = "user-agent";

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(options) {
    options = options || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-refresh-"));
    let clock = options.startClock || 1700000000000;
    const store = createStore({
        dataPath: path.join(dir, "singbox-web.data.json"),
        now: () => new Date(clock),
    });
    const coordinator = createCoordinator();
    const deps = {
        fetchImpl: options.fetchImpl,
        coordinator,
        now: () => new Date(clock),
    };
    return {
        store,
        coordinator,
        deps,
        dir,
        advance: (ms) => {
            clock += ms;
        },
    };
}

describe("subscription refresh — a healthy source", function () {
    it("stores the raw body, the node count and the protocol mix", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": {
                status: 200,
                headers: { "subscription-userinfo": "upload=10; download=20; total=100" },
                body: NODES_A,
            },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(true);
        expect(result.changed).to.equal(true);

        // The snapshot is the untouched body, not a parse result - that is what
        // lets /sub render other client dialects later.
        expect(ctx.store.readSnapshot(source.id)).to.equal(NODES_A);

        const saved = ctx.store.get(source.id);
        expect(saved.nodeCount).to.equal(2);
        // Keys are the internal mihomo type names ("ss", not "shadowsocks"),
        // because that is what both the URI parser and a Clash YAML document
        // hand back - the sing-box spelling only appears at produce time.
        expect(saved.protocols).to.deep.equal({ ss: 2 });
        expect(saved.lastError).to.equal(null);
        expect(saved.usage.upload).to.equal(10);
        expect(saved.usage.download).to.equal(20);
        expect(saved.lastUpdatedAt).to.equal(saved.lastCheckedAt);
    });

    it("reports unchanged content without moving lastUpdatedAt", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": { status: 200, body: NODES_A },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const first = await refreshSource(ctx.store, source.id, ctx.deps);
        const firstUpdatedAt = first.source.lastUpdatedAt;
        const firstCheckedAt = first.source.lastCheckedAt;

        ctx.advance(60000);
        const second = await refreshSource(ctx.store, source.id, ctx.deps);

        expect(second.ok).to.equal(true);
        expect(second.changed).to.equal(false);
        expect(second.source.lastUpdatedAt).to.equal(firstUpdatedAt);
        expect(second.source.lastCheckedAt).to.not.equal(firstCheckedAt);
        expect(second.source.nodeCount).to.equal(2);
    });

    it("bumps lastUpdatedAt when the content really changes", async function () {
        let body = NODES_A;
        const fetchImpl = createMockFetch({
            "https://a.test/sub": () => ({ status: 200, body }),
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const first = await refreshSource(ctx.store, source.id, ctx.deps);
        ctx.advance(60000);
        body = NODES_B;
        const second = await refreshSource(ctx.store, source.id, ctx.deps);

        expect(second.changed).to.equal(true);
        expect(second.source.lastUpdatedAt).to.not.equal(first.source.lastUpdatedAt);
        expect(second.source.nodeCount).to.equal(1);
        expect(ctx.store.readSnapshot(source.id)).to.equal(NODES_B);
    });

    it("handles an inline text source without touching the network", async function () {
        const fetchImpl = createMockFetch({});
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "手动",
            kind: "text",
            content: NODES_A,
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(true);
        expect(result.source.nodeCount).to.equal(2);
        expect(fetchImpl.calls).to.have.length(0);
        expect(ctx.store.readSnapshot(source.id)).to.equal(NODES_A);
    });
});

describe("subscription refresh — User-Agent fallback", function () {
    it("retries once with the fallback UA when the panel gates the default", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": (req) =>
                req.headers[UA_HEADER].includes("Shadowrocket")
                    ? { status: 200, body: NODES_A }
                    : { status: 403, body: "wrong client" },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(true);
        expect(fetchImpl.calls).to.have.length(2);
        expect(fetchImpl.calls[0].headers[UA_HEADER]).to.equal("clash.meta/v1.19.23");
        expect(fetchImpl.calls[1].headers[UA_HEADER]).to.match(/^Shadowrocket\//);
        expect(ctx.store.get(source.id).lastError).to.equal(null);
    });

    it("retries when the body parses to zero nodes", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": (req) =>
                req.headers[UA_HEADER].includes("Shadowrocket")
                    ? { status: 200, body: NODES_A }
                    : { status: 200, body: NO_NODES },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(true);
        expect(fetchImpl.calls).to.have.length(2);
    });

    it("does not retry when the user pinned a User-Agent", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": { status: 403, body: "nope" },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
            requestOptions: { userAgent: "MyClient/1.0" },
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(false);
        expect(fetchImpl.calls).to.have.length(1);
        expect(fetchImpl.calls[0].headers[UA_HEADER]).to.equal("MyClient/1.0");
    });

    it("does not retry on a status a retry cannot fix", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": { status: 404, body: "gone" },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(false);
        expect(fetchImpl.calls).to.have.length(1);
        expect(result.error.status).to.equal(404);
    });
});

describe("subscription refresh — failure keeps the last good data", function () {
    it("records lastError and leaves the snapshot and timestamp alone", async function () {
        let failing = false;
        const fetchImpl = createMockFetch({
            "https://a.test/sub": () =>
                failing ? { status: 500, body: "boom" } : { status: 200, body: NODES_A },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const good = await refreshSource(ctx.store, source.id, ctx.deps);
        failing = true;
        ctx.advance(60000);
        const bad = await refreshSource(ctx.store, source.id, ctx.deps);

        expect(bad.ok).to.equal(false);
        expect(bad.error.message).to.match(/HTTP 500/);
        expect(ctx.store.readSnapshot(source.id)).to.equal(NODES_A);

        const saved = ctx.store.get(source.id);
        expect(saved.nodeCount).to.equal(2);
        expect(saved.lastUpdatedAt).to.equal(good.source.lastUpdatedAt);
        expect(saved.lastError.message).to.match(/HTTP 500/);
        expect(saved.lastError.status).to.equal(500);
        expect(saved.lastError.at).to.be.a("string");
        // lastAttemptAt moves even though nothing was committed.
        expect(saved.lastAttemptAt).to.not.equal(good.source.lastAttemptAt);
    });

    it("clears lastError once a refresh succeeds again", async function () {
        let failing = true;
        const fetchImpl = createMockFetch({
            "https://a.test/sub": () =>
                failing ? { status: 503, body: "x" } : { status: 200, body: NODES_A },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        await refreshSource(ctx.store, source.id, ctx.deps);
        expect(ctx.store.get(source.id).lastError).to.not.equal(null);

        failing = false;
        await refreshSource(ctx.store, source.id, ctx.deps);
        expect(ctx.store.get(source.id).lastError).to.equal(null);
    });

    it("times out rather than hanging, and writes nothing", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": (req) => pendingForever(req),
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
            requestOptions: { timeout: 50 },
        });

        const result = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(result.ok).to.equal(false);
        expect(result.error.message).to.match(/timeout after 50ms/);
        expect(ctx.store.readSnapshot(source.id)).to.equal(null);
    });

    it("reports a missing source instead of throwing", async function () {
        const ctx = setup({ fetchImpl: createMockFetch({}) });
        const result = await refreshSource(ctx.store, "nope", ctx.deps);
        expect(result.ok).to.equal(false);
        expect(result.error.message).to.match(/source not found/);
    });
});

describe("subscription refresh — concurrency", function () {
    it("serialises sources on one host and runs different hosts in parallel", async function () {
        // Starts and ends are kept in separate maps: one Map keyed by label
        // would have each entry's start overwritten by its own end.
        const starts = new Map();
        const ends = new Map();
        const route = (label) => async () => {
            starts.set(label, Date.now());
            await delay(40);
            ends.set(label, Date.now());
            return { status: 200, body: NODES_A };
        };
        const fetchImpl = createMockFetch({
            "https://same.test/1": route("same-1"),
            "https://same.test/2": route("same-2"),
            "https://other.test/1": route("other-1"),
        });
        const ctx = setup({ fetchImpl });
        const s1 = ctx.store.addSource({ name: "1", kind: "url", url: "https://same.test/1" });
        const s2 = ctx.store.addSource({ name: "2", kind: "url", url: "https://same.test/2" });
        const s3 = ctx.store.addSource({ name: "3", kind: "url", url: "https://other.test/1" });

        const result = await refreshMany(ctx.store, [s1.id, s2.id, s3.id], ctx.deps);
        expect(result.ok).to.equal(true);
        expect(result.results.map((r) => r.id)).to.deep.equal([s1.id, s2.id, s3.id]);

        // Same host: the second request cannot start before the first resolves.
        expect(starts.get("same-2")).to.be.at.least(ends.get("same-1"));
        // Different host: the two requests overlap.
        expect(starts.get("other-1")).to.be.below(ends.get("same-1"));
    });

    it("groups lanes by host and keeps text sources together", function () {
        const lanes = groupByHost([
            { id: "1", kind: "url", url: "https://a.test/x" },
            { id: "2", kind: "url", url: "https://a.test/y" },
            { id: "3", kind: "url", url: "https://a.test:8443/z" },
            { id: "4", kind: "text", content: "x" },
            { id: "5", kind: "url", url: "not a url" },
        ]);
        expect(lanes.get("a.test").map((s) => s.id)).to.deep.equal(["1", "2"]);
        expect(lanes.get("a.test:8443").map((s) => s.id)).to.deep.equal(["3"]);
        expect(lanes.get(LOCAL_LANE).map((s) => s.id)).to.deep.equal(["4", "5"]);
    });

    it("discards a slow refresh that a newer one has superseded", async function () {
        let releaseSlow;
        const slow = new Promise((resolve) => {
            releaseSlow = resolve;
        });
        const fetchImpl = createMockFetch({
            "https://a.test/slow": async () => {
                await slow;
                return { status: 200, body: NODES_A };
            },
            "https://a.test/fast": { status: 200, body: NODES_B },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/slow",
        });

        const slowRun = refreshSource(ctx.store, source.id, ctx.deps);
        // The newer request wins the ticket; the slow one is now obsolete.
        ctx.store.updateSource(source.id, { url: "https://a.test/fast" });
        const fastRun = await refreshSource(ctx.store, source.id, ctx.deps);
        expect(fastRun.ok).to.equal(true);

        releaseSlow();
        const stale = await slowRun;
        expect(stale.stale).to.equal(true);
        expect(stale.ok).to.equal(false);
        // The old response did not overwrite the newer snapshot.
        expect(ctx.store.readSnapshot(source.id)).to.equal(NODES_B);
        expect(ctx.store.get(source.id).nodeCount).to.equal(1);
    });

    it("marks a source as running while a refresh is in flight", async function () {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetchImpl = createMockFetch({
            "https://a.test/sub": async () => {
                await gate;
                return { status: 200, body: NODES_A };
            },
        });
        const ctx = setup({ fetchImpl });
        const source = ctx.store.addSource({
            name: "A",
            kind: "url",
            url: "https://a.test/sub",
        });

        const run = refreshSource(ctx.store, source.id, ctx.deps);
        expect(ctx.coordinator.isRunning(source.id)).to.equal(true);
        release();
        await run;
        expect(ctx.coordinator.isRunning(source.id)).to.equal(false);
    });
});

describe("subscription refresh — batch selection", function () {
    it("refreshes every enabled source and leaves disabled ones alone", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/1": { status: 200, body: NODES_A },
            "https://b.test/2": { status: 200, body: NODES_B },
        });
        const ctx = setup({ fetchImpl });
        const on = ctx.store.addSource({ name: "on", kind: "url", url: "https://a.test/1" });
        const off = ctx.store.addSource({
            name: "off",
            kind: "url",
            url: "https://b.test/2",
            enabled: false,
        });

        const result = await refreshMany(ctx.store, [], ctx.deps);
        expect(result.results.map((r) => r.id)).to.deep.equal([on.id]);
        expect(ctx.store.get(off.id).lastUpdatedAt).to.equal(null);
        expect(fetchImpl.calls).to.have.length(1);
    });

    it("collects failures without letting one stop the others", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/1": { status: 500, body: "boom" },
            "https://b.test/2": { status: 200, body: NODES_B },
        });
        const ctx = setup({ fetchImpl });
        const bad = ctx.store.addSource({ name: "坏", kind: "url", url: "https://a.test/1" });
        const good = ctx.store.addSource({ name: "好", kind: "url", url: "https://b.test/2" });

        const result = await refreshMany(ctx.store, [], ctx.deps);
        expect(result.ok).to.equal(false);
        expect(result.failed).to.have.length(1);
        expect(result.failed[0]).to.include({ id: bad.id, name: "坏" });
        expect(ctx.store.get(good.id).lastError).to.equal(null);
        expect(ctx.store.get(good.id).nodeCount).to.equal(1);
    });

    it("reports ids it was asked for but does not have", async function () {
        const ctx = setup({ fetchImpl: createMockFetch({}) });
        ctx.store.addSource({ name: "A", kind: "url", url: "https://a.test/1" });
        const result = await refreshMany(ctx.store, ["missing-id"], ctx.deps);
        expect(result.skipped).to.deep.equal(["missing-id"]);
        expect(result.results).to.deep.equal([]);
    });

    it("calls onProgress after each source completes", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/1": { status: 200, body: NODES_A },
            "https://b.test/2": { status: 200, body: NODES_B },
            "https://c.test/3": { status: 500, body: "boom" },
        });
        const ctx = setup({ fetchImpl });
        ctx.store.addSource({ name: "A源", kind: "url", url: "https://a.test/1" });
        ctx.store.addSource({ name: "B源", kind: "url", url: "https://b.test/2" });
        ctx.store.addSource({ name: "C源", kind: "url", url: "https://c.test/3" });

        const events = [];
        ctx.deps.onProgress = (ev) => { events.push(ev); };
        await refreshMany(ctx.store, [], ctx.deps);

        // Should have 1 start event + 3 progress events.
        expect(events.length).to.equal(4);
        expect(events[0]).to.deep.equal({ type: "start", total: 3 });
        // Each subsequent event has completed count.
        for (let i = 1; i <= 3; i++) {
            expect(events[i].completed).to.equal(i);
            expect(events[i].total).to.equal(3);
            expect(typeof events[i].sourceName).to.equal("string");
        }
        // One of them should be "failed".
        const statuses = events.slice(1).map((e) => e.status);
        expect(statuses).to.include("failed");
        expect(statuses.filter((s) => s === "ok")).to.have.length(2);
    });
});
