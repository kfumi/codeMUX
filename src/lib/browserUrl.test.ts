import { describe, expect, it } from 'vitest';

import { normalizeBrowserUrl } from './browserUrl';

describe('normalizeBrowserUrl', () => {
  it('accepts http and https URLs', () => {
    expect(normalizeBrowserUrl('https://www.baidu.com/')).toEqual({
      ok: true,
      url: 'https://www.baidu.com/',
    });
    expect(normalizeBrowserUrl('http://example.com')).toEqual({
      ok: true,
      url: 'http://example.com/',
    });
  });

  it('adds https when the protocol is missing', () => {
    expect(normalizeBrowserUrl('www.baidu.com')).toEqual({
      ok: true,
      url: 'https://www.baidu.com/',
    });
    expect(normalizeBrowserUrl('example.com/path?q=1')).toEqual({
      ok: true,
      url: 'https://example.com/path?q=1',
    });
  });

  it('rejects empty input', () => {
    expect(normalizeBrowserUrl('   ')).toEqual({
      ok: false,
      error: '请输入网址',
    });
  });

  it('rejects non-http schemes', () => {
    expect(normalizeBrowserUrl('file:///tmp/index.html')).toEqual({
      ok: false,
      error: '只允许 http 或 https 地址',
    });
    expect(normalizeBrowserUrl('javascript:alert(1)')).toEqual({
      ok: false,
      error: '只允许 http 或 https 地址',
    });
    expect(normalizeBrowserUrl('about:blank')).toEqual({
      ok: false,
      error: '只允许 http 或 https 地址',
    });
  });
});
