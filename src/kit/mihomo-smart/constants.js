// Constants and configurations for Mihomo Smart Preset
// Referenced from AIsouler/MyClash (https://github.com/AIsouler/MyClash)

export const ICON_BASE_URL = "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/";
export const RULE_SET_BASE_URL = "https://cdn.jsdmirror.com/gh/appshubcc/bett-rules@meta/geo/";

// Global exclude regex for filtering junk/notice/expired nodes
export const EXCLUDE_FILTER =
    /群|返利|循环|官网|客服|网站|网址|获取|订阅|流量|到期|机场|下次|版本|官址|备用|过期|已用|联系|邮箱|工单|贩卖|通知|倒卖|防止|国内|地址|频道|电报|无法|说明|提示|访问|支持|教程|关注|更新|作者|加入|超时|收藏|优惠|福利|邀请|好友|失联|选择|剩余|公益|发布|DIZTNA|通路|登录|禁止|定时|渠道|牢记|永久|余额|阁下|本站|刷新|导航|建议|重置|以下|过滤|⚠️|@|t\.me\/\+|\bexpire\b|\bhttps?:\/\/|\.com|\btraffic\b/iu;

// Region definitions with SVG icons and matching regexes
export const REGION_DEFINITIONS = [
    {
        name: "香港",
        flag: "🇭🇰",
        regex: /🇭🇰|香港|(?<![A-Za-z])HKG?(?![A-Za-z])|hong\s*kong/i,
        icon: `${ICON_BASE_URL}HongKong.svg`,
    },
    {
        name: "日本",
        flag: "🇯🇵",
        regex: /🇯🇵|日本|东京|大阪|京都|(?<![A-Za-z])JPN?(?![A-Za-z])|japan/i,
        icon: `${ICON_BASE_URL}Japan.svg`,
    },
    {
        name: "美国",
        flag: "🇺🇸",
        regex:
            /🇺🇸|美国|纽约|洛杉矶|旧金山|芝加哥|休斯顿|迈阿密|西雅图|波士顿|华盛顿|拉斯维加斯|圣何塞|圣地亚哥|(?<![A-Za-z])USA?(?![A-Za-z])|america|united\s*states/i,
        icon: `${ICON_BASE_URL}America.svg`,
    },
    {
        name: "新加坡",
        flag: "🇸🇬",
        regex: /🇸🇬|新加坡|狮城|(?<![A-Za-z])SGP?(?![A-Za-z])|singapore/i,
        icon: `${ICON_BASE_URL}Singapore.svg`,
    },
    {
        name: "台湾",
        flag: "🇹🇼",
        regex: /🇹🇼|台湾|台北|高雄|(?<![A-Za-z])TWN?(?![A-Za-z])|taiwan/i,
        icon: `${ICON_BASE_URL}Taiwan.svg`,
    },
];

// Rate region definitions
export const LOW_RATE_REGION_NAME = "低倍率节点";
export const HIGH_RATE_REGION_NAME = "高倍率节点";

export const RATE_REGION_DEFINITIONS = [
    {
        name: LOW_RATE_REGION_NAME,
        regex:
            /^(?!.*(?:剩|期)).*(?:(?<!\d)0(\.[0-5]|[*×✕✖⨯⨉x倍]))|(?:[*×✕✖⨯⨉x]0)|^(?!.*(?:客户端|软件)).*下载|低倍|免费|(?<![A-Za-z])free(?![A-Za-z])/i,
        icon: `${ICON_BASE_URL}Available.svg`,
    },
    {
        name: HIGH_RATE_REGION_NAME,
        regex:
            /(?:[*×✕✖⨯⨉x](?:[2-9]\d*|[1-9]\d+)(?:\.\d+)?)|(?:(?<![\d.])(?:[2-9]\d*|[1-9]\d+)(?:\.\d+)?(?:倍|[*×✕✖⨯⨉x]))/i,
        icon: `${ICON_BASE_URL}Airport.svg`,
    },
];

export const ALL_REGION_DEFINITIONS = [...REGION_DEFINITIONS, ...RATE_REGION_DEFINITIONS];

// Common options for rule providers
const ruleProviderCommonDomain = {
    type: "http",
    format: "mrs",
    interval: 86400,
    behavior: "domain",
};

const ruleProviderCommonIpcidr = {
    type: "http",
    format: "mrs",
    interval: 86400,
    behavior: "ipcidr",
};

