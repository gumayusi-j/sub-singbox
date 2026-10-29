import URI_Producer from './uri.js';

const FINGERPRINTS = {
    chrome: 'chrome_133',
    firefox: 'firefox_148',
    safari: 'safari_26',
    ios: 'chrome_120',
    edge: 'edge_106',
    random: null,
    randomized: null,
};

const NATIVE_FINGERPRINTS = new Set([
    'chrome_133',
    'chrome_120',
    'chrome_106',
    'firefox_148',
    'firefox_120',
    'safari_26',
    'edge_106',
    'non_browser',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPPORTED_SS_CIPHERS = new Set([
    'aes-128-gcm',
    'aes-256-gcm',
    'chacha20-ietf-poly1305',
    'chacha20-poly1305',
    '2022-blake3-aes-128-gcm',
    '2022-blake3-aes-256-gcm',
    '2022-blake3-chacha20-poly1305',
    'none',
]);

export function unsupportedReason(node) {
    if (!node) return '节点为空';

    const type = (node.type || '').toLowerCase();

    // 1. VLESS uuid validation
    if (type === 'vless') {
        const uuid = node.uuid || '';
        if (!UUID_REGEX.test(uuid)) {
            return '节点认证信息无效或不完整。';
        }
    }

    // 2. Certificate fingerprint pin
    if (node['certificate-fingerprint'] || node.certificateFingerprint) {
        return 'Anywhere 不支持证书指纹固定。';
    }

    // 3. Port hopping and plugin
    if (node.ports || node['port-hopping'] || node.plugin) {
        return 'Anywhere 不支持此节点的端口跳跃或插件。';
    }

    // 4. Transport and Reality
    const transport = (node.network || node.transport || 'tcp').toLowerCase();
    const usesReality = !!(node.reality || node['reality-opts']);
    if (usesReality && type !== 'vless') {
        return 'Anywhere 只有 VLESS 支持 Reality 和 TCP 以外的传输方式。';
    }
    if (!['vless', 'hysteria2', 'hy2', 'anytls'].includes(type) && !['', 'tcp'].includes(transport)) {
        return 'Anywhere 只有 VLESS 支持 Reality 和 TCP 以外的传输方式。';
    }

    // 5. Protocol whitelist and specific checks
    switch (type) {
        case 'ss':
        case 'shadowsocks':
            if (node.tls) return 'Anywhere 不支持带 TLS 的 Shadowsocks。';
            if (node.obfs && node.obfs !== 'none') return 'Anywhere 不支持带混淆插件的 Shadowsocks。';
            if (!SUPPORTED_SS_CIPHERS.has(node.cipher)) return 'Anywhere 不支持该 Shadowsocks 加密算法。';
            if (!node.password) return 'Shadowsocks 缺少密码。';
            return null;

        case 'socks':
        case 'socks5':
            if (node.tls) return 'Anywhere 不支持带 TLS 的 SOCKS5。';
            return null;

        case 'hysteria2':
        case 'hy2':
            if (node.alpn && String(node.alpn).trim() !== '') return 'Anywhere 不支持自定义 ALPN 的 Hysteria 2。';
            const obfs = (node.obfs || '').toLowerCase();
            if (!['', 'none', 'salamander', 'gecko'].includes(obfs)) return 'Anywhere 不支持此 Hysteria 2 混淆类型。';
            return null;

        case 'vless':
        case 'anytls':
        case 'trojan':
            return null;

        default:
            return '此节点的协议参数无法在当前客户端完整保留。';
    }
}

export function supports(node) {
    return unsupportedReason(node) == null;
}

export function produceLink(node) {
    if (!node) return '';
    const nodeClone = Object.assign({}, node);
    const uriProducer = URI_Producer();
    const rawUri = uriProducer.produce(nodeClone);
    if (!rawUri) return '';

    const type = (node.type || '').toLowerCase();

    // Shadowsocks uses standard canonical ss:// link directly
    if (type === 'ss' || type === 'shadowsocks') {
        return rawUri;
    }

    // SOCKS5 expects socks://host:port with no URI query suffix
    if (type === 'socks' || type === 'socks5') {
        const hashIdx = rawUri.indexOf('#');
        const fragment = hashIdx !== -1 ? rawUri.slice(hashIdx) : '';
        const base = hashIdx !== -1 ? rawUri.slice(0, hashIdx) : rawUri;
        const qIdx = base.indexOf('?');
        const cleanBase = qIdx !== -1 ? base.slice(0, qIdx) : base;
        return cleanBase + fragment;
    }

    // Parse URL parts
    const hashIdx = rawUri.indexOf('#');
    const fragment = hashIdx !== -1 ? rawUri.slice(hashIdx) : '';
    const main = hashIdx !== -1 ? rawUri.slice(0, hashIdx) : rawUri;
    const qIdx = main.indexOf('?');
    const baseUrl = qIdx !== -1 ? main.slice(0, qIdx) : main;
    const queryString = qIdx !== -1 ? main.slice(qIdx + 1) : '';

    const params = new URLSearchParams(queryString);

    // Aliases (support kebab-case, snake_case, and camelCase)
    const aliases = {
        'idle-session-check-interval': 'ici',
        'idle_session_check_interval': 'ici',
        'idleSessionCheckInterval': 'ici',
        'idle-session-timeout': 'it',
        'idle_session_timeout': 'it',
        'idleSessionTimeout': 'it',
        'min-idle-session': 'mis',
        'min_idle_session': 'mis',
        'minIdleSession': 'mis',
    };
    for (const [longKey, shortKey] of Object.entries(aliases)) {
        if (params.has(longKey)) {
            const val = params.get(longKey);
            params.delete(longKey);
            params.set(shortKey, val);
        }
    }
    // Also read directly from node properties if present
    if (!params.has('ici')) {
        const v = node.idleSessionCheckInterval ?? node['idle-session-check-interval'] ?? node.idle_session_check_interval;
        if (v != null) params.set('ici', String(v));
    }
    if (!params.has('it')) {
        const v = node.idleSessionTimeout ?? node['idle-session-timeout'] ?? node.idle_session_timeout;
        if (v != null) params.set('it', String(v));
    }
    if (!params.has('mis')) {
        const v = node.minIdleSession ?? node['min-idle-session'] ?? node.min_idle_session;
        if (v != null) params.set('mis', String(v));
    }

    // VLESS gRPC host -> authority
    const transport = (node.network || node.transport || '').toLowerCase();
    if (type === 'vless' && transport === 'grpc') {
        if (params.has('host')) {
            const hostVal = params.get('host');
            params.delete('host');
            params.set('authority', hostVal);
        }
    }

    // VLESS flow
    if (type === 'vless' && node.flow && !params.has('flow')) {
        params.set('flow', node.flow);
    }

    // Hysteria 2 up/down
    if (type === 'hysteria2' || type === 'hy2') {
        const up = node['up-mbps'] ?? node.upmbps ?? node.up;
        const down = node['down-mbps'] ?? node.downmbps ?? node.down;
        if (up && !params.has('upmbps')) params.set('upmbps', String(up));
        if (down && !params.has('downmbps')) params.set('downmbps', String(down));
    }

    // TLS Fingerprint mapping
    if (params.has('fp')) {
        const currentFp = params.get('fp');
        const lower = currentFp.toLowerCase();
        if (lower in FINGERPRINTS) {
            const mapped = FINGERPRINTS[lower];
            if (mapped === null) {
                params.delete('fp');
            } else {
                params.set('fp', mapped);
            }
        } else if (!NATIVE_FINGERPRINTS.has(currentFp)) {
            params.set('fp', 'chrome_133');
        }
    }

    const newQuery = params.toString();
    return baseUrl + (newQuery ? '?' + newQuery : '') + fragment;
}

export default function Anywhere_Producer() {
    const type = 'ALL';
    const produce = (proxies, produceType, opts = {}) => {
        const supported = [];
        for (const proxy of proxies || []) {
            const reason = unsupportedReason(proxy);
            if (!reason) {
                supported.push(proxy);
            } else if (opts && Array.isArray(opts.skippedNodes)) {
                opts.skippedNodes.push({ name: proxy.name || '未知节点', reason });
            }
        }
        const links = supported.map(produceLink).filter(Boolean);
        if (produceType === 'internal') {
            return links;
        }
        return links.join('\n') + (links.length > 0 ? '\n' : '');
    };
    return {
        type,
        produce,
        supports,
        unsupportedReason,
        produceLink,
    };
}
