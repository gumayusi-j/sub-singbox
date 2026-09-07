// esbuild single-file build for the web server.
// Produces dist/singbox-kit-web.js: all sources + node_modules dependencies
// bundled, the UI page (public/index.html) inlined, so it runs with a bare
// `node dist/singbox-kit-web.js --port 9000` (no @babel/register/preload).
import { build } from "esbuild";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // project root
const OUT = ROOT + "dist/singbox-kit-web.js";

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
    ],
    loader: { ".html": "text" }, // allow `import html from "./public/index.html"`
    logLevel: "warning",
});

console.log("[build-web] wrote " + OUT);
