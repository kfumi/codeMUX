# OpenCode 会话删除方案研究

研究日期：2026-08-04

## 结论

OpenCode 会话删除的首选方式是调用 OpenCode 自己的删除入口：

- CLI：`opencode session delete <sessionID>`
- HTTP API：`DELETE /session/:id`
- JavaScript/TypeScript SDK：`client.session.delete({ path: { id: sessionID } })`

不建议外部集成直接打开 `opencode.db` 并手工删除几张表。官方删除入口负责取消相关后台任务、递归删除子会话，并通过 OpenCode 自己的存储与事件层完成清理。直接 SQL 删除容易留下子会话、附属数据或与正在运行的 OpenCode 服务产生并发冲突。

## 官方事实

### CLI 删除会话

官方 CLI 文档将会话删除定义为：

```text
opencode session delete <sessionID>
```

CLI 源码中的 `SessionDeleteCommand` 将命令转发给 `Session.Service.remove(sessionID)`，成功后才输出删除成功信息。CLI 不直接解析或操作 SQLite 表。

来源：

- [OpenCode CLI 文档：session](https://opencode.ai/docs/cli/#session)
- [官方 CLI 源码：packages/opencode/src/cli/cmd/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/session.ts)

### HTTP API 与 SDK

官方服务器 API 提供 `DELETE /session/:id`，语义是“删除会话及其全部数据”；官方 SDK 对应的方法是 `client.session.delete`。

```ts
await client.session.delete({
  path: { id: sessionID },
})
```

来源：

- [OpenCode Server 文档：Sessions](https://opencode.ai/docs/server/#sessions)
- [OpenCode SDK 文档：Sessions](https://opencode.ai/docs/sdk/#sessions)

### 官方删除实现包含子会话递归

当前官方 `Session.Service.remove` 的处理顺序包括：

1. 读取当前会话。
2. 取消当前会话及相关父子会话的后台任务。
3. 查询 `children(sessionID)`。
4. 对每个子会话递归调用 `remove`。
5. 发布删除事件并移除该会话的事件/持久化数据。

因此，删除根会话时，官方入口会处理 `parent_id` 子会话；外部只删除根表行则不具备这个保证。

来源：

- [官方会话服务源码：packages/opencode/src/session/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts)
- [官方 HTTP 会话处理器：packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)

### OpenCode 数据库不只有 `session`

官方 schema 当前包含会话、消息、part、todo、session_message、session_input、context epoch 等数据表。其中多个表通过 foreign key 关联到 `session` 并声明级联删除，但这些级联是否生效依赖数据库连接的 foreign key 设置。`parent_id` 是会话层级关系，官方服务显式递归处理，而不是依赖数据库级联。

来源：

- [官方数据库 schema：packages/core/src/session/sql.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts)
- [官方存储 schema 导出：packages/opencode/src/storage/schema.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/storage/schema.ts)

## 对 CodeMUX 的建议

### 推荐方案：通过现有 OpenCode SDK 服务删除

CodeMUX 已经通过 sidecar 启动并持有 OpenCode SDK 客户端。建议增加一个 sidecar 删除命令，由 sidecar 调用：

```ts
await client.session.delete({ path: { id: openCodeSessionId } })
```

建议流程：

1. 从 CodeMUX 映射表取得 `openCodeSessionId`。
2. 对该会话加生命周期锁，阻止新的 prompt、reset 或恢复操作。
3. 先调用 OpenCode SDK 的 `session.delete`；OpenCode 自己负责取消任务和递归子会话。
4. 删除成功后再删除 CodeMUX 的 `agent_session_mappings`、`sessions` 等本地记录。
5. 若 OpenCode 返回 NotFound，可记录为幂等成功，并清理 CodeMUX 本地映射。
6. 若 OpenCode 返回其他错误，不应先删除 CodeMUX 映射；应保留映射并向用户报告失败。

相比启动 `opencode session delete` 子进程，SDK/API 更适合 CodeMUX：不需要解析终端输出，能复用 sidecar 的服务生命周期和错误处理；相比直接 SQLite，也不会绕过 OpenCode 的后台任务与事件清理。

### 当前 CodeMUX 实现的风险

当前 [opencode_history.rs](../src-tauri/src/agent/opencode_history.rs) 直接打开 OpenCode SQLite，并只删除 `part`、`message`、`session` 三类行。这存在几个问题：

- 不会递归删除 `parent_id` 子会话。
- 没有覆盖 OpenCode 后续新增的会话附属表。
- 直接与运行中的 OpenCode 服务共享数据库，存在锁竞争和删除后重新写入的风险。
- 删除结果 `bool` 在 Tauri 命令层被丢弃，调用方无法区分“实际删除”“没有找到数据库”或“没有找到该 session”。

### 迁移与修复建议

对已有残留数据，建议优先读取 OpenCode 的根会话列表和子会话列表，再逐个调用官方 `DELETE /session/:id` 或 SDK 删除。不要直接对生产数据库执行批量 SQL。

只有在 OpenCode 服务无法启动、必须做灾备修复时，才考虑离线 SQLite 清理。此时应：

- 完全停止 OpenCode/CodeMUX 相关进程并备份 `opencode.db`、`-wal`、`-shm` 文件。
- 开启 `PRAGMA foreign_keys = ON`。
- 递归收集目标 session 的全部子 session。
- 在事务中清理官方 schema 中所有与这些 session 关联的数据。
- 删除后重新运行 `opencode session list` 和数据完整性检查。

这属于恢复手段，不应作为正常产品删除链路。

## 与当前问题的对应关系

`opencode session list` 读取的是 OpenCode 自己的 session 服务/数据库，不是 CodeMUX 的 `sessions` 表。CodeMUX UI 中消失，只能说明 CodeMUX 本地记录被删，不代表 OpenCode 原生会话已经通过官方删除入口完成清理。

如果 CLI 中剩下的是子智能体会话，最可能的原因是 CodeMUX 只删除了根 session；如果剩下的是根 session，则应检查该根 session 是否有 CodeMUX 映射，以及删除时是否走了项目删除、旧版本删除链路或删除 API 失败路径。
