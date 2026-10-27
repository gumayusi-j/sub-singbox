import { expect } from "chai";
import { createStore } from "../subscription/store";
import { renderSubscription } from "../subscription/render";
import { resolveTarget } from "../subscription/targets";
import { createCoordinator } from "../subscription/coordinator";
import { createSubscriptionRouter } from "../subscription/router";
import fs from "fs";
import os from "os";
import path from "path";

describe("Collections (组合订阅 / 场景化分组)", function () {
    let tmpDir;
    let store;

    beforeEach(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-collections-test-"));
        store = createStore({
            dataPath: path.join(tmpDir, "data.json"),
            snapshotsDir: path.join(tmpDir, "snapshots"),
        });
    });

    afterEach(function () {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_e) {}
    });

    it("supports collection lifecycle in store", function () {
        const col = store.addCollection({
            name: "办公专线",
            sourceIds: ["src-1", "src-2"],
            options: { out: "config", aclPreset: "mini" },
        });

        expect(col.id).to.be.a("string");
        expect(col.name).to.equal("办公专线");
        expect(col.token).to.be.a("string");
        expect(col.sourceIds).to.deep.equal(["src-1", "src-2"]);

        // list
        const list = store.listCollections();
        expect(list).to.have.length(1);
        expect(list[0].id).to.equal(col.id);

        // get
        const fetched = store.getCollection(col.id);
        expect(fetched.name).to.equal("办公专线");

        // update
        const updated = store.updateCollection(col.id, {
            name: "流媒体专用",
            sourceIds: ["src-2"],
        });
        expect(updated.name).to.equal("流媒体专用");
        expect(updated.sourceIds).to.deep.equal(["src-2"]);

        // rotate token
        const oldToken = col.token;
        const rotated = store.rotateCollectionToken(col.id);
        expect(rotated.token).to.not.equal(oldToken);

        // resolveToken
        const resolved = store.resolveToken(rotated.token);
        expect(resolved).to.not.be.null;
        expect(resolved.kind).to.equal("collection");
        expect(resolved.collection.id).to.equal(col.id);

        // remove
        const removed = store.removeCollection(col.id);
        expect(removed).to.be.true;
        expect(store.listCollections()).to.have.length(0);
        expect(store.resolveToken(rotated.token)).to.be.null;
    });

    it("renders only sources belonging to the collection", function () {
        // Create 2 sources
        const src1 = store.addSource({
            name: "Office Sub",
            kind: "text",
            content: "ss://YWVzLTEyOC1nY206cGFzcw@1.1.1.1:443#%E9%A6%99%E6%B8%AF%2001",
        });
        store.writeSnapshot(src1.id, "ss://YWVzLTEyOC1nY206cGFzcw@1.1.1.1:443#%E9%A6%99%E6%B8%AF%2001");

        const src2 = store.addSource({
            name: "Home Sub",
            kind: "text",
            content: "ss://YWVzLTEyOC1nY206cGFzcw@2.2.2.2:443#%E6%97%A5%E6%9C%AC%2001",
        });
        store.writeSnapshot(src2.id, "ss://YWVzLTEyOC1nY206cGFzcw@2.2.2.2:443#%E6%97%A5%E6%9C%AC%2001");

        // Create collection that only contains src1
        const col = store.addCollection({
            name: "Office Only",
            sourceIds: [src1.id],
            options: {
                nodePipeline: {
                    injectFlags: true,
                },
            },
        });

        const target = resolveTarget({ queryTarget: "clash" }).target;
        const rendered = renderSubscription(
            store,
            { kind: "collection", collection: col },
            { target }
        );

        expect(rendered.status).to.equal(200);
        expect(rendered.body).to.include("🇭🇰 香港 01");
        expect(rendered.body).to.not.include("日本 01");
    });

    it("handles collection API routes", async function () {
        const coordinator = createCoordinator();
        const router = createSubscriptionRouter({ store, coordinator });

        let statusCode = 0;
        let responseHeaders = {};
        let responseBody = "";

        const mockRes = () => ({
            setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; },
            writeHead(st, hd) { statusCode = st; responseHeaders = hd || {}; },
            get statusCode() { return statusCode; },
            set statusCode(v) { statusCode = v; },
            end(data) { responseBody = data ? String(data) : ""; },
        });

        // 1. POST /api/collections
        const createReq = {
            method: "POST",
            headers: {},
        };
        const res1 = mockRes();
        await router.handle(createReq, res1, {
            url: new URL("http://localhost/api/collections"),
            pathname: "/api/collections",
            readJsonBody: async () => ({ name: "游戏加速", sourceIds: ["s1"] }),
            sendJson: (res, code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); },
        });
        expect(statusCode).to.equal(201);
        const parsedCreate = JSON.parse(responseBody);
        expect(parsedCreate.ok).to.be.true;
        const createdId = parsedCreate.data.collection.id;
        const token = parsedCreate.data.collection.token;

        // 2. GET /api/collections
        const res2 = mockRes();
        await router.handle({ method: "GET", headers: {} }, res2, {
            url: new URL("http://localhost/api/collections"),
            pathname: "/api/collections",
            readJsonBody: async () => ({}),
            sendJson: (res, code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); },
        });
        expect(statusCode).to.equal(200);
        const parsedList = JSON.parse(responseBody);
        expect(parsedList.data.collections).to.have.length(1);
        expect(parsedList.data.collections[0].name).to.equal("游戏加速");

        // 3. DELETE /api/collections/:id
        const res3 = mockRes();
        await router.handle({ method: "DELETE", headers: {} }, res3, {
            url: new URL(`http://localhost/api/collections/${createdId}`),
            pathname: `/api/collections/${createdId}`,
            readJsonBody: async () => ({}),
            sendJson: (res, code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); },
        });
        expect(statusCode).to.equal(200);
        expect(store.listCollections()).to.have.length(0);
    });
});
