# 智能体供应商档案命令实现计划

> **供自动化执行者使用：** 必须使用测试驱动开发，逐项执行并在每个检查点验证。

**目标：** 为三种智能体档案提供增删改查、激活、模型切换、模型获取和连接测试命令，并保证原生配置事务先于应用配置更新。

**架构：** 命令层负责从配置中解析档案，调用原生配置渲染和事务写入服务，再在事务成功后更新 `agent_profile_registry` 和持久化配置。连接测试与模型请求只在 Rust 端从档案原生配置取得凭据，错误通过统一函数脱敏。

**技术栈：** Tauri 2、Rust、reqwest、现有 `provider_profiles` 原生配置服务。

---

### 任务 1：档案注册表辅助逻辑

**文件：**
- 修改：`src-tauri/src/commands/provider.rs`
- 测试：`src-tauri/src/commands/provider.rs`

- [x] 先为档案更新、激活 ID 校验、删除活动 ID 清理和默认模型校验编写失败单元测试。
- [x] 运行 `cargo test commands::provider::tests`，确认测试因辅助函数不存在而失败。
- [x] 实现最小注册表辅助函数，不涉及文件写入。
- [x] 再次运行相同测试，确认通过。

### 任务 2：原生配置事务与 Tauri 命令

**文件：**
- 修改：`src-tauri/src/commands/provider.rs`
- 修改：`src-tauri/src/lib.rs`
- 测试：`src-tauri/src/commands/provider.rs`

- [x] 先为档案类型到原生目录、原生配置读取和脱敏错误编写失败测试。
- [x] 运行 `cargo test commands::provider::tests`，确认测试失败。
- [x] 接入 `render_native_config` 与 `NativeConfigWriteService`，实现激活和模型切换的“先事务、后配置”路径，并注册命令。
- [x] 再次运行相同测试，确认通过。

### 任务 3：模型获取与连接测试

**文件：**
- 修改：`src-tauri/src/commands/provider.rs`
- 修改：`src-tauri/src/lib.rs`
- 测试：`src-tauri/src/commands/provider.rs`

- [x] 先为三类档案配置到模型请求连接参数的映射和敏感信息脱敏编写失败测试。
- [x] 运行 `cargo test commands::provider::tests`，确认测试失败。
- [x] 实现只按档案 ID 获取模型及连接测试的命令，保留旧统一供应商命令兼容。
- [x] 运行 `cargo test commands::provider::tests`、`cargo fmt --all -- --check` 与 `cargo check --all-targets --all-features`。
