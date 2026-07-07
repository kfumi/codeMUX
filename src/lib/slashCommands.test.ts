import { describe, expect, it } from 'vitest';

import { findCommand, formatPromptAsCommandDisplay, getAllCommands, renderCommandPrompt } from './slashCommands';

describe('slash commands by agent kind', () => {
  it('uses Codex built-in slash commands for Codex sessions', () => {
    const names = getAllCommands('codex').map((command) => command.name);

    expect(names).toContain('init');
    expect(names).not.toContain('plan');
    expect(names).not.toContain('review');
    expect(names).not.toContain('permissions');
    expect(names).not.toContain('diff');
    expect(names).not.toContain('model');
    expect(names).not.toContain('security-review');
    expect(names).not.toContain('claude-api');
  });

  it('does not include info or custom helper commands', () => {
    const removedNames = ['cost', 'status', 'explain', 'test', 'fix', 'refactor'];

    for (const agentKind of ['codex', 'claude_code'] as const) {
      const names = getAllCommands(agentKind).map((command) => command.name);

      for (const name of removedNames) {
        expect(names).not.toContain(name);
        expect(findCommand(name, agentKind)).toBeUndefined();
      }
    }
  });

  it('keeps Claude Code built-ins scoped to Claude Code sessions', () => {
    const names = getAllCommands('claude_code').map((command) => command.name);

    expect(names).toContain('security-review');
    expect(names).not.toContain('claude-api');
    expect(names).not.toContain('permissions');
    expect(names).not.toContain('debug-config');
  });

  it('finds commands within the selected agent kind only', () => {
    expect(findCommand('permissions', 'codex')).toBeUndefined();
    expect(findCommand('permissions', 'claude_code')).toBeUndefined();
    expect(findCommand('security-review', 'codex')).toBeUndefined();
  });

  it('maps Codex built-ins to prompt templates instead of raw slash commands', () => {
    const init = findCommand('init', 'codex');

    expect(init?.prompt).not.toBe('/init');
    expect(renderCommandPrompt(init!, '')).toContain('AGENTS.md');
  });

  it('maps Codex prompt templates back to slash command display text', () => {
    const init = findCommand('init', 'codex')!;

    expect(formatPromptAsCommandDisplay(renderCommandPrompt(init, ''), 'codex')).toBe('/init');
  });
});
