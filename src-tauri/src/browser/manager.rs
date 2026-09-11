use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window};

use crate::config::types::AppConfig;
use crate::AppState;

use super::url::normalize_browser_url;

pub const BROWSER_PAGE_EVENT: &str = "browser-page-event";
pub const BROWSER_NEW_WINDOW_EVENT: &str = "browser-new-window-event";
const MAIN_WINDOW_LABEL: &str = "main";
const CACHE_CLEAR_SCRIPT: &str = r#"(async () => {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch (error) {}
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (error) {}
  return true;
})()"#;
const FAVICON_SCRIPT: &str = r#"(function () {
  const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
  return link ? link.href : null;
})()"#;
const BLANK_LINK_INTERCEPT_SCRIPT: &str = r#"(function () {
  function installBlankBridge() {
    if (window.__codemuxBrowserBlankBridge) return;
    window.__codemuxBrowserBlankBridge = true;
    function openInAppTab(url) {
      try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        const bridge = "codemux://browser/open?url=" + encodeURIComponent(parsed.href);
        const link = document.createElement("a");
        link.href = bridge;
        link.style.display = "none";
        (document.body || document.documentElement).appendChild(link);
        link.click();
        link.remove();
      } catch (error) {}
    }
    function shouldOpenInNewTab(link, event) {
      const target = (link.getAttribute("target") || "").toLowerCase();
      if (target === "_blank" || target === "_new") return true;
      if (!event) return false;
      return event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    }
    document.addEventListener(
      "click",
      function (event) {
        const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (!link || !shouldOpenInNewTab(link, event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openInAppTab(link.href);
      },
      true,
    );
    document.addEventListener(
      "auxclick",
      function (event) {
        if (event.button !== 1) return;
        const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (!link) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openInAppTab(link.href);
      },
      true,
    );
    const originalOpen = window.open;
    window.open = function (url, target) {
      if (url) {
        openInAppTab(String(url));
        return null;
      }
      return originalOpen.apply(this, arguments);
    };
  }
  installBlankBridge();
})()"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageEvent {
    pub browser_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_go_forward: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewWindowEvent {
    pub source_browser_id: String,
    pub url: String,
}

struct BrowserPageRecord {
    history: Vec<String>,
    index: usize,
}

#[derive(Default)]
pub struct BrowserState {
    pages: Mutex<HashMap<String, BrowserPageRecord>>,
}

pub(crate) const WEBVIEW_LABEL_PREFIX: &str = "cmx-b-";

fn webview_label(browser_id: &str) -> String {
    format!("{WEBVIEW_LABEL_PREFIX}{browser_id}")
}

fn browser_profile_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let state = app.state::<std::sync::Arc<AppState>>();
    Ok(state.app_data_dir.join("browser-profile"))
}

fn main_window(app: &AppHandle) -> Result<Window, String> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())
}

fn emit_page(app: &AppHandle, event: BrowserPageEvent) {
    if let Err(error) = app.emit(BROWSER_PAGE_EVENT, event) {
        warn!(target: "browser", "Failed to emit browser page event: {error}");
    }
}

fn emit_new_window(app: &AppHandle, source_browser_id: &str, url: String) {
    if let Err(error) = app.emit(
        BROWSER_NEW_WINDOW_EVENT,
        BrowserNewWindowEvent {
            source_browser_id: source_browser_id.to_string(),
            url,
        },
    ) {
        warn!(target: "browser", "Failed to emit browser new-window event: {error}");
    }
}

pub(crate) fn parse_codemux_open_url(target: &Url) -> Option<String> {
    if target.scheme() != "codemux" {
        return None;
    }
    if target.host_str() != Some("browser") {
        return None;
    }
    if target.path() != "/open" {
        return None;
    }
    let encoded = target
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())?;
    let parsed = Url::parse(&encoded).ok()?;
    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn record_navigation(state: &BrowserState, browser_id: &str, url: String) -> (bool, bool) {
    let mut pages = state.pages.lock().unwrap();
    let page = pages
        .entry(browser_id.to_string())
        .or_insert_with(|| BrowserPageRecord {
            history: Vec::new(),
            index: 0,
        });
    if page.history.get(page.index) == Some(&url) {
        return (
            !page.history.is_empty() && page.index > 0,
            page.index + 1 < page.history.len(),
        );
    }
    if page.index > 0 && page.history.get(page.index - 1) == Some(&url) {
        page.index -= 1;
    } else if page.index + 1 < page.history.len() && page.history.get(page.index + 1) == Some(&url)
    {
        page.index += 1;
    } else {
        if !page.history.is_empty() {
            page.history.truncate(page.index + 1);
        }
        page.history.push(url);
        page.index = page.history.len().saturating_sub(1);
    }
    (page.index > 0, page.index + 1 < page.history.len())
}

fn navigation_flags(state: &BrowserState, browser_id: &str) -> (bool, bool) {
    let pages = state.pages.lock().unwrap();
    let Some(page) = pages.get(browser_id) else {
        return (false, false);
    };
    (page.index > 0, page.index + 1 < page.history.len())
}

