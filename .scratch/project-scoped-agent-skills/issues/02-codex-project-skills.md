# 02 — 打通 Codex 项目 Skill

**What to build:** Codex 会话打开项目后，CodeMUX 能发现当前项目 `.agents/skills` 中的 Skill，并将其作为当前 Agent 可执行的项目能力展示和调用；项目 Skill 与全局 Codex Skill 正确去重，且不改变现有全局 Skill 管理行为。

**Blocked by:** 01 — 建立项目 Skill Resolver 并打通 Claude Code

**Status:** done

- [x] Codex 项目根目录的 `.agents/skills` 能被 Project Skill Resolver 识别。
- [x] 项目 Skill 与全局 Codex Skill 按规范化名称去重，项目版本优先。
- [x] 斜杠菜单显示项目 Skill 的来源标记，并且项目切换后不会残留旧项目结果。
- [x] 选择 Skill 时向 Codex runtime 传递正确的 `SKILL.md` 路径，Skill 正文和相对资源仍然可访问。
- [x] Windows 路径分隔符、空格路径和不存在路径都有稳定处理。
- [x] Codex 的菜单、命令解析、序列化和实际 runtime 使用同一份 Skill 解析结果。
- [x] 缓存和 single-flight 机制不会因为 Codex 会话初始化再次扫描同一项目。
- [x] 测试覆盖项目来源、同名去重、路径序列化、项目切换、扫描失败和无项目 Skill 回归。
