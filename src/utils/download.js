// Stub: Sub-Store's download util relies on its own network stack. The kit
// performs HTTP fetching itself (see src/kit/convert.js) and never calls this.
const download = () =>
    Promise.reject(
        new Error('singbox-kit: utils/download is not bundled; use fromUrl()'),
    );

export function downloadFile() {
    return download();
}
export default download;
