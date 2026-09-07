// Bundled implementation, used only by the esbuild single-file build: the web
// page is inlined via the ".html -> text" loader, so the output .js is fully
// self-contained (no public/ directory needed next to it). Not loaded in dev.
import html from "./public/index.html";

const ASSETS = { "/index.html": html };

export function readStatic(rel) {
    const key = rel === "/" ? "/index.html" : rel;
    const body = ASSETS[key];
    return body == null ? null : Buffer.from(body);
}

export default readStatic;
