// Stub: flow/header functions are used by Sub-Store's operator chain and are
// not reachable from the parse -> produce('sing-box') path of this kit.
function unsupported(name) {
    return function flowUnsupported() {
        throw new Error(`singbox-kit: ${name} (flow) is not supported`);
    };
}
export const getFlowField = unsupported('getFlowField');
export const getFlowHeaders = unsupported('getFlowHeaders');
export const parseFlowHeaders = unsupported('parseFlowHeaders');
export const validCheck = unsupported('validCheck');
export const flowTransfer = unsupported('flowTransfer');
export const getRmainingDays = unsupported('getRmainingDays');
export const normalizeFlowHeader = unsupported('normalizeFlowHeader');
export default {
    getFlowField,
    getFlowHeaders,
    parseFlowHeaders,
    validCheck,
    flowTransfer,
    getRmainingDays,
    normalizeFlowHeader,
};
