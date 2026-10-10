//! 唯一的系统内置 MCP server(`codemux-daemon mcp-control` 子命令):会话驱动内置
//! 浏览器与桌面应用/窗口的单一工具面,承载两族工具 —— 浏览器级 10 个(`browser_*`)
//! 与电脑控制 14 个(`computer_*`)。
//!
//! 服务名 `codemux-control`(2026-10 由 `codemux-browser` 改名):取设置页
//! 「浏览器**控制**」与「电脑**控制**」的公共词 —— 两族工具各自挂在其中一个开关下,
//! 用任何一个单边词命名都会把另一半说错(候选评估见工单 16)。
//!
//! **改名只动 server key,不动工具名**:`tools/list` 里 24 个 `name` 一个没变;
//! 变的是各运行时拼出来的全名(前缀由 key 派生):
//!
//! | 形态 | 改前 | 改后 |
//! |---|---|---|
//! | Claude / Codex `mcp__<server>__<tool>` | `mcp__codemux-browser__computer_click` | `mcp__codemux-control__computer_click` |
//! | OpenCode 等 `<server>_<tool>` | `codemux-browser_computer_click` | `codemux-control_computer_click` |
//!
//! 所以历史轨迹里的旧全名仍要认得(见 `src/lib/computerUseActivity.ts` 的旧名名单),
//! 旧 key 也保留为禁用名(见 [`LEGACY_SERVER_NAMES`])。
//!
//! **一个 server 而不是两个**:两族能力在开关、调用闸门、审批分级与清单过滤上早已
//! 各自独立(见 [`ToolGroup`]),拆 server 只换来「注入跟着开关走」一条工程收益,
//! 代价是每会话多一个子进程、设置页多一行、spec 与工单 14 的决定要改判(评估见工单 16)。
//!
//! 工单 14 起 `tools/list` 按开关过滤:关着的能力不出现在模型面前。这仍是
//! **礼貌而不是闸门** —— 每次调用的裁决在 daemon 端点,配置读不到时清单一律
//! 放行(宁可多列几个,也不让工具面静默消失,见 [`visible_tool_definitions`])。
//!
//! stdio 上讲 MCP(ISO JSON-RPC 2.0,按行分帧);每个工具调用转发 daemon
//! 回环端点 `POST /api/browser-automation/execute`(Local Daemon Token 鉴权)。
//! 「浏览器控制 / 电脑控制」闸门在 daemon 端点统一裁决,本子命令不做二次判断。
//!
//! 发现:`--app-data-dir`(必填)→ `daemon-run-state.json` 取端口(daemon
//! 必须在运行),`local-daemon-token` 取令牌(与壳/CLI 同源);`tools/list` 另外
//! 从该目录下的 `config.json` 只读地取开关(不写、不迁移,见 `read_switch_config`)。
//!
//! 本文件不含 I/O 以外的环境假设;除 `tools/list` 读一次开关外,JSON-RPC 应答
//! 为纯函数,便于单测。

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::companion::local_daemon_token;
use crate::config::types::AppConfig;
use crate::daemon::{run_state, DAEMON_VERSION};

/// 内置 server 名(会话命令 `mcpServers` 的键)。取「浏览器控制」与「电脑控制」的
/// 公共词:两族工具各自挂在一个开关下,单边词都会把另一半说错(见文件头)。
pub const SERVER_NAME: &str = "codemux-control";

/// 同名子命令(`codemux-daemon mcp-control …`):spec 生成与 bin 解析共用一份,
/// 免得两边各写一个字面量后悄悄漂移。
pub const SUBCOMMAND: &str = "mcp-control";

/// 改名前的 server key。**只用于拒绝**:用户不得再占用它(否则会与历史轨迹里的旧
/// 全名混淆);它不出现在任何注入路径上。
pub const LEGACY_SERVER_NAMES: &[&str] = &["codemux-browser"];

/// 单次 execute 转发的等待上限。
///
/// 覆盖 daemon 端「人工审批等待(默认 120s)+ 壳执行(15s)」两级:审批是
/// 面向人的,客户端必须比它等得久,否则用户还没点就被判定超时。
const EXECUTE_TIMEOUT: Duration = Duration::from_secs(180);

/// 会话命令注入用的内置 server spec(stdio 指向本 daemon 二进制子命令)。
pub fn builtin_server_spec(current_exe: &Path, app_data_dir: &Path) -> Value {
    json!({
        "command": current_exe.to_string_lossy(),
        "args": [SUBCOMMAND, "--app-data-dir", app_data_dir.to_string_lossy()],
    })
}

/// 带会话归属的 spec(会话命令注入用):审批与审计按会话落账。
pub fn builtin_server_spec_for_session(
    current_exe: &Path,
    app_data_dir: &Path,
    session_id: &str,
) -> Value {
    json!({
        "command": current_exe.to_string_lossy(),
        "args": [
            SUBCOMMAND,
            "--app-data-dir", app_data_dir.to_string_lossy(),
            "--session-id", session_id,
        ],
    })
}

/// MCP 设置页展示用的内置条目(不在 DB,列表 API 动态追加;写入路径按
/// id/name 拒绝改删)。apps 全开:注入侧按 runtime 会话命令分发。
///
/// `config` 用来现算 `tools`:当前开关下模型真正看得见的工具名。内置 server 不在
/// 探测链路里(`probe_all_mcp_servers_impl` 只扫 DB),工具数只能由权威侧算。
pub fn builtin_server_entry(
    current_exe: &Path,
    app_data_dir: &Path,
    config: Option<&AppConfig>,
) -> crate::mcp::types::McpServer {
    crate::mcp::types::McpServer {
        id: SERVER_NAME.to_string(),
        name: SERVER_NAME.to_string(),
        description: "让智能体操作内置浏览器与桌面应用(截图、点击、输入)。可用工具随「浏览器控制」「电脑控制」设置变化。".to_string(),
        server: builtin_server_spec(current_exe, app_data_dir),
        apps: crate::mcp::types::McpApps {
            claude: true,
            codex: true,
            gemini: true,
            opencode: true,
            pi: true,
        },
        builtin: true,
        tools: visible_tool_names(config),
    }
}

/// daemon 回环地址 + Local Daemon Token(execute 转发所需的最小环境)。
///
/// 构造不做 I/O:daemon 没在跑时也要能应答 `initialize` / `tools/list`,
/// 否则智能体连工具面都看不到,只能看见一个起不来的 server。端口与令牌在
/// 每次转发时现取 —— daemon 重启换端口后自动跟上。
pub struct BuiltinMcpRuntime {
    app_data_dir: PathBuf,
    /// 端口覆盖(测试/调试;None = 读 run-state)。
    port_override: Option<u16>,
    /// 令牌覆盖(测试;None = 读/建 app-data-dir 下的本地令牌)。
    token_override: Option<String>,
    http: reqwest::Client,
    /// 会话归属(会话命令经 `--session-id` 注入;手工直连时为 None)。
    session_id: Option<String>,
}

