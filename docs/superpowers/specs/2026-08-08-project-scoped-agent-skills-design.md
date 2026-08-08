# 按 Agent 加载项目级 Skills 设计

## Problem Statement

CodeMUX 当前的斜杠命令中的 Skill 主要来自应用启动时扫描并写入全局数据库的 Skill。项目根目录中的 Agent-specific Skill 没有按照当前会话使用的 Agent 进行发现，因此用户无法在项目对话中直接看到或调用仓库自带的 Skill。

当前实现还存在一个一致性风险：菜单中的 Skill 命令、slash/chip 命令解析和 Agent runtime 使用的 Skill allowlist 并不是由同一个项目上下文解析而来。仅在前端菜单增加项目 Skill，可能导致用户能看到命令，但实际 Agent 找不到或无法加载对应的 `SKILL.md`。

项目 Skill 加载还必须考虑性能。扫描过程需要读取文件，不能阻塞 React 输入和渲染，不能因为菜单加载重复扫描，也不能因为磁盘读取长期持有数据库锁或影响其他 Agent 操作。

## Solution

为每个会话建立基于以下上下文的项目 Skill 目录：

```text
(项目根目录, 当前 Agent 类型)
```

由一个共享的 Project Skill Resolver 完成：

1. 根据当前 Agent 类型选择该 Agent 有效的项目目录；
2. 只在当前项目根目录内扫描，不向父目录或子目录扩展；
3. 读取 Skill 元数据并生成项目 Skill 目录；
4. 按当前 Agent 的来源优先级去重；
5. 与全局 Skill 和内置命令合并；
6. 将同一份解析结果同时提供给斜杠菜单、命令解析和 Agent runtime；
7. 在菜单中展示 Skill 的项目来源；
8. 通过缓存和 single-flight 避免重复文件扫描。

项目 Skill 是会话范围内的只读发现结果，不写入全局 Skill 数据库，不复制到 CodeMUX 的 SSOT，也不投影到用户 Agent 目录。

## User Stories

1. 作为 Claude Code 用户，我希望打开项目后看到项目 `.claude/skills` 中的 Skill，以便直接使用仓库提供的工作流。
2. 作为 Codex 用户，我希望看到项目 `.agents/skills` 中的 Skill，以便复用团队共享的 Codex 工作流。
5. 作为 OpenCode 用户，我希望看到项目 `.opencode/skills` 中的 Skill，以便使用 OpenCode 原生项目能力。
6. 作为 OpenCode 用户，我希望使用项目 `.claude/skills` 或 `.agents/skills` 兼容目录中的 Skill，以便复用其他 Agent 的项目工作流。
7. 作为用户，我希望 Skill 目录只根据当前会话 Agent 选择，以便菜单中不出现当前 Agent 无法使用的 Skill。
8. 作为用户，我希望同名的项目 Skill 只显示一个，以便斜杠菜单不出现重复命令。
9. 作为用户，我希望项目 Skill 优先于同名全局 Skill，以便当前仓库的约定覆盖个人默认约定。
10. 作为用户，我希望内置命令优先于同名项目 Skill，以便项目文件不会覆盖 CodeMUX 的核心命令。
11. 作为用户，我希望在斜杠菜单中看到 Skill 来自项目而不是全局，以便判断当前调用的来源。
12. 作为用户，我希望来源显示相对项目根目录的路径，以便识别 Skill 所属目录而不暴露不必要的机器路径。
13. 作为用户，我希望选择项目 Skill 后 Agent 真正加载对应的 `SKILL.md`，而不是只在菜单中显示一个无效命令。
14. 作为 Claude Code 用户，我希望项目 Skill 被加入 Claude runtime 的项目 Skill 发现和 allowlist，以便 SDK 不会因为全局 Skill 配置而排除项目 Skill。
15. 作为 Codex 用户，我希望选择项目 Skill 时仍然能传递正确的 `SKILL.md` 路径，以便 Skill 正文和附带资源保持可访问。
17. 作为 OpenCode 用户，我希望项目 Skill 使用 OpenCode 支持的项目和兼容目录，以便 Skill 能被 OpenCode 的原生 Skill 机制加载。
18. 作为用户，我希望切换项目后旧项目的 Skill 从菜单中消失，以便不会误调用其他项目的工作流。
19. 作为用户，我希望切换 Agent 类型后菜单只展示新 Agent 有效的项目 Skill，以便命令列表与实际 runtime 保持一致。
20. 作为用户，我希望打开没有项目 Skill 的项目时仍然可以正常使用全局 Skill 和内置命令。
21. 作为用户，我希望项目 Skill 扫描失败时仍然可以使用对话、内置命令和全局 Skill。
22. 作为用户，我希望某个损坏的 `SKILL.md` 不会导致整个项目 Skill 列表加载失败。
23. 作为用户，我希望 Skill 扫描不会阻塞输入框、斜杠菜单动画或消息渲染。
24. 作为用户，我希望同一个项目在短时间内重复打开时复用扫描结果，以便减少磁盘读取。
25. 作为用户，我希望菜单加载和 Agent 启动使用同一份 Skill 解析结果，以便避免重复扫描和显示与执行不一致。
26. 作为用户，我希望编辑 Skill 的元数据后，后续刷新能够看到新的名称和描述。
27. 作为用户，我希望项目 Skill 不会被意外写入全局数据库，以便不同项目之间不会互相污染。
28. 作为用户，我希望卸载全局 Skill 不会删除项目目录中的 Skill 文件。
29. 作为项目维护者，我希望提交到仓库的 Skill 能在其他开发者打开项目时自动出现，而不需要每个人手动导入。
30. 作为项目维护者，我希望 Skill 的脚本、references 和 assets 仍然相对其 `SKILL.md` 所在目录工作。
31. 作为用户，我希望大型项目中的大量无关目录不会被扫描，以便打开项目时保持稳定性能。
32. 作为用户，我希望位于慢速或网络磁盘上的项目不会让整个 CodeMUX 无响应。
33. 作为用户，我希望重复触发相同项目和 Agent 的加载请求时只执行一次实际扫描。
34. 作为用户，我希望项目 Skill 只加载元数据，不在打开项目时把所有 Skill 正文读入前端内存。
35. 作为用户，我希望没有 Cursor Agent 会话时 `.cursor/skills` 不会被错误地当作当前 Agent 的有效 Skill 来源。

