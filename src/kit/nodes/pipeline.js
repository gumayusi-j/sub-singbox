// Node processing pipeline: operators for cleaning, flag injection,
// quick settings, regex renaming, and deduplication.

export const NOTICE_REGEX =
    /(?:剩余流量|剩余|到期|过期|重置|官网|网址|网站|客服|官方|通知|公告|提示|traffic|expire|remaining|reset|0\.0+x|工单|贩卖|群|频道|返利|循环|备用|说明|教程|关注|更新|作者|加入|超时|优惠|福利|邀请|失联|发布|永久|余额|刷新|导航|建议|⚠️|@|t\.me\/)/i;

export const COUNTRY_FLAG_RULES = [
    { flag: "🇭🇰", regex: /(?:🇭🇰|香港|(?<![a-zA-Z])HKG?(?![a-zA-Z])|hong\s*kong)/i },
    { flag: "🇯🇵", regex: /(?:🇯🇵|日本|东京|大阪|京都|(?<![a-zA-Z])JPN?(?![a-zA-Z])|japan)/i },
    { flag: "🇺🇸", regex: /(?:🇺🇸|美国|美|纽约|洛杉矶|硅谷|西雅图|芝加哥|(?<![a-zA-Z])USA?(?![a-zA-Z])|america|united\s*states)/i },
    { flag: "🇸🇬", regex: /(?:🇸🇬|新加坡|狮城|(?<![a-zA-Z])SGP?(?![a-zA-Z])|singapore)/i },
    { flag: "🇹🇼", regex: /(?:🇹🇼|🧋|台湾|台北|台中|高雄|(?<![a-zA-Z])TWN?(?![a-zA-Z])|taiwan)/i },
    { flag: "🇰🇷", regex: /(?:🇰🇷|韩国|首尔|(?<![a-zA-Z])(KOR?|KR)(?![a-zA-Z])|korea)/i },
    { flag: "🇬🇧", regex: /(?:🇬🇧|英国|伦敦|(?<![a-zA-Z])(UK|GBR?)(?![a-zA-Z])|britain|england|united\s*kingdom)/i },
    { flag: "🇩🇪", regex: /(?:🇩🇪|德国|法兰克福|柏林|(?<![a-zA-Z])(DE|DEU)(?![a-zA-Z])|germany)/i },
    { flag: "🇫🇷", regex: /(?:🇫🇷|法国|巴黎|(?<![a-zA-Z])(FR|FRA)(?![a-zA-Z])|france)/i },
    { flag: "🇳🇱", regex: /(?:🇳🇱|荷兰|阿姆斯特丹|(?<![a-zA-Z])(NL|NLD)(?![a-zA-Z])|netherlands)/i },
    { flag: "🇨🇭", regex: /(?:🇨🇭|瑞士|苏黎世|日内瓦|(?<![a-zA-Z])(CH|CHE)(?![a-zA-Z])|switzerland)/i },
    { flag: "🇦🇺", regex: /(?:🇦🇺|澳大利亚|澳洲|悉尼|墨尔本|(?<![a-zA-Z])(AU|AUS)(?![a-zA-Z])|australia)/i },
    { flag: "🇨🇦", regex: /(?:🇨🇦|加拿大|温哥华|多伦多|(?<![a-zA-Z])(CA|CAN)(?![a-zA-Z])|canada)/i },
    { flag: "🇷🇺", regex: /(?:🇷🇺|俄罗斯|莫斯科|伯力|(?<![a-zA-Z])(RU|RUS)(?![a-zA-Z])|russia)/i },
    { flag: "🇲🇾", regex: /(?:🇲🇾|马来西亚|大马|吉隆坡|(?<![a-zA-Z])(MY|MYS)(?![a-zA-Z])|malaysia)/i },
    { flag: "🇹🇭", regex: /(?:🇹🇭|泰国|曼谷|(?<![a-zA-Z])(TH|THA)(?![a-zA-Z])|thailand)/i },
    { flag: "🇻🇳", regex: /(?:🇻🇳|越南|胡志明|河内|(?<![a-zA-Z])(VN|VNM)(?![a-zA-Z])|vietnam)/i },
    { flag: "🇵🇭", regex: /(?:🇵🇭|菲律宾|马尼拉|(?<![a-zA-Z])(PH|PHL)(?![a-zA-Z])|philippines)/i },
    { flag: "🇮🇳", regex: /(?:🇮🇳|印度|孟买|(?<![a-zA-Z])(IN|IND)(?![a-zA-Z])|india)/i },
    { flag: "🇹🇷", regex: /(?:🇹🇷|土耳其|伊斯坦布尔|(?<![a-zA-Z])(TR|TUR)(?![a-zA-Z])|turkey)/i },
    { flag: "🇦🇪", regex: /(?:🇦🇪|阿联酋|迪拜|(?<![a-zA-Z])(AE|ARE)(?![a-zA-Z])|dubai|emirates)/i },
    { flag: "🇮🇹", regex: /(?:🇮🇹|意大利|米兰|罗马|(?<![a-zA-Z])(IT|ITA)(?![a-zA-Z])|italy)/i },
    { flag: "🇪🇸", regex: /(?:🇪🇸|西班牙|马德里|巴塞罗那|(?<![a-zA-Z])(ES|ESP)(?![a-zA-Z])|spain)/i },
    { flag: "🇸🇪", regex: /(?:🇸🇪|瑞典|斯德哥尔摩|(?<![a-zA-Z])(SE|SWE)(?![a-zA-Z])|sweden)/i },
    { flag: "🇦🇷", regex: /(?:🇦🇷|阿根廷|(?<![a-zA-Z])(AR|ARG)(?![a-zA-Z])|argentina)/i },
    { flag: "🇧🇷", regex: /(?:🇧🇷|巴西|圣保罗|(?<![a-zA-Z])(BR|BRA)(?![a-zA-Z])|brazil)/i },
];

