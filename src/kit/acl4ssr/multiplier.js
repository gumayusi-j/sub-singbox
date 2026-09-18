// Multiplier (倍率) group helpers and regex definitions.
//
// Supports three-tier rate filtering:
// - 💰 低倍率节点: strictly < 1x (e.g. 0.2x, 0.5倍, 省流, 低倍)
// - ☕ 正常倍率（1x）: 1x / standard rate (explicit 1x/1.0x/标准/正常, or ordinary non-high nodes when no explicit 1x exists)
// - 💎 高倍率节点: > 1x (e.g. 1.5x, 2x, 10x, 高倍)

export const LOW_RATE_GROUP = "💰 低倍率节点";
export const NORMAL_RATE_GROUP = "☕ 正常倍率（1x）";
export const HIGH_RATE_GROUP = "💎 高倍率节点";

// Low rate: strictly < 1x (e.g. 0.2x, 0.5倍, 省流, 低倍)
export const LOW_RATE_REGEX =
    "((?<!\\d)0\\.\\d+\\s*(?:x|倍)|低倍|省流)";

// High rate: > 1x (e.g. 1.05x, 1.5x, 2x, 10x, 高倍)
export const HIGH_RATE_REGEX =
    "((?<![\\d.])1\\.(?!0+(?:x|倍|\\s))\\d+\\s*(?:x|倍)(?![0-9a-zA-Z])|(?<![\\d.])(?:[2-9]|[1-9]\\d+)(?:\\.\\d+)?\\s*(?:x|倍)(?![0-9a-zA-Z])|高倍)";

// Explicit normal rate: 1x, 1.0x, 1倍, 标准, 正常
export const EXPLICIT_NORMAL_REGEX =
    "((?<![\\d.])1(?:\\.0+)?\\s*(?:x|倍)(?![0-9a-zA-Z])|标准|正常)";

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
    if (tag !== LOW_RATE_GROUP && tag !== NORMAL_RATE_GROUP && tag !== HIGH_RATE_GROUP) {
        return undefined;
    }

    const lowMatches = matchTags(LOW_RATE_REGEX, tags);
    const highMatches = matchTags(HIGH_RATE_REGEX, tags);

    if (tag === LOW_RATE_GROUP) {
        return lowMatches.length > 0 ? lowMatches : null;
    }

    if (tag === HIGH_RATE_GROUP) {
        return highMatches.length > 0 ? highMatches : null;
    }

    if (tag === NORMAL_RATE_GROUP) {
        // Only generate normal rate group when:
        // 1. No < 1x nodes exist (lowMatches.length === 0)
        // 2. > 1x nodes exist (highMatches.length > 0)
        if (lowMatches.length > 0 || highMatches.length === 0) {
            return null;
        }

        const explicitNormalMatches = matchTags(EXPLICIT_NORMAL_REGEX, tags);
        if (explicitNormalMatches.length > 0) {
            return explicitNormalMatches;
        }

        // Smart fallback: when no explicit 1x labels exist, include all ordinary nodes
        // (excluding high-multiplier nodes)
        const highSet = new Set(highMatches);
        const nonHighNodes = tags.filter((t) => !highSet.has(t));
        return nonHighNodes.length > 0 ? nonHighNodes : null;
    }

    return undefined;
}
