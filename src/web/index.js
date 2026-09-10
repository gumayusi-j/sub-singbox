// Launcher: starts the web UI server. Config via singbox-web.config.json
// (optional), HOST/PORT env, or command-line flags (highest precedence):
//   --port/-p <n>   listen port
//   --host <addr>   listen host
//   --config <path> alternative config file path
//   --help          show usage
// Listen config comes from singbox-web.config.json in the run/project dir
// (see README); command-line flags and HOST/PORT env override it.
import { start, loadConfig } from "./server";

function usage() {
    return [
        "Usage: node -r @babel/register -r ./preload src/web/index.js [options]",
        "",
        "Options:",
        "  --port <n>, -p <n>   listen port (source default 8788; the bundled app",
        "                       defaults to 80; PORT env / config file also apply)",
        "  --host <addr>        listen host (source default 127.0.0.1; the bundled",
        "                       app defaults to 0.0.0.0)",
        "  --config <path>      config JSON path (same as SINGBOX_WEB_CONFIG env)",
        "  --data <path>        subscription data file (same as SINGBOX_WEB_DATA env;",
        "                       default <cwd>/singbox-web.data.json)",
        "  --help               show this help",
    ].join("\n");
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--port" || a === "-p") args.port = Number(argv[++i]);
        else if (a === "--host") args.host = argv[++i];
        else if (a === "--config") args.config = argv[++i];
        else if (a === "--data") args.data = argv[++i];
        else if (a === "--help" || a === "-h") args.help = true;
        else if (a === "--") {
            // pnpm/npm may forward the trailing "--" separator verbatim; ignore it.
            continue;
        } else if (a.startsWith("-")) throw new Error("unknown option: " + a);
        else args._.push(a);
    }
    return args;
}

function isValidPort(port) {
    return Number.isInteger(port) && port > 0 && port < 65536;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stderr.write(usage() + "\n");
        process.exit(0);
    }
    if (args.config) process.env.SINGBOX_WEB_CONFIG = args.config;

    const config = loadConfig();
    // Command-line flags take precedence over env / config file / defaults.
    if (args.host) config.listen.host = args.host;
    if (args.data) config.dataPath = args.data;
    if (args.port !== undefined) {
        if (!isValidPort(args.port)) {
            throw new Error("invalid --port value: " + args.port);
        }
        config.listen.port = args.port;
    }

    const server = await start(config);
    const { host, port } = config.listen;
    process.stderr.write(
        "[singbox-kit web] listening on http://" + host + ":" + port + "\n",
    );
    // The subscription store holds subscription URLs and their tokens, so
    // reaching it from off-host is a real exposure until apiToken is set.
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !config.apiToken) {
        process.stderr.write(
            "[singbox-kit web] 注意：监听在 " + host +
                " 且未设置 apiToken，/api/* 与订阅地址对能访问到该端口的人都是开放的。\n",
        );
    }
    const shutdown = async () => {
        // Drain any queued store write before the process goes away.
        if (server.subscriptionStore) {
            try {
                await server.subscriptionStore.flush();
            } catch (_e) {
                // Best effort: never block shutdown on a failed write.
            }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 800).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((e) => {
    process.stderr.write(
        "[singbox-kit web] failed to start: " + (e && e.message ? e.message : e) + "\n",
    );
    process.exit(1);
});
