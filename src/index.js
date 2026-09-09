// singbox-kit public API
export {
    fromNodes,
    fromText,
    fromUrl,
    tryLoadNodeDocument,
} from "./kit/convert";
export { default as assemble } from "./kit/assemble";
export {
    analyzeConfig,
    migrateConfig,
    assertCompatible,
    CompatError,
    formatErrors,
} from "./kit/compat";
export {
    toSingboxMatcher,
    toSingboxRule,
    toSingboxRules,
    foldSingboxRules,
    isRejectTarget,
    SUPPORTED as SUPPORTED_RULE_TYPES,
} from "./kit/rules/singbox";
export { ProxyUtils } from "@/core/proxy-utils";

// High-level helper: parse + assemble in one call.
//   source: URL string, subscription text, or an array of node objects.
//   options: assemble() options; { url: true } forces URL handling.
export async function toSingboxConfig(source, options) {
    options = options || {};
    let parsed;
    if (Array.isArray(source)) {
        parsed = await import("./kit/convert").then((m) =>
            m.fromNodes(source, options),
        );
    } else if (options.url || (typeof source === "string" && /^https?:\/\//i.test(source))) {
        parsed = await import("./kit/convert").then((m) =>
            m.fromUrl(source, options),
        );
    } else {
        parsed = await import("./kit/convert").then((m) =>
            m.fromText(source, options),
        );
    }
    const assembleModule = await import("./kit/assemble");
    return assembleModule.default(parsed, options);
}

export default {
    fromNodes,
    fromText,
    fromUrl,
    assemble,
    toSingboxConfig,
    analyzeConfig,
    migrateConfig,
    assertCompatible,
    CompatError,
    ProxyUtils,
};