impl BuiltinMcpRuntime {
    pub fn new(
        app_data_dir: &Path,
        port_override: Option<u16>,
        session_id: Option<String>,
    ) -> Self {
        Self {
            app_data_dir: app_data_dir.to_path_buf(),
            port_override,
            token_override: None,
            http: reqwest::Client::builder()
                .timeout(EXECUTE_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            session_id,
        }
    }

    /// 现取 daemon 端口与本地令牌;每一步失败都给面向模型的明确文案。
    fn endpoint(&self) -> Result<(u16, String), String> {
        let port = match self.port_override {
            Some(port) => port,
            None => {
                let roots = crate::paths::PathRoots {
                    app_data_dir: self.app_data_dir.clone(),
                    resource_dir: None,
                };
                run_state::read(&roots)
                    .ok_or_else(|| {
                        "未发现运行中的 daemon(daemon-run-state.json 缺失或已过期)".to_string()
                    })?
                    .port
            }
        };
        let token = match &self.token_override {
            Some(token) => token.clone(),
            None => local_daemon_token::ensure_local_daemon_token(&self.app_data_dir, false)?,
        };
        Ok((port, token))
    }

    /// 磁盘上的开关,只读;读不到、解析不了都返回 `None`(调用侧按全可见收口)。
    ///
    /// 刻意不走 [`crate::config::load_config`]:那条路带迁移与「读不了就备份 +
    /// 重写默认值」的副作用,是权威侧(daemon)的启动逻辑 —— 一个只负责给模型
    /// 列清单的子进程不该顺手改用户的配置。
    fn read_switch_config(&self) -> Option<AppConfig> {
        let roots = crate::paths::PathRoots {
            app_data_dir: self.app_data_dir.clone(),
            resource_dir: None,
        };
        let path = roots.config_path();
        let Ok(bytes) = std::fs::read(&path) else {
            log::debug!(
                target: "mcp_control",
                "读不到配置 {}:工具清单按全量列出(闸门仍在 daemon 端点)",
                path.display()
            );
            return None;
        };
        match serde_json::from_slice::<AppConfig>(&bytes) {
            Ok(config) => Some(config),
            Err(error) => {
                log::warn!(
                    target: "mcp_control",
                    "配置解析失败 {}:{} —— 工具清单按全量列出(闸门仍在 daemon 端点)",
                    path.display(),
                    error
                );
                None
            }
        }
    }

    /// `tools/list` 的应答体:关着的开关对应的工具不出现(工单 14)。
    ///
    /// 每次调用现读配置:客户端重新列清单就能跟上开关变化;只列一次的老客户端
    /// 仍按启动时的清单跑,调用侧由 daemon 端点闸门兜底。
    fn tool_list(&self) -> Value {
        json!({ "tools": visible_tool_definitions(self.read_switch_config().as_ref()) })
    }

    /// 转发一次 execute;成功返回 payload,失败(4xx/5xx/网络)返回面向
    /// 模型的错误文案(daemon 的 403 文案原样透传)。
    pub async fn call_execute(
        &self,
        tool: &str,
        op: &str,
        browser_id: Option<&str>,
        params: Value,
    ) -> Result<Value, String> {
        let (port, token) = self.endpoint()?;
        let response = self
            .http
            .post(format!(
                "http://127.0.0.1:{}/api/browser-automation/execute",
                port
            ))
            .bearer_auth(&token)
            .json(&json!({
                "op": op,
                "browserId": browser_id,
                "params": params,
                "tool": tool,
                "sessionId": self.session_id,
            }))
            .send()
            .await
            .map_err(|e| format!("连接 daemon 失败: {}", e))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("daemon 响应解析失败: {}", e))?;
        interpret_automation_response(status.is_success(), &body)
    }

    /// 桌面工具(工单 13):转发到 daemon 的 `/api/computer-use/execute`。
    ///
    /// 与浏览器侧同一个鉴权(回环 + Local Daemon Token);闸门、动作前裁决与
    /// 审计都在 daemon 侧,这里只做转达 —— 模型不该因为换了条通道就少一道关。
    pub async fn call_desktop(&self, tool: &str, params: Value) -> Result<Value, String> {
        let (port, token) = self.endpoint()?;
        let response = self
            .http
            .post(format!(
                "http://127.0.0.1:{}/api/computer-use/execute",
                port
            ))
            .bearer_auth(&token)
            .json(&json!({
                "tool": tool,
                "params": params,
                "sessionId": self.session_id,
            }))
            .send()
            .await
            .map_err(|e| format!("连接 daemon 失败: {}", e))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("daemon 响应解析失败: {}", e))?;
        interpret_automation_response(status.is_success(), &body)
    }
}

/// 自动化回包 → 工具结果的映射(纯函数,便于逐例测试)。
///
/// 关键一条:**失败也是 HTTP 200**(`{ok:false, error}`)—— 只看状态码会把拒绝
/// 理由取成 payload 的 `null`,模型看到的是「成功但空」,只能自己猜能力是不是坏了
/// (实测代价:一轮里白烧 5 次调用)。失败必须把原文冒泡给模型。
fn interpret_automation_response(http_ok: bool, body: &Value) -> Result<Value, String> {
    if body.get("ok").and_then(Value::as_bool) == Some(false) || !http_ok {
        return Err(automation_error_text(body));
    }
    Ok(body["payload"].clone())
}

/// 失败响应的可读原因:优先 `error` 字段,退回默认文案。
fn automation_error_text(body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "浏览器自动化请求失败".to_string())
}

