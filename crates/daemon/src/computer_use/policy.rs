//! 可操作范围裁决(需求 13、14):允许列表 + 不可删除的内置拒绝列表。
//!
//! 规则只有两条,但顺序不能反:
//!
//! 1. **内置拒绝永远优先**:密码管理器、终端、锁屏、Windows 安全中心,以及
//!    CodeMUX 自己、安装器和更新器 —— 允许列表写了也没用;
//! 2. **允许列表为空表示「除拒绝外全部可操作」**:非空时只有列进去的应用
//!    可操作,其余按不在列表内拒绝。
//!
//! 判定是纯函数(应用名 + 允许列表 → 裁决),UI 与执行器共用同一份。

/// 内置拒绝列表:`(匹配词, 面向用户的范围名)`,全部小写子串匹配。
///
/// 最后一条 `codemux` 覆盖宿主自身与安装器/更新器:防止智能体操作自己的
/// 宿主窗口(递归失控),也包括 NSIS 安装器与更新器进程。
pub const BUILTIN_DENY: &[(&str, &str)] = &[
    // 密码管理器
    ("1password", "密码管理器"),
    ("bitwarden", "密码管理器"),
    ("lastpass", "密码管理器"),
    ("keepass", "密码管理器"),
    ("dashlane", "密码管理器"),
    ("keeper security", "密码管理器"),
    ("密码管理器", "密码管理器"),
    // 终端
    ("powershell", "终端"),
    ("cmd.exe", "终端"),
    ("windows terminal", "终端"),
    ("conhost", "终端"),
    ("putty", "终端"),
    ("终端", "终端"),
    // 锁屏
    ("logonui", "锁屏"),
    ("lock screen", "锁屏"),
    ("锁定屏幕", "锁屏"),
    // Windows 安全中心
    ("windows security", "Windows 安全中心"),
    ("windows defender", "Windows 安全中心"),
    ("securityhealth", "Windows 安全中心"),
    ("安全中心", "Windows 安全中心"),
    // 宿主自身 / 安装器 / 更新器
    ("codemux", "CodeMUX 自身与安装更新器"),
];

/// 一次可操作性裁决。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAccess {
    Allowed,
    Denied { scope: String, reason: String },
}

impl AppAccess {
    pub fn is_allowed(&self) -> bool {
        matches!(self, AppAccess::Allowed)
    }
}

/// 归一化:小写、去首尾空白。
fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// 命中的内置拒绝范围(未命中返回 None)。
pub fn builtin_deny_scope(app_name: &str) -> Option<&'static str> {
    let name = normalize(app_name);
    if name.is_empty() {
        return None;
    }
    BUILTIN_DENY
        .iter()
        .find(|(needle, _)| name.contains(needle))
        .map(|(_, scope)| *scope)
}

/// 是否在允许列表内(空列表恒为真)。
pub fn in_allowlist(app_name: &str, allowlist: &[String]) -> bool {
    let entries: Vec<String> = allowlist
        .iter()
        .map(|entry| normalize(entry))
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.is_empty() {
        return true;
    }
    let name = normalize(app_name);
    entries.iter().any(|entry| name.contains(entry.as_str()))
}

