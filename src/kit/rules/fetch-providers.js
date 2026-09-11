// Download remote rule-provider payloads for a mihomo import.
//
// When a Clash/Mihomo document references rule-providers of type "http", their
// content must be fetched before the RULE-SET entries that depend on them can
// be expanded into rules.  This module batches those downloads, reports
// progress, and returns both the successful payloads and the failures.
//
// Ported from Tower's RuleSchemeImportService.downloadRequiredRulesets.

import { downloadText } from "../convert";
import { originalGitHubURL } from "../mirror";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeWebPage(text) {
    const head = String(text).trim().slice(0, 512).toLowerCase();
    return head.includes("<!doctype") || head.includes("<html");
}

// sourceName(url) — display-safe label for a download origin.
// Mirrors Tower's RuleImportDownloadFailure.sourceName: host + basename,
// with no credentials or query parameters.
function sourceName(url) {
    try {
        const parsed = typeof url === "string" ? new URL(url) : url;
        const filename = parsed.pathname.split("/").filter(Boolean).pop() || "";
        return [parsed.host || "", filename].filter(Boolean).join(" · ");
    } catch (_e) {
        return typeof url === "string" ? url : "";
    }
}

// downloadProviders(providers, options)
//
//   providers: Array of rule-provider objects from readProviders(), each with
//              at least { name, type, url, behavior }.
//   options:
//     fetchImpl  — fetch implementation (default: globalThis.fetch)
//     timeout    — per-download timeout in ms (default: 30000)
//     onProgress — (event) => void, called after each batch:
//                  { stage:'rules', completed, total, sources:[string] }
//
// Returns:
//   { downloaded: Map<providerName, text>, failures: Array<{ name, url, reason, retryable }> }
//
// Downloads run in parallel within a batch (batch size matches Tower's
// Self.batchSize = 5).  The order of `downloaded` matches provider order.
export async function downloadProviders(providers, options) {
    options = options || {};
    const fetchImpl = options.fetchImpl || fetch;
    const timeout = options.timeout || 30000;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

    const remote = providers.filter(
        (p) =>
            isPlainObject(p) &&
            p.type !== "inline" &&
            typeof p.url === "string" &&
            p.url.trim() !== "",
    );

    if (remote.length === 0) {
        return { downloaded: new Map(), failures: [] };
    }

    const downloaded = new Map();
    const failures = [];
    const BATCH_SIZE = 5;
    let completed = 0;

    for (let start = 0; start < remote.length; start += BATCH_SIZE) {
        const batch = remote.slice(start, start + BATCH_SIZE);

        if (onProgress) {
            onProgress({
                stage: "rules",
                completed,
                total: remote.length,
                sources: batch.map((p) => sourceName(p.url)),
            });
        }

        const results = await Promise.all(
            batch.map(async (provider) => {
                try {
                    const resp = await downloadText(provider.url, { fetchImpl, timeout });
                    if (resp.status < 200 || resp.status >= 300) {
                        return {
                            provider,
                            error: {
                                name: provider.name,
                                url: provider.url,
                                reason: "HTTP " + resp.status,
                                retryable: !!originalGitHubURL(provider.url),
                            },
                        };
                    }
                    const text = resp.text;
                    if (looksLikeWebPage(text)) {
                        return {
                            provider,
                            error: {
                                name: provider.name,
                                url: provider.url,
                                reason: "返回了网页而非规则内容",
                                retryable: false,
                            },
                        };
                    }
                    return { provider, text };
                } catch (e) {
                    const timedOut =
                        e && typeof e.message === "string" && e.message.includes("timeout");
                    return {
                        provider,
                        error: {
                            name: provider.name,
                            url: provider.url,
                            reason: timedOut ? "连接超时，请检查网络或重试" : e.message || String(e),
                            retryable: !!originalGitHubURL(provider.url),
                        },
                    };
                }
            }),
        );

        for (const result of results) {
            completed += 1;
            if (result.error) {
                failures.push(result.error);
            } else {
                downloaded.set(result.provider.name, result.text);
            }
        }

        if (onProgress) {
            onProgress({
                stage: "rules",
                completed,
                total: remote.length,
                sources: batch
                    .map((p) => sourceName(p.url))
                    .filter((_, i) => results[i] && results[i].error),
            });
        }
    }

    return { downloaded, failures };
}

export default { downloadProviders };
