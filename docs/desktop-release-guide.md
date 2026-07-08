# CodeMUX 桌面端发版指南

本文档用于说明如何在私有源码仓库中构建 CodeMUX 安装包，并自动发布到公开下载仓库 `kfumi/codeMUX-desktop` 的 GitHub Releases。

## 当前发布链路

- 私有源码仓库负责构建 Tauri 桌面端安装包。
- 推送版本标签后，GitHub Actions 会自动触发 [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)。
- 构建产物会自动上传到公开仓库 `kfumi/codeMUX-desktop` 的 Releases 页面。
- 正式发布当前仅包含 Windows 和 macOS，暂不发布 Ubuntu 安装包。

## 前置条件

- 私有源码仓库已配置 GitHub Secret: `DESKTOP_RELEASE_TOKEN`
- 该 Token 对公开仓库 `kfumi/codeMUX-desktop` 具有 `Contents: Read and write` 权限

## Updater 签名配置

当前 [`src-tauri/tauri.conf.json`](/D:/project/ai-code/codeMUX/src-tauri/tauri.conf.json:1) 中的 `pubkey` 仍然是占位值，正式发版前必须替换为真实的 updater 公钥；否则自动更新元数据虽然会被生成，但客户端无法正确校验签名。

### 1. 生成 updater 密钥对

先在本机生成专用于 updater 的密钥文件：

```bash
npm run tauri signer generate -- -w ~/.tauri/codemux-updater.key
```

执行后，Tauri signer 会在 `~/.tauri/codemux-updater.key` 写入私钥，并在终端输出对应的公钥内容。建议把这次输出保存下来，后面需要写回配置文件。

### 2. 为私钥设置密码

上面的命令会提示输入私钥密码。这里输入的密码就是后续发布时用于解锁私钥的值，建议使用单独的高强度密码并妥善保存。

私钥文件不要提交到仓库。

首次正式发版前，如果确认还没有任何客户端基于当前 updater 公钥发布过，可以重新执行同一条命令生成新的密钥对；一旦已有客户端发布，不要随意轮换 updater 密钥，否则旧客户端将无法校验后续更新。

### 3. 把真实公钥写入 `tauri.conf.json`

打开 [`src-tauri/tauri.conf.json`](/D:/project/ai-code/codeMUX/src-tauri/tauri.conf.json:1)，将 updater 配置中的占位 `pubkey` 替换为刚才生成时输出的真实公钥。提交前确认没有多余空格、换行或截断。

### 4. 配置 GitHub Secrets

在私有源码仓库的 GitHub Actions Secrets 中新增以下两个 Secret：

- `TAURI_SIGNING_PRIVATE_KEY`：填写 `~/.tauri/codemux-updater.key` 文件中的完整私钥内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：填写生成私钥时设置的密码

保留现有的 `DESKTOP_RELEASE_TOKEN`，它负责把构建产物发布到公开仓库；新增的这两个 Secret 负责让 Tauri 在 CI 中为 updater 产物签名。

### 5. 发布产物说明

当前 release workflow 中的 Tauri 发布步骤会读取上述 Secrets，并在 `createUpdaterArtifacts` 开启的前提下生成 updater 相关产物，包括：

- `latest.json`
- 安装包对应的签名产物

这些产物会和安装包一起发布到公开仓库：

- [kfumi/codeMUX-desktop Releases](https://github.com/kfumi/codeMUX-desktop/releases)

## 发版步骤

### 一键发版

推荐直接使用一键发版脚本：

```bash
npm run release:ship -- 0.0.7
```

这条命令会自动完成以下步骤：

- 同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的版本号
- 提交版本变更
- 创建 `v0.0.7` 标签
- 推送 `master` 分支
- 推送版本标签，触发 GitHub Actions 发版

执行前要求：

- 当前分支必须是 `master`
- 工作区必须是干净状态

如果只想预览脚本会做什么而不真正提交推送，可以执行：

```bash
npm run release:ship -- 0.0.7 --dry-run
```

### 1. 同步版本号

执行下面命令，把以下三个文件的版本号同步为目标版本：

- [`package.json`](/D:/project/ai-code/codeMUX/package.json:1)
- [`src-tauri/tauri.conf.json`](/D:/project/ai-code/codeMUX/src-tauri/tauri.conf.json:1)
- [`src-tauri/Cargo.toml`](/D:/project/ai-code/codeMUX/src-tauri/Cargo.toml:1)

```bash
npm run release:prepare -- 0.0.7
```

如果希望在同步版本号时顺手创建 Git tag，可以执行：

```bash
npm run release:prepare -- 0.0.7 --tag
```

### 2. 提交版本变更

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git add src-tauri/Cargo.lock
git commit -m "chore(release): 发布 v0.0.7"
```

如果上一步没有带 `--tag`，这里手动创建标签：

```bash
git tag v0.0.7
```

### 3. 推送代码和标签

当前仓库主分支为 `master`，推送时执行：

```bash
git push origin master
git push origin v0.0.7
```

### 4. 等待自动发布

标签推送后，GitHub Actions 会在私有仓库中执行构建，并把安装包发布到：

- [kfumi/codeMUX-desktop Releases](https://github.com/kfumi/codeMUX-desktop/releases)

## 工作流说明

- [`.github/workflows/ci.yml`](/D:/project/ai-code/codeMUX/.github/workflows/ci.yml:1)
  用于日常 CI 校验和构建，不负责正式发布。
- [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)
  仅在推送 `v*.*.*` 标签或手动触发时执行，先确保公开仓库的 Release 存在，再并行上传 Windows 和 macOS 产物。

## 常见问题

### Release 没有创建成功

优先检查：

- `DESKTOP_RELEASE_TOKEN` 是否配置在私有源码仓库
- Token 是否对 `kfumi/codeMUX-desktop` 具备写入权限
- `release.yml` 中用于创建公开 Release 的目标分支是否正确，目前配置为 `master`

### 构建成功但没有看到附件

优先检查目标仓库对应版本标签的 Release 页面，以及 GitHub Actions 日志中 `tauri-action` 的上传步骤是否报错。

### 为什么没有 Ubuntu 安装包

当前 workflow 已暂时移除 Ubuntu 发布，原因是 Linux 的 AppImage 打包经常在 `linuxdeploy` 阶段失败。为了保证正式发版稳定性，现在只发布 Windows 和 macOS。后续如果需要恢复 Linux 发布，可以单独再补 Linux 专用工作流或仅保留 `deb/rpm` 目标。
