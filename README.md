# sub-singbox

把 Sub-Store 的代理解析/归一化内核抽出来，加上"完整 sing-box 配置"拼装能力的最小独立工具（Node 库 + Web）。

链路：`导入(HTTP 订阅 / 粘贴文本 / YAML·JSON 节点列表)` → `解析+隐式归一化修复` → `sing-box outbounds/endpoints` → `拼装完整 sing-box 配置`。

> 说明：`src/core/proxy-utils`、`src/utils/*`、`src/constants.js`、`src/vendor/md5.js` 基于 [Sub-Store](https://github.com/sub-store-org/Sub-Store)（AGPL-3.0）。本工程不提供 Sub-Store 的 Web 服务/数据库/脚本算子链，只保留 parse/produce 内核。

## 快速开始

```bash
pnpm install
pnpm test          # mocha（含移植的内核用例 + kit 用例）
```

### Web 页面

本地浏览器界面（无需额外依赖）：

```bash
pnpm web                          # 启动后打开 http://127.0.0.1:8788/
pnpm web -- --port 9000           # 指定监听端口
pnpm web -- --host 0.0.0.0 --port 8080
pnpm web -- --config my-config.json
pnpm web -- --help
```

`npm/pnpm run` 需用 `--` 把参数透传给 node；直接 `node -r @babel/register -r ./preload src/web/index.js --port 9000` 同理。

- 支持订阅文本 / 远程 URL 输入，可展开常用配置（入站端口、tun、final、规则等）。
- 结果三视图：节点表格 / outbounds·endpoints JSON / 完整 sing-box 配置 JSON，可复制或下载 `.json`。
- 服务端 `POST /api/convert` 复用 `kit/convert.js` + `kit/assemble.js`。

**监听配置**：默认 `127.0.0.1:8788`。复制 `singbox-web.config.example.json` 为
`singbox-web.config.json` 修改即可：

```json
{ "listen": { "host": "127.0.0.1", "port": 8788 }, "maxBodyBytes": 1048576 }
```

优先级从高到低：**启动参数（`--port`/`--host`/`--config`） > 环境变量（`HOST` / `PORT` /
`SINGBOX_WEB_CONFIG` 自定义配置文件路径） > 配置文件 > 默认值**。

### 打包为单文件（Web）

把源码 + 依赖 + 页面 `public/index.html` 全部打进一个 **自包含的 `.js`**，
产物只需 `node` 运行（不再需要 `@babel/register`、`preload.js`、`node_modules`、
`public/` 目录）：

```bash
pnpm build            # esbuild 输出 dist/singbox-kit-web.js（约 2MB）
pnpm start -- --port 9000     # 或用裸 node 直接跑：node dist/singbox-kit-web.js --port 9000
```

产物支持与源码模式相同的全部参数/优先级（`--port`/`--host`/`--config`、`PORT`/`HOST`
环境变量）。任意拷贝到其他装了 Node 的机器即可运行。

## License / Attribution

AGPL-3.0。部分源码改编自 Sub-Store（上游 AGPL-3.0），见文件头与上方说明。