/// 工具清单(与 `AUTOMATION_OPS` 的 op 面一一对应;描述面向模型)。
fn tool_definitions() -> Value {
    json!([
        {
            "name": "browser_list",
            "description": "列出内置浏览器当前打开的页面(browserId/URL/标题)。操作其他浏览器工具前先调用它确定目标。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "browser_eval",
            "description": "在内置浏览器页面中执行 JavaScript 并返回 JSON 结果。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "要执行的 JavaScript 代码" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["code"],
            },
        },
        {
            "name": "browser_screenshot",
            "description": "对内置浏览器页面截屏,返回 PNG 图像。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
            },
        },
        {
            "name": "browser_input",
            "description": "向内置浏览器页面注入受信键盘/鼠标事件(Electron InputEvent 字段:type、x、y、keyCode 等)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "event": { "type": "object", "description": "InputEvent 字段面" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["event"],
            },
        },
        {
            "name": "browser_cdp",
            "description": "对内置浏览器页面执行一条 Chrome DevTools Protocol 命令(高级操作逃生舱)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string", "description": "CDP 方法名,如 DOM.getDocument" },
                    "params": { "type": "object", "description": "CDP 命令参数" },
                    "browserId": { "type": "string", "description": "目标页面;省略时取最近打开的页面" },
                },
                "required": ["method"],
            },
        },
        {
            "name": "browser_snapshot",
            "description": "读取当前浏览器页的结构化快照：可交互元素列表（含编号、角色、名称与包围盒）与视口尺寸；截图随结果以图片形式返回。用元素编号驱动后续点击、输入等操作。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "browserId": { "type": "string", "description": "目标页面；省略时取最近打开的页面" },
                },
            },
        },
        {
            "name": "browser_click",
            "description": "点击快照中的元素（按元素编号，如 e3）；先调 browser_snapshot 拿最新列表。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "button": { "type": "string", "description": "left、middle 或 right，缺省 left" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId"],
            },
        },
        {
            "name": "browser_type",
            "description": "在快照中的元素里输入文字（按元素编号）；聚焦后设值并派发输入事件，submit 为真且在表单内时提交。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "text": { "type": "string" },
                    "submit": { "type": "boolean" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId", "text"],
            },
        },
        {
            "name": "browser_scroll",
            "description": "滚动页面或快照中的元素：无元素编号时按增量滚屏，有编号时在元素中心滚轮。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "deltaX": { "type": "number" },
                    "deltaY": { "type": "number" },
                    "browserId": { "type": "string" },
                },
            },
        },
        {
            "name": "browser_select",
            "description": "在快照中的下拉框元素里按值选择（按元素编号），选择后派发变更事件。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "elementId": { "type": "string" },
                    "value": { "type": "string" },
                    "browserId": { "type": "string" },
                },
                "required": ["elementId", "value"],
            },
        },
        {
            "name": "computer_windows",
            "description": "列出桌面上的屏幕与窗口(来源 id、标题、所属进程与窗口矩形 bounds)。只读,不改动任何窗口。截取或点击某个窗口前先用它取 sourceId 与 bounds。宿主自身(CodeMUX)的窗口不在清单里,属于设计如此。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "computer_screenshot",
            "description": "截取桌面画面(默认主屏,可指定 computer_windows 给出来源 id)。只读;返回图片与元数据。width/height 是图像像素,windowBounds 是该窗口在系统坐标(鼠标坐标系)里的矩形 —— 需要按截图定位坐标时用 windowBounds 换算:x = windowBounds.x + 图像像素x × windowBounds.width ÷ width。整屏截图在前台是受保护应用(密码管理器、CodeMUX 自身等)时会被拒绝,此时改用窗口来源。窗口最小化或已关闭时返回错误。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sourceId": { "type": "string", "description": "computer_windows 返回的来源 id;省略时截主屏" },
                },
            },
        },
        {
            "name": "computer_active_window",
            "description": "读取当前前台窗口(标题、进程、位置,以及可用于截图的来源 id)。读不到时明确报错,不会拿别的窗口冒充。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "computer_apps",
            "description": "列出桌面应用(运行中与已安装,含 pid、可执行文件与启动路径)。只读;宿主的进程与内置拒绝范围(密码管理器/终端/安全中心)不出现在清单里。判断某个应用是否装着、在跑,或取启动用的名字/路径时用它。",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "computer_elements",
            "description": "读取某个窗口的可访问性元素树(role/label/value/frame/element_index)并附窗口截图。**这是桌面动作的目标来源**:windowId 与 processId 从 computer_windows 取。任何用 elementIndex 的动作都必须先用本工具取一次(索引按窗口缓存,动作后失效,要重新取);像素坐标必须取本工具回图里的窗口内像素(左上角原点),不要拿整屏截图的坐标来算。回图与树可能自报不完整(truncated/degraded/escalation):树不完整时「没看到某个元素」不能当成不存在;树为空(ax_tree_empty)说明该窗口没有可访问性节点(画布/视频/自绘),按回图用像素坐标动作。readValue 可按控件名精确读一个值(唯一匹配才给;敏感控件拒绝读)。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number", "description": "目标进程号(computer_windows 的 processId)" },
                    "windowId": { "type": "number", "description": "目标窗口号(computer_windows 的 windowId)" },
                    "includeScreenshot": { "type": "boolean", "description": "是否附带截图(默认 true)" },
                    "query": { "type": "string", "description": "只保留名字含该子串的元素及其祖先(树很大时用)" },
                    "maxElements": { "type": "number", "description": "元素上限,默认 400" },
                    "maxDepth": { "type": "number", "description": "树深上限,默认 20" },
                    "maxImageDimension": { "type": "number", "description": "截图长边上限,默认 1280;0 = 原始分辨率" },
                    "readValue": {
                        "type": "object",
                        "description": "精确读一个控件的值;name 必须与元素 label 完全一致,可用 role 消歧",
                        "properties": {
                            "name": { "type": "string" },
                            "role": { "type": "string" },
                        },
                        "required": ["name"],
                    },
                },
                "required": ["processId", "windowId"],
            },
        },
        {
            "name": "computer_wait",
            "description": "等待窗口里的一个条件成立(只读轮询):text_present / text_absent(按 label 或值的子串)、value_equals / value_changed(按控件名精确匹配,唯一命中才算)。超时不等于成功;返回 status=timeout 或 reason=incomplete_tree(树不完整,无法证明不存在)时都要先 computer_elements 看一眼再决定下一步,不要盲目重试。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "kind": { "type": "string", "description": "text_present、text_absent、value_equals、value_changed" },
                    "text": { "type": "string", "description": "text_present/text_absent 要等的文本(子串,大小写不敏感)" },
                    "name": { "type": "string", "description": "value_equals/value_changed 的控件名(与 label 完全一致)" },
                    "value": { "type": "string", "description": "value_equals 的目标值" },
                    "baseline": { "type": "string", "description": "value_changed 的基线值" },
                    "timeoutMs": { "type": "number", "description": "默认 10000,上限 30000" },
                    "pollIntervalMs": { "type": "number", "description": "默认 500,下限 100" },
                },
                "required": ["processId", "windowId", "kind"],
            },
        },
        {
            "name": "computer_click",
            "description": "在窗口里点击:优先用 elementIndex(背景投递,不抢焦点、不移动鼠标,能点到最小化/被遮挡的窗口);只对画布/视频/自绘目标才用 x,y(窗口内截图像素,取 computer_elements 的回图)。先 computer_elements 取元素与图,动作后重新取一次看变化。默认 background;不要在没试过background 之前就用 foreground —— 驱动会在后台实在做不到时明确报 background_unavailable,那时才改用 foreground(会短暂抢焦点)。没有反应不要原样重放。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "elementIndex": { "type": "number", "description": "computer_elements 给的元素编号(与 x/y 二选一)" },
                    "x": { "type": "number", "description": "窗口内截图像素 x(与 elementIndex 二选一)" },
                    "y": { "type": "number" },
                    "button": { "type": "string", "description": "left(默认)、right、middle" },
                    "count": { "type": "number", "description": "点击次数,默认 1;双击用 2" },
                    "deliveryMode": { "type": "string", "description": "background(默认)或 foreground" },
                    "snapshotId": { "type": "string", "description": "computer_elements 回包里的 snapshot_id;带上可让驱动校验索引未过期" },
                },
                "required": ["processId", "windowId"],
            },
        },
        {
            "name": "computer_type",
            "description": "向窗口输入文字(不抢焦点;XAML/UWP 目标必须给 elementIndex,驱动会走 Value 模式)。只输入文字,回车/Tab 这类按键用 computer_key。输入内容不进日志与审批历史。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "elementIndex": { "type": "number", "description": "目标输入控件;XAML/UWP 目标必填" },
                    "text": { "type": "string" },
                    "delayMs": { "type": "number", "description": "逐字符间隔,默认 30,上限 200" },
                    "deliveryMode": { "type": "string" },
                },
                "required": ["processId", "text"],
            },
        },
        {
            "name": "computer_key",
            "description": "向窗口发送一个按键或组合键(key + modifiers,如 key=return;key=s + modifiers=[ctrl])。目标不需要在前台。带 Ctrl/Win 的组合键在旧式 Win32 目标上会短暂切换前台后再还原。不确定结果时先 computer_elements 看状态,不要重放。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "elementIndex": { "type": "number" },
                    "key": { "type": "string", "description": "return、tab、escape、up/down/left/right、space、delete、home、end、pageup、pagedown、f1-f12、字母或数字" },
                    "modifiers": { "type": "array", "items": { "type": "string" }, "description": "ctrl、shift、alt、win 的组合" },
                    "deliveryMode": { "type": "string" },
                },
                "required": ["processId", "key"],
            },
        },
        {
            "name": "computer_paste",
            "description": "把文本经系统剪贴板粘贴进目标窗口的当前焦点控件(对话、原生保存框这类只认粘贴的控件用它)。**会覆盖系统剪贴板**;粘贴对象是窗口里当前有焦点的控件,所以先用 computer_elements 确认焦点位置。内容不落日志。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "text": { "type": "string" },
                },
                "required": ["processId", "text"],
            },
        },
        {
            "name": "computer_scroll",
            "description": "滚动窗口或控件(direction + by + amount,默认按页滚一屏)。背景投递,不抢焦点。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "elementIndex": { "type": "number" },
                    "direction": { "type": "string", "description": "up、down、left、right" },
                    "by": { "type": "string", "description": "page(默认)或 line" },
                    "amount": { "type": "number", "description": "滚动量,默认 1" },
                    "deliveryMode": { "type": "string" },
                },
                "required": ["processId", "direction"],
            },
        },
        {
            "name": "computer_drag",
            "description": "在窗口里按住拖动(窗口内截图像素,取 computer_elements 的回图)。从标题栏/边框起拖是移动/缩放窗口,后台做不到,会报 background_unavailable —— 那种情况才用 foreground。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "fromX": { "type": "number" },
                    "fromY": { "type": "number" },
                    "toX": { "type": "number" },
                    "toY": { "type": "number" },
                    "durationMs": { "type": "number", "description": "默认 500" },
                    "deliveryMode": { "type": "string" },
                },
                "required": ["processId", "fromX", "fromY", "toX", "toY"],
            },
        },
        {
            "name": "computer_set_value",
            "description": "直接设置控件值(走可访问性 Value 模式,后台完成、不模拟按键)。适合下拉框按文本选项、滑块、标准输入框;网页类自绘输入框可能忽略这种写法,那就改用 computer_type。elementIndex 必须来自最近一次 computer_elements。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "processId": { "type": "number" },
                    "windowId": { "type": "number" },
                    "elementIndex": { "type": "number" },
                    "value": { "type": "string" },
                    "snapshotId": { "type": "string" },
                },
                "required": ["processId", "windowId", "elementIndex", "value"],
            },
        },
        {
            "name": "computer_launch",
            "description": "启动一个应用(不需要它已经在跑;后台启动,不抢焦点)。给 name(应用名)、path(可执行文件路径)或 launchPath 之一。内置拒绝范围里应用(密码管理器、终端、安全中心)会被拒绝。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "path": { "type": "string" },
                    "launchPath": { "type": "string" },
                },
            },
        },
    ])
}

