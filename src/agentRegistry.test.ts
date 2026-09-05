import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, getAgentDefinition, getDefaultAgentKind } from './types/agentRegistry';

describe('agent registry', () => {
  it('keeps Claude Code as the product default', () => {
    expect(getDefaultAgentKind()).toBe('claude_code');
  });

  it('exposes codex as a selectable coding agent', () => {
    expect(getAgentDefinition('codex')).toMatchObject({
      kind: 'codex',
      label: 'Codex',
    });
  });

  it('marks Codex as supporting interactive user questions', () => {
    expect(getAgentDefinition('codex')?.capabilities).toContain('supports_ask_user_question');
  });

  it('marks unsupported registry lookups as missing', () => {
    expect(AGENT_REGISTRY.some((entry) => entry.kind === 'gemini_cli')).toBe(true);
    expect(getAgentDefinition('gemini_cli')).toBeDefined();
    expect(getAgentDefinition('nonexistent' as never)).toBeUndefined();
  });

  it('exposes only the OpenCode capabilities implemented by the runtime and UI', () => {
    expect(getAgentDefinition('opencode')?.capabilities).toEqual([
      'supports_resume',
      'supports_tools',
      'supports_steer',
    ]);
    expect(getAgentDefinition('opencode')?.capabilities).not.toContain('supports_cost');
    expect(getAgentDefinition('opencode')?.capabilities).not.toContain('supports_file_snapshots');
    expect(getAgentDefinition('opencode')?.capabilities).not.toContain('supports_ask_user_question');
  });

  it('marks Claude, Codex, OpenCode and pi as supporting steer', () => {
    expect(getAgentDefinition('claude_code')?.capabilities).toContain('supports_steer');
    expect(getAgentDefinition('codex')?.capabilities).toContain('supports_steer');
    expect(getAgentDefinition('opencode')?.capabilities).toContain('supports_steer');
    expect(getAgentDefinition('pi')?.capabilities).toContain('supports_steer');
  });

  it('does not mark Gemini CLI as supporting steer', () => {
    expect(getAgentDefinition('gemini_cli')?.capabilities).not.toContain('supports_steer');
  });
});
