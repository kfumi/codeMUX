# 03 — 打通 OpenCode 项目 Skill 并完成跨 Agent 回归

**What to build:** OpenCode 会话打开项目后，CodeMUX 能发现 OpenCode 原生和兼容项目 Skill 来源，并让项目 Skill 通过 OpenCode runtime 真正可用；同时完成 Claude Code、Codex 和 OpenCode 三种 Agent 在项目切换、来源展示、缓存和命令解析上的一致性验证。

**Blocked by:** 01 — 建立项目 Skill Resolver 并打通 Claude Code

**Status:** done

- [x] OpenCode 能识别项目 `.opencode/skills`、`.claude/skills` 和 `.agents/skills` 中符合其规则的 Skill。
- [x] OpenCode 的来源优先级和同名 Skill 选择行为与其 runtime 约定一致。
- [x] 项目 Skill 与全局 OpenCode Skill 正确去重，项目结果优先于全局结果。
- [x] 选择项目 Skill 后，OpenCode runtime 能实际发现或加载对应 Skill，而不是只有菜单展示。
- [x] 菜单显示来源标记，命令解析和 runtime 使用同一份合并结果。
- [x] 项目切换、Agent 切换、并发加载、缓存命中、缓存刷新和单个 Skill 读取失败均有稳定行为。
- [x] 完成 Claude Code、Codex 和 OpenCode 的跨 Agent 回归，确认全局 Skill、内置命令和无项目 Skill 场景不受影响。
- [x] 明确 Gemini CLI 和 `.cursor/skills` 不在本次功能范围内。
