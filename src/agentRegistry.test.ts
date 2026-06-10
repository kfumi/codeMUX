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

  it('marks unsupported registry lookups as missing', () => {
    expect(AGENT_REGISTRY.some((entry) => entry.kind === 'gemini_cli')).toBe(true);
  });
});
