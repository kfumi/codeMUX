# 桌面应用窗口尺寸持久化方案调研

调研日期：2026-08-02

## 结论摘要

推荐采用 Tauri 官方 `window-state` 插件作为窗口级状态持久化的默认方案，并把前端 `resize` 事件仅用于界面布局响应或轻量状态更新。若业务必须自定义存储格式，再使用 Tauri Window API 的 `innerSize`、`outerPosition`、`setSize`、`setPosition` 以及 `onResized`、`onMoved` 组合实现。

无论使用插件还是自定义实现，都应遵循以下原则：

- 恢复时校验尺寸下限、位置是否仍在可见屏幕范围内，并处理最大化、全屏等状态。
- 拖动 resize 期间不要在每个事件中同步写文件、数据库或调用跨进程命令；使用内存中的最新状态，按时间节流写入，或在 resize/move 暂停后再写入。
- 前端只关心 WebView 内容区域尺寸时，使用 `ResizeObserver` 观察具体容器；不要把浏览器 `window.resize` 当作所有元素尺寸变化的通用通知。
- 持久化应以窗口标识为键，至少保存 `width`、`height`、`x`、`y`，并按产品需要保存 `maximized`、`fullscreen`。恢复失败或数据无效时回退到配置中的默认窗口设置。

## 一、Tauri 官方 Window API 能力

Tauri v2 的 JavaScript Window API 提供了窗口对象的尺寸、位置、状态和事件能力。与本调研直接相关的 API 包括：

- `innerSize()`：读取客户区尺寸；`outerSize()`：读取包含窗口边框的外部尺寸。
- `outerPosition()`：读取窗口外部位置；`setSize()`、`setPosition()`：设置尺寸和位置。
- `onResized()`：监听窗口大小变化；`onMoved()`：监听窗口移动。
- `isMaximized()`、`isFullscreen()`：读取窗口状态；对应的最大化/全屏 API 可用于恢复前后的状态协调。
- 事件监听返回取消监听函数，组件卸载或窗口生命周期结束时应清理监听器。

这些 API 适合自定义方案，但它们本身不负责持久化、数据校验、跨显示器恢复或写入节流。自定义实现需要明确“何时采样”和“何时落盘”：事件回调中更新内存快照，持久化层再异步合并写入。

来源：

