# pi 接入优化计划

- 日期：2026-09-28
- 来源：codeg Pi 接入对照走查（`docs/research/2026-09-28-codeg-pi-integration-reference.md`）+ 本机 pi 0.87.1 实测
- 覆盖：`crates/daemon/`、`apps/sidecar/`、`src/`、`docs/`
- 状态：**已执行**（2026-09-28；本文档同时是已批准计划的快照与执行记录）

## 目标与非目标

目标：修掉已实测确认的缺陷；把 codeg 对照中判断有价值的工程做法补齐；全部改动保持现有架构决策不变（pi 原生 RPC、`PI_CODING_AGENT_DIR` 托管目录硬隔离 ADR 0005、daemon 权威 ADR 0011）。

非目标：不引入 ACP 总线或适配器层；不与用户 `~/.pi` 共享配置；不改动已完成的消息展示对齐（`docs/plans/2026-09-19-pi-message-display-alignment.md`）。

## 已批准的三个决策

| 待决点 | 结论 |
|---|---|
| P0-1 能力位来源 | **(b) 新增 provider model 能力位** `ProviderModel.supports_reasoning`（`Option<bool>`）；仅 `Some(true)` 才向 pi 声明 `reasoning` |
| P1-1 路线 | **保守路线**：保持默认不信任，不提供授权入口；靠「托管目录不写 `trust.json` + RPC 无 UI ⇒ pi 自判不信任」+ 代码注释 + 设置页明示 + 姿态测试固化 |
| 执行范围 | **全表**（P0/P1/P2/P3） |

## 执行结果总览

| 优先级 | 项 | 状态 | 落点 / 证据 |
|---|---|---|---|
| P0-1 | pi 思考档位静默失效 | ✅ 已修 | `model_providers/types.rs`、`agent/session_lifecycle.rs`、`piRuntime.ts`、`piEvents`/`types.ts`、`src/types/provider.ts`、`ProviderConfig.tsx`；本机实跑 7 档生效 |
| P0-2 | 视觉模型附件被丢弃 | ✅ 已修（实跑部分见「开放项」） | 同上链路写 `input`；探针确认 pi 状态 `input=["text","image"]` |
| P1-1 | 项目信任行为显式化 | ✅ 已显式化 | ADR 0014、`buildPiLaunchArgs` 注释、`piRuntime.test.ts` 姿态测试、`AgentSettings.tsx` 文案 |
| P2-1 | 活动链成环回退过粗 | ✅ 已修 | `pi_history.rs`；测试 `keeps_resolved_chain_when_parent_links_cycle` |
| P2-2 | 历史与实时投影漂移 | ✅ 已修（改为孪生契约，见偏离 2） | `pi_history.rs` / `piEvents.ts` 双注释互指 + 混合/空数组测试 |
| P2-3 | 注入产物未在投影层剥离 | ✅ 已做 | `pi_history.rs` 投影出口剥离 `__codemux_approve__:` / `__codemux_ask__:`；测试 `strips_codemux_internal_markers_from_projected_history` |
| P2-4 | 向前兼容/多根分叉语义 | ✅ 三条均采纳 | 测试 `keeps_entries_without_id_or_parent_id_key_when_pruning_to_chain`、`follows_one_branch_when_session_has_two_null_parent_roots` |
| P3-1 | 托管 Runtime pin 断言 | ✅ 已补（前提已纠正，见偏离 1） | `runtime/resolver.rs`：`pi_runtime_pack_contract_pins_package_and_entry_path` + `check_integrity_*_pi_*` 两条 |
| P3-2 | 契约测试标注帧来源 | ✅ 已补 | `piRpcTransport.test.ts` 头部、`__fixtures__/fake-pi.mjs` 头部 |
| P3-3 | 大目录导入性能 | ✅ 已测量，**决定不做** | 本机 `~/.pi`：4 个 jsonl / 1,266,995 字节 / 27 个目录 ⇒ 无可测收益 |
| P3-4 | 文档与实现漂移 | ✅ 已修 | ticket 02 包名与入口勘误、ticket 04 字段清单与档位口径、新建 ticket 12、research 两处结论修正、`docs/README.md` 索引 |

## 逐项要点

