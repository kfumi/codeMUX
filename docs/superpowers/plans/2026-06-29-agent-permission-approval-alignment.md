# Agent Permission Approval Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Claude Code and Codex permission approval behavior with the medium-scope design while preserving the current sidecar and assistant-ui architecture.

**Architecture:** Keep session persistence and Rust command injection unchanged. Resolve effective permission policy in frontend helpers and sidecar helpers, then route Claude approvals through the existing `ask_user_question`/`tool_response` channel with clearer metadata and copy. Codex plan mode becomes read-only at the sidecar boundary, and Codex approval event support is audited in the SDK event switch.

**Tech Stack:** React 18, TypeScript, Vitest, Tauri 2, Rust command shell, Anthropic Claude Agent SDK, OpenAI Codex SDK.

---

## File Structure

- Modify `src/lib/agentPermissions.ts`: frontend permission preset mapping and effective config resolution.
- Modify `src/lib/agentPermissions.test.ts`: TDD coverage for Codex auto-edit and plan-mode effective config.
- Modify `src-tauri/sidecar/src/agentPermissions.ts`: sidecar SDK option resolution and effective mode description helper.
- Modify `src-tauri/sidecar/src/agentPermissions.test.ts`: TDD coverage for Codex plan overrides and status description.
- Modify `src/components/agent/AgentPermissionSelector.tsx`: readable Chinese labels and Codex plan display.
- Modify `src/components/agent/AgentPermissionSelector.test.tsx`: UI tests for readable labels and Codex plan display.
- Modify `src/components/agent/AskUserQuestionCard.tsx`: readable Chinese labels and approval-friendly behavior.
- Create `src/components/agent/AskUserQuestionCard.test.tsx`: UI tests for approval card copy and response submission.
- Create `src-tauri/sidecar/src/claudeApprovalPrompt.ts`: pure helper for readable Claude approval titles.
- Create `src-tauri/sidecar/src/claudeApprovalPrompt.test.ts`: helper tests without importing the sidecar main loop.
- Modify `src-tauri/sidecar/src/index.ts`: use readable Claude approval titles and denial messages.
- Modify `src-tauri/sidecar/src/codexRuntime.ts`: Codex approval event-shape audit comment/diagnostic handling.
- Modify `src-tauri/sidecar/src/codexRuntime.test.ts`: coverage for Codex plan thread options and approval-event fallback.

---

### Task 1: Frontend Permission Mapping

**Files:**
- Modify: `src/lib/agentPermissions.test.ts`
- Modify: `src/lib/agentPermissions.ts`

- [ ] **Step 1: Write failing tests for Codex medium-alignment policy**

Update `src/lib/agentPermissions.test.ts` so the Codex preset and effective-plan tests expect confirmation-before-change:

```ts
  it('maps unified execution presets to native Codex sandbox and approval settings', () => {
    expect(mapExecutionModeToPermissionConfig('codex', 'confirm_before_edit')).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'auto_edit')).toEqual({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(mapExecutionModeToPermissionConfig('codex', 'full_access')).toEqual({
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    });
  });

  it('forces Codex plan mode to read-only approval settings', () => {
    const configured: AgentPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    };

    expect(resolveEffectivePermissionConfig('codex', configured, 'on')).toEqual({
      kind: 'codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });
```

- [ ] **Step 2: Run frontend permission tests and verify failure**

Run:

```bash
npx vitest run src/lib/agentPermissions.test.ts
```

Expected: FAIL because `auto_edit` still returns `approvalPolicy: 'never'` and Codex plan mode still returns the configured value.

- [ ] **Step 3: Implement frontend permission mapping**

Update the Codex branch in `mapExecutionModeToPermissionConfig` in `src/lib/agentPermissions.ts`:

```ts
      case 'auto_edit':
        return {
          kind: 'codex',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          networkAccessEnabled: false,
        };
```

Update `resolveEffectivePermissionConfig` to force Codex plan mode:

```ts
  if (agentKind === 'codex' && planMode === 'on') {
    return {
      kind: 'codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    };
  }
```

- [ ] **Step 4: Run frontend permission tests and verify pass**

Run:

```bash
npx vitest run src/lib/agentPermissions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/lib/agentPermissions.ts src/lib/agentPermissions.test.ts
git commit -m "fix(agent): align frontend permission presets"
```

Expected: commit succeeds with only these two files staged.

---

### Task 2: Sidecar Permission Resolution

**Files:**
- Modify: `src-tauri/sidecar/src/agentPermissions.test.ts`
- Modify: `src-tauri/sidecar/src/agentPermissions.ts`

- [ ] **Step 1: Write failing sidecar permission tests**

Update the final Codex test in `src-tauri/sidecar/src/agentPermissions.test.ts`:

```ts
  it('forces Codex plan mode to read-only approval settings', () => {
    const config: SidecarPermissionConfig = {
      kind: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    };

    expect(buildCodexThreadPermissionOptions(config, 'on')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });
```

Add an import and test for a status helper:

```ts
import {
  buildClaudePermissionOptions,
  buildCodexThreadPermissionOptions,
  describeCodexPermissionOptions,
  type SidecarPermissionConfig,
} from './agentPermissions.js';

  it('describes effective Codex permission options for status logging', () => {
    expect(describeCodexPermissionOptions({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    })).toBe('read-only/on-request/network-off');
  });
```

- [ ] **Step 2: Run sidecar permission tests and verify failure**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/agentPermissions.test.ts
```

Expected: FAIL because plan mode is ignored and `describeCodexPermissionOptions` does not exist.

- [ ] **Step 3: Implement sidecar policy resolution**

Update `buildCodexThreadPermissionOptions` in `src-tauri/sidecar/src/agentPermissions.ts`:

```ts
export function buildCodexThreadPermissionOptions(config: unknown, planMode: AgentPlanMode = 'off'): {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
} {
  if (planMode === 'on') {
    return {
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    };
  }

  const raw = isRecord(config) ? config : {};
  return {
    sandboxMode: isCodexSandboxMode(raw.sandboxMode) ? raw.sandboxMode : 'workspace-write',
    approvalPolicy: isCodexApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : 'on-request',
    networkAccessEnabled: typeof raw.networkAccessEnabled === 'boolean' ? raw.networkAccessEnabled : false,
  };
}
```

Add the helper below the builder:

```ts
export function describeCodexPermissionOptions(options: {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  networkAccessEnabled: boolean;
}): string {
  return `${options.sandboxMode}/${options.approvalPolicy}/${options.networkAccessEnabled ? 'network-on' : 'network-off'}`;
}
```

- [ ] **Step 4: Use helper in Codex runtime status**

Modify the import in `src-tauri/sidecar/src/codexRuntime.ts`:

```ts
import {
  buildCodexThreadPermissionOptions,
  describeCodexPermissionOptions,
  type AgentPlanMode,
  type SidecarPermissionConfig,
} from './agentPermissions.js';
```

Replace the system init `permissionMode` value:

```ts
      permissionMode: describeCodexPermissionOptions(permissionOptions),
```

- [ ] **Step 5: Run sidecar permission tests and Codex runtime tests**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/agentPermissions.test.ts src/codexRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src-tauri/sidecar/src/agentPermissions.ts src-tauri/sidecar/src/agentPermissions.test.ts src-tauri/sidecar/src/codexRuntime.ts
git commit -m "fix(sidecar): enforce codex plan permissions"
```

Expected: commit succeeds with only these three files staged.

---

### Task 3: Permission Selector Copy and Plan Display

**Files:**
- Modify: `src/components/agent/AgentPermissionSelector.test.tsx`
- Modify: `src/components/agent/AgentPermissionSelector.tsx`

- [ ] **Step 1: Write failing selector tests with readable Chinese copy**