/// 工具分组:决定「哪个开关关着时,这个工具不该出现在模型面前」(工单 14)。
///
/// 分组只跟**调用时会拦它的那一档闸门**对齐 —— 清单过滤与调用闸门是两条执行
/// 路径,判据必须同源,否则清单会承诺一个调用必被拒的工具:
///
/// - `Browser`:浏览器级,看「浏览器控制」(`browser.enabled`);
/// - `DesktopObservation`:壳侧执行的桌面只读三件套(工单 04),
///   看「电脑控制」(`computer_use.enabled`);
/// - `DesktopDriver`:驱动面(工单 13 的观测与输入),驱动是执行者,
///   看「电脑控制」+「系统级执行」(`system_execution_enabled`)。
///
/// 与审批的风险分级(只读/输入,`computer_use::guard`)是**两条轴**:这里决定
/// 清单里出不出现,那里决定调用时要人点几下。桌面只读三件套落在驱动组,是因为
/// 它们经驱动执行(`computer_use::desktop::ensure_ready`),不是因为风险高 ——
/// 两个枚举不要并成一个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolGroup {
    Browser,
    DesktopObservation,
    DesktopDriver,
}

/// 工具名 → 分组;`None` 表示没登记(测试锁死每个工具都必须登记)。
fn tool_group(name: &str) -> Option<ToolGroup> {
    Some(match name {
        "browser_list" | "browser_eval" | "browser_screenshot" | "browser_input"
        | "browser_cdp" | "browser_snapshot" | "browser_click" | "browser_type"
        | "browser_scroll" | "browser_select" => ToolGroup::Browser,
        "computer_windows" | "computer_screenshot" | "computer_active_window" => {
            ToolGroup::DesktopObservation
        }
        _ if crate::computer_use::desktop::op_for_tool(name).is_some() => ToolGroup::DesktopDriver,
        _ => return None,
    })
}

/// 某分组在当前开关下该不该出现在清单里。
///
/// `config` 为 `None`(读不到配置)时全部可见:清单是礼貌,闸门才是权威 ——
/// 不确定时宁可多列几个,也不能让能力静默消失(工单 05 的「daemon 没起就看不到
/// 工具面」与工单 07 的「运行时回退静默丢工具」都属于这一类事故)。
fn group_is_visible(group: ToolGroup, config: Option<&AppConfig>) -> bool {
    let Some(config) = config else {
        return true;
    };
    match group {
        ToolGroup::Browser => config.browser.enabled,
        ToolGroup::DesktopObservation => config.computer_use.enabled,
        ToolGroup::DesktopDriver => {
            config.computer_use.enabled && config.computer_use.system_execution_enabled
        }
    }
}

/// 某个工具在当前开关下该不该出现在清单里(纯函数)。
///
/// 清单过滤与工具计数是两条消费路径,判据必须同源 —— 否则设置页会显示一个模型
/// 根本看不到的工具数。没登记分组的名字按可见处理(登记由测试看住)。
fn is_visible(name: &str, config: Option<&AppConfig>) -> bool {
    tool_group(name)
        .map(|group| group_is_visible(group, config))
        .unwrap_or(true)
}

