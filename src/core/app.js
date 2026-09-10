import { readFileSync } from "fs";

// Minimal logger / environment shim standing in for Sub-Store's "@/core/app".
// All diagnostics go to stderr so stdout stays clean for structured output
// (e.g. a caller piping generated config JSON to stdout).
const LEVELS = { log: "LOG", info: "INFO", warn: "WARN", error: "ERROR" };

function emit(level, args) {
    let line = "[singbox-kit " + new Date().toISOString() + "] " +
        LEVELS[level] + ":";
    for (const arg of args) {
        if (arg instanceof Error) line += " " + arg.message;
        else if (typeof arg === "string") line += " " + arg;
        else {
            try {
                line += " " + JSON.stringify(arg);
            } catch (_e) {
                line += " " + String(arg);
            }
        }
    }
    try {
        process.stderr.write(line + "\n");
    } catch (_e) {
        /* never let logging break conversion */
    }
}

const $ = {
    env: { isNode: true },
    node: { fs: { readFileSync } },
    log: (...args) => emit("log", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    read: () => [],
    write: () => undefined,
};

export default $;
