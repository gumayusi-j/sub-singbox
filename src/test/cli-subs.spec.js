import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { createStore } from "@/subscription/store";
import { runSubs, pickSource, defaultBase } from "@/kit/cli-subs";
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

// The commands write to stdout/stderr; collecting them is the whole assertion
// surface, so no child process is needed (or wanted - spawning is slow and
// behaves differently across platforms).
function harness(options) {
    options = options || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-cli-"));
    const store = createStore({ dataPath: path.join(dir, "singbox-web.data.json") });
    const out = [];
    const err = [];
    const config = {
        listen: { host: "127.0.0.1", port: 8788 },
        defaultOut: "config",
        remoteDns: "",
        subscription: { defaultTarget: "sing-box" },
    };
    return {
        store,
        out,
        err,
        stdout: () => out.join("\n"),
        stderr: () => err.join("\n"),
        run: (argv) => {
            // Each command gets a clean buffer, so a test that runs "add" and
            // then "list" asserts on the list output alone.
            out.length = 0;
            err.length = 0;
            return runSubs(argv, {
                store,
                config,
                stdout: (t) => out.push(t),
                stderr: (t) => err.push(t),
                fetchImpl: options.fetchImpl,
                now: options.now,
            });
        },
    };
}

describe("singbox-kit subs — source references", function () {
    const sources = [
        { id: "aaaa1111", name: "主机场" },
        { id: "bbbb2222", name: "备用机场" },
        { id: "cccc3333", name: "主机场备份" },
    ];

    it("resolves an exact id, then an exact name, then a unique prefix", function () {
        expect(pickSource(sources, "bbbb2222").id).to.equal("bbbb2222");
        expect(pickSource(sources, "备用机场").id).to.equal("bbbb2222");
        expect(pickSource(sources, "bbbb").id).to.equal("bbbb2222");
    });

    it("refuses an ambiguous reference rather than guessing", function () {
        // An exact name still wins even when it is a prefix of another source.
        expect(pickSource(sources, "主机场").id).to.equal("aaaa1111");
        // But a bare prefix matching two sources is refused, not guessed.
        expect(() => pickSource(sources, "主")).to.throw(/ambiguous/);
    });

    it("reports an unknown reference", function () {
        expect(() => pickSource(sources, "nope")).to.throw(/no source matches/);
        expect(() => pickSource(sources, "")).to.throw(/required/);
    });
});

