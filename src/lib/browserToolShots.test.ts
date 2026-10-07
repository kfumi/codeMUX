import { describe, expect, it } from 'vitest';
import { computeBrowserStepContext, extractBrowserShots, isBrowserToolName } from './browserToolShots';

const B64 = 'iVBOR' + 'A'.repeat(3000);

describe('isBrowserToolName', () => {
  it('识别 10 个浏览器工具', () => {
    for (const name of ['browser_list', 'browser_eval', 'browser_screenshot', 'browser_input', 'browser_cdp', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_select']) {
      expect(isBrowserToolName(name)).toBe(true);
    }
  });
  it('非浏览器工具返回 false', () => {
    expect(isBrowserToolName('Bash')).toBe(false);
    expect(isBrowserToolName('mcp__x')).toBe(false);
  });
});
describe('extractBrowserShots', () => {
  it('MCP 图片块数组：提图片、留文字', () => {
    const raw = JSON.stringify({ content: [{ type: 'image', data: B64, mimeType: 'image/png' }, { type: 'text', text: 'done' }] });
    const out = extractBrowserShots(raw);
    expect(out.shots).toHaveLength(1);
    expect(out.shots[0].startsWith('data:image/png;base64,iVBOR')).toBe(true);
    expect(out.text).toContain('done');
    expect(out.text).not.toContain(B64);
  });
  it('快照对象：提 screenshot、留元素', () => {
    const raw = JSON.stringify({ elements: [{ id: 'e1' }], viewport: { width: 1, height: 1 }, screenshot: B64 });
    const out = extractBrowserShots(raw);
    expect(out.shots).toHaveLength(1);
    expect(out.text).toContain('e1');
    expect(out.text).not.toContain(B64);
  });
  it('裸 base64 PNG：直接成图', () => {
    const out = extractBrowserShots(B64);
    expect(out.shots).toHaveLength(1);
    expect(out.text).toContain('图片已折叠');
  });
  it('纯文本与非图片 JSON：无图', () => {
    expect(extractBrowserShots('hello').shots).toHaveLength(0);
    expect(extractBrowserShots('hello').text).toBe('hello');
    expect(extractBrowserShots(JSON.stringify({ ok: true })).shots).toHaveLength(0);
  });
  it('短串不误判', () => {
    expect(extractBrowserShots('iVBOR').shots).toHaveLength(0);
    expect(extractBrowserShots(undefined).shots).toHaveLength(0);
  });
});
describe('computeBrowserStepContext', () => {
  const snap = (id: string) => JSON.stringify({ elements: [{ id }], viewport: { width: 1, height: 1 }, screenshot: 'SHOT-' + id });
  it('同消息内编号、找前后截图', () => {
    const parts = [
      { toolName: 'browser_snapshot', result: snap('e1') },
      { toolName: 'browser_click', result: JSON.stringify({ ok: true }) },
      { toolName: 'Bash', result: 'done' },
      { toolName: 'browser_type', result: snap('e2') },
    ];
    const ctx = computeBrowserStepContext(parts);
    expect(ctx.map((c) => c.step)).toEqual([1, 2, undefined, 3]);
    expect(ctx[1].beforeShot).toContain('SHOT-e1');
    expect(ctx[1].afterShot).toContain('SHOT-e2');
    expect(ctx[0].beforeShot).toBeUndefined();
  });
  it('空数组返回空', () => {
    expect(computeBrowserStepContext([])).toEqual([]);
  });
});
