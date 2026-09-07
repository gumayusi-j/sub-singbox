// Loads optional singbox-web.config.json from the project root and merges it
// with defaults. Environment variables take precedence:
//   HOST / PORT .......... override listen host/port
//   SINGBOX_WEB_CONFIG ... alternative config file path
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export const DEFAULT_CONFIG = {
    listen: {
        host: "127.0.0.1",
        port: 8788,
    },
    maxBodyBytes: 1048576, // 1 MiB request body cap
    defaultOut: "config", // "config" | "outbounds"
    remoteDns: "https://dns.alidns.com/dns-query",
};

export function resolveConfigPath() {
    if (process.env.SINGBOX_WEB_CONFIG) return process.env.SINGBOX_WEB_CONFIG;
    // When running the bundled dist/singbox-kit-web.js, __dirname points at
    // dist/ so the legacy relative lookup misses the project-root config.
    // Check the launch directory (project root for `npm start`) first.
    const cwdPath = join(process.cwd(), "singbox-web.config.json");
    if (existsSync(cwdPath)) return cwdPath;
    return join(__dirname, "..", "..", "singbox-web.config.json");
}

export function loadConfig() {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const path = resolveConfigPath();
    if (existsSync(path)) {
        try {
            const fileConfig = JSON.parse(readFileSync(path, "utf8"));
            Object.assign(config, fileConfig);
            config.listen = Object.assign(
                {},
                DEFAULT_CONFIG.listen,
                (fileConfig && fileConfig.listen) || {},
            );
        } catch (e) {
            process.stderr.write(
                "[singbox-kit web] failed to parse " + path + ": " + e.message + "\n",
            );
        }
    }
    // environment overrides
    if (process.env.HOST) config.listen.host = process.env.HOST;
    if (process.env.PORT) {
        const port = Number(process.env.PORT);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
            config.listen.port = port;
        }
    }
    return config;
}

export default { loadConfig, resolveConfigPath, DEFAULT_CONFIG };
