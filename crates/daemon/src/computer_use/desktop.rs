//! 桌面工具面(工单 13):把驱动的窗口级能力按我们的闸门暴露给模型。
//!
//! 为什么不自己合成键鼠:驱动(trycua/cua)已经实现了整套窗口面 —— UI
//! Automation 树、背景投递(不抢焦点)、像素命中升级、`verify_state`、
//! `zoom`、剪辑板、会话生命周期。自己用 PowerShell + SendInput 重写一套,
//! 等于把「背景优先、不重放、目标必须显式」这些来之不易的语义再踩一遍。
//! 本模块因此只做三件事:
//!
//! 1. **参数翻译**(纯函数):我们的工具参数 → 驱动工具参数,缺参数在本地
//!    就拒绝,不把半成品丢给驱动;
//! 2. **动作前裁决**:窗口身份(pid / 映像名 / 可执行文件路径)+ 标题 + 允许
//!    列表,任一命中内置拒绝就**在动作之前**拒绝 —— 观测可以事后筛查截图,
//!    输入动作事后筛查等于没筛;
//! 3. **结果整形**:脱敏敏感控件的值、给等待谓词配证据、附一句「不要重放」
//!    的回执,然后原样把驱动的 content/structuredContent 交给模型。
//!
//! 闸门(审批、敏感场景、步数、限时控制会话)复用 [`super::approval::gate`],
//! 与浏览器侧的输入动作同一套裁决 —— 桌面不会因为换了条通道就松一格。

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::companion::browser_audit::{self, AuditRecord};
use crate::companion::server::ServerContext;

use super::policy::{self, ProtectedProcesses, WindowSubject};

/// 等待谓词的默认与上限(与驱动的 verify_state 不同,这里是显式轮询)。
const WAIT_DEFAULT_TIMEOUT_MS: u64 = 10_000;
const WAIT_MAX_TIMEOUT_MS: u64 = 30_000;
const WAIT_DEFAULT_INTERVAL_MS: u64 = 500;

/// 轮询时的树预算:判定「不存在」需要完整树,预算给得比人工观测大一档。
const WAIT_TREE_MAX_ELEMENTS: u64 = 1500;
const WAIT_TREE_MAX_DEPTH: u64 = 25;

/// 我们暴露的桌面工具清单(顺序即 tools/list 顺序)。
pub const DESKTOP_TOOL_NAMES: [&str; 11] = [
    "computer_apps",
    "computer_elements",
    "computer_wait",
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_paste",
    "computer_scroll",
    "computer_drag",
    "computer_set_value",
    "computer_launch",
];

/// 工具 → 闸门用的 op 名。
///
/// 只读 op 在 [`super::guard::READ_ONLY_OPS`] 里;其余一律按输入动作收口
/// (没列进只读表的一律是输入,这与 guard 的默认方向一致)。
pub fn op_for_tool(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "computer_apps" => "desktop-apps",
        "computer_elements" => "desktop-elements",
        "computer_wait" => "desktop-wait",
        "computer_click" => "desktop-click",
        "computer_type" => "desktop-type",
        "computer_key" => "desktop-key",
        "computer_paste" => "desktop-paste",
        "computer_scroll" => "desktop-scroll",
        "computer_drag" => "desktop-drag",
        "computer_set_value" => "desktop-set-value",
        "computer_launch" => "desktop-launch",
        _ => return None,
    })
}

/// 该工具是不是输入动作(需要人在当下放行;只读走轻量确认)。
pub fn is_input_tool(tool: &str) -> bool {
    matches!(
        op_for_tool(tool),
        Some(
            "desktop-click"
                | "desktop-type"
                | "desktop-key"
                | "desktop-paste"
                | "desktop-scroll"
                | "desktop-drag"
                | "desktop-set-value"
                | "desktop-launch"
        )
    )
}

// ---------------------------------------------------------------------------
// 参数翻译(纯函数)
// ---------------------------------------------------------------------------

fn number(args: &Map<String, Value>, key: &str) -> Option<u64> {
    args.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    })
}

fn required_number(args: &Map<String, Value>, key: &str, tool: &str) -> Result<u64, String> {
    number(args, key).ok_or_else(|| format!("{tool} 缺少必填参数 {key}(整数)"))
}

fn string<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn required_string<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    tool: &str,
) -> Result<&'a str, String> {
    string(args, key).ok_or_else(|| format!("{tool} 缺少必填参数 {key}"))
}

/// 布尔参数:真值只认 `true`/`"true"`,避免 `"false"` 被当成真。
fn bool_arg(args: &Map<String, Value>, key: &str) -> Option<bool> {
    match args.get(key) {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn bool_or(args: &Map<String, Value>, key: &str, default: bool) -> bool {
    bool_arg(args, key).unwrap_or(default)
}

/// 目标窗口地址:输入动作必须显式给 pid + windowId(驱动也不做隐式选窗)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Target {
    pid: u32,
    window_id: Option<u64>,
}

fn target(args: &Map<String, Value>, tool: &str) -> Result<Target, String> {
    let pid = required_number(args, "processId", tool)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return Err(format!("{tool} 的 processId 不是有效的进程号"));
    }
    Ok(Target {
        pid: pid as u32,
        window_id: number(args, "windowId"),
    })
}

/// 元素编号 / 像素坐标二选一的寻址(与驱动同一套约束)。
fn addressing(args: &Map<String, Value>, tool: &str) -> Result<Option<Value>, String> {
    let element_index = number(args, "elementIndex");
    let x = args.get("x").and_then(Value::as_f64);
    let y = args.get("y").and_then(Value::as_f64);
    match (element_index, x, y) {
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => Err(format!(
            "{tool} 的 elementIndex 与 x/y 只能给一个:元素寻址能用背景投递,像素坐标只用于画布/视频这类没有可访问性节点的目标"
        )),
        (Some(index), None, None) => Ok(Some(json!({ "element_index": index }))),
        (None, Some(x), Some(y)) => Ok(Some(json!({ "x": x, "y": y }))),
        _ => Ok(None),
    }
}

/// 像素坐标寻址是否需要窗口(驱动要求像素点击锚定一个可见窗口)。
fn needs_window_for_pixels(args: &Map<String, Value>) -> bool {
    number(args, "elementIndex").is_none() && args.contains_key("x")
}

