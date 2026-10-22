# 项目多根目录只经提示词声明，不启用各运行时的原生多目录能力

Project 可以拥有多个源文件夹（Project Root），但第一版**不**调用任何 Agent Kind 原生的多目录支持：Claude Code 的 `Options.additionalDirectories` / `--add-dir`、Codex app-server 的 `runtime_workspace_roots` / `writableRoots`、OpenCode 的 `directory` 全部不用。附加目录只作为绝对路径清单追加进 system prompt（Claude `systemPrompt.append`、Codex `thread/start` 的 instructions、OpenCode `Config.instructions`、pi `--append-system-prompt`）。

**为什么不用原生能力：** Claude 的 `--add-dir` 不只是扩大工具可达范围，它同时把该目录当作配置来源——CLI 帮助文本直接把它标注为 “CLAUDE.md dirs”，SDK 内部有 `additionalDirectoriesForClaudeMd()`，`register_repo_root` 还能对附加目录 `reload_claude_md` / `reload_skills` / `reload_plugins`。这违背了本设计的核心约束：**附加目录只贡献可访问的文件，不贡献项目规则**。若给一个项目加 `backend` 根，会话会突然多出一套后端 CLAUDE.md 与 skills，用户无从预期。Codex 与 OpenCode 各有自己的语义和版本兼容面，四家行为无法对齐。

**代价：** 在 Codex、OpenCode、pi 上，“项目只包含这些文件夹”是提示词级别的约定而非强制边界；只有 Claude 在 `permissions.blockReadsOutsideWorkingDirectories` 等设置下才真正收窄。这是有意接受的——本需求是文件夹组织，不是权限模型重构。若将来要做强制边界，需要把文件工具执行权收归 daemon，那是另一件事。

**带来的简化：** 四种 Agent Kind 行为一致，与 ZCode 的实际形态相同；附加目录不会污染项目配置；实现落在四个 runtime 的初始化参数上，各加一个字段。
