// Multiplier (倍率) group helpers and regex definitions.
//
// Supports three-tier rate filtering:
// - 💰 低倍率节点: strictly < 1x (e.g. 0.2x, 0.5倍, 省流, 低倍)
// - ☕ 正常倍率（1x）: 1x / standard rate (explicit 1x/1.0x/标准/正常, or ordinary non-high nodes when no explicit 1x exists)
// - 💎 高倍率节点: > 1x (e.g. 1.5x, 2x, 10x, 高倍)

export const LOW_RATE_GROUP = "💰 低倍率节点";
export const NORMAL_RATE_GROUP = "☕ 正常倍率节点";
export const HIGH_RATE_GROUP = "💎 高倍率节点";

export function isLowRateGroup(tag) {
    if (typeof tag !== "string") return false;
    return tag === LOW_RATE_GROUP || /低倍率/.test(tag);
}

export function isNormalRateGroup(tag) {
    if (typeof tag !== "string") return false;
    return tag === NORMAL_RATE_GROUP || tag === "☕ 正常倍率（1x）" || /正常倍率/.test(tag);
}

export function isHighRateGroup(tag) {
    if (typeof tag !== "string") return false;
    return tag === HIGH_RATE_GROUP || /高倍率/.test(tag);
}

// Low rate: strictly < 1x (e.g. 0.05x, 0.2x, 0.5倍, 省流, 低倍; ignores 0.0x / 0.00x notice nodes)
export const LOW_RATE_REGEX =
    "((?<!\\d)0\\.(?!0+(?:x|倍|\\s|\\b))\\d+\\s*(?:x|倍)|低倍|省流)";

// High rate: > 1x (e.g. 1.05x, 1.5x, 2x, 10x, 高倍)
export const HIGH_RATE_REGEX =
    "((?<![\\d.])1\\.(?!0+(?:x|倍|\\s))\\d+\\s*(?:x|倍)(?![0-9a-zA-Z])|(?<![\\d.])(?:[2-9]|[1-9]\\d+)(?:\\.\\d+)?\\s*(?:x|倍)(?![0-9a-zA-Z])|高倍)";

// Notice/announcement nodes (e.g. 剩余流量, 套餐到期, 官网, 0.0x) that should not enter proxy groups
export const NOTICE_NODE_REGEX =
    "(?:剩余流量|剩余|到期|过期|重置|官网|网址|官方|通知|公告|提示|traffic|expire|remaining|reset|0\\.0+x)";

// Explicit normal rate: 1x, 1.0x, 1倍, 标准, 正常
export const EXPLICIT_NORMAL_REGEX =
    "((?<![\\d.])1(?:\\.0+)?\\s*(?:x|倍)(?![0-9a-zA-Z])|标准|正常)";

// Negative lookahead regex for normal rate (used in static INIs and external parser fallbacks):
// matches any node name that contains neither high rate (> 1x) nor low rate (< 1x) nor notice indicators.
export const NORMAL_RATE_REGEX =
    "^(?!.*(?:1\\.(?!0+(?:x|倍|\\s|\\b))\\d+\\s*(?:x|倍)|(?:[2-9]|[1-9]\\d+)(?:\\.\\d+)?\\s*(?:x|倍)|高倍|0\\.(?!0+(?:x|倍|\\s|\\b))\\d+\\s*(?:x|倍)|低倍|省流|剩余流量|剩余|到期|过期|重置|官网|网址|官方|通知|公告|提示|traffic|expire|remaining|reset|0\\.0+x)).*$";

export function matchTags(pattern, tags) {
    if (!pattern || pattern === ".*") return tags.slice();
    let re;
    try {
        re = new RegExp(pattern, "iu");
    } catch (_e) {
        return [];
    }
    return tags.filter((t) => re.test(t));
}

/**
 * Resolves matched nodes for multiplier groups.
 * Returns an array of node tags if matched, null if this group should not be emitted,
 * or undefined if the tag is not a multiplier group.
 *
 * @param {string} tag - The group tag.
 * @param {string[]} tags - All available node names/tags.
 * @returns {string[] | null | undefined}
 */
export function resolveMultiplierGroupNodes(tag, tags) {
    if (!isLowRateGroup(tag) && !isNormalRateGroup(tag) && !isHighRateGroup(tag)) {
        return undefined;
    }

    const lowMatches = matchTags(LOW_RATE_REGEX, tags);
    const highMatches = matchTags(HIGH_RATE_REGEX, tags);

    if (isLowRateGroup(tag)) {
        return lowMatches.length > 0 ? lowMatches : null;
    }

    if (isHighRateGroup(tag)) {
        return highMatches.length > 0 ? highMatches : null;
    }

    if (isNormalRateGroup(tag)) {
        // Only generate normal rate group when:
        // 1. No < 1x nodes exist (lowMatches.length === 0)
        // 2. > 1x nodes exist (highMatches.length > 0)
        if (lowMatches.length > 0 || highMatches.length === 0) {
            return null;
        }

        // All standard nodes: every node that is neither high-rate nor low-rate nor notice.
        // Plain node names (e.g. "香港 01") without explicit multiplier suffixes
        // are standard 1x rate nodes by definition.
        const highSet = new Set(highMatches);
        const lowSet = new Set(lowMatches);
        const noticeMatches = matchTags(NOTICE_NODE_REGEX, tags);
        const noticeSet = new Set(noticeMatches);
        const normalNodes = tags.filter(
            (t) => !highSet.has(t) && !lowSet.has(t) && !noticeSet.has(t)
        );
        return normalNodes.length > 0 ? normalNodes : null;
    }

    return undefined;
}
