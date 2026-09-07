# sub-singbox

把 Sub-Store 的代理解析/归一化内核抽出来，加上"完整 sing-box 配置"拼装能力的最小独立工具（Node 库 + CLI）。

链路：`导入(HTTP 订阅 / 粘贴文本 / YAML·JSON 节点列表)` → `解析+隐式归一化修复` → `sing-box outbounds/endpoints` → `拼装完整 sing-box 配置`。

> 说明：`src/core/proxy-utils`、`src/utils/*`、`src/constants.js`、`src/vendor/md5.js` 改编自 [Sub-Store](https://github.com/sub-store-org/Sub-Store)（AGPL-3.0）。本工程不提供 Sub-Store 的 Web 服务/数据库/脚本算子链，只保留 parse/produce 内核。

## 快速开始

```bash
pnpm install
pnpm test          # mocha（含移植的内核用例 + kit 用例）
```

### CLI

```bash
# 本地订阅文本文件 -> 完整 sing-box 配置(默认)
pnpm cli --file sub.txt > config.json

# 远程订阅 URL
pnpm cli "https://example.com/sub?token=x" --url > config.json

# 只输出节点 outbounds/endpoints
pnpm cli --file sub.txt --out outbounds > nodes.json

# 规则 + tun 入口
pnpm cli --file sub.txt --rule-file rules.txt --tun --inbound-port 7890 > config.json
```

规则文件 `rules.txt`：每行 `TYPE,CONTENT[,outbound]`，或一个 JSON 数组（元素可为上述描述符，或已是 sing-box matcher，例如 `{"ip_is_private":true,"outbound":"direct"}`）。支持类型见下。

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

优先级从高到低：**CLI 参数（`--port`/`--host`/`--config`） > 环境变量（`HOST` / `PORT` /
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

### 作为库

```js
import { fromText, fromNodes, fromUrl, assemble, toSingboxConfig } from "singbox-kit";

const parsed = fromText(text);            // -> { outbounds, endpoints }
const parsed2 = fromNodes(nodeObjects);   // 直接喂 mihomo 风格节点对象
const parsed3 = await fromUrl("https://.../sub");

const config = assemble(parsed, {
  proxyGroupTag: "PROXY",
  inboundPort: 1080,
  tun: false,
  rules: [{ type: "DOMAIN-SUFFIX", content: "doubleclick.net", outbound: "block" }],
});
console.log(JSON.stringify(config, null, 2));
```

`sources 是 URL / 文本 / 节点数组 时的捷径`：

```js
const config = await toSingboxConfig("https://example.com/sub", { url: true });
```

## 输入

- HTTP(S) 订阅链接（`fromUrl`）
- 订阅文本：各协议 URI（vmess:// vless:// ss:// trojan:// hysteria2:// tuic:// …）逐行；或整份 YAML/JSON（带 `proxies:` 的 mihomo 文档、或顶层节点对象数组）
- 节点对象数组：mihomo(clash) schema，例如 `{ name, type: "ss", server, port, cipher, password }`

## 输出

`outbounds/endpoints` 与 sing-box 对齐：
- wireguard / tailscale → `endpoints`
- 其余代理 → `outbounds`；shadow-tls 链式节点会拆成主协议 outbound + `<name>_shadowtls` outbound，用 `detour` 串联

`assemble()` 追加：`auto[urltest]`、`proxy[selector]`、`direct`、`block`、`dns-out`，并生成默认 `dns` / `inbounds(mixed)` / `route`（内置 `ip_is_private→direct` 默认规则，置于用户规则之后）。

可用 `--dns/--final/--proxy-tag/--inbound-port` 及 `options.{dns,inbounds,route,log,extra}` 整体覆盖。

## 规则类型映射（内部 -> sing-box）

`DOMAIN→domain`、`DOMAIN-SUFFIX→domain_suffix`、`DOMAIN-KEYWORD→domain_keyword`、`DOMAIN-REGEX→domain_regex`、`IP-CIDR/IP-CIDR6→ip_cidr`、`GEOIP→geoip`、`GEOSITE→geosite`、`PROCESS-NAME→process_name`、`DEST-PORT→port`、`SRC-PORT→source_port`、`SRC-IP→source_ip_cidr`、`NETWORK→network`、`RULE-SET→rule_set`。其余类型抛错。

## 已知边界

- 默认配置假定 sing-box ≥ 1.9；规则/geoip 依赖你的 sing-box 环境提供（本工具不做 geo 数据下载）。
- "YAML/JSON 节点文档"输入要求 mihomo 风格的完整对象（含 `cipher`/`password` 等）；未内置 Sub-Store 的 `lastParse` 全量归一化。
- 官方版 sing-box 不支持的协议默认跳过并报 `Platform sing-box does not support ...`（`--include-unsupported-proxy` 可放行社区版字段，例如旧 Snell / SSR）。
- 本工程不校验 sing-box 可加载性；生成后请用目标 sing-box 校验配置。

## License / Attribution

AGPL-3.0。部分源码改编自 Sub-Store（上游 AGPL-3.0），见文件头与上方说明。
