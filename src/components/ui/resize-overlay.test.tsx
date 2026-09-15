// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResizeOverlay } from './resize-overlay';

describe('ResizeOverlay', () => {
  afterEach(cleanup);

  it('active 时把遮罩挂到 body 并显示拖拽光标', () => {
    render(<ResizeOverlay active />);

    const overlay = screen.getByTestId('panel-resize-overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.style.cursor).toBe('col-resize');
  });

  it('inactive 时不渲染', () => {
    render(<ResizeOverlay active={false} />);

    expect(screen.queryByTestId('panel-resize-overlay')).toBeNull();
  });
});
