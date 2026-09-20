# 智能体运行时检测与升级功能增强 Spec

## Why

当前 codeMUX 智能体引擎设置页的运行时检测仅做"找命令 + 跑 `--version` + 比 npm latest"三步,存在三类实际问题:

1. **检测不准**:无法区分"没装"和"装了但跑不起来"(Node 版本不达标、可执行损坏等),用户看到 Error 状态无法定位原因。
2. **升级无效**:直接 `npm install -g <pkg>@latest` 不关心 PATH 实际命中的那处安装,若用户用 nvm/volta/brew 装的,新版会装到 npm 全局目录,而 PATH 仍指向旧版,升级等于没做。
3. **多处安装不可见**:用户系统里同时存在 nvm + 系统 node + volta 等多份 CLI 时,我们只看到第一处,无法诊断"PATH 遮蔽"问题。

参考 cc-switch 的本地环境检查实现,通过引入三态探测、多处安装枚举、锚定升级三项核心能力来解决以上问题。

## What Changes

- **三态探测**:在 `AgentRuntimeCheck` 增加 `installed_but_broken` 字段,严格区分 `NotFound` / `FoundButFailed` / `Found` 三态,前端按状态展示差异化文案。
- **多处安装枚举**:新增 `probe_agent_installations` IPC 命令,枚举单个智能体在系统里的所有安装位置、版本、运行状态、安装来源,并判定是否存在冲突(≥2 处且版本分歧或运行态混合)。
- **锚定升级**:`upgrade_agent_runtime` 改为优先使用 PATH 默认那处安装的绝对路径执行升级,优先级为 `官方自升级命令(claude update / opencode update)` → `同级包管理器(npm/volta/bun 等)` → `npm install -g 兜底`。
- **搜索路径扩展**:`find_command_path` 不再只依赖 `where/which`,先扫描 nvm/volta/brew/pnpm/scoop/fnm/mise 等常见安装目录,再回退 PATH。
- **安装来源推断**:根据安装路径前缀推断 source(nvm/homebrew/volta/fnm/mise/bun/pnpm/scoop/system/unknown),前端展示徽章。
- **升级前确认**:当某智能体检测到 ≥2 处安装时,升级前弹出确认对话框,展示每处安装的来源/路径/版本/默认标记 + 锚定后将执行的命令,用户知情后再确认。
- **升级后补诊**:升级完成后自动触发 `probe_agent_installations`,检测是否仍存在冲突(如升级写入 A 处、PATH 实际用 B 处的遮蔽问题),结果写入卡片。
- **命令重新生成**:展示给用户的命令字符串仅用于知情,后端执行时重新生成,不信任前端回传。
- **错误分级**:升级结果区分 `hard_failure`(命令报错)/ `soft_version_unchanged`(版本未变)/ `soft_not_runnable`(装上跑不起来)/ `success`,前端按级别展示 toast。

不包含(超出本次范围):
- WSL 跨边界检测与升级(复杂度高,单独评估)
- 环境变量冲突检测(独立能力线,另行立项)
- 预发布通道(`next` tag)补查(edge case)
- 新增智能体(openclaw/hermes)接入
- 批量"全部升级"按钮(当前逐一升级已满足)
- PyPI / GitHub releases 兜底(仅 hermes/opencode 需要,当前不接入)

## Impact

- Affected specs: 无既有 spec 受影响(新增能力)
- Affected code:
  - `src-tauri/src/commands/agent_runtime_check.rs` — 核心改造:三态探测、多处枚举、锚定升级、搜索路径扩展、来源推断
  - `src-tauri/src/lib.rs` — 注册新 IPC 命令 `probe_agent_installations`
  - `src/lib/tauri.ts` — 新增类型 `AgentInstallation` / `AgentInstallationReport` / `AgentUpgradePlan`,扩展 `AgentRuntimeCheck` 字段,新增 `appApi.probeAgentInstallations`
  - `src/components/settings/AgentSettings.tsx` — `RuntimeCard` 展示 `installed_but_broken` 文案、来源徽章、冲突列表;升级流程接入确认对话框与补诊;toast 分级
  - 新增 `src/components/settings/AgentUpgradeConfirmDialog.tsx` — 升级前确认对话框
  - 新增 `src/components/settings/AgentInstallRow.tsx` — 单处安装信息行(诊断列表与确认对话框共用)
  - `src/components/settings/AgentSettings.test.tsx` — 扩展测试覆盖新状态、确认对话框、补诊流程

