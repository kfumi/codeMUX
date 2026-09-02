import { describe, expect, it } from 'vitest';

import { BLANK_PAGE_TITLE, browserPageTitle } from './browserPage';

describe('browser page title', () => {
  it('prefers the document title', () => {
    expect(browserPageTitle('百度一下', 'https://www.baidu.com/')).toBe('百度一下');
  });

  it('falls back to the hostname when the title is empty', () => {
    expect(browserPageTitle('  ', 'https://www.baidu.com/path')).toBe('www.baidu.com');
  });

  it('uses the blank-page label when there is no URL', () => {
    expect(browserPageTitle('', '')).toBe(BLANK_PAGE_TITLE);
  });
});