/// 裁决某应用能否被操作。
pub fn decide_app_access(app_name: &str, allowlist: &[String]) -> AppAccess {
    if let Some(scope) = builtin_deny_scope(app_name) {
        return AppAccess::Denied {
            scope: scope.to_string(),
            reason: format!("{scope}在不可操作范围内(内置拒绝列表,不可删除)"),
        };
    }
    if in_allowlist(app_name, allowlist) {
        return AppAccess::Allowed;
    }
    AppAccess::Denied {
        scope: "允许列表".to_string(),
        reason: "该应用不在允许列表内:请在 设置 → 电脑控制 的允许列表里加上它".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowlist(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    #[test]
    fn password_managers_are_always_denied() {
        for name in [
            "1Password",
            "Bitwarden - 我的保险库",
            "KeePassXC",
            "Dashlane",
        ] {
            let access = decide_app_access(name, &allowlist(&["1password", "bitwarden"]));
            assert!(!access.is_allowed(), "{name} 必须被拒绝");
            match access {
                AppAccess::Denied { scope, .. } => assert_eq!(scope, "密码管理器"),
                AppAccess::Allowed => unreachable!(),
            }
        }
    }

    #[test]
    fn terminals_lock_screen_and_security_center_are_denied() {
        let cases = [
            ("Windows PowerShell", "终端"),
            ("命令提示符 - cmd.exe", "终端"),
            ("Windows Terminal", "终端"),
            ("Windows 安全中心", "Windows 安全中心"),
            ("Windows Defender 防火墙", "Windows 安全中心"),
            ("Lock Screen", "锁屏"),
        ];
        for (name, expected_scope) in cases {
            match decide_app_access(name, &[]) {
                AppAccess::Denied { scope, .. } => assert_eq!(scope, expected_scope, "{name}"),
                AppAccess::Allowed => panic!("{name} 必须被拒绝"),
            }
        }
    }

    #[test]
    fn the_host_itself_installer_and_updater_are_denied() {
        for name in ["CodeMUX", "CodeMUX Setup", "codemux-daemon 更新器"] {
            match decide_app_access(name, &allowlist(&["codemux"])) {
                AppAccess::Denied { scope, .. } => assert_eq!(scope, "CodeMUX 自身与安装更新器"),
                AppAccess::Allowed => panic!("{name} 必须被拒绝:允许列表写自己也不行"),
            }
        }
    }

    #[test]
    fn empty_allowlist_means_everything_else_is_allowed() {
        assert!(decide_app_access("记事本", &[]).is_allowed());
        assert!(decide_app_access("Visual Studio Code", &allowlist(&["", "  "])).is_allowed());
    }

    #[test]
    fn non_empty_allowlist_restricts_to_listed_apps() {
        let list = allowlist(&["Notepad", "记事本"]);
        assert!(decide_app_access("记事本", &list).is_allowed());
        assert!(decide_app_access("Notepad++", &list).is_allowed());
        match decide_app_access("Excel", &list) {
            AppAccess::Denied { scope, reason } => {
                assert_eq!(scope, "允许列表");
                assert!(reason.contains("不在允许列表内"));
            }
            AppAccess::Allowed => panic!("Excel 不在允许列表内,必须拒绝"),
        }
    }

    #[test]
    fn matching_is_case_insensitive_and_trimmed() {
        assert!(decide_app_access("  NOTEPAD  ", &allowlist(&[" notepad "])).is_allowed());
        assert_eq!(builtin_deny_scope(" 1PASSWORD "), Some("密码管理器"));
    }

    #[test]
    fn blank_app_names_never_match_the_deny_list() {
        assert_eq!(builtin_deny_scope(""), None);
        assert_eq!(builtin_deny_scope("   "), None);
    }
}

/// 桌面只读回包筛查(需求 14):命中内置拒绝或不在允许列表的窗口既不截图
/// 也不列举。
///
/// - `desktop-windows`:从清单里删掉不可操作的窗口(模型看不到它们存在);
/// - `desktop-active-window`:前台窗口不可操作时整体拒绝 —— 只说范围名,
///   不复述窗口标题(标题本身可能就是敏感信息);
/// - `desktop-screenshot`:窗口截图按来源名裁决;整屏截图按**前台窗口**裁决
///   —— 前台是受保护应用时拒绝(整屏会把它拍进去),切走或指定窗口来源后可截。
pub fn screen_desktop_payload(
    op: &str,
    payload: &serde_json::Value,
    allowlist: &[String],
) -> Result<serde_json::Value, String> {
    match op {
        "desktop-windows" => {
            let Some(items) = payload.as_array() else {
                return Ok(payload.clone());
            };
            let filtered: Vec<serde_json::Value> = items
                .iter()
                .filter(|item| {
                    let name = item
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let is_screen =
                        item.get("kind").and_then(|value| value.as_str()) == Some("screen");
                    is_screen || decide_app_access(name, allowlist).is_allowed()
                })
                .cloned()
                .collect();
            Ok(serde_json::Value::Array(filtered))
        }
        "desktop-active-window" => {
            let name = payload
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            match decide_app_access(name, allowlist) {
                AppAccess::Allowed => Ok(payload.clone()),
                AppAccess::Denied { scope, reason } => Err(format!(
                    "当前前台窗口属于不可操作范围({scope}),已拒绝读取。{reason}"
                )),
            }
        }
        "desktop-screenshot" => {
            let kind = payload
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if kind != "window" {
                // 整屏截图不按来源名筛,但前台若是受保护应用就要拒绝:整屏会把
                // 密码管理器一并拍进去,而只读观测没有像素级打码能力。
                let foreground = payload
                    .get("foregroundTitle")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let AppAccess::Denied { scope, .. } = decide_app_access(foreground, allowlist) {
                    return Err(format!(
                        "前台窗口属于不可操作范围({scope}),整屏截图会把它一并拍下,已拒绝。请先切到别的窗口再截,或指定可截的窗口来源。"
                    ));
                }
                return Ok(payload.clone());
            }
            let name = payload
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            match decide_app_access(name, allowlist) {
                AppAccess::Allowed => Ok(payload.clone()),
                AppAccess::Denied { scope, reason } => Err(format!(
                    "该窗口属于不可操作范围({scope}),已拒绝截图。{reason}"
                )),
            }
        }
        _ => Ok(payload.clone()),
    }
}

#[cfg(test)]
mod screening_tests {
    use super::*;
    use serde_json::json;

    fn allowlist(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    #[test]
    fn window_listing_hides_denied_windows_but_keeps_screens() {
        let payload = json!([
            { "id": "screen:0:0", "name": "整个屏幕", "kind": "screen" },
            { "id": "window:1:0", "name": "记事本", "kind": "window" },
            { "id": "window:2:0", "name": "1Password", "kind": "window" },
            { "id": "window:3:0", "name": "CodeMUX", "kind": "window" },
        ]);
        let screened = screen_desktop_payload("desktop-windows", &payload, &[]).expect("筛查通过");
        let names: Vec<&str> = screened
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["整个屏幕", "记事本"]);
    }

    #[test]
    fn active_window_refusal_does_not_echo_the_window_title() {
        let payload = json!({ "title": "Bitwarden - 我的保险库", "processId": 42 });
        let error = screen_desktop_payload("desktop-active-window", &payload, &[])
            .expect_err("密码管理器前台窗口必须拒绝");
        assert!(error.contains("密码管理器"));
        assert!(
            !error.contains("Bitwarden"),
            "拒绝文案不该复述窗口标题: {error}"
        );
    }

    #[test]
    fn window_screenshot_is_refused_for_denied_apps_only() {
        let denied = json!({ "name": "Windows PowerShell", "kind": "window", "sourceId": "w1" });
        assert!(screen_desktop_payload("desktop-screenshot", &denied, &[]).is_err());

        let screen = json!({ "name": "整个屏幕", "kind": "screen", "sourceId": "s1" });
        assert!(screen_desktop_payload("desktop-screenshot", &screen, &[]).is_ok());

        let allowed = json!({ "name": "记事本", "kind": "window", "sourceId": "w2" });
        assert!(screen_desktop_payload("desktop-screenshot", &allowed, &[]).is_ok());
    }

    #[test]
    fn allowlist_restricts_window_screenshots() {
        let notepad = json!({ "name": "记事本", "kind": "window", "sourceId": "w2" });
        assert!(
            screen_desktop_payload("desktop-screenshot", &notepad, &allowlist(&["Excel"])).is_err()
        );
        assert!(
            screen_desktop_payload("desktop-screenshot", &notepad, &allowlist(&["记事本"])).is_ok()
        );
    }

    #[test]
    fn screen_capture_is_refused_when_a_protected_app_is_in_the_foreground() {
        let screen = json!({
            "name": "整个屏幕",
            "kind": "screen",
            "sourceId": "s1",
            "foregroundTitle": "1Password",
        });
        let error = screen_desktop_payload("desktop-screenshot", &screen, &[])
            .expect_err("前台是密码管理器时整屏截图必须拒绝");
        assert!(error.contains("密码管理器"));
        assert!(
            !error.contains("1Password"),
            "拒绝文案不该复述窗口标题: {error}"
        );

        let benign = json!({
            "name": "整个屏幕",
            "kind": "screen",
            "sourceId": "s1",
            "foregroundTitle": "记事本",
        });
        assert!(screen_desktop_payload("desktop-screenshot", &benign, &[]).is_ok());

        // 读不到前台标题(非 Windows)时不误伤。
        let unknown = json!({ "name": "整个屏幕", "kind": "screen", "sourceId": "s1" });
        assert!(screen_desktop_payload("desktop-screenshot", &unknown, &[]).is_ok());
    }

    #[test]
    fn browser_ops_pass_through_untouched() {
        let payload = json!({ "elements": 3 });
        assert_eq!(
            screen_desktop_payload("snapshot", &payload, &[]).expect("浏览器 op 不筛"),
            payload
        );
    }
}
