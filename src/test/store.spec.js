import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { createStore } from "@/subscription/store";

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sbx-store-"));
}

function newStore(extra) {
    const dir = tempDir();
    const dataPath = path.join(dir, "singbox-web.data.json");
    return { store: createStore(Object.assign({ dataPath }, extra || {})), dir, dataPath };
}

describe("subscription store", function () {
    it("creates a data file only once something is written, with a global token", async function () {
        const { store, dataPath } = newStore();
        // load() alone must not touch the disk, so a read-only deployment never
        // materialises a file just by being started.
        expect(fs.existsSync(dataPath)).to.equal(false);
        expect(store.getSettings().globalToken).to.be.a("string").with.length.above(20);

        store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        await store.flush();
        expect(fs.existsSync(dataPath)).to.equal(true);
    });

    it("round-trips sources through the data file", async function () {
        const { store, dataPath } = newStore();
        const added = store.addSource({
            name: "主机场",
            kind: "url",
            url: "https://example.test/sub?token=abc",
            requestOptions: { userAgent: "Custom/1.0", headers: { "X-Token": "1" } },
        });
        await store.flush();

        const reopened = createStore({ dataPath });
        const sources = reopened.list();
        expect(sources).to.have.length(1);
        expect(sources[0].id).to.equal(added.id);
        expect(sources[0].name).to.equal("主机场");
        expect(sources[0].enabled).to.equal(true);
        expect(sources[0].requestOptions.userAgent).to.equal("Custom/1.0");
        expect(sources[0].requestOptions.headers).to.deep.equal({ "X-Token": "1" });
        expect(sources[0].token).to.equal(added.token);
    });

    it("rejects a source with no url or content", function () {
        const { store } = newStore();
        expect(() => store.addSource({ name: "空", kind: "url", url: "  " })).to.throw(
            /non-empty url/,
        );
        expect(() => store.addSource({ name: "空", kind: "text" })).to.throw(
            /non-empty content/,
        );
    });

    it("generates distinct tokens per source", function () {
        const { store } = newStore();
        const a = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const b = store.addSource({ name: "B", kind: "url", url: "https://b.test/sub" });
        expect(a.token).to.not.equal(b.token);
        expect(a.token).to.not.equal(store.getSettings().globalToken);
    });

    it("resolves the global token before a source token", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const global = store.getSettings().globalToken;

        expect(store.resolveToken(global)).to.deep.equal({ kind: "global" });
        expect(store.resolveToken(source.token).kind).to.equal("source");
        expect(store.resolveToken(source.token).source.id).to.equal(source.id);
        expect(store.resolveToken("nope")).to.equal(null);
        expect(store.resolveToken("")).to.equal(null);
    });

    it("invalidates the old token on rotation", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const old = source.token;
        const rotated = store.rotateToken(source.id);
        expect(rotated.scope).to.equal("source");
        expect(store.resolveToken(old)).to.equal(null);
        expect(store.resolveToken(rotated.token).source.id).to.equal(source.id);
    });

    it("rotates the global token independently", function () {
        const { store } = newStore();
        const old = store.getSettings().globalToken;
        const rotated = store.rotateToken(null);
        expect(rotated.scope).to.equal("global");
        expect(store.resolveToken(old)).to.equal(null);
        expect(store.resolveToken(rotated.token)).to.deep.equal({ kind: "global" });
    });

    it("keeps the token and id stable across an edit", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const updated = store.updateSource(source.id, { name: "改名了" });
        expect(updated.id).to.equal(source.id);
        expect(updated.token).to.equal(source.token);
        expect(updated.name).to.equal("改名了");
        expect(updated.createdAt).to.equal(source.createdAt);
    });

    it("clears the content hash when the url changes, so a refresh re-parses", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        store.patchSource(source.id, { contentHash: "sha256:deadbeef" });
        expect(store.get(source.id).contentHash).to.equal("sha256:deadbeef");

        store.updateSource(source.id, { url: "https://a.test/other" });
        expect(store.get(source.id).contentHash).to.equal(null);
    });

    it("keeps the content hash through a refresh patch", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        store.patchSource(source.id, { contentHash: "sha256:abc", nodeCount: 3 });
        expect(store.get(source.id).contentHash).to.equal("sha256:abc");
        expect(store.get(source.id).nodeCount).to.equal(3);
    });

    it("deletes a source together with its snapshot", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const snapshotPath = store.writeSnapshot(source.id, "vmess://AAAA");
        expect(fs.existsSync(snapshotPath)).to.equal(true);

        expect(store.removeSource(source.id)).to.equal(true);
        expect(store.get(source.id)).to.equal(null);
        expect(fs.existsSync(snapshotPath)).to.equal(false);
        expect(store.removeSource(source.id)).to.equal(false);
    });

    it("reads back a snapshot verbatim", function () {
        const { store } = newStore();
        const source = store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        const body = "ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#node\n";
        store.writeSnapshot(source.id, body);
        expect(store.readSnapshot(source.id)).to.equal(body);
        expect(store.readSnapshot("missing")).to.equal(null);
    });

    it("does not let a hostile id escape the snapshots directory", function () {
        const { store } = newStore();
        const written = store.writeSnapshot("../../evil", "x");
        expect(path.dirname(written)).to.equal(store.snapshotsDir);
    });

    it("serialises concurrent mutations without losing any", async function () {
        const { store } = newStore();
        await Promise.all(
            Array.from({ length: 20 }, (_v, i) =>
                Promise.resolve().then(() =>
                    store.addSource({
                        name: "S" + i,
                        kind: "url",
                        url: "https://h" + i + ".test/sub",
                    }),
                ),
            ),
        );
        await store.flush();
        expect(store.list()).to.have.length(20);
    });

    it("leaves no .tmp file behind and keeps a .bak of the previous revision", async function () {
        const { store, dataPath } = newStore();
        store.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        await store.flush();
        store.addSource({ name: "B", kind: "url", url: "https://b.test/sub" });
        await store.flush();

        expect(fs.existsSync(dataPath + ".tmp")).to.equal(false);
        expect(fs.existsSync(dataPath + ".bak")).to.equal(true);
        // The backup is the revision before the latest write.
        const backup = JSON.parse(fs.readFileSync(dataPath + ".bak", "utf8"));
        expect(backup.sources).to.have.length(1);
    });

    it("backs up an unparseable data file and starts empty instead of throwing", function () {
        const { dataPath, dir } = newStore();
        fs.writeFileSync(dataPath, "{ this is not json");

        const messages = [];
        const reopened = createStore({ dataPath, logger: (m) => messages.push(m) });
        expect(reopened.list()).to.deep.equal([]);
        expect(reopened.getSettings().globalToken).to.be.a("string");

        const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
        expect(backups).to.have.length(1);
        expect(messages.join("\n")).to.match(/not valid JSON/);
    });

    it("fills in a missing token and id when loading an older file", function () {
        const { dataPath } = newStore();
        fs.writeFileSync(
            dataPath,
            JSON.stringify({
                version: 1,
                settings: { defaultOptions: { mode: "proxy" } },
                sources: [{ name: "老数据", kind: "url", url: "https://old.test/sub" }],
            }),
        );
        const store = createStore({ dataPath });
        const sources = store.list();
        expect(sources).to.have.length(1);
        expect(sources[0].id).to.be.a("string").with.length.above(0);
        expect(sources[0].token).to.be.a("string").with.length.above(20);
        expect(sources[0].enabled).to.equal(true);
        expect(store.getSettings().defaultOptions).to.deep.equal({ mode: "proxy" });
    });

    it("warns instead of silently clobbering when another writer touched the file", async function () {
        const { dataPath } = newStore();
        const messages = [];
        const watched = createStore({ dataPath, logger: (m) => messages.push(m) });
        watched.addSource({ name: "A", kind: "url", url: "https://a.test/sub" });
        await watched.flush();

        // Simulate a second process appending to the same document.
        const onDisk = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        onDisk.sources.push({ id: "other", name: "B", kind: "url", url: "https://b.test/sub" });
        fs.writeFileSync(dataPath, JSON.stringify(onDisk));

        watched.addSource({ name: "C", kind: "url", url: "https://c.test/sub" });
        await watched.flush();
        expect(messages.join("\n")).to.match(/changed on disk/);
    });

    it("hands out a defensive copy from read()", function () {
        const { store } = newStore();
        const snapshot = store.read();
        snapshot.sources.push({ id: "injected" });
        expect(store.list()).to.have.length(0);
    });
});
