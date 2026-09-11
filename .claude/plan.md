# 同步 Tower 1.0.15：导入进度 / 刷新进度 / 镜像恢复 / 严格校验

## 背景

Tower 1.0.14 已同步（`d8f8bce`）。Tower 1.0.15 新增：
- 规则导入三阶段进度（配置下载 → 解析 → 引用规则下载）
- 远程规则集必须全部下载成功才保存方案
- `ghp.ci` 镜像检测 + 原始 GitHub 地址恢复
- 订阅刷新进度 + 取消
- 导入/刷新共用居中进度卡片 UI

sub-singbox 当前 `/api/schemes/import` 跳过远程 RULE-SET provider，且无进度/取消机制。

---

## Phase 1：后端工具 + 远程规则集下载 + ghp.ci 恢复

### 1a. 新建 `src/kit/mirror.js`

纯函数，无网络副作用：

```js
// 检测 ghp.ci 包装的 GitHub Raw/Gist URL，提取原始地址。
// 条件：https://ghp.ci/https://raw.githubusercontent.com/... 或
//       https://ghp.ci/https://gist.githubusercontent.com/...
// 不接受凭据、端口、查询参数。
export function originalGitHubURL(url)  // → URL | null
```

### 1b. 新建 `src/kit/rules/fetch-providers.js`

负责下载远程 provider 内容：

```js
// downloadProviders(providers, options)
//   providers: Array<{ name, type, url, behavior, ... }>
//   options: { fetchImpl?, timeout?, onProgress? }
//   onProgress: (event) → void，event = { stage:'rules', completed, total, sources:[name...] }
//
// 并发下载，超时/HTTP 错误 → 记录失败。
// 返回 { downloaded: Map<name, text>, failures: [{ name, url, reason }] }
export async function downloadProviders(providers, options)
```

### 1c. 扩展 `src/kit/rules/import.js`

扩展 `importMihomoDocument` 使其接受已下载的 provider 内容：

- `importRuleSet` 中：如果 provider 的 content 在 `downloadedContent` Map 中，用它展开规则（复用 `normalizeResourceLines` + `addRule`），不跳过。
- `result.providers` 不再包含已下载的 provider（它们已内联为规则）。
- 保留原来的跳过逻辑作为 fallback。

### 1d. 扩展 `src/subscription/router.js` — SSE 导入端点

新增 `/api/schemes/import-stream`，返回 `text/event-stream`：

1. 推送 `{ type:'stage', stage:'configuration' }`
2. 下载配置文本（URL 导入时），失败推送 `{ type:'error', ... }`
3. 推送 `{ type:'stage', stage:'parsing' }`
4. 解析配置，收集远程 RULE-SET provider URL
5. 推送 `{ type:'stage', stage:'rules', total:N }`
6. 下载 provider，每个 batch 完成推送 `{ type:'progress', completed, total, sources }`
7. 如有失败：推送 `{ type:'error', failures:[{url,reason}] }`，不保存方案
8. 成功：展开规则，保存方案，推送 `{ type:'done', scheme, report }`

ghp.ci 失败条目标记 `retryable:true`。

旧 `/api/schemes/import` 保留但前端不再调用。

### 1e. 新增测试

- `src/test/mirror.spec.js`：originalGitHubURL 各种 URL 格式
- `src/test/rule-import.spec.js` 补充：远程 provider 下载后展开规则
- `src/test/web.spec.js` 补充：SSE 端点返回正确格式，失败时返回 failures

---

## Phase 2：订阅刷新进度 + 取消

### 2a. 扩展 `src/subscription/coordinator.js`

新增 `cancel(id)` / `isCancelled(id)` 支持。

### 2b. 扩展 `src/subscription/refresh.js`

`refreshMany` 接受 `onProgress` 回调：

```js
deps.onProgress: (event) → void
// event = { sourceId, sourceName, completed, total, status:'ok'|'failed'|'skipped' }
```

每个源完成后推送进度。

### 2c. 新建 SSE 刷新端点

`POST /api/subscriptions/refresh-stream`，返回 SSE 事件流：
- `{ type:'start', total }`
- `{ type:'progress', completed, total, sourceId, sourceName, status }`
- `{ type:'done', results, failed }`

新增 `POST /api/subscriptions/cancel-refresh` 取消进行中的刷新。

### 2d. 新增测试

- `src/test/refresh.spec.js` 补充：onProgress 回调触发、取消后结果被忽略

---

## Phase 3：前端 UI

### 3a. SSE 客户端工具函数

在 `index.html` 中新增：

```js
async function importStream(body, onEvent)   // POST /api/schemes/import-stream
async function refreshStream(ids, onEvent)    // POST /api/subscriptions/refresh-stream
```

逐行解析 SSE 事件，调用 `onEvent(parsed)`。

### 3b. 导入进度浮层

替换现有导入对话框的内部内容：

**进度态**（importing=true）：隐藏表单，居中进度卡片，显示阶段 + 来源列表 + 取消按钮。

**错误态**：居中错误卡片（材质/圆角/遮罩），错误详情限高可滚动，单个「确定」按钮，关闭后保留输入草稿。

**成功态**：原有 importReport + ElMessage.success。

### 3c. 订阅刷新进度浮层

新增浮层覆盖在订阅列表上方：
- 居中卡片：正在刷新订阅（2/5）+ 当前源名称 + 取消按钮
- 取消后卡片消失，已完成的源保留结果

### 3d. 样式

新增：
- `.task-overlay` — 轻量遮罩
- `.task-card` — 居中圆角卡片
- `.task-card--error` 错误态
- `@media (prefers-reduced-motion)` / `@media (prefers-contrast: more)` 适配

---

## 实施顺序

1. **Phase 1**（后端）：`mirror.js` → `fetch-providers.js` → 扩展 `import.js` → SSE 端点 → 测试
2. **Phase 2**（后端）：扩展 `coordinator.js` → `refresh.js` → SSE 刷新端点 → 测试
3. **Phase 3**（前端）：SSE 工具 → 导入浮层 → 刷新浮层 → 样式 → `npm test`

每完成一个 phase 跑 `npm test` 验证回归。

---

## 不做的（Tower 1.0.15 iOS/Mac 专属）

- SwiftUI TaskProgressCard / SubscriptionRefreshProgress Observable
- Swift @MainActor 进度回调
- Mac Catalyst / iOS 无障碍/动画适配
- Xcode 本地化字符串
