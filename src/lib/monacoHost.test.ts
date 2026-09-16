// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { supportsRichCodeEditor } from './monacoHost';

describe('supportsRichCodeEditor', () => {
  it('桌面与 PC 浏览器使用完整编辑器', () => {
    expect(supportsRichCodeEditor('desktop')).toBe(true);
    expect(supportsRichCodeEditor('browser')).toBe(true);
  });

  it('移动形态退回轻量渲染', () => {
    // Monaco 官方不支持移动浏览器,这是能力取舍(host-form.ts 允许宿主间能力差异)。
    expect(supportsRichCodeEditor('mobile')).toBe(false);
  });
});
