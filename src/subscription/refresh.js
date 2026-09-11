// Subscription refresh engine.
//
// Behaviour is modelled on Tower's SubscriptionService / AppModel refresh
// path, with two deliberate differences noted inline:
//
//   - sources on the same host are fetched one at a time while different hosts
//     run in parallel, because an airport panel rate-limits a burst of
//     requests from one client (Tower's subscriptionIDsGroupedByHost).
//   - a refresh whose content is unchanged does not bump lastUpdatedAt, which
//     needs a content hash - something Tower does not keep. The hash costs
//     nothing here and makes "refreshed, still current" distinguishable from
//     "refreshed, changed" in the UI.
//
// A failing source never throws out of here and never discards its previous
// snapshot: the last good node list keeps being served while lastError
// explains what went wrong.

import crypto from "crypto";
import {
    downloadText,
    parseNodes,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT_MS,
    CLIENT_GATING_STATUS_CODES,
    FALLBACK_USER_AGENT,
} from "../kit/convert";
import { extractUsage } from "./usage";

// Lane key for sources that make no network request (inline text sources) and
// for URLs this cannot parse a host out of. The leading space matters: a host
// from `new URL(...).host` can never start with one, so no real host can ever
// share this lane.
export const LOCAL_LANE = " (local)";

function isSuccessStatus(status) {
    return status >= 200 && status < 300;
}

function subscriptionError(message, status) {
    const error = new Error(message);
    if (Number.isInteger(status)) error.status = status;
    return error;
}

