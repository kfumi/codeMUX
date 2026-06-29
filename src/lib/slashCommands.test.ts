import { describe, expect, it } from 'vitest';

import { findCommand, formatPromptAsCommandDisplay, getAllCommands, renderCommandPrompt } from './slashCommands';

describe('slash commands by agent kind', () => {
  it('uses Codex built-in slash commands for Codex sessions', () => {
    const names = getAllCommands('codex').map((command) => command.name);

    expect(names.filter((name) => ['init', 'review', 'plan'].includes(name))).toEqual(['plan', 'init', 'review']);
    expect(names).not.toContain('permissions');
    expect(names).not.toContain('diff');
    expect(names).not.toContain('model');
    expect(names).not.toContain('security-review');
    expect(names).not.toContain('claude-api');
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
    const review = findCommand('review', 'codex');
    const plan = findCommand('plan', 'codex');

    expect(init?.prompt).not.toBe('/init');
    expect(review?.prompt).not.toBe('/review');
    expect(plan?.prompt).not.toBe('/plan');
    expect(renderCommandPrompt(init!, '')).toContain('AGENTS.md');
    expect(renderCommandPrompt(review!, 'focus tests')).toContain('focus tests');
    expect(renderCommandPrompt(plan!, 'add login')).toBe('$plan add login');
  });

  it('maps Codex prompt templates back to slash command display text', () => {
    const init = findCommand('init', 'codex')!;
    const review = findCommand('review', 'codex')!;
    const plan = findCommand('plan', 'codex')!;

    expect(formatPromptAsCommandDisplay(renderCommandPrompt(init, ''), 'codex')).toBe('/init');
    expect(formatPromptAsCommandDisplay(renderCommandPrompt(review, 'focus tests'), 'codex')).toBe('/review focus tests');
    expect(formatPromptAsCommandDisplay(renderCommandPrompt(plan, 'add login'), 'codex')).toBe('/plan add login');
  });

  it('maps raw Codex $plan prompts back to slash command display text', () => {
    expect(formatPromptAsCommandDisplay('$plan add login', 'codex')).toBe('/plan add login');
  });

  it('maps legacy Codex review prompt templates back to slash command display text', () => {
    expect(
      formatPromptAsCommandDisplay(
        '## Code review guidelines:\nReview the current code changes (staged, unstaged, and untracked files) and provide concise, actionable feedback in a normal Markdown response.',
        'codex',
      ),
    ).toBe('/review');
  });
});
