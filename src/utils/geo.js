import { extractCountryFlag, stripExistingFlags } from '../kit/nodes/pipeline';

function unsupported(name) {
    return function geoUnsupported() {
        throw new Error(`singbox-kit: ${name} (geo) is not supported`);
    };
}

export function getFlag(name) {
    return extractCountryFlag(name) || '';
}

export function removeFlag(str) {
    return stripExistingFlags(str);
}

export const getISO = unsupported('getISO');
export const MMDB = { lookup: unsupported('MMDB.lookup') };
export default { getFlag, removeFlag, getISO, MMDB };
