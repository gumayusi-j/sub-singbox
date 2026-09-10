// `singbox-kit subs …` — the subscription store from a terminal.
//
// The point of this is unattended use: a cron job can run
//   singbox-kit subs refresh --all && singbox-kit subs export > config.json
// and never open a browser. It shares the store, the refresh engine and the
// renderer with the web server, so it is not a second implementation.
//
// Every command is reachable as an exported function taking an injected `io`,
// which is how the tests drive it - spawning a Node child per assertion would
// be slow and platform-dependent.

import { readFileSync } from "fs";
import { createStore } from "../subscription/store";
import { createCoordinator } from "../subscription/coordinator";
import { refreshMany } from "../subscription/refresh";
import { renderSubscription } from "../subscription/render";
import { resolveTarget, listTargets } from "../subscription/targets";
import { usageSummary } from "../subscription/usage";
import { loadConfig, resolveDataPath } from "../web/config";

export const SUBS_USAGE = [
    "Usage: singbox-kit subs <command> [options]",
    "",
    "  list [--json]                 list sources and their state",
    "  add <name> <url|->            add a URL source ('-' reads the value from stdin)",
    "  add <name> <text|-> --text    add an inline text source",
    "        [--ua <ua>] [--header <name:value>] [--timeout <ms>] [--disabled]",
    "  rm <id|name>                  delete a source",
    "  enable|disable <id|name>      include or exclude it from the merged view",
    "  refresh [<id|name>...] [--all]",
    "  show <id|name>                node count, protocols, quota, last error",
    "  url [<id|name>] [--target <dialect>] [--base <origin>]",
    "  export [<id|name>...] [--target <dialect>] [--out config|outbounds] [--acl <id>]",
    "  rotate-token [<id|name>]      replace the global (or one source's) token",
    "",
    "Global options:",
    "  --data <path>                 subscription data file (default: <cwd>/singbox-web.data.json)",
].join("\n");

function readStdin() {
    try {
        return readFileSync(0, "utf8");
    } catch (_e) {
        return "";
    }
}

export function parseArgs(argv) {
    const args = { _: [], headers: {} };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--json") args.json = true;
        else if (a === "--help" || a === "-h") args.help = true;
        else if (a === "--all") args.all = true;
        else if (a === "--text") args.text = true;
        else if (a === "--disabled") args.disabled = true;
        else if (a === "--data") args.data = argv[++i];
        else if (a === "--ua") args.ua = argv[++i];
        else if (a === "--timeout") args.timeout = Number(argv[++i]);
        else if (a === "--target") args.target = argv[++i];
        else if (a === "--out") args.out = argv[++i];
        else if (a === "--acl") args.acl = argv[++i];
        else if (a === "--mode") args.mode = argv[++i];
        else if (a === "--base") args.base = argv[++i];
        else if (a === "--header") {
            const pair = String(argv[++i] || "");
            const idx = pair.indexOf(":");
            if (idx <= 0) throw new Error("invalid --header (expected name:value): " + pair);
            args.headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        } else if (a.startsWith("-") && a !== "-") {
            throw new Error("unknown option: " + a);
        } else {
            args._.push(a);
        }
    }
    return args;
}

// Accept an exact id, then an exact name, then an unambiguous prefix.
export function pickSource(sources, ref) {
    if (typeof ref !== "string" || ref === "") {
        throw new Error("a source id or name is required");
    }
    const exactId = sources.find((s) => s.id === ref);
    if (exactId) return exactId;

    const exactName = sources.filter((s) => s.name === ref);
    if (exactName.length === 1) return exactName[0];
    if (exactName.length > 1) {
        throw new Error(
            "several sources are named '" + ref + "': " +
                exactName.map((s) => s.id).join(", "),
        );
    }

    const prefix = sources.filter((s) => s.id.startsWith(ref) || s.name.startsWith(ref));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length === 0) throw new Error("no source matches '" + ref + "'");
    throw new Error(
        "'" + ref + "' is ambiguous: " +
            prefix.map((s) => s.name + " (" + s.id + ")").join(", "),
    );
}

function formatBytes(n) {
    if (n == null) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(n);
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
    }
    return (i === 0 ? value : value.toFixed(1)) + " " + units[i];
}

