// Stub: MMDB/geo lookups are Sub-Store restful features, not on the
// parse/produce('sing-box') path exercised by this kit.
function unsupported(name) {
    return function geoUnsupported() {
        throw new Error(`singbox-kit: ${name} (geo) is not supported`);
    };
}
export const getFlag = unsupported('getFlag');
export const removeFlag = unsupported('removeFlag');
export const getISO = unsupported('getISO');
export const MMDB = { lookup: unsupported('MMDB.lookup') };
export default { getFlag, removeFlag, getISO, MMDB };