/// 工具参数 → (驱动工具名, 驱动参数)。缺参数、越界、模式冲突都在这里拒绝。
///
/// 只读三个工具(等待、观测)不走这张表 —— 它们要么在本地轮询,要么需要
/// 结果整形,由 [`execute`] 单独处理。
pub fn translate(tool: &str, args: &Map<String, Value>) -> Result<(&'static str, Value), String> {
    let delivery = |args: &Map<String, Value>| -> Result<Option<&'static str>, String> {
        match string(args, "deliveryMode") {
            None => Ok(None),
            Some("foreground") => Ok(Some("foreground")),
            Some("background") => Ok(Some("background")),
            Some(other) => Err(format!(
                "deliveryMode 只认 background(默认,不抢焦点)或 foreground,收到 {other}"
            )),
        }
    };
    match tool {
        "computer_apps" => Ok(("list_apps", json!({}))),
        "computer_click" => {
            let target = target(args, tool)?;
            let window_id = target.window_id.ok_or_else(|| {
                "computer_click 缺少必填参数 windowId(windowId 必须属于该 processId;先用 computer_windows 取)"
                    .to_string()
            })?;
            let mut payload = json!({ "pid": target.pid, "window_id": window_id });
            match addressing(args, tool)? {
                Some(addressing) => {
                    merge(&mut payload, addressing);
                }
                None => {
                    return Err(
                        "computer_click 需要 elementIndex,或者 x 与 y 同时给(像素坐标取 computer_elements 回图里的窗口内坐标)"
                            .to_string(),
                    )
                }
            }
            let count = number(args, "count").unwrap_or(1);
            if !(1..=3).contains(&count) {
                return Err("computer_click 的 count 只支持 1~3(双击用 2)".to_string());
            }
            payload["count"] = json!(count);
            let button = string(args, "button").unwrap_or("left");
            if !["left", "right", "middle"].contains(&button) {
                return Err("computer_click 的 button 只支持 left、right、middle".to_string());
            }
            payload["button"] = json!(button);
            if let Some(mode) = delivery(args)? {
                payload["delivery_mode"] = json!(mode);
            }
            if let Some(snapshot) = string(args, "snapshotId") {
                payload["snapshot_id"] = json!(snapshot);
            }
            Ok(("click", payload))
        }
        "computer_type" => {
            let target = target(args, tool)?;
            let text = required_string(args, "text", tool)?;
            let mut payload = json!({ "pid": target.pid, "text": text });
            if let Some(window_id) = target.window_id {
                payload["window_id"] = json!(window_id);
            }
            if let Some(index) = number(args, "elementIndex") {
                payload["element_index"] = json!(index);
            }
            if let Some(delay) = number(args, "delayMs") {
                if delay > 200 {
                    return Err("computer_type 的 delayMs 上限 200(毫秒)".to_string());
                }
                payload["delay_ms"] = json!(delay);
            }
            if let Some(mode) = delivery(args)? {
                payload["delivery_mode"] = json!(mode);
            }
            Ok(("type_text", payload))
        }
        "computer_key" => {
            let target = target(args, tool)?;
            let key = required_string(args, "key", tool)?;
            let modifiers: Vec<&str> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            for modifier in &modifiers {
                if !["ctrl", "shift", "alt", "win"].contains(modifier) {
                    return Err(format!(
                        "computer_key 的 modifiers 只支持 ctrl、shift、alt、win,收到 {modifier}"
                    ));
                }
            }
            let mut payload = json!({ "pid": target.pid });
            if let Some(window_id) = target.window_id {
                payload["window_id"] = json!(window_id);
            }
            if let Some(index) = number(args, "elementIndex") {
                payload["element_index"] = json!(index);
            }
            if let Some(mode) = delivery(args)? {
                payload["delivery_mode"] = json!(mode);
            }
            if modifiers.is_empty() {
                payload["key"] = json!(key);
                Ok(("press_key", payload))
            } else {
                let mut keys: Vec<&str> = modifiers;
                keys.push(key);
                payload["keys"] = json!(keys);
                Ok(("hotkey", payload))
            }
        }
        "computer_scroll" => {
            let target = target(args, tool)?;
            let direction = required_string(args, "direction", tool)?;
            if !["up", "down", "left", "right"].contains(&direction) {
                return Err("computer_scroll 的 direction 只支持 up、down、left、right".to_string());
            }
            let by = string(args, "by").unwrap_or("page");
            if !["page", "line"].contains(&by) {
                return Err("computer_scroll 的 by 只支持 page、line".to_string());
            }
            let amount = number(args, "amount").unwrap_or(1).clamp(1, 50);
            let mut payload = json!({
                "pid": target.pid,
                "direction": direction,
                "by": by,
                "amount": amount,
            });
            if let Some(window_id) = target.window_id {
                payload["window_id"] = json!(window_id);
            }
            if let Some(index) = number(args, "elementIndex") {
                payload["element_index"] = json!(index);
            }
            if let Some(mode) = delivery(args)? {
                payload["delivery_mode"] = json!(mode);
            }
            Ok(("scroll", payload))
        }
        "computer_drag" => {
            let target = target(args, tool)?;
            let mut payload = json!({
                "pid": target.pid,
                "from_x": args.get("fromX").and_then(Value::as_f64).ok_or_else(|| "computer_drag 缺少必填参数 fromX".to_string())?,
                "from_y": args.get("fromY").and_then(Value::as_f64).ok_or_else(|| "computer_drag 缺少必填参数 fromY".to_string())?,
                "to_x": args.get("toX").and_then(Value::as_f64).ok_or_else(|| "computer_drag 缺少必填参数 toX".to_string())?,
                "to_y": args.get("toY").and_then(Value::as_f64).ok_or_else(|| "computer_drag 缺少必填参数 toY".to_string())?,
            });
            if let Some(window_id) = target.window_id {
                payload["window_id"] = json!(window_id);
            }
            if let Some(duration) = number(args, "durationMs") {
                payload["duration_ms"] = json!(duration.clamp(50, 5000));
            }
            if let Some(mode) = delivery(args)? {
                payload["delivery_mode"] = json!(mode);
            }
            Ok(("drag", payload))
        }
        "computer_set_value" => {
            let target = target(args, tool)?;
            let window_id = target
                .window_id
                .ok_or_else(|| "computer_set_value 缺少必填参数 windowId".to_string())?;
            let index = required_number(args, "elementIndex", tool)?;
            let value = args
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "computer_set_value 缺少必填参数 value(字符串)".to_string())?;
            let mut payload = json!({
                "pid": target.pid,
                "window_id": window_id,
                "element_index": index,
                "value": value,
            });
            if let Some(snapshot) = string(args, "snapshotId") {
                payload["snapshot_id"] = json!(snapshot);
            }
            Ok(("set_value", payload))
        }
        "computer_launch" => {
            let name = string(args, "name");
            let path = string(args, "path");
            let launch_path = string(args, "launchPath");
            let mut payload = Map::new();
            if let Some(launch_path) = launch_path {
                payload.insert("launch_path".to_string(), json!(launch_path));
            } else if let Some(path) = path {
                payload.insert("path".to_string(), json!(path));
            } else if let Some(name) = name {
                payload.insert("name".to_string(), json!(name));
            } else {
                return Err(
                    "computer_launch 需要 name(应用名)、path(可执行文件路径)或 launchPath 之一"
                        .to_string(),
                );
            }
            Ok(("launch_app", Value::Object(payload)))
        }
        other => Err(format!("translate 不认识桌面工具 {other}")),
    }
}

