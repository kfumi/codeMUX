# CodeMUX 桌面端发版指南

本文档用于说明如何在公开源码仓库 `kfumi/codeMUX` 中构建 CodeMUX 安装包，并发布到本仓库的 GitHub Releases。

## 当前发布链路

- 桌面发布面为 **Electron 壳 + 独立 Rust daemon 二进制**（Tauri 壳已从仓库移除；daemon crate 位于 `crates/daemon/`，目录已由 `src-tauri/` 改名）。
- 出包：`npm run build:electron-installer`（详见下文「构建安装包」），产物输出到 `apps/desktop/release/`。
- 发布：把安装包（NSIS exe）与 `latest.yml` 上传到 [kfumi/codeMUX Releases](https://github.com/kfumi/codeMUX/releases)，现有安装版经 electron-updater 检测到更新。
- CI 发版流水线已迁回 Electron：`.github/workflows/release.yml` 的 `ensure-release` 建 Release 记录，紧随其后的 `build-desktop` **三平台矩阵 job**（windows-latest / macos-latest / ubuntu-latest）各跑一遍完整出包链路，并用 `gh release upload --clobber` 把产物附到该 Release 上。推 tag 即自动出包，无需本地手工上传。
- 需要人工介入的只剩一处：仓库 Secrets 里的签名证书（未配置则出未签名包；macOS 另需 Apple Developer ID 才能免 Gatekeeper 拦截，见下文「macOS / Linux 打包」）。
- 本地出包仍可用（见下文），用于临时验证或绕过 CI；`build-desktop` 的步骤顺序刻意与 `build:electron-installer` 一致，改动出包链路时两边都要看。

## 版本号同步（daemon 版本配对依赖）

壳与 daemon 构成 supervisor 版本配对：daemon 的 `DAEMON_VERSION` 来自 `crates/daemon/Cargo.toml`，壳的期望版本默认取自身 `app.getVersion()`（即 `apps/desktop/package.json`）。**三者必须同版本**，否则壳启动时会判定版本不匹配而强杀重起 daemon。

```bash
npm run release:prepare -- 0.0.7   # 同步 package.json / apps/desktop/package.json / Cargo.toml / Cargo.lock
```

`npm run release:ship -- 0.0.7` 在 `master`、工作区干净的前提下自动完成同步 → 提交 → 打 tag → 推送（`--dry-run` 可预演）。

## 构建安装包(NSIS)

一条命令完成全部构建(daemon release 二进制、渲染层、Electron 壳、打包)：

```bash
npm run build:electron-installer
```

`build:electron-installer` 依次执行:`apps/sidecar` tsc(sidecar dist/)→
daemon release 二进制 → 仓库根 `vite build`(渲染层 dist/;类型检查门禁独立跑
`npx tsc --noEmit`)→ `apps/desktop` tsc(main/preload)→
`scripts/copy-renderer-dist.mjs` 把仓库根 `dist/` 拷入 `apps/desktop/renderer-dist`
→ `scripts/copy-sidecar-dist.mjs` 把 `apps/sidecar/dist` 拷入
`apps/desktop/sidecar-dist` → `electron-builder --win nsis`。
产物输出到 `apps/desktop/release/`。

打包工具链的 `electron-builder` 在 `apps/desktop/package.json` 里固定精确版本（不写 `^`）：26 起 Windows 的 PE 资源写入由 rcedit 换成纯 JS 的 `resedit`，产物元数据与压缩工具随之变化，出包工具链需要可复现。

资源根布局(daemon 按这些相对路径找资源,`--resource-dir` = 打包态的
`process.resourcesPath`):

| 路径 | 来源 | 缺失后果 |
| --- | --- | --- |
| `daemon/codemux-daemon[.exe]` | `extraResources` ← `apps/desktop/daemon-bin/`(脚本生成,见下文) | 壳拉不起 daemon |
| `sidecar/dist/index.js` + `sidecar/package.json` | `extraResources` ← `apps/desktop/sidecar-dist/`(脚本生成) | 发消息报 `Bundled sidecar was not found at sidecar\dist/index.js` |
| `dist-web/` | `extraResources` ← 仓库根 `dist-web/` | 浏览器/移动形态无页面 |
| `icons/icon.ico` | `extraResources` ← `crates/daemon/icons/` | 托盘无图标 |
| `app.asar` 内 `renderer-dist/` | `files` ← 脚本从根 `dist/` 拷入 | 桌面窗口白屏 |

`sidecar/package.json` 只标记 ESM(`"type": "module"`);`node_modules` 不随包
分发,sidecar 运行时从托管 Runtime 目录(`%LOCALAPPDATA%/CodeMUX/runtimes`)动态
加载 provider SDK。修改 sidecar 源码后务必让打包链路重跑 `npm run build:sidecar`
(脚本会拦住「dist 比 src 旧」的情况,除非设 `CODEMUX_ALLOW_STALE_SIDECAR=1`)。

### 常见打包环境问题

electron-builder 首次打包会下载 `nsis`、`nsis-resources`、`7zip` 等工具包（签名出包另需 `win-codesign`），国内网络下常遇到两类问题：

1. **下载超时**（`Get "https://github.com/.../nsis-*.7z": connection failed`）：切国内镜像后重跑，缓存写入 `%LOCALAPPDATA%/electron-builder/Cache/`。

   ```powershell
   $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
   npm run build:electron-installer
   ```

2. **签名时 winCodeSign 解压报符号链接权限错误**（`Cannot create symbolic link ... darwin/10.12/lib/libcrypto.dylib`）：只影响配置了 `CSC_LINK` 的签名出包。未签名出包改 PE 资源用的是纯 JS 的 `resedit`（electron-builder 26 起取代 rcedit），根本不下载 `winCodeSign`；签名路径需要 signtool，而 `toolsets.winCodeSign` 默认值 `0.0.0` 指向那个内含两个 macOS 软链的 legacy 包，Windows 解压需管理员权限或开发者模式。两种免管理员规避方式（择一）：
   - 在 `apps/desktop/electron-builder.yml` 设 `toolsets.winCodeSign: "1.1.0"`，改下 Windows 专用的 `windows-kits-bundle-*.zip`（约 8 MB，不含软链）；
   - 或设 `SIGNTOOL_PATH` 指向系统已装的 signtool。

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

CI 侧对应两个仓库 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 内容 | 缺失后果 |
| --- | --- | --- |
| `CSC_LINK` | `.pfx` 的 base64 内容（Actions 里传文件路径没意义，务必 base64） | workflow 跳过签名，产出未签名安装包，并在 job summary 里标注 |
| `CSC_KEY_PASSWORD` | 证书密码 | 同上 |

`build-windows` job 先把 Secrets 注入为环境变量再判断是否配置（`secrets` 上下文不能直接用于 `if` 条件），**已配置但签名失败会直接让 job 失败**，不会产出未签名发布物。

## 更新通道(GitHub Releases)

- [`apps/desktop/electron-builder.yml`](/D:/project/my-project/codeMUX/apps/desktop/electron-builder.yml:1)
  的 `publish`(provider: github,owner/repo = `kfumi/codeMUX`)在打包时生成
  `resources/app-update.yml`;electron-updater 运行时自动读取,代码不硬编码 feed。
- 应用内更新流:渲染层「检查更新」(AboutSettings / 标题栏 UpdateEntry)→
  preload 桥 → main `autoUpdater`(见 `apps/desktop/src/updater.ts`);
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

## macOS / Linux 打包

三个平台都由 Release workflow 的 `build-desktop` 矩阵 job 自动出包,本地对应命令:

| 平台 | 产物 | 本地命令 |
| --- | --- | --- |
| Windows | NSIS `x64` | `npm run build:electron-installer` |
| macOS | `dmg` + `zip`,`x64` / `arm64` | `npm run build:electron-installer:mac` |
| Linux | `AppImage` `x64` | `npm run build:electron-installer:linux` |

**macOS 必须同时出 dmg 和 zip。** `latest-mac.yml` 指向的是 zip 而不是 dmg ——
electron-updater 靠 zip 做更新。只出 dmg 的话,已装用户能检测到新版本却装不上。

### 跨平台资源映射:为什么有 stage-daemon-bin.mjs

`electron-builder.yml` 没有按目标平台分支的能力,而 daemon 的产物文件名随平台
变化(Windows 带 `.exe`,unix 不带)。原先 `extraResources` 直接写死
`from: ../../crates/daemon/target/release/codemux-daemon.exe`,换个平台就是
「文件不存在」。

现在改为 `scripts/stage-daemon-bin.mjs` 先按当前 runner 平台把二进制复制进
`apps/desktop/daemon-bin/`(win 下叫 `codemux-daemon.exe`,unix 下叫
`codemux-daemon`),`extraResources` 只引用目录名:

```yaml
- from: daemon-bin
  to: daemon
```

落地后的文件名与 `apps/desktop/src/main.ts` 的 `resolveDaemonExe()` 一致
(`win32` → `codemux-daemon.exe`,其余 → `codemux-daemon`),壳的代码不用改。
`daemon-bin/` 是生成目录,已在 `.gitignore` 里。

### 签名现状

| 平台 | 状态 |
| --- | --- |
| Windows | 未配 `CSC_LINK` → 未签名;配了走 signtool 链(含 daemon) |
| macOS | **无 Apple Developer ID**,electron-builder 走 ad-hoc 签名 |
| Linux | 不签名 |

ad-hoc 签名的 mac 包能运行,但 Gatekeeper 会拦:用户需右键「打开」,或去
系统设置 → 隐私与安全性 放行。拿到 Developer ID 后,在 `electron-builder.yml`
的 `mac:` 段补 `identity`/`notarize` 并在 Secrets 注入证书即可。

### 已知的功能缺口(打包不等于功能对齐)

以下能力是 Windows 专属,在 mac/linux 上**不会报错但会不工作**,属待适配项:

- `open-project.ts` 找 VS Code / Cursor / git-bash 走的是 `cmd.exe`、`Code.exe`、
  `AppData\Roaming`,非 Windows 上找不到
- 通知的「应用名 + 图标归组」靠 AUMID + 注册表 IconUri(Windows 概念),非
  Windows 上退化为普通通知;`main.ts` 已用 `process.platform === 'win32'` 挡住
  `ensureNotificationIdentity()` 的调用

核心链路(对话、Agent、daemon、文件、终端、内置浏览器、网页/手机形态)不挑平台。

## 通知身份(Windows)

- main 进程 `app.setAppUserModelId('com.codemux.desktop')`,与 electron-builder
  `appId` 一致;NSIS 快捷方式的 AUMID 由此派生 → 通知中心按 CodeMUX 归组、
  点击回跳应用。修改 appId 时必须同步修改 main.ts 的 `APP_ID`。
- 归属区(应用名左侧)的名字与图标**不能**用 Electron 的通知参数设置:
  `Notification.icon` 在 Windows 上渲染为内容区左侧的 `appLogoOverride` 方块。
  它来自 AUMID 身份解析 —— 未打包应用读
  `HKCU\Software\Classes\AppUserModelId\<AUMID>` 的 `DisplayName` / `IconUri`。
  旧 Tauri 版本写过这个键且 `IconUri` 指向 dev 产物路径,若不刷新就是
  "有名字、无图标"。
- 打包态启动时 `main.ts` 调用 `ensureNotificationIdentity()`
  (`src/notification-identity.ts`)刷新该键;`IconUri` 指向随包分发的
  `resources/icons/Square150x150Logo.png`(见 `electron-builder.yml` 的
  extraResources)。归属区图标用 png,托盘/任务栏仍用 `icon.ico`。

## 手动验收清单(不进 CI)

- [ ] 安装 NSIS 包后触发一次真实更新安装(检查更新 → 下载 → 重启进入新版本)。
- [ ] 从开始菜单/桌面快捷方式启动应用,触发 agent 通知:通知在通知中心归组到
      CodeMUX,点击通知回跳应用并激活对应会话。
- [ ] 通知卡片在**应用名左侧**显示 CodeMUX 图标(而非内容区左侧的大方块)。
- [ ] 配置签名环境变量出一次包,确认安装器属性中的数字签名覆盖安装器本体与
      `resources/daemon/codemux-daemon.exe`。

## 历史:Tauri 壳发版链路(已移除)

v0.3.1 之前发布面为 Tauri(`tauri build` + tauri updater 密钥对 + `latest.json`)。
Tauri 壳与其发版脚本 `release:local` 已随工单 09 下线;`tauri.conf.json` 及其
updater `pubkey` 不再存在,相关 GitHub Secrets(`TAURI_SIGNING_PRIVATE_KEY*`)可
在 CI 迁移完成后一并清理。

## CI 出包 job 一览(`build-windows`)

`.github/workflows/release.yml` 在推 `v*.*.*` tag 时触发,两个 job 串行:

| job | runner | 职责 |
| --- | --- | --- |
| `ensure-release` | ubuntu | 按 `package.json` 版本确保 tag 与 GitHub Release 存在 |
| `build-desktop` | 矩阵:windows / macos / ubuntu | 检出 tag → 装依赖 → 构建 → 打包 → 上传产物与 Release 附件 |

`build-desktop` 的构建步骤与根脚本 `build:electron-installer` 一一对应,打包命令走
`npm run pack:${{ matrix.pack }}`(`win` / `mac` / `linux` 三选一)。这些脚本里已固定
`--publish never`:electron-builder 的默认发布策略是 `onTagOrDraft`,在 tag 触发的
CI 上会自行发布并和 `ensure-release` 建的 Release 打架;`--publish never` 让它只
出包,上传统一交给 `gh release upload --clobber`(可重复执行)。

几个实现要点:

- **矩阵而非三份 job**:`pwsh` 在三个 runner 上都预装,「取产物 → 上传」这段
  PowerShell 原样共用;每个 runner 只产本平台产物,上传整个 `release/` 目录、
  排除 `builder-*` 即可,不必按平台写扩展名白名单。
- **daemon 必须原生编译**:Rust 无法从 Windows 交叉编译到 mac/linux,三个 runner
  各自跑一遍完整构建。Linux 需 `libssl-dev`;macOS 显式指 `OPENSSL_DIR`
  (brew 装的 openssl 在 `/opt/homebrew`,openssl-sys 有时找不到)。
- **缓存**:`crates/daemon` 的 cargo 产物(`Swatinem/rust-cache`)+ electron-builder
  工具包(nsis/7zip 等约 100MB+,不缓存则每次重下;macOS runner 较贵,缓存更值)。
- 产物同时用 `actions/upload-artifact` 留存 14 天,即使 Release 附件传失败也能从
  workflow 页面取回安装包。

给已存在的 tag 补装安装包:在 Actions 页手动 `workflow_dispatch` 跑一次 Release
workflow 即可 —— `ensure-release` 会识别到 Release 已存在而跳过创建,
`build-desktop` 照常出包并覆盖上传。
