// Detect a known GitHub-mirror wrapper and recover the original URL.
//
// ghp.ci (and similar proxies) wrap a GitHub Raw/Gist URL inside their own
// path: `https://ghp.ci/https://raw.githubusercontent.com/...`.  This module
// peels that wrapper back to the original HTTPS address, but only when the
// inner URL is a well-known GitHub host.  Arbitrary nested URLs, credentials,
// ports, query strings or fragments are rejected — there is no general
// "unwrap one level" here, only a precise whitelist.
//
// Ported from Tower's RuleSchemeImportService.originalGitHubURL.

const GITHUB_RAW_HOSTS = new Set([
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
]);

// originalGitHubURL(url) → URL | null
//
// `url` may be a string or a URL object.  Returns the unwrapped original when
// the wrapper matches the whitelist, null otherwise.
export function originalGitHubURL(url) {
    let parsed;
    if (url instanceof URL) {
        parsed = url;
    } else if (typeof url === "string") {
        try {
            parsed = new URL(url);
        } catch (_e) {
            return null;
        }
    } else {
        return null;
    }

    if (parsed.protocol !== "https:") return null;
    if (parsed.host !== "ghp.ci") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port) return null;
    if (parsed.search || parsed.hash) return null;

    // The path should be /https://... — strip the leading slash.
    const inner = parsed.pathname.startsWith("/")
        ? parsed.pathname.slice(1)
        : parsed.pathname;
    if (!inner.startsWith("https://")) return null;

    let original;
    try {
        original = new URL(inner);
    } catch (_e) {
        return null;
    }

    if (original.protocol !== "https:") return null;
    if (original.username || original.password) return null;
    if (original.port) return null;
    if (original.search || original.hash) return null;
    if (!GITHUB_RAW_HOSTS.has(original.host)) return null;
    // A GitHub Raw URL has at least 4 path components: /owner/repo/branch/file
    if (original.pathname.split("/").filter(Boolean).length < 4) return null;

    return original;
}

export default { originalGitHubURL };
