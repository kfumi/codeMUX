# 智能体供应商使用说明

## 概览

设置页按 Claude Code、Codex、OpenCode 分标签管理供应商。新建或编辑 Claude Code 供应商时，名称和备注位于同一行；配置由模型映射表和完整 JSON 共同维护。

## Claude Code 默认供应商

Claude Code 标签页的“默认供应商”不可编辑、不可删除，直接使用 `~/.claude/settings.json`。

- 从默认供应商切到已保存供应商时，会先将当前 `settings.json` 覆盖备份为 `settings.json.bak`。
- 已保存供应商之间切换不会改写 `.bak`。
- 切回默认供应商时，会用 `.bak` 恢复 `settings.json`，并保留 `.bak` 文件。
- 已保存供应商配置会递归合并到当前 `settings.json`：对象按键合并，标量、数组和类型不同的同名节点以供应商配置为准，供应商未提供的当前键保持不变。

编辑 Claude Code 供应商只保存 CodeMUX 内部配置，不会立即改写 `settings.json`；只有切换供应商才会同步原生文件。

## Claude 配置 JSON

新建 Claude Code 供应商的默认 JSON 是：

```json
{
  "env": {},
  "theme": "auto",
  "includeCoAuthoredBy": false,
  "autoUpdatesChannel": "latest"
}
```

表单和 JSON 双向同步。API Key 写入 `ANTHROPIC_AUTH_TOKEN`，URL 写入 `ANTHROPIC_BASE_URL`，默认兜底模型写入 `ANTHROPIC_MODEL`。Sonnet、Opus、Fable 可以独立声明 1M，保存时会在对应模型值后加 `[1M]`；Haiku 没有 1M 声明项。

为便于直接维护原生配置，Claude Code JSON 会回显真实令牌。该令牌仅用于设置页配置读取与编辑；对话启动仍由 Rust 后端根据会话快照或默认本机配置解析，不由 Webview 传递给运行时。

## 对话与会话

新建对话先确定智能体。Claude Code 没有活动已保存供应商时可直接发送，CLI 会读取本机默认 `settings.json`，不会注入供应商 URL、模型或密钥。已保存供应商的切换只影响之后新建或重新启动的会话，运行中的会话不会热更新。

Codex 和 OpenCode 继续使用各自供应商的模型和密钥配置；这两类已保存密钥不会回显。
