// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CodeMuxDirectiveText, parseDirectiveText } from './CodeMuxDirectiveText';

describe('CodeMuxDirectiveText', () => {
  it('parses colon skill commands as command directives', () => {
    expect(parseDirectiveText('/superpowers:brainstorming 测试')).toEqual([
      {
        kind: 'directive',
        directiveKind: 'command',
        value: '/superpowers:brainstorming',
        label: 'superpowers:brainstorming',
      },
      { kind: 'text', text: ' 测试' },
    ]);
  });

  it('renders colon skill commands with command chip treatment', () => {
    render(<CodeMuxDirectiveText text="/superpowers:brainstorming 测试" />);

    const chip = screen.getByText('superpowers:brainstorming').closest('[data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('codemux-directive-command');
  });

  it('does not parse inline URL separators in logs as file directives', () => {
    const text =
      '[2026-07-03][10:24:15][INFO][webview:emit@http://localhost:1420/src/lib/logger.ts:53:17] [agentNotifications] Notification candidate';

    expect(parseDirectiveText(text)).toEqual([{ kind: 'text', text }]);

    const { container } = render(<CodeMuxDirectiveText text={text} />);

    expect(container.querySelector('[data-directive-type="file"]')).toBeNull();
  });

  it('parses chip-format commands as command directives', () => {
    expect(parseDirectiveText('[$review](review) args')).toEqual([
      {
        kind: 'directive',
        directiveKind: 'command',
        value: '[$review](review)',
        label: 'review',
      },
      { kind: 'text', text: ' args' },
    ]);
  });

  it('parses chip-format skill commands as command directives', () => {
    expect(parseDirectiveText('[$skill-installer](C:\\skills\\SKILL.md) install')).toEqual([
      {
        kind: 'directive',
        directiveKind: 'command',
        value: '[$skill-installer](C:\\skills\\SKILL.md)',
        label: 'skill-installer',
      },
      { kind: 'text', text: ' install' },
    ]);
  });

  it('parses Claude Code command XML into command chip plus args text', () => {
    const xml = '<command-message>find-skills</command-message>\n<command-name>/find-skills</command-name>\n<command-args>找下React相关skill</command-args>';
    expect(parseDirectiveText(xml)).toEqual([
      {
        kind: 'directive',
        directiveKind: 'command',
        value: xml,
        label: 'find-skills',
      },
      { kind: 'text', text: ' 找下React相关skill' },
    ]);
  });

  it('renders chip-format commands with command chip treatment', () => {
    render(<CodeMuxDirectiveText text="[$review](review) args" />);

    const chip = screen.getByText('review').closest('[data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('codemux-directive-command');
  });

  it('renders Claude Code command XML with command chip for name and text for args', () => {
    const xml = '<command-message>find-skills</command-message>\n<command-name>/find-skills</command-name>\n<command-args>找下React相关skill</command-args>';
    render(<CodeMuxDirectiveText text={xml} />);

    const chip = screen.getByText('find-skills').closest('[data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect(chip?.className).toContain('codemux-directive-command');
    expect(screen.getByText('找下React相关skill')).toBeTruthy();
  });
});