Replace the test expectations in `src/components/agent/AgentPermissionSelector.test.tsx` with readable copy:

```tsx
  it('shows Claude Code options matching native permission modes', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="claude_code"
        permissionConfig={{ kind: 'claude_code', permissionMode: 'default' }}
        planMode="off"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle('变更前确认'));

    expect(screen.getAllByText('变更前确认')).toHaveLength(2);
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    fireEvent.click(screen.getByText('计划模式'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({ kind: 'claude_code', permissionMode: 'plan' });
    expect(onPlanModeChange).toHaveBeenCalledWith('on');
  });

  it('shows Codex plan mode as read-only without changing plan mode from the selector', () => {
    const onPermissionConfigChange = vi.fn();
    const onPlanModeChange = vi.fn();

    render(
      <AgentPermissionSelector
        agentKind="codex"
        permissionConfig={{
          kind: 'codex',
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          networkAccessEnabled: true,
        }}
        planMode="on"
        onPermissionConfigChange={onPermissionConfigChange}
        onPlanModeChange={onPlanModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle('计划只读'));

    expect(screen.getByText('Codex 操作审批')).toBeTruthy();
    expect(screen.getByText('计划只读')).toBeTruthy();
    expect(screen.getByText('请求批准')).toBeTruthy();
    expect(screen.getByText('自动编辑')).toBeTruthy();
    expect(screen.getByText('完全访问')).toBeTruthy();

    fireEvent.click(screen.getByText('自动编辑'));

    expect(onPermissionConfigChange).toHaveBeenCalledWith({
      kind: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
    expect(onPlanModeChange).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run selector test and verify failure**

Run:

```bash
npx vitest run src/components/agent/AgentPermissionSelector.test.tsx
```

Expected: FAIL because component text is mojibake and Codex plan mode does not display `计划只读`.

- [ ] **Step 3: Replace selector options and selected display**

In `src/components/agent/AgentPermissionSelector.tsx`, replace `claudeOptions` and `codexOptions`:

```ts
const claudeOptions: PermissionOption[] = [
  { mode: 'confirm_before_edit', label: '变更前确认', description: '修改文件或运行敏感工具前先询问。', icon: Hand },
  { mode: 'auto_edit', label: '自动编辑', description: '允许 Claude 自动编辑文件。', icon: ShieldCheck },
  { mode: 'plan', label: '计划模式', description: '先分析和规划，暂不直接修改。', icon: ClipboardList },
  { mode: 'full_access', label: '完全访问', description: '跳过权限确认，风险更高。', icon: Shield, tone: 'warning' },
];

const codexOptions: PermissionOption[] = [
  { mode: 'confirm_before_edit', label: '请求批准', description: '文件变更和敏感操作前请求确认。', icon: Hand },
  { mode: 'auto_edit', label: '自动编辑', description: '保持工作区写入，但仍按策略请求批准。', icon: ShieldQuestion },
  { mode: 'full_access', label: '完全访问', description: '允许不受限访问文件和网络，风险更高。', icon: Shield, tone: 'warning' },
];
```

Add a plan-mode display override after `selected` is computed:

```ts
  const displaySelected = agentKind === 'codex' && planMode === 'on'
    ? { ...selected, label: '计划只读', icon: ClipboardList, tone: undefined }
    : selected;
  const SelectedIcon = displaySelected.icon;
```

Update title and label reads from `selected` to `displaySelected`:

```tsx
        title={displaySelected.label}
```

```tsx
        <span className="truncate">{displaySelected.label}</span>
```

Replace the Codex menu intro:

```tsx
              <span>Codex 操作审批</span>
              <span className="text-muted-foreground/80">计划模式会强制只读</span>
