# 项目排序字段与重排接口

**What to build:** `projects` 表新增 `position`，daemon 按它返回项目列表；提供 `POST /api/projects/reorder` 让客户端提交完整顺序。老库升级后按现有展示顺序回填，列表不跳。

**Why:** 当前顺序由 `updated_at` 决定，用户无法固定项目入口；顺序必须由 daemon 持久化，多端才能一致。

## 实现要点

- [ ] `crates/daemon/src/db/schema.rs`
  - 新建 `projects` 表包含 `position INTEGER NOT NULL DEFAULT 0`。
  - 迁移：列不存在时 `ALTER TABLE`，再按 `updated_at DESC, created_at DESC, id ASC` 回填 `0..n-1`。
- [ ] `crates/daemon/src/db/operations.rs`
  - `create_project_with_primary`：新项目 `position = COALESCE(MIN(position), 0) - 1`。
  - `get_all_projects`：`ORDER BY position ASC, updated_at DESC, created_at DESC, id ASC`。
  - 新增 `reorder_projects(conn, ids)`：事务内完整重写 `0..n-1`；忽略不存在的 id；未列出的项目按原顺序追加；不修改 `updated_at`。
- [ ] `crates/daemon/src/companion/server.rs`
  - 注册 `POST /projects/reorder`，body `{ ids: string[] }`，成功 `204`。
  - 复用现有 `authorize`，错误走 `ApiError`。

## 测试

- [ ] 迁移：老库三行项目按 `updated_at` 倒序回填为 0/1/2。
- [ ] 新建项目排在已有项目之前。
- [ ] 重排按 ids 顺序生效；未列出的项目追加在末尾；重复 / 不存在的 id 被忽略。
- [ ] 重排不改变 `updated_at`。
- [ ] `cargo fmt --all -- --check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo check --all-targets --all-features`。
- [ ] `npm run build:daemon` 并重启 daemon 验证。