function statusText(source) {
    if (source.lastError) return "失败：" + source.lastError.message;
    if (source.lastUpdatedAt) return source.nodeCount + " 个节点 · " + source.lastUpdatedAt;
    if (source.lastCheckedAt) return "已检查，内容未变化 · " + source.lastCheckedAt;
    return "尚未刷新";
}

function quotaText(source, now) {
    const summary = usageSummary(source.usage, now);
    if (!summary) return null;
    const parts = summary.unlimited
        ? ["已用 " + formatBytes(summary.used) + "/不限量"]
        : ["已用 " + formatBytes(summary.used) + "/" + formatBytes(summary.total)];
    if (summary.daysLeft != null) {
        parts.push(summary.expired ? "已到期" : "剩余 " + summary.daysLeft + " 天");
    }
    return parts.join(" · ");
}

// The list is what a human reads, so it is one line per source; --json is what
// a script reads.
function sourceLine(source, now) {
    const parts = [
        source.enabled ? "[x]" : "[ ]",
        source.id,
        source.name,
        "(" + source.kind + ")",
        statusText(source),
    ];
    const quota = quotaText(source, now);
    if (quota) parts.push(quota);
    return parts.join("  ");
}

// 0.0.0.0 and :: are listen addresses, not reachable ones.
export function defaultBase(config) {
    const listen = (config && config.listen) || {};
    const host =
        !listen.host || listen.host === "0.0.0.0" || listen.host === "::"
            ? "127.0.0.1"
            : listen.host;
    return "http://" + host + ":" + (listen.port || 8788);
}

function resolveTargetEntry(requested, config) {
    const fallback =
        (config && config.subscription && config.subscription.defaultTarget) ||
        "sing-box";
    const resolved = resolveTarget({ queryTarget: requested || fallback });
    if (!resolved) {
        throw new Error(
            "unknown target '" + (requested || fallback) + "'; known: " +
                listTargets().map((t) => t.id).join(", "),
        );
    }
    return resolved.target;
}

