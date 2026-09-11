// esbuild single-file build for the web server.
// Produces dist/singbox-kit-web.js: all sources + node_modules dependencies
// bundled, the UI page (public/index.html) inlined, so it runs with a bare
// `node dist/singbox-kit-web.js --port 9000` (no @babel/register/preload).
import { build } from "esbuild";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // project root
const OUT = ROOT + "dist/singbox-kit-web.js";

// Bundled single-file default listen: 0.0.0.0:80 so that a bare
// `node dist/singbox-kit-web.js` is server-ready with no arguments (source/dev
// mode keeps the loopback 127.0.0.1:8788). Runtime CLI/env/config still win.
// Override the shipped default with SINGBOX_KIT_BUNDLE_LISTEN, e.g.
// SINGBOX_KIT_BUNDLE_LISTEN='{"host":"127.0.0.1","port":8080}' pnpm build
function bundleDefaultListen() {
    const raw = process.env.SINGBOX_KIT_BUNDLE_LISTEN;
    if (raw) {
        try {
            const value = JSON.parse(raw);
            if (value && typeof value === "object" && !Array.isArray(value)) {
                return value;
            }
        } catch (_e) {
            // Malformed override: fall through to the deploy default.
        }
    }
    return { host: "0.0.0.0", port: 80 };
}
// JSON.stringify twice: first serialises the object, second turns that JSON
// text into a JS string literal esbuild can splice into the bundle.
const injectedDefaultListen = JSON.stringify(JSON.stringify(bundleDefaultListen()));

await build({
    entryPoints: [ROOT + "src/web/index.js"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: OUT,
    alias: {
        // The source uses a "@/" -> "src/" import alias that is normally
        // resolved at runtime by preload.js; resolve it here for the bundle.
        "@": ROOT + "src",
    },
    define: {
        "process.env.SINGBOX_KIT_WEB_DEFAULT_LISTEN": injectedDefaultListen,
    },
    plugins: [
        {
            name: "static-embed",
            setup(build) {
                // Swap the disk-backed static reader for the inlined-assets
                // one (esbuild aliases can't target relative specifiers).
                build.onResolve({ filter: /^\.\/static$/ }, () => ({
                    path: ROOT + "src/web/static.embedded.js",
                }));
            },
        },
        {
            name: "vendor-text",
            setup(build) {
                // The vendored front-end libraries are inlined as text so the
                // output stays a single self-contained file. Filtering on the
                // resolved path keeps ordinary .js/.css imports out of this.
                build.onLoad(
                    { filter: /[\\/]public[\\/]vendor[\\/][^\\/]+\.(js|css)$/ },
                    (args) => ({
                        contents: readFileSync(args.path, "utf8"),
                        loader: "text",
                    }),
                );
            },
        },
    ],
    // `.html` allows `import html from "./public/index.html"`. `.svg` carries no
    // default loader in esbuild, so the favicon import needs declaring too, and
    // "text" rather than "file"/"dataurl" is what keeps the output one file.
    loader: { ".html": "text", ".svg": "text" },
    logLevel: "warning",
});

console.log("[build-web] wrote " + OUT);