### P0-1 / P0-2：`models.json` 的声明缺口

根因与证据、字段清单、验收数据见 `docs/tickets/pi-agent-integration/12-pi-models-json-thinking-and-modality.md`。要点：

- 修复前 `buildPiModelsJson` 只写 `id`/`name`/`contextWindow`/`maxTokens`；pi 取 `reasoning ?? false` ⇒ 可用档位仅 `["off"]`，`--thinking high` 被静默钳回 `off`（CodeMUX 会话默认 `reasoning_effort='high'`，即默认就在跑 `off`）。
- 只加 `reasoning: true` 不够：`xhigh`/`max` 还需 `thinkingLevelMap` 显式条目，否则被降级/不存在。
- `input` 缺省为 `["text"]`，视觉模型的图片会被替换成 `(image omitted: ...)` 占位文本。
- 链路：`ProviderModel.supports_reasoning` → `modelLimits.{reasoning,thinkingLevelMap,input}` → `PiSessionConfig.modelReasoning/modelThinkingLevelMap/modelInputModalities` → `PiProviderDefinition` → `models.json`；`canReuse` 比对新增字段，改声明即重建进程。
- 前端入口：「支持思考（推理）」开关（关闭写 `null`，与「未设置」同态），并已在自己的 plan 中记录为「非协议门槛」。

### P1-1：项目信任

决策记录见 `docs/adr/0014-pi-project-resources-untrusted-by-default.md`。要点：决策链为 `--approve`/`--no-approve` → 无信任需求资源则可信 → 扩展 `project_trust` 事件 → 已保存决策（`<agentDir>/trust.json`）→ 全局 `defaultProjectTrust`（默认 `ask`）→ 无 UI 直接 `false`；我们**故意不传**信任 flag（未知 `--` flag 会让 RPC 启动即退出），托管目录里也不写 `trust.json`，因此默认不信任是成立的，但属被动结果，故用注释 + 测试 + 文案三处固化。

### P2-1 / P2-3 / P2-4：`pi_history.rs`

- P2-1：成环时按访问集终止遍历并**保留已解析链**（不再整体回退全量线性）；断链仍回退全量（取舍差异已写进注释）。
- P2-3：投影出口剥离 `__codemux_approve__:` / `__codemux_ask__:` 前缀（保留其余文本），并加「marker 不出现在投影结果」的测试。
- P2-4：三条 codeg 细节全部采纳——无 `id` 条目保留、`parentId` 键缺失 ≠ 根（不当分叉点）、多个 `parentId: null` 视为分叉只跟一条。

### P2-2：孪生契约（详见「偏离 2」）

`pi_history.rs` 的 `pi_tool_result_content` 与 `apps/sidecar/src/piEvents.ts` 的 `piAskToolResultContent` 是同一份 pi 结果的两条投影路径，现已互相指名、写明「两侧对同一输入必须逐字相同」的契约，并把三档语义（全 null → `__cancelled__`、部分作答 → 未作答项落 `""`、空串是合法答复）在两侧都用测试钉住。

## 偏离与纠正

1. **P3-1 前提被纠正**。计划写「钉死包名、版本与入口候选」，但代码里没有编译期版本常量——版本在安装时由 `NpmRuntimeSpec::for_version` 选定。实际做法：在 `runtime/resolver.rs` 钉死**包名 + 入口相对路径**（`@earendil-works/pi-coding-agent@0.87.1`、`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`），并补 pi 的 `check_integrity` 正/负用例；`runtime/npm.rs` 的包名处补「不回退旧包名 + 迁移理由」注释。
2. **P2-2 从「跨语言 golden」改为「孪生契约 + 消除已发现的漂移」**。核实后确认两侧**都不做** pi `edit` 的 diff 提升，计划里假设的不对称并不存在，做两条 edit/bash golden 只能钉住各自实现。改而处理真实漂移：提问卡答案的归一化在两侧被分别改写（混合作答时 Rust 落 `null`、TS 落 `""`），现已统一为**未作答项落空串**（`[""]`）。「空数组」一档两侧仍有差异（Rust 返回拍平文本、TS 返回 `{"answers":[]}`）：真实 pi 不产出空数组，前端 `AskUserQuestionCard.tsx` 的 `normalizeAnswerValues` 把 `null` 与 `''` 一并渲染成「未作答」，故不强行统一，改为在两处注释里**显式记录这一刻意差异**，两侧各有用例钉住。
3. **P1-1 走保守路线**（决策已批准）：不提供授权入口。完整路线（披露 + 授权 + 撤销）留给将来的新 ADR，遗留条件已写进 ADR 0014 的 Decision 5。
4. **P3-3 不做**。实测规模不足（4 个 jsonl / 1.27 MB / 27 个目录），摘要缓存与「只读头行匹配 id」都无可测收益；结论记录在此，未来规模上来再评估。
5. **P2-4 未逐条否决**：三条全部采纳，不需要「不采纳 + 理由」的书面结论。

