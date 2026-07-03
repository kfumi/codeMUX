# AI 任务系统通知与提示音 Implementation Plan

> **面向 agentic workers：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现本计划。步骤使用 checkbox（`- [ ]`）语法便于跟踪。

**Goal:** 当 codeMUX 失焦、最小化或隐藏到托盘时，对等待用户输入和 AI 任务完成发出系统通知，并支持可选提示音。

**Architecture:** 使用前端统一调度层读取 `agentStore`、`sessionStore`、`settingsStore` 和窗口活跃状态，生成去重后的通知候选；桌面通知优先使用 Web Notification API 以获得 `onclick` 跳转能力，Tauri notification 插件负责权限/兜底发送；提示音由前端播放 `public/sounds/` 资源。设置持久化沿用现有 `AppConfig`、Rust command、`configApi`、`settingsStore` 模式。

**Tech Stack:** Tauri 2、React 18、Vite、TypeScript、Zustand、Vitest、Testing Library、Rust serde、`@tauri-apps/plugin-notification`、`tauri-plugin-notification`。

---

## 文件结构

- Modify: `package.json`  
  增加 `@tauri-apps/plugin-notification` 依赖。
- Modify: `package-lock.json`  
  由 `npm install @tauri-apps/plugin-notification` 更新。
- Modify: `src-tauri/Cargo.toml`  
  增加 `tauri-plugin-notification` 依赖。
- Modify: `src-tauri/capabilities/default.json`  
  增加 notification 权限。
- Modify: `src-tauri/src/lib.rs`  
  注册 notification 插件，新增显示主窗口命令。
- Modify: `src-tauri/src/config/types.rs`  
  增加通知配置类型、默认值和旧配置兼容测试。
- Modify: `src-tauri/src/commands/provider.rs`  
  增加 `set_notification_settings` command。
- Modify: `src/types/provider.ts`  
  增加 `NotificationSettings`、`NotificationSound` 和 `AppConfig.notifications`。
- Modify: `src/lib/tauri.ts`  
  增加 `configApi.setNotificationSettings` 和 `appApi.showMainWindow`。
- Modify: `src/stores/settingsStore.ts`  
  增加通知设置 setter，失败时回滚。
- Modify: `src/stores/settingsStore.test.ts`  
  覆盖通知默认值、更新和回滚。
- Create: `src/lib/agentNotifications.ts`  
  纯函数：通知候选生成、去重键、活跃状态判断输入类型。
- Create: `src/lib/agentNotifications.test.ts`  
  覆盖等待输入、完成、失败、活跃状态过滤、去重键。
- Create: `src/hooks/useAgentNotifications.ts`  
  全局 hook：订阅 store、请求通知权限、发送系统通知、播放声音、处理点击跳转。
- Create: `src/hooks/useAgentNotifications.test.tsx`  
  使用 mocked Tauri notification API 验证 hook 行为。
- Modify: `src/App.tsx`  
  挂载 `useAgentNotifications()`。
- Create: `src/components/settings/NotificationSettingsSection.tsx`  
  常规设置中的通知 UI。
- Create: `src/components/settings/NotificationSettingsSection.test.tsx`  
  覆盖开关、下拉和试听按钮。
- Modify: `src/components/settings/GeneralSettings.tsx`  
  引入通知设置区。
- Create: `public/sounds/soft.wav`
- Create: `public/sounds/clear.wav`
- Create: `public/sounds/alert.wav`
  三个短提示音资源。若当前实现环境不方便提交二进制音频，先用生成脚本创建短 WAV 文件。

---

### Task 1: 配置模型与持久化命令

**Files:**
- Modify: `src-tauri/src/config/types.rs`
- Modify: `src-tauri/src/commands/provider.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/provider.ts`
- Modify: `src/lib/tauri.ts`
- Modify: `src/stores/settingsStore.ts`
- Test: `src/stores/settingsStore.test.ts`

- [ ] **Step 1: 写 Rust 配置默认值测试**

在 `src-tauri/src/config/types.rs` 的 `#[cfg(test)] mod tests` 中加入：

```rust
#[test]
fn old_config_json_deserializes_with_notification_defaults() {
    let raw = serde_json::json!({
        "providers": [],
        "active_provider_id": null,
        "theme": "System"
    });

    let config: AppConfig = serde_json::from_value(raw).unwrap();

    assert!(config.notifications.system_enabled);
    assert!(!config.notifications.sound_enabled);
    assert_eq!(config.notifications.sound, "soft");
}
```

- [ ] **Step 2: 运行 Rust 测试并确认失败**

Run:

```powershell
cd src-tauri
cargo test old_config_json_deserializes_with_notification_defaults
```

