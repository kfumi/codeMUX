# AI 任务系统通知与提示音设计

## 背景

CodeMUX 是 Tauri 2 桌面应用，用户经常在 AI 任务运行期间切到其他窗口、最小化应用或把主窗口隐藏到托盘。当前任务完成、任务失败、权限审批和 AI 提问主要通过应用内聊天区域或未读状态体现；当主窗口不活跃时，用户需要主动切回来才知道任务已经结束或正在等待输入。

本设计为 CodeMUX 增加系统级通知与可选提示音：当应用失焦、最小化或隐藏到托盘时，遇到等待用户输入或 AI 任务完成，Windows 右下角显示系统通知。提示音默认关闭，用户可在设置中开启、切换或试听。

## 目标

- 当 CodeMUX 不活跃时，对所有会话的等待用户输入事件发出系统通知。
- 当 CodeMUX 不活跃时，对所有会话的 AI 任务完成或失败发出系统通知。
- 系统通知默认开启，提示音默认关闭。
- 提供多个内置提示音，可在设置中切换、试听或关闭。
- 用户点击系统通知后，打开 CodeMUX 并切换到对应会话。
- 复用现有 `agentStore`、`sessionStore`、`settingsStore` 和设置页模式，避免通知逻辑散落在聊天组件中。

## 非目标

- 不实现每种事件单独开关。本阶段等待输入和任务完成共用同一套系统通知设置。
- 不支持用户导入自定义提示音。
- 不实现跨设备推送、邮件、短信或第三方通知渠道。
- 不新增复杂的通知历史中心。
- 不改变现有权限审批和 AI 提问的交互卡片，只在其事件到达时补充系统提醒。

## 推荐方案

采用“前端统一通知调度层 + Tauri 原生通知插件 + 前端音频播放”的方案。

### 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 前端统一调度，Tauri 插件发通知 | 贴合现有事件归并位置，点击跳转和测试方便 | 需要新增通知插件和调度层 | 采用 |
| Rust 后端统一调度 | 更接近系统层 | 需要同步前端活跃会话、窗口状态、设置和事件去重，复杂度偏高 | 不采用 |
| Web Notification API | 实现较轻 | 桌面端一致性、权限和点击行为不如 Tauri 原生通知 | 不采用 |

## 架构

### Tauri 层

接入 Tauri notification 插件：

- `package.json` 增加 `@tauri-apps/plugin-notification`。
- `src-tauri/Cargo.toml` 增加 `tauri-plugin-notification`。
- `src-tauri/src/lib.rs` 注册 notification 插件。
- 如项目能力文件需要显式权限，补充 notification 权限。

Tauri 层只负责原生通知能力，不承载业务判断。是否通知、通知内容、点击后切换哪个会话，均由前端调度层决定。

### 前端通知调度层

新增通知调度模块，例如 `src/lib/agentNotifications.ts` 与一个全局挂载的 React hook。

职责：

- 监听 `agentStore` 中每个会话的新事件。
- 读取 `sessionStore` 的会话标题、活动会话和会话切换能力。
- 读取 `settingsStore` 的通知设置。
- 维护应用活跃状态：失焦、最小化、隐藏到托盘均视为不活跃。
- 对事件进行分类、去重、发送系统通知并播放提示音。
- 处理通知点击，显示并聚焦主窗口，然后切换到对应会话。

建议把触发判断拆成纯函数，便于单元测试：

```typescript
type AgentNotificationKind = 'requires_input' | 'task_completed' | 'task_failed';

interface AgentNotificationCandidate {
  key: string;
  kind: AgentNotificationKind;
  sessionId: string;
  title: string;
  body: string;
}
```

调度层消费候选通知，再根据应用活跃状态和设置决定是否实际发送。

### 应用活跃状态

新增轻量状态跟踪：

- 浏览器 `window` 的 `focus` / `blur` 事件用于判断失焦。
- Tauri window API 用于监听最小化、恢复、可见性或关闭到托盘相关状态。
- 当前主窗口不可见、最小化或没有焦点时，统一记为 `inactive`。

如果某个平台无法可靠返回某项窗口状态，使用保守策略：只要 `document.hasFocus()` 为 `false`，就允许通知；当窗口重新获得焦点时恢复为活跃。

### 设置与配置

在 `AppConfig` 中新增通知配置：

```typescript
notifications: {
  system_enabled: true,
  sound_enabled: false,
  sound: 'soft'
}
```

Rust 配置类型同步增加默认值，旧配置文件缺少 `notifications` 时自动补齐。

前端类型同步：

```typescript
export type NotificationSound = 'soft' | 'clear' | 'alert';

export interface NotificationSettings {
  system_enabled: boolean;
  sound_enabled: boolean;
  sound: NotificationSound;
}
```

`settingsStore` 增加更新方法，可整体更新通知设置，也可提供细粒度 setter。实现时应沿用现有乐观更新和失败回滚模式。

### 设置 UI

在“设置 > 常规”中新增“通知”区域：

- “系统通知”开关，默认开启。
- “提示音”开关，默认关闭。
- “提示音类型”下拉选择，提示音关闭时禁用。
- “试听”按钮，播放当前选中的提示音。

提示音内置三种：

| 值 | 名称 | 用途 |
| --- | --- | --- |
| `soft` | 轻提示 | 默认选项，适合低打扰提醒 |
| `clear` | 清脆提示 | 更容易察觉 |
| `alert` | 明显提示 | 适合想强化等待审批感知的用户 |

