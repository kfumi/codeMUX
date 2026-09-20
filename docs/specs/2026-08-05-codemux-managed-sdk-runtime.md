# CodeMUX 托管 SDK Runtime 规格

## 背景

Claude、Codex 和 OpenCode 的 SDK 不应随 sidecar 或桌面安装包发布，也不应从 CodeMUX 自己的 GitHub Release 获取。SDK 版本由官方 npm registry 管理，CodeMUX 只负责将用户选择的版本安装到自己的 Runtime 目录并在 sidecar 中动态加载。

## 目标

- 主安装包不包含 Provider SDK、传递依赖和平台 CLI 二进制。
- 用户可以在设置页查看 npm 返回的全部稳定 semver 版本，并指定版本安装。
- SDK 安装与用户全局 CLI 解耦，不执行 `npm install -g`。
- 安装、升级和修复具备版本隔离、完整性校验、原子切换和失败回滚能力。
- sidecar 只能从 Rust 传入的托管 Runtime 路径动态加载 SDK。

## npm 包映射

| Provider | npm 包 |
| --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` |
| Codex | `@openai/codex-sdk` |
| OpenCode | `@opencode-ai/sdk` 与 `opencode-ai` |

安装由本机 Node.js/npm 执行，默认使用 npm 的官方 registry 配置，同时兼容用户的镜像、代理和认证配置。安装参数使用确切版本、`--include=optional`、`--no-audit` 和 `--no-fund`；OpenCode 保留官方 postinstall。

## 目录与生命周期

```text
%LOCALAPPDATA%/CodeMUX/runtimes/
└── <provider>/
    ├── current
    └── <version>/
        ├── package.json
        ├── package-lock.json
        └── node_modules/
```

Runtime Manager 为每个 Provider 维护独立锁。安装先创建同盘临时目录，npm 安装和完整性校验通过后，再原子替换目标版本目录并原子更新 `current`。失败时删除临时目录，旧版本和当前指针保持可用。已经存在的旧 Runtime 不主动删除。

完整性检查至少确认：

- 根目录 `package.json`；
- 主 SDK 的 `package.json` 及精确版本；
- Claude 平台 CLI（如有）；
- OpenCode CLI 二进制；
- Runtime 的 `node_modules` 结构。

`package-lock.json` 是 npm 安装产物，但不是旧 Runtime 兼容性检查的硬性条件。

## 前端和命令

保持现有 Tauri 命令名称不变：

- `check_managed_runtimes`：读取本地状态，并尽力查询 npm 最新版本和版本列表；网络失败时仍展示本地状态。
- `install_managed_runtime(provider, version)`：缺省安装最新版本，传入版本时安装用户选定的确切版本。
- `upgrade_managed_runtime`：安装 npm 最新版本。
- `repair_managed_runtime`：当前 Runtime 损坏时按当前版本重新安装。

设置页显示“查询 npm 版本”“执行 npm 安装”“校验 SDK 包”等进度，并将 npm、Node.js、平台依赖和 CLI 缺失错误直接展示给用户。

## 发布边界

发布工作流只构建桌面应用和 sidecar，不构建、签名、压缩或上传 Runtime Pack。Runtime Pack 构建脚本、独立 SDK 来源目录、GitHub manifest 查询和 Pack 下载器均不属于当前生产代码。

## 验证

- Rust：`cargo check --all-targets`、`cargo test runtime::`
- sidecar：`npm run build`
- 前端：`npx vitest run`、`npm run build`
- 重点回归：包映射、版本列表、指定版本、OpenCode 双包、npm 失败回滚、离线本地状态和 sidecar 显式路径加载。
