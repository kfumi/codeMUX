// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MainLayout } from './MainLayout';

const titleBarProps: Record<string, unknown>[] = [];

vi.mock('./TitleBar', () => ({
  TitleBar: (props: Record<string, unknown>) => {
    titleBarProps.push(props);
    return <div data-testid="title-bar" />;
  },
}));

vi.mock('../workspace/SidePanel', () => ({
  SidePanel: () => null,
}));

describe('MainLayout', () => {
  afterEach(() => {
    titleBarProps.length = 0;
    cleanup();
  });

  it('keeps the title bar inside the workspace instead of sizing it from sidebar props', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>} headerContent={<span>header</span>}>
        <div>content</div>
      </MainLayout>,
    );

    expect(titleBarProps).toHaveLength(1);
    expect(titleBarProps[0]).not.toHaveProperty('sidebarWidth');
    expect(titleBarProps[0]).not.toHaveProperty('sidebarInstant');
  });

  it('renders sidebar accessory next to the expanded sidebar toggle', () => {
    render(
      <MainLayout sidebar={<div>sidebar</div>} sidebarAccessory={<button>更新</button>}>
        <div>content</div>
      </MainLayout>,
    );

    const toggle = document.querySelector('button[title="收起侧栏"]');
    const update = document.querySelector('button:not([title])');

    expect(toggle).toBeTruthy();
    expect(update?.textContent).toBe('更新');
    expect(toggle?.parentElement).toBe(update?.parentElement);
  });
});