Expected: FAIL，错误包含 `no field notifications` 或 `unknown field notifications` 相关编译失败。

- [ ] **Step 3: 实现 Rust 通知配置类型**

在 `src-tauri/src/config/types.rs` 中 `default_false()` 后加入：

```rust
fn default_notification_sound() -> String {
    "soft".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationSettings {
    #[serde(default = "default_true")]
    pub system_enabled: bool,
    #[serde(default = "default_false")]
    pub sound_enabled: bool,
    #[serde(default = "default_notification_sound")]
    pub sound: String,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            system_enabled: true,
            sound_enabled: false,
            sound: default_notification_sound(),
        }
    }
}
```

在 `AppConfig` 中 `compact_ai_output` 后加入字段：

```rust
#[serde(default)]
pub notifications: NotificationSettings,
```

在 `AppConfig::default()` 中 `compact_ai_output: false,` 后加入：

```rust
notifications: NotificationSettings::default(),
```

- [ ] **Step 4: 运行 Rust 测试并确认通过**

Run:

```powershell
cd src-tauri
cargo test old_config_json_deserializes_with_notification_defaults
```

Expected: PASS。

- [ ] **Step 5: 写前端 store 测试**

在 `src/stores/settingsStore.test.ts` 顶部 mock 区加入：

```typescript
const setNotificationSettingsMock = vi.fn<(settings: Record<string, unknown>) => Promise<void>>();
```

在 `vi.mock('../lib/tauri'...)` 的 `configApi` 中加入：

```typescript
setNotificationSettings: setNotificationSettingsMock,
```

在 `baseConfig` 中加入：

```typescript
notifications: {
  system_enabled: true,
  sound_enabled: false,
  sound: 'soft',
},
```

在 describe 中追加测试：

```typescript
it('persists notification settings updates', async () => {
  const { useSettingsStore } = await import('./settingsStore');

  await useSettingsStore.getState().setNotificationSettings({
    system_enabled: true,
    sound_enabled: true,
    sound: 'clear',
  });

  expect(setNotificationSettingsMock).toHaveBeenCalledWith({
    system_enabled: true,
    sound_enabled: true,
    sound: 'clear',
  });
  expect(useSettingsStore.getState().config?.notifications).toEqual({
    system_enabled: true,
    sound_enabled: true,
    sound: 'clear',
  });
});

it('rolls notification settings back when persistence fails', async () => {
  const { useSettingsStore } = await import('./settingsStore');
  setNotificationSettingsMock.mockRejectedValueOnce(new Error('write failed'));

  await useSettingsStore.getState().setNotificationSettings({
    system_enabled: false,
    sound_enabled: true,
    sound: 'alert',
  });

  expect(useSettingsStore.getState().config?.notifications).toEqual({
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft',
  });
  expect(useSettingsStore.getState().error).toContain('write failed');
});
```

- [ ] **Step 6: 运行前端 store 测试并确认失败**

Run:

```powershell
npx vitest run src/stores/settingsStore.test.ts
```

Expected: FAIL，错误包含 `setNotificationSettings is not a function` 或类型缺少 `notifications`。

- [ ] **Step 7: 实现前端类型、API 和 store**

在 `src/types/provider.ts` 中加入：

```typescript
export type NotificationSound = 'soft' | 'clear' | 'alert';

export interface NotificationSettings {
  system_enabled: boolean;
  sound_enabled: boolean;
  sound: NotificationSound;
}
```

在 `AppConfig` 中加入：

```typescript
notifications: NotificationSettings;
```

在 `src/lib/tauri.ts` 的类型导入中加入 `NotificationSettings`：

```typescript
import type { AgentConfigUpdateMap, AppConfig, NotificationSettings, Provider, Theme } from '../types/provider';
```

在 `configApi` 中加入：

```typescript
setNotificationSettings: (settings: NotificationSettings): Promise<void> =>
  invokeLogged('set_notification_settings', { settings }),
```

在 `src/stores/settingsStore.ts` 的类型导入中加入：

```typescript
import type { AgentConfigMap, AgentConfigUpdateMap, AppConfig, NotificationSettings, Provider, Theme } from '../types/provider';
```

在 `SettingsState` 中加入：

```typescript
setNotificationSettings: (settings: NotificationSettings) => Promise<void>;
```

在 store 实现中加入：

```typescript
setNotificationSettings: async (settings: NotificationSettings) => {
  const previousValue = get().config?.notifications ?? {
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft',
  };
  set((state) => ({
    config: state.config ? { ...state.config, notifications: settings } : state.config,
    error: null,
  }));

  try {
    await configApi.setNotificationSettings(settings);
  } catch (error) {
    set((state) => ({
      config: state.config ? { ...state.config, notifications: previousValue } : state.config,
      error: String(error),
    }));
  }
},
```

