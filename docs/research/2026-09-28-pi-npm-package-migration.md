# pi npm 包迁移:@mariozechner → @earendil-works

## 背景

2026-09-28 排查「设置页 pi Runtime 最新版本停在 0.73.1」时确认:pi 上游已把 npm 包从个人 scope 迁移到组织 scope,旧包停止发版。

| 包 | latest | 状态 |
|---|---|---|
| `@mariozechner/pi-coding-agent`(旧) | 0.73.1(2026-05-07) | 已标 deprecated:*"please use @earendil-works/pi-coding-agent instead going forward"* |
| `@earendil-works/pi-coding-agent`(新) | 0.87.1(2026-09-22) | 活跃;dist-tags 另有 `legacy-node20: 0.74.2`(engines `>=20.6.0`) |

CodeMUX 当初 pin 0.73.1 时它就是旧 scope 的最后一版。Runtime 版本列表写死查询旧包(`runtime/npm.rs` `primary_package(Provider::Pi)`),因此设置页永远看不到新版——不是镜像/版本源配置问题,是包名变了。

## 关键差异(0.73.1 → 0.87.x)

- **bin 入口改为 bun bundle**:旧 `dist/cli.js` → 新 `dist/bundle/cli.js`(另有 `dist/bundle/rpc-entry.js` 硬编码 `--mode rpc`)。daemon 完整性检查与 sidecar `PI_RPC_ENTRY_RELATIVE` 都指向旧路径。
- **Node 门槛**:0.75.0 起 engines `node >= 22.19.0`(旧包 0.73.1 无 engines 声明;`legacy-node20` dist-tag 0.74.2 面向 Node 20)。CodeMUX 安装时的既有门槛是 Node 18,不拦 0.75+。
- **project trust(0.75+)**:仓库内 `.pi/settings.json`、`.pi/extensions` 等资源需显式信任;**RPC 模式无 UI,默认不信任**(docs/security.md)。迁移前旧包无此机制、无条件加载 `<cwd>/.pi/extensions`——CodeMUX 会话 cwd 即用户工作区,构成仓库代码随会话启动执行的缺口。升级后该缺口自然关闭。
- **`clear_queue` RPC 自 0.84.4 起原生支持**(sidecar `COMPAT(piClearQueueFallback)` 可退役但保留无害)。
- **`message_update` 自 0.84 起 delta-only**(`COMPAT(piCumulativeMessageUpdate)` 针对 ≤0.83 的累积全文,保留无害)。
- **RPC 命令面只增不减**:新增 `get_available_thinking_levels` / `get_entries` / `get_tree` 等;CodeMUX 依赖的 `get_state`(sessionId/sessionFile/sessionName)、`get_session_stats`、`fork`、`extension_ui_request/response`、`session_info_changed` 事件全部兼容(0.87.1 源码与 docs/rpc.md 核对)。
- **thinking 语义不变**:`models.json` 模型仍需 `reasoning: true` 才启用思考等级(0.87 新增 `max` 级别,`xhigh`/`max` 需 `thinkingLevelMap` 显式映射)。CodeMUX `writePiModelsJson` 目前不写 `reasoning`,思考等级对 codemux 供应商静默钳到 off——独立问题,升级不解决,另行处理。
- **MCP 结论不变**:README 仍明确 "No MCP",无 `--mcp-config` flag(未知 `--` flag 进 `unknownFlags`,无扩展注册时产生 error diagnostic,0.87 RPC 模式遇 error diagnostic 会 `process.exit(1)`——sidecar 对 pi 下发的 `--mcp-config` 在 0.87 会**阻断启动**,见下方「迁移中的行为差异」)。
- **typebox 仍是直接依赖**(1.3.27),注入扩展 `import { Type } from "typebox"` 兼容。
- **扩展 API 兼容**:审批/ask-user 桥依赖的 `pi.on("tool_call")`(可 block)、`pi.registerTool`、`ctx.ui.select/input` 均在。

### 迁移中的行为差异:`--mcp-config` 从无害变致命

0.73.1 同样没有 `--mcp-config` flag,未知 flag 静默忽略 → sidecar 传了也没效果(WARN adapter 缺失),会话能跑。0.87 把未知 `--` flag 收进 `unknownFlags` 交给扩展注册表核对,无扩展注册该 flag 时产生 **error diagnostic**,且 RPC 模式下 `hasRuntimeErrors → process.exit(1)`。即:**sidecar 现有 `--mcp-config` 参数在 0.87 上会让 pi 进程启动即退出**。本迁移同步移除该参数注入(pi 无 MCP 是上游明确立场,CodeMUX 侧 browser MCP 对 pi 也不再有通道;将来若 pi 提供原生 MCP 再立项,与 spec 既有「明确不做」一致)。

## 迁移决定(2026-09-28)

以新源为准,不保留旧包作为安装目标;仅入口探测保留旧路径回落,让迁移前已装的 0.73.x Runtime 继续可用,用户在设置页升级到新包任意版本后自然收敛。

- daemon `runtime/npm.rs`:`NpmRuntimeSpec::for_version(Provider::Pi)` 与 `primary_package` 切到 `@earendil-works/pi-coding-agent`;`candidate_binaries` 指向 `dist/bundle/cli.js`。
- daemon `runtime/resolver.rs`:`local_key_binaries(Provider::Pi)` 指向新包 bundle 入口(旧 0.73.1 安装经该检查会判 Corrupted,设置页提示重装/升级——预期收敛路径)。
- sidecar `piRuntime.ts`:`PI_RPC_ENTRY_CANDIDATES` 按序探测新包 bundle 入口 → 旧包 `dist/cli.js`;`resolvePiEntryFromRuntimeRef` 首个存在者胜出,都不存在时报错路径指向新包。
- sidecar `piRuntime.ts`:`createDefaultPiTransport` 不再向 pi 子进程传 `--mcp-config`(0.87 视为未知 flag 即 error → RPC 进程退出);`piMcp.ts` 的配置文件生成保留(供将来 pi MCP 立项复用),`noteMcpAdapterAvailability` 的 get_commands 探测随之移除。
- 已装 0.73.1 继续可跑(sidecar 回落旧入口);daemon 完整性检查以新包为准,设置页会显示 Corrupted 引导重装——接受的行为:重装即得新版。

## 后续(未做,另行 ticket)

- `writePiModelsJson` 补 `reasoning: true` / `thinkingLevelMap`(思考等级当前静默失效)。
- Node engines 检查:安装 `>=0.75.0` 时校验本机 Node ≥ 22.19(现仅拦 Node 18),不满足时引导 `legacy-node20` 或升级 Node。
- project trust 的产品化:0.87 RPC 默认不信任项目资源(安全默认),将来可在 CodeMUX 侧暴露 `--approve` / trust.json 管理面(参照 codeg 的信任门实现)。
- sidecar 兼容下限上移后可移除 `COMPAT(piCumulativeMessageUpdate)`、`COMPAT(piClearQueueFallback)`、`get_session_stats` 回退 `get_state` 三处防御代码(spec「已知坑位清单」既定方向);当前保留以防用户 pin 旧版。