## Implementation Decisions

- 新增一个 Project Skill Resolver 作为主要 seam。菜单、命令解析和 runtime 配置都通过该 seam 获取项目 Skill，避免各层分别实现目录扫描和去重。
- Resolver 的输入是项目根目录和 `AgentKind`，不使用全局当前 Agent 设置，也不使用前端传入的任意 Skill 路径作为可信 allowlist。
- 当前 Agent-specific 项目来源定义如下：
  - Claude Code：`.claude/skills`
  - Codex：`.agents/skills`
  - OpenCode：`.opencode/skills`、`.claude/skills` 和 `.agents/skills`
- `.cursor/skills` 不纳入当前功能，因为当前 AgentKind 没有 Cursor。将 Cursor Skill 作为其他 Agent 的跨来源兼容输入属于后续功能。
- 项目根目录由会话绑定的项目路径确定。Resolver 不实现从当前工作目录向父级逐级查找，也不扫描项目根目录之外的 Skill。
- 每个 Agent 的来源优先级由其 Adapter 定义。通用合并优先级为：内置命令高于项目 Skill，项目 Skill 高于全局 Skill。
- 同名去重使用规范化命令名作为 key，至少进行空白清理和大小写归一化；展示名称、实际名称和路径保留原始值。
- Project Skill 的元数据包含名称、描述、显示名称、Skill 文件路径、项目相对来源路径和来源目录类型。
- 项目 Skill 不进入全局 SQLite，不调用全局 Skill 的安装、导入、卸载或投影逻辑，不复制项目文件。
- 首次扫描只读取发现所需的 `SKILL.md` 元数据，不读取 Skill 正文、references 或 assets。正文和附属资源由对应 Agent 在真正使用时按需读取。
- Scanner 不应在扫描文件时持有 SQLite 锁。全局 Skill 查询与项目 Skill 文件扫描必须是可分离的阶段。
- Resolver 缓存以规范化项目根目录和 AgentKind 为 key，缓存值为项目 Skill 元数据和来源状态。
- 同一个 key 的并发请求使用 single-flight；菜单加载和 Agent 会话初始化共享进行中的请求或已完成的缓存结果。
- 缓存刷新至少支持项目切换、Agent 类型变化和显式刷新。短 TTL 或有限的 `SKILL.md` 修改时间检查可用于发现外部文件变化。
- Scanner 对目录深度、Skill 数量、单个元数据文件读取大小和符号链接/junction 行为设定边界，防止异常仓库导致无界扫描。
- 文件读取和 frontmatter 解析失败时跳过单个 Skill并记录诊断，不使整个 Skill 目录或对话功能失败。
- 前端在项目 Skill 尚未完成加载时显示加载状态或暂时只显示已有命令；不得在每次输入字符变化时触发扫描。
- 当前 Agent runtime 使用 Resolver 的结果：
  - Claude Code 将项目来源纳入项目 settings source，并将有效项目 Skill 名称与允许的全局 Skill 合并；
  - Codex 使用项目 Skill 的实际 `SKILL.md` 路径进行调用；
  - OpenCode 使用项目 Skill、Claude-compatible Skill 和 Agent-compatible Skill 的原生发现语义。
