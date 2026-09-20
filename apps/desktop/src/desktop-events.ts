//! 桌面 UI 事件接缝(工单 09)main 进程侧解析:daemon 广播 → 渲染层事件。
//!
//! daemon 的 [`UiEventSink`](crates/daemon/src/daemon/mod.rs) 把桌面 UI 事件以
//! `ui-event` 信封、空 session_id 发进 companion 广播通道;控制面 WS
//! (`/api/ws` 无 session_id)以 `{"type":"event","sessionId":"","event":...}`
//! 帧转发给壳。本模块从帧里解析出 `{name, payload}`,main 进程据此
//! `webContents.send(name, payload)`(与 Tauri 壳 `app.emit(event, payload)`
//! 同名同形:sessions-changed / scheduled-tasks-changed /
//! runtime-install-progress / runtime-install-progress-<provider>)。
//!
//! 本文件不 import electron(纯解析),便于 Node(vitest)契约测试。

/** 解析后的桌面 UI 事件:name = 渲染层事件名,payload = 原样载荷。 */
export interface DesktopUiEvent {
  name: string;
  payload: unknown;
}

/** daemon 控制面事件信封:{"type":"event","sessionId":"","event":{...}}。 */
interface ControlEventEnvelope {
  type?: unknown;
  sessionId?: unknown;
  event?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从控制面 WS 帧解析桌面 UI 事件。非事件帧 / 会话帧(非空 sessionId)/
 * 非 ui-event 类型(如 browser-automation-request)一律返回 null。
 */
export function parseDesktopUiEvent(raw: string): DesktopUiEvent | null {
  let envelope: ControlEventEnvelope;
  try {
    envelope = JSON.parse(raw) as ControlEventEnvelope;
  } catch {
    return null;
  }
  if (!isRecord(envelope) || envelope.type !== 'event') return null;
  if (typeof envelope.sessionId === 'string' && envelope.sessionId !== '') return null;
  const event = envelope.event;
  if (!isRecord(event) || event.type !== 'ui-event') return null;
  if (typeof event.name !== 'string' || !event.name) return null;
  return {
    name: event.name,
    payload: event.payload ?? null,
  };
}
