# 重构为 CodeMUX 托管 SDK Runtime
## Problem Statement
CodeMUX 当前将 Claude、Codex 和 OpenCode SDK 作为 sidecar 的 npm 依赖随安装包发布，并将安装包内的 sidecar 目录作为实际运行时来源。这样会造成以下用户问题：
- 安装包体积包含多个 SDK、传递依赖和平台相关二进制，发布与升级成本高。
- CodeMUX 更新时可能覆盖正在使用的 SDK 文件，导致 Windows 出现文件占用或 `Error opening file for writing`。
- SDK 版本与 CodeMUX 主程序发布耦合，无法独立修复或升级单个 Provider Runtime。
- 当前运行时检测主要依赖 PATH 中的全局 CLI，用户未安装全局 `claude`、`codex` 或 `opencode` 时，CodeMUX 可能被误判为不可用。
- 通过全局 npm 目录或 `npm install -g` 管理 SDK 会受用户环境、权限、版本残留和多份安装影响，结果不可预测。
- Runtime 损坏、下载中断、校验失败和更新失败缺少统一的恢复、回滚和诊断入口。
用户需要的是由 CodeMUX 自己管理、可验证、可回滚且与用户全局 CLI 解耦的 SDK Runtime；系统 Node.js 仍作为明确的外部前置依赖。
## Solution
CodeMUX 改为托管 Claude、Codex 和 OpenCode 的 SDK Runtime。主安装包只保留 sidecar 核心代码，不再包含三个 SDK 及其平台二进制；Runtime Pack 从项目 GitHub Release 下载，安装到用户级运行时目录，并由 Rust Runtime Manager 负责清单、签名、哈希、完整性、版本切换、失败回滚和旧版本清理。
CodeMUX 启动智能体会话前检查 Node.js、sidecar 和对应 Provider Runtime。sidecar 从 Rust 接收当前 Runtime 的显式路径，动态加载 SDK，不依赖用户全局 npm 目录。全局 `claude`、`codex`、`opencode` 检测继续保留，但仅作为独立的外部 CLI 诊断，不再决定 CodeMUX 自有 SDK Runtime 是否可用。
设置页继续复用现有 AgentSettings 页面和卡片结构，但改为展示 CodeMUX 运行时环境，并提供安装、更新、修复、删除、重新检测、进度反馈和失败重试。
## User Stories
1. 作为 CodeMUX 用户，我希望安装包不再包含 Claude、Codex 和 OpenCode SDK 及其二进制，以便安装更轻量且主程序升级不再覆盖 SDK 文件。
2. 作为首次安装用户，我希望仅安装系统 Node.js 就能在 CodeMUX 中下载所需 Runtime，以便不必额外安装全局 CLI。
3. 作为首次启动用户，我希望清楚看到 Node.js 是否存在、版本是否满足要求以及可执行路径，以便知道无法启动会话的具体原因。
4. 作为用户，我希望按 Provider 单独安装 Runtime，以便只安装我实际使用的智能体。
5. 作为用户，我希望 Runtime 安装到用户级目录，而不是 CodeMUX 安装目录，以便应用升级不会破坏已安装 Runtime。
6. 作为用户，我希望看到每个 Provider 的 Runtime 状态、当前版本、可用版本和安装路径，以便判断是否需要操作。
7. 作为用户，我希望 CodeMUX 在下载前验证 Runtime manifest，以便只安装受信任的版本。
8. 作为用户，我希望下载包校验签名和 SHA-256，以便避免损坏或被篡改的 Runtime 被启用。
9. 作为用户，我希望 Runtime 安装在版本化目录中，以便更新时不覆盖当前正在使用的 SDK 文件。
10. 作为正在运行会话的用户，我希望更新另一个 Provider 不影响当前会话，以便可以安全地在后台维护 Runtime。
11. 作为用户，我希望更新失败自动回滚到上一个可用版本，以便失败后仍能继续使用 CodeMUX。
12. 作为用户，我希望删除 Runtime 后仍能从设置页重新安装，以便修复不再需要或损坏的 Provider。
13. 作为用户，我希望修复操作重新下载并校验损坏 Runtime，以便无需手动清理文件。
14. 作为用户，我希望下载中断后可以重试或继续，以便网络不稳定时不必从头排查。
15. 作为用户，我希望看到下载阶段、进度和失败原因，以便了解安装没有响应还是正在处理。
16. 作为用户，我希望同一 Provider 的并发安装只执行一个实际任务，以便避免文件竞争和重复下载。
17. 作为用户，我希望 CodeMUX 检查 Runtime 目录关键文件和二进制，以便提前发现不完整安装。
18. 作为用户，我希望 Runtime 版本与 sidecar 兼容性不匹配时得到明确提示，以便知道应升级哪个部分。
19. 作为用户，我希望缺少 Runtime 或 Runtime 损坏时，会话启动被阻止并返回结构化错误，而不是出现难以理解的 Node 异常。
20. 作为用户，我希望 Claude 会话继续支持现有会话恢复、流式事件、权限请求和中断行为，以便 Runtime 来源变化不改变使用体验。
21. 作为用户，我希望 Codex 会话继续支持现有流式事件、权限、中断、恢复和代理逻辑，以便迁移不影响已有工作流。
22. 作为用户，我希望 OpenCode 会话继续支持现有会话、流式事件、权限和中断行为，以便迁移不改变 Provider 语义。
23. 作为用户，我希望 Runtime 路径包含空格或非 ASCII 字符时仍可运行，以便使用系统默认用户目录和国际化账户名。
24. 作为用户，我希望 Node.js 不存在或低于 Node 18 时看到安装 Node.js 的明确提示，以便快速恢复会话能力。
25. 作为用户，我希望外部 CLI 未安装时，CodeMUX 自有 Runtime 仍显示可用，以便不被全局环境误导。
26. 作为用户，我希望单独查看 PATH 中的外部 CLI、版本、路径和冲突情况，以便诊断其他工具链，而不影响 SDK Runtime。
27. 作为用户，我希望外部 CLI 的多版本冲突与 CodeMUX Runtime 状态分开展示，以便区分环境诊断和应用运行依赖。
28. 作为发布维护者，我希望分别生成 Claude、Codex 和 OpenCode Runtime Pack，以便独立发布、修复和扩展 Provider。
29. 作为发布维护者，我希望每个 Pack 带有版本、平台、架构、大小和 SHA-256 信息，以便客户端可验证并支持审计。
30. 作为发布维护者，我希望 Runtime Pack 复用 GitHub Release 与现有签名体系，以便不引入另一套分发渠道。
31. 作为发布维护者，我希望 Runtime manifest 描述 SDK、传递依赖、关键文件和兼容版本，以便客户端能执行完整性检查。
32. 作为开发者，我希望 sidecar 的 Provider adapter 只替换 SDK 加载来源，不重写会话和事件逻辑，以便降低迁移风险。
33. 作为开发者，我希望前端保留统一的运行时调用入口，以便设置页和其他启动检查共享同一契约。
34. 作为开发者，我希望 Runtime Manager 成为 SDK Runtime 的唯一管理模块，以便避免 Rust、sidecar 和前端分别实现下载或版本切换。
35. 作为维护者，我希望 CodeMUX 不保留安装包内旧 SDK fallback 或旧 Runtime 目录兼容路径，以便消除双重来源和不可预测行为。
## Implementation Decisions
- 将 SDK Runtime 定义为 CodeMUX 托管的 Provider 运行时，而不是用户系统上的全局 CLI。支持的 Provider 为 Claude、Codex 和 OpenCode。
- 保留系统 Node.js 作为外部前置依赖，要求 Node 18 或更高版本可从 PATH 访问；Node.js 不随 CodeMUX 打包。
- 从安装包资源中移除完整 sidecar `node_modules` 以及三个 SDK 和其平台相关二进制；保留 sidecar 编译后的核心入口和业务代码。
- 新增 Runtime Pack 构建流程，分别生成 Claude Runtime Pack、Codex Runtime Pack 和 OpenCode Runtime Pack。每个 Pack 包含对应 SDK、平台相关二进制、传递依赖和最小 manifest。
- Runtime Pack 的正式下载源固定为项目 GitHub Release，并沿用现有发布版本与签名体系。
- Runtime manifest 至少描述 Runtime 版本、Provider、平台、架构、下载资产、文件大小、SHA-256、签名、兼容的 sidecar 版本、关键文件和关键二进制。
- Runtime 安装根目录固定为 `%LOCALAPPDATA%\CodeMUX\runtimes`，Provider 目录和版本目录采用稳定结构：`claude/<version>`、`codex/<version>`、`opencode/<version>`。
- Runtime Manager 是 SDK Runtime 的唯一管理模块，负责获取 manifest、检测 Node、发现已安装 Runtime、下载、签名与哈希校验、解压、目录完整性校验、版本切换、失败回滚、旧版本删除和损坏 Runtime 修复。
- Runtime 更新采用“新版本写入新目录、校验完成后切换当前版本”的策略，禁止原地覆盖当前使用的 SDK 文件。
- Runtime Manager 必须为同一 Provider 的安装、更新和修复提供互斥控制；并发请求只能产生一个有效安装任务，其他调用收到可识别的进行中结果或复用同一任务结果。
- Runtime Manager 必须区分下载失败、签名错误、哈希不匹配、解压失败、完整性失败、兼容性失败、权限失败、Node 不可用和回滚失败，并返回结构化错误。
- 将现有 `agent_runtime_check` 从“PATH 全局 CLI 检测”重构为 CodeMUX Runtime 检测，检测 Node 版本与路径、sidecar entrypoint、三个 Runtime 的安装状态、版本、完整性、关键二进制和 sidecar 兼容性。
- 统一 Runtime 状态为 `missing`、`installing`、`ready`、`outdated`、`corrupted`、`node_unavailable` 和 `error`。状态应描述 CodeMUX 自有 Runtime，不得由外部 CLI 缺失推导为不可用。
- 将升级操作改为 Runtime Pack 下载、校验、安装和切换；安装操作复用同一流程，修复操作强制重新验证并在必要时重装，删除操作只删除指定 Provider 的版本目录和当前版本指针。
- 扩展并保持统一前端调用入口：`checkAgentRuntimes`、`installAgentRuntime`、`upgradeAgentRuntime`、`repairAgentRuntime`、`removeAgentRuntime` 和 `probeExternalAgentCli`。调用结果应包含 Provider、状态、版本、路径、Node 状态、完整性结果、阶段、进度和用户可读错误。
- sidecar 启动协议由 Rust 显式传入 Runtime 根目录和当前 Provider Runtime 路径；sidecar 启动前验证路径已准备完成，缺失或损坏时返回结构化 Provider 错误。
- sidecar 通过显式路径动态加载 SDK，不读取用户全局 npm 目录，不执行 `npm install -g`，不依赖 CodeMUX 安装目录中的旧 SDK fallback。
- Claude、Codex 和 OpenCode 的现有会话、流式事件、权限请求、用户输入、中断、恢复和 Provider adapter 语义保持不变；本次变更只替换 SDK 的加载来源和启动前置检查。
- Runtime 路径解析必须使用平台安全的路径参数传递，正确支持空格、非 ASCII 字符和 Windows 用户目录，不通过未经转义的 shell 字符串拼接路径。
- 全局 `claude`、`codex`、`opencode` 检测迁移为独立的外部 CLI 诊断接口，允许展示 PATH、版本、来源、多安装冲突和可运行性，但不能改变 SDK Runtime 的 ready 状态或会话可用性。
- 设置页名称改为“CodeMUX 运行时环境”，复用现有 AgentSettings 页面和 RuntimeCard 结构。每个 Provider 卡片展示 Runtime 状态、当前版本、可用版本、Node 状态、安装路径和完整性结果。
- 设置页根据状态提供安装、更新、修复、删除和重新检测操作；下载时展示当前阶段和进度，失败时提供重试入口，并在操作完成后自动刷新状态。
- 外部 CLI 诊断单独展示为“外部 CLI 环境”，明确说明它不影响 CodeMUX 自有 SDK Runtime 的可用性。
- 不保留旧 SDK 安装包 fallback、旧 Runtime 目录兼容路径或通过全局 npm 管理 CodeMUX 实际使用 SDK 的逻辑。
- 优先实现 Windows x64；manifest、Pack 命名和 Runtime Manager 数据模型保留平台与架构扩展能力。
## Testing Decisions
- 测试以用户可观察的 Runtime 管理行为为主，不测试具体函数调用顺序、临时目录命名或实现内部数据结构。
- 最高层 seam 是 CodeMUX Runtime 管理 API：使用可控的 manifest、下载源、签名校验器和文件系统测试夹具，验证从检测到安装、切换、修复、删除和回滚的外部结果。
- 第二个必要 seam 是 sidecar Provider Runtime loader：验证 Claude、Codex 和 OpenCode 能从显式外部路径加载；验证路径缺失、目录损坏、版本不匹配、空格路径和非 ASCII 路径的结构化错误。
- 前端沿用现有 `AgentSettingsPanel`、`RuntimeCard` 和 Tauri API mock seam，只验证状态到按钮、进度、错误、重试和刷新行为的映射。
- Rust Runtime Manager 测试覆盖 Node 缺失、Node 版本低于 18、Node 版本满足要求、sidecar 缺失、manifest 缺失、签名错误、SHA-256 不匹配、目录缺少文件、关键二进制损坏、兼容性不匹配、安装、更新、切换、失败回滚、旧版本删除和损坏 Runtime 修复。
- Rust Runtime Manager 测试覆盖同一 Provider 并发安装的互斥行为，以及 Runtime 正在使用时更新不覆盖当前版本文件。
- Runtime Pack 发布测试验证三类 Pack 的 manifest、平台与架构字段、大小、SHA-256、签名输入和关键文件列表一致。
- sidecar 测试复用现有 Provider adapter、事件规范化、权限和会话测试模式，重点证明 SDK 加载来源改变后流式事件、权限请求、中断和恢复的外部行为不变。
- 前端测试覆盖 `missing` 显示安装、`installing` 显示进度、`ready` 显示可用、`outdated` 显示更新、`corrupted` 显示修复、`node_unavailable` 显示 Node 安装提示、操作成功后刷新、失败后重试，以及外部 CLI 缺失不影响 Runtime 状态。
- 手工验收覆盖全新机器仅安装 Node、只安装单个 Provider、会话运行期间更新另一个 Provider、CodeMUX 安装目录无 SDK 二进制、主程序更新无文件占用错误、删除后重装、断网、重启和下载中断恢复。
- 测试不得依赖开发机已有的全局 CLI、真实用户目录、真实 GitHub Release 或固定本地路径；网络、签名、下载和文件系统应由测试 seam 注入或使用临时夹具隔离。
- 既有 Claude、Codex、OpenCode 会话行为测试继续作为回归基线，不因 Runtime 管理重构而删除或降低覆盖范围。
## Out of Scope
- 不随 CodeMUX 打包 Node.js，也不实现 Node.js 的自动安装、升级或版本管理。
- 不在本 spec 中改变 Claude、Codex、OpenCode 的会话协议、事件语义、权限模型、模型配置、代理行为或历史恢复规则。
- 不保留安装包内 SDK fallback、旧 Runtime 目录兼容或从全局 npm 目录加载的兼容路径。
- 不再使用 `npm install -g` 安装或升级 CodeMUX 实际使用的 SDK。
- 不将全局 CLI 诊断改造成 CodeMUX Runtime 的替代实现；外部 CLI 仅提供辅助诊断。
- 不实现 Windows x86、Linux、macOS 或其他平台的专属 Pack；本期只要求 Windows x64 优先，并保留扩展模型。
- 不改变 GitHub Release 之外的产品分发渠道，也不新增另一套签名基础设施。
- 不在本 spec 中清理用户机器上已有的全局 CLI、全局 npm 包或其配置文件。
- 不提供旧版本 CodeMUX 安装包与新 Runtime 目录之间的迁移兼容；升级策略以新 Runtime 重新安装为准。
## Further Notes
- 当前仓库已有运行时检测的 Tauri API、设置页 RuntimeCard、安装诊断测试，以及 Claude/Codex/OpenCode sidecar 行为测试；本 spec 优先扩展这些既有 seam，而不是创建平行 API。
- 当前 sidecar package manifest 仍直接声明三个 SDK 依赖，后续实现必须同步调整依赖安装、构建产物和发布脚本，避免仅修改运行时检测而继续把 SDK 打进安装包。
- 当前事件协议 ADR 要求 sidecar 负责 Provider 事件解释、去重、顺序、工具生命周期、错误语义和结束状态；本次 Runtime 重构应保持该边界不变。
- Runtime manifest 和签名校验失败不得将未验证的 Pack 解压到当前有效目录；安装失败时应保留旧版本并提供可诊断的错误阶段。
- 当前项目没有发现可用的 issue tracker 配置文件，且本机没有可调用的 `gh` CLI。因此本次已生成仓库内中文 spec，但尚未发布 GitHub Issue 或应用 `ready-for-agent` 标签；发布前需要配置 issue tracker，并确认目标仓库为 `kfumi/codeMUX`。