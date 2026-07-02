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
});
