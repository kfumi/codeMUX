# 16 内置 MCP 的身份改名与工具清单展示(不拆 server)

**What to build:** 内置 MCP server 从名不副实的 `codemux-browser` 改成覆盖两族能力的 `codemux-control`,描述砍成一行,并让设置页把「当前开关下有多少、具体哪些工具」直接摊开;同时修掉工具卡片把两族工具都显示成 server 名(人分不清在点浏览器还是桌面)的展示层问题。**server 数量不变(仍是一个),调用侧闸门一行不动。**

**Blocked by:** 无(接在 14 的清单过滤与 05 的替身驱动之上)

**Status:** done

## Decisions

- **改名要彻底,因为名字是协议身份。** server key、UI 名、子命令(`mcp-browser` → `mcp-control`)、模块名(`browser_mcp.rs` → `builtin_mcp.rs`)一起改。留一半旧名(例如只改 UI 不改 key)会让「设置页叫什么」与「运行时前缀叫什么」长期分叉,后面每处识别逻辑都要猜是哪一半。集中成 `SERVER_NAME` / `SUBCOMMAND` / `LEGACY_SERVER_NAMES` 三个常量,再让 `cargo check` 兜底扫出漏改的引用。
- **为什么是 `codemux-control`。** 设置页里「浏览器**控制**」与「电脑**控制**」是两个平级开关(`SettingsDialog.tsx`),且「电脑控制」的说明明写"与「浏览器控制」是两个开关,互不代管"——即在本产品词表里「电脑控制」已被收窄为不含浏览器。`codemux-control` 正好是这两个页面名的公共词,覆盖 `browser_*` + `computer_*` 无缺口。命名候选评估:
  - `codemux-control` ✅ 两族公共词,不偏任何一边。
  - `codemux-computer` ❌ 只盖住半边,且与已被收窄的「电脑控制」语义正面冲突——浏览器工具挂在一个叫 computer 的 server 下,正是这次要修的毛病。
  - `codemux-desktop` ❌ 与「桌面壳 / 桌面应用」撞车,而工具里既有浏览器页面也有桌面窗口,`desktop` 同样偏半边。
  - `codemux-automation` ❌ 盖不住只读观测类工具(截图 / 列窗口 / 读元素),且更像 RPA 产品名。
- **工具名不变,只有运行时全名变。** `tools/list` 里 24 个 `name`(`browser_*` 10 + `computer_*` 14)一个不动;daemon 端点的 op 名、审批帧裸名、前端按裸名做的映射全部不动。变的是由 server key 派生的全名前缀:

  | 形态 | 改前 | 改后 |
  |---|---|---|
  | Claude / Codex `mcp__<server>__<tool>` | `mcp__codemux-browser__computer_click` | `mcp__codemux-control__computer_click` |
  | OpenCode 等 `<server>_<tool>` | `codemux-browser_computer_click` | `codemux-control_computer_click` |
  | daemon 审批帧(裸名) | `computer_click` | 不变 |

- **历史名 `codemux-browser` 保留识别,是必需的而不是可选的。** 历史会话轨迹是持久数据,里面存的就是旧全名;不认旧名,老会话的桌面活动标记与 Esc 判定会静默失效。所以 `computerUseActivity.ts` 同时认 `codemux-control` 与 `codemux-browser`(各含 `-` / `_` 两种拼写),`reject_builtin` 也同时拒绝两个 key(id 与 name)。反之 `codemux-computer` 从未发布过,不为其留任何兼容分支。
- **不保留 `mcp-browser` 子命令别名。** 唯一调用方是我们自己生成的 spec(`builtin_server_spec*`),没有外部脚本依赖;留别名等于把旧名钉进 CLI 表面,与"彻底改名"相反。
- **描述砍成一行,位置让给 tooltip。** 新描述:「让智能体操作内置浏览器与桌面应用(截图、点击、输入)。可用工具随「浏览器控制」「电脑控制」设置变化。」逐条念工具名那半句删掉——它在设置页占两行且随开关变化会立刻过期,而工具清单现在有 tooltip 专门承载(见下条)。末句保留,因为工单 14 要求写清「清单随开关变化」。
- **工具数走"daemon 现算",不接探测链路。** 探测只扫 DB(`probe_all_mcp_servers_impl`),而内置条目是 `get_mcp_servers_impl` 动态追加的;内置行也没有探测按钮。所以给内置条目在返回时现算 `tools`(读 `state.config`,不落库),可见性与 `visible_tool_definitions` 共用同一个 `is_visible()`,让**清单、过滤、计数三者同源**——否则计数会和模型真正看到的工具面漂移。计数矩阵:全开 24 / 只浏览器 10 / 只电脑控制 3 / 电脑控制+系统级执行 14 / 全关 0。
- **空清单的两种含义要分开。** 内置 server 且 0 个工具 = 「未启用」(灰字 + tooltip 说明两个开关都关着);自建 server 且 0 个工具(探测没跑或失败)= 什么都不渲染。把两者画成同一个灰字,会把"开关关着"误读成"探测失败"。
- **自定义 MCP 复用同一个徽章组件。** 数据来自既有 `probeTools[id]`,零后端改动;只是自建 server 仅探测成功后才有徽章。
- **工具卡片标题改用工具自身的中文标签。** `getToolHeaderSummary` 的 `mcp__` 分支原先一律取第二段(server 名),改名后 24 个工具会全部显示成 `codemux-control`,两族彻底分不清。改为:先试**最后一段**(工具名)是否在 `BUILT_IN_TOOL_DISPLAY_NAMES` 里 → 用中文标签,否则退回 server 段——第三方 MCP(`mcp__context7__query_docs` → `context7`)行为完全不变。OpenCode 连写形态同样受限处理(只认我们自己的 server 名 + 已知工具名后缀)。顺带补齐 14 个 `computer_*` 中文标签(桌面窗口 / 桌面截图 / 当前窗口 / 应用列表 / 界面元素 / 等待条件 / 点击 / 输入 / 按键 / 粘贴 / 滚动 / 拖拽 / 设值 / 启动)。
- **折叠行文案不动。** `getToolGroupPhrase` 继续显示「调用 N 次 codemux-control」——折叠行回答的是"调了谁",卡片回答的是"干了什么",职责不同。
- **设置页内置行只给命令形态。** 展示 `codemux-daemon mcp-control --app-data-dir <数据目录>`,真实绝对路径(带用户名、安装位置)移进 tooltip,并抹掉 `.exe` 后缀。用户机器上的绝对路径在设置页是纯噪音。

