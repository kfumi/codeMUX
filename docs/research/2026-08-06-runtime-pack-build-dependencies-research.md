# 托管 SDK Runtime 安装方案

## 结论

CodeMUX 不再构建或发布 Runtime Pack，也不从 CodeMUX GitHub Release 下载 SDK。Runtime 的唯一生产安装路径是：

1. 检测用户本机 Node.js 和 npm；
2. 使用 npm 当前配置的 registry 查询官方包版本；
3. 将 SDK 安装到 `%LOCALAPPDATA%/CodeMUX/runtimes/<provider>/<version>`；
4. 校验安装目录后原子切换 `current` 指针；
5. sidecar 通过 `runtimeRef` 从该目录动态加载 SDK。

npm 默认使用官方 registry `https://registry.npmjs.org`，用户已有的 npm 镜像、代理和认证配置也会自然生效。

## Provider 包映射

| Provider | 主 SDK | 额外包 |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | 平台原生 Claude CLI 依赖由 npm optional dependency 安装 |
| Codex | `@openai/codex`（CLI，app-server 传输） | 无 |
| OpenCode | `@opencode-ai/sdk` | `opencode-ai`，保留官方 postinstall 生成平台 CLI |

安装时使用确切版本和 `--include=optional`，避免版本漂移并保留平台原生依赖。

## 为什么 Runtime 仍然需要 node_modules

这里的 `node_modules` 是用户 Runtime 目录中的运行时依赖，不是 sidecar 的构建依赖，也不会自动打进桌面安装包。SDK 的入口、传递依赖、optional platform package 和 OpenCode CLI 都依赖 Node.js 模块解析规则，因此不能只复制一个 SDK 文件。

sidecar 自身不再声明三个 Provider 的运行时 SDK 依赖；它只保留类型声明和动态加载逻辑。这样安装包体积不会包含用户未选择的 SDK，Runtime 也能独立升级和回滚。

## 生命周期与失败保护

目录结构保持稳定：

```text
%LOCALAPPDATA%/CodeMUX/runtimes/
└── <provider>/
    ├── current
    └── <version>/
        ├── package.json
        ├── package-lock.json
        └── node_modules/
```

安装先写入同盘临时目录。npm 失败、完整性校验失败或版本切换失败时，临时目录会清理，旧 Runtime 和 `current` 指针保持不变。已经存在的旧 Runtime Pack 不会被主动删除，仍可由兼容的本地解析逻辑继续使用。

## 发布流程

桌面发布工作流只构建 Tauri 应用，不再执行 Runtime Pack 构建、签名、归档或 Release Asset 上传。SDK 版本由运行时设置页通过 npm registry 查询，用户可以选择任意已发布的稳定 semver 版本安装。
