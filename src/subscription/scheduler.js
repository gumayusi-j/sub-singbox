// Background scheduler for automated subscription refreshes and cloud sync.
//
// Automatically refreshes enabled subscriptions periodically. If any subscription
// snapshot has changed and GitHub Gist is configured, it auto-syncs the rendered
// configuration to GitHub Gist so clients using Gist URLs always have the latest nodes.

import { refreshMany } from "./refresh";
import { renderSubscription } from "./render";
import { resolveTarget } from "./targets";

export function createScheduler(options = {}) {
    const store = options.store;
    const coordinator = options.coordinator;
    const config = options.config || {};
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const now = options.now || (() => new Date());
    const logger = options.logger || console.log;

    // Configurable interval in minutes (default 60 min; 0 or negative disables periodic polling)
    let intervalMinutes = Number(
        process.env.REFRESH_INTERVAL ||
        (config.scheduler && config.scheduler.intervalMinutes) ||
        60
    );
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) {
        intervalMinutes = 60;
    }

    let timer = null;
    let isRunning = false;
    let lastRunAt = null;
    let nextRunAt = null;
    let lastResult = null;
    let lastGistSync = null;

    async function syncToGist(gistConfig, filesMap) {
        if (!gistConfig || !gistConfig.id || !gistConfig.token) return null;
        if (!filesMap || Object.keys(filesMap).length === 0) return null;

        const url = `https://api.github.com/gists/${gistConfig.id}`;
        const body = {
            description: `singbox-kit auto-sync at ${now().toISOString()}`,
            files: {},
        };
        for (const [name, content] of Object.entries(filesMap)) {
            if (typeof content === "string") {
                body.files[name] = { content };
            }
        }

        try {
            const res = await fetchImpl(url, {
                method: "PATCH",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${gistConfig.token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`GitHub API HTTP ${res.status}: ${text}`);
            }
            return { ok: true, syncedAt: now().toISOString(), files: Object.keys(filesMap) };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    }

    async function runJob() {
        if (isRunning) return { ok: false, error: "job already in progress" };
        isRunning = true;
        const startedAt = now().toISOString();
        try {
            const refreshRes = await refreshMany(store, null, {
                fetchImpl,
                coordinator,
                now,
            });

            lastRunAt = startedAt;
            const changedAny = (refreshRes.results || []).some((r) => r.changed);

            let gistResult = null;
            if (changedAny) {
                const settings = store.getSettings() || {};
                const gist = settings.gist;
                // When subscriptions are refreshed, auto-update the actual exported configurations (syncProfiles)
                // that were generated based on these subscriptions. Never blindly push unrequested default files.
                if (gist && gist.id && gist.token) {
                    const filesToSync = {};
                    const syncProfiles = Array.isArray(gist.syncProfiles) ? gist.syncProfiles : [];

                    if (syncProfiles.length > 0) {
                        for (const profile of syncProfiles) {
                            try {
                                const resolvedTarget = resolveTarget({ queryTarget: profile.target || "sing-box" });
                                if (!resolvedTarget) continue;
                                const renderSpec = profile.sourceId
                                    ? { kind: "source", id: profile.sourceId }
                                    : { kind: "global" };
                                const rendered = renderSubscription(store, renderSpec, {
                                    target: resolvedTarget.target,
                                    out: profile.out || "config",
                                    nodePipeline: profile.nodePipeline,
                                });
                                if (rendered && rendered.status === 200) {
                                    filesToSync[profile.fileName] =
                                        typeof rendered.body === "string"
                                            ? rendered.body
                                            : JSON.stringify(rendered.body, null, 2);
                                }
                            } catch (e) {
                                logger("[singbox-kit scheduler] error auto-updating profile " + profile.fileName + ":", e);
                            }
                        }
                    } else if (gist.autoSync === true) {
                        // Fallback only if user explicitly enabled legacy autoSync
                        const targetsToSync = Array.isArray(gist.autoSyncTargets) && gist.autoSyncTargets.length > 0
                            ? gist.autoSyncTargets
                            : ["clash", "sing-box"];

                        try {
                            if (targetsToSync.includes("clash")) {
                                const clashTarget = resolveTarget({ queryTarget: "clash" });
                                if (clashTarget) {
                                    const clashRender = renderSubscription(store, { kind: "global" }, {
                                        target: clashTarget.target,
                                        out: "config",
                                    });
                                    if (clashRender && clashRender.status === 200) {
                                        filesToSync["clash-config.yaml"] = clashRender.body;
                                    }
                                }
                            }

                            if (targetsToSync.includes("sing-box")) {
                                const singboxTarget = resolveTarget({ queryTarget: "sing-box" });
                                if (singboxTarget) {
                                    const sbRender = renderSubscription(store, { kind: "global" }, {
                                        target: singboxTarget.target,
                                        out: "config",
                                    });
                                    if (sbRender && sbRender.status === 200) {
                                        filesToSync["singbox-config.json"] =
                                            typeof sbRender.body === "string"
                                                ? sbRender.body
                                                : JSON.stringify(sbRender.body, null, 2);
                                    }
                                }
                            }
                        } catch (renderErr) {
                            logger("[singbox-kit scheduler] auto-render error:", renderErr);
                        }
                    }

                    if (Object.keys(filesToSync).length > 0) {
                        try {
                            gistResult = await syncToGist(gist, filesToSync);
                            lastGistSync = gistResult;
                        } catch (gistErr) {
                            logger("[singbox-kit scheduler] gist sync error:", gistErr);
                        }
                    }
                }
            }

            lastResult = {
                ok: true,
                startedAt,
                completedAt: now().toISOString(),
                totalSources: (refreshRes.results || []).length,
                changed: changedAny,
                results: refreshRes.results,
                gistSync: gistResult,
            };

            return lastResult;
        } catch (e) {
            lastResult = {
                ok: false,
                startedAt,
                error: e && e.message ? e.message : String(e),
            };
            return lastResult;
        } finally {
            isRunning = false;
            scheduleNext();
        }
    }

    function scheduleNext() {
        if (timer) clearTimeout(timer);
        if (intervalMinutes > 0) {
            const ms = intervalMinutes * 60 * 1000;
            nextRunAt = new Date(Date.now() + ms).toISOString();
            timer = setTimeout(() => {
                runJob().catch((err) => logger("[singbox-kit scheduler] error:", err));
            }, ms);
            if (timer.unref) timer.unref();
        } else {
            nextRunAt = null;
        }
    }

    function start() {
        if (intervalMinutes > 0) {
            scheduleNext();
        }
    }

    function stop() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        nextRunAt = null;
    }

    function setIntervalMinutes(mins) {
        const val = Number(mins);
        if (Number.isFinite(val) && val >= 0) {
            intervalMinutes = val;
            stop();
            if (intervalMinutes > 0) {
                scheduleNext();
            }
        }
    }

    function getStatus() {
        return {
            enabled: intervalMinutes > 0,
            intervalMinutes,
            isRunning,
            lastRunAt,
            nextRunAt,
            lastResult,
            lastGistSync,
        };
    }

    return {
        start,
        stop,
        runJob,
        setIntervalMinutes,
        getStatus,
    };
}

export default { createScheduler };
