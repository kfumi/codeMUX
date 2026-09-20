# 08 — `~/.pi` 存量会话导入（二期）

**What to build:** 用户原生 pi CLI 的存量会话导入：按现有按 kind 历史导入模式追加 pi 发现分支，扫描原生会话目录（解析规则对齐 pi 自身：`PI_CODING_AGENT_SESSION_DIR` env → `<agentDir>/settings.json` 的 `sessionDir` → `<agentDir>/sessions`，agentDir 为 `PI_CODING_AGENT_DIR` env → `~/.pi/agent`，相对路径依赖 pi 进程 cwd 故跳过走默认）。严格校验 `type:"session"` 头；pi 会话文件是 `id`/`parentId` 树（`/tree` 分支），只取活动叶子到根的链（断链/成环回退全量线性）；mapping 存会话文件绝对路径，复用 `--session <file>` 恢复语义，导入冲突/去重走既有 DB 通道。

**Blocked by:** 05、07

**Status:** done

- [x] `discover_pi` 发现分支接入 `discover_all`；导入对话框经既有 kind 无关通道自动出现 pi 候选（前端零改动）
- [x] 原生会话目录解析（env/settings/默认三级优先，`~` 展开；纯函数单测覆盖优先级与回退）
- [x] 严格 `type:"session"` 头校验，非会话 JSONL 跳过（宁漏勿错）
- [x] 树形会话活动分支链选取（线性文件透传；断链/成环回退线性，宁可交错不丢条目）
- [x] `compaction` 文件条目映射 `compact_boundary`（勘误 2026-09-03：`compaction_start/end` 只是运行时事件不落盘，此前仅处理 `compaction_end` 导致重开压缩边界丢失——托管会话同步受益）
- [x] mapping 存会话文件绝对路径；继续导入会话时 `--session <path>` 追加原文件，与其他 kind 的导入续聊语义一致
- [x] 单测：发现（含外流 JSONL 跳过、cwd 注入、标题）、链选取、断链回退、compaction 条目、目录解析；cargo test --lib 444 全绿，触碰文件 clippy 零告警