### 为什么不拆成两个 server

功能面、闸门、审批、清单过滤**都已经分离**(工单 14 的分组表 + `desktop::op_for_tool` 交叉验证),拆开能换到的只有一条工程收益:**注入跟着开关走**(只开浏览器就只注入浏览器 server,不再靠清单过滤)。

代价则是四条实打实的:

1. 每个会话多一个子进程(替身驱动是一个 stdio MCP 进程,不是常驻服务);
2. 设置页多一行,用户要理解两个内置条目与三个开关的对应关系;
3. spec「能力只暴露为一个系统内置 MCP 服务」与工单 14 的过滤决定要改判,`visible_tool_definitions` 的三组矩阵测试作废;
4. 浏览器 server 会复用老 key `codemux-browser`——于是"旧名"同时是历史数据与一个活的 server,历史名识别从"兼容分支"变成"两条正常路径",语义重叠。

**结论:不拆。** 这一票要修的是"人看不清、名字不副实",不是权限边界;权限边界由调用侧闸门负责,已由 14 与 06 收口。

## Checklist

- [x] `browser_mcp.rs` → `builtin_mcp.rs`(文件头注释重写:`SERVER_NAME` / `SUBCOMMAND` / `LEGACY_SERVER_NAMES` 与"为何不拆"写在模块头)
- [x] 引用全量更新:`lib.rs`、`bin/codemux-daemon.rs`(`McpControlCli` / `parse_mcp_control_cli` / usage / 错误文案)、`session_lifecycle.rs`、`computer_use/driver.rs`、`tests/computer_use_driver.rs`、`services/mcp.rs`
- [x] 描述换成一行文案
- [x] `visible_tool_names(config)` + 共享 `is_visible()`;内置条目在 `get_mcp_servers_impl` 里带 `tools`(先克隆 config 再取 DB,不嵌套两把锁)
- [x] `McpServer.tools: Vec<String>`(`serde(default, skip_serializing_if)`,读投影不落库)+ 全部结构体字面量补齐
- [x] `reject_builtin` 拒绝新旧两个 key(id 与 name)
- [x] 测试:内置条目 `tools` 随三开关变化的矩阵;拒绝旧名用例
- [x] 前端:`McpToolCountBadge.tsx` + test(数量文案 / 未启用分支 / hover 后列出全部名字)+ `builtinMcp.ts` 共享模块 + test
- [x] `McpSettings.tsx`:徽章接入、内置行命令形态 + 真实路径 tooltip
- [x] 展示层:`computerUseActivity.ts` 新旧名识别、`toolHeaderSummary.ts` 工具名优先 + 14 个 `computer_*` 中文标签,测试钉死第三方 MCP 不回归
- [x] 门禁:cargo fmt / clippy / check / test、`npm run build:daemon`、`npm run build`、前端与 sidecar 全量 vitest

## Comments

- **不改的东西:** `/api/browser-automation/execute` 与 `companion/browser_automation.rs`(内部执行端点,不是身份);审批闸门、风险分级、允许/拒绝范围、清单过滤逻辑;内置行仍不显示状态绿点与刷新按钮(它不进探测链路)。
- **用户原生配置不受影响:** 内置 server 只经会话命令注入(`session_lifecycle.rs`),从不写 `~/.claude.json` / `~/.codex/config.toml`;`adapters/*` 只同步 DB 里的用户 server。
- **审批记忆不受影响:** `guard` 的会话记忆按 op 键、进程内;`turn_artifact_summary` 的匹配与前缀无关;daemon 全仓没有对 `mcp__<server>__` 的运行时依赖(只有注释)。
- **风险与对策:** 改名前缀属协议身份,漏改一处识别逻辑的表现是**静默失效**(不报错,只是标记不亮)。对策是旧名保留识别 + daemon 侧单一常量 + 测试钉死"新名唯一、旧名只用于识别与拒绝"。
- **回滚成本低:** 改动集中在一个常量与几处引用,回退提交即可;无数据迁移、无 DB 结构变更(`serde(default)` 兼容旧读)。
