import { expect } from "chai";
import {
    cleanNoticeNodes,
    injectCountryFlags,
    applyQuickSettings,
    applyRegexRename,
    dedupeByAddress,
    executeNodePipeline,
    extractCountryFlag,
    stripExistingFlags,
} from "../kit/nodes/pipeline";
import { createStore } from "../subscription/store";
import { renderSubscription } from "../subscription/render";
import { resolveTarget } from "../subscription/targets";
import fs from "fs";
import os from "os";
import path from "path";

describe("Node Processing Pipeline (Operators)", function () {
    describe("cleanNoticeNodes", function () {
        it("filters out notice and dummy nodes while keeping valid nodes", function () {
            const raw = [
                { name: "官网：https://airport.com", server: "127.0.0.1", port: 0, type: "ss" },
                { name: "剩余流量：250 GB", server: "127.0.0.1", port: 1080, type: "vmess" },
                { name: "到期时间：2027-01-01", server: "0.0.0.0", port: 0, type: "trojan" },
                { name: "香港 01 [0.0x]", server: "1.1.1.1", port: 443, type: "vless" },
                { name: "香港 02 [1.0x]", server: "1.1.1.1", port: 443, type: "vless" },
                { name: "日本 01", server: "2.2.2.2", port: 8443, type: "shadowsocks" },
            ];

            const warnings = [];
            const result = cleanNoticeNodes(raw, warnings);
            expect(result).to.have.length(2);
            expect(result[0].name).to.equal("香港 02 [1.0x]");
            expect(result[1].name).to.equal("日本 01");
            expect(warnings).to.have.length(1);
            expect(warnings[0].message).to.include("4 个公告");
        });

        it("filters out domestic carrier mianliu / dummy fake HTTP proxies", function () {
            const raw = [
                {
                    name: "🇨🇳 南京移动",
                    type: "http",
                    server: "36.155.169.188",
                    port: 443,
                    headers: {
                        Host: "down.dingtalk.com:80",
                        "with-At": "down.dingtalk.com",
                        "X-T5-Auth": "2025848265",
                        "User-Agent": "okhttp/3.11.0 SP-engine/2.71.0",
                    },
                },
                {
                    name: "🇨🇳 广州电信",
                    type: "http",
                    server: "14.215.182.75",
                    port: 443,
                    headers: {
                        Host: "down.dingtalk.com:80",
                        "X-T5-Auth": "2025848265",
                    },
                },
                {
                    name: "普通可用代理",
                    type: "http",
                    server: "1.2.3.4",
                    port: 8080,
                    headers: {},
                },
            ];

            const warnings = [];
            const result = cleanNoticeNodes(raw, warnings);
            expect(result).to.have.length(1);
            expect(result[0].name).to.equal("普通可用代理");
            expect(warnings).to.have.length(1);
            expect(warnings[0].message).to.include("2 个公告");
        });
    });

    describe("injectCountryFlags", function () {
        it("injects proper country flag emoji without duplicating flags", function () {
            const nodes = [
                { name: "香港 01 高速", server: "1.2.3.4", port: 443 },
                { name: "日本-东京-02", server: "1.2.3.4", port: 443 },
                { name: "US Los Angeles BGP", server: "1.2.3.4", port: 443 },
                { name: "🇸🇬 新加坡 01", server: "1.2.3.4", port: 443 },
                { name: "台湾 01 🧋", server: "1.2.3.4", port: 443 },
                { name: "未知节点", server: "1.2.3.4", port: 443 },
            ];

            const result = injectCountryFlags(nodes);
            expect(result[0].name).to.equal("🇭🇰 香港 01 高速");
            expect(result[1].name).to.equal("🇯🇵 日本-东京-02");
            expect(result[2].name).to.equal("🇺🇸 US Los Angeles BGP");
            expect(result[3].name).to.equal("🇸🇬 新加坡 01");
            expect(result[4].name).to.equal("🧋 台湾 01");
            expect(result[5].name).to.equal("未知节点");
        });
    });

    describe("applyQuickSettings", function () {
        it("forces UDP, skip-cert-verify, and TFO", function () {
            const nodes = [
                { name: "Node A", server: "1.1.1.1", port: 443, tls: { enabled: true } },
            ];

            const updated = applyQuickSettings(nodes, {
                udp: true,
                skipCertVerify: true,
                tfo: true,
            });

            expect(updated[0].udp).to.be.true;
            expect(updated[0]["skip-cert-verify"]).to.be.true;
            expect(updated[0].tls.insecure).to.be.true;
            expect(updated[0].tfo).to.be.true;
            expect(updated[0]["tcp-fast-open"]).to.be.true;
        });
    });

    describe("applyRegexRename", function () {
        it("applies regex renaming rules in sequence", function () {
            const nodes = [
                { name: "【专线】香港 01 [1.0x]" },
                { name: "【普通】日本 02 [0.5x]" },
            ];

            const rules = [
                { pattern: "【[^】]+】", replacement: "" },
                { pattern: "\\[[^\\]]+\\]", replacement: "" },
            ];

            const renamed = applyRegexRename(nodes, rules);
            expect(renamed[0].name).to.equal("香港 01");
            expect(renamed[1].name).to.equal("日本 02");
        });
    });

    describe("dedupeByAddress", function () {
        it("deduplicates nodes with identical physical destination", function () {
            const nodes = [
                { name: "HK 01", type: "vmess", server: "1.2.3.4", port: 443, uuid: "abc" },
                { name: "HK 01 Backup", type: "vmess", server: "1.2.3.4", port: 443, uuid: "abc" },
                { name: "JP 01", type: "vmess", server: "1.2.3.4", port: 8443, uuid: "abc" },
            ];

            const warnings = [];
            const deduped = dedupeByAddress(nodes, warnings);
            expect(deduped).to.have.length(2);
            expect(deduped[0].name).to.equal("HK 01");
            expect(deduped[1].name).to.equal("JP 01");
            expect(warnings).to.have.length(1);
        });

        it("does NOT deduplicate nodes sharing relay host but with different region, SNI, or reality keys", function () {
            const nodes = [
                {
                    name: "🇭🇰 [vless]HK香港 Reality 01 x1",
                    type: "vless",
                    server: "1.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "a-star.edu.sg",
                    public_key: "g_zLZWBK-fEIIZlqvlajj7IayHCvnkdyzpidCOUaGko",
                    short_id: "3456f305",
                },
                {
                    name: "🇭🇰 [vless]HK香港 Reality 02 x1",
                    type: "vless",
                    server: "2.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "shingaku.mynavi.jp",
                    public_key: "Kje-ArJ9fAuFhe6oNpPsrsQ95ByWfN06Qvi0nU-WU3E",
                    short_id: "2765beb6",
                },
                {
                    name: "🇨🇳TW台湾 Reality 01 x1",
                    type: "vless",
                    server: "1.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "tw-target.com",
                },
                {
                    name: "🇯🇵JP日本 Reality 01 x1",
                    type: "vless",
                    server: "1.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "jp-target.com",
                },
                {
                    name: "🇸🇬SG新加坡 Reality 01 x1",
                    type: "vless",
                    server: "1.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "sg-target.com",
                },
                {
                    name: "🇩🇪DE德国 Reality 01 x1",
                    type: "vless",
                    server: "1.6rguyesfdhvbz.uk",
                    port: 443,
                    uuid: "7ceb06cc-83dd-4c5c-8582-045d00c21fa8",
                    sni: "de-target.com",
                },
            ];

            const warnings = [];
            const result = dedupeByAddress(nodes, warnings);
            // All 6 different regions/SNIs must be fully preserved!
            expect(result).to.have.length(6);
            expect(warnings).to.have.length(0);
        });
    });

    describe("executeNodePipeline", function () {
        it("executes full pipeline chain", function () {
            const raw = [
                { name: "剩余流量：500GB", server: "127.0.0.1", port: 0, type: "ss" },
                { name: "【专线】HK 香港 01", server: "1.2.3.4", port: 443, type: "ss", password: "p" },
                { name: "【专线】HK 香港 01 备用", server: "1.2.3.4", port: 443, type: "ss", password: "p" },
            ];

            const processed = executeNodePipeline(raw, {
                cleanNotice: true,
                renameRules: [{ pattern: "【专线】", replacement: "" }],
                injectFlags: true,
                quickSettings: { udp: true },
                dedupeAddress: true,
            });

            expect(processed).to.have.length(1);
            expect(processed[0].name).to.equal("🇭🇰 HK 香港 01");
            expect(processed[0].udp).to.be.true;
        });
    });

    describe("Integration in renderSubscription", function () {
        let tmpDir;
        let store;

        beforeEach(function () {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-pipeline-test-"));
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

        it("applies nodePipeline when rendering subscription", function () {
            const source = store.addSource({
                name: "Test Source",
                kind: "text",
                content: "ss://YWVzLTEyOC1nY206cGFzcw@1.2.3.4:443#%E9%A6%99%E6%B8%AF%2001\nss://YWVzLTEyOC1nY206cGFzcw@127.0.0.1:0#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A100G",
            });
            // write snapshot
            const snapshot = "ss://YWVzLTEyOC1nY206cGFzcw@1.2.3.4:443#%E9%A6%99%E6%B8%AF%2001\nss://YWVzLTEyOC1nY206cGFzcw@127.0.0.1:0#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A100G";
            store.writeSnapshot(source.id, snapshot);

            const resolved = resolveTarget({ queryTarget: "clash" });
            const rendered = renderSubscription(
                store,
                { kind: "global" },
                {
                    target: resolved.target,
                    nodePipeline: {
                        cleanNotice: true,
                        injectFlags: true,
                        quickSettings: { udp: true },
                    },
                }
            );

            expect(rendered.status).to.equal(200);
            expect(rendered.body).to.include("🇭🇰 香港 01");
            expect(rendered.body).to.not.include("剩余流量");
            expect(rendered.body).to.include("udp: true");
        });
    });
});