## ADDED Requirements

### Requirement: 三态版本探测

系统 SHALL 对每个受支持智能体 CLI 严格区分三种本地状态:`Found`(成功拿到版本号)、`FoundButFailed`(可执行存在但 `--version` 非零退出)、`NotFound`(未找到命令)。

`AgentRuntimeCheck` 结构 SHALL 新增 `installed_but_broken: bool` 字段,前端据此展示"已安装但无法运行"的差异化文案(琥珀色 + 具体错误),不依赖 error 文案反推。

#### Scenario: 装了但跑不起来

- **WHEN** `where claude` 命中某路径,但执行 `claude --version` 返回非零退出码(如 Node 版本不达标)
- **THEN** `status` 为 `Error`,`installed_but_broken` 为 `true`,`current_version` 为 `None`,`message` 包含 stderr 末尾内容
- **AND** 前端卡片状态徽标为琥珀色"异常",副文案显示"已安装但无法运行:<错误摘要>"

#### Scenario: 完全没装

- **WHEN** `where claude` 未命中任何路径
- **THEN** `status` 为 `Missing`,`installed_but_broken` 为 `false`,`current_version` 为 `None`
- **AND** 前端卡片状态徽标为红色"未安装"

### Requirement: 多处安装枚举

系统 SHALL 提供 `probe_agent_installations(agent_kind: String)` IPC 命令,返回 `AgentInstallationReport`,枚举指定智能体在系统里的所有安装位置。

每处安装 SHALL 包含:`path`(原始路径)、`real`(canonicalize 后的真实路径)、`version`(Option)、`runnable`(bool)、`error`(Option)、`source`(nvm/homebrew/volta/fnm/mise/bun/pnpm/scoop/system/unknown 之一)、`is_path_default`(是否为 PATH 实际命中那处)。

枚举 SHALL 不短路——遍历所有候选目录,canonicalize 后去重,对每个去重后的真实安装跑一次 `--version`。

`AgentInstallationReport` SHALL 包含:`agent_kind`、`installs: Vec<AgentInstallation>`、`is_conflict: bool`(≥2 处且版本分歧或运行态混合)、`needs_confirmation: bool`(≥2 处)、`anchored: bool`(是否成功锚定到具体安装)、`command: Option<String>`(锚定后将执行的升级命令,仅展示)。

#### Scenario: 检测到多处安装冲突

- **WHEN** 用户系统里 nvm 装了 claude 1.0.0,系统 node 装了 claude 1.0.16,两处都能跑
- **THEN** `installs` 长度为 2,`is_conflict` 为 `true`(版本分歧),`needs_confirmation` 为 `true`
- **AND** PATH 默认那处的 `is_path_default` 为 `true`,排 `installs` 第一位
- **AND** `command` 字段为锚定到 PATH 默认那处的升级命令(绝对路径)

#### Scenario: 多处安装但无冲突

- **WHEN** 用户系统里 homebrew 装了 claude 1.0.16,volta 也装了 claude 1.0.16,两处都能跑
- **THEN** `installs` 长度为 2,`is_conflict` 为 `false`(版本一致且都能跑),`needs_confirmation` 为 `true`(≥2 处仍需用户知情)

#### Scenario: 仅一处安装

- **WHEN** 用户系统里只有 npm 全局装了 claude 1.0.16
- **THEN** `installs` 长度为 1,`is_conflict` 为 `false`,`needs_confirmation` 为 `false`,`anchored` 为 `true`

### Requirement: 锚定升级

`upgrade_agent_runtime` SHALL 优先把升级命令路由到 PATH 实际命中的那处安装,使用绝对路径调用执行体,不依赖 PATH(GUI 进程与登录 shell 的 PATH 不对称)。

