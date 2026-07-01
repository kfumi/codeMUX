# codeMUX 桌面端发版指南

本文档用于说明如何在私有源码仓库中构建安装包，并自动发布到公开下载仓库 `kfumi/codeMUX-desktop` 的 GitHub Releases。

## 当前发布链路

- 私有源码仓库负责构建 Tauri 桌面端安装包。
- 推送版本标签后，GitHub Actions 会自动触发 [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)。
- 构建产物会自动上传到公开仓库 `kfumi/codeMUX-desktop` 的 Releases 页面。

## 前置条件

- 私有源码仓库已配置 GitHub Secret: `DESKTOP_RELEASE_TOKEN`
- 该 Token 对公开仓库 `kfumi/codeMUX-desktop` 具有 `Contents: Read and write` 权限

## 发版步骤

### 1. 同步版本号

执行下面命令，把以下三个文件的版本号同步为目标版本：

- [`package.json`](/D:/project/ai-code/codeMUX/package.json:1)
- [`src-tauri/tauri.conf.json`](/D:/project/ai-code/codeMUX/src-tauri/tauri.conf.json:1)
- [`src-tauri/Cargo.toml`](/D:/project/ai-code/codeMUX/src-tauri/Cargo.toml:1)

```bash
npm run release:prepare -- 0.0.2
```

如果希望在同步版本号时顺手创建 Git tag，可以执行：

```bash
npm run release:prepare -- 0.0.2 --tag
```

### 2. 提交版本变更

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore(release): 发布 v0.0.2"
```

如果上一步没有带 `--tag`，这里手动创建标签：

```bash
git tag v0.0.2
```

### 3. 推送代码和标签

```bash
git push origin main
git push origin v0.0.2
```

### 4. 等待自动发布

标签推送后，GitHub Actions 会在私有仓库中执行构建，并把安装包发布到：

- [kfumi/codeMUX-desktop Releases](https://github.com/kfumi/codeMUX-desktop/releases)

## 工作流说明

- [`.github/workflows/ci.yml`](/D:/project/ai-code/codeMUX/.github/workflows/ci.yml:1)
  用于日常 CI 校验和构建，不负责正式发布。
- [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)
  仅在推送 `v*.*.*` 标签或手动触发时执行，负责跨仓库发布 Release。

## 常见问题

### Release 没有创建成功

优先检查：

- `DESKTOP_RELEASE_TOKEN` 是否配置在私有源码仓库
- Token 是否对 `kfumi/codeMUX-desktop` 具备写入权限
- `release.yml` 中的 `releaseCommitish` 是否与目标仓库默认分支一致，目前配置为 `main`

### 构建成功但没有看到附件

优先检查目标仓库对应版本标签的 Release 页面，以及 GitHub Actions 日志中 `tauri-action` 的上传步骤是否报错。