/// 按开关过滤后的工具清单(纯函数)。
fn visible_tool_definitions(config: Option<&AppConfig>) -> Value {
    let tools = tool_definitions();
    if config.is_none() {
        return tools;
    }
    let kept: Vec<Value> = tools
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|tool| {
            tool["name"]
                .as_str()
                .map(|name| is_visible(name, config))
                .unwrap_or(true)
        })
        .collect();
    Value::Array(kept)
}

/// 当前开关下可见的工具名(与 [`visible_tool_definitions`] 同一判据)。
///
/// 给设置页用:内置 server 不在探测链路里(`probe_all_mcp_servers_impl` 只扫 DB),
/// 工具数只能由权威侧按内存里的配置现算 —— 与 `tools/list` 共用这一个纯函数,
/// 所以设置页的数字不会和模型看到的清单打架。
pub fn visible_tool_names(config: Option<&AppConfig>) -> Vec<String> {
    tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(str::to_string))
        .filter(|name| is_visible(name, config))
        .collect()
}

/// 一次 stdio 请求的应答:除 `tools/list` 现读一次磁盘上的开关外无副作用。
pub fn handle_request<'a>(
    runtime: &'a BuiltinMcpRuntime,
    method: &'a str,
    params: &'a Value,
) -> impl std::future::Future<Output = Result<Value, (i64, String)>> + 'a {
    let method = method.to_string();
    let params = params.clone();
    async move {
        match method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": DAEMON_VERSION,
                },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(runtime.tool_list()),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or_default();
                let args = params["arguments"].as_object().cloned().unwrap_or_default();
                call_tool(runtime, name, &args).await
            }
            other => Err((
                -32601,
                format!(
                    "Method not found: {}(内置浏览器 server 仅支持 initialize/ping/tools/*)",
                    other
                ),
            )),
        }
    }
}

/// 工具调用 → execute 转发;返回 MCP content 数组(失败置 isError)。
async fn call_tool(
    runtime: &BuiltinMcpRuntime,
    name: &str,
    args: &serde_json::Map<String, Value>,
) -> Result<Value, (i64, String)> {
    let browser_id = args.get("browserId").and_then(|v| v.as_str());
    let result: Result<Value, String> = match name {
        "browser_list" => runtime.call_execute(name, "list", None, json!({})).await,
        "browser_eval" => match args.get("code").and_then(|v| v.as_str()) {
            Some(code) if !code.trim().is_empty() => {
                runtime
                    .call_execute(name, "eval", browser_id, json!({ "code": code }))
                    .await
            }
            _ => Err("browser_eval 缺少必填参数 code".to_string()),
        },
        "browser_screenshot" => {
            runtime
                .call_execute(name, "screenshot", browser_id, json!({}))
                .await
        }
        "browser_input" => match args.get("event") {
            Some(event) if event.is_object() => {
                runtime
                    .call_execute(name, "input", browser_id, event.clone())
                    .await
            }
            _ => Err("browser_input 缺少必填参数 event(对象)".to_string()),
        },
        "browser_cdp" => match args.get("method").and_then(|v| v.as_str()) {
            Some(method) if !method.trim().is_empty() => {
                runtime
                    .call_execute(
                        name,
                        "cdp",
                        browser_id,
                        json!({ "method": method, "params": args.get("params") }),
                    )
                    .await
            }
            _ => Err("browser_cdp 缺少必填参数 method".to_string()),
        },
        "browser_snapshot" => {
            runtime
                .call_execute(name, "snapshot", browser_id, json!({}))
                .await
        }
        "browser_click" => match args.get("elementId").and_then(|v| v.as_str()) {
            Some(element_id) if !element_id.trim().is_empty() => {
                runtime
                    .call_execute(
                        name,
                        "click",
                        browser_id,
                        json!({ "elementId": element_id }),
                    )
                    .await
            }
            _ => Err("browser_click 缺少必填参数 elementId".to_string()),
        },
        "browser_type" => {
            let element_id = args.get("elementId").and_then(|v| v.as_str()).unwrap_or("");
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if element_id.trim().is_empty() || text.is_empty() {
                Err("browser_type 缺少必填参数 elementId 或 text".to_string())
            } else {
                let mut params = serde_json::Map::new();
                params.insert(
                    "elementId".to_string(),
                    Value::String(element_id.to_string()),
                );
                params.insert("text".to_string(), Value::String(text.to_string()));
                if let Some(submit) = args.get("submit") {
                    params.insert("submit".to_string(), submit.clone());
                }
                runtime
                    .call_execute(name, "type", browser_id, Value::Object(params))
                    .await
            }
        }
        "browser_scroll" => {
            let mut params = serde_json::Map::new();
            for key in ["elementId", "deltaX", "deltaY"] {
                if let Some(value) = args.get(key) {
                    params.insert(key.to_string(), value.clone());
                }
            }
            runtime
                .call_execute(name, "scroll", browser_id, Value::Object(params))
                .await
        }
        "browser_select" => {
            let element_id = args.get("elementId").and_then(|v| v.as_str()).unwrap_or("");
            let value = args.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if element_id.trim().is_empty() || value.is_empty() {
                Err("browser_select 缺少必填参数 elementId 或 value".to_string())
            } else {
                runtime
                    .call_execute(
                        name,
                        "select",
                        browser_id,
                        json!({ "elementId": element_id, "value": value }),
                    )
                    .await
            }
        }
        "computer_windows" => {
            runtime
                .call_execute(name, "desktop-windows", None, json!({}))
                .await
        }
        "computer_screenshot" => {
            let mut params = serde_json::Map::new();
            if let Some(source_id) = args.get("sourceId") {
                params.insert("sourceId".to_string(), source_id.clone());
            }
            runtime
                .call_execute(name, "desktop-screenshot", None, Value::Object(params))
                .await
        }
        "computer_active_window" => {
            runtime
                .call_execute(name, "desktop-active-window", None, json!({}))
                .await
        }
        // 桌面输入与可访问性树(工单 13):驱动的窗口级能力,daemon 侧过闸门。
        _ if crate::computer_use::desktop::op_for_tool(name).is_some() => {
            runtime
                .call_desktop(name, Value::Object(args.clone()))
                .await
        }
        other => Err(format!("未知工具: {}(见 tools/list)", other)),
    };
    Ok(match result {
        Ok(payload) => match (name, payload) {
            // 桌面工具的回包已经是 MCP 形状(content 数组,可能带图):
            // 原样带走,错误标志如实转达(措辞归驱动,见 shape_desktop_payload)。
            (name, payload) if crate::computer_use::desktop::op_for_tool(name).is_some() => {
                shape_desktop_payload(&payload)
            }
            ("browser_snapshot", Value::Object(map)) => {
                let screenshot = map.get("screenshot").and_then(|v| v.as_str()).unwrap_or("");
                let mut summary = map.clone();
                summary.remove("screenshot");
                json!({
                    "content": [
                        { "type": "image", "data": screenshot, "mimeType": "image/png" },
                        { "type": "text", "text": serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "null".to_string()) },
                    ],
                })
            }
            ("browser_screenshot", Value::String(data)) if !data.is_empty() => json!({
                "content": [{ "type": "image", "data": data, "mimeType": "image/png" }],
            }),
            ("computer_screenshot", Value::Object(map)) => {
                let image = map.get("image").and_then(|v| v.as_str()).unwrap_or("");
                if image.is_empty() {
                    json!({
                        "content": [{ "type": "text", "text": "桌面截图为空(来源可能已关闭或最小化)" }],
                        "isError": true,
                    })
                } else {
                    let mut meta = map.clone();
                    meta.remove("image");
                    json!({
                        "content": [
                            { "type": "image", "data": image, "mimeType": "image/png" },
                            { "type": "text", "text": serde_json::to_string_pretty(&meta).unwrap_or_else(|_| "null".to_string()) },
                        ],
                    })
                }
            }
            ("browser_eval", payload) => json!({
                "content": [{ "type": "text", "text": payload.as_str().unwrap_or("null") }],
            }),
            (_, payload) => json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "null".to_string()) }],
            }),
        },
        Err(error) => json!({
            "content": [{ "type": "text", "text": error }],
            "isError": true,
        }),
    })
}

