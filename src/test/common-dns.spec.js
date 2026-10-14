import { expect } from "chai";
import {
    isCommonDns,
    stripDnsSuffix,
    isIpAddress,
    matchDomainPattern,
    applyHostsToProxies,
    simplifyDomainPolicy,
    extractPrivateDns,
} from "@/kit/common-dns";
import { parseSubscriptionDoc, fromNodes } from "@/kit/convert";
import assembleClash from "@/kit/assemble-clash";
import { buildMihomoSmartClash } from "@/kit/mihomo-smart/builder";

describe("Common DNS filtering & Private DNS extraction", function () {
    describe("isCommonDns", function () {
        it("identifies domestic and foreign public DNS", function () {
            expect(isCommonDns("223.5.5.5")).to.equal(true);
            expect(isCommonDns("223.5.5.5#DIRECT")).to.equal(true);
            expect(isCommonDns("119.29.29.29")).to.equal(true);
            expect(isCommonDns("114.114.114.114")).to.equal(true);
            expect(isCommonDns("https://doh.pub/dns-query")).to.equal(true);
            expect(isCommonDns("tls://dns.pub")).to.equal(true);
            expect(isCommonDns("8.8.8.8")).to.equal(true);
            expect(isCommonDns("https://dns.google/dns-query")).to.equal(true);
            expect(isCommonDns("1.1.1.1")).to.equal(true);
            expect(isCommonDns("https://cloudflare-dns.com/dns-query#代理")).to.equal(true);
            expect(isCommonDns("9.9.9.9")).to.equal(true);
            expect(isCommonDns("94.140.14.14")).to.equal(true);
            expect(isCommonDns("system")).to.equal(true);
            expect(isCommonDns("system://")).to.equal(true);
        });

        it("identifies genuinely private or custom DNS", function () {
            expect(isCommonDns("10.0.0.53")).to.equal(false);
            expect(isCommonDns("192.168.1.1")).to.equal(false);
            expect(isCommonDns("https://dns.my-custom-airport.org/dns-query")).to.equal(false);
            expect(isCommonDns("45.76.12.34")).to.equal(false);
            expect(isCommonDns("tls://private-resolver.xyz")).to.equal(false);
        });
    });

    describe("stripDnsSuffix", function () {
        it("strips custom group suffix or normalizes direct suffix", function () {
            expect(stripDnsSuffix("223.5.5.5#DIRECT")).to.equal("223.5.5.5#DIRECT");
            expect(stripDnsSuffix("223.5.5.5#直连")).to.equal("223.5.5.5#DIRECT");
            expect(stripDnsSuffix("1.1.1.1#🚀 节点选择")).to.equal("1.1.1.1");
            expect(stripDnsSuffix("8.8.8.8")).to.equal("8.8.8.8");
        });
    });

    describe("isIpAddress", function () {
        it("identifies IPv4 and IPv6", function () {
            expect(isIpAddress("1.1.1.1")).to.equal(true);
            expect(isIpAddress("255.255.255.255")).to.equal(true);
            expect(isIpAddress("999.1.1.1")).to.equal(false);
            expect(isIpAddress("2001:4860:4860::8888")).to.equal(true);
            expect(isIpAddress("node1.example.com")).to.equal(false);
        });
    });

    describe("matchDomainPattern", function () {
        it("matches exact, suffix (+. and .), and wildcard (*)", function () {
            expect(matchDomainPattern("example.com", "example.com")).to.equal(true);
            expect(matchDomainPattern("example.com", "other.com")).to.equal(false);

            expect(matchDomainPattern("+.example.com", "example.com")).to.equal(true);
            expect(matchDomainPattern("+.example.com", "hk.example.com")).to.equal(true);
            expect(matchDomainPattern("+.example.com", "sub.hk.example.com")).to.equal(true);
            expect(matchDomainPattern("+.example.com", "notexample.com")).to.equal(false);

            expect(matchDomainPattern(".example.com", "hk.example.com")).to.equal(true);
            expect(matchDomainPattern(".example.com", "example.com")).to.equal(false);

            expect(matchDomainPattern("*.example.com", "hk.example.com")).to.equal(true);
            expect(matchDomainPattern("*.example.com", "sub.hk.example.com")).to.equal(false);
        });
    });

    describe("applyHostsToProxies", function () {
        it("rewrites proxy.server to IP while preserving SNI", function () {
            const proxies = [
                {
                    name: "HK-01",
                    type: "vmess",
                    server: "hk01.airport.com",
                    port: 443,
                    tls: true,
                },
                {
                    name: "US-01",
                    type: "ss",
                    server: "1.2.3.4",
                    port: 8388,
                },
            ];

            const hosts = {
                "+.airport.com": "104.21.5.10",
            };

            const mapped = applyHostsToProxies(proxies, hosts);
            expect(mapped[0].server).to.equal("104.21.5.10");
            expect(mapped[0].servername).to.equal("hk01.airport.com");
            expect(mapped[1].server).to.equal("1.2.3.4");
        });
    });

    describe("simplifyDomainPolicy", function () {
        it("merges subdomains sharing the same DNS into +.suffix", function () {
            const policy = {
                "hk01.airport.com": "10.0.0.53",
                "hk02.airport.com": "10.0.0.53",
                "us01.airport.com": "10.0.0.53",
                "standalone.org": "1.1.1.1",
            };

            const simplified = simplifyDomainPolicy(policy);
            expect(simplified["+.airport.com"]).to.equal("10.0.0.53");
            expect(simplified["standalone.org"]).to.equal("1.1.1.1");
            expect(simplified["hk01.airport.com"]).to.equal(undefined);
        });
    });

    describe("extractPrivateDns", function () {
        it("filters out public DNS and retains airport private DNS bound to node domains", function () {
            const originalDns = {
                nameserver: [
                    "223.5.5.5",
                    "114.114.114.114",
                    "10.0.0.53#DIRECT",
                ],
                "proxy-server-nameserver": [
                    "8.8.8.8",
                    "https://private.airport-dns.com/dns-query",
                ],
                "fake-ip-filter": [
                    "*.lan",
                    "*.airport.com",
                ],
            };

            const proxies = [
                { name: "node-1", server: "node1.airport.com" },
                { name: "node-2", server: "node2.airport.com" },
            ];

            const extracted = extractPrivateDns(originalDns, proxies);
            expect(extracted.privateDNS).to.include("10.0.0.53#DIRECT");
            expect(extracted.privateDNS).to.include("https://private.airport-dns.com/dns-query");
            expect(extracted.privateDNS).to.not.include("223.5.5.5");
            expect(extracted.privateDNS).to.not.include("8.8.8.8");

            // Simplified policy should cover node domains
            expect(extracted.proxyServerPolicy).to.have.property("+.airport.com");
            expect(extracted.proxyFakeIpFilter).to.include("*.airport.com");
        });
    });

    describe("Mihomo Smart Preset with full DNS and private DNS injection", function () {
        it("generates complete DNS and hosts in output", function () {
            const inputYaml = `
dns:
  nameserver:
    - 223.5.5.5
    - 198.51.100.55
  fake-ip-filter:
    - "*.special-node.com"
proxies:
  - name: "🇭🇰 香港 01"
    type: ss
    server: hk01.special-node.com
    port: 8388
    cipher: aes-128-gcm
    password: test
`;
            const result = buildMihomoSmartClash(inputYaml);
            expect(result).to.include("dns:");
            expect(result).to.include("hosts:");
            expect(result).to.include("enhanced-mode: fake-ip");
            expect(result).to.include("cache-algorithm: arc");
            expect(result).to.include("proxy-server-nameserver:");
            expect(result).to.include("direct-nameserver:");
            expect(result).to.include("'+.mcdn.bilivideo.com': '0.0.0.0'");
            expect(result).to.include("'services.googleapis.cn': 'services.googleapis.com'");

            // Private DNS should be extracted and injected into policy
            expect(result).to.include("proxy-server-nameserver-policy:");
            expect(result).to.include("198.51.100.55");
            expect(result).to.include("*.special-node.com");
        });
    });

    describe("sing-box target with hosts mapping", function () {
        it("rewrites node server to IP while preserving SNI, without polluting sing-box dns", function () {
            const yamlWithHosts = `
hosts:
  '+.airport.com': '104.21.5.10'
proxies:
  - name: "🇭🇰 香港 01"
    type: vmess
    server: hk01.airport.com
    port: 443
    uuid: 12345678-1234-1234-1234-123456789012
    alterId: 0
    cipher: auto
    tls: true
    network: ws
`;
            const docInfo = parseSubscriptionDoc(yamlWithHosts);
            const mappedNodes = applyHostsToProxies(docInfo.nodes, docInfo.hosts);
            const { outbounds } = fromNodes(mappedNodes);

            const vmessOutbound = outbounds.find((o) => o.tag === "🇭🇰 香港 01");
            expect(vmessOutbound).to.not.equal(undefined);
            expect(vmessOutbound.server).to.equal("104.21.5.10");
            expect(vmessOutbound.tls.server_name).to.equal("hk01.airport.com");
        });
    });
});