## 验证记录（本次实际执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 格式 | `cargo fmt --all -- --check`（`crates/daemon`） | 通过（exit 0） |
| Rust lint | `cargo clippy --all-targets --all-features -- -D warnings` | 通过（首轮报 `doc_lazy_continuation`，修注释后 exit 0） |
| Rust 测试 | `cargo test --lib`（`crates/daemon`） | **563 passed / 0 failed** |
| Daemon 构建 | `npm run build:daemon` | 通过（debug 二进制已刷新，需重启 daemon 才生效） |
| Sidecar 类型 | `cd apps/sidecar && npx tsc --noEmit` | 通过 |
| Sidecar 测试 | `cd apps/sidecar && npx vitest run` | **60 files / 684 tests passed** |
| 前端受影响测试 | `npx vitest run src/components/settings src/components/agent` | **61 files / 578 tests passed** |
| 前端全量测试 | `npx vitest run`（仓库根） | **251 files / 2067 tests passed**（exit 0） |
| 前端构建 | `npm run build:web` | 通过（`dist-web/` 已刷新，浏览器宿主可见） |
| P0 端到端实跑 | 真实 pi 0.87.1 + sidecar 构建产物的 `buildPiModelsJson`，经 RPC `get_available_thinking_levels` / `get_state` | `--thinking high` → `effective=high`、`--thinking xhigh` → `effective=xhigh`、可用档位 7 档、`reasoning=true`、`input=["text","image"]`；对照组（不声明）→ `off` / `["off"]` / `["text"]` |

环境注意：本机默认 `node` 是 v14，`vitest` 会因 `??=` 语法直接报错，上述 JS 侧检查均在 **node v22.20.0** 下执行。

## 开放项

- **P0-2 的图片端到端实跑未做**：探针确认了「声明被接受」（pi 状态里 `input: ["text","image"]`、`reasoning: true`），但没有向真实供应商发过一张图并核对上游请求体里是图像块而非占位文本。这一条留待有可用视觉端点时补做。
- **P1-1 完整路线**（披露 + 授权 + 撤销）未做，见 ADR 0014。
- 托管 pi Runtime 升级时需按 ticket 01 / `piRpcTransport.test.ts` 的重捕清单复核：响应包封字段、失败形状、`Unknown command:` 文案、`extension_ui_request`/`extension_ui_response` 配对、CRLF 容错，以及 ADR 0014 依赖的两条信任默认值。

## 本次产出

- 计划与执行记录：本文档
- 调研：`docs/research/2026-09-28-codeg-pi-integration-reference.md`（含本轮两处结论修正与「执行落地」节）、`docs/research/2026-09-28-pi-npm-package-migration.md`
- 决策：`docs/adr/0014-pi-project-resources-untrusted-by-default.md`
- 工单：`docs/tickets/pi-agent-integration/12-pi-models-json-thinking-and-modality.md`（并勘误 02、回指 04）
- 代码：`crates/daemon/src/{model_providers/types.rs,agent/session_lifecycle.rs,agent/pi_history.rs,runtime/{npm.rs,resolver.rs},config/mod.rs,services/{git.rs,provider.rs},model_providers/builtins.rs}`、`apps/sidecar/src/{types.ts,piRuntime.ts,index.ts,piEvents.ts,piRpcTransport.test.ts,__fixtures__/fake-pi.mjs}`、`src/{types/provider.ts,components/settings/{ProviderConfig.tsx,AgentSettings.tsx}}`