- [ ] **Step 8: 实现 Rust command 并注册**

在 `src-tauri/src/commands/provider.rs` 的 imports 中加入 `NotificationSettings`：

```rust
AgentKind, AppConfig, ClaudeCodeAgentConfigUpdate, CodexAgentConfigUpdate, NotificationSettings, Provider, Theme,
```

在 `set_compact_ai_output` 后加入：

```rust
#[tauri::command]
pub fn set_notification_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    settings: NotificationSettings,
) -> Result<(), String> {
    if !matches!(settings.sound.as_str(), "soft" | "clear" | "alert") {
        return Err(format!("Unsupported notification sound: {}", settings.sound));
    }

    info!(
        target: "provider",
        "Setting notification settings system_enabled={} sound_enabled={} sound={}",
        settings.system_enabled,
        settings.sound_enabled,
        settings.sound
    );
    let mut config = state.config.lock().unwrap();
    config.notifications = settings;
    config::save_config(&app, &config)?;
    Ok(())
}
```

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中 `commands::provider::set_compact_ai_output,` 后加入：

```rust
commands::provider::set_notification_settings,
```

先不要添加 `show_main_window` command，本任务只完成配置持久化。

- [ ] **Step 9: 运行测试确认通过**

Run:

```powershell
npx vitest run src/stores/settingsStore.test.ts
cd src-tauri
cargo test old_config_json_deserializes_with_notification_defaults
```

Expected: 两个命令都 PASS。

- [ ] **Step 10: Commit**

```powershell
git add src-tauri/src/config/types.rs src-tauri/src/commands/provider.rs src-tauri/src/lib.rs src/types/provider.ts src/lib/tauri.ts src/stores/settingsStore.ts src/stores/settingsStore.test.ts
git commit -m "feat(config): 增加通知设置配置"
```

---

### Task 2: 通知候选纯函数

**Files:**
- Create: `src/lib/agentNotifications.ts`
- Create: `src/lib/agentNotifications.test.ts`

- [ ] **Step 1: 写通知规则测试**

Create `src/lib/agentNotifications.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';
import {
  buildAgentNotificationCandidate,
  shouldDispatchAgentNotification,
} from './agentNotifications';

const sessionTitles = new Map<string, string>([['session-1', '重构设置页']]);

describe('agent notification rules', () => {
  it('builds a requires-input notification for ask_user_question events', () => {
    const event: AgentMessage = {
      kind: 'ask_user_question',
      data: {
        tool_use_id: 'question-1',
        questions: [{
          question: '是否继续执行命令？',
          options: [{ label: '继续' }, { label: '停止' }],
        }],
      },
    };

    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event,
      eventIndex: 3,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'requires_input:session-1:question-1',
      kind: 'requires_input',
      sessionId: 'session-1',
      title: '需要你的回复',
      body: '重构设置页：是否继续执行命令？',
    });
  });

  it('builds a completed notification for done events', () => {
    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event: { kind: 'done' },
      eventIndex: 8,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'terminal:session-1:done:8',
      kind: 'task_completed',
      sessionId: 'session-1',
      title: '任务已完成',
      body: '重构设置页',
    });
  });

  it('builds a failed notification for error events', () => {
    const candidate = buildAgentNotificationCandidate({
      sessionId: 'session-1',
      event: { kind: 'error', data: { error: 'stream disconnected' } },
      eventIndex: 9,
      sessionTitles,
    });

    expect(candidate).toEqual({
      key: 'terminal:session-1:error:9',
      kind: 'task_failed',
      sessionId: 'session-1',
      title: '任务失败',
      body: '重构设置页：stream disconnected',
    });
  });

  it('does not dispatch while app is active or system notifications are disabled', () => {
    const candidate = {
      key: 'terminal:session-1:done:8',
      kind: 'task_completed' as const,
      sessionId: 'session-1',
      title: '任务已完成',
      body: '重构设置页',
    };

    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: false,
      systemEnabled: true,
      alreadyDispatched: false,
    })).toBe(false);
    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: true,
      systemEnabled: false,
      alreadyDispatched: false,
    })).toBe(false);
  });

  it('does not dispatch duplicate notification keys', () => {
    const candidate = {
      key: 'requires_input:session-1:question-1',
      kind: 'requires_input' as const,
      sessionId: 'session-1',
      title: '需要你的回复',
      body: '重构设置页：是否继续执行命令？',
    };

    expect(shouldDispatchAgentNotification({
      candidate,
      isAppInactive: true,
      systemEnabled: true,
      alreadyDispatched: true,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npx vitest run src/lib/agentNotifications.test.ts
```

