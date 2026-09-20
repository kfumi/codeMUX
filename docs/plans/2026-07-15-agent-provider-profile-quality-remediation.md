# 智能体供应商档案质量修复实施计划

> **供自动化执行者使用：** 必须使用测试驱动开发，逐项执行并在每个检查点验证。

**目标：** 使应用配置落盘、空模型档案、档案更新凭据语义及原生配置事务备份均具备可验证的故障安全行为。

**架构：** `config` 使用可注入文件操作的同目录临时文件写入、同步和替换流程，避免失败时破坏旧配置。命令层以专用上行 DTO 表达机密字段的保留与清除，并仅激活含默认模型的档案。原生配置事务在应用配置成功提交后清理其补偿备份。

**技术栈：** Rust、Tauri 2、serde、现有 `NativeConfigWriteService`。

---

### 任务 1：应用配置原子写入

**文件：**
- 修改：`src-tauri/src/config/mod.rs`
- 测试：`src-tauri/src/config/mod.rs`

- [ ] **步骤 1：编写失败测试。** 使用可注入的替换失败文件操作，先写入旧 `config.json`，调用保存后断言返回错误且旧字节不变。
- [ ] **步骤 2：运行失败测试。** 运行 `cargo test config::tests::配置保存替换失败时保留原文件`，预期因现有直接写入会覆盖旧文件而失败。
- [ ] **步骤 3：实现最小原子写入。** 在目标目录创建唯一临时文件，写入、`flush`、`sync_all` 后以平台原子替换提交；Unix 同步父目录，Windows 使用写穿透替换；任一步失败删除临时文件。
- [ ] **步骤 4：运行测试。** 运行相同测试，预期通过。

### 任务 2：空模型档案的保存、激活和渲染

**文件：**
- 修改：`src-tauri/src/commands/provider.rs`
- 修改：`src-tauri/src/provider_profiles/native_config.rs`
- 测试：上述文件内测试模块

- [ ] **步骤 1：编写失败测试。** 验证空模型且空默认模型的档案可更新，但激活拒绝；并验证三种原生渲染均保留既有模型字段而不写入空字符串。
- [ ] **步骤 2：运行失败测试。** 分别运行 `cargo test commands::provider::tests::空默认模型档案不可激活` 与 `cargo test provider_profiles::native_config::tests::空默认模型不会渲染模型字段`，预期失败。
- [ ] **步骤 3：实现最小校验和条件渲染。** 激活前验证 `default_model.trim()` 非空；传入渲染器的默认模型使用 `trim` 过滤的 `Option`。
- [ ] **步骤 4：运行测试。** 运行上述两个测试，预期通过。

### 任务 3：上行档案 DTO 的机密字段补丁语义

**文件：**
- 修改：`src-tauri/src/commands/provider.rs`
- 测试：`src-tauri/src/commands/provider.rs`

- [ ] **步骤 1：编写失败测试。** 反序列化未提供、空字符串和 `null` 的 API Key 与高级配置补丁，并验证未提供/脱敏空值保留既有机密、显式清除移除既有值。
- [ ] **步骤 2：运行失败测试。** 运行 `cargo test commands::provider::tests::档案更新DTO区分保留与清除机密字段`，预期失败。
- [ ] **步骤 3：实现专用 DTO。** 用 `Option<Option<T>>`（并把空 API Key 规范为保留）表示字段未提供、明确清除和新值；先合并既有档案再执行既有校验和事务。
- [ ] **步骤 4：运行测试。** 运行相同测试，预期通过。

### 任务 4：成功事务备份清理

**文件：**
- 修改：`src-tauri/src/provider_profiles/service.rs`
- 修改：`src-tauri/src/commands/provider.rs`
- 测试：上述文件内测试模块

- [ ] **步骤 1：编写失败测试。** 成功写入后调用安全丢弃接口，断言会话目录不存在；命令提交辅助函数在保存成功后触发清理。
- [ ] **步骤 2：运行失败测试。** 运行 `cargo test provider_profiles::service::tests::成功事务可安全删除备份会话` 和 `cargo test commands::provider::tests::保存成功后清理原生配置事务备份`，预期失败。
- [ ] **步骤 3：实现最小清理。** 仅允许删除备份根目录直属 UUID 会话，在锁保护下安全递归删除并同步父目录；应用配置保存成功后调用清理。
- [ ] **步骤 4：运行测试。** 运行上述两个测试，预期通过。

### 任务 5：综合验证

**文件：**
- 验证：`src-tauri/src/config/mod.rs`
- 验证：`src-tauri/src/commands/provider.rs`
- 验证：`src-tauri/src/provider_profiles/{service,native_config}.rs`

- [ ] **步骤 1：格式化。** 运行 `cargo fmt --all -- --check`；若失败，仅运行 `cargo fmt --all` 后重新检查。
- [ ] **步骤 2：运行相关测试。** 运行 `cargo test config::tests`、`cargo test commands::provider::tests`、`cargo test provider_profiles`。
- [ ] **步骤 3：编译检查。** 运行 `cargo check --all-targets --all-features`。
- [ ] **步骤 4：提交。** 仅暂存本计划涉及的源码与文档，使用中文 Conventional Commit 提交。
