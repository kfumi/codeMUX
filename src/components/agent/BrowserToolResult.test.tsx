// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrowserToolResult } from './BrowserToolResult';

const B64 = 'iVBOR' + 'A'.repeat(3000);
const SNAPSHOT = JSON.stringify({ elements: [{ id: 'e1' }], viewport: { width: 1, height: 1 }, screenshot: B64 });

describe('BrowserToolResult', () => {
  it('展示步骤徽标与截图缩略图，点击展开大图', () => {
    const { container } = render(<BrowserToolResult toolName={'browser_snapshot'} result={SNAPSHOT} step={2} />);
    expect(container.querySelector('[data-slot="browser-step-badge"]')?.textContent).toContain('2');
    expect(screen.getByAltText('浏览器截图缩略图')).toBeTruthy();
    expect(screen.queryByAltText('浏览器截图大图')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开截图' }));
    expect(screen.getByAltText('浏览器截图大图')).toBeTruthy();
  });
  it('无自身截图时展示执行前后对比', () => {
    const { container } = render(
      <BrowserToolResult
        toolName={'browser_click'}
        result={JSON.stringify({ ok: true })}
        step={3}
        beforeShot={'data:image/png;base64,BEFORE'}
        afterShot={'data:image/png;base64,AFTER'}
      />,
    );
    expect(screen.getByAltText('执行前截图')).toBeTruthy();
    expect(screen.getByAltText('执行后截图')).toBeTruthy();
    expect(container.querySelector('[alt="浏览器截图缩略图"]')).toBeNull();
  });
});
