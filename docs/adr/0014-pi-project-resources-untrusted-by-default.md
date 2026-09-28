# ADR 0014: pi 项目资源默认不信任（不提供授权入口）

## Status

Accepted(2026-09-28)

## Context

pi 0.75+ 会加载会话工作目录自己的 `.pi/*` 资源：`settings.json`（深合并进全局设置）、`extensions/`、`skills/`、`prompts/`、`themes/`。其中 `.pi/extensions` 是 JS/TS 模块，顶层代码在 pi 启动时以**用户权限**执行，等价于「跑一次仓库里的代码」。CodeMUX 的 pi 会话 cwd 就是用户工作区（`crates/daemon/src/agent/session_lifecycle.rs` 把会话 cwd 交给 sidecar 拉起 pi），因此「开一个会话」在信任该仓库时就会执行它的代码。

CodeMUX 的 pi 走原生 RPC（`apps/sidecar/src/piRuntime.ts`，`--mode rpc`），pi 的唯一前端是一个没有 UI 的进程；同时 pi 的配置目录被重定向到托管目录（`PI_CODING_AGENT_DIR`，ADR 0005），与用户的 `~/.pi` 硬隔离。

2026-09-28 在 pi 0.87.1 上核实了信任判定的完整链条（`dist/core/project-trust.js` 的 `resolveProjectTrusted`，`dist/core/trust-manager.js`）：

1. `--approve` / `--no-approve`（`trustOverride`）最优先；
2. 工作目录**没有**需要信任的项目资源（`hasTrustRequiringProjectResources(cwd)` 为假）时直接视为可信——此时没有东西要加载，无后果；
3. 用户级/命令行扩展抛出的 `project_trust` 事件可裁决（有 `remember` 则落盘）；
4. 已保存的决策（`trustStore.get(cwd)`）；
5. 全局设置 `defaultProjectTrust`（`always`/`never`/`ask`，默认 `ask`）；
6. 走到 `ask` 时看 `projectTrustContext.hasUI`：**没有 UI 直接返回 false**。

信任库落在 `<agentDir>/trust.json`，而 `getAgentDir()`（`dist/config.js`）优先读 `PI_CODING_AGENT_DIR`。项目资源与项目 `settings.json` 的合并都由 `projectTrusted` 这一位统一闸门控制；未受信任时 pi 连项目设置的写入都会拒绝（`assertProjectTrustedForWrite`）。

结论：我们当前是**默认不信任**，但这个状态是「托管目录里没有 `trust.json` + RPC 没有 UI」两条上游行为的**被动结果**。它既依赖上游默认值（一旦 `defaultProjectTrust` 变成 `always` 就翻转），也无法向用户交代，还没有任何测试或文档钉住。

## Decision

1. **姿态：默认不信任项目资源，且不提供授权入口**（本轮不照 codeg 的完整闸门形状）。pi 会话不加载 `<cwd>/.pi/*`——不执行项目扩展，不合并项目设置。
2. **不写、不读 pi 的 `trust.json`**。写它会翻转姿态；而且信任库按 `agentDir` 定位，在托管目录里写等于把「用户对某仓库的信任决策」存进我们自己的运行时目录，既污染共享语义又容易被误当成缓存清理。离开托管目录去读用户原生 `~/.pi/agent/trust.json` 则破坏目录隔离（ADR 0005）。
3. **不传 `--approve` / `--no-approve`**。显式声明姿态看起来更明确，但 pi 对未知 `--` flag 会让 RPC 进程启动即退出（同类事故见 `piRuntime.ts` 中 `--mcp-config` 的 COMPAT 注释），而当前默认已解析为 `false`，收益为零、风险非零。启动参数由 `buildPiLaunchArgs` 单一构造，这一决定在该函数上有长注释。
4. **把姿态固化为测试与文案**：`piRuntime.test.ts` 断言启动参数里**不会**出现任何项目信任 flag；设置页 pi 权限区明确写出「不会加载项目内 `.pi` 的设置与扩展」，让用户知道项目扩展在当前姿态下不生效，而不是以为坏了。
5. **将来若要开放授权，另开 ADR**，且必须满足：授权状态存 CodeMUX 自己的文件（不写 pi 的 `trust.json`）、一次性披露「授权即执行该仓库代码」、可撤销、并明确是否连带启用项目 `settings.json` 深合并。本轮不做，因为半成品授权入口（披露不全 / 不可撤销 / 状态放错地方）比没有入口更危险。

## Considered Options

- **照 codeg 的完整形状（拒绝启动 + 披露 + 撤销）**：推迟。它需要 CodeMUX 自建信任存储、授权 UI 与撤销路径，是一独立特性；当前默认已经是安全侧，先把姿态钉死并说清，比仓促做一个半成品授权入口更有价值。
- **对所有项目一律信任**：否决。等价于「打开一个仓库就跑它的代码」，且用户无从预期。
- **显式传 `--no-approve`**：否决。默认已是 `false`；而未知 flag 会直接让 RPC 进程退出，属于用启动失败换一句注释。
- **把决策写进 pi 的 `trust.json`（含「永不信任」）**：否决。见 Decision 2；「永不信任」还会与用户原生 pi 的信任库语义冲突。
- **不写任何文案，仅靠默认值**：否决。用户会看到项目里的 pi 扩展「失效」而无法判断是缺陷还是策略。

## Consequences

- 仓库自带的 `.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes` 在 CodeMUX 的 pi 会话里**不生效**，`.pi/settings.json` 也不参与合并。这是有意取舍，代价是「项目级 pi 配置」这一类能力在 CodeMUX 里不可用；设置页已明示。
- 姿态依赖上游两条行为（`defaultProjectTrust` 默认 `ask`、无 UI 时 `ask` 判为 false）。升级托管 pi Runtime 时必须复核这两条，否则护栏（注释 + 测试）会说反话——这与 ticket 01 里「契约测试要标注帧来源」是同一类纪律。
- 用户的逃生口是自行在托管 `agentDir` 下写 `trust.json`（pi 会读已保存决策）。我们不做入口，但也不阻止；这条路径属于用户显式自担，且不受 CodeMUX UI 保护。
- 若上游把项目资源纳入「不需要信任」的范围，本 ADR 的结论会变化，实施层（`buildPiLaunchArgs` 姿态测试与设置页文案）需要同步复核，而不是默默继续宣称不加载。

## References

- `docs/research/2026-09-28-codeg-pi-integration-reference.md`（codeg 的项目信任门对照、启发第 1 条）
- `docs/research/2026-09-28-pi-npm-package-migration.md`
- `docs/plans/2026-09-28-pi-agent-integration-optimizations.md`（本轮执行记录与偏离说明）
- ADR 0005（CodeMUX 自有 model provider / `PI_CODING_AGENT_DIR` 托管目录硬隔离）
- pi 0.87.1：`dist/core/project-trust.js`、`dist/core/trust-manager.js`、`dist/config.js`（`getAgentDir`）