export function extractCountryFlag(name) {
    if (!name || typeof name !== "string") return null;
    for (const rule of COUNTRY_FLAG_RULES) {
        if (rule.regex.test(name)) return rule.flag;
    }
    return null;
}

export function stripExistingFlags(str) {
    if (!str || typeof str !== "string") return "";
    return str
        .replace(/[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]|🧋|🏳️‍🌈/g, "")
        .replace(/^\s*[-_|/]\s*|\s*[-_|/]\s*$/g, "")
        .trim();
}

/**
 * Clean announcement / dummy notice nodes.
 */
export function cleanNoticeNodes(nodes, warnings = []) {
    if (!Array.isArray(nodes)) return [];
    const kept = [];
    let removedCount = 0;

    for (const node of nodes) {
        if (!node) continue;
        const name = node.name || node.tag || "";
        const server = (node.server || "").trim().toLowerCase();
        const port = Number(node.port || node.server_port || 0);

        const isNoticeName = NOTICE_REGEX.test(name);
        const isDummyAddress =
            (server === "127.0.0.1" || server === "0.0.0.0" || server === "localhost") &&
            (port === 0 || port === 1080);
        const isPortZero = port === 0;

        if (isNoticeName || isDummyAddress || isPortZero) {
            removedCount += 1;
            continue;
        }
        kept.push(node);
    }

    if (removedCount > 0 && Array.isArray(warnings)) {
        warnings.push({
            message: `已自动清洗 ${removedCount} 个公告或无用节点`,
            path: "pipeline:cleanNoticeNodes",
        });
    }

    return kept;
}

/**
 * Inject country flag emoji to node names if matching.
 */
export function injectCountryFlags(nodes) {
    if (!Array.isArray(nodes)) return [];
    return nodes.map((node) => {
        if (!node) return node;
        const currentName = node.name || node.tag || "";
        const flag = extractCountryFlag(currentName);
        if (!flag) return node;

        const clean = stripExistingFlags(currentName);
        const newName = `${flag} ${clean}`;
        const updated = Object.assign({}, node);
        if (node.name !== undefined) updated.name = newName;
        if (node.tag !== undefined) updated.tag = newName;
        return updated;
    });
}

/**
 * Apply quick settings (force UDP, skip-cert-verify, TCP Fast Open).
 */
