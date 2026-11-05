import { describe, expect, it, vi } from 'vitest';
import type { IBuffer } from '@xterm/xterm';

import {
  createTerminalLinkProvider,
  findTerminalTextLinks,
  logicalLineStart,
  trimTerminalUrl,
} from './terminalLinks';

describe('trimTerminalUrl', () => {
  it('removes sentence punctuation', () => {
    expect(trimTerminalUrl('https://example.com/a.')).toBe('https://example.com/a');
    expect(trimTerminalUrl('https://example.com/a,')).toBe('https://example.com/a');
  });

  it('removes an unmatched closing bracket but keeps a matched one', () => {
    expect(trimTerminalUrl('https://example.com/a)')).toBe('https://example.com/a');
    expect(trimTerminalUrl('https://example.com/a_(b)')).toBe('https://example.com/a_(b)');
  });
});

describe('findTerminalTextLinks', () => {
  it('finds http(s) urls with their character range', () => {
    const text = 'ready at https://example.com/dev and http://localhost:5173/x';
    const links = findTerminalTextLinks(text);

    expect(links.map((link) => link.text)).toEqual([
      'https://example.com/dev',
      'http://localhost:5173/x',
    ]);
    expect(text.slice(links[0].start, links[0].end + 1)).toBe('https://example.com/dev');
  });

  it('ignores a bare scheme and non-http schemes', () => {
    expect(findTerminalTextLinks('https:// file:///etc/passwd')).toEqual([]);
  });
});

function makeLine(text: string, wrapped: boolean) {
  return {
    length: text.length,
    isWrapped: wrapped,
    getCell(x: number) {
      return { getWidth: () => 1, getChars: () => text[x] ?? '' };
    },
  };
}

function makeBuffer(text: string, splitAt?: number) {
  const lines = splitAt === undefined
    ? [makeLine(text, false)]
    : [makeLine(text.slice(0, splitAt), false), makeLine(text.slice(splitAt), true)];

  return {
    getLine(y: number) {
      return lines[y];
    },
  } as unknown as IBuffer;
}

describe('terminal link provider', () => {
  it('maps a url to 1-based cell coordinates on a single line', () => {
    const buffer = makeBuffer('see https://example.com/a now');
    const term = { buffer: { active: buffer } };
    const callback = vi.fn();

    createTerminalLinkProvider(term as never, vi.fn()).provideLinks!(1, callback);

    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/a');
    // "see " 占 4 格，URL 从第 5 格开始 → xterm range 从 5 开始（1-based）。
    expect(links[0].range.start).toEqual({ x: 5, y: 1 });
  });

  it('joins a url split across wrapped rows', () => {
    const buffer = makeBuffer('see https://example.com/dev', 12);
    expect(logicalLineStart(buffer, 2)).toBe(0);

    const term = { buffer: { active: buffer } };
    const callback = vi.fn();
    createTerminalLinkProvider(term as never, vi.fn()).provideLinks!(2, callback);

    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/dev');
    expect(links[0].range.start).toEqual({ x: 5, y: 1 });
    expect(links[0].range.end.y).toBe(2);
  });

  it('activates the matched url', () => {
    const buffer = makeBuffer('https://example.com/x');
    const term = { buffer: { active: buffer } };
    const onActivate = vi.fn();
    const callback = vi.fn();

    createTerminalLinkProvider(term as never, onActivate).provideLinks!(1, callback);
    callback.mock.calls[0][0][0].activate(
      { preventDefault: vi.fn() } as unknown as MouseEvent,
      'https://example.com/x',
    );

    expect(onActivate).toHaveBeenCalledWith('https://example.com/x');
  });
});