describe("singbox-kit subs — store commands", function () {
    it("adds, lists, disables and removes a source", async function () {
        const h = harness();

        expect(await h.run(["add", "主机场", "https://a.test/sub"])).to.equal(0);
        expect(h.stdout()).to.match(/已添加/);
        expect(h.store.list()).to.have.length(1);

        expect(await h.run(["list"])).to.equal(0);
        expect(h.stdout()).to.contain("主机场");
        expect(h.stdout()).to.contain("尚未刷新");

        const id = h.store.list()[0].id;
        expect(await h.run(["disable", id])).to.equal(0);
        expect(h.store.get(id).enabled).to.equal(false);

        expect(await h.run(["enable", "主机场"])).to.equal(0);
        expect(h.store.get(id).enabled).to.equal(true);

        expect(await h.run(["rm", id])).to.equal(0);
        expect(h.store.list()).to.deep.equal([]);
    });

    it("adds an inline text source and carries the request options", async function () {
        const h = harness();
        expect(
            await h.run([
                "add", "手动", NODES, "--text",
                "--ua", "Custom/1.0", "--header", "X-Token: 1", "--timeout", "5000",
            ]),
        ).to.equal(0);

        const source = h.store.list()[0];
        expect(source.kind).to.equal("text");
        expect(source.content).to.equal(NODES);
        expect(source.requestOptions.userAgent).to.equal("Custom/1.0");
        expect(source.requestOptions.headers).to.deep.equal({ "X-Token": "1" });
        expect(source.requestOptions.timeout).to.equal(5000);
    });

    it("emits the whole model as JSON", async function () {
        const h = harness();
        await h.run(["add", "A", "https://a.test/sub"]);
        expect(await h.run(["list", "--json"])).to.equal(0);
        const model = JSON.parse(h.stdout());
        expect(model.sources).to.have.length(1);
        expect(model.settings.globalToken).to.be.a("string");
    });

    it("rejects an add with no body", async function () {
        const h = harness();
        expect(await h.run(["add", "空"])).to.equal(1);

        // A literal "-" reads stdin, which is empty under the test runner.
        expect(await h.run(["add", "空", "-"])).to.equal(1);
        expect(h.stderr()).to.match(/订阅内容为空/);
    });

    it("rotates tokens and prints the new address", async function () {
        const h = harness();
        await h.run(["add", "A", "https://a.test/sub"]);
        const before = h.store.getSettings().globalToken;

        expect(await h.run(["rotate-token"])).to.equal(0);
        expect(h.store.getSettings().globalToken).to.not.equal(before);
        expect(h.stdout()).to.match(/\/sub\//);

        const id = h.store.list()[0].id;
        const sourceBefore = h.store.get(id).token;
        expect(await h.run(["rotate-token", id])).to.equal(0);
        expect(h.store.get(id).token).to.not.equal(sourceBefore);
    });
});

describe("singbox-kit subs — refresh and inspect", function () {
    it("refreshes every enabled source and reports each line", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": { status: 200, body: NODES },
        });
        const h = harness({ fetchImpl });
        await h.run(["add", "主机场", "https://a.test/sub"]);

        expect(await h.run(["refresh", "--all"])).to.equal(0);
        expect(h.stdout()).to.match(/已更新\s+主机场/);
        expect(h.store.list()[0].nodeCount).to.equal(2);
    });

    it("exits non-zero when a refresh fails, and says why", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/sub": { status: 500, body: "boom" },
        });
        const h = harness({ fetchImpl });
        await h.run(["add", "坏源", "https://a.test/sub"]);

        expect(await h.run(["refresh", "--all"])).to.equal(1);
        expect(h.stdout()).to.match(/失败\s+坏源/);
        expect(h.stdout()).to.match(/HTTP 500/);
    });

    it("refreshes only the named sources", async function () {
        const fetchImpl = createMockFetch({
            "https://a.test/1": { status: 200, body: NODES },
            "https://b.test/2": { status: 200, body: NODES },
        });
        const h = harness({ fetchImpl });
        await h.run(["add", "甲", "https://a.test/1"]);
        await h.run(["add", "乙", "https://b.test/2"]);

        expect(await h.run(["refresh", "甲"])).to.equal(0);
        expect(fetchImpl.calls).to.have.length(1);
    });

    it("shows node count, protocols, quota and the subscription address", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        const id = h.store.list()[0].id;
        h.store.writeSnapshot(id, NODES);
        h.store.patchSource(id, {
            nodeCount: 2,
            protocols: { ss: 2 },
            lastUpdatedAt: "2026-09-09T12:00:00.000Z",
            usage: { upload: 100, download: 200, total: 1000, expire: 1790000000 },
        });

        expect(await h.run(["show", "主机场"])).to.equal(0);
        const text = h.stdout();
        expect(text).to.contain("主机场");
        expect(text).to.contain("ss ×2");
        expect(text).to.contain("已用 300 B/1000 B");
        expect(text).to.contain("更新    2026-09-09T12:00:00.000Z");
        expect(text).to.match(/地址\s+\/sub\/\S+/);
    });

    it("shows the last error when a refresh failed", async function () {
        const h = harness();
        await h.run(["add", "坏源", "https://a.test/sub"]);
        const id = h.store.list()[0].id;
        h.store.patchSource(id, {
            lastError: { message: "HTTP 403", status: 403, at: "2026-09-10T00:00:00.000Z" },
        });
        await h.run(["show", "坏源"]);
        expect(h.stdout()).to.contain("错误    HTTP 403");
        expect(h.stdout()).to.contain("更新    从未");
    });

    it("prints the subscription URL with the configured base and target", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);

        expect(await h.run(["url"])).to.equal(0);
        expect(h.stdout()).to.equal(
            "http://127.0.0.1:8788/sub/" + h.store.getSettings().globalToken,
        );

        await h.run(["url", "主机场", "--base", "http://box.lan", "--target", "clash"]);
        expect(h.stdout()).to.equal(
            "http://box.lan/sub/" + h.store.list()[0].token + "?target=clash",
        );
    });

    it("falls back to loopback when the server listens on a wildcard", function () {
        expect(defaultBase({ listen: { host: "0.0.0.0", port: 80 } })).to.equal(
            "http://127.0.0.1:80",
        );
        expect(defaultBase({ listen: { host: "::", port: 8080 } })).to.equal(
            "http://127.0.0.1:8080",
        );
        expect(defaultBase({ listen: { host: "192.168.1.5", port: 80 } })).to.equal(
            "http://192.168.1.5:80",
        );
    });
});

