# Tasks

- [x] Task 1: 扩展 Rust 端数据结构与三态探测
  - [x] SubTask 1.1: 在 `agent_runtime_check.rs` 的 `AgentRuntimeCheck` 增加 `installed_but_broken: bool` 字段(camelCase 序列化)
  - [x] SubTask 1.2: 重构 `check_single_runtime`,严格区分 `NotFound`(无 exe 无 version) / `FoundButFailed`(有 exe 但 `--version` 非零,`installed_but_broken=true`) / `Found`(有 version)三态
  - [x] SubTask 1.3: `FoundButFailed` 时 `message` 包含 stderr 末尾内容(最多 8 行),`current_version` 为 `None`,`status` 为 `Error`
  - [x] SubTask 1.4: 扩展 `AgentRuntimeStatus` 单元测试覆盖三态判定
  - [x] SubTask 1.5: `cargo fmt --all -- --check` 与 `cargo clippy --all-targets --all-features -- -D warnings` 通过

- [x] Task 2: 实现搜索路径扩展与来源推断
  - [x] SubTask 2.1: 新增 `build_tool_search_paths(agent_kind)` 函数,按 spec 列出的通用/macOS/Linux/Windows/OpenCode 专属目录汇总去重
  - [x] SubTask 2.2: Windows 排除 `Microsoft\WindowsApps` 目录
  - [x] SubTask 2.3: 新增 `infer_install_source(real_path)` 函数,按路径前缀推断 nvm/homebrew/volta/fnm/mise/bun/pnpm/scoop/system/unknown
  - [x] SubTask 2.4: 改造 `find_command_path` 先扫候选目录,再回退 `where/which`
  - [x] SubTask 2.5: 新增单元测试覆盖 `infer_install_source` 各分支
  - [x] SubTask 2.6: `cargo fmt` 与 `cargo clippy` 通过

- [x] Task 3: 实现多处安装枚举 `probe_agent_installations`
  - [x] SubTask 3.1: 定义 `AgentInstallation`、`AgentInstallationReport` 结构(camelCase 序列化)
  - [x] SubTask 3.2: 实现 `enumerate_tool_installations`:遍历 `build_tool_search_paths`,每个候选路径下查找可执行文件,canonicalize 去重,对每个去重后的真实安装跑 `--version`
  - [x] SubTask 3.3: 实现 `is_path_default` 判定:用 `where/which tool` 解析 PATH 实际命中那处,canonicalize 后与枚举项的 `real` 比对
  - [x] SubTask 3.4: 实现 `is_conflicting` 判定:≥2 处 && (版本分歧 || runnable 混合)
  - [x] SubTask 3.5: PATH 默认那处排 `installs` 第一位
  - [x] SubTask 3.6: 实现 `probe_agent_installations` IPC 命令并注册到 `lib.rs`
  - [x] SubTask 3.7: `cargo fmt` 与 `cargo clippy` 通过

- [x] Task 4: 实现锚定升级命令生成
  - [x] SubTask 4.1: 实现 `default_install(report)`:取 PATH 默认那处或唯一一处
  - [x] SubTask 4.2: 实现 `anchored_command_from_paths`:按官方自升级 → 同级包管理器 → npm 兜底 优先级生成命令
  - [x] SubTask 4.3: 实现 `package_manager_anchored_command_from_paths`:按 source 推导同级 bin(volta/bun/npm)
  - [x] SubTask 4.4: Windows 版 sibling 选择 `.cmd` 优先于 `.exe`(读 fs 决定)
  - [x] SubTask 4.5: 命令字符串路径含空格才加引号(POSIX 单引号 / Windows 双引号)
  - [x] SubTask 4.6: 路径为锚定的绝对路径,不依赖 PATH
  - [x] SubTask 4.7: 新增单元测试覆盖锚定判定各分支(官方自升级 / volta / brew / npm 兜底 / 无法锚定)
  - [x] SubTask 4.8: `cargo fmt` 与 `cargo clippy` 通过

- [x] Task 5: 改造 `upgrade_agent_runtime` 执行与错误分级
  - [x] SubTask 5.1: `AgentRuntimeUpgradeResult` 增加 `outcome: UpgradeOutcome` 枚举字段(success/soft_version_unchanged/soft_not_runnable/hard_failure)
  - [x] SubTask 5.2: 改造 `upgrade_agent_runtime`:内部调用 `probe_agent_installations` 获取锚定信息,按 Task 4 生成命令(不信任前端回传)
  - [x] SubTask 5.3: 静默执行:POSIX 用 `bash -c`,Windows 写临时 `.bat` + `cmd /C` + `CREATE_NO_WINDOW`,执行后删 `.bat`
  - [x] SubTask 5.4: 完成后跑 `--version` 取 `new_version`,按版本变化与可运行性判定 `outcome`
  - [x] SubTask 5.5: 失败时 `message` 取 stderr 末尾 8 行(Windows 按 OEM/ANSI codepage 解码)
  - [x] SubTask 5.6: `cargo fmt` 与 `cargo clippy` 通过

- [x] Task 6: 扩展 TS 端类型与 IPC 封装
  - [x] SubTask 6.1: 在 `src/lib/tauri.ts` 新增 `AgentInstallation`、`AgentInstallationReport`、`UpgradeOutcome` 类型(与 Rust 结构对齐;`AgentUpgradePlan` 未创建,Rust 实现未使用)
  - [x] SubTask 6.2: 扩展 `AgentRuntimeCheck` 增加 `installedButBroken` 字段
  - [x] SubTask 6.3: 扩展 `AgentRuntimeUpgradeResult` 增加 `outcome` 字段
  - [x] SubTask 6.4: 新增 `appApi.probeAgentInstallations(agentKind: string): Promise<AgentInstallationReport>`
  - [x] SubTask 6.5: 扩展 `tauri.test.ts` 覆盖新类型与 IPC 参数序列化