// Base rule providers
export const BASE_RULE_PROVIDERS = {
    private: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/private.mrs`,
        path: "./ruleset/private.mrs",
    },
    private_ip: {
        ...ruleProviderCommonIpcidr,
        url: `${RULE_SET_BASE_URL}geoip/private.mrs`,
        path: "./ruleset/private_ip.mrs",
    },
    games_cn: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/category-games@cn.mrs`,
        path: "./ruleset/category-games@cn.mrs",
    },
    epicgames: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/epicgames.mrs`,
        path: "./ruleset/epicgames.mrs",
    },
    nvidia_cn: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/nvidia@cn.mrs`,
        path: "./ruleset/nvidia@cn.mrs",
    },
    apple_cn: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/apple@cn.mrs`,
        path: "./ruleset/apple@cn.mrs",
    },
    microsoft_cn: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/microsoft@cn.mrs`,
        path: "./ruleset/microsoft_cn.mrs",
    },
    "geolocation-cn": {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/geolocation-cn.mrs`,
        path: "./ruleset/geolocation-cn.mrs",
    },
    cn_ip: {
        ...ruleProviderCommonIpcidr,
        url: `${RULE_SET_BASE_URL}geoip/cn.mrs`,
        path: "./ruleset/cn_ip.mrs",
    },
    "geolocation-!cn": {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/geolocation-!cn.mrs`,
        path: "./ruleset/geolocation-!cn.mrs",
    },
    cn_additional: {
        ...ruleProviderCommonDomain,
        url: "https://static-file-global.353355.xyz/rules/cn-additional-list.mrs",
        path: "./ruleset/cn-additional-list.mrs",
    },
};

// Direct proxies definitions for Clash
export const DIRECT_PROXIES = [
    {
        name: "🇨🇳 直连 | 双栈",
        type: "direct",
    },
    {
        name: "🇨🇳 直连 | IPv4优先",
        type: "direct",
        "ip-version": "ipv4-prefer",
    },
    {
        name: "🇨🇳 直连 | IPv6优先",
        type: "direct",
        "ip-version": "ipv6-prefer",
    },
    {
        name: "🇨🇳 直连 | 仅IPv4",
        type: "direct",
        "ip-version": "ipv4",
    },
    {
        name: "🇨🇳 直连 | 仅IPv6",
        type: "direct",
        "ip-version": "ipv6",
    },
];

// Prefix routing rules
export const PREFIX_RULES = [
    "RULE-SET,private,直连",
    "RULE-SET,private_ip,直连",
    "RULE-SET,geolocation-cn,直连",
    "RULE-SET,games_cn,直连",
    "RULE-SET,epicgames,直连",
    "RULE-SET,nvidia_cn,直连",
    "RULE-SET,apple_cn,直连",
    "RULE-SET,microsoft_cn,直连",
    "DOMAIN,fsend.cn,直连",
    "DOMAIN,international-gfe.download.nvidia.com,直连",
];

// Foreign QUIC blocking rule
export const BLOCK_FOREIGN_QUIC = [
    "AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((RULE-SET,cn_additional),(RULE-SET,cn_ip,no-resolve)))))),REJECT",
];

// Fallback routing rules
export const FALLBACK_RULES = [
    "RULE-SET,geolocation-!cn,默认代理",
    "RULE-SET,cn_ip,直连",
    "RULE-SET,private_ip,直连",
    "MATCH,漏网之鱼",
];

// Common options for proxy groups
export const GROUP_BASE_OPTION = {
    interval: 600,
    timeout: 3000,
    url: "https://www.apple.com/library/test/success.html",
    lazy: true,
    "max-failed-times": 3,
    "empty-fallback": "REJECT",
};

// Base groups
export const BASE_GROUPS = [
    {
        name: "手动选择",
        type: "select",
        includeAll: true,
        icon: `${ICON_BASE_URL}Static.svg`,
    },
    {
        name: "自动选择",
        type: "url-test",
        includeAll: true,
        tolerance: 50,
        icon: `${ICON_BASE_URL}Auto.svg`,
    },
    {
        name: "负载均衡",
        type: "load-balance",
        strategy: "sticky-sessions",
        includeAll: true,
        icon: `${ICON_BASE_URL}RoundRobin.svg`,
    },
];

