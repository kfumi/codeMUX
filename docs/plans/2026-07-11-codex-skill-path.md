# Codex 技能完整路径实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让 Codex 技能命令使用完整的 `SKILL.md` 路径，而不改变 Claude Code。

**Architecture:** 在命令触发项元数据中携带智能体类型，序列化时仅对 Codex 技能命令将已保存的技能目录补成 `SKILL.md` 文件路径。没有路径时保留原有命令名称，避免影响其他命令。

**Tech Stack:** React、TypeScript、Vitest、assistant-ui directive formatter。

---

### 任务 1：为 Codex 技能路径定义回归测试

**文件：**
- 修改：`src/components/agent/assistant-ui/CodeMuxComposer.test.tsx`
- 修改：`src/lib/slashCommands.ts`

- [x] **步骤 1：扩展测试注册一个带磁盘路径的技能**

在作曲器测试的 `beforeEach` 或对应测试准备中注册一个启用 Codex 与 Claude Code 的技能，并设置 `diskPath: 'C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming'`。

- [x] **步骤 2：写入 Codex 序列化断言**

调用 `CODEMUX_FORMATTER.serialize` 的 Codex 命令触发项，断言结果为 `[$superpowers:brainstorming](C:\\Users\\94910\\.codex\\superpowers\\skills\\brainstorming\\SKILL.md) `。

- [x] **步骤 3：写入 Claude Code 兼容断言**

调用相同技能的 Claude Code 命令触发项，断言结果仍为 `[$superpowers:brainstorming](superpowers:brainstorming) `。

- [x] **步骤 4：运行测试并确认 RED**

运行：`npx vitest run src/components/agent/assistant-ui/CodeMuxComposer.test.tsx`

预期：新增 Codex 断言失败，证明当前实现仍发送技能名称而非完整文件路径；Claude 兼容断言保持通过。

### 任务 2：实现 Codex 技能路径序列化

**文件：**
- 修改：`src/lib/slashCommands.ts`
- 修改：`src/components/agent/assistant-ui/CodeMuxComposer.tsx`

- [x] **步骤 1：在命令触发项元数据中保存智能体类型**

让 `toTriggerItem` 接收 `agentKind`，并将其写入命令触发项元数据；`groupCommands` 从作曲器当前的 `agentKind` 传入该参数。

- [x] **步骤 2：仅为 Codex 技能构造完整路径**

在 `CODEMUX_FORMATTER.serialize` 中读取命令触发项的 `category`、`filePath` 和 `agentKind`；只有 `category === 'skill'`、`agentKind === 'codex'` 且存在 `filePath` 时，使用 `join(filePath, 'SKILL.md')` 的等价路径拼接结果，否则继续使用命令 ID。

- [x] **步骤 3：运行定向测试并确认 GREEN**

运行：`npx vitest run src/components/agent/assistant-ui/CodeMuxComposer.test.tsx`

预期：所有作曲器测试通过，且 Codex 与 Claude Code 的格式均符合设计。

### 任务 3：执行项目级验证

**文件：**
- 无新增文件。

- [x] **步骤 1：运行相关 slash command 测试**

运行：`npx vitest run src/lib/slashCommands.test.ts src/components/agent/assistant-ui/CodeMuxComposer.test.tsx`

- [x] **步骤 2：运行前端构建**

运行：`npm run build`

- [x] **步骤 3：检查变更范围**

运行：`git diff --check` 与 `git status --short`，确认只包含 Codex 路径修复、回归测试及中文设计/计划文档。