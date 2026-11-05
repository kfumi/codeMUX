# 终端系统重构实施计划（registry + 底部 Dock）

**Spec:** `docs/specs/2026-11-06-terminal-dock-registry.md`
**ADR:** `docs/adr/0022-terminal-session-registry-ownership.md`

## 分票

| 票 | 内容 | 依赖 |
|---|---|---|
| 01 | registry 骨架 + `TerminalView`，右侧面板迁移 | — |
| 02 | 底部 dock（store / 组件 / 布局 / 持久化） | 01 |
| 03 | 快捷键与标题栏入口 | 02 |
| 04 | 终端内交互（主题/链接/键位/IME/PS） | 01 |
| 05 | daemon shell 解析 / env / 退出码 / shell 字段 | — |
| 06 | 删死代码与全量验证 | 01–05 |

## 实施顺序与要点

### 票 01 — registry 骨架

1. 新增 `src/lib/terminal/sessionRegistry.ts`，先把现有 `TerminalPanel` 的内部逻辑整体搬进去：
   - xterm 创建 + `FitAddon` + `term.open(hostEl)`；
   - 先 `fit()` 再 `terminal.start(projectPath, cols, rows, onEvent)`，避免 80×24 启动重排；
   - 事件处理：`output`/`replay`/`exit`/`error`；
   - 后台缓冲（128KB + 行界截断 + 截断提示）；
   - `synchronizeSize` 改为 registry 内部队列（单飞行 latest-wins）。
2. **面板开合过渡期间不 fit**：沿宿主祖先查 `getAnimations()`，过渡结束后再做一次干净 fit。这条规则来自 `9fdabc2`（"面板宽度过渡结束后才 fit/同步"），重构时不能丢——否则中间尺寸会发给 PTY，PSReadLine 在 1~2 列宽下重画 prompt 会留下残影。
2. 新增 `src/components/workspace/terminal/TerminalView.tsx`：稳定容器 + `useLayoutEffect` 挂载/摘除宿主 + 错误浮层。`TerminalScrollbar` 抽成独立文件，挂载时重新查询 `.xterm-viewport`。
3. `SidePanel.tsx` 的终端标签改用 `<TerminalView sessionKey={tab.id} projectPath=... active=... />`；`closeTab` 路径调用 `terminalRegistry.release(tab.id)`。
4. `sidePanelStore` 去掉 `terminalId` / `setTerminalId`（registry 持有）。若保留 attach 兜底，terminalId 只在 registry 内部流转。
5. 迁移测试：`TerminalPanel.test.tsx` → `TerminalView.test.tsx` + `sessionRegistry.test.ts`。保留契约：一次 start、可见性切换不 attach/detach、隐藏缓冲与截断、回放 `RIS`、字号只改视图不重建。删除 `getAnimations` 契约，改为防抖合并。

### 票 02 — 底部 dock

1. `src/store/terminalDockStore.ts`：纯状态机 + 惰性建标签 + 序号复用 + 最后标签关掉收起。
2. `TerminalDock.tsx`：头部（折叠/标题/shell 标签/标签条/+/✕）+ 常驻标签内容 + 顶部拖拽条 + 开合动画 + 空态。
3. `MainLayout.tsx` 加 `terminalDock?: ReactNode`，插在对话列 `ConversationFullViewHost` 之后。`App.tsx` 在 `activeView === 'app' && sidePanelProjectPath` 时传入。
4. `layoutPreferences` 增加 `terminalDockHeight` / `terminalDockOpen`，带读写测试。
5. 高度约束：min 140px、max 容器 50%、默认 260px；窗口变小时自动夹取。
6. 测试：store 状态机、dock 开合/标签/关闭语义、MainLayout 挂载位置。

### 票 03 — 快捷键

1. 目录新增 `toggleTerminalDock`（layout 组，`Mod+Backquote`），测试里的命令计数改为 14。
2. `App.tsx` dispatch 接线；`TitleBar` 加按钮（图标与右侧面板按钮同规格）。
3. 设置页无需改动（由目录驱动），补一条渲染断言。

### 票 04 — 终端内交互

1. `terminalTheme.ts`：CSS 变量 → xterm theme；ANSI 色为常量。
2. `terminalLinks.ts` + `registerLinkProvider` + OSC 8 `linkHandler`；`openTerminalLink()` 按宿主能力选择内置浏览器或系统浏览器。
3. `terminalDataTransform.ts`：PowerShell 单行重绘 `40 → 49`。
4. `composedInputFallback.ts`：Windows composed input 兜底。
5. 键位与右键菜单：复制/粘贴语义 + `ContextMenu`。
6. 每项独立单测。

### 票 05 — daemon

1. `crates/daemon/src/terminal.rs`：shell 候选列表 + 可执行校验（纯函数）、env 构造、退出码。
2. `routes_terminal.rs`：`POST /terminals` 返回 `shell`；`daemon-client/terminal.ts` 类型同步。
3. Rust 单测覆盖候选回退、UTF-8 env、退出码；`npm run build:daemon`。

### 票 06 — 收口

1. 删除 `TerminalPanel.tsx`、`sidePanelStore.setTerminalId`、`isTabPresent` 中只为终端存在的分支。
2. 更新 `docs/specs/2026-08-19-terminal-session-persistence.md` 的 Status 说明（指向本 spec）。
3. 全量验证（见下）。

## 与 ZCode 的有意差异

1. **隐藏标签仍缓冲输出**（128KB、行界截断）：省主线程解析开销；代价是超限尾部丢弃并提示。
2. **PTY 自然退出保留标签**并显示退出码：符合既有 spec，避免退出信息一闪而过。
3. **关最后一个标签真正销毁 PTY 并收起 dock**：关闭语义明确；ZCode 是「只收起、保活」。

## 验证

迭代期按票跑相关测试：

```bash
npx vitest run src/lib/terminal src/components/workspace/terminal \
  src/stores/terminalDockStore.test.ts src/components/workspace/SidePanel.test.tsx \
  src/components/layout/MainLayout.test.tsx src/lib/shortcuts src/lib/layoutPreferences.test.ts
```

收口：

```bash
npx vitest run                 # 根目录全量
npm run build                  # src typecheck + vite
cd crates/daemon && cargo fmt --all -- --check \
  && cargo clippy --all-targets --all-features -- -D warnings \
  && cargo test
npm run build:daemon
```

手工（`npm run dev:desktop`）：

1. Ctrl+` 开 dock → 终端出提示符；`npm run dev` 跑起来。
2. 拖顶部改高 → PowerShell 不反复重画提示符；松手后 `stty size` 与窗口一致。
3. 切会话（同项目）→ dock 不换；切项目 → 换成该项目终端，回来的项目终端仍在跑。
4. 收起 dock → 再展开 → 输出与滚动位置仍在。
5. 切主题 / 改代码字号 → 终端配色与字号跟随，不重连。
6. 中文输入法输入 → 不丢字、不重复。
7. 输出一个 URL → 可点击并在右侧浏览器打开。
8. `exit` → 显示退出码。
9. 关最后一个标签 → dock 收起且进程已结束（任务管理器无残留）。
10. 窄窗口 / 浏览器宿主：dock 可用、默认收起，高度不超过对话列一半。
