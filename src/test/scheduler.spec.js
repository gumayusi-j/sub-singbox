import { expect } from "chai";
import { createStore } from "../subscription/store";
import { createCoordinator } from "../subscription/coordinator";
import { createScheduler } from "../subscription/scheduler";
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
});