describe("singbox-kit subs — export", function () {
    it("writes a complete sing-box config to stdout", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        h.store.writeSnapshot(h.store.list()[0].id, NODES);

        expect(await h.run(["export"])).to.equal(0);
        const config = JSON.parse(h.stdout());
        expect(config.outbounds.map((o) => o.tag)).to.include.members([
            "香港 01",
            "日本 02",
        ]);
        // The mode layer and the downloader hardening both survive the round trip.
        expect(config.experimental.clash_api.default_mode).to.equal("规则判定");
        expect(config.http_clients[0].domain_resolver).to.equal("local");
    });

    it("exports only the named sources, and only those nodes", async function () {
        const h = harness();
        await h.run(["add", "甲", "https://a.test/1"]);
        await h.run(["add", "乙", "https://b.test/2"]);
        const [first, second] = h.store.list();
        h.store.writeSnapshot(first.id, nodesJson(["甲节点"]));
        h.store.writeSnapshot(second.id, nodesJson(["乙节点"]));

        expect(await h.run(["export", "甲"])).to.equal(0);
        const tags = JSON.parse(h.stdout()).outbounds.map((o) => o.tag);
        expect(tags).to.include("甲节点");
        expect(tags).to.not.include("乙节点");
    });

    it("exports a non-sing-box dialect as text", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        h.store.writeSnapshot(h.store.list()[0].id, NODES);

        expect(await h.run(["export", "--target", "clash"])).to.equal(0);
        expect(h.stdout()).to.contain("proxies:");
    });

    it("applies an ACL4SSR preset", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        h.store.writeSnapshot(h.store.list()[0].id, NODES);

        expect(await h.run(["export", "--acl", "acl4ssr-mini"])).to.equal(0);
        const tags = JSON.parse(h.stdout()).outbounds.map((o) => o.tag);
        expect(tags).to.include("🚀 节点选择");
    });

    it("fails with a readable message when nothing has been refreshed", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        expect(await h.run(["export"])).to.equal(1);
        expect(h.stderr()).to.match(/no snapshot yet/);
    });

    it("rejects an unknown dialect instead of picking one", async function () {
        const h = harness();
        await h.run(["add", "主机场", "https://a.test/sub"]);
        h.store.writeSnapshot(h.store.list()[0].id, NODES);
        expect(await h.run(["export", "--target", "clsh"])).to.equal(1);
        expect(h.stderr()).to.match(/unknown target/);
    });
});

describe("singbox-kit subs — dispatch", function () {
    it("prints usage for an unknown command and for no command", async function () {
        const h = harness();
        expect(await h.run(["nonsense"])).to.equal(1);
        expect(h.stderr()).to.match(/未知子命令/);

        const empty = harness();
        expect(await empty.run([])).to.equal(1);
        expect(empty.stdout()).to.match(/Usage: singbox-kit subs/);

        const help = harness();
        expect(await help.run(["--help"])).to.equal(0);
        expect(help.stdout()).to.match(/Usage: singbox-kit subs/);
    });

    it("reports a bad option instead of ignoring it", async function () {
        const h = harness();
        expect(await h.run(["list", "--nope"])).to.equal(1);
        expect(h.stderr()).to.match(/unknown option/);

        const bad = harness();
        expect(await bad.run(["add", "A", "u", "--header", "oops"])).to.equal(1);
        expect(bad.stderr()).to.match(/invalid --header/);
    });
});