Expected: FAIL，错误包含 `Cannot find module './agentNotifications'`。

- [ ] **Step 3: 实现通知规则纯函数**

Create `src/lib/agentNotifications.ts`:

```typescript
import type { AgentMessage } from '../stores/agentStore';

export type AgentNotificationKind = 'requires_input' | 'task_completed' | 'task_failed';

export interface AgentNotificationCandidate {
  key: string;
  kind: AgentNotificationKind;
  sessionId: string;
  title: string;
  body: string;
}

interface CandidateInput {
  sessionId: string;
  event: AgentMessage;
  eventIndex: number;
  sessionTitles: Map<string, string>;
}

interface DispatchInput {
  candidate: AgentNotificationCandidate | null;
  isAppInactive: boolean;
  systemEnabled: boolean;
  alreadyDispatched: boolean;
}

function getSessionTitle(sessionId: string, sessionTitles: Map<string, string>): string {
  return sessionTitles.get(sessionId)?.trim() || 'AI 任务';
}

function compactBody(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getQuestionSummary(event: Extract<AgentMessage, { kind: 'ask_user_question' }>): string {
  return compactBody(event.data.questions[0]?.question ?? '等待你的输入');
}

export function buildAgentNotificationCandidate({
  sessionId,
  event,
  eventIndex,
  sessionTitles,
}: CandidateInput): AgentNotificationCandidate | null {
  const sessionTitle = getSessionTitle(sessionId, sessionTitles);

  if (event.kind === 'ask_user_question') {
    return {
      key: `requires_input:${sessionId}:${event.data.tool_use_id}`,
      kind: 'requires_input',
      sessionId,
      title: '需要你的回复',
      body: compactBody(`${sessionTitle}：${getQuestionSummary(event)}`),
    };
  }

  if (event.kind === 'done') {
    return {
      key: `terminal:${sessionId}:done:${eventIndex}`,
      kind: 'task_completed',
      sessionId,
      title: '任务已完成',
      body: sessionTitle,
    };
  }

  if (event.kind === 'result') {
    const isError = Boolean(event.data?.is_error);
    const resultText = typeof event.data?.result === 'string' ? event.data.result : '';
    return {
      key: `terminal:${sessionId}:result:${eventIndex}`,
      kind: isError ? 'task_failed' : 'task_completed',
      sessionId,
      title: isError ? '任务失败' : '任务已完成',
      body: isError && resultText ? compactBody(`${sessionTitle}：${resultText}`) : sessionTitle,
    };
  }

  if (event.kind === 'error') {
    return {
      key: `terminal:${sessionId}:error:${eventIndex}`,
      kind: 'task_failed',
      sessionId,
      title: '任务失败',
      body: compactBody(`${sessionTitle}：${event.data.error}`),
    };
  }

  return null;
}

export function shouldDispatchAgentNotification({
  candidate,
  isAppInactive,
  systemEnabled,
  alreadyDispatched,
}: DispatchInput): boolean {
  return Boolean(candidate && isAppInactive && systemEnabled && !alreadyDispatched);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```powershell
npx vitest run src/lib/agentNotifications.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add src/lib/agentNotifications.ts src/lib/agentNotifications.test.ts
git commit -m "feat(agent): 增加通知触发规则"
```

---

### Task 3: Tauri 通知插件与窗口显示命令

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: 安装前端通知插件**

Run:

```powershell
npm install @tauri-apps/plugin-notification
```

Expected: `package.json` 和 `package-lock.json` 更新，`package.json` dependencies 中出现 `@tauri-apps/plugin-notification`。

- [ ] **Step 2: 增加 Rust 插件依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 中加入：

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 3: 注册 Tauri notification 插件**

在 `src-tauri/src/lib.rs` 的 builder 插件链中，`.plugin(tauri_plugin_process::init())` 后加入：

```rust
.plugin(tauri_plugin_notification::init())
```

- [ ] **Step 4: 增加显示主窗口 command**

在 `src-tauri/src/lib.rs` 中 `show_main_window` 函数后加入：

```rust
#[tauri::command]
fn show_main_window_command(app: tauri::AppHandle) {
    show_main_window(&app);
}
```

在 `invoke_handler` 中 `commands::app::read_log_file,` 后加入：

```rust
show_main_window_command,
```

在 `src/lib/tauri.ts` 的 `appApi` 中确认已有或加入：

```typescript
showMainWindow: (): Promise<void> => invokeLogged('show_main_window_command'),
```

- [ ] **Step 5: 增加 capabilities 权限**

在 `src-tauri/capabilities/default.json` 的 `permissions` 数组中加入：

```json
"notification:default"
```

放在 `"process:allow-restart"` 后即可。

- [ ] **Step 6: 运行检查**

Run:

```powershell
npm run build
cd src-tauri
cargo check --all-targets --all-features
```

Expected: 两个命令都 PASS。

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/capabilities/default.json src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(notification): 接入 Tauri 系统通知插件"
```

