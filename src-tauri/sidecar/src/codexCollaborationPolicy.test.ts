import { describe, expect, it } from 'vitest';

import {
  applyCodexCollaborationPolicyToInput,
  buildCodexModeBlockedEvent,
  detectPlanModeBlockedMethod,
  resolveCodexCollaborationPolicy,
} from './codexCollaborationPolicy.js';

describe('codexCollaborationPolicy', () => {
  it('resolves planMode on to strict-local plan mode', () => {
    expect(resolveCodexCollaborationPolicy({ planMode: 'on' })).toMatchObject({
      selectedMode: 'plan',
      effectiveMode: 'plan',
      profile: 'strict-local',
      requestUserInputPolicy: 'allow',
      fallbackReason: null,
    });
  });

  it('resolves missing or off planMode to code mode that blocks user input tools', () => {
    expect(resolveCodexCollaborationPolicy({ planMode: 'off' })).toMatchObject({
      selectedMode: 'code',
      effectiveMode: 'code',
      requestUserInputPolicy: 'block',
    });
    expect(resolveCodexCollaborationPolicy({})).toMatchObject({
      effectiveMode: 'code',
      fallbackReason: 'missing_mode_in_request_default_code',
    });
  });

  it('keeps selectedMode null when mode is inherited from previous state', () => {
    expect(resolveCodexCollaborationPolicy({ previousMode: 'plan' })).toMatchObject({
      selectedMode: null,
      effectiveMode: 'plan',
      fallbackReason: 'missing_mode_in_request_using_thread_state',
    });
  });

  it('injects plan directives into the first text input entry', () => {
    const policy = resolveCodexCollaborationPolicy({ planMode: 'on' });
    expect(applyCodexCollaborationPolicyToInput(
      [{ type: 'text', text: 'Design the feature.' }],
      policy,
    )).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Execution policy (plan mode): work in planning-only style.'),
      },
    ]);
  });

  it('does not duplicate directives when applied twice', () => {
    const policy = resolveCodexCollaborationPolicy({ planMode: 'on' });
    const once = applyCodexCollaborationPolicyToInput([{ type: 'text', text: 'Plan it.' }], policy);
    const twice = applyCodexCollaborationPolicyToInput(once, policy);
    expect(twice).toEqual(once);
  });

  it('detects plan-mode file and repo mutation attempts', () => {
    expect(detectPlanModeBlockedMethod({
      type: 'file_change',
      id: 'patch-1',
      changes: [{ path: 'src/app.ts', kind: 'update' }],
    })).toBe('item/tool/apply_patch');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-1',
      command: 'git commit -m "ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-1',
      command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git commit -m ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-1',
      command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "git commit -m ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-2',
      command: 'git status --short',
      status: 'in_progress',
    })).toBeNull();
  });

  it('detects wrapped and option-prefixed git mutations without blocking read-only branch checks', () => {
    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-3',
      command: 'git -C ../repo commit -m "ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-4',
      command: 'git -c user.name=bot commit -m "ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-5',
      command: 'cmd /c "git commit -m ship"',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-6',
      command: 'git branch --show-current',
      status: 'in_progress',
    })).toBeNull();
  });

  it('blocks mutating git branch commands without blocking read-only searches that mention git', () => {
    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-7',
      command: 'git branch new-plan',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git branch');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-8',
      command: 'git branch -D old-plan',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git branch');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-9',
      command: 'git branch -M old-plan new-plan',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git branch');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-10',
      command: 'git status --short && git commit -m ship',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-11',
      command: 'git status; git commit -m ship',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-12',
      command: 'git status&& git commit -m ship',
      status: 'in_progress',
    })).toBe('item/tool/commandExecution:git commit');

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-13',
      command: 'rg "git commit"',
      status: 'in_progress',
    })).toBeNull();

    expect(detectPlanModeBlockedMethod({
      type: 'command_execution',
      id: 'cmd-14',
      command: 'git branch --list "feature/*"',
      status: 'in_progress',
    })).toBeNull();
  });

  it('builds a mode-blocked diagnostic event', () => {
    expect(buildCodexModeBlockedEvent({
      blockedMethod: 'item/tool/requestUserInput',
      effectiveMode: 'code',
      reasonCode: 'request_user_input_blocked_in_default_mode',
      reason: 'requestUserInput is blocked while effective_mode=code',
      suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
      requestId: 'tool-1',
    })).toEqual({
      type: 'sidecar_stream_status',
      message: expect.stringContaining('request_user_input_blocked_in_default_mode'),
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/requestUserInput',
        effective_mode: 'code',
        reason_code: 'request_user_input_blocked_in_default_mode',
        reason: 'requestUserInput is blocked while effective_mode=code',
        suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
        request_id: 'tool-1',
      },
    });
  });
});
