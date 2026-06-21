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
});