---

### Task 4: 全局通知 hook

**Files:**
- Create: `src/hooks/useAgentNotifications.ts`
- Create: `src/hooks/useAgentNotifications.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 写 hook 行为测试**

Create `src/hooks/useAgentNotifications.test.tsx`:

```typescript
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppConfig } from '../types/provider';
import { useAgentNotifications } from './useAgentNotifications';

const sendNotificationMock = vi.fn();
const requestPermissionMock = vi.fn(async () => 'granted');
const isPermissionGrantedMock = vi.fn(async () => true);
const showMainWindowMock = vi.fn(async () => {});
const notificationInstances: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
  sendNotification: (payload: unknown) => sendNotificationMock(payload),
}));

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri');
  return {
    ...actual,
    appApi: {
      ...actual.appApi,
      showMainWindow: showMainWindowMock,
    },
  };
});

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: { sdk_mode: 'responses' },
    gemini_cli: {},
    opencode: {},
  },
  compact_ai_output: false,
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft',
  },
  theme: 'System',
};

function Harness() {
  useAgentNotifications();
  return null;
}

describe('useAgentNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    notificationInstances.length = 0;
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      onclick: (() => void) | null = null;

      constructor(public title: string, public options?: NotificationOptions) {
        notificationInstances.push(this);
      }
    });
    useSettingsStore.setState({ config: structuredClone(baseConfig), isLoading: false, error: null });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: '重构设置页',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        mode: 'agent',
        project_id: null,
        provider_id: null,
        model: null,
        reasoning_effort: null,
        is_archived: false,
        is_pinned: false,
        agent_kind: 'claude_code',
        permission_config: null,
        plan_mode: null,
      }],
      activeSessionId: null,
      unreadSessions: new Set<string>(),
    });
    useAgentStore.setState({
      events: {},
      eventTimestamps: {},
    });
  });

  it('sends a notification for a new waiting-input event while inactive', async () => {
    render(<Harness />);

    useAgentStore.setState({
      events: {
        'session-1': [{
          kind: 'ask_user_question',
          data: {
            tool_use_id: 'question-1',
            questions: [{
              question: '是否继续？',
              options: [{ label: '继续' }, { label: '停止' }],
            }],
          },
        }],
      },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances[0]).toMatchObject({
        title: '需要你的回复',
        options: { body: '重构设置页：是否继续？' },
      });
    });
  });

  it('does not send duplicate notifications for the same event', async () => {
    render(<Harness />);

    const event = {
      kind: 'done' as const,
    };

    useAgentStore.setState({
      events: { 'session-1': [event] },
      eventTimestamps: { 'session-1': [1] },
    });
    useAgentStore.setState({
      events: { 'session-1': [event] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances).toHaveLength(1);
    });
  });

  it('opens the app and switches to the session when the notification is clicked', async () => {
    const setActiveSession = vi.fn();
    useSessionStore.setState({ setActiveSession } as Partial<ReturnType<typeof useSessionStore.getState>>);
    render(<Harness />);

    useAgentStore.setState({
      events: { 'session-1': [{ kind: 'done' }] },
      eventTimestamps: { 'session-1': [1] },
    });

    await waitFor(() => {
      expect(notificationInstances).toHaveLength(1);
    });

    notificationInstances[0].onclick?.();

    await waitFor(() => {
      expect(showMainWindowMock).toHaveBeenCalled();
      expect(setActiveSession).toHaveBeenCalledWith('session-1');
    });
  });
});
```

- [ ] **Step 2: 运行 hook 测试并确认失败**

Run:

```powershell
npx vitest run src/hooks/useAgentNotifications.test.tsx
```

Expected: FAIL，错误包含 `Cannot find module './useAgentNotifications'`。

- [ ] **Step 3: 实现 hook**

Create `src/hooks/useAgentNotifications.ts`:

```typescript
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import { buildAgentNotificationCandidate, shouldDispatchAgentNotification } from '../lib/agentNotifications';
import { createLogger, serializeError } from '../lib/logger';
import { appApi } from '../lib/tauri';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { NotificationSound } from '../types/provider';

const logger = createLogger('agentNotifications');

function getSoundUrl(sound: NotificationSound): string {
  return `/sounds/${sound}.wav`;
}

