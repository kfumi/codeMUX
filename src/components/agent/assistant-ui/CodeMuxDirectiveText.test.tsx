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
        label: '/superpowers:brainstorming',
      },
      { kind: 'text', text: ' 测试' },
    ]);
  });

  it('renders colon skill commands with command chip treatment', () => {
    render(<CodeMuxDirectiveText text="/superpowers:brainstorming 测试" />);

    const chip = screen.getByText('/superpowers:brainstorming').closest('[data-directive-type="command"]');

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
});
