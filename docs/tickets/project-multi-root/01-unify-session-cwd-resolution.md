# 01 — 合并会话工作目录解析为唯一权威实现

**What to build:** 把 daemon 里两份语义不同的会话工作目录解析合并成一份权威实现，顺序为「imported 会话取原生存储的目录 → 会话自己的 working path → 项目主根 → home」。合并后，worktree 会话在「首发」与「移动端改设置后刷新 runtime」两条路径上都拿到 worktree 路径，而不是项目主根。

这是整个特性的 prefactor：后续所有「项目主根」替换「项目路径」的改动都会落到这一个函数上。没有它，同一处语义会在多个调用点各改一遍，且很难判断是否改全。

对用户可见的唯一变化是缺陷修复：worktree 会话在移动端改设置后不会被错误地拉回项目主根。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 会话工作目录解析只剩一份实现，优先级为 imported 原生目录 → working path → 项目主根 → home
- [ ] 「首发」与「移动端改设置后刷新 runtime」两条路径都使用该实现
- [ ] worktree 会话在上述两条路径上解析出 worktree 路径，而非项目主根
- [ ] 导入会话仍以原生存储的目录为准
- [ ] 无项目会话回落到 home，行为不变
- [ ] 单测覆盖四个优先级分支与 worktree 场景
