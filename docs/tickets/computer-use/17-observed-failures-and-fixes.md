# 17 真机失败复盘：脱敏、paste、最小化窗口与寻址回归

**What to build:** 用一次真实会话（`e6cdcd99`：让模型「在记事本输入 测试123 并把截图存到桌面」）暴露的失败，回头修工具面的缺陷，并补上「不依赖真驱动」的契约测试基建 —— 让这类回归在没装驱动的机器上也能被测到。

**Blocked by:** 13 桌面输入面、11 宿主身份硬拒、16 内置 MCP 身份与工具清单

**Status:** done

## Decisions

- **模型可见的元素树文本由 CodeMUX 自己渲染。** 驱动 `get_window_state` 的 `tree_markdown` 是它自己渲染的，里面带每个控件的**原始值**（`value="..."`），而脱敏只能改结构化元素（`structuredContent.elements[].value`）—— 转发驱动文本等于把脱敏整块丢掉。改成只渲染已脱敏的结构化元素，来源里没有真值；拿不到结构化树时宁可不给文本。驱动自己的 `_note` 也写着「Prefer `elements`」。
- **`structuredContent.tree_markdown` 同样要清。** 整形只保留 `content`，但 REST 接口直接回原始回包（内置 MCP 走它转发）—— 实测不清这一份时，回包里仍能找到敏感值。
- **敏感控件上的等待谓词直接拒绝（`reason=sensitive_refused`）。** `value_*` 要读值才判得了；`text_present` 的子串匹配等于一个逐字试探的读值通道。拒绝是终态（不轮询、不回值）。
- **paste 按设计实现成两步**（先写系统剪贴板，再投 Ctrl+V），**写剪贴板失败就不粘贴** —— 半途而废比不做更糟（剪贴板被改、窗口没收到，模型却以为成功）。失败文案必须说清「你的剪贴板没有被改动」并给替代路径。
- **最小化窗口补录进清单，但标记不可截。** Electron 的 `desktopCapturer` 不列最小化窗口，PowerShell 的 `EnumWindows` 列 —— 只补「最小化 + 有标题」的条目（`capturable:false`、只有 `windowId`/`processId`、**不带 bounds**：最小化窗口的 `GetWindowRect` 是 -32000 哨兵值）。放开全部身份会灌进一堆不可见辅助窗口。
- **假驱动（`DriverHost::install_stub`）而不是重构出 trait。** 生产路径永不安装它；装上之后 `call_tool` 走预置回包并记录调用顺序，`is_running()` 为真。这样「顺序类」不变量（翻译/裁决/闸门谁先谁后、跨步契约）能在 CI 里断言，不必真桌面。

## Checklist

- [x] P0：`computer_launch` 永远失败（`缺少必填参数 processId`）—— `execute` 不再在 `preflight` 前无条件解析目标窗口，改为按工具分派；删掉 launch 分支重复的 `gate`（原来吃两份步数）
- [x] P1：`elementIndex` 与 `snapshotId` 的配对纪律落到工具面（`computer_type`/`key`/`scroll` 连参数都没有），`computer_elements` 回执带上 `snapshotId`
- [x] P1：新增 `computer_save_screenshot`（窗口级落盘，`screenshot_out_file`），「截图存盘」不再需要模型自己拼 shell
- [x] 越权口子：`launchPath > path > name` 的优先级三处同源（翻译 / 裁决 / 审批摘要），`{name:"notepad", path:"…powershell.exe"}` 不再按 notepad 放行
- [x] 脱敏失效：自己渲染 + 清 `tree_markdown` + 等待谓词拒绝（详见 Decisions）
- [x] `computer_paste` 死工具：`translate` 无分支 → 必然 403；按两步实现，补 `windowId` 必填与 `deliveryMode`
- [x] 最小化窗口从 `computer_windows` 消失：身份脚本补 `title`/`IsIconic`（并把 stdout 钉成 UTF-8，否则中文标题乱码）、清单补录、截图错误文案指向 `windowId` 背景动作
- [x] 假驱动 + 4 条契约测试（启动按应用名、脱敏后的整形、写剪贴板失败不投 Ctrl+V、参数成对纪律本地拒绝）
- [x] 门禁：`cargo fmt/clippy/test`（757 单元 + 集成）、`npm run typecheck`、`npx vitest run`、`npm run build:daemon`

## Comments

- **原始会话证据**：`computer_launch 缺少必填参数 processId(整数)`；`type_text: bare element_index is not accepted; pass element_token, or snapshot_id together with element_index`；`找不到来源 window:46663656:0(先用 computer_windows 取最新清单)`；`前台窗口属于不可操作范围(CodeMUX 自身与安装更新器),整屏截图会把它一并拍下,已拒绝`；后半程 18 次 shell 调用产出桌面 PNG —— 也就是**工具面坏了，模型退回终端**。
- **驱动实测（本机 v0.30.1，59 个工具）**：`tree_markdown` 带 `value="原始值"`；结构化元素的键是 `actions/depth/element_index/element_token/enabled/frame/in_web_content/label/parent_index/role/value`（**没有** `id`/`help` —— 那两项只存在于驱动文本里，所以自己渲染会丢它们，且没有任何动作参数接受它们）；`clipboard_write` 在本机**恒定** `OSError(5) 拒绝访问`（同一台机器上 PowerShell 写剪贴板正常）；Chromium 目标的 Ctrl+V 后台不可用（`background_unavailable`）、前台也 `foreground_unavailable`（提示要 UIAccess worker）。
- **已知边界（如实记录）**：脱敏按敏感词表（登录/密码/验证码/支付/删除/关闭防护）判定，**「收件人」这类字段不脱敏**（实测其值照给）—— 要不要扩表是产品判断。
- **端到端验证方式**：脱敏与等待拒绝用「真 daemon + 真驱动 + 隔离 Edge 探针页（带敏感控件的本地 HTML）」跑通（临时用例，验完删除）；paste 用同一方式跑到「驱动写剪贴板失败 → 拒绝粘贴 + 文案」这一步，卡在驱动能力上，**未能验证成功粘贴**（`computer_paste` 的两步接线本身已由契约测试与实测调用顺序覆盖）。
- **未做 / 后续**：驱动 `element_token` 未透出（等价于 `snapshotId:index`，无必要）；`needs_window_for_pixels` 已成死代码；`is_input_tool` 无生产调用点；本票 16 号工单里的工具计数矩阵（24/14）已过期（现 25/15）；驱动升到 v0.34 后应重验 paste；`computer_windows` 的清单条目形状（`capturable`/`minimized`）目前靠 JSON 直出，若以后要整形给模型，别把这些标记丢掉。
