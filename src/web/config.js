// Loads optional singbox-web.config.json from the project root and merges it
// with defaults. Environment variables take precedence:
//   HOST / PORT .......... override listen host/port
//   SINGBOX_WEB_CONFIG ... alternative config file path
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Effective default listen host/port.
//
// In source/dev the default stays on the loopback 127.0.0.1:8788. When esbuild
// bundles the single-file app it injects SINGBOX_KIT_WEB_DEFAULT_LISTEN (see
// scripts/build-web.mjs), so `node dist/singbox-kit-web.js` with no arguments
// listens on 0.0.0.0:80 - ready for a plain server deploy. Anything passed at
// runtime still overrides: CLI flags > HOST/PORT env > config file > default.
function bundledDefaultListen() {
    const raw = process.env.SINGBOX_KIT_WEB_DEFAULT_LISTEN;
    if (typeof raw !== "string" || raw === "") return null;
    try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
            return value;
        }
    } catch (_e) {
        // Malformed injected default: fall through to the dev default.
    }
    return null;
}

const defaultListen = bundledDefaultListen() || { host: "127.0.0.1", port: 8788 };

export const DEFAULT_CONFIG = {
    listen: {
        host: defaultListen.host,
        port: defaultListen.port,
    },
    maxBodyBytes: 1048576, // 1 MiB request body cap
    defaultOut: "config", // "config" | "outbounds"
    // Leave empty so the client profile defaults to google (tls://8.8.8.8)
    // over the proxy; set here or in the UI to override.
    remoteDns: "",
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
