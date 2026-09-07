// Dev / plain-node implementation: serve web UI assets from the on-disk
// public/ directory. The esbuild single-file build swaps this module for
// static.embedded.js (via alias) so the page is bundled into the output.
import { readFileSync, existsSync } from "fs";
import { join, normalize, sep } from "path";

const PUBLIC_ROOT = normalize(join(__dirname, "public"));

// rel is a URL pathname like "/" or "/index.html". Returns a Buffer, or null
// if the asset is missing or escapes the public root.
export function readStatic(rel) {
    const target = normalize(join(PUBLIC_ROOT, rel));
    if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) {
        return null; // traversal guard
    }
    if (!existsSync(target)) return null;
    return readFileSync(target);
}

export default readStatic;
