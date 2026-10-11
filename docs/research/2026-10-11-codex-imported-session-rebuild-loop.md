# 导入的 Codex 会话「原生会话已重建」死循环与「未找到任务路径」根因排查

**触发**：用户报告导入的 codex 会话（`99e8c39a-eb5f-45aa-9f52-110b3c88af0f`）点「复制任务路径」报「未找到任务路径」，且每次打开都会往时间线加一条「Codex 原生会话恢复失败，已重建会话」。

## 结论

不是导入操作的问题。导入（`origin=imported`）按设计把会话绑到原始 rollout 上；随后**打开会话**时 codex 拒绝 `thread/resume`（原线程被 Codex 桌面端持有写锁），而 sidecar 的重建兜底把这次**临时冲突**当成「原生会话消失」，mint 新 thread 并替换 `agent_session_mappings`。mint 出来的 thread 在首个 rollout 落盘前无法被下一个 app-server 进程 resume，于是每次打开都再重建一次；映射最终指向一个**没有任何 rollout 文件的幽灵线程 id**，daemon 解析不出 `messagePath`，前端就报「未找到任务路径」。

## 实机证据（2026-10-11）

数据库 `%APPDATA%\com.codemux.desktop\codemux.db`：

| 位置 | 值 |
|---|---|
| `sessions` | `agent_kind=codex`、`origin=imported`、`created_at=2026-10-11T04:52:31Z` |
| `session_sources` | `agent_session_id=01a1294b-5ddc-7b12-97fc-cbdbe73e6e8c`、`source_locator=…\.codex\sessions\2026\10\11\rollout-2026-10-11T12-49-27-01a1294b-….jsonl`、`imported_at=07:56:42Z` |
| `agent_session_mappings` | `agent_session_id=01a129fe-6dcd-7840-a69e-cf3d2cdfdca8`（幽灵）、`updated_at=08:05:02Z` |

- 幽灵 id 的 UUIDv7 时间戳 = `08:05:02Z`，与 mapping 的 `updated_at` 同秒：它就是那一刻 `thread/start` mint 出来的。
- `~\.codex` 下找不到任何 `01a129fe…` 的 rollout（只剩 `thread-writer-locks\01a129fe….lock`）；codex 自己的 `state_5.sqlite.threads`、`thread_history_1.sqlite` 里也没有这条线程。
- 原线程 `01a1294b…`：rollout 文件存在，首行 `session_meta.payload.id` 吻合，`threads` 表 1 行、8 turns / 662 items。

`session_event_snapshots` 里的 4 次 `native_session_rebuilt`（均在导入之后）：

| 时间 | previous → new | reason |
|---|---|---|
| 07:56:47Z | `01a1294b` → `01a129f6` | `thread/resume failed: thread 01a1294b-… already has an active writer` |
| 08:03:44Z | `01a129f6` → `01a129fd` | `no rollout found for thread id 01a129f6-…` |
| 08:04:57Z | `01a129fd` → `01a129fe-587d` | `no rollout found for thread id 01a129fd-…` |
| 08:05:02Z | `01a129fe-587d` → `01a129fe-6dcd` | `no rollout found for thread id 01a129fe-587d-…` |

`daemon.log` 原文（15:56:47）：

```
[codex-app-server][stderr] ERROR codex_core::session::session: failed to initialize thread persistence:
  thread-store conflict: thread 01a1294b-5ddc-7b12-97fc-cbdbe73e6e8c already has an active writer
```

占用者：`codex.exe` PID 41484（Codex 桌面端 app-server，15:51:06 启动，持 `thread-writer-locks\01a1294b-….lock`）。

## 代码链路

1. `apps/sidecar/src/codexAppServerRuntime.ts` `startOrResumeThread`：`thread/resume` 一失败（不分原因）就 `thread/start` + 之后 emit `agent_session_mapping`。
2. `resolve_agent_session_info` / `get_agent_session_info_for_companion`（`crates/daemon/src/agent/session_lifecycle.rs`）：按 mapping 调 `find_codex_session_jsonl`，找不到 rollout → `messagePath=null`；**只有 mapping 缺失**时才会回落到 `session_sources.source_locator`。
3. `SessionHeader.copyText`（`src/components/layout/SessionHeader.tsx`）：`messagePath` 为空 → `toast.error('未找到任务路径')`。

## 处置

见 `docs/adr/0010-codex-app-server-transport.md` 的 2026-10-11 修订节：归属冲突（`active writer`）改为有限重试后报错、不重建不改绑；原生会话消失仍 mint 兜底但不再替换 mapping；`native_session_rebuilt` 提示按 (previous id, reason) 去重。

遗留：**已被污染的历史映射不在代码修复范围内**（本次未改数据）——存量幽灵绑定的会话仍需重建绑定/重新导入，或由 daemon 侧在解析不出 rollout 时回落到 `session_sources.source_locator` 兜底。