function useAppInactive(): boolean {
  const [inactive, setInactive] = useState(() =>
    typeof document !== 'undefined' ? !document.hasFocus() : false,
  );

  useEffect(() => {
    const updateFromFocus = () => {
      setInactive(!document.hasFocus());
    };

    window.addEventListener('focus', updateFromFocus);
    window.addEventListener('blur', updateFromFocus);
    document.addEventListener('visibilitychange', updateFromFocus);

    updateFromFocus();

    return () => {
      window.removeEventListener('focus', updateFromFocus);
      window.removeEventListener('blur', updateFromFocus);
      document.removeEventListener('visibilitychange', updateFromFocus);
    };
  }, []);

  return inactive;
}

async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) {
      return true;
    }
    return await requestPermission() === 'granted';
  } catch (error) {
    logger.error('Failed to check notification permission', undefined, serializeError(error));
    return false;
  }
}

function playNotificationSound(sound: NotificationSound) {
  try {
    const audio = new Audio(getSoundUrl(sound));
    audio.volume = 0.55;
    void audio.play().catch((error) => {
      logger.debug('Notification sound playback failed', undefined, serializeError(error));
    });
  } catch (error) {
    logger.debug('Notification sound setup failed', undefined, serializeError(error));
  }
}

async function showAppSession(sessionId: string) {
  await appApi.showMainWindow();
  const sessions = useSessionStore.getState().sessions;
  if (sessions.some((session) => session.id === sessionId)) {
    useSessionStore.getState().setActiveSession(sessionId);
  }
}

async function sendClickableNotification(candidate: { title: string; body: string; sessionId: string }) {
  const notificationCtor = typeof window !== 'undefined' ? window.Notification : undefined;

  if (notificationCtor) {
    if (notificationCtor.permission === 'default') {
      await notificationCtor.requestPermission();
    }

    if (notificationCtor.permission === 'granted') {
      const notification = new notificationCtor(candidate.title, {
        body: candidate.body,
        tag: `codemux-${candidate.sessionId}`,
      });
      notification.onclick = () => {
        void showAppSession(candidate.sessionId);
      };
      return;
    }
  }

  if (await ensureNotificationPermission()) {
    sendNotification({
      title: candidate.title,
      body: candidate.body,
    });
  }
}

export function useAgentNotifications() {
  const events = useAgentStore((state) => state.events);
  const sessions = useSessionStore((state) => state.sessions);
  const notificationSettings = useSettingsStore((state) => state.config?.notifications);
  const isAppInactive = useAppInactive();
  const dispatchedKeysRef = useRef<Set<string>>(new Set());

  const sessionTitles = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions],
  );
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);

  useEffect(() => {
    const settings = notificationSettings ?? {
      system_enabled: true,
      sound_enabled: false,
      sound: 'soft' as const,
    };

    for (const [sessionId, sessionEvents] of Object.entries(events)) {
      sessionEvents.forEach((event, eventIndex) => {
        const candidate = buildAgentNotificationCandidate({
          sessionId,
          event,
          eventIndex,
          sessionTitles,
        });

        if (!shouldDispatchAgentNotification({
          candidate,
          isAppInactive,
          systemEnabled: settings.system_enabled,
          alreadyDispatched: candidate ? dispatchedKeysRef.current.has(candidate.key) : false,
        }) || !candidate) {
          return;
        }

        dispatchedKeysRef.current.add(candidate.key);

        void sendClickableNotification(candidate);

        if (settings.sound_enabled) {
          playNotificationSound(settings.sound);
        }
      });
    }
  }, [events, isAppInactive, notificationSettings, sessionTitles]);
}
```

- [ ] **Step 4: 记录桌面点击行为的实现边界**

在 `src/hooks/useAgentNotifications.ts` 的 `sendClickableNotification` 上方加入注释：

```typescript
// Tauri notification actions are mobile-only. Desktop uses the Web
// Notification API so notification clicks can reopen codeMUX and select
// the originating session. The Tauri plugin remains the fallback sender.
```

- [ ] **Step 5: 挂载 hook**

在 `src/App.tsx` imports 中加入：

```typescript
import { useAgentNotifications } from './hooks/useAgentNotifications';
```

在 `function App()` 中 `useTheme();` 后加入：

```typescript
useAgentNotifications();
```

- [ ] **Step 6: 运行测试**

Run:

```powershell
npx vitest run src/lib/agentNotifications.test.ts src/hooks/useAgentNotifications.test.tsx
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/hooks/useAgentNotifications.ts src/hooks/useAgentNotifications.test.tsx src/App.tsx
git commit -m "feat(agent): 添加后台任务系统通知"
```

---

### Task 5: 设置 UI 与试听

**Files:**
- Create: `src/components/settings/NotificationSettingsSection.tsx`
- Create: `src/components/settings/NotificationSettingsSection.test.tsx`
- Modify: `src/components/settings/GeneralSettings.tsx`
- Create: `public/sounds/soft.wav`
- Create: `public/sounds/clear.wav`
- Create: `public/sounds/alert.wav`

- [ ] **Step 1: 生成三个短 WAV 提示音**

Run:

```powershell
@'
import math
import struct
import wave
from pathlib import Path

