//! 可操作范围裁决(需求 13、14):允许列表 + 不可删除的内置拒绝列表。
//! 工单 11 起内置拒绝多了「按进程身份」那一半:宿主自己的窗口可能没有标题
//! (自绘无边框窗、驱动面板、DevTools),只靠标题串匹配挡不住。
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

// ---------------------------------------------------------------------------
// 宿主进程家族(工单 11):内置拒绝的「按身份」那一半。
// ---------------------------------------------------------------------------

/// 宿主家族的进程映像名(小写比较,`.exe` 后缀可省)。
///
/// 刻意**不含 `electron`**:开发模式下壳是 `electron.exe`,但机器上别的
/// Electron 应用(编辑器、聊天工具)也是这个名字,按名字拒会误伤一大片 ——
/// 开发模式由父进程号兜住(壳的渲染进程是壳的子进程)。
pub const HOST_IMAGE_NAMES: &[&str] = &["codemux", "codemux-daemon", "cua-driver"];

/// 宿主进程家族:自己的 pid、外壳的 pid(壳经 `CODEMUX_SHELL_PID` 告知)、
/// 正在跑的驱动 pid,以及自己的映像名。
///
/// 为什么需要它:标题串匹配挡不住没有标题的窗口 —— 自绘的无边框窗口、驱动
/// 面板、DevTools 都可能没有标题或标题随手改,而宿主自己的窗口被模型看到或
/// 截到,等于把控制台递给了它自己。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProtectedProcesses {
    pub pids: Vec<u32>,
    pub image_names: Vec<String>,
}

impl ProtectedProcesses {
    /// 组装宿主家族名单(pid 去重排序,便于比较与测试)。
    pub fn host_family(shell_pid: Option<u32>, driver_pid: Option<u32>) -> Self {
        let mut pids = vec![std::process::id()];
        pids.extend(shell_pid.filter(|pid| *pid != 0));
        pids.extend(driver_pid.filter(|pid| *pid != 0));
        pids.sort_unstable();
        pids.dedup();
        Self {
            pids,
            image_names: HOST_IMAGE_NAMES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }

    /// 进程号是否属于宿主家族(`None` = 身份未知,不命中)。
    pub fn contains_pid(&self, pid: Option<u32>) -> bool {
        pid.is_some_and(|pid| self.pids.contains(&pid))
    }

    /// 映像名是否属于宿主家族(大小写不敏感,`.exe` 后缀可省)。
    pub fn matches_image(&self, image_name: &str) -> bool {
        let stem = image_stem(image_name);
        if stem.is_empty() {
            return false;
        }
        self.image_names.contains(&stem)
    }
}

/// 映像名归一化:`CodeMUX.exe` → `codemux`。
fn image_stem(image_name: &str) -> String {
    let lowered = image_name.trim().to_lowercase();
    match lowered.strip_suffix(".exe") {
        Some(stem) => stem.to_string(),
        None => lowered,
    }
}

/// 一个待裁决窗口的「名字 + 身份」。
#[derive(Debug, Clone, Default)]
pub struct WindowSubject {
    /// 窗口标题(界面上显示的名字);可能为空。
    pub title: String,
    pub process_id: Option<u32>,
    pub parent_process_id: Option<u32>,
    pub process_name: Option<String>,
}

impl WindowSubject {
    /// 从 payload 里抽(title 字段名按 op 不同:`name` 或 `title`)。
    pub fn from_value(value: &serde_json::Value, title_key: &str) -> Self {
        let number = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .and_then(|raw| u32::try_from(raw).ok())
                .filter(|pid| *pid > 0)
        };
        Self {
            title: value
                .get(title_key)
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            process_id: number("processId"),
            parent_process_id: number("parentProcessId"),
            process_name: value
                .get("processName")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        }
    }
}