音频资源放在 `public/sounds/`，文件应短小、音量适中，避免明显打扰。

## 触发规则

### 等待用户输入

等待用户输入事件包括：

- `ask_user_question`：AI 主动提问，需要用户选择或回答。
- 权限审批：本阶段归入等待输入类。如果审批事件已经通过 `ask_user_question` 呈现，直接复用；如果后续新增独立审批事件，则接入同一候选通知接口。

通知文案：

- 标题：`需要你的回复` 或 `需要你的审批`。
- 内容：优先显示会话标题，并追加问题或审批摘要。

去重键：

```text
requires_input:{sessionId}:{tool_use_id}
```

同一 `tool_use_id` 只通知一次。

### 任务完成与失败

终止事件包括现有 `agentStore` 判定为终止事件的 `done`、`result`、`error`。其中：

- 成功完成：标题 `任务已完成`。
- 失败或错误：标题 `任务失败`。

通知内容包含会话标题。若错误事件有简短错误信息，可在内容中追加，但避免把长堆栈放入系统通知。

去重键：

```text
terminal:{sessionId}:{eventKind}:{eventIndexOrTimestamp}
```

每次用户发起任务后产生的终止事件都可以通知。后台多个会话完成时分别通知。

### 活跃状态限制

只有 CodeMUX 不活跃时才发送系统通知并播放提示音。不活跃包括：

- 主窗口失去焦点。
- 主窗口最小化。
- 主窗口隐藏到托盘。

当用户正在活跃查看 CodeMUX 时，不发送系统通知，也不播放提示音。应用内已有聊天状态和未读状态足够提示。

## 点击通知行为

用户点击系统通知后：

1. 显示主窗口。
2. 取消最小化。
3. 聚焦主窗口。
4. 切换到通知对应的 `sessionId`。
5. 复用 `sessionStore.setActiveSession(sessionId)` 清除该会话未读状态。

如果点击时会话已经被删除，则只显示并聚焦主窗口，不切换会话。

## 数据流

### 等待用户输入

```text
Agent 事件到达 agentStore
  -> 新事件为 ask_user_question 或审批类事件
  -> 通知调度层生成 requires_input 候选通知
  -> 检查应用是否不活跃
  -> 检查系统通知设置
  -> 按 sessionId + tool_use_id 去重
  -> 发送系统通知
  -> 如果提示音开启，播放选中的提示音
```

### 任务完成

```text
Agent 事件到达 agentStore
  -> 新事件为 done/result/error
  -> agentStore 更新运行状态和未读状态
  -> 通知调度层生成 task_completed 或 task_failed 候选通知
  -> 检查应用是否不活跃
  -> 检查系统通知设置
  -> 按终止事件去重
  -> 发送系统通知
  -> 如果提示音开启，播放选中的提示音
```

### 点击通知

```text
用户点击系统通知
  -> notification 点击回调携带 sessionId
  -> 调用显示主窗口能力
  -> 校验会话仍存在
  -> sessionStore.setActiveSession(sessionId)
```

## 错误处理

- 系统通知权限未授权或被系统拒绝：记录日志，不阻塞任务；提示音仍可按设置播放。
- 通知发送失败：记录日志并静默降级，避免影响 Agent 流程。
- 音频播放失败：记录调试日志并静默降级。
- 通知点击时会话不存在：只打开 CodeMUX，不抛错。
- 获取窗口状态失败：使用 `document.hasFocus()` 和已知事件状态作为回退。
- 旧配置缺少 `notifications`：反序列化时自动使用默认配置。

## 测试计划

新增或更新以下测试：

- `src/stores/settingsStore.test.ts`
  - 旧配置缺少通知字段时得到默认值。
  - 更新系统通知、提示音开关和提示音类型后状态正确。
  - 更新失败时回滚到旧值。
- 通知规则纯函数测试
  - 活跃状态下不产生实际通知。
  - 不活跃状态下等待输入会通知。
  - 不活跃状态下任务完成和失败会通知。
  - 同一等待输入 `tool_use_id` 不重复通知。
  - 多个后台会话完成时分别通知。
- `src/components/settings/GeneralSettings.test.tsx`
  - 通知设置区域渲染正确。
  - 提示音关闭时下拉和试听禁用或按设计限制。
  - 切换开关和选择提示音会调用设置更新。
- 手动验证
  - `npm run build`
  - `cd src-tauri && cargo check --all-targets --all-features`
  - Windows 上失焦、最小化、隐藏到托盘后的通知展示。
  - 点击通知后打开 CodeMUX 并切换到对应会话。
  - 提示音关闭时无声音，开启后播放所选声音。

## 验收标准

- 系统通知默认开启，提示音默认关闭。
- CodeMUX 活跃时，任务完成和等待输入不会弹系统通知，也不会播放提示音。
- CodeMUX 失焦、最小化或隐藏到托盘时，等待用户输入会弹系统通知。
- CodeMUX 失焦、最小化或隐藏到托盘时，任意会话任务完成或失败会弹系统通知。
- 通知点击后主窗口显示、聚焦，并切换到对应会话。
- 设置页可开关系统通知、开关提示音、切换提示音并试听。
- 老配置文件升级后无需手动编辑即可获得默认通知配置。
