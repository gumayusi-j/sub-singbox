// Stub: age-encryption is a Sub-Store restful feature, not on the parse/produce path.
function unsupported(name) {
    return function ageUnsupported() {
        throw new Error(`singbox-kit: ${name} (age) is not supported`);
    };
}
export const decryptArmorIfPresent = unsupported('decryptArmorIfPresent');
export const derivePublicKey = unsupported('derivePublicKey');
export const encryptArmor = unsupported('encryptArmor');
export default { decryptArmorIfPresent, derivePublicKey, encryptArmor };
