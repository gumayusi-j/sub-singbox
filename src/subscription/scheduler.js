// Background scheduler for automated subscription refreshes and cloud sync.
//
// 自动化运维执行闭环流程：
// 1. 定时触发或手动触发时，全量更新所有订阅节点（包括未启用的节点，确保本地所有节点数据最新）；
// 2. 启用状态作为生成配置的过滤开关：在生成客户端配置时，自动基于各源启用的最新节点；
// 3. 扫描已上传到 GitHub Gist 的配置方案 (syncProfiles)，按照原有参数重新生成最新配置；
// 4. 静默提交最新生成的配置到 GitHub Gist，保证订阅客户端随时获得最新节点配置。

import { refreshMany } from "./refresh";
import { renderSubscription } from "./render";
import { resolveTarget } from "./targets";

export const DEFAULT_SCHEDULER_INTERVAL_MINUTES = 360; // 6 小时默认维护周期

export function createScheduler(options = {}) {
    const store = options.store;
    const coordinator = options.coordinator;
    const config = options.config || {};
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const now = options.now || (() => new Date());
    const logger = options.logger || console.log;

    const storedSettings = store && typeof store.getSettings === "function" ? store.getSettings() : null;
    const storedScheduler = storedSettings && storedSettings.scheduler;

    // Configurable interval in minutes (default 360 min / 6 hours; 0 or negative disables periodic polling)
    let intervalMinutes = Number(
        (storedScheduler && storedScheduler.intervalMinutes) ||
        process.env.REFRESH_INTERVAL ||
        (config.scheduler && config.scheduler.intervalMinutes) ||
        DEFAULT_SCHEDULER_INTERVAL_MINUTES
    );
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) {
        intervalMinutes = DEFAULT_SCHEDULER_INTERVAL_MINUTES;
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

    async function runJob(jobOptions = {}) {
        if (isRunning) return { ok: false, error: "job already in progress" };
        isRunning = true;
        const startedAt = now().toISOString();
        const forceSyncGist = jobOptions && jobOptions.forceSyncGist === true;

        try {
            // 步骤 1：后台全量静默更新所有节点（包括未启用的节点，保证最新可用性与快照）
            const refreshRes = await refreshMany(store, null, {
                fetchImpl,
                coordinator,
                now,
                allSources: true,
            });

            lastRunAt = startedAt;
            const changedAny = (refreshRes.results || []).some((r) => r.changed);

            let gistResult = null;
            const settings = (store && typeof store.getSettings === "function" ? store.getSettings() : null) || {};
            const gist = settings.gist || (config && config.gist);

            // 步骤 2：基于已上传到 Gist 的配置 (syncProfiles)，按启用节点重新渲染各配置，并静默提交至 Gist
            if (gist && gist.id && gist.token) {
                const shouldSyncGist = forceSyncGist || changedAny || !lastGistSync || (lastGistSync && !lastGistSync.ok);
                if (shouldSyncGist) {
                    const filesToSync = {};
                    const syncProfiles = Array.isArray(gist.syncProfiles) ? gist.syncProfiles : [];

                    if (syncProfiles.length > 0) {
                        for (const profile of syncProfiles) {
                            try {
                                const resolvedTarget = resolveTarget({ queryTarget: profile.target || "sing-box" });
                                if (!resolvedTarget) continue;

                                const sourceObj = profile.sourceId ? store.get(profile.sourceId) : null;
                                const renderSpec = profile.sourceId
                                    ? { kind: "source", source: sourceObj, id: profile.sourceId }
                                    : { kind: "global" };

                                const renderOptions = Object.assign(
                                    {},
                                    settings.defaultOptions || {},
                                    profile.options || {},
                                    {
                                        target: resolvedTarget.target,
                                        out: profile.out || "config",
                                        nodePipeline: profile.nodePipeline,
                                        aclPreset: profile.aclPreset,
                                        nodeFilter: profile.nodeFilter,
                                        remoteDns: profile.remoteDns,
                                        localDns: profile.localDns,
                                        ipv6Enabled: profile.ipv6Enabled,
                                        sourceIds: profile.sourceIds,
                                    }
                                );

                                const rendered = renderSubscription(store, renderSpec, renderOptions);
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
                        // 回退兼容：仅在用户未保存 syncProfiles 且显式开启旧版 autoSync 时
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
                            gistResult = { ok: false, error: gistErr && gistErr.message ? gistErr.message : String(gistErr) };
                            lastGistSync = gistResult;
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
            if (store && typeof store.setSettings === "function") {
                try {
                    store.setSettings({ scheduler: { intervalMinutes: val } });
                } catch (_e) {}
            }
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

export default { createScheduler, DEFAULT_SCHEDULER_INTERVAL_MINUTES };