- [Tauri v2 JavaScript Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Tauri v2 Window API（中文页面）](https://v2.tauri.app/zh-cn/reference/javascript/api/namespacewindow/)

## 二、官方生态 Window State 插件

Tauri 官方插件文档将 Window State 插件定义为“持久化窗口大小和位置”。这说明窗口状态保存属于插件明确覆盖的常见桌面能力，而不是需要每个应用重复实现的业务逻辑。

采用插件的主要收益：

- 直接覆盖尺寸和位置持久化的常见路径，减少前端事件、Rust 命令和配置存储代码。
- 插件位于 Tauri 官方插件生态，文档、权限配置和安装方式与 Tauri v2 集成。
- 应用仍可保留默认尺寸、最小尺寸等窗口配置，把插件作为运行时状态覆盖层。

采用插件时仍需验证以下边界：

- 多窗口应用必须确认状态是否按窗口标签或窗口标识隔离。
- 显示器布局变化、缩放比例变化、断开外接显示器后，保存的位置可能不可见；恢复逻辑必须允许回退或重新居中。
- 最大化、全屏和普通窗口尺寸不是同一个状态，不能只保存一个当前宽高覆盖全部状态。
- 应在目标平台验证首次启动、异常退出、权限限制以及状态文件损坏时的行为。

来源：

- [Tauri v2 Window State 插件官方文档](https://v2.tauri.app/plugin/window-state/)
- [Tauri 官方插件仓库](https://github.com/tauri-apps/tauri-plugin-window-state)
- [插件源码（官方仓库）](https://github.com/tauri-apps/tauri-plugin-window-state/tree/dev)

## 三、WebView 与浏览器 resize 规范

### 3.1 `window` 的 `resize` 事件

MDN 对 `resize` 的说明是：当文档视图（窗口）大小改变时触发。现代浏览器通常只在 `Window` 上派发该事件；元素自身尺寸变化不应依赖元素上的 `resize` 事件。

窗口被用户拖动调整大小时，事件可能在连续的交互过程中反复触发。因此在监听器中执行同步布局重算、序列化、磁盘写入或跨进程调用，会把交互输入路径和慢 I/O 绑定在一起，造成卡顿风险。监听器应保持短小，只记录最新值或安排一次后续任务。

来源：[MDN：Window.resize 事件](https://developer.mozilla.org/en-US/docs/Web/API/Window/resize_event)

### 3.2 `ResizeObserver`

`ResizeObserver` 用于报告元素内容盒或边框盒尺寸的变化，适合观察应用内部布局容器、侧栏和编辑区。它解决的是“哪个元素变了以及变成多大”，与 Tauri 原生窗口的屏幕位置持久化是两个层次的问题。

观察回调也可能在一次布局变化后收到多个条目，因此回调中仍应避免昂贵同步工作。需要把尺寸反馈回布局时，优先使用 CSS、批量更新或 `requestAnimationFrame` 合并处理；需要持久化时，再额外采用节流/防抖和异步存储。

来源：

- [MDN：ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)
- [WHATWG HTML Standard：Resize Observer](https://html.spec.whatwg.org/multipage/webappapis.html#resize-observer)

## 四、主流实现方案比较

| 方案 | 适用场景 | 优点 | 主要风险 |
| --- | --- | --- | --- |
| Tauri Window State 插件 | 单窗口或常规多窗口桌面应用 | 官方生态、实现少、覆盖常见持久化需求 | 需要验证多窗口键、显示器变化和状态边界 |
| 自定义 Tauri API + 应用存储 | 需要自定义 schema、同步云端或统一设置中心 | 完全可控，可加入版本迁移和业务字段 | 需要自行处理事件频率、原子写入、校验和跨屏恢复 |
| 仅前端 `localStorage` + `window.resize` | 只保存 WebView 内部布局，不要求原生窗口位置 | 接入简单 | 无法可靠获得原生屏幕位置；同步写入会影响 resize 交互 |
| `ResizeObserver` | 保存或响应内容区域尺寸 | 元素级、适合复杂布局 | 不能替代 Tauri 原生窗口位置/外部尺寸 API |

## 五、建议的时序

1. 窗口创建后，先读取插件状态或自定义存储。
2. 校验宽高、位置和状态；若位置不在任一显示器可见工作区，改用默认位置或居中。
3. 恢复普通窗口尺寸和位置；最大化/全屏状态单独恢复，并避免在恢复过程中反复写回中间状态。
4. 监听 Tauri 的 `resized` 与 `moved`，仅更新内存快照。
5. 通过约 200～500 毫秒的防抖/节流异步写入，或在一段时间没有变化、窗口失焦、关闭前执行最终保存。具体间隔应以实际平台测试为准，官方资料没有规定固定数值。
6. 对写入失败、损坏数据和版本升级提供默认值回退；保存数据应采用临时文件加替换或存储层提供的原子更新能力。

## 六、针对 CodeMUX 的取舍

当前需求是持久化桌面窗口的宽高与位置，且不要求新增自定义同步协议。优先评估并采用 Tauri 官方 Window State 插件；前端仅使用 `ResizeObserver` 处理内部布局，避免把前端布局尺寸误当作原生窗口状态。

在引入前应做一轮手工验收：Windows 与 macOS 的首次启动和重启、多显示器拔插、系统缩放变化、最大化/全屏切换、最小尺寸约束、异常退出，以及多个窗口的独立恢复。若这些边界不符合产品要求，再退回自定义 Tauri API 方案，并把状态 schema、校验和节流策略写成可测试的独立模块。