pub fn create_page(
    app: &AppHandle,
    state: &BrowserState,
    config: &AppConfig,
    browser_id: String,
    url: String,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    let normalized = normalize_browser_url(&url)?;
    let parsed = Url::parse(&normalized).map_err(|error| error.to_string())?;
    let label = webview_label(&browser_id);
    if app.get_webview(&label).is_some() {
        return navigate_page(app, state, browser_id, normalized);
    }

    let profile_dir = browser_profile_dir(app)?;
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("无法创建浏览器资料目录: {error}"))?;

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed.clone()))
        .data_directory(profile_dir)
        .devtools(true)
        .initialization_script(BLANK_LINK_INTERCEPT_SCRIPT);

    #[cfg(windows)]
    {
        let mut args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string();
        if config.browser.ignore_certificate_errors {
            args.push_str(" --ignore-certificate-errors");
        }
        builder = builder.additional_browser_args(&args);
    }
    #[cfg(not(windows))]
    let _ = config;

    let app_for_nav = app.clone();
    let nav_id = browser_id.clone();
    builder = builder.on_navigation(move |target| {
        if target.scheme() == "codemux" {
            if let Some(url) = parse_codemux_open_url(&target) {
                emit_new_window(&app_for_nav, &nav_id, url);
            }
            return false;
        }
        let allowed = target.scheme() == "http" || target.scheme() == "https";
        if !allowed {
            emit_page(
                &app_for_nav,
                BrowserPageEvent {
                    browser_id: nav_id.clone(),
                    last_error: Some("只允许 http 或 https 地址".to_string()),
                    url: None,
                    title: None,
                    favicon_url: None,
                    is_loading: None,
                    can_go_back: None,
                    can_go_forward: None,
                },
            );
            return false;
        }
        true
    });

    let app_for_new_window = app.clone();
    let new_window_id = browser_id.clone();
    builder = builder.on_new_window(move |url, _features| {
        if url.scheme() == "http" || url.scheme() == "https" {
            emit_new_window(&app_for_new_window, &new_window_id, url.to_string());
        }
        NewWindowResponse::Deny
    });

    let app_for_title = app.clone();
    let title_id = browser_id.clone();
    builder = builder.on_document_title_changed(move |_webview, title| {
        emit_page(
            &app_for_title,
            BrowserPageEvent {
                browser_id: title_id.clone(),
                title: Some(title),
                url: None,
                favicon_url: None,
                is_loading: None,
                can_go_back: None,
                can_go_forward: None,
                last_error: None,
            },
        );
    });

    let app_for_load = app.clone();
    let load_id = browser_id.clone();
    builder = builder.on_page_load(move |webview, payload| {
        let url = payload.url().to_string();
        let is_loading = matches!(payload.event(), PageLoadEvent::Started);
        let state = app_for_load.state::<BrowserState>();
        let (can_go_back, can_go_forward) = if is_loading {
            navigation_flags(&state, &load_id)
        } else {
            record_navigation(&state, &load_id, url.clone())
        };
        emit_page(
            &app_for_load,
            BrowserPageEvent {
                browser_id: load_id.clone(),
                url: Some(url),
                is_loading: Some(is_loading),
                can_go_back: Some(can_go_back),
                can_go_forward: Some(can_go_forward),
                last_error: if is_loading {
                    None
                } else {
                    Some(String::new())
                },
                title: None,
                favicon_url: None,
            },
        );
        if !is_loading {
            let _ = webview.eval(BLANK_LINK_INTERCEPT_SCRIPT);
            let app = app_for_load.clone();
            let browser_id = load_id.clone();
            let _ = webview.eval_with_callback(FAVICON_SCRIPT, move |result| {
                let favicon = serde_json::from_str::<Option<String>>(&result)
                    .ok()
                    .flatten();
                emit_page(
                    &app,
                    BrowserPageEvent {
                        browser_id: browser_id.clone(),
                        favicon_url: favicon,
                        url: None,
                        title: None,
                        is_loading: None,
                        can_go_back: None,
                        can_go_forward: None,
                        last_error: None,
                    },
                );
            });
        }
    });

    let window = main_window(app)?;
    let width = bounds.width.max(1.0);
    let height = bounds.height.max(1.0);
    match window.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(width, height),
    ) {
        Ok(_) => {}
        Err(error) => {
            let message = error.to_string();
            if message.contains("already exists") {
                return navigate_page(app, state, browser_id, normalized);
            }
            warn!(target: "browser", "Failed to create browser page {browser_id}: {error}");
            return Err(format!("无法创建浏览器页: {error}"));
        }
    }

    record_navigation(state, &browser_id, normalized.clone());
    emit_page(
        app,
        BrowserPageEvent {
            browser_id,
            url: Some(normalized),
            is_loading: Some(true),
            can_go_back: Some(false),
            can_go_forward: Some(false),
            title: None,
            favicon_url: None,
            last_error: None,
        },
    );
    Ok(())
}

