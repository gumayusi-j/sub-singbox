import { readFileSync } from "fs";
import { fromText, fromUrl } from "./convert";
import assemble from "./assemble";

function readStdin() {
    // Synchronous read of piped stdin.
    try {
        const fs = require("fs");
        const data = fs.readFileSync(0, "utf8");
        return data;
    } catch (e) {
        return "";
    }
}

function parseArgs(argv) {
    const args = { _: [], includeUnsupportedProxy: false, tun: false, out: "config" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--url") args.url = true;
        else if (a === "--file") args.file = argv[++i];
        else if (a === "--out") args.out = argv[++i];
        else if (a === "--inbound-port") args.inboundPort = Number(argv[++i]);
        else if (a === "--dns") args.remoteDns = argv[++i];
        else if (a === "--final") args.final = argv[++i];
        else if (a === "--rule-file") args.ruleFile = argv[++i];
        else if (a === "--proxy-tag") args.proxyGroupTag = argv[++i];
        else if (a === "--include-unsupported-proxy") args.includeUnsupportedProxy = true;
        else if (a === "--tun") args.tun = true;
        else if (a === "--outbounds") args.out = "outbounds";
        else if (a === "--help" || a === "-h") args.help = true;
        else if (a.startsWith("-")) {
            throw new Error("unknown option: " + a);
        } else args._.push(a);
    }
    return args;
}

function loadRuleFile(path) {
    const content = readFileSync(path, "utf8");
    const trimmed = content.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        return JSON.parse(content);
    }
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
}

function usage() {
    return [
        "Usage: singbox-kit <input> [options]",
        "",
        "  input                    URL (http/https), a subscription file path,",
        "                           or inline subscription text (use - for stdin)",
        "",
        "Options:",
        "  --url                    force treat input as an http(s) URL",
        "  --file <path>            read input from a local file",
        "  --out outbounds|config   output style (default: config)",
        "  --inbound-port <n>       mixed inbound listen port (default 1080)",
        "  --tun                    add a tun inbound",
        "  --dns <url>              remote DoH URL for the dns section",
        "  --final <tag>            route.final tag (default proxy)",
        "  --proxy-tag <tag>        name of the selector group (default proxy)",
        "  --rule-file <path>       rules: a JSON array, or lines 'TYPE,CONTENT'",
        "  --include-unsupported-proxy   keep proxies sing-box cannot officially run",
        "  --help                   show this help",
    ].join("\n");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }
    const options = {
        includeUnsupportedProxy: args.includeUnsupportedProxy,
        inboundPort: args.inboundPort,
        tun: args.tun,
        remoteDns: args.remoteDns,
        final: args.final,
        proxyGroupTag: args.proxyGroupTag,
        userAgent: "singbox-kit/0.1",
    };
    if (args.ruleFile) options.rules = loadRuleFile(args.ruleFile);

    let input = args._[0];
    if (args.file) input = readFileSync(args.file, "utf8");
    if (input === undefined || input === "-" || input === "") {
        if (!process.stdin.isTTY) input = readStdin();
    }
    if (!input || (typeof input === "string" && input.trim() === "")) {
        console.error("singbox-kit: no input provided");
        console.error(usage());
        process.exit(1);
    }

    const isUrl = args.url || (typeof input === "string" && /^https?:\/\//i.test(input.trim()));
    let parsed;
    if (isUrl) {
        parsed = await fromUrl(input.trim(), options);
    } else if (typeof input === "string") {
        parsed = fromText(input, options);
    } else {
        console.error("singbox-kit: unsupported input type");
        process.exit(1);
    }

    if (args.out === "outbounds") {
        const body = { outbounds: parsed.outbounds, endpoints: parsed.endpoints };
        console.log(JSON.stringify(body, null, 2));
        return;
    }
    const config = assemble(parsed, options);
    console.log(JSON.stringify(config, null, 2));
}

main().catch((e) => {
    console.error("singbox-kit error:", e && e.message ? e.message : e);
    process.exit(1);
});