/// 桌面工具的回包已经是 MCP 形状(content 数组,可能带图):原样带走,只把
/// 驱动的 isError 如实转成工具错误。
///
/// 为什么不能压成一句话:驱动给的是**写给模型的原文**(例如
/// `background_unavailable` 的下一步该改用 foreground),压扁就等于把
/// 「失败理由」这类信息又吞一次。
pub(crate) fn shape_desktop_payload(payload: &Value) -> Value {
    let is_error = payload
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = payload
        .get("content")
        .cloned()
        .unwrap_or_else(|| json!([{ "type": "text", "text": "驱动没有返回内容" }]));
    let mut shaped = json!({ "content": content });
    if is_error {
        shaped["isError"] = json!(true);
    }
    shaped
}

/// stdio 主循环:按行读 JSON-RPC,应答写 stdout(逐行 flush)。EOF 或致命
/// 写错误返回。永不因单条坏行失败 —— 坏行回 -32700(id null)。
pub fn run_stdio(runtime: &BuiltinMcpRuntime) -> Result<(), String> {
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("构建 tokio 运行时失败: {}", e))?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("读取 stdin 失败: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => {
                let Some(id) = message.get("id").cloned() else {
                    // 通知(如 notifications/initialized):不应答。
                    continue;
                };
                let method = message["method"].as_str().unwrap_or_default().to_string();
                let params = message.get("params").cloned().unwrap_or(json!({}));
                match tokio_runtime.block_on(handle_request(runtime, &method, &params)) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err((code, message_text)) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": code, "message": message_text },
                    }),
                }
            }
            Err(_) => json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error: 请求不是合法 JSON" },
            }),
        };
        writeln!(stdout, "{}", response).map_err(|e| format!("写出 stdout 失败: {}", e))?;
        stdout
            .flush()
            .map_err(|e| format!("刷新 stdout 失败: {}", e))?;
    }
    Ok(())
}

