import { describe, expect, it } from 'vitest';

import { buildCommandInput, buildSettingsPatch, canSubmitComposer, findActiveComposerTrigger, parsePermissionMode } from './MobileComposer';

describe('canSubmitComposer', () => {
  it('allows an image-only submission', () => {
    expect(canSubmitComposer('', 1)).toBe(true);
  });

  it('rejects an empty submission without attachments', () => {
    expect(canSubmitComposer('  ', 0)).toBe(false);
  });
});

describe('findActiveComposerTrigger', () => {
  it('detects file references after whitespace', () => {
    expect(findActiveComposerTrigger('请查看 @src/app', 12)).toEqual({
      kind: 'file',
      query: 'src/app',
      start: 4,
      end: 12,
    });
  });

  it('does not treat a completed reference as an active suggestion', () => {
    expect(findActiveComposerTrigger('@src/app.ts ', 12)).toBeNull();
  });
});

describe('buildCommandInput', () => {
  it('uses Codex skill links so the desktop agent receives the skill directive', () => {
    expect(buildCommandInput({
      name: 'review',
      description: 'review',
      category: 'skill',
      handler: 'prompt',
      filePath: 'C:\\project\\.codex\\skills\\review',
    }, 'auth flow', 'codex')).toBe(
      '[$review](C:\\project\\.codex\\skills\\review\\SKILL.md) auth flow',
    );
  });

  it('renders ordinary slash command arguments', () => {
    expect(buildCommandInput({
      name: 'review',
      description: 'review',
      category: 'builtin',
      handler: 'prompt',
      prompt: '/review {args}',
    }, 'auth flow', 'claude_code')).toBe('/review auth flow');
  });
});

describe('parsePermissionMode', () => {
  it('keeps the Codex workflow tier while the plan toggle is on (orthogonal)', () => {
    const config = JSON.stringify({ kind: 'codex', workflowMode: 'full-access', networkAccessEnabled: true });
    expect(parsePermissionMode('codex', config, 'on')).toBe('full_access');
    expect(parsePermissionMode('codex', config, 'off')).toBe('full_access');
    expect(parsePermissionMode('codex', JSON.stringify({ kind: 'codex', sandboxMode: 'workspace-write' }), 'on')).toBe('auto_edit');
  });

  it('still maps plan mode onto non-Codex permission modes', () => {
    expect(parsePermissionMode('claude_code', null, 'on')).toBe('plan');
    expect(parsePermissionMode('opencode', null, 'on')).toBe('plan');
  });
});

describe('buildSettingsPatch', () => {
  it('preserves the Codex workflow tier when plan mode is toggled on', () => {
    const patch = buildSettingsPatch('codex', 'p1', 'gpt-5', 'high', 'auto_edit', 'on');
    expect(patch.planMode).toBe('on');
    expect(patch.permissionConfig).toMatchObject({ kind: 'codex', workflowMode: 'auto' });
  });

  it('serializes a full-access tier without forcing read-only under plan', () => {
    const patch = buildSettingsPatch('codex', 'p1', 'gpt-5', 'high', 'full_access', 'on');
    expect(patch.planMode).toBe('on');
    expect(patch.permissionConfig).toMatchObject({ kind: 'codex', workflowMode: 'full-access', networkAccessEnabled: true });
  });
});
