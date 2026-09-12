# CodeMUX 桌面端发版指南

本文档用于说明如何在公开源码仓库 `kfumi/codeMUX` 中构建 CodeMUX 安装包，并发布到本仓库的 GitHub Releases。

## 当前发布链路

- 桌面发布面为 **Electron 壳 + 独立 Rust daemon 二进制**（Tauri 壳已从仓库移除；`src-tauri/` 目录名保留，内容为 daemon crate 与其 bin 目标）。
- 出包：`npm run build:electron-installer`（详见下文「构建安装包」），产物输出到 `desktop-electron/release/`。
- 发布：把安装包（NSIS exe）与 `latest.yml` 上传到 [kfumi/codeMUX Releases](https://github.com/kfumi/codeMUX/releases)，现有安装版经 electron-updater 检测到更新。
- CI 发版流水线待迁移：`.github/workflows/release.yml` 目前只负责推标签时创建 GitHub Release 记录（`publish-tauri` 任务已随 Tauri 壳移除），**不产出也不上传安装包**；正式标签发版请本地出包后手动上传附件，或先完成 workflow 迁移。

## 版本号同步（daemon 版本配对依赖）

壳与 daemon 构成 supervisor 版本配对：daemon 的 `DAEMON_VERSION` 来自 `src-tauri/Cargo.toml`，壳的期望版本默认取自身 `app.getVersion()`（即 `desktop-electron/package.json`）。**三者必须同版本**，否则壳启动时会判定版本不匹配而强杀重起 daemon。

```bash
npm run release:prepare -- 0.0.7   # 同步 package.json / desktop-electron/package.json / Cargo.toml / Cargo.lock
```

`npm run release:ship -- 0.0.7` 在 `master`、工作区干净的前提下自动完成同步 → 提交 → 打 tag → 推送（`--dry-run` 可预演）。

## 构建安装包(NSIS)

前置：daemon release 二进制已构建,渲染层已构建(脚本会自动完成后者)。

```bash
cd src-tauri && cargo build --release --bin codemux-daemon
npm run build:electron-installer
```

`build:electron-installer` 依次执行:仓库根 `vite build`(渲染层 dist/;类型
检查门禁独立跑 `npx tsc --noEmit`)→ `desktop-electron` tsc(main/preload)→
`scripts/copy-renderer-dist.mjs` 把 `../dist` 拷入 `desktop-electron/renderer-dist`
→ `electron-builder --win nsis`。
产物输出到 `desktop-electron/release/`。

## 安装包签名(应用 + daemon 同一签名链)

Windows 签名统一走 signtool + 同一张代码签名证书，覆盖安装包内两类二进制：

| 签名对象 | 执行者 | 时机 |
| --- | --- | --- |
| Electron 应用本体（exe、dll、NSIS 安装器） | electron-builder 原生 | 打包时自动 |
| daemon 二进制（`resources/daemon/codemux-daemon.exe`） | afterPack 钩子 `scripts/sign-daemon.cjs` → `src/codesign.ts` | 打包时自动 |

签名只需要配置环境变量，`electron-builder.yml` 无需写入证书信息：

- `CSC_LINK`（或 `WIN_CSC_LINK`）：`.pfx` 证书的**文件路径**或 **base64 内容**（两者都支持，base64 会解码到临时文件）。
- `CSC_KEY_PASSWORD`：证书密码。
- `CODEMUX_SIGNTOOL_PATH`（可选）：显式指定 `signtool.exe`；缺省自动在 Windows Kits 各版本目录查找，再退回 PATH。

```bash
export CSC_LINK="C:/certs/codemux.pfx"
export CSC_KEY_PASSWORD="..."
npm run build:electron-installer
```

- 未配置 `CSC_LINK` 时本地出包不签名（钩子打印跳过日志）；**已配置但签名失败会直接使打包失败**，不允许产出未签名发布物。
- daemon 与应用使用同一证书、同一时间戳服务（RFC3161, SHA256），信任链一致。
- 证书文件与密码不得提交仓库；CI 中经 GitHub Secrets 注入。

## 更新通道(GitHub Releases)

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

## 数据目录与旧壳用户迁移

daemon 的应用数据目录不变(`%APPDATA%/com.codemux.desktop` 及平台等价目录):
SQLite 会话、config.json、配对设备、Local Daemon Token 全部原地复用。旧 Tauri
版用户**一次性安装 Electron 安装包即完成迁移**,无数据搬家脚本。

## unix 打包(待办)

`electron-builder.yml` 当前仅配置 win(NSIS);mac/linux 的 daemon 二进制命名、
resources 映射与公证流程为待办事项。

## 通知身份(Windows)

- main 进程 `app.setAppUserModelId('com.codemux.desktop')`,与 electron-builder
  `appId` 一致;NSIS 快捷方式的 AUMID 由此派生 → 通知中心按 CodeMUX 归组、
  点击回跳应用。修改 appId 时必须同步修改 main.ts 的 `APP_ID`。

## 手动验收清单(不进 CI)

- [ ] 安装 NSIS 包后触发一次真实更新安装(检查更新 → 下载 → 重启进入新版本)。
- [ ] 从开始菜单/桌面快捷方式启动应用,触发 agent 通知:通知在通知中心归组到
      CodeMUX,点击通知回跳应用并激活对应会话。
- [ ] 配置签名环境变量出一次包,确认安装器属性中的数字签名覆盖安装器本体与
      `resources/daemon/codemux-daemon.exe`。

## 历史:Tauri 壳发版链路(已移除)

v0.3.1 之前发布面为 Tauri(`tauri build` + tauri updater 密钥对 + `latest.json`)。
Tauri 壳与其发版脚本 `release:local` 已随工单 09 下线;`tauri.conf.json` 及其
updater `pubkey` 不再存在,相关 GitHub Secrets(`TAURI_SIGNING_PRIVATE_KEY*`)可
在 CI 迁移完成后一并清理。
