// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextDisplay } from './context-display';

// vitest 没开 globals，Testing Library 的自动 cleanup 不会注册。
afterEach(() => cleanup());

describe('ContextDisplay', () => {
  it('renders the ring with a known denominator', () => {
    const { container } = render(<ContextDisplay usedTokens={262_144} totalTokens={1_048_576} />);

    expect(container.querySelector('[data-slot="context-display-trigger"]')).toBeTruthy();
  });

  it('hides entirely when the context window is unknown', () => {
    // 免费模型会话在目录里查不到窗口时的状态：分子是真的，分母未知。
    // 显示一个猜出来的 200k 会让 1M 的模型看起来随时溢出，宁可不显示。
    const { container } = render(<ContextDisplay usedTokens={262_144} totalTokens={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('hides entirely for a non-positive denominator', () => {
    const { container } = render(<ContextDisplay usedTokens={262_144} totalTokens={0} />);

    expect(container.innerHTML).toBe('');
  });
});