Path("public/sounds").mkdir(parents=True, exist_ok=True)

def write_tone(path, frequencies, duration=0.18, rate=44100):
    frames = int(duration * rate)
    with wave.open(str(path), "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        for i in range(frames):
            t = i / rate
            envelope = min(1.0, i / (rate * 0.015), (frames - i) / (rate * 0.045))
            value = sum(math.sin(2 * math.pi * freq * t) for freq in frequencies) / len(frequencies)
            sample = int(0.28 * envelope * value * 32767)
            f.writeframes(struct.pack("<h", sample))

write_tone(Path("public/sounds/soft.wav"), [660, 880], 0.16)
write_tone(Path("public/sounds/clear.wav"), [880, 1174], 0.18)
write_tone(Path("public/sounds/alert.wav"), [740, 988, 1318], 0.22)
'@ | python -
```

Expected: `public/sounds/soft.wav`、`clear.wav`、`alert.wav` 存在。

- [ ] **Step 2: 写设置 UI 测试**

Create `src/components/settings/NotificationSettingsSection.test.tsx`:

```typescript
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '../../stores/settingsStore';
import type { AppConfig } from '../../types/provider';
import { NotificationSettingsSection } from './NotificationSettingsSection';

const setNotificationSettingsMock = vi.fn();

vi.mock('../../stores/settingsStore', async () => {
  const actual = await vi.importActual<typeof import('../../stores/settingsStore')>('../../stores/settingsStore');
  return {
    ...actual,
    useSettingsStore: actual.useSettingsStore,
  };
});

const baseConfig: AppConfig = {
  providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: { sdk_mode: 'responses' },
    gemini_cli: {},
    opencode: {},
  },
  compact_ai_output: false,
  notifications: {
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft',
  },
  theme: 'System',
};

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      config: structuredClone(baseConfig),
      setNotificationSettings: setNotificationSettingsMock,
    } as Partial<ReturnType<typeof useSettingsStore.getState>>);
    vi.stubGlobal('Audio', vi.fn(() => ({
      volume: 1,
      play: vi.fn(async () => undefined),
    })));
  });

  it('renders notification controls with sound disabled by default', () => {
    render(<NotificationSettingsSection />);

    expect(screen.getByText('通知')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '系统通知' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '提示音' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: '试听提示音' })).toBeDisabled();
  });

  it('updates settings when enabling sound', () => {
    render(<NotificationSettingsSection />);

    fireEvent.click(screen.getByRole('switch', { name: '提示音' }));

    expect(setNotificationSettingsMock).toHaveBeenCalledWith({
      system_enabled: true,
      sound_enabled: true,
      sound: 'soft',
    });
  });
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run:

```powershell
npx vitest run src/components/settings/NotificationSettingsSection.test.tsx
```

Expected: FAIL，错误包含 `Cannot find module './NotificationSettingsSection'`。

- [ ] **Step 4: 实现通知设置组件**

Create `src/components/settings/NotificationSettingsSection.tsx`:

