# 贡献指南

感谢你对 codeMUX 项目的关注！我们欢迎各种形式的贡献。

## 如何参与贡献

### 报告问题

使用 [GitHub Issues](https://github.com/vzi777/codeMUX/issues) 报告 Bug 或提出功能建议。

**Bug 报告**请包含：

- 操作系统和版本（如 Windows 11 23H2、macOS 15.0、Ubuntu 24.04）
- Node.js 版本（`node --version`）
- Rust 版本（`rustc --version`）
- 问题复现步骤
- 预期行为与实际行为
- 相关日志或截图

**功能建议**请包含：

- 使用场景描述
- 期望的交互方式
- 是否愿意参与实现

### 提交代码

1. **Fork** 本仓库到你的 GitHub 账号
2. **克隆** 你的 Fork：
   ```bash
   git clone https://github.com/vzi777/codeMUX.git
   cd codeMUX
   ```
3. **创建分支**：
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **安装依赖**：
   ```bash
   npm install
   cd src-tauri/sidecar && npm install && npm run build && cd ../..
   ```
5. **开发与测试**：
   ```bash
   npm run tauri dev
   ```
6. **提交修改**：
   ```bash
   git add .
   git commit -m "feat: your feature description"
   ```
7. **推送并创建 PR**：
   ```bash
   git push origin feature/your-feature-name
   ```

## Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Type 类型

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响逻辑，如空格、分号等） |
| `refactor` | 重构（既不修复 Bug 也不添加功能） |
| `perf` | 性能优化 |
| `test` | 添加或修改测试 |
| `chore` | 构建流程、工具链变动 |
| `ci` | CI 配置变动 |
| `revert` | 回滚提交 |

### Scope 范围（可选）

常用范围：`agent`、`mcp`、`skills`、`ui`、`store`、`db`、`sidecar`、`config`

### 示例

```
feat(mcp): add SSE transport support
fix(agent): prevent sidecar crash on empty response
docs(readme): add macOS setup instructions
refactor(store): simplify session state management
chore(deps): bump tauri to 2.1.0
```

## 代码规范

### Rust

- 使用 `cargo fmt` 格式化代码
- 使用 `cargo clippy` 检查 lint
- 提交前确保 `cargo build` 无错误

### TypeScript / React

- 遵循项目 ESLint 配置
- 组件使用函数式组件 + Hooks
- 状态管理使用 Zustand
- 样式使用 Tailwind CSS，避免自定义 CSS

### 通用

- 保持代码简洁，避免不必要的注释
- 变量和函数命名清晰明了
- 新功能请附带相关文档更新

## 项目结构速览

```
src/                    # React 前端
  components/agent/     # Agent 对话面板
  components/settings/  # 设置页面
  stores/               # Zustand 状态
  types/                # TypeScript 类型
  lib/                  # 工具函数

src-tauri/              # Rust 后端
  src/commands/         # Tauri 命令处理器
  src/mcp/              # MCP 管理
  src/skills/           # Skills 管理
  sidecar/              # Node.js Agent Sidecar
```

## 设计文档

项目的详细设计文档位于 `docs/superpowers/specs/` 目录，阅读这些文档有助于理解架构决策：

- `2026-05-27-ai-codeMUX-design.md` — 项目整体设计
- `2026-05-28-claude-agent-sdk-integration-design.md` — Claude Agent SDK 集成设计
- `2026-06-04-mcp-management-design.md` — MCP 管理设计
- `2026-06-06-skills-management-design.md` — Skills 系统设计

## Pull Request 检查清单

提交 PR 前请确认：

- [ ] 代码已通过 `cargo fmt` 和 `cargo clippy`（Rust 部分）
- [ ] 代码已通过 TypeScript 类型检查（`npm run build`）
- [ ] 功能在开发模式下测试通过（`npm run tauri dev`）
- [ ] 新功能已更新相关文档
- [ ] Commit 消息符合 Conventional Commits 规范
- [ ] PR 描述清晰说明了修改内容和原因

## 行为准则

- 尊重每一位参与者
- 建设性地提出意见和建议
- 聚焦于技术讨论，避免人身攻击
- 欢迎不同背景和经验水平的贡献者

## 有问题？

如有任何疑问，欢迎在 [GitHub Discussions](https://github.com/vzi777/codeMUX/discussions) 中提问。

---

再次感谢你的贡献！🎉