```

Keep the warning tone class based on `displaySelected.tone`.

- [ ] **Step 4: Run selector test and verify pass**

Run:

```bash
npx vitest run src/components/agent/AgentPermissionSelector.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/components/agent/AgentPermissionSelector.tsx src/components/agent/AgentPermissionSelector.test.tsx
git commit -m "fix(ui): clarify permission selector copy"
```

Expected: commit succeeds with only these two files staged.

---

### Task 4: Ask User Question Approval Card Copy

**Files:**
- Create: `src/components/agent/AskUserQuestionCard.test.tsx`
- Modify: `src/components/agent/AskUserQuestionCard.tsx`

- [ ] **Step 1: Write failing approval card tests**

Create `src/components/agent/AskUserQuestionCard.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToolResponse = vi.fn();

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    sendToolResponse,
  },
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: () => false,
}));

import { AskUserQuestionCard } from './AskUserQuestionCard';

describe('AskUserQuestionCard', () => {
  afterEach(() => {
    cleanup();
    sendToolResponse.mockReset();
  });

  it('renders readable approval copy and sends the selected answer', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          header: '审批',
          question: '允许 Claude 编辑 src/app.ts 吗？',
          options: [
            { label: '允许', description: '执行这一次操作。' },
            { label: '拒绝', description: '阻止这一次操作。' },
          ],
        }]}
      />,
    );

    expect(screen.getByText('审批')).toBeTruthy();
    expect(screen.getByText('允许 Claude 编辑 src/app.ts 吗？')).toBeTruthy();
    expect(screen.getByText('执行这一次操作。')).toBeTruthy();

    fireEvent.click(screen.getByText('允许'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['允许']);
    });
  });

  it('cancels with a readable submitted answer', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          question: '需要继续吗？',
          options: [{ label: '继续' }],
        }]}
      />,
    );

    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['__cancelled__']);
      expect(screen.getByText('已取消')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run approval card tests and verify failure**

Run:

```bash
npx vitest run src/components/agent/AskUserQuestionCard.test.tsx
```

Expected: FAIL because the component contains mojibake labels.

- [ ] **Step 3: Replace mojibake UI copy**

In `src/components/agent/AskUserQuestionCard.tsx`, replace these strings:

```tsx
setSubmittedAnswers(questions.map(() => '已取消'));
```

```tsx
if (idx === OTHER_IDX) return otherTexts[i]?.trim() || '其他';
```

```tsx
setSubmittedAnswers(questions.map(() => '已取消'));
```

```tsx
<span className="font-medium">其他</span>
```

```tsx
placeholder="请输入..."
```

```ts
const headerText = questions[0]?.header || '需要你的输入';
```

```tsx
{submittedAnswers[qIdx] || '已回答'}
```

```tsx
{q.header || `问题 ${i + 1}`}
```

```tsx
取消
```

```tsx
{submitting ? '提交中...' : '提交'}
```

Apply both repeated button blocks.

- [ ] **Step 4: Run approval card tests and verify pass**

Run:

```bash
npx vitest run src/components/agent/AskUserQuestionCard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add src/components/agent/AskUserQuestionCard.tsx src/components/agent/AskUserQuestionCard.test.tsx
git commit -m "fix(ui): clarify approval card copy"
```

Expected: commit succeeds with only these two files staged.

---

### Task 5: Claude Approval Prompt Generation

**Files:**
- Create: `src-tauri/sidecar/src/claudeApprovalPrompt.ts`
- Create: `src-tauri/sidecar/src/claudeApprovalPrompt.test.ts`
- Modify: `src-tauri/sidecar/src/index.ts`

- [ ] **Step 1: Add tests for a pure approval title helper**

Create `src-tauri/sidecar/src/claudeApprovalPrompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';

describe('getClaudeApprovalTitle', () => {
  it('describes file edits with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Edit', { file_path: 'src/app.ts' }, {})).toBe('允许 Claude 编辑 src/app.ts 吗？');
  });

  it('describes file writes with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Write', { file_path: 'src/new.ts' }, {})).toBe('允许 Claude 写入 src/new.ts 吗？');
  });

  it('describes bash commands with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Bash', { command: 'npm test' }, {})).toBe('允许 Claude 运行命令：npm test');
  });
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/claudeApprovalPrompt.test.ts
```

Expected: FAIL because `src-tauri/sidecar/src/claudeApprovalPrompt.ts` does not exist.

- [ ] **Step 3: Implement readable approval title helper**

Create `src-tauri/sidecar/src/claudeApprovalPrompt.ts`:

```ts
export function getClaudeApprovalTitle(
  toolName: string,
  input: Record<string, unknown>,
  opts: { title?: string; displayName?: string } = {},
): string {
  if (typeof opts.title === 'string' && opts.title.trim()) {
    return opts.title;
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (filePath && (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit')) {
    const action = toolName === 'Write' ? '写入' : '编辑';
    return `允许 Claude ${action} ${filePath} 吗？`;
  }

  const command = typeof input.command === 'string' ? input.command : undefined;
  if (toolName === 'Bash' && command) {
    return `允许 Claude 运行命令：${command}`;
  }

  const displayName = typeof opts.displayName === 'string' && opts.displayName.trim()
    ? opts.displayName
    : toolName;
  return `允许 Claude 使用 ${displayName} 吗？`;
}
```

- [ ] **Step 4: Wire helper into sidecar approval flow**

In `src-tauri/sidecar/src/index.ts`, add the import near other local imports:

```ts
import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';
```

In the `canUseTool` non-`AskUserQuestion` branch, replace the emitted approval question:

```ts
          questions: [{
            header: '审批',
            question: title,
            options: [
              { label: '允许', description: '执行这一次操作。' },
              { label: '拒绝', description: '阻止这一次操作。' },
            ],
          }],
```

Replace approval answer comparison:

```ts
        if (answer === '允许') {
```

Replace denial message:

```ts
          message: `${toolName} was denied by the user.`,
```

Leave the denial message in English because it is returned to the SDK as a technical tool result.

Remove the old local `getClaudeApprovalTitle` function from `src-tauri/sidecar/src/index.ts`.

- [ ] **Step 5: Run sidecar helper tests**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/claudeApprovalPrompt.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add src-tauri/sidecar/src/index.ts src-tauri/sidecar/src/claudeApprovalPrompt.ts src-tauri/sidecar/src/claudeApprovalPrompt.test.ts
git commit -m "fix(sidecar): clarify claude approval prompts"
```

Expected: commit succeeds with only these three files staged.

---

### Task 6: Codex SDK Approval Event Audit

**Files:**
- Modify: `src-tauri/sidecar/src/codexRuntime.ts`
- Modify: `src-tauri/sidecar/src/codexRuntime.test.ts`

- [ ] **Step 1: Add Codex plan thread-options test**

Append this test to `src-tauri/sidecar/src/codexRuntime.test.ts`:

```ts
  it('uses read-only Codex thread options when plan mode is active', () => {
    const runtime = new CodexSessionRuntime();
    (runtime as unknown as {
      config: {
        sessionId: string;
        cwd: string;
        model: string;
        planMode: 'on';
        permissionConfig: {
          kind: 'codex';
          sandboxMode: 'danger-full-access';
          approvalPolicy: 'never';
          networkAccessEnabled: true;
        };
      };
    }).config = {
      sessionId: 'session-1',
      cwd: 'D:/repo',
      model: 'gpt-5',
      planMode: 'on',
      permissionConfig: {
        kind: 'codex',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
      },
    };

    const options = (runtime as unknown as { threadOptions: () => Record<string, unknown> }).threadOptions();

    expect(options).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });
```

- [ ] **Step 2: Add approval event-shape fallback test**

Append this test to `src-tauri/sidecar/src/codexRuntime.test.ts`:

```ts
  it('emits a structured diagnostic for unknown Codex approval-like events', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    try {
      const runtime = new CodexSessionRuntime();
      await (runtime as unknown as {
        handleSdkEvent: (
          sessionId: string,
          event: ThreadEvent,
          emitFailure: (message: string) => void,
          noteStreamError: (message: string) => void,
        ) => Promise<void>;
      }).handleSdkEvent(
        'session-1',
        {
          type: 'approval.requested',
          request_id: 'approval-1',
          item: { id: 'approval-1', type: 'command_execution', command: 'git commit', status: 'pending' },
        } as unknown as ThreadEvent,
        () => {},
        () => {},
      );

      const emittedEvents = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));

      expect(emittedEvents).toEqual([
        {
          type: 'sidecar_stream_status',
          message: 'Codex emitted unsupported approval event type: approval.requested',
          is_reconnecting: false,
        },
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
```

- [ ] **Step 3: Run Codex runtime tests and verify failure**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/codexRuntime.test.ts
```

Expected: FAIL because unknown approval-like events currently fall through silently. The plan thread-options test should pass after Task 2.

- [ ] **Step 4: Add approval event-shape audit handling**

In `handleSdkEvent` in `src-tauri/sidecar/src/codexRuntime.ts`, add this default handling after the known cases:

```ts
      default: {
        const unknownEvent = event as { type?: string };
        if (typeof unknownEvent.type === 'string' && unknownEvent.type.toLowerCase().includes('approval')) {
          emit({
            type: 'sidecar_stream_status',
            message: `Codex emitted unsupported approval event type: ${unknownEvent.type}`,
            is_reconnecting: false,
          });
        }
        return;
      }
```

Add this comment directly above the switch:

```ts
    // Codex SDK 0.139.0 exposes tool execution items and sandbox/approval policy
    // options, but this codebase has not observed a stable interactive approval
    // event shape. Approval-like unknown event types are surfaced as diagnostics
    // instead of being auto-allowed.
```

- [ ] **Step 5: Run Codex runtime tests and sidecar typecheck**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/codexRuntime.test.ts
npm run build
```

Expected: PASS and TypeScript build succeeds.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src-tauri/sidecar/src/codexRuntime.ts src-tauri/sidecar/src/codexRuntime.test.ts
git commit -m "fix(codex): surface approval event diagnostics"
```

Expected: commit succeeds with only these two files staged.

---

### Task 7: Integration Verification

**Files:**
- No source edits expected. If verification reveals a missed import or type mismatch, return to the task that introduced it, update that task's files, rerun that task's tests, and amend that task's commit.

- [ ] **Step 1: Run focused root tests**

Run:

```bash
npx vitest run src/lib/agentPermissions.test.ts src/components/agent/AgentPermissionSelector.test.tsx src/components/agent/AskUserQuestionCard.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run focused sidecar tests**

Run:

```bash
cd src-tauri/sidecar
npx vitest run src/agentPermissions.test.ts src/claudeApprovalPrompt.test.ts src/codexRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run builds**

Run:

```bash
npm run build
cd src-tauri/sidecar
npm run build
```

Expected: both builds pass.

- [ ] **Step 4: Check git status for unrelated files**

Run:

```bash
git status --short
```

Expected: only the user's untracked `docs/ai-agent-permission-approval-guide.md` remains. If any tracked implementation files are modified, stop and return to the task that introduced those files before completing verification.

---

## Self-Review Notes

- Spec coverage: Task 1 covers frontend policy semantics; Task 2 covers sidecar effective policy; Task 3 covers selector copy and Codex plan display; Task 4 covers approval card copy; Task 5 covers Claude approval prompts; Task 6 covers Codex SDK approval event audit and diagnostics; Task 7 covers verification.
- Scope check: The plan does not implement synthetic approval, batch approval, remember rules, or history cleanup, matching non-goals.
- Type consistency: The plan uses existing public types `AgentPermissionConfig`, `SidecarPermissionConfig`, `AgentPlanMode`, `ThreadEvent`, and current helper names.
