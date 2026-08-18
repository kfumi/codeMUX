import { describe, expect, it } from 'vitest';

import { buildCommandInput, canSubmitComposer, findActiveComposerTrigger } from './MobileComposer';

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
