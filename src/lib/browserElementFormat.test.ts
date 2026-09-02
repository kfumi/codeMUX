import { describe, expect, it } from 'vitest';

import {
  formatBrowserElementBlock,
  formatBrowserElements,
  mergeBrowserElementsIntoText,
  truncateBrowserElementText,
} from './browserElementFormat';

describe('browser element formatting', () => {
  it('keeps the tag when visible text is empty', () => {
    expect(formatBrowserElementBlock({
      url: 'https://www.baidu.com/',
      tag: 'div',
      text: '   ',
    })).toBe(
      [
        '<browser-element url="https://www.baidu.com/">',
        '  <tag>div</tag>',
        '  <text></text>',
        '</browser-element>',
      ].join('\n'),
    );
  });

  it('omits the selector when it is missing', () => {
    expect(formatBrowserElementBlock({
      url: 'https://example.com/path',
      tag: 'button',
      text: '百度一下',
    })).not.toContain('<selector>');
  });

  it('includes a selector when present', () => {
    expect(formatBrowserElementBlock({
      url: 'https://example.com/',
      tag: 'a',
      text: '新闻',
      selector: '#s-top-left > a',
    })).toContain('  <selector>#s-top-left &gt; a</selector>');
  });

  it('truncates long visible text to 500 characters', () => {
    const text = '字'.repeat(520);
    expect(truncateBrowserElementText(text)).toBe('字'.repeat(500));
  });

  it('preserves capture order for multiple elements', () => {
    const formatted = formatBrowserElements([
      { url: 'https://example.com/', tag: 'div', text: 'nav' },
      { url: 'https://example.com/', tag: 'button', text: '百度一下' },
    ]);
    expect(formatted.indexOf('<text>nav</text>')).toBeLessThan(
      formatted.indexOf('<text>百度一下</text>'),
    );
  });

  it('merges captured elements after the user text', () => {
    expect(mergeBrowserElementsIntoText('看下这个导航', [
      { url: 'https://www.baidu.com/', tag: 'div', text: '新闻 hao123' },
    ])).toBe(
      [
        '看下这个导航',
        '',
        '<browser-element url="https://www.baidu.com/">',
        '  <tag>div</tag>',
        '  <text>新闻 hao123</text>',
        '</browser-element>',
      ].join('\n'),
    );
  });

  it('uses only the element block when the composer text is empty', () => {
    expect(mergeBrowserElementsIntoText('', [
      { url: 'https://example.com/', tag: 'h1', text: 'Hello' },
    ])).toBe(formatBrowserElementBlock({
      url: 'https://example.com/',
      tag: 'h1',
      text: 'Hello',
    }));
  });
});
