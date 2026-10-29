import { expect } from 'chai';
import Anywhere_Producer, {
    supports,
    unsupportedReason,
    produceLink,
} from '@/core/proxy-utils/producers/anywhere';

describe('Anywhere Export & Dialect', function () {
    const producer = Anywhere_Producer();

    it('supports VLESS Reality and standard transports, rejects invalid UUID', function () {
        const validVless = {
            type: 'vless',
            name: 'VLESS-Valid',
            server: 'example.com',
            port: 443,
            uuid: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
            tls: true,
            network: 'ws',
            'ws-opts': { path: '/ws' },
        };
        expect(supports(validVless)).to.equal(true);

        const invalidUuid = {
            ...validVless,
            uuid: 'not-a-uuid',
        };
        expect(supports(invalidUuid)).to.equal(false);
        expect(unsupportedReason(invalidUuid)).to.include('认证信息无效');
    });

    it('accepts nodes with skip-cert-verify and disabled udp, rejects pinned cert', function () {
        const base = {
            type: 'trojan',
            name: 'Trojan-Node',
            server: 'example.com',
            port: 443,
            password: 'secret',
            tls: true,
        };
        expect(supports(base)).to.equal(true);

        // Nodes with skip-cert-verify or disabled udp are supported (Anywhere connects normally)
        const insecure = { ...base, 'skip-cert-verify': true };
        expect(supports(insecure)).to.equal(true);

        const noUdp = { ...base, udp: false };
        expect(supports(noUdp)).to.equal(true);

        const pinned = { ...base, 'certificate-fingerprint': 'aabbccdd' };
        expect(supports(pinned)).to.equal(false);
        expect(unsupportedReason(pinned)).to.include('证书指纹固定');
    });

    it('maps TLS fingerprints according to Anywhere specifications', function () {
        const node = (fp) => ({
            type: 'vless',
            name: `Node-${fp}`,
            server: 'example.com',
            port: 443,
            uuid: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
            tls: true,
            'client-fingerprint': fp,
        });

        // chrome -> chrome_133
        const chromeLink = produceLink(node('chrome'));
        expect(chromeLink).to.include('fp=chrome_133');

        // ios -> chrome_120
        const iosLink = produceLink(node('ios'));
        expect(iosLink).to.include('fp=chrome_120');

        // random -> omit fp
        const randomLink = produceLink(node('random'));
        expect(randomLink).to.not.include('fp=');

        // Unsupported fingerprint mapped to chrome_133
        const unsupportedFp = node('qq');
        const link = produceLink(unsupportedFp);
        expect(link).to.include('fp=chrome_133');
    });

    it('converts parameter aliases (ici, it, mis) for Anywhere', function () {
        const anytlsNode = {
            type: 'anytls',
            name: 'AnyTLS-Test',
            server: '2001:db8::1',
            port: 443,
            password: 'pass',
            tls: true,
            'idle-session-check-interval': 17,
            'idle-session-timeout': 21,
            'min-idle-session': 3,
        };
        expect(supports(anytlsNode)).to.equal(true);
        const link = produceLink(anytlsNode);
        expect(link).to.include('ici=17');
        expect(link).to.include('it=21');
        expect(link).to.include('mis=3');
        expect(link).to.not.include('idle-session');
    });

    it('maps VLESS gRPC host to authority', function () {
        const vlessGrpc = {
            type: 'vless',
            name: 'VLESS-gRPC',
            server: 'example.com',
            port: 443,
            uuid: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
            tls: true,
            network: 'grpc',
            'grpc-opts': {
                'grpc-service-name': 'my-service',
                host: 'grpc.example.com',
            },
        };
        const link = produceLink(vlessGrpc);
        expect(link).to.include('authority=grpc.example.com');
        expect(link).to.not.include('host=grpc.example.com');
    });

    it('strips query parameters from SOCKS5 links', function () {
        const socks = {
            type: 'socks5',
            name: 'My-Socks',
            server: '1.2.3.4',
            port: 1080,
            username: 'user',
            password: 'pass',
        };
        const link = produceLink(socks);
        expect(link).to.match(/^socks(5)?:\/\//);
        expect(link).to.not.include('?');
        expect(link).to.include('#My-Socks');
    });

    it('filters unsupported protocols (VMess, WireGuard, TUIC)', function () {
        const vmess = {
            type: 'vmess',
            name: 'VMess-Test',
            server: 'example.com',
            port: 443,
            uuid: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        };
        const wg = {
            type: 'wireguard',
            name: 'WG-Test',
            server: 'example.com',
            port: 51820,
        };
        const tuic = {
            type: 'tuic',
            name: 'TUIC-Test',
            server: 'example.com',
            port: 8443,
        };
        expect(supports(vmess)).to.equal(false);
        expect(supports(wg)).to.equal(false);
        expect(supports(tuic)).to.equal(false);

        const result = producer.produce([vmess, wg, tuic]);
        expect(result.trim()).to.equal('');
    });

    it('supports Hysteria 2 with network udp and preserves original node object immutability', function () {
        const hy2Node = {
            type: 'hysteria2',
            name: 'HY2-Node',
            server: 'hy2.example.com',
            port: 443,
            password: 'secret-password',
            tls: true,
            network: 'udp',
            subName: 'my-sub',
        };
        expect(supports(hy2Node)).to.equal(true);

        const beforeTls = hy2Node.tls;
        const beforeSubName = hy2Node.subName;
        const link = produceLink(hy2Node);
        expect(link).to.include('hysteria2://');
        expect(link).to.include('#HY2-Node');

        // Original object properties must not be deleted or mutated
        expect(hy2Node.tls).to.equal(beforeTls);
        expect(hy2Node.subName).to.equal(beforeSubName);
    });
});