// 21 Detailed Service Routing Configs
export const SERVICE_CONFIGS = [
    {
        name: "AdBlock",
        type: "select",
        reject: true,
        icon: `${ICON_BASE_URL}AdBlock.svg`,
        providers: {
            "category-ads": {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/category-ads.mrs`,
                path: "./ruleset/category-ads.mrs",
            },
        },
        rules: ["RULE-SET,category-ads,AdBlock"],
    },
    {
        name: "FCM",
        type: "select",
        direct: true,
        defaultSelected: "直连",
        icon: `${ICON_BASE_URL}Fcm.svg`,
        providers: {
            googlefcm: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/googlefcm.mrs`,
                path: "./ruleset/googlefcm.mrs",
            },
        },
        rules: ["RULE-SET,googlefcm,FCM"],
    },
    {
        name: "YouTube",
        type: "select",
        icon: `${ICON_BASE_URL}YouTube.svg`,
        providers: {
            youtube: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/youtube.mrs`,
                path: "./ruleset/youtube.mrs",
            },
        },
        rules: ["RULE-SET,youtube,YouTube"],
    },
    {
        name: "Google",
        type: "select",
        icon: `${ICON_BASE_URL}Google.svg`,
        providers: {
            google: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/google.mrs`,
                path: "./ruleset/google.mrs",
            },
            google_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/google.mrs`,
                path: "./ruleset/google_ip.mrs",
            },
        },
        rules: ["RULE-SET,google,Google", "RULE-SET,google_ip,Google,no-resolve"],
    },
    {
        name: "AI",
        type: "select",
        defaultSelected: "美国",
        icon: `${ICON_BASE_URL}OpenAI.svg`,
        providers: {
            ai: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/category-ai-!cn.mrs`,
                path: "./ruleset/ai.mrs",
            },
        },
        rules: ["RULE-SET,ai,AI"],
    },
    {
        name: "Microsoft",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}Microsoft.svg`,
        providers: {
            github: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/github.mrs`,
                path: "./ruleset/github.mrs",
            },
            microsoft: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/microsoft.mrs`,
                path: "./ruleset/microsoft.mrs",
            },
            microsoft_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/microsoft.mrs`,
                path: "./ruleset/microsoft_ip.mrs",
            },
        },
        rules: [
            "RULE-SET,github,默认代理",
            "RULE-SET,microsoft,Microsoft",
            "RULE-SET,microsoft_ip,Microsoft,no-resolve",
        ],
    },
    {
        name: "Apple",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}Apple.svg`,
        providers: {
            apple: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/apple.mrs`,
                path: "./ruleset/apple.mrs",
            },
            apple_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/apple.mrs`,
                path: "./ruleset/apple_ip.mrs",
            },
        },
        rules: ["RULE-SET,apple,Apple", "RULE-SET,apple_ip,Apple,no-resolve"],
    },
    {
        name: "Telegram",
        type: "select",
        icon: `${ICON_BASE_URL}Telegram.svg`,
        providers: {
            telegram: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/telegram.mrs`,
                path: "./ruleset/telegram.mrs",
            },
            telegram_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/telegram.mrs`,
                path: "./ruleset/telegram_ip.mrs",
            },
        },
        rules: ["RULE-SET,telegram,Telegram", "RULE-SET,telegram_ip,Telegram,no-resolve"],
    },
    {
        name: "Steam",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}Steam.svg`,
        providers: {
            steam: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/steam.mrs`,
                path: "./ruleset/steam.mrs",
            },
            steam_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/steam.mrs`,
                path: "./ruleset/steam_ip.mrs",
            },
        },
        rules: ["RULE-SET,steam,Steam", "RULE-SET,steam_ip,Steam,no-resolve"],
    },
    {
        name: "TikTok",
        type: "select",
        defaultSelected: "日本",
        icon: `${ICON_BASE_URL}TikTok.svg`,
        providers: {
            tiktok: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/tiktok.mrs`,
                path: "./ruleset/tiktok.mrs",
            },
            tiktok_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/tiktok.mrs`,
                path: "./ruleset/tiktok_ip.mrs",
            },
        },
        rules: ["RULE-SET,tiktok,TikTok", "RULE-SET,tiktok_ip,TikTok,no-resolve"],
    },
    {
        name: "Twitter",
        type: "select",
        icon: `${ICON_BASE_URL}Twitter.svg`,
        providers: {
            twitter: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/twitter.mrs`,
                path: "./ruleset/twitter.mrs",
            },
            twitter_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/twitter.mrs`,
                path: "./ruleset/twitter_ip.mrs",
            },
        },
        rules: ["RULE-SET,twitter,Twitter", "RULE-SET,twitter_ip,Twitter,no-resolve"],
    },
    {
        name: "Meta",
        type: "select",
        icon: `${ICON_BASE_URL}Meta.svg`,
        providers: {
            meta: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/meta.mrs`,
                path: "./ruleset/meta.mrs",
            },
            facebook_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/facebook.mrs`,
                path: "./ruleset/facebook_ip.mrs",
            },
        },
        rules: ["RULE-SET,meta,Meta", "RULE-SET,facebook_ip,Meta,no-resolve"],
    },
    {
        name: "Line",
        type: "select",
        icon: `${ICON_BASE_URL}Line.svg`,
        providers: {
            line: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/line.mrs`,
                path: "./ruleset/line.mrs",
            },
        },
        rules: ["RULE-SET,line,Line"],
    },
    {
        name: "Netflix",
        type: "select",
        icon: `${ICON_BASE_URL}Netflix.svg`,
        providers: {
            netflix: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/netflix.mrs`,
                path: "./ruleset/netflix.mrs",
            },
            netflix_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/netflix.mrs`,
                path: "./ruleset/netflix_ip.mrs",
            },
        },
        rules: ["RULE-SET,netflix,Netflix", "RULE-SET,netflix_ip,Netflix,no-resolve"],
    },
    {
        name: "Emby",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}Emby.svg`,
        providers: {
            emby: {
                ...ruleProviderCommonDomain,
                url: "https://cdn.jsdmirror.com/gh/666OS/rules@release/mihomo/domain/Emby.mrs",
                path: "./ruleset/emby.mrs",
            },
            emos: {
                ...ruleProviderCommonDomain,
                url: "https://cdn.jsdmirror.com/gh/binaryu/emos-proxy-rule@main/rules/emos-mihomo.mrs",
                path: "./ruleset/emos.mrs",
            },
        },
        rules: [
            "RULE-SET,emby,Emby",
            "RULE-SET,emos,Emby",
            "DOMAIN-SUFFIX,mb3admin.com,Emby",
            "DOMAIN-SUFFIX,nubebelle.com,Emby",
            "DOMAIN-KEYWORD,emby,Emby",
            "PROCESS-NAME,com.mb.android,Emby",
            "PROCESS-NAME,tv.emby.embyatv,Emby",
            "PROCESS-NAME,com.hush.yamby,Emby",
            "PROCESS-NAME,com.jellycine.app,Emby",
            "PROCESS-NAME,com.mountains.hills,Emby",
            "PROCESS-NAME,RodelPlayer.App.exe,Emby",
            "PROCESS-NAME,com.feifeiduck.capyplayer,Emby",
        ],
    },
    {
        name: "PikPak",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}PikPak.svg`,
        providers: {
            pikpak: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/pikpak.mrs`,
                path: "./ruleset/pikpak.mrs",
            },
        },
        rules: ["RULE-SET,pikpak,PikPak"],
    },
    {
        name: "Spotify",
        type: "select",
        direct: true,
        icon: `${ICON_BASE_URL}Spotify.svg`,
        providers: {
            spotify: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/spotify.mrs`,
                path: "./ruleset/spotify.mrs",
            },
            spotify_ip: {
                ...ruleProviderCommonIpcidr,
                url: `${RULE_SET_BASE_URL}geoip/spotify.mrs`,
                path: "./ruleset/spotify_ip.mrs",
            },
        },
        rules: ["RULE-SET,spotify,Spotify", "RULE-SET,spotify_ip,Spotify,no-resolve"],
    },
    {
        name: "Crypto",
        type: "select",
        defaultSelected: "日本",
        icon: `${ICON_BASE_URL}Bitcoin.svg`,
        providers: {
            cryptocurrency: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/category-cryptocurrency.mrs`,
                path: "./ruleset/cryptocurrency.mrs",
            },
        },
        rules: ["RULE-SET,cryptocurrency,Crypto"],
    },
    {
        name: "PayPal",
        type: "select",
        defaultSelected: "美国",
        icon: `${ICON_BASE_URL}PayPal.svg`,
        providers: {
            paypal: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/paypal.mrs`,
                path: "./ruleset/paypal.mrs",
            },
        },
        rules: ["RULE-SET,paypal,PayPal"],
    },
    {
        name: "Patreon",
        type: "select",
        defaultSelected: "香港",
        icon: `${ICON_BASE_URL}Patreon.svg`,
        providers: {
            patreon: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/patreon.mrs`,
                path: "./ruleset/patreon.mrs",
            },
        },
        rules: ["RULE-SET,patreon,Patreon"],
    },
    {
        name: "EHentai",
        type: "select",
        direct: true,
        defaultSelected: "美国",
        icon: `${ICON_BASE_URL}EHentai.svg`,
        providers: {
            ehentai: {
                ...ruleProviderCommonDomain,
                url: `${RULE_SET_BASE_URL}geosite/ehentai.mrs`,
                path: "./ruleset/ehentai.mrs",
            },
        },
        rules: ["RULE-SET,ehentai,EHentai"],
    },
];