- Agent runtime 的初始化如果必须等待 Skill 结果，只等待对应的 Resolver 请求，不阻塞整个前端应用。
- 斜杠菜单、slash 解析、chip 解析和命令序列化必须使用同一套已合并命令目录。
- 来源展示使用“项目”标记和项目相对路径；完整绝对路径只用于诊断或必要的运行时引用。
- 全局 Skill 的启用状态继续由现有设置和数据库控制；项目 Skill 不提供全局开关。
- 项目 Skill 变更不会自动修改仓库文件、全局 Skill 目录、Agent 配置文件或 SQLite 数据。

## Testing Decisions

- 测试应验证外部行为：给定项目目录和 Agent 类型，Resolver 返回哪些 Skill；给定同名来源，菜单和 runtime 最终使用哪个 Skill；给定扫描失败，其他功能是否仍然可用。
- Rust Resolver 测试使用临时项目根目录和最小的 Skill fixture，覆盖每种 Agent 的有效目录、无效目录、缺少 `SKILL.md`、损坏 frontmatter 和空描述。
- Resolver 测试覆盖 Agent-specific 来源：
  - Claude Code 只加载 `.claude/skills`；
  - Codex 加载 `.agents/skills`；
  - OpenCode 合并其原生和兼容来源。
- 去重测试覆盖项目与全局同名、项目来源之间同名、大小写差异、内置命令同名以及来源优先级。
- 性能行为测试验证同一个项目和 Agent 的并发请求只产生一次扫描，并验证缓存命中不会再次读取 Skill 文件。
- 性能边界测试验证超出数量、文件大小或递归限制时不会无界扫描，并验证单个异常 Skill 不影响其他结果。
- 文件系统测试验证符号链接、junction、不可读文件和项目路径不存在时的安全降级行为。
- 前端测试验证项目 Skill 加载状态、项目切换清理、Agent 切换刷新、来源标签显示和命令列表去重。
- 前端测试验证同一个命令目录同时驱动菜单过滤、slash 解析、chip 解析和命令序列化。
- Agent runtime 测试验证项目 Skill 名称或 `SKILL.md` 路径实际进入对应 runtime 配置，而不是只存在于 UI 状态。
- Claude runtime 测试验证项目 Skill 不会因为全局 Skill allowlist 而被排除。
- Codex runtime 测试验证项目 Skill 的 `SKILL.md` 路径保持正确，并覆盖 Windows 路径分隔符。
- OpenCode 测试验证项目根目录和兼容 Skill 来源被正确传递或由原生 runtime 发现。
- 回归测试验证没有项目 Skill 时，现有全局 Skill、内置命令和 Agent 启动行为不变。
- 不测试 Rust 内部函数调用次数等实现细节；只测试扫描结果、缓存可观察行为、runtime 配置和用户可见命令。

## Out of Scope

- 不支持 Gemini CLI 项目 Skill；后续可单独增加 Gemini-specific 来源和 runtime 测试。
- 不支持 Cursor 作为当前 Agent，也不扫描 `.cursor/skills` 作为其他 Agent 的默认来源。
- 不实现跨 Agent Skill 导入、转换或自动复制。
- 不把项目 Skill 安装到全局目录或写入全局 Skill 数据库。
- 不提供项目 Skill 的编辑器、安装器、版本管理、市场浏览或卸载 UI。
- 不递归扫描整个项目，也不实现从当前目录向 Git 根目录逐级寻找 Skill。
- 不在打开项目时预加载所有 Skill 正文、references、assets 或脚本。
- 不监听整个项目文件树来实现实时 Skill 热更新。
- 不改变现有全局 Skill 的数据库结构和全局开关语义。
- 不解决 Agent 原生 Skill 规范之外的任意自定义目录配置。
- 不保证一个 Agent 的 Skill 能直接在另一个 Agent 中以完全相同的语义运行。

## Further Notes

- 当前代码中的全局磁盘扫描会在部分文件系统操作期间持有数据库锁。项目 Skill Resolver 必须与该持久化扫描流程分离，不能复用会复制 Skill 或写入数据库的入口。
- 当前命令注册是全局前端状态，而项目 Skill 是项目和 Agent 上下文状态。实现时应避免继续扩大全局可变数组的职责。
- 项目 Skill 目录只返回元数据和路径，能够显著降低 IPC payload、前端内存和首次打开项目的磁盘读取量。
- 需要在实现阶段确认各 Agent 当前 runtime 版本对项目 Skill 的原生发现和 allowlist 语义，并为不支持统一 allowlist 的 Agent 使用各自 Adapter。
- 规格的 issue tracker 发布需要 GitHub CLI；当前工作环境未安装 `gh`，因此本次只生成规格文件，未创建带 `ready-for-agent` 标签的 issue。