export async function runSubs(argv, io) {
    io = io || {};
    const stdout = io.stdout || ((text) => process.stdout.write(text + "\n"));
    const stderr = io.stderr || ((text) => process.stderr.write(text + "\n"));
    const now = io.now || (() => new Date());
    const config = io.config || loadConfig();

    // Parsing sits inside its own guard so a bad option becomes a message and
    // an exit code rather than an unhandled rejection.
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        stderr(e && e.message ? e.message : String(e));
        return 1;
    }
    const command = args._.shift();
    if (args.help || command === "help") {
        stdout(SUBS_USAGE);
        return 0;
    }
    if (!command) {
        stdout(SUBS_USAGE);
        return 1;
    }

    const store = io.store || createStore({ dataPath: args.data || resolveDataPath(config) });
    const deps = {
        fetchImpl: io.fetchImpl,
        coordinator: io.coordinator || createCoordinator(),
        now,
    };

    try {
        switch (command) {
            case "list": {
                const sources = store.list();
                if (args.json) {
                    stdout(JSON.stringify(store.read(), null, 2));
                    return 0;
                }
                if (sources.length === 0) {
                    stdout("（还没有订阅源）");
                    return 0;
                }
                for (const source of sources) stdout(sourceLine(source, now()));
                return 0;
            }

            case "add": {
                const name = args._[0];
                let body = args._[1];
                if (!name || body === undefined) {
                    stderr("用法：subs add <名称> <URL|-> [--text] [其他选项]");
                    return 1;
                }
                if (body === "-") body = readStdin().trim();
                if (!body) {
                    stderr("订阅内容为空。");
                    return 1;
                }
                const created = store.addSource({
                    name,
                    kind: args.text ? "text" : "url",
                    url: args.text ? "" : body,
                    content: args.text ? body : null,
                    enabled: !args.disabled,
                    requestOptions: {
                        userAgent: args.ua || null,
                        headers: args.headers,
                        timeout: Number.isFinite(args.timeout) ? args.timeout : null,
                    },
                });
                stdout("已添加 " + created.id + "  " + created.name);
                stdout("订阅地址：" + (args.base || "") + "/sub/" + created.token);
                return 0;
            }

            case "rm": {
                const source = pickSource(store.list(), args._[0]);
                store.removeSource(source.id);
                stdout("已删除 " + source.name);
                return 0;
            }

            case "enable":
            case "disable": {
                const source = pickSource(store.list(), args._[0]);
                store.updateSource(source.id, { enabled: command === "enable" });
                stdout((command === "enable" ? "已启用 " : "已停用 ") + source.name);
                return 0;
            }

            case "refresh": {
                const refs = args._.slice();
                const ids =
                    refs.length > 0 && !args.all
                        ? refs.map((ref) => pickSource(store.list(), ref).id)
                        : null;
                const result = await refreshMany(store, ids, deps);
                for (const entry of result.results) {
                    const latest = store.get(entry.id);
                    stdout(
                        (entry.ok ? (entry.changed ? "已更新  " : "无变化  ") : "失败    ") +
                            (latest ? latest.name : entry.id) +
                            (entry.ok ? "" : "  " + (entry.error && entry.error.message)),
                    );
                }
                for (const id of result.skipped) stderr("跳过未知来源 " + id);
                return result.ok ? 0 : 1;
            }

            case "show": {
                const source = pickSource(store.list(), args._[0]);
                stdout("名称    " + source.name);
                stdout("id      " + source.id);
                stdout("类型    " + source.kind + (source.kind === "url" ? "  " + source.url : ""));
                stdout("状态    " + (source.enabled ? "参与导出" : "已停用"));
                const protocols = Object.keys(source.protocols || {}).sort();
                stdout(
                    "节点    " + source.nodeCount +
                        (protocols.length
                            ? "  " + protocols
                                .map((p) => p + " ×" + source.protocols[p]).join(" · ")
                            : ""),
                );
                const quota = quotaText(source, now());
                if (quota) stdout("流量    " + quota);
                stdout("更新    " + (source.lastUpdatedAt || "从未"));
                stdout("检查    " + (source.lastCheckedAt || "从未"));
                if (source.lastError) stdout("错误    " + source.lastError.message);
                stdout("地址    /sub/" + source.token);
                return 0;
            }

            case "url": {
                const ref = args._[0];
                const source = ref ? pickSource(store.list(), ref) : null;
                const token = source ? source.token : store.getSettings().globalToken;
                const base = args.base || defaultBase(config);
                const target = args.target
                    ? "?target=" + encodeURIComponent(args.target)
                    : "";
                stdout(base + "/sub/" + token + target);
                return 0;
            }

            case "rotate-token": {
                const ref = args._[0];
                const source = ref ? pickSource(store.list(), ref) : null;
                const rotated = store.rotateToken(source ? source.id : null);
                stdout("新地址：" + (args.base || "") + "/sub/" + rotated.token);
                return 0;
            }

            case "export": {
                const refs = args._.slice();
                const ids = refs.map((ref) => pickSource(store.list(), ref).id);
                const target = resolveTargetEntry(args.target, config);
                const rendered = renderSubscription(store, { kind: "global" }, {
                    target,
                    out: args.out || config.defaultOut,
                    aclPreset: args.acl,
                    mode: args.mode,
                    remoteDns: config.remoteDns,
                    sourceIds: ids.length > 0 ? ids : null,
                    idsExact: ids.length > 0,
                    usageHeader: false,
                });
                if (rendered.status !== 200) {
                    stderr(
                        rendered.body && rendered.body.error
                            ? rendered.body.error
                            : "导出失败（HTTP " + rendered.status + "）",
                    );
                    return 1;
                }
                stdout(
                    typeof rendered.body === "string"
                        ? rendered.body
                        : JSON.stringify(rendered.body, null, 2),
                );
                for (const warning of rendered.warnings || []) {
                    stderr("注意：" + warning.message);
                }
                return 0;
            }

            default:
                stderr("未知子命令：" + command);
                stderr(SUBS_USAGE);
                return 1;
        }
    } catch (e) {
        stderr(e && e.message ? e.message : String(e));
        return 1;
    } finally {
        await store.flush();
    }
}

export default { runSubs, SUBS_USAGE, pickSource, defaultBase, parseArgs };