/// 子命令入口:`codemux-daemon mcp-control --app-data-dir <dir> [--port <n>]
/// [--session-id <id>]`。
pub fn run_subcommand(
    app_data_dir: PathBuf,
    port_override: Option<u16>,
    session_id: Option<String>,
) -> Result<(), String> {
    let runtime = BuiltinMcpRuntime::new(&app_data_dir, port_override, session_id);
    run_stdio(&runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::types::{AppConfig, BrowserControlConfig, ComputerUseConfig};

    fn runtime_at(port: u16) -> BuiltinMcpRuntime {
        // 不存在的 app-data-dir:配置读不到 → 清单按全量收口(见 read_switch_config)。
        let configless =
            std::env::temp_dir().join(format!("codemux-mcp-no-config-{}", uuid::Uuid::new_v4()));
        runtime_in(&configless, port)
    }

    fn runtime_in(app_data_dir: &Path, port: u16) -> BuiltinMcpRuntime {
        BuiltinMcpRuntime {
            app_data_dir: app_data_dir.to_path_buf(),
            port_override: Some(port),
            token_override: Some("test-token".to_string()),
            http: reqwest::Client::new(),
            session_id: Some("session-test".to_string()),
        }
    }

    /// 三个开关的一次组合(其余字段取默认,形状与 daemon 落盘的一致)。
    fn switches_config(browser: bool, computer_use: bool, system_execution: bool) -> AppConfig {
        AppConfig {
            browser: BrowserControlConfig {
                enabled: browser,
                ignore_certificate_errors: false,
            },
            computer_use: ComputerUseConfig {
                enabled: computer_use,
                system_execution_enabled: system_execution,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn write_switches(
        app_data_dir: &Path,
        browser: bool,
        computer_use: bool,
        system_execution: bool,
    ) {
        let bytes =
            serde_json::to_vec_pretty(&switches_config(browser, computer_use, system_execution))
                .expect("序列化配置");
        std::fs::write(app_data_dir.join("config.json"), bytes).expect("写配置");
    }

    fn config_names(config: Option<&AppConfig>) -> Vec<String> {
        visible_tool_definitions(config)
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect()
    }

    async fn listed_names(runtime: &BuiltinMcpRuntime) -> Vec<String> {
        let result = handle_request(runtime, "tools/list", &json!({}))
            .await
            .expect("tools/list 应成功");
        result["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn builtin_spec_points_at_daemon_subcommand() {
        let spec =
            builtin_server_spec(Path::new("C:/bin/codemux-daemon.exe"), Path::new("D:/data"));
        assert_eq!(spec["command"], "C:/bin/codemux-daemon.exe");
        assert_eq!(spec["args"][0], SUBCOMMAND);
        assert_eq!(spec["args"][1], "--app-data-dir");
        assert_eq!(spec["args"][2], "D:/data");
    }

    // ---- 失败回包必须把理由冒泡给模型(实测:被吞成 null 时模型判定"能力坏了") ----

    #[test]
    fn a_refusal_inside_a_200_response_becomes_a_tool_error() {
        // 桌面只读观测的拒绝就是走这条路:HTTP 200 + {ok:false, error}。
        let body = json!({
            "ok": false,
            "requestId": "r1",
            "error": "前台窗口属于不可操作范围(CodeMUX 进程家族),整屏截图会把它一并拍下,已拒绝。",
        });
        let error = interpret_automation_response(true, &body).expect_err("拒绝必须变成错误");
        assert!(error.contains("整屏截图"));
        assert!(error.contains("CodeMUX"), "理由要原样带给模型: {error}");
    }

    #[test]
    fn a_successful_response_returns_the_payload() {
        let body = json!({ "ok": true, "requestId": "r1", "payload": { "elements": 3 } });
        assert_eq!(
            interpret_automation_response(true, &body).expect("成功"),
            json!({ "elements": 3 })
        );
    }

    #[test]
    fn an_http_failure_uses_the_error_field_and_falls_back_to_a_default() {
        let with_reason = json!({ "error": "电脑控制未开启:请在 设置 → 电脑控制 中打开后重试" });
        let error = interpret_automation_response(false, &with_reason).expect_err("403 也是错误");
        assert!(error.contains("电脑控制未开启"));

        let bare = json!({ "ok": false });
        assert_eq!(
            interpret_automation_response(true, &bare).expect_err("没有理由也要报错"),
            "浏览器自动化请求失败"
        );
    }

    #[tokio::test]
    async fn initialize_echoes_protocol_version() {
        let runtime = runtime_at(1);
        let result = handle_request(
            &runtime,
            "initialize",
            &json!({ "protocolVersion": "2025-06-18" }),
        )
        .await
        .expect("initialize 应成功");
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["capabilities"]["tools"], json!({}));
    }

    #[tokio::test]
    async fn tools_list_covers_all_execute_ops() {
        // 读不到配置 → 清单按全量收口(见 read_switch_config);开关过滤见
        // `the_tool_list_follows_the_three_switches`。
        let runtime = runtime_at(1);
        let result = handle_request(&runtime, "tools/list", &json!({}))
            .await
            .expect("tools/list 应成功");
        let names: Vec<&str> = result["tools"]
            .as_array()
            .expect("tools 数组")
            .iter()
            .map(|tool| tool["name"].as_str().expect("工具名"))
            .collect();
        // 工具面覆盖全部 op 面:浏览器 op 一一对应,桌面只读三件套(04 票)按
        // 「覆盖」断言,工单 13 的桌面工具面另有一份自己的 op 表(不走 execute)。
        let mut expected = vec![
            "browser_list",
            "browser_eval",
            "browser_screenshot",
            "browser_input",
            "browser_cdp",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_scroll",
            "browser_select",
            "computer_windows",
            "computer_screenshot",
            "computer_active_window",
        ];
        expected.extend(crate::computer_use::desktop::DESKTOP_TOOL_NAMES);
        assert_eq!(names, expected);
        // 工具面覆盖全部 op 面:每个合法 op 至少有一个工具能到达它(01 票的
        // 一一对应在 04 票加了桌面只读三件套,这里按「覆盖」而非「同名」断言)。
        let ops_reachable = [
            "list",
            "eval",
            "screenshot",
            "input",
            "cdp",
            "snapshot",
            "click",
            "type",
            "scroll",
            "select",
            "desktop-windows",
            "desktop-screenshot",
            "desktop-active-window",
        ];
        assert_eq!(
            ops_reachable.len(),
            crate::companion::browser_automation::AUTOMATION_OPS.len(),
            "新增 op 时同步补工具或更新本断言"
        );
    }

    // ---- 工具清单随开关(工单 14) ----

    #[test]
    fn the_tool_list_follows_the_three_switches() {
        let names = |browser: bool, computer_use: bool, system_execution: bool| {
            config_names(Some(&switches_config(
                browser,
                computer_use,
                system_execution,
            )))
        };

        // 全关:一个都不列(这份 server 只在开关打开过的会话里才会被注入)。
        assert!(names(false, false, false).is_empty());

        // 只开浏览器控制:10 个 browser_*,桌面工具一个都不出现。
        let browser_only = names(true, false, false);
        assert_eq!(browser_only.len(), 10, "{browser_only:?}");
        assert!(browser_only.iter().all(|name| name.starts_with("browser_")));

        // 只开电脑控制:壳侧只读三件套;驱动面(含驱动侧只读)不出现。
        let observation_only = names(false, true, false);
        assert_eq!(observation_only.len(), 3, "{observation_only:?}");

        // 电脑控制 + 系统级执行:驱动面出现,合计 14 个 computer_*。
        let driver_only = names(false, true, true);
        assert_eq!(driver_only.len(), 14, "{driver_only:?}");

        // 三开:与静态表逐字一致(过滤只做删减,不改顺序、不动 schema)。
        let full = names(true, true, true);
        assert_eq!(full, config_names(None));
        assert_eq!(full.len(), 24);
    }

    /// 设置页拿到的工具名:与 `tools/list` 同源,且随开关走(工单 16)。
    ///
    /// 内置 server 不进探测链路,所以这个数字由 daemon 现算;它与清单侧
    /// (`config_names`)必须逐字一致 —— 设置页不能显示一个模型看不到的工具数。
    #[test]
    fn the_builtin_entry_carries_the_switch_filtered_tool_names() {
        let entry = |browser: bool, computer_use: bool, system_execution: bool| {
            builtin_server_entry(
                Path::new("C:/bin/codemux-daemon.exe"),
                Path::new("D:/data"),
                Some(&switches_config(browser, computer_use, system_execution)),
            )
        };

        let full = entry(true, true, true);
        assert_eq!(full.tools, config_names(None));
        assert_eq!(full.tools.len(), 24);
        assert_eq!(entry(true, false, false).tools.len(), 10);
        assert_eq!(entry(false, true, false).tools.len(), 3);
        assert_eq!(entry(false, true, true).tools.len(), 14);
        assert!(entry(false, false, false).tools.is_empty());

        // 配置读不到:按全量列,与 `tools/list` 的失败开口一致。
        let configless = builtin_server_entry(
            Path::new("C:/bin/codemux-daemon.exe"),
            Path::new("D:/data"),
            None,
        );
        assert_eq!(configless.tools, config_names(None));

        // 身份:新 key 唯一,历史名只作为禁用名存在(改名不动工具名)。
        assert_eq!(SERVER_NAME, "codemux-control");
        assert_eq!(SUBCOMMAND, "mcp-control");
        assert_eq!(LEGACY_SERVER_NAMES, &["codemux-browser"]);
        assert_eq!(full.id, SERVER_NAME);
        assert_eq!(full.name, SERVER_NAME);
        assert!(full.builtin);
        assert_eq!(full.server["args"][0], SUBCOMMAND);
        assert!(
            !LEGACY_SERVER_NAMES.contains(&full.id.as_str()),
            "新 key 不得与历史名重合"
        );
        assert!(
            full.tools.iter().all(|name| !name.contains("codemux")),
            "工具名本身不含 server 段:{:?}",
            full.tools
        );
    }

    #[test]
    fn every_listed_tool_is_registered_and_matches_the_call_time_gate() {
        let tools = tool_definitions();
        let tools = tools.as_array().cloned().unwrap_or_default();
        let mut observation = Vec::new();
        for tool in &tools {
            let name = tool["name"].as_str().expect("工具名");
            let group = tool_group(name).unwrap_or_else(|| panic!("{name} 没登记分组"));

            // 期望分组从**调用侧的事实**独立推出来:浏览器前缀看浏览器开关;
            // 在驱动 op 表里的走驱动面;其余 computer_* 是壳侧只读三件套。
            let expected = if name.starts_with("browser_") {
                ToolGroup::Browser
            } else if crate::computer_use::desktop::op_for_tool(name).is_some() {
                ToolGroup::DesktopDriver
            } else {
                observation.push(name.to_string());
                ToolGroup::DesktopObservation
            };
            assert_eq!(group, expected, "{name} 的分组与调用侧闸门不一致");
        }

        // 驱动组与驱动工具表同一批(漏登记/多登记都在这里失败)。
        assert_eq!(
            crate::computer_use::desktop::DESKTOP_TOOL_NAMES.len(),
            tools
                .iter()
                .filter(|tool| {
                    tool["name"].as_str().and_then(tool_group) == Some(ToolGroup::DesktopDriver)
                })
                .count(),
            "驱动组与 DESKTOP_TOOL_NAMES 必须一一对应"
        );
        // 壳侧只读组的成员钉死:新增 computer_* 工具若不进驱动 op 表,会静默
        // 落进这一组 —— 这里逼作者先决定它归哪一组。
        assert_eq!(
            observation,
            vec![
                "computer_windows",
                "computer_screenshot",
                "computer_active_window"
            ]
        );
    }

    #[tokio::test]
    async fn tools_list_reads_the_switches_from_disk_each_time() {
        let dir = tempfile::tempdir().expect("建临时目录");
        write_switches(dir.path(), true, false, false);
        let runtime = runtime_in(dir.path(), 1);

        let browser_only = listed_names(&runtime).await;
        assert_eq!(browser_only.len(), 10, "{browser_only:?}");
        assert!(browser_only.iter().all(|name| name.starts_with("browser_")));

        // 开关改了(daemon 落盘),重新列清单就跟着变 —— 只列一次的老客户端
        // 仍按启动时的清单跑,调用侧由端点闸门兜底。
        write_switches(dir.path(), true, true, true);
        assert_eq!(listed_names(&runtime).await.len(), 24);
    }

    #[tokio::test]
    async fn an_unreadable_config_keeps_every_tool_visible() {
        // 失败开口:工具面静默缺失比多列几个更贵(工单 05/07 两次事故)。
        let runtime = runtime_at(1);
        assert_eq!(listed_names(&runtime).await.len(), 24);
    }

    #[test]
    fn desktop_tools_are_mapped_to_desktop_ops() {
        // 三个桌面只读工具的存在与分类:只读由 daemon 闸门按 op 裁决。
        for op in crate::companion::browser_automation::DESKTOP_OPS {
            assert!(
                crate::companion::browser_automation::is_desktop_op(op),
                "{op} 应被识别为桌面只读操作"
            );
        }
        assert!(!crate::companion::browser_automation::is_desktop_op(
            "snapshot"
        ));
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let runtime = runtime_at(1);
        let (code, message) = handle_request(&runtime, "resources/list", &json!({}))
            .await
            .expect_err("未知方法必须 -32601");
        assert_eq!(code, -32601);
        assert!(message.contains("resources/list"));
    }

    #[tokio::test]
    async fn missing_required_args_fail_without_network() {
        let runtime = runtime_at(1);
        for (name, args) in [
            ("browser_eval", json!({})),
            ("browser_input", json!({ "event": "not-object" })),
            ("browser_cdp", json!({})),
            ("browser_click", json!({})),
            ("browser_type", json!({"elementId": "e1"})),
            ("browser_select", json!({"elementId": "e1"})),
        ] {
            let result = handle_request(
                &runtime,
                "tools/call",
                &json!({ "name": name, "arguments": args }),
            )
            .await
            .expect("tools/call 应答");
            assert_eq!(result["isError"], true, "{} 缺参应 isError", name);
        }
        let unknown = handle_request(
            &runtime,
            "tools/call",
            &json!({ "name": "browser_fly", "arguments": {} }),
        )
        .await
        .expect("tools/call 应答");
        assert!(unknown["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("未知工具"));
    }

    #[tokio::test]
    async fn failed_execute_becomes_is_error_content() {
        // 端口 1 上没有 daemon:连接失败 → isError,错误文案含原因。
        let runtime = runtime_at(1);
        let result = handle_request(
            &runtime,
            "tools/call",
            &json!({ "name": "browser_list", "arguments": {} }),
        )
        .await
        .expect("tools/call 应答");
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("连接 daemon 失败"));
    }

    // ---- 桌面工具面(工单 13) ----

    #[test]
    fn every_desktop_tool_is_listed_with_its_disciplines() {
        let tools = tool_definitions();
        let tools = tools.as_array().cloned().unwrap_or_default();
        for name in crate::computer_use::desktop::DESKTOP_TOOL_NAMES {
            let entry = tools
                .iter()
                .find(|tool| tool["name"] == json!(name))
                .unwrap_or_else(|| panic!("tools/list 缺 {name}"));
            let description = entry["description"].as_str().unwrap_or_default();
            assert!(!description.trim().is_empty(), "{name} 要有面向模型的描述");
            assert!(
                entry["inputSchema"]["type"] == json!("object"),
                "{name} 要有 inputSchema"
            );
        }
        // 关键纪律必须写在描述里:寻址先取快照、坐标来自本工具回图、不要重放。
        let elements = tools
            .iter()
            .find(|tool| tool["name"] == json!("computer_elements"))
            .expect("computer_elements");
        let description = elements["description"].as_str().unwrap_or_default();
        assert!(description.contains("elementIndex") || description.contains("element_index"));
        assert!(description.contains("窗口内像素") || description.contains("窗口内截图"));
        let click = tools
            .iter()
            .find(|tool| tool["name"] == json!("computer_click"))
            .expect("computer_click");
        let description = click["description"].as_str().unwrap_or_default();
        assert!(
            description.contains("background_unavailable"),
            "要写明后台优先与升级信号"
        );
        assert!(description.contains("不要原样重放") || description.contains("不要重放"));
    }

    #[test]
    fn the_desktop_face_and_the_browser_face_do_not_share_names() {
        let tools = tool_definitions();
        let tools = tools.as_array().cloned().unwrap_or_default();
        let mut names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "工具名不能重复");
    }

    #[test]
    fn a_driver_payload_keeps_its_image_and_its_error_flag() {
        // 成功:图与结构化文本都原样带走。
        let payload = json!({
            "content": [
                { "type": "image", "data": "iVBORw0K", "mimeType": "image/png" },
                { "type": "text", "text": "tree_markdown" },
            ],
            "structuredContent": { "elements": [] },
        });
        let shaped = shape_desktop_payload(&payload);
        assert_eq!(shaped["content"][0]["type"], json!("image"));
        assert_eq!(shaped["content"][0]["data"], json!("iVBORw0K"));
        assert!(shaped.get("isError").is_none(), "成功不置 isError");

        // 驱动拒绝:原文保留、isError 置真。
        let refusal = json!({
            "content": [{ "type": "text", "text": "background_unavailable: 改用 delivery_mode=foreground 再试" }],
            "isError": true,
        });
        let shaped = shape_desktop_payload(&refusal);
        assert_eq!(shaped["isError"], json!(true));
        assert!(shaped["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("background_unavailable"));

        // 没有 content 也不能给模型一个空壳。
        let shaped = shape_desktop_payload(&json!({}));
        assert!(shaped["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("没有返回内容"));
    }
}
