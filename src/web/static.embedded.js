// Bundled implementation, used only by the esbuild single-file build: the web
// page is inlined via the ".html -> text" loader, so the output .js is fully
// self-contained (no public/ directory needed next to it). Not loaded in dev.
import html from "./public/index.html";
// The front-end libraries are inlined alongside it: the page must not depend on
// a CDN, so the bundle has to carry them rather than expect a vendor/ directory
// to sit next to the output file.
import elementPlusCss from "./public/vendor/element-plus.css";
import vueJs from "./public/vendor/vue.global.prod.js";
import elementPlusJs from "./public/vendor/element-plus.full.min.js";
import elementPlusIconsJs from "./public/vendor/element-plus-icons.iife.min.js";
import qrcodeJs from "./public/vendor/qrcode.min.js";

const ASSETS = {
    "/index.html": html,
    "/vendor/element-plus.css": elementPlusCss,
    "/vendor/vue.global.prod.js": vueJs,
    "/vendor/element-plus.full.min.js": elementPlusJs,
    "/vendor/element-plus-icons.iife.min.js": elementPlusIconsJs,
    "/vendor/qrcode.min.js": qrcodeJs,
};

export function readStatic(rel) {
    const key = rel === "/" ? "/index.html" : rel;
    const body = ASSETS[key];
    return body == null ? null : Buffer.from(body);
}

export default readStatic;
