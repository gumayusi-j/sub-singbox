// Launcher: starts the web UI server. Config via singbox-web.config.json
// (optional) or HOST/PORT env. See singbox-web.config.example.json.
import { start, loadConfig } from "./server";

async function main() {
    const config = loadConfig();
    const server = await start(config);
    const { host, port } = config.listen;
    process.stderr.write(
        "[singbox-kit web] listening on http://" + host + ":" + port + "\n",
    );
    const shutdown = () => {
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
