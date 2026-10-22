# `projects.path` 删除，主根只存在于 `project_roots`

项目从单一路径改为多根集合后，`projects.path` 不再保留。迁移把每个项目的 `path` 写入 `project_roots`（`position=0, is_primary=1`），随后 `ALTER TABLE projects DROP COLUMN path`。

**为什么不保留冗余列：** `path` 被 Git 面板、文件树、`@` 提及、项目 Skill 扫描、导入会话匹配等二十余处当作“项目目录”读取。保留一列与 roots 表并存的“主根副本”，等于制造两个真相源；这类一致性迟早会在某个读点破掉，而破掉时的表现是静默的错误路径，不是崩溃。

**为什么不改成 `legacy_path`：** 改名只降低误读概率，不消除它。未来读代码的人（包括 AI agent）看到一列仍在表里、仍被填充，就会假设它有语义。

**已验证的前提：** daemon 使用 `rusqlite 0.31` 的 `bundled` 特性（SQLite ≥ 3.45），且代码库已有 `ALTER TABLE ... DROP COLUMN` 先例（`crates/daemon/src/db/schema.rs:383`）。

**顺带修掉的既有缺陷：** 删列迫使两处 `resolve_session_cwd` 合并——`companion/actions.rs` 那份只读 `projects.path` 的实现忽略了 `sessions.working_path`，导致 worktree 会话在首发与移动端刷新路径上拿到项目主根而非 worktree 路径。合并后统一为 `session_sources.cwd`（imported）→ `working_path` → 主根 → home。
