# 0007 — 同一 Session 上的 Agent Kind Switch

一条 CodeMUX Session 在生命周期内可以更换 Active Agent Kind（Claude Code / Codex / OpenCode），会话身份与 CodeMUX Event 时间线不变。三个 runtime 不能共用 Native Session，也不能无损重放工具历史；切换通过新建 Native Session 并注入确定性 Switch Briefing 完成。这撤销 2026-06-10 规格中「创建后永久绑定、session 内不可切换」的不变量，并收窄 ADR 0005「切换智能体不自动更换供应商」为仅适用于新建草稿。

## Status

accepted

## Context

CodeMUX 托管三套独立编码运行时。它们各有工具协议、权限模型和原生 session 存储；原生 ID 不可互换。旧规则把 `agent_kind` 当作 Session 的出生绑定，换人只能新开对话或 Fork。用户要的是同一条对话里换驾驶席并继续干活。权威时间线已是 CodeMUX Event（ADR 0003）；应用层可以保持一条 Session，同时在模型侧承认交接是有损的。

## Decision

1. **Session 身份稳定。** Agent Kind Switch 不创建新 Session，不搬走已有气泡。Active Agent Kind 是指针，不是出生绑定。
2. **仅 Claude Code、Codex、OpenCode。** `gemini_cli` 未接入，不参与切换。只读或导入快照 Session 不能切换。
3. **确认后立即成立**，不绑下一条 User Message。仅当最近一轮已有 Turn Outcome、且没有未应答 Interactive Request。进行中不能切。有未发送队列时仍可切，但队列保持暂停，不自动发给进入的种类。
4. **每次切换（含切回）都新建 Native Session**，注入 Switch Briefing。Briefing 从 CodeMUX Event 做确定性投影（近文、触及路径、最后 Turn Outcome），不另调用模型，不先 compact，不重放工具/权限，不 resume 该种类的旧 Native Session。Briefing 不是 User Message；切换记为 System Event。
5. **Permission Snapshot 重置**为进入种类的默认预设，plan 关掉。不翻译权限枚举，不迁移「本会话已允许」。
6. **Kind Model Selection** 按种类记住 Model Provider、模型与 Reasoning Effort。切换时恢复进入种类的那一组；没有记录则回落到能提供匹配 Protocol Endpoint 的 Active Provider；再没有则切换不能成立。这收窄 ADR 0005 第 3 条：新建草稿改种类仍不自动换供应商；Agent Kind Switch 不再沿用上一种类的供应商。
7. **Fork 仍是另一件事**：新 Session、同一 Agent Kind、原生历史拷贝。首版不提供「Fork 到另一种类」。

## Considered Options

- **切换即开子会话（Fork 到另一种类）**——弃用：用户要的是同一条对话继续，不是世界线分叉。Fork 保留为同种类原生拷贝。
- **编排器把另一 runtime 当工具**——弃用：用户要亲手换驾驶席，不是让当前种类代为调用。
- **喂完整工具历史 / 跨种类 resume 旧 Native Session**——拒绝：协议不兼容，模型和屏幕会分裂；切回时 resume 旧世界线同样如此。
- **轮中热切 / 先停再切合成一步**——拒绝：外部 runtime 不保证 turn 边界；卡住时走现有 Stop，等 Turn Outcome 再切。
- **选择器只是待定意图，下次发送才切换**——弃用：徽章、权限、模型会与真正的驾驶席不一致。
- **用另一次模型调用或 native compact 生成 Briefing**——弃用：确认即切不能再开一轮；跨种类也不能依赖当前种类的压缩格式。
- **跨种类翻译权限 / 保留 plan 为会话意图**——拒绝：三种 Plan 不是同一语义；切走常常就是为了换工作方式。
- **一份会话级 provider/model/effort 跨种类沿用**——弃用：切到 Codex 时可能带着只含 Anthropic 端点的供应商，下一轮发不出。
- **有队列则禁止切换，或切换时丢掉/自动放行队列**——弃用：暂停队列已是「先别发」；默默丢字或把写给 Claude 的句子发给 Codex 都更糟。

## Consequences

- 打开 Session 必须以 CodeMUX Event 快照为权威时间线，不能只按当前 Active Agent Kind 加载原生磁盘 transcript，否则会丢掉其他种类说过的话。
- `sessions.agent_kind` 的含义变为当前驾驶席，必须可更新；每种最多一条继续用的 Native Session 映射，切换后覆盖。
- 用户看见的连续，不等于模型看见的连续。切换等于冷启动，prompt cache 不保证命中。
- MCP/skills 按进入种类的启用开关重载；工作区仍是同一项目，串行驾驶，不为切换建 git 分支。
- 实施前需正式修订 2026-06-10 多智能体规格中的「不可切换」非目标，而不是静默改行为。
