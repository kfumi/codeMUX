# CodeMUX 桌面端发版指南

本文档用于说明如何在公开源码仓库 `kfumi/codeMUX` 中构建 CodeMUX 安装包，并发布到本仓库的 GitHub Releases。

## 当前发布链路

- 当前仓库负责构建 Tauri 桌面端安装包。
- 推送版本标签后，GitHub Actions 会自动触发 [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)。
- 构建产物会自动上传到本仓库 `kfumi/codeMUX` 的 Releases 页面。
- 正式发布当前仅包含 Windows 和 macOS，暂不发布 Ubuntu 安装包。

## 前置条件

- GitHub Actions 已通过仓库自带的 `GITHUB_TOKEN` 获得 `Contents: Write` 权限

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

在当前仓库的 GitHub Actions Secrets 中新增以下两个 Secret：

- `TAURI_SIGNING_PRIVATE_KEY`：填写 `~/.tauri/codemux-updater.key` 文件中的完整私钥内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：填写生成私钥时设置的密码

发布 workflow 使用仓库自带的 `GITHUB_TOKEN` 将构建产物发布到本仓库；`TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 负责让 Tauri 在 CI 中为 updater 产物签名。

### 5. 发布产物说明

当前 release workflow 中的 Tauri 发布步骤会读取上述 Secrets，并在 `createUpdaterArtifacts` 开启的前提下生成 updater 相关产物，包括：

- `latest.json`
- 安装包对应的签名产物

这些产物会和安装包一起发布到公开仓库：

- [kfumi/codeMUX Releases](https://github.com/kfumi/codeMUX/releases)

## 发版步骤

### 本地手动发版

如果不想使用 GitHub Actions 托管 Runner，可以直接在本地 Windows 构建并整理手动上传文件：

```bash
npm run release:local -- 0.1.5
```

这条命令会自动完成：

- 同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 版本号
- 读取本机 `C:\Users\94910\.tauri` 下的 updater 私钥和密码
- 本地构建 Windows 安装包
- 自动整理 `.msi`、`.exe`、对应 `.sig`
- 自动生成可上传的 `latest.json`
- 在 `out/manual-release/v版本号/` 下生成中文上传清单和 Release 文案

构建完成后，手动打开公开下载仓库上传即可：

- [kfumi/codeMUX Releases](https://github.com/kfumi/codeMUX/releases)

注意：

- 该脚本当前仅支持在 Windows 上执行
- 当前只整理 Windows 产物，不包含 macOS 和 Linux
- 本地手动发版不会自动提交、打 tag、推送代码

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

标签推送后，GitHub Actions 会在当前仓库中执行构建，并把安装包发布到：

- [kfumi/codeMUX Releases](https://github.com/kfumi/codeMUX/releases)

## 工作流说明

- [`.github/workflows/ci.yml`](/D:/project/ai-code/codeMUX/.github/workflows/ci.yml:1)
  用于日常 CI 校验和构建，不负责正式发布。
- [`.github/workflows/release.yml`](/D:/project/ai-code/codeMUX/.github/workflows/release.yml:1)
  仅在推送 `v*.*.*` 标签或手动触发时执行，先确保公开仓库的 Release 存在，再并行上传 Windows 和 macOS 产物。

## 常见问题

### Release 没有创建成功

优先检查：

- workflow 是否配置了 `permissions: contents: write`
- `GITHUB_TOKEN` 是否获得了仓库内容写入权限
- `release.yml` 中用于创建公开 Release 的目标分支是否正确，目前配置为 `master`

### 构建成功但没有看到附件

优先检查目标仓库对应版本标签的 Release 页面，以及 GitHub Actions 日志中 `tauri-action` 的上传步骤是否报错。

### 为什么没有 Ubuntu 安装包

当前 workflow 已暂时移除 Ubuntu 发布，原因是 Linux 的 AppImage 打包经常在 `linuxdeploy` 阶段失败。为了保证正式发版稳定性，现在只发布 Windows 和 macOS。后续如果需要恢复 Linux 发布，可以单独再补 Linux 专用工作流或仅保留 `deb/rpm` 目标。

## Electron 壳发版路径(正式)

自工单 09 起,桌面发布面为 **Electron 壳 + 独立 Rust daemon 二进制**,Tauri 壳
已从仓库移除(`src-tauri/` 目录名保留,内容为 daemon crate 与其 bin 目标)。

### 数据目录与旧壳用户迁移

daemon 的应用数据目录不变(`%APPDATA%/com.codemux.desktop` 及平台等价目录):
SQLite 会话、config.json、配对设备、Local Daemon Token 全部原地复用。旧 Tauri
版用户**一次性安装 Electron 安装包即完成迁移**,无数据搬家脚本。

### unix 打包(待办)

`electron-builder.yml` 当前仅配置 win(NSIS);mac/linux 的 daemon 二进制命名、
resources 映射与公证流程为待办事项。

### 构建安装包(NSIS)

前置:daemon release 二进制已构建,渲染层已构建(脚本会自动完成后者)。

```bash
cd src-tauri && cargo build --release --bin codemux-daemon
npm run build:electron-installer
```

`build:electron-installer` 依次执行:仓库根 `vite build`(渲染层 dist/;类型
检查门禁独立跑 `npx tsc --noEmit`)→ `desktop-electron` tsc(main/preload)→
`scripts/copy-renderer-dist.mjs` 把 `../dist` 拷入 `desktop-electron/renderer-dist`
→ `electron-builder --win nsis`。
产物输出到 `desktop-electron/release/`。

### 更新通道(GitHub Releases)

- [`desktop-electron/electron-builder.yml`](/D:/project/my-project/codeMUX/desktop-electron/electron-builder.yml:1)
  的 `publish`(provider: github,owner/repo = `kfumi/codeMUX`)在打包时生成
  `resources/app-update.yml`;electron-updater 运行时自动读取,代码不硬编码 feed。
- 应用内更新流:渲染层「检查更新」(AboutSettings / 标题栏 UpdateEntry)→
  preload 桥 → main `autoUpdater`(见 `desktop-electron/src/updater.ts`);
  `autoDownload=false`(用户确认后下载)、`autoInstallOnAppQuit=true`(下载后
  即使不立即重启,退出时也会安装)。
- 开发/未打包环境(`app.isPackaged === false`)更新器自动禁用,check 返回
  unavailable。
- 发布新版本时,把 GitHub Release 附件(latest.yml + NSIS exe)上传到
  `kfumi/codeMUX` Releases 即可被现有安装版检测到。

### 通知身份(Windows)

- main 进程 `app.setAppUserModelId('com.codemux.desktop')`,与 electron-builder
  `appId` 一致;NSIS 快捷方式的 AUMID 由此派生 → 通知中心按 CodeMUX 归组、
  点击回跳应用。修改 appId 时必须同步修改 main.ts 的 `APP_ID`。

### 手动验收清单(不进 CI)

- [ ] 安装 NSIS 包后触发一次真实更新安装(检查更新 → 下载 → 重启进入新版本)。
- [ ] 从开始菜单/桌面快捷方式启动应用,触发 agent 通知:通知在通知中心归组到
      CodeMUX,点击通知回跳应用并激活对应会话。
