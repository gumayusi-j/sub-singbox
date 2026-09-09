#!/usr/bin/env node
// Validate a generated sing-box JSON config against a real sing-box binary
// (syntax check, optionally a brief boot), mirroring Tower's
// Scripts/test_singbox_bootstrap.py.
//
//   node scripts/validate-config.mjs [options] [config.json]
//
// Reads stdin when no file is given. The binary is resolved from $SING_BOX_BIN,
// else "sing-box" on PATH. When no binary is present the script prints a hint
// and exits 0, so callers can skip cleanly on machines without the kernel.
//
// Exit codes:
//   0  check passed (or binary absent)
//   1  sing-box rejected the config (or it failed to boot with --run)
//   2  usage / read error

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function usage() {
    return [
        "Usage: validate-config [options] [config.json]",
        "",
        "  config.json           generated sing-box config to check (or stdin)",
        "  --run <seconds>       also boot the config for <seconds> as a smoke test",
        "  --help                show this help",
        "",
        "Binary: $SING_BOX_BIN, else 'sing-box' on PATH.",
        "Exit 0 also when no binary is found (callers may skip locally).",
    ].join("\n");
}

function parseArgs(argv) {
    const parsed = { runSeconds: 0, file: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") parsed.help = true;
        else if (arg === "--run") parsed.runSeconds = Number(argv[++i]) || 0;
        else if (arg.startsWith("-")) {
            throw new Error("unknown option: " + arg);
        } else if (parsed.file === null) parsed.file = arg;
        else throw new Error("unexpected extra argument: " + arg);
    }
    return parsed;
}

function readStdin() {
    try {
        return readFileSync(0, "utf8");
    } catch (_e) {
        return null;
    }
}

function runCheck(bin, file) {
    return new Promise((resolve) => {
        const child = spawn(bin, ["check", "-c", file], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("error", (err) => resolve({ status: null, error: err }));
        child.on("close", (code) => resolve({ status: code, output: out }));
    });
}

function runSmoke(bin, file, dir, seconds) {
    return new Promise((resolve) => {
        const child = spawn(bin, ["run", "-c", file, "-D", dir], {
            cwd: dir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const timer = setTimeout(() => child.kill(), seconds * 1000);
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ status: null, timedOut: false, output: String(err.message || err) });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ status: code, timedOut: code === null, output: out });
        });
    });
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error("validate-config:", e.message);
        console.error(usage());
        process.exit(2);
    }
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }

    const bin = process.env.SING_BOX_BIN || "sing-box";

    let file = args.file;
    let tempDir = null;
    if (!file) {
        if (process.stdin.isTTY) {
            console.error("validate-config: no config file given and no piped stdin");
            console.error(usage());
            process.exit(2);
        }
        const stdin = readStdin();
        if (stdin == null || stdin.trim() === "") {
            console.error("validate-config: empty stdin");
            process.exit(2);
        }
        tempDir = mkdtempSync(join(tmpdir(), "singbox-kit-validate-"));
        file = join(tempDir, "config.json");
        writeFileSync(file, stdin, "utf8");
    } else {
        try {
            readFileSync(file, "utf8");
        } catch (_e) {
            console.error("validate-config: cannot read config file:", file);
            process.exit(2);
        }
    }

    const check = await runCheck(bin, file);
    if (check.status === null) {
        console.log(
            "singbox-kit: sing-box binary not found (" +
                (check.error && check.error.code === "ENOENT"
                    ? "not on PATH; set SING_BOX_BIN"
                    : String(check.error && check.error.message)) +
                ") - skipping validation",
        );
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        process.exit(0);
    }
    if (check.output) process.stdout.write(check.output);
    if (check.status !== 0) {
        console.error(
            "validate-config: sing-box check rejected the config (exit " + check.status + ")",
        );
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        process.exit(1);
    }
    console.log("singbox-kit: sing-box check passed");

    if (args.runSeconds > 0) {
        const dir = tempDir || mkdtempSync(join(tmpdir(), "singbox-kit-run-"));
        const smoke = await runSmoke(bin, file, dir, args.runSeconds);
        if (smoke.output) process.stdout.write(smoke.output);
        if (smoke.status !== null && smoke.status !== 0) {
            console.error(
                "validate-config: sing-box boot failed (exit " + smoke.status + ")",
            );
            if (tempDir) rmSync(tempDir, { recursive: true, force: true });
            process.exit(1);
        }
        console.log(
            smoke.timedOut
                ? "singbox-kit: booted for " + args.runSeconds + "s without error (killed)"
                : "singbox-kit: boot smoke passed",
        );
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    } else if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
    process.exit(0);
}

main().catch((e) => {
    console.error("validate-config:", e && e.message ? e.message : e);
    process.exit(2);
});
