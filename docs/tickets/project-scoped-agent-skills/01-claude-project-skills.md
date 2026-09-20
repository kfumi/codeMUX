# 01 — 建立项目 Skill Resolver 并打通 Claude Code

**What to build:** Claude Code 会话打开项目后，CodeMUX 能从当前项目根目录发现 Claude 项目 Skill，并将同一份项目 Skill 结果用于斜杠菜单、命令解析和 Claude runtime；项目 Skill 优先于同名全局 Skill，但不覆盖内置命令，同时扫描过程不会阻塞对话输入或污染全局 Skill 管理。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 当前项目根目录的 `.claude/skills` 能发现有效的 `SKILL.md`，并展示名称、描述和项目来源。
- [x] 项目 Skill 与全局 Skill 按规范化名称去重，项目 Skill 优先；内置命令优先于所有 Skill。
- [x] 菜单、slash 解析、chip 解析和命令序列化使用同一份合并后的命令目录。
- [x] 选择项目 Skill 后，Claude runtime 能通过项目 Skill source 和有效 Skill allowlist 真正加载该 Skill。
- [x] 项目 Skill 不写入全局数据库、不复制到 SSOT、不投影到用户 Agent 目录。
- [x] 首次加载只读取必要的 Skill 元数据，不预加载 Skill 正文、references 或 assets。
- [x] 同一项目和 Agent 的并发加载请求只执行一次实际扫描，并复用缓存结果。
- [x] 扫描不持有 SQLite 锁；单个文件读取或 frontmatter 解析失败不会阻塞对话和其他 Skill。
- [x] 项目切换、Agent 会话重建和显式刷新不会保留旧项目 Skill。
- [x] 测试覆盖来源发现、去重优先级、runtime 配置、缓存 single-flight、失败降级和无项目 Skill 回归。
