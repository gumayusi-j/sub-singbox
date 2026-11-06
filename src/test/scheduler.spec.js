import { expect } from "chai";
import { createStore } from "../subscription/store";
import { createCoordinator } from "../subscription/coordinator";
import { createScheduler, inferProfileFromFileName } from "../subscription/scheduler";
import { createMockFetch } from "./helpers/mock-fetch";
import fs from "fs";
import os from "os";
import path from "path";

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

describe("Subscription Scheduler & Automation", function () {
    let tmpDir;
    let store;
    let coordinator;

    beforeEach(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-scheduler-test-"));
        store = createStore({
            dataPath: path.join(tmpDir, "data.json"),
            snapshotsDir: path.join(tmpDir, "snapshots"),
        });
        coordinator = createCoordinator();
    });

    afterEach(function () {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_e) {}
    });

    it("initializes scheduler and respects interval configuration", function () {
        const scheduler = createScheduler({
            store,
            coordinator,
            config: { scheduler: { intervalMinutes: 30 } },
        });

        const status = scheduler.getStatus();
        expect(status.enabled).to.be.true;
        expect(status.intervalMinutes).to.equal(30);

        scheduler.setIntervalMinutes(15);
        expect(scheduler.getStatus().intervalMinutes).to.equal(15);

        scheduler.stop();
        expect(scheduler.getStatus().nextRunAt).to.be.null;
    });

    it("runs job, refreshes sources and falls back on error", async function () {
        const mockFetch = createMockFetch({
            "https://example.com/good": {
                status: 200,
                headers: { "subscription-userinfo": "upload=100; download=200; total=1000" },
                body: nodesJson(["香港 01"]),
            },
            "https://example.com/failing": {
                status: 500,
                body: "Internal Server Error",
            },
        });

        const goodSource = store.addSource({
            name: "Good Source",
            kind: "url",
            url: "https://example.com/good",
        });

        const failingSource = store.addSource({
            name: "Failing Source",
            kind: "url",
            url: "https://example.com/failing",
        });
        // Pre-populate failingSource with a previous snapshot
        store.writeSnapshot(failingSource.id, nodesJson(["旧节点"]));
        store.patchSource(failingSource.id, {
            nodeCount: 1,
            lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;
        expect(result.totalSources).to.equal(2);

        // Good source updated
        const updatedGood = store.get(goodSource.id);
        expect(updatedGood.nodeCount).to.equal(1);
        expect(store.readSnapshot(goodSource.id)).to.include("香港 01");

        // Failing source gracefully retained its previous snapshot (fallback)
        const keptFailing = store.get(failingSource.id);
        expect(keptFailing.nodeCount).to.equal(1);
        expect(store.readSnapshot(failingSource.id)).to.include("旧节点");
        expect(keptFailing.lastError).to.not.be.null;
    });

    it("triggers Gist sync when sources change and Gist credentials exist", async function () {
        let gistPatched = false;
        let gistPayload = null;

        const mockFetch = createMockFetch({
            "https://example.com/sub": {
                status: 200,
                headers: {},
                body: nodesJson(["香港 01"]),
            },
            "https://api.github.com/gists/test-gist-id": (req) => {
                gistPatched = true;
                // createMockFetch doesn't parse req.body if not passed in request, but let's check
                return {
                    status: 200,
                    body: JSON.stringify({ ok: true }),
                };
            },
        });

        // Configure Gist in store settings with autoSync: true
        store.setSettings({
            gist: { id: "test-gist-id", token: "ghp_secretToken123", autoSync: true },
        });

        store.addSource({
            name: "Gist Test Source",
            kind: "url",
            url: "https://example.com/sub",
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;
        expect(gistPatched).to.be.true;
        expect(result.gistSync).to.not.be.null;
        expect(result.gistSync.ok).to.be.true;
    });

    it("skips Gist sync when autoSync is not explicitly enabled", async function () {
        let gistPatched = false;

        const mockFetch = createMockFetch({
            "https://example.com/sub": {
                status: 200,
                headers: {},
                body: nodesJson(["香港 02"]),
            },
            "https://api.github.com/gists/test-gist-id": () => {
                gistPatched = true;
                return { status: 200, body: JSON.stringify({ ok: true }) };
            },
        });

        // Configure Gist credentials without autoSync
        store.setSettings({
            gist: { id: "test-gist-id", token: "ghp_secretToken123" },
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;
        expect(gistPatched).to.be.false;
        expect(result.gistSync).to.be.null;
    });
    it("auto-updates configurations specified in gist.syncProfiles based on refreshed subscription nodes", async function () {
        let syncedFiles = null;

        const mockFetch = createMockFetch({
            "https://example.com/sub": {
                status: 200,
                headers: {},
                body: nodesJson(["香港 01", "台湾 01"]),
            },
            "https://api.github.com/gists/test-gist-id": (req) => {
                if (req && req.body) {
                    try {
                        const parsed = JSON.parse(req.body);
                        syncedFiles = parsed.files;
                    } catch (e) {}
                }
                return { status: 200, body: JSON.stringify({ ok: true }) };
            },
        });

        store.setSettings({
            gist: {
                id: "test-gist-id",
                token: "ghp_secretToken123",
                syncProfiles: [
                    {
                        fileName: "我的Anywhere-节点.txt",
                        target: "anywhere",
                        out: "outbounds",
                    },
                ],
            },
        });

        store.addSource({
            name: "My Source",
            kind: "url",
            url: "https://example.com/sub",
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;
        expect(result.gistSync).to.not.be.null;
        expect(result.gistSync.files).to.include("我的Anywhere-节点.txt");
        expect(result.gistSync.files).to.not.include("singbox-config.json");
        expect(result.gistSync.files).to.not.include("clash-config.yaml");
    });

    it("refreshes ALL sources including disabled ones, while global config only includes enabled ones", async function () {
        let syncedGistBody = null;
        const mockFetch = createMockFetch({
            "https://example.com/enabled": {
                status: 200,
                headers: {},
                body: nodesJson(["启用节点-香港"]),
            },
            "https://example.com/disabled": {
                status: 200,
                headers: {},
                body: nodesJson(["未启用节点-美国"]),
            },
            "https://api.github.com/gists/test-gist-id": (req) => {
                if (req && req.body) {
                    try {
                        syncedGistBody = JSON.parse(req.body);
                    } catch (e) {}
                }
                return { status: 200, body: JSON.stringify({ ok: true }) };
            },
        });

        const enabledSource = store.addSource({
            name: "Enabled Source",
            kind: "url",
            url: "https://example.com/enabled",
            enabled: true,
        });

        const disabledSource = store.addSource({
            name: "Disabled Source",
            kind: "url",
            url: "https://example.com/disabled",
            enabled: false,
        });

        store.setSettings({
            gist: {
                id: "test-gist-id",
                token: "ghp_secretToken123",
                syncProfiles: [
                    {
                        fileName: "global-anywhere.txt",
                        target: "anywhere",
                        out: "outbounds",
                    },
                ],
            },
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;

        // Verify ALL sources (both enabled and disabled) were refreshed and updated
        expect(store.readSnapshot(enabledSource.id)).to.include("启用节点-香港");
        expect(store.readSnapshot(disabledSource.id)).to.include("未启用节点-美国");

        // Verify Gist configuration generated according to enabled state:
        // Global configuration should only include enabled nodes, not disabled ones
        expect(syncedGistBody).to.not.be.null;
        const gistFileContent = syncedGistBody.files["global-anywhere.txt"].content;
        expect(decodeURIComponent(gistFileContent)).to.include("启用节点-香港");
        expect(decodeURIComponent(gistFileContent)).to.not.include("未启用节点-美国");
    });

    it("persists scheduler interval in store settings and defaults to 360 minutes", function () {
        const defaultScheduler = createScheduler({ store, coordinator });
        expect(defaultScheduler.getStatus().intervalMinutes).to.equal(360);

        defaultScheduler.setIntervalMinutes(720);
        expect(defaultScheduler.getStatus().intervalMinutes).to.equal(720);
        expect(store.getSettings().scheduler.intervalMinutes).to.equal(720);
    });

    it("correctly infers profile parameters from Gist filenames for multiple sources", function () {
        const sources = [
            { id: "src-bbxy", name: "bbxy" },
            { id: "src-naiyun", name: "naiyun" },
        ];

        const p1 = inferProfileFromFileName("bbxy-anywhere-nodes.txt", sources);
        expect(p1.sourceId).to.equal("src-bbxy");
        expect(p1.target).to.equal("anywhere");
        expect(p1.out).to.equal("outbounds");

        const p2 = inferProfileFromFileName("bbxy-egern-nodes.yaml", sources);
        expect(p2.sourceId).to.equal("src-bbxy");
        expect(p2.target).to.equal("egern");
        expect(p2.out).to.equal("outbounds");

        const p3 = inferProfileFromFileName("bbxy-loon-nodes.conf", sources);
        expect(p3.sourceId).to.equal("src-bbxy");
        expect(p3.target).to.equal("loon");
        expect(p3.out).to.equal("outbounds");

        const p4 = inferProfileFromFileName("bbxy-singbox-config.json", sources);
        expect(p4.sourceId).to.equal("src-bbxy");
        expect(p4.target).to.equal("sing-box");
        expect(p4.out).to.equal("config");

        const p5 = inferProfileFromFileName("bbxy-stash-config.yaml", sources);
        expect(p5.sourceId).to.equal("src-bbxy");
        expect(p5.target).to.equal("stash");
        expect(p5.out).to.equal("config");

        const p6 = inferProfileFromFileName("bbxy-surfboard-nodes.conf", sources);
        expect(p6.sourceId).to.equal("src-bbxy");
        expect(p6.target).to.equal("surfboard");
        expect(p6.out).to.equal("config");

        const p7 = inferProfileFromFileName("naiyun-anywhere-nodes.txt", sources);
        expect(p7.sourceId).to.equal("src-naiyun");
        expect(p7.target).to.equal("anywhere");
        expect(p7.out).to.equal("outbounds");

        const p8 = inferProfileFromFileName("naiyun-singbox-config.json", sources);
        expect(p8.sourceId).to.equal("src-naiyun");
        expect(p8.target).to.equal("sing-box");
        expect(p8.out).to.equal("config");
    });

    it("auto-reconciles all Gist files into syncProfiles and syncs all 8 files", async function () {
        const srcBbxy = store.addSource({
            name: "bbxy",
            kind: "text",
            content: nodesJson(["香港-01", "日本-02"]),
        });
        const srcNaiyun = store.addSource({
            name: "naiyun",
            kind: "text",
            content: nodesJson(["美国-01", "新加坡-02"]),
        });

        const gistFilesMap = {
            "bbxy-anywhere-nodes.txt": { content: "old" },
            "bbxy-egern-nodes.yaml": { content: "old" },
            "bbxy-loon-nodes.conf": { content: "old" },
            "bbxy-singbox-config.json": { content: "old" },
            "bbxy-stash-config.yaml": { content: "old" },
            "bbxy-surfboard-nodes.conf": { content: "old" },
            "naiyun-anywhere-nodes.txt": { content: "old" },
            "naiyun-singbox-config.json": { content: "old" },
        };

        let syncedGistFiles = null;
        const mockFetch = createMockFetch({
            "https://api.github.com/gists/test-gist-id": (req) => {
                if (req && req.method === "GET") {
                    return {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: "test-gist-id", files: gistFilesMap }),
                    };
                }
                if (req && req.method === "PATCH") {
                    const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
                    syncedGistFiles = Object.keys(parsed.files);
                    return {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ok: true }),
                    };
                }
                return { status: 404, body: "Not found" };
            },
        });

        // Initially syncProfiles only has 4 items
        store.setSettings({
            gist: {
                id: "test-gist-id",
                token: "ghp_secretToken123",
                syncProfiles: [
                    { fileName: "naiyun-singbox-config.json", target: "sing-box", out: "config", sourceId: srcNaiyun.id },
                    { fileName: "naiyun-anywhere-nodes.txt", target: "anywhere", out: "outbounds", sourceId: srcNaiyun.id },
                    { fileName: "bbxy-loon-nodes.conf", target: "loon", out: "outbounds", sourceId: srcBbxy.id },
                    { fileName: "bbxy-anywhere-nodes.txt", target: "anywhere", out: "outbounds", sourceId: srcBbxy.id },
                ],
            },
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob({ forceSyncGist: true });
        expect(result.ok).to.be.true;

        // Verify that all 8 files were discovered, reconciled and synced
        expect(syncedGistFiles).to.have.lengthOf(8);
        expect(syncedGistFiles).to.include.members(Object.keys(gistFilesMap));

        // Verify that store settings now contains all 8 syncProfiles
        const updatedProfiles = store.getSettings().gist.syncProfiles;
        expect(updatedProfiles).to.have.lengthOf(8);
    });

    it("generates sing-box config with inherited aclPreset and rules in automated scheduler run", async function () {
        let syncedSingboxConfig = null;
        const mockFetch = createMockFetch({
            "https://example.com/sub1": {
                status: 200,
                headers: {},
                body: nodesJson(["香港 01", "日本 02"]),
            },
            "https://example.com/sub2": {
                status: 200,
                headers: {},
                body: nodesJson(["美国 01", "新加坡 02"]),
            },
            "https://api.github.com/gists/test-gist-id": (req) => {
                if (req && req.body) {
                    try {
                        const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
                        if (parsed.files && parsed.files["合并-singbox-config.json"]) {
                            syncedSingboxConfig = JSON.parse(parsed.files["合并-singbox-config.json"].content);
                        }
                    } catch (e) {}
                }
                return { status: 200, body: JSON.stringify({ ok: true }) };
            },
        });

        // Set global default aclPreset to acl4ssr-mini via setDefaultOptions
        store.setDefaultOptions({ aclPreset: "acl4ssr-mini" });
        store.setSettings({
            gist: {
                id: "test-gist-id",
                token: "ghp_secretToken123",
                syncProfiles: [
                    {
                        fileName: "合并-singbox-config.json",
                        target: "sing-box",
                        out: "config",
                        sourceId: "", // 全量合并
                        aclPreset: "", // 未单独指定，应继承全局 acl4ssr-mini
                    },
                ],
            },
        });

        store.addSource({
            name: "Sub1",
            kind: "url",
            url: "https://example.com/sub1",
            enabled: true,
        });
        store.addSource({
            name: "Sub2",
            kind: "url",
            url: "https://example.com/sub2",
            enabled: true,
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob();
        expect(result.ok).to.be.true;
        expect(syncedSingboxConfig).to.not.be.null;

        // Verify that sing-box configuration includes nodes from BOTH sources (full merge)
        const outboundTags = (syncedSingboxConfig.outbounds || []).map((o) => o.tag);
        expect(outboundTags.some((t) => t.includes("香港 01"))).to.be.true;
        expect(outboundTags.some((t) => t.includes("美国 01"))).to.be.true;

        // Verify that aclPreset was NOT overwritten by empty string, but generated ACL rule groups
        expect(outboundTags).to.include("🚀 节点选择");
        expect(outboundTags).to.include("🐟 漏网之鱼");
        expect(syncedSingboxConfig.route).to.exist;
        expect(syncedSingboxConfig.route.rules).to.be.an("array").that.is.not.empty;
    });

    it("correctly identifies 合并- and 全量- prefixes as global merged configuration", function () {
        const sources = [{ id: "src-1", name: "机场A" }];
        const p1 = inferProfileFromFileName("合并-2源-singbox-config.json", sources);
        expect(p1.sourceId).to.equal("");
        expect(p1.target).to.equal("sing-box");

        const p2 = inferProfileFromFileName("全量-singbox-config.json", sources);
        expect(p2.sourceId).to.equal("");
        expect(p2.target).to.equal("sing-box");
    });

    it("ignores standalone client configs like MyEgern.yaml and MyLoon.conf and removes them from syncProfiles", async function () {
        const sources = [{ id: "src-1", name: "MySub" }];
        expect(inferProfileFromFileName("MyEgern.yaml", sources)).to.be.null;
        expect(inferProfileFromFileName("MyLoon.conf", sources)).to.be.null;
        expect(inferProfileFromFileName("README.md", sources)).to.be.null;

        let patchedFiles = [];
        const mockFetch = createMockFetch({
            "https://example.com/sub": {
                status: 200,
                headers: {},
                body: nodesJson(["香港 01"]),
            },
            "https://api.github.com/gists/test-gist-id": (req) => {
                if (req && req.method === "GET") {
                    return {
                        status: 200,
                        body: JSON.stringify({
                            files: {
                                "MyEgern.yaml": { content: "# static egern config" },
                                "MyLoon.conf": { content: "# static loon config" },
                                "singbox-config.json": { content: "{}" },
                            },
                        }),
                    };
                }
                if (req && req.method === "PATCH") {
                    const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
                    if (parsed && parsed.files) {
                        patchedFiles = Object.keys(parsed.files);
                    }
                    return { status: 200, body: JSON.stringify({ ok: true }) };
                }
                return { status: 200, body: JSON.stringify({ ok: true }) };
            },
        });

        // Pre-populate store with corrupted syncProfiles containing MyEgern.yaml and MyLoon.conf
        store.setSettings({
            gist: {
                id: "test-gist-id",
                token: "ghp_secretToken123",
                syncProfiles: [
                    { fileName: "MyEgern.yaml", target: "egern", out: "config" },
                    { fileName: "MyLoon.conf", target: "loon", out: "outbounds" },
                    { fileName: "singbox-config.json", target: "sing-box", out: "config" },
                ],
            },
        });

        store.addSource({
            name: "MySub",
            kind: "url",
            url: "https://example.com/sub",
            enabled: true,
        });

        const scheduler = createScheduler({
            store,
            coordinator,
            fetchImpl: mockFetch,
        });

        const result = await scheduler.runJob({ forceSyncGist: true });
        expect(result.ok).to.be.true;

        // MyEgern.yaml and MyLoon.conf should be sanitized and NEVER touched/overwritten by automated scheduler
        expect(patchedFiles).to.not.include("MyEgern.yaml");
        expect(patchedFiles).to.not.include("MyLoon.conf");
        expect(patchedFiles).to.include("singbox-config.json");

        // The store settings syncProfiles must also have cleaned them out
        const savedProfiles = (store.getSettings().gist.syncProfiles || []).map((p) => p.fileName);
        expect(savedProfiles).to.not.include("MyEgern.yaml");
        expect(savedProfiles).to.not.include("MyLoon.conf");
        expect(savedProfiles).to.include("singbox-config.json");
    });
});