锚定判定顺序(命中即返回):

1. PATH 默认那处(或唯一一处)的绝对路径
2. 退到静态兜底命令(`npm install -g <pkg>@latest`)

每处安装的升级命令优先级:

1. **官方自升级**(claude/opencode 等):`<abs_path> update`,失败回退到下一级
2. **同级包管理器**:根据 `source` 推导同级 bin 调用(`<sibling>/volta install <pkg>` / `<sibling>/npm i -g <pkg>@latest` / `<sibling>/bun add -g <pkg>@latest`)
3. **npm 兜底**:`npm install -g <pkg>@latest`

Windows 平台 SHALL 使用 `.cmd` 优先于 `.exe` 的 sibling 选择策略;不启用 `install.sh`;命令字符串含空格才加引号。

#### Scenario: PATH 默认安装支持官方自升级

- **WHEN** 用户 PATH 默认的 claude 安装在 `~/.local/share/claude/`,source 为 `unknown`,该 CLI 支持 `claude update`
- **THEN** 锚定命令为 `<绝对路径>/claude update`
- **AND** `anchored` 为 `true`

#### Scenario: PATH 默认安装来自 volta

- **WHEN** 用户 PATH 默认的 codex 安装在 volta 目录,source 为 `volta`
- **THEN** 锚定命令为 `<sibling>/volta install @openai/codex`
- **AND** `anchored` 为 `true`

#### Scenario: 无法锚定

- **WHEN** `probe_agent_installations` 返回 `installs` 为空,或 PATH 默认那处无法定位
- **THEN** 退到 `npm install -g <pkg>@latest`,`anchored` 为 `false`

### Requirement: 搜索路径扩展

`find_command_path` 与多处枚举 SHALL 按以下顺序汇总候选目录去重:

- **通用**:`~/.local/bin`、`~/.npm-global/bin`、`~/n/bin`、`~/.volta/bin`、mise node installs、fnm_multishells、nvm versions
- **macOS**:`/opt/homebrew/bin`、`/usr/local/bin`
- **Linux**:`/usr/local/bin`、`/usr/bin`
- **Windows**:`%APPDATA%\npm`、`C:\Program Files\nodejs`、Volta / pnpm / Scoop / NVM / fnm 各自的 bin
- **OpenCode 专属**:`$OPENCODE_INSTALL_DIR` / `$XDG_BIN_DIR` / `~/bin` / `~/.opencode/bin` / `~/.bun/bin` / `~/go/bin` / `$GOPATH/bin`
- 最后追加 `PATH`(Windows 排除 `Microsoft\WindowsApps` 目录防 App Execution Alias 干扰)

Windows 原生探测 SHALL 不走 `cmd /C <tool>`(会触发 App Execution Alias),只在已定位的真实可执行文件上跑 `--version`,扩展名优先 `.cmd` → `.exe` → 无扩展名。

### Requirement: 安装来源推断

系统 SHALL 根据安装路径前缀推断 `source`,驱动前端徽章展示:

- 路径含 `nvm` / `versions/node` → `nvm`
- 路径含 `Cellar/` / `homebrew` → `homebrew`
- 路径含 `.volta` → `volta`
- 路径含 `fnm` / `fnm_multishells` → `fnm`
- 路径含 `mise` → `mise`
- 路径含 `.bun` → `bun`
- 路径含 `pnpm` → `pnpm`
- 路径含 `scoop` → `scoop`
- 路径含 `/usr/local/bin` / `/usr/bin` / `C:\Program Files` → `system`
- 其它 → `unknown`

### Requirement: 升级前确认对话框

当 `probe_agent_installations` 返回 `needs_confirmation: true` 时,前端 SHALL 在执行升级前弹出 `AgentUpgradeConfirmDialog`,展示:

- 每处安装的 `source` 徽章 + 路径 + 版本(或"无法运行")+ "默认"标记(仅 `is_path_default` 那处)
- 锚定后将执行的命令字符串(`command` 字段)
- `anchored: false` 时额外提示"默认入口无法确定,将退到 npm 兜底"

