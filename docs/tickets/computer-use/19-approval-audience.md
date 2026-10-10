# 19 审批受众：没界面能应答的放行请求不再干等

**What to build:** 把电脑控制审批的一个真缺口补掉 —— 放行请求本质是「等一个界面来点」，但 daemon 此前从不检查**有没有界面能点**。于是在「渲染层没武装」的第三种运行形态（PC 浏览器 / 手机浏览器 / 无人值守）下有两种坏行为：① 系统里根本没有界面（定时任务跑在没开壳的机器上）时，这一步仍占满整段 `APPROVAL_TIMEOUT`（120s）；② 有界面但看的是**别的**会话时，请求帧广播出去没人认领，模型照样干等两分钟才拿到「超时按拒绝」。现在按**受众**判定：谁也看不到 → 立刻按 `no-ui` 收口；可能有人看到 → 保留整段等待窗口；唯一能展示审批卡的界面断开 → 挂起的放行一起按「放行界面已断开」收口。

**Blocked by:** 03 技能与审批（审批闸门本体）、13 桌面输入面（限时授权与会话/回合记账）

**Status:** done

## Decisions

- **只加「有没有人能应答」这一维，不动投递规则。** 带会话归属的审批帧继续只走那条会话的流（既有不变量 `session_scoped_approvals_stay_on_the_session_stream_and_fail_closed`），不做跨流广播 —— 否则控制面就会收到本不该收到的会话帧。
- **受众 = 控制面有客户端 或 这条会话有人看。** 两条通路都算「可能被看到」：有人正看着这条会话（请求帧直接送到它面前），或者桌面壳在跑（用户还能打开这条会话，卡片由会话时间线派生）。前端一律按会话订阅 WS（`buildWsUrl` 的 `sessionId` 是必填项），无 `sessionId` 的控制面流只有桌面壳会连（`apps/desktop/src/browser-automation.ts`），所以这个判据的实际含义是「壳在跑，或有别的客户端正看着这条会话」。
- **判据不能看广播通道有没有接收者。** 广播是全局多订阅者通道，壳的控制面连接长期挂在上面却永远收不到会话帧 —— 拿「send 成功」当判据，会把「只有别的会话在看」误判成有人能应答。所以新增独立的订阅计数（`CompanionInner.ui_subscribers`，键就是**帧归属的那条流**：空串 = 控制面，非空 = 会话流）。
- **有人可能看到时保留整段等待窗口。** 「用户在两分钟内打开会话放行」是既有能力，不能被这条检查砍掉；只有连「可能被看到」都不成立（无控制面客户端 + 本会话无人订阅）才立刻收口。这条边界有正反两条用例各自钉住。
- **订阅记账与收尾放在包装层，不放在服务循环里。** 会话/控制面 WS 的服务循环有多条提前 return 路径，把计数放在包一层的 `handle_socket` / `handle_control_socket` 才能保证「加计数」与「减计数」成对。
- **界面全没了就把挂起的放行一起收掉。** 没有人能应答时让模型干等满超时是纯粹的浪费；收掉 sender 让等待端走既有的 `dropped` 分支（文案「放行界面已断开」），fail closed。

## Checklist

- [x] `CompanionInner.ui_subscribers` + `add_ui_subscriber` / `remove_ui_subscriber` / `has_ui_subscriber` / `has_approval_audience(session)` / `has_any_ui` / `abandon_approvals_without_ui`（单测 `ui_subscribers_are_counted_per_connection` 覆盖计数、控制面语义与归零不越界；`approvals_are_abandoned_only_when_the_last_ui_is_gone` 覆盖收尾只在界面全没了时动手）
- [x] `handle_socket` / `handle_control_socket` 拆成「包装层 + 服务循环」，包装层负责订阅记账与「界面全没了就收掉挂起的放行」（策略本身在 state，避免在已超线的 server.rs 里复制两遍）
- [x] `ApprovalRegistry::abandon_all()`（单测 `abandoning_everything_denies_all_pending_requests`）
- [x] 闸门受众预检：无受众 → 立刻 `no-ui` 拒绝；`broadcast.is_err()` 保留为竞态兜底（两条路径的审计理由文案互相区分）
- [x] 集成用例：只有别的会话在看 → 秒拒；壳在跑但本会话没人看 → 等满窗口后超时；唯一界面断开 → 立刻按「放行界面已断开」收口
- [x] 反向验证：分别禁掉受众预检 / `abandon_all`，对应用例各自变红、其余全绿
- [x] 门禁：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo check --all-targets --all-features`、`cargo test`（760 单测 + 集成套件全绿）、`npm run build:daemon`、`npm run check:size`

## Comments

- **为什么不是「把判据迁到驱动侧」**：那才是结构性方案（见 18 的 Comments：`computer_use/desktop.rs::execute` 是唯一知道「这台机器此刻真的在被驱动」的地方），但它属于新增协议面，要先落 spec + ADR。本票只修「明明没人能应答却还等满两分钟」这一格，改动小且可回滚。
- **没有做的事**：没有把审批请求**重投**给后连上的界面 —— 用户在等待窗口内打开会话能看到卡片，靠的是会话时间线派生（`pendingComputerUseApprovals`），不是重投。中继隧道只转发 HTTP（WS 不经隧道），所以经中继的客户端本来就答不了审批，本票不涉及。
- **行数门禁如实记录**：`check:size` 仍是 27 处违规，**逐条与 master 一致**（同文件同条目，在临时 worktree 跑同一脚本对比过）。但 `crates/daemon/src/companion/server.rs` 是**冻结基线内**文件：master 上它已超基线 138 行，本票在它里面再长 23 行（包装层拆分的代价）—— 收尾策略因此上提到 `state.rs`，避免同样的「判断 + 收掉」在 server.rs 里写两遍。要彻底不碰这个文件得先拆它。
- **夹具坑（备查）**：Windows 上 `Copy-Item` 会保留源文件的 `LastWriteTime`，反向验证后把文件复制回去会让 mtime 比已编译产物更旧，cargo 据此不重编、跑的仍是上一版二进制（第一次反向验证险些据此得出错误结论）。改动源码后以 `Compiling` 出现为准再读结论。
