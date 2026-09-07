// Stub: remote DNS helpers are restful features, not on the parse/produce path.
function unsupported(name) {
    return function dnsUnsupported() {
        throw new Error(`singbox-kit: ${name} (dns) is not supported`);
    };
}
export const doh = unsupported('doh');
export const resolveDns = unsupported('resolveDns');
export default { doh, resolveDns };