用户确认后才执行升级;取消则中止。单处安装(`needs_confirmation: false`)不弹窗,直接升级。

#### Scenario: 多处安装时弹窗确认

- **WHEN** 用户点击"升级到 1.0.16",`probe_agent_installations` 返回 `needs_confirmation: true`
- **THEN** 弹出 `AgentUpgradeConfirmDialog`,展示 2 处安装详情与锚定命令
- **AND** 用户点击"确认升级"后才调用 `upgrade_agent_runtime`
- **AND** 用户点击"取消"则不执行升级

### Requirement: 升级后补诊

升级完成后(无论成功或版本未变),前端 SHALL 自动调用 `probe_agent_installations` 重新检测该智能体是否仍存在冲突:

- 有冲突 → 在卡片下方展示 `AgentInstallRow` 列表
- 无冲突 → 清掉该卡片可能残留的冲突展示

补诊 SHALL 静默执行,不弹 toast、不报错打扰(仅在卡片 UI 上反映结果)。

### Requirement: 升级错误分级

`AgentRuntimeUpgradeResult` SHALL 扩展 `outcome` 字段,取值:

- `success`:命令成功且版本号变化
- `soft_version_unchanged`:命令退出码 0 但版本未变(可能升级写入非 PATH 默认处)
- `soft_not_runnable`:命令退出码 0 但探不到版本(装上跑不起来)
- `hard_failure`:命令非零退出码

前端 toast 按 `outcome` 分级:

- `success` → success toast,附"当前版本:{newVersion}"
- `soft_*` → warning toast,提示"命令已执行但可能未生效,已自动诊断"
- `hard_failure` → error toast,附 stderr 末尾内容

#### Scenario: 升级后版本未变

- **WHEN** `npm install -g` 退出码 0,但 `claude --version` 仍返回旧版本号
- **THEN** `outcome` 为 `soft_version_unchanged`,`new_version` 为旧版本号
- **AND** 前端展示 warning toast,自动触发补诊

### Requirement: 命令展示与执行分离

展示给用户的命令字符串(确认对话框中的 `command` 字段)仅用于知情;后端 `upgrade_agent_runtime` 执行时 SHALL 重新生成命令,不信任前端回传的 `command` 值,避免命令注入面扩大。

`upgrade_agent_runtime` 仅接受 `agent_kind: String` 参数,内部自行调用 `probe_agent_installations` 获取锚定信息并生成命令。

## MODIFIED Requirements

### Requirement: AgentRuntimeCheck 数据结构

原结构:

```rust
struct AgentRuntimeCheck {
    agent_kind, label, command, status,
    current_version, latest_version,
    executable_path, config_path,
    npm_package, message
}
```

修改为:

```rust
struct AgentRuntimeCheck {
    agent_kind, label, command, status,
    current_version, latest_version,
    executable_path, config_path,
    npm_package, message,
    installed_but_broken: bool,  // 新增
}
```

`status` 语义细化:`Missing` 仅当未找到命令;`Error` 涵盖 `installed_but_broken=true` 与其它异常;`Outdated`/`Ok` 仅当 `current_version` 有值且 CLI 可运行。

### Requirement: upgrade_agent_runtime 行为

原行为:直接 `npm install -g {npm_package}@latest`,完成后跑 `--version` 取 `new_version`。

修改为:

1. 调用 `probe_agent_installations(agent_kind)` 获取锚定信息
2. 按"锚定升级"优先级生成命令(官方自升级 → 同级包管理器 → npm 兜底)
3. 静默执行命令(POSIX 用 `bash -c`,Windows 写临时 `.bat` + `cmd /C` + `CREATE_NO_WINDOW`)
4. 完成后跑 `--version` 取 `new_version`
5. 判定 `outcome`(success / soft_version_unchanged / soft_not_runnable / hard_failure)
6. 返回 `AgentRuntimeUpgradeResult { agent_kind, success, outcome, message, new_version }`
