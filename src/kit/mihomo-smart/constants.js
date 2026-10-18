// Constants and configurations for Mihomo Smart Preset
// 精简现代成熟设计：精美 SVG 图标、负载均衡、单层地区自动优选、高低倍率与核心服务精准分流

export const ICON_BASE_URL = "https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/";
export const RULE_SET_BASE_URL = "https://cdn.jsdmirror.com/gh/appshubcc/bett-rules@meta/geo/";

// Global exclude regex for filtering junk/notice/expired nodes
export const EXCLUDE_FILTER =
    /群|返利|循环|官网|客服|网站|网址|获取|订阅|流量|到期|机场|下次|版本|官址|备用|过期|已用|联系|邮箱|工单|贩卖|通知|倒卖|防止|国内|地址|频道|电报|无法|说明|提示|访问|支持|教程|关注|更新|作者|加入|超时|收藏|优惠|福利|邀请|好友|失联|选择|剩余|公益|发布|DIZTNA|通路|登录|禁止|定时|渠道|牢记|永久|余额|阁下|本站|刷新|导航|建议|重置|以下|过滤|⚠️|@|t\.me\/\+|\bexpire\b|\bhttps?:\/\/|\.com|\btraffic\b/iu;

// Region definitions with SVG icons and matching regexes
export const REGION_DEFINITIONS = [
    {
        name: "🇭🇰 香港",
        flag: "🇭🇰",
        regex: /🇭🇰|香港|(?<![A-Za-z])HKG?(?![A-Za-z])|hong\s*kong/i,
        icon: `${ICON_BASE_URL}HongKong.svg`,
    },
    {
        name: "🇯🇵 日本",
        flag: "🇯🇵",
        regex: /🇯🇵|日本|东京|大阪|京都|(?<![A-Za-z])JPN?(?![A-Za-z])|japan/i,
        icon: `${ICON_BASE_URL}Japan.svg`,
    },
    {
        name: "🇺🇸 美国",
        flag: "🇺🇸",
        regex:
            /🇺🇸|美国|纽约|洛杉矶|旧金山|芝加哥|休斯顿|迈阿密|西雅图|波士顿|华盛顿|拉斯维加斯|圣何塞|圣地亚哥|(?<![A-Za-z])USA?(?![A-Za-z])|america|united\s*states/i,
        icon: `${ICON_BASE_URL}America.svg`,
    },
    {
        name: "🇸🇬 新加坡",
        flag: "🇸🇬",
        regex: /🇸🇬|新加坡|狮城|(?<![A-Za-z])SGP?(?![A-Za-z])|singapore/i,
        icon: `${ICON_BASE_URL}Singapore.svg`,
    },
    {
        name: "🧋 台湾",
        flag: "🧋",
        regex: /🧋|🇹🇼|台湾|台北|高雄|(?<![A-Za-z])TWN?(?![A-Za-z])|taiwan/i,
        icon: `${ICON_BASE_URL}Taiwan.svg`,
    },
];

// Invisible / zero-width characters: some airports insert these to disrupt regex matching.
// Intentionally preserves semantic characters:
// - U+200C / U+200D (ZWNJ / ZWJ): emoji sequences and cursive joins
// - U+FE00–U+FE0F: emoji variation selectors
export const INVISIBLE_CHARS_REGEX =
    /[\u00AD\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u115F\u1160\u3164\uFFA0]/g;

export function toMatchableName(name) {
    return typeof name === "string" ? name.replace(INVISIBLE_CHARS_REGEX, "") : name;
}

export const LOW_RATE_REGION_NAME = "💰 低倍率节点";
export const HIGH_RATE_REGION_NAME = "💎 高倍率节点";
export const MANUAL_SELECT_NAME = "🎯 手动选择";

export const RATE_REGION_DEFINITIONS = [
    {
        name: LOW_RATE_REGION_NAME,
        regex:
            /^(?!.*(?:剩|期)).*(?:(?<![\d.])0(\.[0-5]|[*×✕✖⨯⨉x倍]))|(?:[*×✕✖⨯⨉x]0)|^(?!.*(?:客户端|软件)).*下载|低倍|免费|(?<![A-Za-z])free(?![A-Za-z])/i,
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

// Base rule providers for direct connections and foundational routing
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
    fakeip_filter: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/fakeip-filter.mrs`,
        path: "./ruleset/fakeip-filter.mrs",
    },
    douyin: {
        ...ruleProviderCommonDomain,
        url: `${RULE_SET_BASE_URL}geosite/douyin.mrs`,
        path: "./ruleset/douyin.mrs",
    },
};

// Prefix routing rules: internal & CN services routed directly
export const PREFIX_RULES = [
    "RULE-SET,private,DIRECT",
    "RULE-SET,private_ip,DIRECT",
    "RULE-SET,geolocation-cn,DIRECT",
    "RULE-SET,games_cn,DIRECT",
    "RULE-SET,epicgames,DIRECT",
    "RULE-SET,nvidia_cn,DIRECT",
    "RULE-SET,apple_cn,DIRECT",
    "RULE-SET,microsoft_cn,DIRECT",
    "DOMAIN,fsend.cn,DIRECT",
    "DOMAIN,international-gfe.download.nvidia.com,DIRECT",
];

// Foreign QUIC blocking rule
export const BLOCK_FOREIGN_QUIC = [
    "AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((RULE-SET,cn_additional),(RULE-SET,cn_ip,no-resolve)))))),REJECT",
];

// Fallback routing rules
export const FALLBACK_RULES = [
    "RULE-SET,geolocation-!cn,🚀 节点选择",
    "RULE-SET,cn_ip,DIRECT",
    "RULE-SET,private_ip,DIRECT",
    "MATCH,🐟 漏网之鱼",
];

// Common options for proxy groups
export const GROUP_BASE_OPTION = {
    interval: 300,
    timeout: 3000,
    url: "http://www.gstatic.com/generate_204",
    lazy: true,
    "max-failed-times": 3,
};

// Core high-value service routing configs (精炼成熟的 5 大业务)
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
        name: "AI",
        type: "select",
        defaultSelected: "🇺🇸 美国",
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
];
