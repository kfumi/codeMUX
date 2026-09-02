// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useBrowserElementStore } from '../../stores/browserElementStore';
import { BrowserElementPills } from './BrowserElementPills';

describe('BrowserElementPills', () => {
  beforeEach(() => {
    useBrowserElementStore.getState().reset();
    useBrowserElementStore.getState().add('session-a', {
      url: 'https://www.baidu.com/',
      tag: 'div',
      text: '新闻 hao123 地图',
    });
    useBrowserElementStore.getState().add('session-a', {
      url: 'https://www.baidu.com/',
      tag: 'a',
      text: '百度一下',
    });
  });

  afterEach(() => {
    cleanup();
    useBrowserElementStore.getState().reset();
  });

  it('collapses captured elements into a count chip and hides the undo action', () => {
    render(<BrowserElementPills sessionId="session-a" />);

    expect(screen.getByText('2 个网页元素')).toBeTruthy();
    expect(screen.queryByText('撤销')).toBeNull();
    expect(screen.queryByText('新闻 hao123 地图')).toBeNull();
  });

  it('reveals element details on hover and clears them from the chip', () => {
    render(<BrowserElementPills sessionId="session-a" />);

    fireEvent.mouseEnter(screen.getByTestId('browser-element-list'));
    expect(screen.getByText('新闻 hao123 地图')).toBeTruthy();
    expect(screen.getByText('百度一下')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清除全部网页元素' }));
    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toEqual([]);
    expect(screen.queryByTestId('browser-element-list')).toBeNull();
  });
});