export function sha256(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function countProtocols(nodes) {
    const out = {};
    for (const node of nodes) {
        const type = node && typeof node.type === "string" ? node.type : "unknown";
        out[type] = (out[type] || 0) + 1;
    }
    return out;
}

// Group sources into fetch lanes. Text sources and unparseable URLs land in
// LOCAL_LANE and are serialised with each other, which costs nothing because
// they never touch the network.
export function groupByHost(sources) {
    const lanes = new Map();
    for (const source of sources || []) {
        let key = LOCAL_LANE;
        if (source && source.kind === "url" && typeof source.url === "string") {
            try {
                key = new URL(source.url).host || LOCAL_LANE;
            } catch (_e) {
                key = LOCAL_LANE;
            }
        }
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(source);
    }
    return lanes;
}

// Fetch one source, retrying once with the fallback User-Agent when the panel
// gates the default one. Mirrors Tower's SubscriptionParser.load: the retry
// only happens when the caller did NOT pin a UA (a user who set one gets
// exactly what they asked for), and only for a gating status, an empty body,
// or a body that parses to zero nodes.
//
// Throws on total failure so the caller can record lastError.
export async function downloadWithFallback(source, deps) {
    deps = deps || {};
    const options = source.requestOptions || {};
    const customUserAgent =
        typeof options.userAgent === "string" && options.userAgent.trim() !== ""
            ? options.userAgent.trim()
            : null;
    const headers = options.headers || {};
    const timeout = options.timeout || deps.timeout || DEFAULT_TIMEOUT_MS;
    const defaultUserAgent = deps.defaultUserAgent || DEFAULT_USER_AGENT;

    // null means "use the default UA" rather than a literal header value.
    const sequence = customUserAgent ? [customUserAgent] : [null];
    if (!customUserAgent) sequence.push(FALLBACK_USER_AGENT);

    const attempts = [];
    let lastError = null;

    for (let i = 0; i < sequence.length; i += 1) {
        const userAgent = sequence[i] || defaultUserAgent;
        const hasNext = i < sequence.length - 1;
        const response = await downloadText(source.url, {
            userAgent,
            headers,
            timeout,
            fetchImpl: deps.fetchImpl,
        });

        if (!isSuccessStatus(response.status)) {
            attempts.push({ userAgent, status: response.status, nodeCount: 0 });
            lastError = subscriptionError(
                "subscription download failed HTTP " + response.status + " " + source.url,
                response.status,
            );
            // A non-gating failure (404, 500) will not improve on a retry.
            if (hasNext && CLIENT_GATING_STATUS_CODES.includes(response.status)) continue;
            throw lastError;
        }

        const text = response.text;
        const nodes = parseNodes(text);
        attempts.push({ userAgent, status: response.status, nodeCount: nodes.length });

        if (text.trim() === "") {
            lastError = subscriptionError("subscription body is empty: " + source.url);
            if (hasNext) continue;
            throw lastError;
        }
        if (nodes.length === 0) {
            lastError = subscriptionError(
                "no supported nodes parsed from subscription: " + source.url,
            );
            if (hasNext) continue;
            throw lastError;
        }

        return {
            text,
            nodes,
            status: response.status,
            headers: response.headers,
            usedUserAgent: response.usedUserAgent,
            attempts,
        };
    }

    throw lastError || subscriptionError("subscription download failed: " + source.url);
}

// refreshSource(store, id, deps) -> { ok, changed, source, usage, error, stale }
//
// Never throws: a failure is reported through `error` and recorded on the
// source, leaving the previous snapshot in place.
export async function refreshSource(store, id, deps) {
    deps = deps || {};
    const now = deps.now || (() => new Date());
    const coordinator = deps.coordinator;

    const source = store.get(id);
    if (!source) {
        return { ok: false, error: { message: "source not found", status: null } };
    }

    const ticket = coordinator ? coordinator.begin(id) : null;
    try {
        let text;
        let nodes;
        let headers = {};
        if (source.kind === "text") {
            // An inline source needs no network, but runs through exactly the
            // same hashing / usage / commit path so it behaves like any other.
            text = typeof source.content === "string" ? source.content : "";
            nodes = parseNodes(text);
            if (nodes.length === 0) {
                throw subscriptionError("no supported nodes parsed from source text");
            }
        } else {
            const result = await downloadWithFallback(source, deps);
            text = result.text;
            nodes = result.nodes;
            headers = result.headers;
        }

        const contentHash = "sha256:" + sha256(text);
        const usage = extractUsage(headers, text, nodes);
        const timestamp = now().toISOString();

        // Someone asked for a newer refresh while this one was in flight, so
        // this result is already out of date.
        if (coordinator && !coordinator.isCurrent(id, ticket)) {
            return {
                ok: false,
                stale: true,
                error: { message: "superseded by a newer refresh", status: null },
            };
        }

        const unchanged =
            source.contentHash === contentHash && store.readSnapshot(id) != null;

        const patch = {
            lastAttemptAt: timestamp,
            lastCheckedAt: timestamp,
            lastError: null,
        };
        // A panel that stops reporting the quota should not wipe the last known
        // figure; a transient miss is far more likely than a plan change.
        if (usage) patch.usage = usage;

        if (unchanged) {
            // Bytes are identical, so the snapshot and lastUpdatedAt stay put -
            // only "we checked and it is current" moves.
            patch.lastUpdatedAt = source.lastUpdatedAt;
            patch.contentHash = contentHash;
            patch.nodeCount = source.nodeCount;
            patch.protocols = source.protocols;
        } else {
            store.writeSnapshot(id, text);
            patch.contentHash = contentHash;
            patch.lastUpdatedAt = timestamp;
            patch.nodeCount = nodes.length;
            patch.protocols = countProtocols(nodes);
        }

        const updated = store.patchSource(id, patch);
        if (!updated) {
            return { ok: false, error: { message: "source was removed", status: null } };
        }
        return { ok: true, changed: !unchanged, source: updated, usage: updated.usage };
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        const status = e && Number.isInteger(e.status) ? e.status : null;
        if (coordinator && !coordinator.isCurrent(id, ticket)) {
            return { ok: false, stale: true, error: { message, status } };
        }
        // The previous snapshot, nodeCount and lastUpdatedAt are all left alone
        // here: /sub keeps serving the last good list.
        store.patchSource(id, {
            lastAttemptAt: now().toISOString(),
            lastError: { message, status, at: now().toISOString() },
        });
        return { ok: false, error: { message, status } };
    } finally {
        if (coordinator && ticket) coordinator.finish(id, ticket);
    }
}

// refreshMany(store, ids, deps) -> { results, ok, failed, skipped }
//
// `ids` empty/absent refreshes every enabled source. Results come back in the
// caller's order regardless of which lane finished first.
//
// deps.onProgress — (event) => void, called after each source completes:
//   { sourceId, sourceName, completed, total, status }
//   status is 'ok', 'failed', or 'skipped'.
export async function refreshMany(store, ids, deps) {
    deps = deps || {};
    const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : null;
    const all = store.list();
    const byId = new Map(all.map((s) => [s.id, s]));
    const requested = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
    const selected =
        requested.length > 0
            ? requested.map((id) => byId.get(id)).filter(Boolean)
            : all.filter((s) => s.enabled);
    const skipped = requested.filter((id) => !byId.has(id));
    const total = selected.length;

    if (onProgress) {
        onProgress({ type: "start", total });
    }

    const lanes = groupByHost(selected);
    const outcomes = new Map();
    let completed = 0;
    await Promise.all(
        Array.from(lanes.values()).map(async (lane) => {
            // Serial within a host; the lanes themselves run concurrently.
            for (const source of lane) {
                const outcome = await refreshSource(store, source.id, deps);
                outcomes.set(source.id, outcome);
                completed += 1;
                if (onProgress) {
                    onProgress({
                        sourceId: source.id,
                        sourceName: source.name,
                        completed,
                        total,
                        status: outcome.ok ? "ok" : outcome.stale ? "skipped" : "failed",
                    });
                }
            }
        }),
    );

    const results = selected
        .map((source) => {
            const outcome = outcomes.get(source.id);
            return outcome ? { ...outcome, id: source.id, name: source.name } : null;
        })
        .filter(Boolean);
    const failed = results
        .filter((r) => !r.ok && !r.stale)
        .map((r) => ({ id: r.id, name: r.name, error: r.error }));

    return { results, ok: failed.length === 0, failed, skipped };
}

export default {
    refreshSource,
    refreshMany,
    downloadWithFallback,
    groupByHost,
    sha256,
    LOCAL_LANE,
};