/// 浅合并(把寻址片段并进 payload)。
fn merge(base: &mut Value, extra: Value) {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// 动作前裁决(窗口身份 + 标题 + 允许列表)
// ---------------------------------------------------------------------------

/// 目标窗口的可操作事实(裁决通过后回给闸门做敏感判定)。
#[derive(Debug, Clone, Default)]
pub struct TargetFacts {
    pub title: String,
    pub process_name: Option<String>,
}

impl TargetFacts {
    pub fn subject(&self, pid: u32) -> WindowSubject {
        WindowSubject {
            title: self.title.clone(),
            process_id: Some(pid),
            parent_process_id: None,
            process_name: self.process_name.clone(),
        }
    }
}

/// 目标窗口身份裁决:路径与外壳可执行文件相同也算宿主家族。
///
/// 为什么要有这一条:开发模式下壳是 `electron.exe`,机器上别的 Electron
/// 应用同名,不能按映像名拒(会误伤一大片);而按 pid 也挡不住渲染进程
/// (它是壳的子进程,另有 pid)。比 exe 路径是唯一不误伤又挡得住的做法。
pub fn host_path_denial(target_path: Option<&str>, host_paths: &[String]) -> Option<String> {
    let target = target_path?.trim().to_lowercase();
    if target.is_empty() {
        return None;
    }
    host_paths
        .iter()
        .map(|path| path.trim().to_lowercase())
        .any(|path| !path.is_empty() && path == target)
        .then(|| "目标窗口与 CodeMUX 外壳是同一个可执行文件(进程家族),已拒绝输入。".to_string())
}

/// 驱动记录里的窗口字段 → 裁决用事实。
pub fn facts_from_window_record(record: &Value) -> TargetFacts {
    TargetFacts {
        title: record
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        process_name: record
            .get("app_name")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// 窗口级拒绝文案(与观测侧同一套措辞,补一句下一步)。
pub fn denial_message(denial: &policy::AppAccess) -> Option<String> {
    match denial {
        policy::AppAccess::Allowed => None,
        policy::AppAccess::Denied { scope, reason } => Some(format!(
            "目标窗口不可操作({scope}),已拒绝输入。{reason}先用 computer_windows 找可操作的窗口。"
        )),
    }
}

// ---------------------------------------------------------------------------
// 结果整形(纯函数)
// ---------------------------------------------------------------------------

/// 元素上的名字/角色是否命中敏感词:命中就不把它的值回给模型。
fn element_is_sensitive(element: &Value) -> Option<&'static str> {
    let label = element
        .get("label")
        .or_else(|| element.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let role = element.get("role").and_then(Value::as_str).unwrap_or("");
    super::guard::sensitivity_of(&[label, role])
}

/// 敏感控件的值一律脱敏:树里能看见「有这么一个框」,但看不到里面写了什么。
///
/// 返回脱敏条数。密码框的真值(UIA 通常也不给)与验证码、登录表单同一条规矩。
pub fn redact_sensitive_values(elements: &mut [Value]) -> usize {
    let mut redacted = 0;
    for element in elements.iter_mut() {
        if element_is_sensitive(element).is_none() {
            continue;
        }
        let clear = element
            .get("value")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty());
        if clear {
            element["value"] = json!("<已脱敏:敏感控件>");
        }
        if element.get("value").is_some() {
            redacted += 1;
        }
    }
    redacted
}

fn element_label(element: &Value) -> &str {
    element
        .get("label")
        .or_else(|| element.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn element_value(element: &Value) -> Option<&str> {
    element.get("value").and_then(Value::as_str)
}

/// 元素是否命中一个名字(大小写不敏感,可带角色限定)。
fn element_matches(element: &Value, name: &str, role: Option<&str>) -> bool {
    if let Some(role) = role {
        let actual = element.get("role").and_then(Value::as_str).unwrap_or("");
        if !actual.eq_ignore_ascii_case(role) {
            return false;
        }
    }
    element_label(element).to_lowercase() == name.to_lowercase()
}

/// 精确读一个控件的值(照插件的 read_value 规矩:唯一匹配才给值)。
pub fn read_value(elements: &[Value], name: &str, role: Option<&str>) -> Value {
    let matches: Vec<&Value> = elements
        .iter()
        .filter(|element| element_matches(element, name, role))
        .collect();
    match matches.len() {
        0 => json!({
            "status": "unavailable",
            "code": "target_missing",
            "matchCount": 0,
            "note": "没有名字完全匹配的控件;先用 computer_elements 看一遍(名字要与 label 完全一致,可带 role 限定)。",
        }),
        1 => {
            let element = matches[0];
            if let Some(label) = element_is_sensitive(element) {
                return json!({
                    "status": "unavailable",
                    "code": "sensitive_refused",
                    "matchCount": 1,
                    "note": format!("目标控件疑似敏感输入({label}),已拒绝读取它的值。"),
                });
            }
            let mut payload = json!({
                "status": "read",
                "code": "value_read",
                "matchCount": 1,
                "elementIndex": element.get("element_index").cloned().unwrap_or(Value::Null),
                "role": element.get("role").cloned().unwrap_or(Value::Null),
                "label": element_label(element),
            });
            if let Some(value) = element_value(element) {
                payload["value"] = json!(value);
            } else {
                payload["status"] = json!("unavailable");
                payload["code"] = json!("value_missing");
                payload["note"] = json!("该控件没有暴露值(UIA 的 Value/Text 模式都没有)。");
            }
            payload
        }
        count => json!({
            "status": "unavailable",
            "code": "ambiguous_target",
            "matchCount": count,
            "note": "有多个同名控件,不猜;补 role 限定,或改用 elementIndex 寻址。",
        }),
    }
}

/// 等待谓词(与插件同一套 kind,语义按「保守优先」)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    TextPresent,
    TextAbsent,
    ValueEquals,
    ValueChanged,
}

impl WaitKind {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "text_present" => WaitKind::TextPresent,
            "text_absent" => WaitKind::TextAbsent,
            "value_equals" => WaitKind::ValueEquals,
            "value_changed" => WaitKind::ValueChanged,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WaitKind::TextPresent => "text_present",
            WaitKind::TextAbsent => "text_absent",
            WaitKind::ValueEquals => "value_equals",
            WaitKind::ValueChanged => "value_changed",
        }
    }
}

/// 一次轮询的判定结果。
#[derive(Debug, Clone, PartialEq)]
pub enum WaitOutcome {
    Matched(Value),
    Unsatisfied,
    /// 树不完整/目标不唯一 —— 不能当成「还没发生」,也不能当成成功。
    Unknown(&'static str),
}

fn element_contains_text(element: &Value, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    let label = element_label(element).to_lowercase();
    if label.contains(&needle) {
        return true;
    }
    element_value(element)
        .map(|value| value.to_lowercase().contains(&needle))
        .unwrap_or(false)
}

/// 判定一次快照是否满足谓词。`complete` 为假时「不存在」类结论一律 unknown。
pub fn evaluate_wait(
    kind: WaitKind,
    elements: &[Value],
    complete: bool,
    name: Option<&str>,
    text: Option<&str>,
    expected: Option<&str>,
) -> WaitOutcome {
    match kind {
        WaitKind::TextPresent => {
            let needle = text.unwrap_or("");
            match elements.iter().find(|el| element_contains_text(el, needle)) {
                Some(element) => WaitOutcome::Matched(json!({
                    "kind": "text_present",
                    "elementIndex": element.get("element_index").cloned().unwrap_or(Value::Null),
                    "label": element_label(element),
                })),
                None if !complete => WaitOutcome::Unknown("incomplete_tree"),
                None => WaitOutcome::Unsatisfied,
            }
        }
        WaitKind::TextAbsent => {
            let needle = text.unwrap_or("");
            if elements.iter().any(|el| element_contains_text(el, needle)) {
                return WaitOutcome::Unsatisfied;
            }
            if !complete {
                return WaitOutcome::Unknown("incomplete_tree");
            }
            WaitOutcome::Matched(json!({ "kind": "text_absent", "text": needle }))
        }
        WaitKind::ValueEquals | WaitKind::ValueChanged => {
            let name = name.unwrap_or("");
            let matches: Vec<&Value> = elements
                .iter()
                .filter(|el| element_matches(el, name, None))
                .collect();
            if matches.len() > 1 {
                return WaitOutcome::Unknown("ambiguous_target");
            }
            let Some(element) = matches.first() else {
                return if complete {
                    WaitOutcome::Unsatisfied
                } else {
                    WaitOutcome::Unknown("incomplete_tree")
                };
            };
            let Some(value) = element_value(element) else {
                return WaitOutcome::Unknown("value_missing");
            };
            let hit = match kind {
                WaitKind::ValueEquals => {
                    value.to_lowercase() == expected.unwrap_or("").to_lowercase()
                }
                WaitKind::ValueChanged => value != expected.unwrap_or(""),
                _ => unreachable!("上面已按 kind 分流"),
            };
            if !hit {
                return WaitOutcome::Unsatisfied;
            }
            WaitOutcome::Matched(json!({
                "kind": kind.as_str(),
                "elementIndex": element.get("element_index").cloned().unwrap_or(Value::Null),
                "label": element_label(element),
                "value": value,
            }))
        }
    }
}

/// 等待谓词的参数(解析并校验后)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitSpec {
    pub kind: WaitKind,
    /// text_present / text_absent 的待查文本。
    pub text: Option<String>,
    /// value_* 的控件名(与 label 精确匹配)。
    pub name: Option<String>,
    /// value_equals 的目标值 / value_changed 的基线值。
    pub expected: Option<String>,
}

/// 等待谓词的必填项校验(与 evaluate 分开,便于逐例测试文案)。
pub fn validate_wait_args(args: &Map<String, Value>) -> Result<WaitSpec, String> {
    let kind = string(args, "kind")
        .and_then(WaitKind::parse)
        .ok_or_else(|| {
            "computer_wait 缺少必填参数 kind(text_present、text_absent、value_equals、value_changed)"
                .to_string()
        })?;
    let text = string(args, "text").map(str::to_string);
    let name = string(args, "name").map(str::to_string);
    match kind {
        WaitKind::TextPresent | WaitKind::TextAbsent if text.is_none() => {
            Err("computer_wait 的 text_present/text_absent 需要 text".to_string())
        }
        WaitKind::ValueEquals if name.is_none() => {
            Err("computer_wait 的 value_equals 需要 name(控件名)".to_string())
        }
        WaitKind::ValueEquals if string(args, "value").is_none() => {
            Err("computer_wait 的 value_equals 需要 value".to_string())
        }
        WaitKind::ValueChanged if name.is_none() => {
            Err("computer_wait 的 value_changed 需要 name 与 baseline".to_string())
        }
        _ => Ok(WaitSpec {
            kind,
            text,
            name,
            expected: string(args, "value")
                .or_else(|| string(args, "baseline"))
                .map(str::to_string),
        }),
    }
}

/// 输入动作的回执:明确「投递出去了没有」与「不要重放」。
pub fn receipt_line(tool: &str, args: &Map<String, Value>, ok: bool) -> String {
    let pid = number(args, "processId").unwrap_or(0);
    let window = number(args, "windowId")
        .map(|id| id.to_string())
        .unwrap_or_else(|| "未指定".to_string());
    let mode = string(args, "deliveryMode").unwrap_or("background");
    if !ok {
        return "回执:动作未投递(失败在驱动侧),先看错误原文再决定;不要原样重试。".to_string();
    }
    let mut line = format!(
        "回执:{tool} 已交驱动投递(pid={pid}, windowId={window}, 模式={mode});驱动不保证可观测效果,不要重放。"
    );
    if tool == "computer_click" && number(args, "elementIndex").is_none() {
        line.push_str("像素点击只对画布/视频类目标有效,点上没有反应时先 computer_elements 确认目标是否在可访问性树里。");
    }
    line
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/// 一次桌面工具调用的完整链路:驱动就绪 → 参数翻译 → 动作前裁决 → 闸门 →
/// 驱动执行 → 整形 → 审计。
pub(crate) async fn execute(
    ctx: &ServerContext,
    session_id: Option<&str>,
    tool: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let Some(op) = op_for_tool(tool) else {
        return Err(format!("未知桌面工具: {tool}"));
    };

    // 参数翻译放在启驱动之前:写错的调用不该先把驱动拉起来(纯函数,不碰外部)。
    // 只读的三个自己不翻译:等待在本地轮询,观测要整形,应用列表要过滤宿主。
    let translated = match tool {
        "computer_apps" | "computer_elements" | "computer_wait" => None,
        _ => {
            let (driver_tool, payload) = translate(tool, args).inspect_err(|error| {
                audit_row(ctx, op, tool, session_id, false, Some(error));
            })?;
            Some((driver_tool, payload))
        }
    };

    if let Err(error) = ensure_ready(ctx).await {
        audit_row(ctx, op, tool, session_id, false, Some(&error));
        return Err(error);
    }

    match tool {
        "computer_apps" => return read_apps(ctx, session_id, tool, op).await,
        "computer_elements" => return read_elements(ctx, session_id, tool, op, args).await,
        "computer_wait" => return wait(ctx, session_id, tool, op, args).await,
        _ => {}
    }

    let (driver_tool, payload) = translated.expect("已翻译的工具必有驱动调用");
    let target = target(args, tool)?;
    let facts = preflight(ctx, op, tool, session_id, target, args).await?;

    // 闸门:输入动作一次一放行(除非人在本回合给过限时授权),敏感场景逐次确认。
    gate(ctx, session_id, tool, op, args, facts.title.as_str()).await?;

    let driver = &ctx.daemon.companion.inner.driver;
    let result = driver.call_tool(driver_tool, payload).await;
    match result {
        Ok(payload) => {
            audit_row(ctx, op, tool, session_id, true, None);
            Ok(with_receipt(payload, &receipt_line(tool, args, true)))
        }
        Err(error) => {
            audit_row(ctx, op, tool, session_id, false, Some(&error));
            Ok(with_receipt(
                json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
                &receipt_line(tool, args, false),
            ))
        }
    }
}

/// 驱动就绪:电脑控制开关 + 系统级执行 + 驱动在跑(不在跑就按配置拉起)。
async fn ensure_ready(ctx: &ServerContext) -> Result<(), String> {
    let config = ctx.daemon.app.config.lock().unwrap().computer_use.clone();
    if !config.enabled || !config.system_execution_enabled {
        return Err("电脑控制未开启:请在 设置 → 电脑控制 中打开「系统级执行」后重试".to_string());
    }
    let driver = &ctx.daemon.companion.inner.driver;
    if driver.is_running().await {
        return Ok(());
    }
    let spec = super::routes::driver_spec_from_config(&config);
    let Some(spec) = spec else {
        return Err(
            "未检测到电脑控制驱动:先在 设置 → 电脑控制 点「一键安装」(或填入驱动命令)".to_string(),
        );
    };
    driver
        .start(Some(&spec))
        .await
        .map(|_| ())
        .map_err(|error| format!("驱动启动失败: {error}"))
}

/// 宿主家族身份裁决需要的两条事实:目标 exe 路径、外壳 exe 路径。
///
/// 外壳路径不缓存:调试信息是本地标准输入输出的往返(实测几十毫秒),而缓存
/// 会引入「外壳换了可执行文件但缓存还旧」的窗口期 —— 这里宁可多问一次。
async fn host_paths(ctx: &ServerContext) -> Vec<String> {
    let mut paths = Vec::new();
    let driver = &ctx.daemon.companion.inner.driver;
    if let Some(shell_pid) = std::env::var("CODEMUX_SHELL_PID")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
    {
        if let Ok(info) = driver
            .call_tool("debug_window_info", json!({ "pid": shell_pid }))
            .await
        {
            if let Some(path) = info
                .get("structuredContent")
                .and_then(|sc| sc.get("exe_path"))
                .and_then(Value::as_str)
            {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

async fn process_exe_path(ctx: &ServerContext, pid: u32) -> Option<String> {
    let driver = &ctx.daemon.companion.inner.driver;
    let info = driver
        .call_tool("debug_window_info", json!({ "pid": pid }))
        .await
        .ok()?;
    info.get("structuredContent")
        .and_then(|sc| sc.get("exe_path"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 动作前裁决:目标窗口必须存在、属于该 pid,且通过内置拒绝 + 身份 + 允许列表。
///
/// 观测可以事后筛查截图,输入动作事后筛查等于没筛 —— 所以这一关必须在
/// 驱动动作之前跑完。
async fn preflight(
    ctx: &ServerContext,
    op: &str,
    tool: &str,
    session_id: Option<&str>,
    target: Target,
    args: &Map<String, Value>,
) -> Result<TargetFacts, String> {
    let config = ctx.daemon.app.config.lock().unwrap().computer_use.clone();
    let driver = &ctx.daemon.companion.inner.driver;

    // 启动应用没有目标窗口:按应用名/路径走同一条内置拒绝 + 允许列表。
    if tool == "computer_launch" {
        let named = string(args, "name")
            .or_else(|| string(args, "path"))
            .or_else(|| string(args, "launchPath"))
            .unwrap_or("");
        match policy::decide_app_access(named, &config.allowlist) {
            policy::AppAccess::Allowed => {
                gate(ctx, session_id, tool, op, args, named).await?;
                return Ok(TargetFacts {
                    title: named.to_string(),
                    process_name: None,
                });
            }
            denial => {
                let message = format!(
                    "{}已拒绝启动。",
                    denial_message(&denial).unwrap_or_else(|| "该应用不可操作。".to_string())
                );
                audit_row(ctx, op, tool, session_id, false, Some(&message));
                return Err(message);
            }
        }
    }

    let window_id = target
        .window_id
        .ok_or_else(|| format!("{tool} 缺少必填参数 windowId(windowId 必须属于该 processId)"))?;
    if needs_window_for_pixels(args) && target.window_id.is_none() {
        return Err(format!(
            "{tool} 用像素坐标时必须给 windowId:像素点击要锚定一个可见窗口"
        ));
    }
    let listing = driver
        .call_tool("list_windows", json!({ "pid": target.pid }))
        .await
        .map_err(|error| format!("取目标窗口失败: {error}"))?;
    let windows = listing
        .get("structuredContent")
        .and_then(|sc| sc.get("windows"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let record = windows
        .iter()
        .find(|record| record.get("window_id").and_then(Value::as_u64) == Some(window_id))
        .ok_or_else(|| {
            format!(
                "windowId={window_id} 不属于进程 {}(或窗口已关闭);先用 computer_windows 取最新的 windowId",
                target.pid
            )
        })?;
    let facts = facts_from_window_record(record);

    // 身份:自己的 pid/外壳 pid/驱动 pid + 映像名 + 可执行文件路径。
    let protected = protected_processes(ctx).await;
    let subject = facts.subject(target.pid);
    if let Some(denial) = host_path_denial(
        process_exe_path(ctx, target.pid).await.as_deref(),
        &host_paths(ctx).await,
    ) {
        let message = format!("{denial}已拒绝输入。");
        audit_row(ctx, op, tool, session_id, false, Some(&message));
        return Err(message);
    }
    match policy::decide_window_access(&subject, &config.allowlist, &protected) {
        policy::AppAccess::Allowed => Ok(facts),
        denial => {
            let message =
                denial_message(&denial).unwrap_or_else(|| "目标窗口不可操作。".to_string());
            audit_row(ctx, op, tool, session_id, false, Some(&message));
            Err(message)
        }
    }
}

/// 宿主进程家族(与观测侧同一份构造:自己的 pid + 外壳 + 驱动)。
pub(crate) async fn protected_processes(ctx: &ServerContext) -> ProtectedProcesses {
    let shell_pid = std::env::var("CODEMUX_SHELL_PID")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok());
    let driver_pid = ctx.daemon.companion.inner.driver.pid().await;
    ProtectedProcesses::host_family(shell_pid, driver_pid)
}

/// 闸门(与浏览器侧同一条链:审批 + 敏感 + 步数 + 限时授权)。
pub(crate) async fn gate(
    ctx: &ServerContext,
    session_id: Option<&str>,
    tool: &str,
    op: &str,
    args: &Map<String, Value>,
    target_label: &str,
) -> Result<(), String> {
    let params = Value::Object(args.clone());
    let input = super::approval::GateInput {
        session_id,
        tool,
        op,
        params: &params,
        browser_id: None,
        target: Some(target_label),
    };
    super::approval::gate(
        &ctx.daemon.app.clone(),
        &ctx.daemon.companion,
        &ctx.daemon.companion.inner.page_context,
        &input,
    )
    .await
    .map_err(|denied| denied.message)
}

/// 只读:应用清单(过滤宿主家族的进程)。
async fn read_apps(
    ctx: &ServerContext,
    session_id: Option<&str>,
    tool: &str,
    op: &str,
) -> Result<Value, String> {
    gate(ctx, session_id, tool, op, &Map::new(), "").await?;
    let driver = &ctx.daemon.companion.inner.driver;
    let listing = driver
        .call_tool("list_apps", json!({}))
        .await
        .map_err(|error| format!("取应用清单失败: {error}"))?;
    let protected = protected_processes(ctx).await;
    let mut payload = listing;
    if let Some(apps) = payload
        .get_mut("structuredContent")
        .and_then(|sc| sc.get_mut("apps"))
        .and_then(Value::as_array_mut)
    {
        let before = apps.len();
        apps.retain(|app| {
            let pid = app.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
            let name = app.get("name").and_then(Value::as_str).unwrap_or("");
            !protected.contains_pid(Some(pid))
                && !protected.matches_image(name)
                && policy::builtin_deny_scope(name).is_none()
        });
        let hidden = before - apps.len();
        if hidden > 0 {
            payload["hiddenProtected"] = json!(hidden);
        }
    }
    audit_row(ctx, op, tool, session_id, true, None);
    Ok(with_receipt(payload, "回执:应用清单是只读观测。"))
}

/// 只读:窗口可访问性树(可按需读某个控件的值)。
async fn read_elements(
    ctx: &ServerContext,
    session_id: Option<&str>,
    tool: &str,
    op: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let target = target(args, tool)?;
    let window_id = target.window_id.ok_or_else(|| {
        "computer_elements 缺少必填参数 windowId(必须属于该 processId)".to_string()
    })?;
    gate(ctx, session_id, tool, op, args, "").await?;
    let driver = &ctx.daemon.companion.inner.driver;
    let mut payload = driver
        .call_tool(
            "get_window_state",
            json!({
                "pid": target.pid,
                "window_id": window_id,
                "include_accessibility_tree": true,
                "include_screenshot": bool_or(args, "includeScreenshot", true),
                "query": string(args, "query"),
                "max_elements": number(args, "maxElements").unwrap_or(400),
                "max_depth": number(args, "maxDepth").unwrap_or(20),
                "max_image_dimension": number(args, "maxImageDimension").unwrap_or(1280),
            }),
        )
        .await
        .map_err(|error| format!("取窗口状态失败: {error}"))?;

    let mut redacted = 0;
    let mut read_value_result = Value::Null;
    if let Some(state) = payload.get_mut("structuredContent") {
        if let Some(elements) = state.get_mut("elements").and_then(Value::as_array_mut) {
            redacted = redact_sensitive_values(elements);
            if let Some(selector) = args.get("readValue").and_then(Value::as_object) {
                let name = selector
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "readValue 需要 name(控件名)".to_string())?;
                let role = selector.get("role").and_then(Value::as_str);
                read_value_result = read_value(elements, name, role);
            }
        }
    }
    if redacted > 0 {
        payload["redactedValues"] = json!(redacted);
    }
    if !read_value_result.is_null() {
        payload["readValue"] = read_value_result;
    }
    audit_row(ctx, op, tool, session_id, true, None);
    Ok(with_receipt(
        payload,
        "回执:这是只读观测;像素坐标取本回图(窗口内坐标),元素编号只在最近一次本工具之后有效。",
    ))
}

/// 只读:等一个谓词成立(显式轮询;超时不等于成功)。
async fn wait(
    ctx: &ServerContext,
    session_id: Option<&str>,
    tool: &str,
    op: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let target = target(args, tool)?;
    let window_id = target
        .window_id
        .ok_or_else(|| "computer_wait 缺少必填参数 windowId(必须属于该 processId)".to_string())?;
    let spec = validate_wait_args(args)?;
    gate(ctx, session_id, tool, op, args, "").await?;

    let timeout = Duration::from_millis(
        number(args, "timeoutMs")
            .unwrap_or(WAIT_DEFAULT_TIMEOUT_MS)
            .min(WAIT_MAX_TIMEOUT_MS),
    );
    let interval = Duration::from_millis(
        number(args, "pollIntervalMs")
            .unwrap_or(WAIT_DEFAULT_INTERVAL_MS)
            .clamp(100, 5000),
    );
    let driver = &ctx.daemon.companion.inner.driver;
    let deadline = Instant::now() + timeout;
    let started = Instant::now();
    let mut observations = 0u32;
    let mut reason = "predicate_unsatisfied";
    loop {
        observations += 1;
        let state = driver
            .call_tool(
                "get_window_state",
                json!({
                    "pid": target.pid,
                    "window_id": window_id,
                    "include_accessibility_tree": true,
                    "include_screenshot": false,
                    "max_elements": WAIT_TREE_MAX_ELEMENTS,
                    "max_depth": WAIT_TREE_MAX_DEPTH,
                }),
            )
            .await
            .map_err(|error| format!("等待期间的观测失败: {error}"))?;
        let structured = state
            .get("structuredContent")
            .cloned()
            .unwrap_or(Value::Null);
        let elements = structured
            .get("elements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // 完整性以驱动自报为准;它不保证完整时,「不存在」只能算 unknown。
        let complete = structured
            .get("elements_complete")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match evaluate_wait(
            spec.kind,
            &elements,
            complete,
            spec.name.as_deref(),
            spec.text.as_deref(),
            spec.expected.as_deref(),
        ) {
            WaitOutcome::Matched(evidence) => {
                audit_row(ctx, op, tool, session_id, true, None);
                return Ok(json!({
                    "content": [{ "type": "text", "text": format!(
                        "等待满足:{}(观测 {observations} 次,耗时 {}ms)",
                        spec.kind.as_str(),
                        started.elapsed().as_millis()
                    ) }],
                    "structuredContent": {
                        "status": "matched",
                        "kind": spec.kind.as_str(),
                        "evidence": evidence,
                        "observations": observations,
                        "elapsedMs": started.elapsed().as_millis(),
                    },
                }));
            }
            WaitOutcome::Unsatisfied => {}
            WaitOutcome::Unknown(why) => reason = why,
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(interval).await;
    }
    audit_row(
        ctx,
        op,
        tool,
        session_id,
        true,
        Some("等待超时(超时不是成功)"),
    );
    Ok(json!({
        "content": [{ "type": "text", "text": format!(
            "等待超时({}ms,观测 {observations} 次,最后原因={reason})。超时不等于成功:先 computer_elements 看一眼现在到底什么样。",
            started.elapsed().as_millis()
        ) }],
        "structuredContent": {
            "status": "timeout",
            "kind": spec.kind.as_str(),
            "reason": reason,
            "observations": observations,
            "elapsedMs": started.elapsed().as_millis(),
        },
    }))
}

/// 把驱动回包原样带走,前面加一句我们自己的回执(模型先看到纪律,再看细节)。
fn with_receipt(mut payload: Value, receipt: &str) -> Value {
    if let Some(content) = payload.get_mut("content").and_then(Value::as_array_mut) {
        content.insert(0, json!({ "type": "text", "text": receipt }));
        return payload;
    }
    json!({
        "content": [{ "type": "text", "text": receipt }],
        "structuredContent": payload,
    })
}

fn audit_row(
    ctx: &ServerContext,
    op: &str,
    tool: &str,
    session_id: Option<&str>,
    ok: bool,
    error: Option<&str>,
) {
    if let Ok(db) = ctx.daemon.app.db.lock() {
        browser_audit::record_audit(
            &db,
            &AuditRecord {
                op,
                tool: Some(tool),
                browser_id: None,
                session_id,
                actor: "local",
                ok,
                decision: None,
                error,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    // ---- 参数翻译 ----

    #[test]
    fn a_click_needs_exactly_one_addressing_mode() {
        let both =
            args(json!({ "processId": 42, "windowId": 7, "elementIndex": 3, "x": 1.0, "y": 2.0 }));
        assert!(translate("computer_click", &both)
            .unwrap_err()
            .contains("只能给一个"));

        let neither = args(json!({ "processId": 42, "windowId": 7 }));
        assert!(translate("computer_click", &neither)
            .unwrap_err()
            .contains("elementIndex"));

        let by_element =
            args(json!({ "processId": 42, "windowId": 7, "elementIndex": 3, "snapshotId": "s1" }));
        let (tool, payload) = translate("computer_click", &by_element).unwrap();
        assert_eq!(tool, "click");
        assert_eq!(payload["element_index"], json!(3));
        assert_eq!(payload["snapshot_id"], json!("s1"));
        assert_eq!(payload["count"], json!(1));
        assert_eq!(payload["button"], json!("left"));
        assert!(
            payload.get("delivery_mode").is_none(),
            "默认交给驱动(background)"
        );
    }

    #[test]
    fn pixel_clicks_need_a_window_and_a_pixel_source() {
        let pixels =
            args(json!({ "processId": 42, "windowId": 7, "x": 12.5, "y": 30.0, "count": 2 }));
        let (tool, payload) = translate("computer_click", &pixels).unwrap();
        assert_eq!(tool, "click");
        assert_eq!(payload["count"], json!(2));
        assert_eq!(payload["x"], json!(12.5));

        let no_window = args(json!({ "processId": 42, "x": 1.0, "y": 2.0 }));
        assert!(translate("computer_click", &no_window)
            .unwrap_err()
            .contains("windowId"));
    }

    #[test]
    fn a_key_with_modifiers_becomes_a_hotkey() {
        let plain = args(json!({ "processId": 42, "key": "return" }));
        let (tool, payload) = translate("computer_key", &plain).unwrap();
        assert_eq!(tool, "press_key");
        assert_eq!(payload["key"], json!("return"));

        let chord =
            args(json!({ "processId": 42, "windowId": 7, "key": "s", "modifiers": ["ctrl"] }));
        let (tool, payload) = translate("computer_key", &chord).unwrap();
        assert_eq!(tool, "hotkey");
        assert_eq!(payload["keys"], json!(["ctrl", "s"]));

        let bad = args(json!({ "processId": 42, "key": "s", "modifiers": ["hyper"] }));
        assert!(translate("computer_key", &bad)
            .unwrap_err()
            .contains("hyper"));
    }

    #[test]
    fn launch_accepts_one_of_the_three_addresses() {
        let (tool, payload) =
            translate("computer_launch", &args(json!({ "name": "记事本" }))).unwrap();
        assert_eq!(tool, "launch_app");
        assert_eq!(payload["name"], json!("记事本"));
        assert!(translate("computer_launch", &args(json!({})))
            .unwrap_err()
            .contains("name"));
    }

    #[test]
    fn obvious_parameter_mistakes_are_refused_locally() {
        let click = args(json!({ "processId": 42, "windowId": 7, "x": 1.0, "y": 2.0, "count": 9 }));
        assert!(translate("computer_click", &click)
            .unwrap_err()
            .contains("count"));
        let scroll = args(json!({ "processId": 42, "direction": "sideways" }));
        assert!(translate("computer_scroll", &scroll)
            .unwrap_err()
            .contains("direction"));
        let typo = args(json!({ "processId": 42, "text": "hi", "deliveryMode": "foregrounds" }));
        assert!(translate("computer_type", &typo)
            .unwrap_err()
            .contains("deliveryMode"));
    }

    // ---- 动作前裁决 ----

    #[test]
    fn the_same_executable_path_as_the_shell_is_a_host_window() {
        // 开发模式下壳是 electron.exe:按名字不能拒(误伤别的 Electron 应用),
        // 按 pid 也挡不住渲染进程 —— 比 exe 路径是唯一挡得住又不误伤的做法。
        let denial = host_path_denial(
            Some("C:\\app\\node_modules\\electron\\dist\\electron.exe"),
            &["c:\\app\\node_modules\\electron\\dist\\electron.exe".to_string()],
        );
        assert!(denial.is_some(), "同路径必须拒");

        assert!(
            host_path_denial(
                Some("C:\\Windows\\System32\\notepad.exe"),
                &["C:\\app\\electron.exe".to_string()],
            )
            .is_none(),
            "不同路径不能误伤"
        );
        assert!(host_path_denial(None, &["C:\\app\\electron.exe".to_string()]).is_none());
    }

    #[test]
    fn a_builtin_denied_title_blocks_input_with_a_next_step() {
        let facts = TargetFacts {
            title: "CodeMUX".to_string(),
            process_name: Some("electron.exe".to_string()),
        };
        let protected = ProtectedProcesses::host_family(None, None);
        let denial = policy::decide_window_access(&facts.subject(1234), &[], &protected);
        let message = denial_message(&denial).expect("必须拒绝");
        assert!(message.contains("CodeMUX 自身与安装更新器"), "{message}");
        assert!(
            message.contains("computer_windows"),
            "要给下一步: {message}"
        );
    }

    #[test]
    fn a_terminal_window_is_denied_by_image_name() {
        let facts = TargetFacts {
            title: "PowerShell".to_string(),
            process_name: Some("powershell.exe".to_string()),
        };
        let protected = ProtectedProcesses::host_family(None, None);
        let denial = policy::decide_window_access(&facts.subject(999), &[], &protected);
        assert!(denial_message(&denial).unwrap().contains("终端"));
    }

    // ---- 结果整形 ----

    #[test]
    fn sensitive_values_are_redacted_from_the_tree() {
        let mut elements = vec![
            json!({ "element_index": 1, "role": "edit", "label": "用户名", "value": "alice" }),
            json!({ "element_index": 2, "role": "edit", "label": "密码", "value": "hunter2" }),
            json!({ "element_index": 3, "role": "edit", "label": "验证码", "value": "123456" }),
        ];
        let redacted = redact_sensitive_values(&mut elements);
        assert_eq!(elements[0]["value"], json!("alice"), "普通输入不动");
        assert_eq!(redacted, 2);
        assert!(elements[1]["value"].as_str().unwrap().contains("已脱敏"));
        assert!(elements[2]["value"].as_str().unwrap().contains("已脱敏"));
    }

    #[test]
    fn read_value_refuses_ambiguity_and_sensitive_controls() {
        let elements = vec![
            json!({ "element_index": 1, "role": "edit", "label": "文件名", "value": "报告.docx" }),
            json!({ "element_index": 2, "role": "edit", "label": "文件名", "value": "另一份.docx" }),
            json!({ "element_index": 3, "role": "edit", "label": "密码", "value": "hunter2" }),
        ];
        let ambiguous = read_value(&elements, "文件名", None);
        assert_eq!(ambiguous["status"], json!("unavailable"));
        assert_eq!(ambiguous["matchCount"], json!(2));
        assert_eq!(
            read_value(&elements, "文件名", Some("edit"))["matchCount"],
            json!(2)
        );

        let missing = read_value(&elements, "不存在的框", None);
        assert_eq!(missing["code"], json!("target_missing"));

        let sensitive = read_value(&elements, "密码", None);
        assert_eq!(sensitive["code"], json!("sensitive_refused"));
        assert!(sensitive.get("value").is_none(), "敏感值一个字节都不回");
    }

    #[test]
    fn read_value_returns_the_exact_value_when_unique() {
        let elements = vec![json!({
            "element_index": 4, "role": "edit", "label": "文件名", "value": ""
        })];
        let read = read_value(&elements, "文件名", None);
        assert_eq!(read["status"], json!("read"));
        assert_eq!(read["value"], json!(""), "空串是真实的值,不能当缺失");
    }

    // ---- 等待谓词 ----

    #[test]
    fn text_presence_is_provable_even_on_an_incomplete_tree() {
        let elements = vec![json!({ "element_index": 1, "role": "text", "label": "保存成功" })];
        assert!(matches!(
            evaluate_wait(
                WaitKind::TextPresent,
                &elements,
                false,
                None,
                Some("保存成功"),
                None
            ),
            WaitOutcome::Matched(_)
        ));
        // 找不到 + 树不完整 = unknown,不能当「还没发生」也不能当成功。
        assert_eq!(
            evaluate_wait(
                WaitKind::TextPresent,
                &[],
                false,
                None,
                Some("保存成功"),
                None
            ),
            WaitOutcome::Unknown("incomplete_tree")
        );
        assert_eq!(
            evaluate_wait(
                WaitKind::TextPresent,
                &[],
                true,
                None,
                Some("保存成功"),
                None
            ),
            WaitOutcome::Unsatisfied
        );
    }

    #[test]
    fn absence_requires_a_complete_tree() {
        let present = vec![json!({ "element_index": 1, "role": "text", "label": "正在保存…" })];
        assert_eq!(
            evaluate_wait(
                WaitKind::TextAbsent,
                &present,
                true,
                None,
                Some("正在保存"),
                None
            ),
            WaitOutcome::Unsatisfied
        );
        assert!(matches!(
            evaluate_wait(
                WaitKind::TextAbsent,
                &[],
                true,
                None,
                Some("正在保存"),
                None
            ),
            WaitOutcome::Matched(_)
        ));
        assert_eq!(
            evaluate_wait(
                WaitKind::TextAbsent,
                &[],
                false,
                None,
                Some("正在保存"),
                None
            ),
            WaitOutcome::Unknown("incomplete_tree")
        );
    }

    #[test]
    fn value_predicates_need_exactly_one_candidate() {
        let two = vec![
            json!({ "element_index": 1, "role": "edit", "label": "文件名", "value": "a.docx" }),
            json!({ "element_index": 2, "role": "edit", "label": "文件名", "value": "b.docx" }),
        ];
        assert_eq!(
            evaluate_wait(
                WaitKind::ValueEquals,
                &two,
                true,
                Some("文件名"),
                None,
                Some("a.docx")
            ),
            WaitOutcome::Unknown("ambiguous_target")
        );

        let one = vec![
            json!({ "element_index": 1, "role": "edit", "label": "文件名", "value": "a.docx" }),
        ];
        assert!(matches!(
            evaluate_wait(
                WaitKind::ValueEquals,
                &one,
                true,
                Some("文件名"),
                None,
                Some("A.DOCX")
            ),
            WaitOutcome::Matched(_)
        ));
        assert_eq!(
            evaluate_wait(
                WaitKind::ValueChanged,
                &one,
                true,
                Some("文件名"),
                None,
                Some("a.docx")
            ),
            WaitOutcome::Unsatisfied
        );
        assert!(matches!(
            evaluate_wait(
                WaitKind::ValueChanged,
                &one,
                true,
                Some("文件名"),
                None,
                Some("b.docx")
            ),
            WaitOutcome::Matched(_)
        ));
    }

    #[test]
    fn wait_kinds_are_named_and_validated() {
        assert!(validate_wait_args(&args(json!({ "kind": "text_present" })))
            .unwrap_err()
            .contains("text"));
        assert!(
            validate_wait_args(&args(json!({ "kind": "value_equals", "name": "文件名" })))
                .unwrap_err()
                .contains("value")
        );
        assert!(validate_wait_args(&args(json!({ "kind": "随便" })))
            .unwrap_err()
            .contains("kind"));
        let spec =
            validate_wait_args(&args(json!({ "kind": "text_absent", "text": "保存中" }))).unwrap();
        assert_eq!(spec.kind, WaitKind::TextAbsent);
        assert_eq!(spec.text.as_deref(), Some("保存中"));
    }

    // ---- 回执与 op 面 ----

    #[test]
    fn the_receipt_says_what_was_sent_and_forbids_replay() {
        let click = args(json!({ "processId": 42, "windowId": 7, "x": 1.0, "y": 2.0 }));
        let line = receipt_line("computer_click", &click, true);
        assert!(line.contains("pid=42") && line.contains("windowId=7"));
        assert!(line.contains("不要重放"));
        assert!(
            line.contains("可访问性树"),
            "像素点击要提醒先确认目标: {line}"
        );

        let failed = receipt_line("computer_click", &click, false);
        assert!(failed.contains("未投递"));
    }

    #[test]
    fn the_tool_table_matches_the_gate_classification() {
        for tool in DESKTOP_TOOL_NAMES {
            let op = op_for_tool(tool).unwrap_or_else(|| panic!("{tool} 缺 op"));
            let class = super::super::guard::classify(op);
            if is_input_tool(tool) {
                assert_eq!(
                    class,
                    super::super::guard::RiskClass::Input,
                    "{tool} 是输入动作,必须按输入收口"
                );
            } else {
                assert_eq!(
                    class,
                    super::super::guard::RiskClass::ReadOnly,
                    "{tool} 是只读,应列进 READ_ONLY_OPS"
                );
            }
        }
        assert!(op_for_tool("computer_teleport").is_none());
    }
}
