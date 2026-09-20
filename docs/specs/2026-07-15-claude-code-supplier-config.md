# Claude Code 供应商配置重构设计

## 背景与目标

将 Claude Code 的供应商管理改为以供应商为中心的配置体验，并使其原生配置与 `~/.claude/settings.json` 的使用方式符合下列规则：默认供应商直接使用用户原有配置；已保存供应商通过合并配置切换；从默认切出时保存可恢复的 `.bak` 备份。

本设计只改变 Claude Code 供应商页与对应后端配置行为。Codex、OpenCode、会话快照和对话运行时的供应商解析保持现有边界。

## 界面与字段

- 所有面向用户的“档案”统一改为“供应商”。
- Claude Code 供应商列表的首项是固定“默认供应商”卡片，不可编辑、不可删除。
- 编辑表单中，“名称”和“备注”同一行；备注替代原“说明”。
- API Key 下方显示 URL。
- 删除“清除已保存的 API Key”和“清除已保存的高级配置”控制项。
- 编辑已有供应商时，配置 JSON 直接回显真实 `ANTHROPIC_AUTH_TOKEN`。该授权仅适用于设置页读取与编辑，不改变对话启动时由后端解析凭据的设计。

## 模型映射

原“模型列表”和全局“1M 上下文”改为固定四行映射表：Sonnet、Opus、Fable、Haiku。

每行包含：模型角色、显示名称、实际请求模型。Sonnet、Opus、Fable 有独立的“声明支持 1M”勾选项；Haiku 的对应列保持空白，不显示控件或提示。表格下方提供默认兜底模型。

实际请求模型用于 Claude Code 上游请求，显示名称仅用于 Claude Code 的 `/model` 菜单。

`env` 映射规则如下：

- URL 映射为 `ANTHROPIC_BASE_URL`。
- API Key 映射为 `ANTHROPIC_AUTH_TOKEN`。
- 默认兜底模型映射为 `ANTHROPIC_MODEL`。
- Haiku 实际请求模型映射为 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。
- Sonnet、Opus、Fable 实际请求模型分别映射为 `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`。勾选 1M 时，值追加 `[1M]`。
- Sonnet、Opus、Fable 显示名称分别映射为 `ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`、`ANTHROPIC_DEFAULT_OPUS_MODEL_NAME`、`ANTHROPIC_DEFAULT_FABLE_MODEL_NAME`。

## 配置 JSON

新建供应商的 JSON 初始值为：

```json
{
  "env": {},
  "theme": "auto",
  "includeCoAuthoredBy": false,
  "autoUpdatesChannel": "latest"
}
```

JSON 编辑器与表单双向同步：修改表单会更新相关 `env` 键；输入合法 JSON 后会回填表单。`env` 不是对象、JSON 语法错误或映射字段类型无效时禁止保存并显示原因。配置中的未知字段不丢失。

## 默认供应商与原生文件切换

默认供应商没有独立的已保存配置。它表示直接使用 `~/.claude/settings.json`。

1. 激活默认供应商时，若当前为已保存供应商，使用 `~/.claude/settings.json.bak` 的内容原子恢复 `~/.claude/settings.json`，并保留 `.bak` 文件。若 `.bak` 不存在或恢复失败，保留当前文件并返回错误。
2. 从默认供应商切到任一已保存供应商时，无论 `.bak` 是否存在，都将当前 `settings.json` 的完整原始内容覆盖保存为 `.bak`；成功后再切换目标供应商配置。
3. 在已保存供应商之间切换时，不改写 `.bak`。
4. 切到已保存供应商时读取当前 `settings.json`，将目标供应商配置递归合并进去，而不是完整替换文件。对象按键深度合并；标量、数组或类型不同的同名节点以目标供应商为准；目标配置不存在的当前节点保留。
5. 保存或编辑未激活供应商只更新应用内部配置，不触碰 `settings.json`。激活供应商的模型切换才会依照上述规则同步原生文件。

文件备份、恢复与应用配置状态更新必须在同一后端事务内执行。任一步失败时，不提交供应商选择状态，并尽可能恢复已变更的原生文件。

## 迁移与兼容性

旧 Claude Code 供应商迁移为四角色模型映射：旧默认模型填入默认兜底模型及四个角色的实际请求模型；旧 1M 设置迁移到 Sonnet、Opus、Fable 的声明值。升级后 Claude Code 默认选中“默认供应商”，不立即改写用户现有 `settings.json`。

## 验证

- 前端测试覆盖术语、固定默认卡片、表单与 JSON 双向同步、Haiku 无 1M 控件、真实令牌回显和 JSON 校验。
- 后端测试覆盖 `.bak` 每次从默认切出时覆盖写入、供应商之间切换不改 `.bak`、恢复后保留 `.bak`、递归合并、恢复/写入失败回滚、未激活供应商保存不写原生文件和旧配置迁移。
- 执行前端构建与 Vitest，Rust 格式化、Clippy、编译与相关单元测试。
