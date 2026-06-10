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

  it('returns undefined for unsupported registry lookups', () => {
    expect(getAgentDefinition('missing_agent' as never)).toBeUndefined();
  });
});