pub fn destroy_page(app: &AppHandle, state: &BrowserState, browser_id: &str) -> Result<(), String> {
    let label = webview_label(browser_id);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("无法关闭浏览器页: {error}"))?;
    }
    state.pages.lock().unwrap().remove(browser_id);
    Ok(())
}

pub fn navigate_page(
    app: &AppHandle,
    state: &BrowserState,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    let normalized = normalize_browser_url(&url)?;
    let parsed = Url::parse(&normalized).map_err(|error| error.to_string())?;
    let label = webview_label(&browser_id);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .navigate(parsed)
        .map_err(|error| format!("无法打开网页: {error}"))?;
    emit_page(
        app,
        BrowserPageEvent {
            browser_id: browser_id.clone(),
            url: Some(normalized.clone()),
            is_loading: Some(true),
            last_error: None,
            title: None,
            favicon_url: None,
            can_go_back: None,
            can_go_forward: None,
        },
    );
    let _ = state;
    Ok(())
}

pub fn back_page(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    eval_script(app, browser_id, "history.back()")
}

pub fn forward_page(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    eval_script(app, browser_id, "history.forward()")
}

pub fn reload_page(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .reload()
        .map_err(|error| format!("无法刷新网页: {error}"))
}

pub fn set_page_bounds(
    app: &AppHandle,
    browser_id: &str,
    bounds: BrowserPageBounds,
) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("无法移动浏览器页: {error}"))?;
    webview
        .set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        ))
        .map_err(|error| format!("无法调整浏览器页大小: {error}"))
}

pub fn show_page(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .show()
        .map_err(|error| format!("无法显示浏览器页: {error}"))
}

pub fn hide_page(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .hide()
        .map_err(|error| format!("无法隐藏浏览器页: {error}"))
}

pub fn open_devtools(app: &AppHandle, browser_id: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview.open_devtools();
    Ok(())
}

pub fn set_page_zoom(app: &AppHandle, browser_id: &str, factor: f64) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .set_zoom(factor.max(0.1))
        .map_err(|error| format!("无法调整页面缩放: {error}"))
}

fn eval_script(app: &AppHandle, browser_id: &str, script: &str) -> Result<(), String> {
    let webview = app
        .get_webview(&webview_label(browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    webview
        .eval(script)
        .map_err(|error| format!("无法执行页面脚本: {error}"))
}

pub async fn evaluate_script(
    app: AppHandle,
    browser_id: String,
    script: String,
) -> Result<String, String> {
    let webview = app
        .get_webview(&webview_label(&browser_id))
        .ok_or_else(|| format!("浏览器页不存在: {browser_id}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(tx));
    webview
        .eval_with_callback(script, move |result| {
            if let Some(tx) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(result);
            }
        })
        .map_err(|error| format!("无法执行页面脚本: {error}"))?;
    tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "页面脚本执行超时".to_string())?
        .map_err(|_| "页面脚本没有返回结果".to_string())
}

pub fn clear_data(app: &AppHandle, scope: &str) -> Result<(), String> {
    match scope {
        "cache" | "all" => {}
        other => return Err(format!("未知的清除范围: {other}")),
    }

    let targets: Vec<_> = app
        .webviews()
        .into_iter()
        .filter(|(label, _)| label.starts_with(WEBVIEW_LABEL_PREFIX))
        .map(|(_, webview)| webview)
        .collect();

    if targets.is_empty() {
        return clear_profile_on_disk(app, scope);
    }

    for webview in targets {
        clear_one(&webview, scope)?;
    }
    if scope == "cache" {
        clear_profile_on_disk(app, scope)?;
    }
    Ok(())
}

fn clear_one<R: tauri::Runtime>(webview: &tauri::Webview<R>, scope: &str) -> Result<(), String> {
    match scope {
        "all" => webview
            .clear_all_browsing_data()
            .map_err(|error| format!("无法清除浏览器资料: {error}"))?,
        "cache" => {
            webview
                .eval(CACHE_CLEAR_SCRIPT)
                .map_err(|error| format!("无法清除缓存: {error}"))?;
        }
        other => return Err(format!("未知的清除范围: {other}")),
    }
    let _ = webview.reload();
    Ok(())
}

fn clear_profile_on_disk(app: &AppHandle, scope: &str) -> Result<(), String> {
    let dir = browser_profile_dir(app)?;
    if !dir.exists() {
        return Ok(());
    }
    match scope {
        "all" => {
            std::fs::remove_dir_all(&dir)
                .map_err(|error| format!("无法清除浏览器资料: {error}"))?;
            std::fs::create_dir_all(&dir)
                .map_err(|error| format!("无法重建浏览器资料目录: {error}"))?;
        }
        "cache" => {
            for name in [
                "Cache",
                "Code Cache",
                "GPUCache",
                "Service Worker",
                "CacheStorage",
            ] {
                let path = dir.join(name);
                if path.exists() {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
        }
        other => return Err(format!("未知的清除范围: {other}")),
    }
    Ok(())
}
