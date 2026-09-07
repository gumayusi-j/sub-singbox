// Stub for Sub-Store's restful subscription/file engine. Vendored code
// (proxy-utils) imports produceArtifact but never reaches it on the
// parse -> produce('sing-box') path exercised by this kit.
export function produceArtifact() {
    throw new Error(
        'singbox-kit: produceArtifact (restful/sync) is not supported; feed raw content through fromText/fromUrl instead',
    );
}

export default { produceArtifact };
