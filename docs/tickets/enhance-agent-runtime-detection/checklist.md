# Checklist

## 三态探测

- [x] `AgentRuntimeCheck` 新增 `installed_but_broken: bool` 字段,Rust 与 TS 类型对齐
- [x] `check_single_runtime` 严格区分 `NotFound` / `FoundButFailed` / `Found` 三态,`FoundButFailed` 时 `installed_but_broken=true` 且 `message` 含 stderr 末尾内容
- [x] 前端 `RuntimeCard` 在 `installed_but_broken=true` 时展示琥珀色"异常"徽标与"已安装但无法运行:<摘要>"副文案
- [x] 单元测试覆盖三态判定

## 搜索路径扩展与来源推断

- [x] `build_tool_search_paths` 按通用/macOS/Linux/Windows/OpenCode 专属目录汇总去重
- [x] Windows 排除 `Microsoft\WindowsApps` 目录
- [x] `find_command_path` 先扫候选目录,再回退 `where/which`
- [x] `infer_install_source` 按路径前缀推断 nvm/homebrew/volta/fnm/mise/bun/pnpm/scoop/system/unknown
- [x] Windows 原生不走 `cmd /C <tool>`,只在已定位真实可执行文件上跑 `--version`,扩展名优先 `.cmd` → `.exe` → 无扩展名
- [x] 单元测试覆盖 `infer_install_source` 各分支

## 多处安装枚举

- [x] `probe_agent_installations` IPC 命令已注册到 `lib.rs`
- [x] `AgentInstallation` 包含 path / real / version / runnable / error / source / is_path_default 字段
- [x] `AgentInstallationReport` 包含 agent_kind / installs / is_conflict / needs_confirmation / anchored / command 字段
- [x] 枚举不短路,遍历所有候选目录,canonicalize 去重,每个真实安装跑一次 `--version`
- [x] `is_path_default` 用 `where/which` 解析 PATH 实际命中那处并比对
- [x] `is_conflict` 判定:≥2 处 && (版本分歧 || runnable 混合)
- [x] PATH 默认那处排 `installs` 第一位
- [x] TS 端 `appApi.probeAgentInstallations` 封装就绪

## 锚定升级

- [x] `default_install` 取 PATH 默认那处或唯一一处
- [x] `anchored_command_from_paths` 按官方自升级 → 同级包管理器 → npm 兜底 优先级生成命令
- [x] `package_manager_anchored_command_from_paths` 按 source 推导同级 bin(volta/bun/npm)
- [x] Windows 版 sibling 选择 `.cmd` 优先于 `.exe`
- [x] 命令字符串路径含空格才加引号(POSIX 单引号 / Windows 双引号)
- [x] 命令使用绝对路径,不依赖 PATH
- [x] `upgrade_agent_runtime` 内部重新生成命令,不信任前端回传
- [x] 单元测试覆盖锚定判定各分支

## 升级执行与错误分级

- [x] `AgentRuntimeUpgradeResult` 新增 `outcome: UpgradeOutcome` 字段(success/soft_version_unchanged/soft_not_runnable/hard_failure)
- [x] POSIX 静默执行用 `bash -c`,Windows 写临时 `.bat` + `cmd /C` + `CREATE_NO_WINDOW`,执行后删 `.bat`
- [x] 失败时 `message` 取 stderr 末尾 8 行,Windows 按 OEM/ANSI codepage 解码
- [x] 按 version 变化与可运行性判定 `outcome`
- [x] TS 端 `AgentRuntimeUpgradeResult` 类型含 `outcome` 字段

## 升级前确认对话框

- [x] `AgentUpgradeConfirmDialog` 组件已创建
- [x] 接收 `report` 与 `onConfirm` / `onCancel` 回调
- [x] 列表渲染 `installs`(`AgentInstallRow`)
- [x] 底部展示锚定命令字符串
- [x] `anchored=false` 时展示"默认入口无法确定,将退到 npm 兜底"提示
- [x] `needs_confirmation=true` 时升级前弹窗,`false` 时直接升级
- [x] 使用 shadcn/ui `Dialog` 组件,遵循面板式风格
- [x] 组件测试覆盖确认/取消回调与各展示状态

## 升级后补诊

- [x] 升级完成后(无论 outcome)自动调 `probeAgentInstallations` 补诊
- [x] 补诊有冲突 → 卡片下方渲染 `AgentInstallRow` 列表
- [x] 补诊无冲突 → 清掉残留展示
- [x] 补诊静默执行,不弹 toast
- [x] 升级期间 `upgradingKind` 锁定,禁用其它卡片升级按钮

## toast 分级

- [x] `outcome=success` → success toast + "当前版本:{newVersion}"
- [x] `outcome=soft_*` → warning toast + "命令已执行但可能未生效,已自动诊断"
- [x] `outcome=hard_failure` → error toast + stderr 末尾内容

## AgentInstallRow 组件

- [x] `src/components/settings/AgentInstallRow.tsx` 已创建
- [x] 单行展示 source 徽章 + 路径(可复制)+ 版本(或"无法运行")+ "默认"标记
- [x] 复用 shadcn/ui `Button`/`Badge`(本地最小化 Badge,后续可抽取到 `ui/badge.tsx`)
- [x] 组件测试覆盖各状态

## 命令展示与执行分离

- [x] 展示给用户的命令字符串仅用于知情
- [x] 后端 `upgrade_agent_runtime` 仅接受 `agent_kind` 参数,内部重新生成命令

## 回归验证

- [x] `cd src-tauri && cargo fmt --all -- --check` 通过
- [x] `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` 通过
- [x] `cd src-tauri && cargo check --all-targets --all-features` 通过
- [x] `npx vitest run` 本次相关测试全通过(tauri.test.ts 16/16、AgentSettings.test.tsx 23/23、AgentInstallRow.test.tsx 4/4、AgentUpgradeConfirmDialog.test.tsx 7/7);预先存在的无关失败见 tasks.md SubTask 12.4 备注
- [ ] `npm run build` 类型检查通过(预先存在的 `agentStore.ts` `simulateStreamingText` 未使用错误阻塞,本次改动无新错误)
- [ ] 手动 `npm run tauri dev` 验证:三态展示、多处安装诊断、锚定升级、确认对话框、补诊、toast 分级
