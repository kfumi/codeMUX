import { describe, expect, it } from 'vitest';

import {
  allKinds,
  availableRewindModes,
  describeKind,
  getDefaultAgentKind,
  permissionMenu,
  selectableKinds,
  supports,
  supportsRewind,
} from './index';

describe('agent kind', () => {
  it('keeps Claude Code as the product default', () => {
    expect(getDefaultAgentKind()).toBe('claude_code');
  });

  it('exposes codex as a selectable coding agent', () => {
    expect(describeKind('codex')).toMatchObject({
      kind: 'codex',
      label: 'Codex',
      selectable: true,
    });
  });

  it('marks Codex as supporting interactive user questions', () => {
    expect(supports('codex', 'supports_ask_user_question')).toBe(true);
  });

  it('marks unsupported lookups as missing', () => {
    expect(allKinds().some((entry) => entry.kind === 'gemini_cli')).toBe(true);
    expect(describeKind('gemini_cli')).toBeDefined();
    expect(describeKind('nonexistent' as never)).toBeUndefined();
  });

  it('exposes only the OpenCode capabilities implemented by the runtime and UI', () => {
    const capabilities = describeKind('opencode') && allKinds()
      .find((entry) => entry.kind === 'opencode');
    expect(capabilities).toBeDefined();

    expect(supports('opencode', 'supports_resume')).toBe(true);
    expect(supports('opencode', 'supports_tools')).toBe(true);
    expect(supports('opencode', 'supports_steer')).toBe(true);
    expect(supports('opencode', 'supports_cost')).toBe(false);
    expect(supports('opencode', 'supports_file_snapshots')).toBe(false);
    expect(supports('opencode', 'supports_ask_user_question')).toBe(false);
  });

  it('marks Claude, Codex, OpenCode and pi as supporting steer', () => {
    expect(supports('claude_code', 'supports_steer')).toBe(true);
    expect(supports('codex', 'supports_steer')).toBe(true);
    expect(supports('opencode', 'supports_steer')).toBe(true);
    expect(supports('pi', 'supports_steer')).toBe(true);
  });

  it('does not mark Gemini CLI as supporting steer', () => {
    expect(supports('gemini_cli', 'supports_steer')).toBe(false);
  });

  it('marks unknown kinds as supporting nothing', () => {
    expect(supports(undefined, 'supports_steer')).toBe(false);
    expect(supports('nonexistent' as never, 'supports_steer')).toBe(false);
    expect(supportsRewind(undefined, 'conversation')).toBe(false);
    expect(supportsRewind('nonexistent' as never, 'conversation')).toBe(false);
  });

  describe('selectable', () => {
    it('只把已接入的 kind 放进新建会话选择器', () => {
      expect(selectableKinds().map((entry) => entry.kind)).toEqual([
        'claude_code',
        'codex',
        'opencode',
        'pi',
      ]);
    });

    it('gemini_cli 保留在规格表里但不可选', () => {
      expect(describeKind('gemini_cli')?.selectable).toBe(false);
      expect(selectableKinds().some((entry) => entry.kind === 'gemini_cli')).toBe(false);
    });

    it('可选性不再由 capabilities 是否为空兼职', () => {
      // 这是本轮收掉的一个坑：过去给 gemini_cli 填空数组只为让选择器滤掉它，
      // 一旦有人补上能力，它会悄悄出现在选择器里。现在两件事分开。
      const gemini = allKinds().find((entry) => entry.kind === 'gemini_cli');
      expect(gemini?.selectable).toBe(false);
      expect(supports('gemini_cli', 'supports_tools')).toBe(false);
    });
  });

  describe('rewind', () => {
    it('只有 Claude 同时支持会话回退与文件回退', () => {
      expect(availableRewindModes('claude_code')).toEqual(['conversation', 'files', 'both']);
    });

    it('Codex、OpenCode、pi 只支持会话回退', () => {
      for (const kind of ['codex', 'opencode', 'pi'] as const) {
        expect(availableRewindModes(kind)).toEqual(['conversation']);
        expect(supportsRewind(kind, 'files')).toBe(false);
        expect(supportsRewind(kind, 'both')).toBe(false);
      }
    });

    it('未接入的 gemini_cli 没有任何回退能力', () => {
      expect(availableRewindModes('gemini_cli')).toEqual([]);
    });
  });

  describe('plan mode semantics', () => {
    it('Claude 与 OpenCode 的 plan 由档位承载', () => {
      expect(describeKind('claude_code')?.planMode).toBe('via-tier');
      expect(describeKind('opencode')?.planMode).toBe('via-tier');
    });

    it('Codex 的 plan 是正交开关（ADR 0010）', () => {
      expect(describeKind('codex')?.planMode).toBe('orthogonal-toggle');
    });

    it('pi 没有 plan 概念', () => {
      expect(describeKind('pi')?.planMode).toBe('unsupported');
    });
  });

  describe('permission menu', () => {
    it('Claude 出五档且默认选中「变更前确认」', () => {
      const menu = permissionMenu('claude_code', null, 'off');
      expect(menu.tiers.map((tier) => tier.mode)).toEqual([
        'confirm_before_edit',
        'auto_edit',
        'auto_review',
        'plan',
        'full_access',
      ]);
      expect(menu.selectedMode).toBe('confirm_before_edit');
      expect(menu.planMode).toBe('via-tier');
    });

    it('Codex 常规只出三档，legacy 只读档不主动出现', () => {
      const menu = permissionMenu('codex', null, 'off');
      expect(menu.tiers.map((tier) => tier.mode)).toEqual([
        'auto_edit',
        'auto_review',
        'full_access',
      ]);
      expect(menu.legacyTierActive).toBe(false);
    });

    it('会话已存于 Codex 只读档时把该档放到首位作为退出通道', () => {
      const menu = permissionMenu(
        'codex',
        { kind: 'codex', workflowMode: 'read-only', networkAccessEnabled: false },
        'off',
      );
      expect(menu.tiers.map((tier) => tier.mode)).toEqual([
        'read_only',
        'auto_edit',
        'auto_review',
        'full_access',
      ]);
      expect(menu.selectedMode).toBe('read_only');
      expect(menu.legacyTierActive).toBe(true);
    });

    it('OpenCode 出构建/计划两档，plan 开时选中计划', () => {
      expect(permissionMenu('opencode', null, 'off').tiers.map((tier) => tier.mode))
        .toEqual(['confirm_before_edit', 'plan']);
      expect(permissionMenu('opencode', null, 'on').selectedMode).toBe('plan');
    });

    it('pi 出三档且没有 plan 档', () => {
      const menu = permissionMenu('pi', null, 'off');
      expect(menu.tiers.map((tier) => tier.mode)).toEqual([
        'confirm_before_edit',
        'auto_edit',
        'full_access',
      ]);
      expect(menu.tiers.some((tier) => tier.mode === 'plan')).toBe(false);
      expect(menu.planMode).toBe('unsupported');
    });

    it('只把「完全访问」标成 dangerous', () => {
      for (const kind of ['claude_code', 'codex', 'opencode', 'pi'] as const) {
        for (const tier of permissionMenu(kind, null, 'off').tiers) {
          expect(tier.dangerous).toBe(tier.mode === 'full_access');
        }
      }
    });

    it('每个档位都带描述与图标名，两个消费方共用同一份数据', () => {
      for (const kind of ['claude_code', 'codex', 'opencode', 'pi'] as const) {
        for (const tier of permissionMenu(kind, null, 'off').tiers) {
          expect(tier.label.length).toBeGreaterThan(0);
          expect(tier.description.length).toBeGreaterThan(0);
          expect(tier.iconName.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