export function applyQuickSettings(nodes, settings = {}) {
    if (!Array.isArray(nodes)) return [];
    const hasUdp = settings.udp === true;
    const hasSkipCert = settings.skipCertVerify === true || settings.skipCert === true;
    const hasTfo = settings.tfo === true;

    if (!hasUdp && !hasSkipCert && !hasTfo) return nodes;

    return nodes.map((node) => {
        if (!node) return node;
        const updated = Object.assign({}, node);
        if (hasUdp) {
            updated.udp = true;
        }
        if (hasSkipCert) {
            updated["skip-cert-verify"] = true;
            if (updated.tls && typeof updated.tls === "object") {
                updated.tls = Object.assign({}, updated.tls, { insecure: true });
            }
        }
        if (hasTfo) {
            updated.tfo = true;
            updated["tcp-fast-open"] = true;
        }
        return updated;
    });
}

/**
 * Apply regex rename rules.
 * @param {Array} nodes
 * @param {Array<{ pattern: string, replacement: string, flags?: string }>} rules
 */
export function applyRegexRename(nodes, rules = []) {
    if (!Array.isArray(nodes) || !Array.isArray(rules) || rules.length === 0) {
        return nodes;
    }

    const compiledRules = [];
    for (const r of rules) {
        if (!r || !r.pattern) continue;
        try {
            const re = new RegExp(r.pattern, r.flags || "g");
            compiledRules.push({ re, replacement: r.replacement !== undefined ? r.replacement : "" });
        } catch (_e) {
            // Skip invalid regex
        }
    }

    if (compiledRules.length === 0) return nodes;

    return nodes.map((node) => {
        if (!node) return node;
        let name = node.name || node.tag || "";
        for (const { re, replacement } of compiledRules) {
            name = name.replace(re, replacement);
        }
        name = name.trim();
        const updated = Object.assign({}, node);
        if (node.name !== undefined) updated.name = name;
        if (node.tag !== undefined) updated.tag = name;
        return updated;
    });
}

/**
 * Deduplicate nodes by physical address (type + server + port + credential).
 */
export function dedupeByAddress(nodes, warnings = []) {
    if (!Array.isArray(nodes)) return [];
    const seen = new Set();
    const kept = [];
    let dupCount = 0;

    for (const node of nodes) {
        if (!node) continue;
        const port = node.port || node.server_port || "";
        const key = `${node.type || ""}:${node.server || ""}:${port}:${node.uuid || node.password || ""}`;
        if (key !== ":::" && seen.has(key)) {
            dupCount += 1;
            continue;
        }
        seen.add(key);
        kept.push(node);
    }

    if (dupCount > 0 && Array.isArray(warnings)) {
        warnings.push({
            message: `按服务器地址与端口去除了 ${dupCount} 个物理重复节点`,
            path: "pipeline:dedupeByAddress",
        });
    }

    return kept;
}

/**
 * Main pipeline runner.
 */
export function executeNodePipeline(nodes, options = {}, warnings = []) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];

    let result = nodes;

    // 1. Clean notice / advertisement nodes (default true if options provided unless explicitly false)
    const shouldClean = options.cleanNotice !== undefined ? options.cleanNotice : options.cleanNoticeNodes;
    if (shouldClean !== false) {
        result = cleanNoticeNodes(result, warnings);
    }

    // 2. Regex rename
    if (Array.isArray(options.renameRules) && options.renameRules.length > 0) {
        result = applyRegexRename(result, options.renameRules);
    }

    // 3. Inject country flags
    if (options.injectFlags === true || options.flags === true) {
        result = injectCountryFlags(result);
    }

    // 4. Quick settings (udp, skipCertVerify, tfo)
    if (options.quickSettings) {
        result = applyQuickSettings(result, options.quickSettings);
    }

    // 5. Dedupe by address
    if (options.dedupeAddress === true || options.dedupe === true) {
        result = dedupeByAddress(result, warnings);
    }

    return result;
}

export default {
    cleanNoticeNodes,
    injectCountryFlags,
    applyQuickSettings,
    applyRegexRename,
    dedupeByAddress,
    executeNodePipeline,
    extractCountryFlag,
    stripExistingFlags,
};