/// 裁决一个窗口能否被操作。规则按「更具体的那条先说」排:
///
/// 1. 标题命中内置拒绝词表 → 就报内置拒绝(人类可读、能解释是哪条规则);
/// 2. 进程身份命中(自己的 pid / 外壳的 pid / 驱动 pid / 宿主子进程 / 宿主映像名)
///    → 报进程家族 —— 标题缺失或被改时,挡得住的就是这一层;
/// 3. 否则按允许列表(空列表 = 除拒绝外全部可操作)。
///
/// 三条都不接受允许列表的覆盖(与内置拒绝同一条铁律)。
pub fn decide_window_access(
    subject: &WindowSubject,
    allowlist: &[String],
    protected: &ProtectedProcesses,
) -> AppAccess {
    if let Some(scope) = builtin_deny_scope(&subject.title) {
        return AppAccess::Denied {
            scope: scope.to_string(),
            reason: format!("{scope}在不可操作范围内(内置拒绝列表,不可删除)"),
        };
    }
    let identity_hit = protected.contains_pid(subject.process_id)
        || protected.contains_pid(subject.parent_process_id)
        || subject
            .process_name
            .as_deref()
            .is_some_and(|name| protected.matches_image(name));
    if identity_hit {
        return AppAccess::Denied {
            scope: "CodeMUX 进程家族".to_string(),
            reason: "该窗口属于 CodeMUX 自己(外壳/守护进程/驱动),不在可操作范围内(按进程身份拒绝,不可删除)"
                .to_string(),
        };
    }
    decide_app_access(&subject.title, allowlist)
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

/// 桌面只读回包筛查(需求 14、工单 11):命中内置拒绝、宿主进程家族或不在
/// 允许列表的窗口既不截图也不列举。
///
/// - `desktop-windows`:从清单里删掉不可操作的窗口(模型看不到它们存在);
/// - `desktop-active-window`:前台窗口不可操作时整体拒绝 —— 只说范围名,
///   不复述窗口标题(标题本身可能就是敏感信息);
/// - `desktop-screenshot`:窗口截图按来源身份/名称裁决;整屏截图按**前台窗口**
///   裁决 —— 前台是受保护应用时拒绝(整屏会把它拍进去),切走或指定窗口来源后可截。
///
/// 身份(pid / 父进程 / 映像名)由壳随 payload 报上来;身份缺失时退回按标题
/// 裁决(非 Windows 平台没有这份事实),不会因此拒绝一切。
pub fn screen_desktop_payload(
    op: &str,
    payload: &serde_json::Value,
    allowlist: &[String],
    protected: &ProtectedProcesses,
) -> Result<serde_json::Value, String> {
    match op {
        "desktop-windows" => {
            let Some(items) = payload.as_array() else {
                return Ok(payload.clone());
            };
            let filtered: Vec<serde_json::Value> = items
                .iter()
                .filter(|item| {
                    let is_screen =
                        item.get("kind").and_then(|value| value.as_str()) == Some("screen");
                    is_screen
                        || decide_window_access(
                            &WindowSubject::from_value(item, "name"),
                            allowlist,
                            protected,
                        )
                        .is_allowed()
                })
                .cloned()
                .collect();
            Ok(serde_json::Value::Array(filtered))
        }
        "desktop-active-window" => {
            match decide_window_access(
                &WindowSubject::from_value(payload, "title"),
                allowlist,
                protected,
            ) {
                AppAccess::Allowed => Ok(payload.clone()),
                AppAccess::Denied { scope, reason } => Err(format!(
                    "当前前台窗口属于不可操作范围({scope}),已拒绝读取。{reason}可以先用 computer_windows 看看有哪些可操作的窗口。"
                )),
            }
        }
        "desktop-screenshot" => {
            let kind = payload
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if kind != "window" {
                // 整屏截图不按来源名筛,但前台若是受保护应用(按身份或名称)就要拒绝:
                // 整屏会把密码管理器/宿主自己一并拍进去,而只读观测没有像素级打码能力。
                let foreground = WindowSubject {
                    title: payload
                        .get("foregroundTitle")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string(),
                    process_id: payload
                        .get("foregroundProcessId")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|raw| u32::try_from(raw).ok()),
                    parent_process_id: payload
                        .get("foregroundParentProcessId")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|raw| u32::try_from(raw).ok()),
                    process_name: payload
                        .get("foregroundProcessName")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                };
                if let AppAccess::Denied { scope, .. } =
                    decide_window_access(&foreground, allowlist, protected)
                {
                    return Err(format!(
                        "前台窗口属于不可操作范围({scope}),整屏截图会把它一并拍下,已拒绝。请先切到别的窗口,或用 computer_windows 取窗口来源后带 sourceId 截那个窗口。"
                    ));
                }
                return Ok(payload.clone());
            }
            match decide_window_access(
                &WindowSubject::from_value(payload, "name"),
                allowlist,
                protected,
            ) {
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

    /// 一个「有身份但都不是宿主」的名单:宿主家族为空,便于隔离名称规则。
    fn no_hosts() -> ProtectedProcesses {
        ProtectedProcesses {
            pids: Vec::new(),
            image_names: Vec::new(),
        }
    }

    /// 宿主家族:pid 4242(外壳)+ 映像名名单。
    fn host_family() -> ProtectedProcesses {
        ProtectedProcesses {
            pids: vec![4242],
            image_names: HOST_IMAGE_NAMES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }

    #[test]
    fn window_listing_hides_denied_windows_but_keeps_screens() {
        let payload = json!([
            { "id": "screen:0:0", "name": "整个屏幕", "kind": "screen" },
            { "id": "window:1:0", "name": "记事本", "kind": "window" },
            { "id": "window:2:0", "name": "1Password", "kind": "window" },
            { "id": "window:3:0", "name": "CodeMUX", "kind": "window" },
        ]);
        let screened = screen_desktop_payload("desktop-windows", &payload, &[], &no_hosts())
            .expect("筛查通过");
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
        let error = screen_desktop_payload("desktop-active-window", &payload, &[], &no_hosts())
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
        assert!(screen_desktop_payload("desktop-screenshot", &denied, &[], &no_hosts()).is_err());

        let screen = json!({ "name": "整个屏幕", "kind": "screen", "sourceId": "s1" });
        assert!(screen_desktop_payload("desktop-screenshot", &screen, &[], &no_hosts()).is_ok());

        let allowed = json!({ "name": "记事本", "kind": "window", "sourceId": "w2" });
        assert!(screen_desktop_payload("desktop-screenshot", &allowed, &[], &no_hosts()).is_ok());
    }

    #[test]
    fn allowlist_restricts_window_screenshots() {
        let notepad = json!({ "name": "记事本", "kind": "window", "sourceId": "w2" });
        assert!(screen_desktop_payload(
            "desktop-screenshot",
            &notepad,
            &allowlist(&["Excel"]),
            &no_hosts()
        )
        .is_err());
        assert!(screen_desktop_payload(
            "desktop-screenshot",
            &notepad,
            &allowlist(&["记事本"]),
            &no_hosts()
        )
        .is_ok());
    }

    #[test]
    fn screen_capture_is_refused_when_a_protected_app_is_in_the_foreground() {
        let screen = json!({
            "name": "整个屏幕",
            "kind": "screen",
            "sourceId": "s1",
            "foregroundTitle": "1Password",
        });
        let error = screen_desktop_payload("desktop-screenshot", &screen, &[], &no_hosts())
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
        assert!(screen_desktop_payload("desktop-screenshot", &benign, &[], &no_hosts()).is_ok());

        // 读不到前台标题(非 Windows)时不误伤。
        let unknown = json!({ "name": "整个屏幕", "kind": "screen", "sourceId": "s1" });
        assert!(screen_desktop_payload("desktop-screenshot", &unknown, &[], &no_hosts()).is_ok());
    }

    #[test]
    fn browser_ops_pass_through_untouched() {
        let payload = json!({ "elements": 3 });
        assert_eq!(
            screen_desktop_payload("snapshot", &payload, &[], &no_hosts()).expect("浏览器 op 不筛"),
            payload
        );
    }

    // ---- 宿主进程家族(工单 11):身份优先,标题挡不住的一律在这层兜住 ----

    #[test]
    fn an_untitled_host_window_is_hidden_from_the_listing() {
        // 自绘的无边框窗口没有标题:标题串匹配放行,身份必须拒绝。
        let payload = json!([
            { "id": "window:9:0", "name": "", "kind": "window", "processId": 4242 },
            { "id": "window:10:0", "name": "记事本", "kind": "window", "processId": 777 },
        ]);
        let screened = screen_desktop_payload("desktop-windows", &payload, &[], &host_family())
            .expect("筛查通过");
        let items = screened.as_array().unwrap();
        assert_eq!(items.len(), 1, "无标题的宿主窗口必须被身份拦下");
        assert_eq!(items[0]["name"], "记事本");
    }

    #[test]
    fn a_renderer_child_of_the_shell_is_denied_by_parent_pid() {
        // 外壳的渲染进程是外壳的子进程:pid 陌生,但父进程号命中。
        let payload = json!([
            { "id": "window:1:0", "name": "随便什么标题", "kind": "window", "processId": 5150, "parentProcessId": 4242 },
        ]);
        let screened = screen_desktop_payload("desktop-windows", &payload, &[], &host_family())
            .expect("筛查通过");
        assert!(screened.as_array().unwrap().is_empty());
    }

    #[test]
    fn host_binaries_are_denied_by_image_name_even_when_allowlisted() {
        // 驱动面板/daemon 窗口:名字对得上就拒,允许列表写自己也不行。
        for name in ["cua-driver.exe", "Cua-Driver", "codemux-daemon.exe"] {
            let entry = json!({
                "id": "window:5:0",
                "name": "面板",
                "kind": "window",
                "processId": 999,
                "processName": name,
            });
            let error = screen_desktop_payload(
                "desktop-screenshot",
                &entry,
                &allowlist(&["cua-driver", "codemux-daemon"]),
                &host_family(),
            )
            .expect_err("宿主家族映像名必须拒绝");
            assert!(error.contains("CodeMUX 进程家族"), "{name}: {error}");
        }
    }

    #[test]
    fn the_more_specific_rule_names_the_refusal() {
        // 标题就写着 CodeMUX(身份也可能命中):报「内置拒绝列表」这条,人才知道
        // 是哪条规则挡的;否则会误以为是莫名其妙的进程判定。
        let titled = WindowSubject {
            title: "CodeMUX".to_string(),
            ..Default::default()
        };
        match decide_window_access(&titled, &[], &host_family()) {
            AppAccess::Denied { scope, .. } => assert_eq!(scope, "CodeMUX 自身与安装更新器"),
            AppAccess::Allowed => panic!("必须拒绝"),
        }

        // 标题无害但身份是宿主(无标题窗口同理):报进程家族。
        let nameless = WindowSubject {
            title: String::new(),
            process_id: Some(4242),
            ..Default::default()
        };
        match decide_window_access(&nameless, &[], &host_family()) {
            AppAccess::Denied { scope, .. } => assert_eq!(scope, "CodeMUX 进程家族"),
            AppAccess::Allowed => panic!("必须拒绝"),
        }
    }

    #[test]
    fn a_foreign_process_with_a_benign_title_is_still_allowed() {
        let entry = json!({
            "id": "window:6:0",
            "name": "记事本",
            "kind": "window",
            "processId": 777,
            "parentProcessId": 1,
            "processName": "notepad.exe",
        });
        assert!(screen_desktop_payload("desktop-screenshot", &entry, &[], &host_family()).is_ok());
    }

    #[test]
    fn a_protected_foreground_refuses_the_full_screen_capture_by_identity() {
        // 前台是宿主自己的窗口(标题无害、身份命中):整屏截图必须拒绝。
        let screen = json!({
            "name": "整个屏幕",
            "kind": "screen",
            "sourceId": "s1",
            "foregroundTitle": "设置",
            "foregroundProcessId": 4242,
        });
        let error = screen_desktop_payload("desktop-screenshot", &screen, &[], &host_family())
            .expect_err("前台是宿主窗口时整屏截图必须拒绝");
        assert!(error.contains("CodeMUX 进程家族"));

        // 前台是宿主子进程(渲染进程)同样拒绝。
        let child = json!({
            "name": "整个屏幕",
            "kind": "screen",
            "sourceId": "s1",
            "foregroundTitle": "会话",
            "foregroundProcessId": 5150,
            "foregroundParentProcessId": 4242,
        });
        assert!(screen_desktop_payload("desktop-screenshot", &child, &[], &host_family()).is_err());
    }

    #[test]
    fn no_identity_means_falling_back_to_the_title_rules() {
        // 非 Windows(壳报不出身份)不该因为「没有 pid」而拒绝一切。
        let entry = json!({ "id": "window:7:0", "name": "记事本", "kind": "window" });
        assert!(screen_desktop_payload("desktop-screenshot", &entry, &[], &host_family()).is_ok());
    }

    #[test]
    fn the_host_family_always_contains_the_daemon_itself() {
        let family = ProtectedProcesses::host_family(None, None);
        assert!(family.contains_pid(Some(std::process::id())));
        assert!(!family.contains_pid(None));
        assert!(!family.contains_pid(Some(0)));

        let with_hosts = ProtectedProcesses::host_family(Some(42), Some(43));
        assert!(with_hosts.contains_pid(Some(42)));
        assert!(with_hosts.contains_pid(Some(43)));
        assert!(with_hosts.matches_image("CodeMUX.exe"));
        assert!(with_hosts.matches_image("cua-driver"));
        assert!(
            !with_hosts.matches_image("electron.exe"),
            "开发模式的壳靠父进程号兜"
        );
        assert!(!with_hosts.matches_image(""));
    }
}