- [x] Task 7: 改造 `RuntimeCard` 展示三态与来源徽章
  - [x] SubTask 7.1: `installed_but_broken=true` 时状态徽标为琥珀色"异常",副文案"已安装但无法运行:<message 摘要>"
  - [x] SubTask 7.2: `executable_path` 行旁展示绿色圆点指示器(可运行时)
  - [x] SubTask 7.3: 卡片下方预留冲突列表展示位(`installationReport` prop)
  - [x] SubTask 7.4: 扩展 `AgentSettings.test.tsx` 覆盖 `installed_but_broken` 与冲突占位渲染

- [x] Task 8: 实现 `AgentInstallRow` 组件
  - [x] SubTask 8.1: 创建 `src/components/settings/AgentInstallRow.tsx`
  - [x] SubTask 8.2: 单行展示:source 徽章 + 路径(可复制)+ 版本(或"无法运行")+ "默认"标记(仅 `is_path_default`)
  - [x] SubTask 8.3: 复用 `Button`/`Badge`(本地最小化 Badge),遵循项目 Tailwind + CSS 变量风格
  - [x] SubTask 8.4: 编写组件测试覆盖各状态(默认/普通/无法运行)

- [x] Task 9: 实现 `AgentUpgradeConfirmDialog` 组件
  - [x] SubTask 9.1: 创建 `src/components/settings/AgentUpgradeConfirmDialog.tsx`
  - [x] SubTask 9.2: 接收 `report: AgentInstallationReport | null` 与 `onConfirm` / `onCancel` 回调
  - [x] SubTask 9.3: 列表渲染 `installs`(`AgentInstallRow`),底部展示锚定命令字符串(`report.command`)
  - [x] SubTask 9.4: `anchored=false` 时额外提示"默认入口无法确定,将退到 npm 兜底"
  - [x] SubTask 9.5: 使用 shadcn/ui `Dialog` 组件,遵循面板式风格约束
  - [x] SubTask 9.6: 编写组件测试覆盖确认/取消回调与各展示状态

- [x] Task 10: 改造升级流程接入确认对话框与补诊
  - [x] SubTask 10.1: `handleUpgrade` 先调 `probeAgentInstallations`
  - [x] SubTask 10.2: `needs_confirmation=true` 时弹出 `AgentUpgradeConfirmDialog`,等待用户确认
  - [x] SubTask 10.3: `needs_confirmation=false` 时直接执行升级
  - [x] SubTask 10.4: 升级完成后(无论 outcome)自动调 `probeAgentInstallations` 补诊
  - [x] SubTask 10.5: 补诊结果有冲突 → 在卡片下方渲染 `AgentInstallRow` 列表;无冲突 → 清掉残留展示
  - [x] SubTask 10.6: 升级期间 `upgradingKind` 锁定,禁用其它卡片升级按钮(`anyUpgrading` prop)
  - [x] SubTask 10.7: 扩展 `AgentSettings.test.tsx` 覆盖确认对话框流程与补诊

- [x] Task 11: 改造升级 toast 分级展示
  - [x] SubTask 11.1: `outcome=success` → success toast + "当前版本:{newVersion}"
  - [x] SubTask 11.2: `outcome=soft_*` → warning toast + "命令已执行但可能未生效,已自动诊断"
  - [x] SubTask 11.3: `outcome=hard_failure` → error toast + stderr 末尾内容
  - [x] SubTask 11.4: 扩展 `AgentSettings.test.tsx` 覆盖各 outcome 的 toast 调用

- [ ] Task 12: 全量回归验证
  - [x] SubTask 12.1: `cd src-tauri && cargo fmt --all -- --check` 通过
  - [x] SubTask 12.2: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` 通过
  - [x] SubTask 12.3: `cd src-tauri && cargo check --all-targets --all-features` 通过
  - [x] SubTask 12.4: `npx vitest run` 通过(本次相关测试 tauri.test.ts/AgentSettings.test.tsx/AgentInstallRow.test.tsx/AgentUpgradeConfirmDialog.test.tsx 全通过;预先存在的无关失败:sidecar dist/index.js 缺失、codexCompatProxy 端口占用、assistant-ui 渲染问题)
  - [ ] SubTask 12.5: `npm run build` 类型检查通过(预先存在的 `agentStore.ts` `simulateStreamingText` 未使用错误阻塞,本次改动无新错误)
  - [ ] SubTask 12.6: 手动 `npm run tauri dev` 验证:三态展示、多处安装诊断、锚定升级、确认对话框、补诊、toast 分级

# Task Dependencies

- Task 2 依赖 Task 1(三态探测为基础)
- Task 3 依赖 Task 2(多处枚举复用搜索路径与来源推断)
- Task 4 依赖 Task 3(锚定命令需要 `AgentInstallationReport`)
- Task 5 依赖 Task 4(执行复用命令生成)
- Task 6 依赖 Task 1、3、5(类型对齐 Rust 新结构)
- Task 7 依赖 Task 6(前端类型就绪)
- Task 8 独立,可并行于 Task 7
- Task 9 依赖 Task 6、8(复用 `AgentInstallRow`)
- Task 10 依赖 Task 7、9(卡片改造与对话框就绪)
- Task 11 依赖 Task 10(toast 分级接入升级流程)
- Task 12 依赖 Task 1-11 全部完成

# 可并行任务

- Task 8(`AgentInstallRow`)可与 Task 7(`RuntimeCard` 改造)并行
- Task 6(TS 类型)可与 Task 4、5(Rust 锚定与执行)并行准备(但需在 Task 7 前完成)