```typescript
import { Bell, Volume2 } from 'lucide-react';

import { useSettingsStore } from '../../stores/settingsStore';
import type { NotificationSound } from '../../types/provider';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';

const SOUND_OPTIONS: Array<{ value: NotificationSound; label: string }> = [
  { value: 'soft', label: '轻提示' },
  { value: 'clear', label: '清脆提示' },
  { value: 'alert', label: '明显提示' },
];

function playPreview(sound: NotificationSound) {
  const audio = new Audio(`/sounds/${sound}.wav`);
  audio.volume = 0.55;
  void audio.play();
}

export function NotificationSettingsSection() {
  const settings = useSettingsStore((state) => state.config?.notifications ?? {
    system_enabled: true,
    sound_enabled: false,
    sound: 'soft' as const,
  });
  const setNotificationSettings = useSettingsStore((state) => state.setNotificationSettings);

  return (
    <div className="space-y-3">
      <label className="text-sm text-foreground/74">通知</label>
      <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Bell className="h-4 w-4 text-foreground/58" />
              系统通知
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              codeMUX 不活跃时，任务完成或等待你回复会显示系统通知。
            </p>
          </div>
          <Switch
            aria-label="系统通知"
            checked={settings.system_enabled}
            onCheckedChange={(checked) => {
              void setNotificationSettings({ ...settings, system_enabled: checked });
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border/55 pt-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Volume2 className="h-4 w-4 text-foreground/58" />
              提示音
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              可选播放短提示音，默认关闭。
            </p>
          </div>
          <Switch
            aria-label="提示音"
            checked={settings.sound_enabled}
            onCheckedChange={(checked) => {
              void setNotificationSettings({ ...settings, sound_enabled: checked });
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/55 pt-3">
          <Select
            value={settings.sound}
            disabled={!settings.sound_enabled}
            onValueChange={(value) => {
              void setNotificationSettings({ ...settings, sound: value as NotificationSound });
            }}
          >
            <SelectTrigger aria-label="提示音类型" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOUND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!settings.sound_enabled}
            onClick={() => playPreview(settings.sound)}
          >
            <Volume2 className="h-3.5 w-3.5" />
            试听
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 挂载到常规设置**

在 `src/components/settings/GeneralSettings.tsx` imports 中加入：

```typescript
import { NotificationSettingsSection } from './NotificationSettingsSection';
```

在“显示偏好”区块后、配置文件区块前加入：

```tsx
<NotificationSettingsSection />
```

- [ ] **Step 6: 运行 UI 测试**

Run:

```powershell
npx vitest run src/components/settings/NotificationSettingsSection.test.tsx
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/components/settings/NotificationSettingsSection.tsx src/components/settings/NotificationSettingsSection.test.tsx src/components/settings/GeneralSettings.tsx public/sounds/soft.wav public/sounds/clear.wav public/sounds/alert.wav
git commit -m "feat(settings): 添加通知与提示音设置"
```

---

### Task 6: 集成验证与回归

**Files:**
- Modify: only files touched by Tasks 1-5 when an integration check finds a concrete compile or test failure.

- [ ] **Step 1: 运行前端相关测试**

Run:

```powershell
npx vitest run src/stores/settingsStore.test.ts src/lib/agentNotifications.test.ts src/hooks/useAgentNotifications.test.tsx src/components/settings/NotificationSettingsSection.test.tsx
```

Expected: PASS。

- [ ] **Step 2: 运行前端构建**

Run:

```powershell
npm run build
```

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 3: 运行 Rust 格式检查和编译检查**

Run:

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo check --all-targets --all-features
```

Expected: 两个命令都 PASS。

- [ ] **Step 4: 手动验证通知权限和后台触发**

Run:

```powershell
npm run tauri dev
```

手动步骤：

1. 打开设置 > 常规，确认系统通知开启、提示音关闭。
2. 切到其他应用，使 codeMUX 失焦。
3. 让一个会话完成任务，确认 Windows 右下角出现“任务已完成”通知。
4. 触发 `ask_user_question` 或权限审批，确认出现“需要你的回复”或“需要你的审批”通知。
5. 点击通知，确认 codeMUX 显示、聚焦，并切换到对应会话。
6. 开启提示音并选择 `clear`，重复完成事件，确认播放短提示音。
7. 关闭系统通知，重复完成事件，确认不弹通知。

Expected: 每一步符合描述。

- [ ] **Step 5: 检查 git 状态**

Run:

```powershell
git status --short
```

Expected: 没有未提交改动。手动验证产生的本地日志或配置变更不属于本功能提交内容。

- [ ] **Step 6: Final commit if integration fixes were needed**

Task 6 期间产生集成修复时提交：

```powershell
git add src src-tauri package.json package-lock.json public/sounds
git commit -m "fix(notification): 完善通知集成"
```

没有任何改动时跳过此步骤。

---

## Self-Review

- Spec coverage: 计划覆盖系统通知默认开启、提示音默认关闭、多个提示音、设置 UI、等待输入通知、任务完成通知、失焦/最小化/托盘隐藏状态、点击通知切换会话、旧配置兼容、测试与手动验证。
- Scope check: 该 spec 是一个单一功能，子系统包括配置、通知规则、运行时 hook、设置 UI 和 Tauri 插件，但它们共同交付同一条可测试用户体验，不需要拆成多个独立计划。
- Completeness scan: 本计划没有未完成标记或未定义的空泛步骤；桌面点击行为明确使用 Web Notification API，Tauri notification 插件作为兜底发送。
- Type consistency: 通知设置统一使用 `NotificationSettings`，字段为 `system_enabled`、`sound_enabled`、`sound`；提示音类型统一为 `'soft' | 'clear' | 'alert'`；通知候选统一使用 `AgentNotificationCandidate`。
