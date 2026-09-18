import Surge_Producer from './surge';
import SurgeMac_Producer from './surgemac';
import Clash_Producer from './clash';
import ClashMeta_Producer from './clashmeta';
import Stash_Producer from './stash';
import Loon_Producer from './loon';
import URI_Producer from './uri';
import V2Ray_Producer from './v2ray';
import QX_Producer from './qx';
import Shadowrocket_Producer from './shadowrocket';
import Surfboard_Producer from './surfboard';
import singbox_Producer from './sing-box';
import Egern_Producer from './egern';

function JSON_Producer() {
    const type = 'ALL';
    const produce = (proxies, type) =>
        type === 'internal' ? proxies : JSON.stringify(proxies, null, 2);
    return { type, produce };
}

function Karing_Producer() {
    const meta = ClashMeta_Producer();
    const type = 'ALL';
    const produce = (proxies, type, opts = {}) => {
        const filtered = proxies.filter((proxy) => {
            if (opts['include-unsupported-proxy']) return true;
            if (
                proxy?.plugin === 'shadow-tls' ||
                proxy?.['obfs-opts']?.mode === 'shadow-tls'
            ) {
                return false;
            }
            return true;
        });
        return meta.produce(filtered, type, opts);
    };
    return { type, produce };
}

export default {
    karing: Karing_Producer(),
    Karing: Karing_Producer(),
    qx: QX_Producer(),
    QX: QX_Producer(),
    QuantumultX: QX_Producer(),
    surge: Surge_Producer(),
    Surge: Surge_Producer(),
    SurgeMac: SurgeMac_Producer(),
    Loon: Loon_Producer(),
    Clash: Clash_Producer(),
    meta: ClashMeta_Producer(),
    clashmeta: ClashMeta_Producer(),
    'clash.meta': ClashMeta_Producer(),
    'Clash.Meta': ClashMeta_Producer(),
    ClashMeta: ClashMeta_Producer(),
    mihomo: ClashMeta_Producer(),
    Mihomo: ClashMeta_Producer(),
    uri: URI_Producer(),
    URI: URI_Producer(),
    v2: V2Ray_Producer(),
    v2ray: V2Ray_Producer(),
    V2Ray: V2Ray_Producer(),
    json: JSON_Producer(),
    JSON: JSON_Producer(),
    stash: Stash_Producer(),
    Stash: Stash_Producer(),
    shadowrocket: Shadowrocket_Producer(),
    Shadowrocket: Shadowrocket_Producer(),
    ShadowRocket: Shadowrocket_Producer(),
    surfboard: Surfboard_Producer(),
    Surfboard: Surfboard_Producer(),
    singbox: singbox_Producer(),
    'sing-box': singbox_Producer(),
    egern: Egern_Producer(),
    Egern: Egern_Producer(),
};
