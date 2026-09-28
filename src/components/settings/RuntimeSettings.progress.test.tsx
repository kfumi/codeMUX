// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ProgressBar } from './RuntimeSettings';

afterEach(cleanup);

const startedAt = Date.now();

function renderProgress(progress: Parameters<typeof ProgressBar>[0]['progress']) {
  return render(<ProgressBar progress={progress} startedAt={startedAt} />);
}

describe('ProgressBar', () => {
  it('shows no percentage and no byte counter while progress is unknown', () => {
    // npm 安装阶段 daemon 只发 step 消息，不带 percent / bytes。回归：这里曾经渲染出
    // 一个假的「0%」和一行「null B / null B」。
    const { container } = renderProgress({
      stage: 'downloading',
      message: '正在从 npm 安装 OpenCode 1.18.33 · 已获取 42 个依赖',
    });

    expect(container.textContent).not.toContain('0%');
    expect(container.textContent).not.toContain('null');
    expect(container.textContent).not.toContain('B /');
    expect(container.textContent).toContain('已获取 42 个依赖');
  });

  it('treats a null percent from an older daemon as unknown', () => {
    const { container } = renderProgress({
      stage: 'downloading',
      percent: null as unknown as number,
    });
    expect(container.textContent).not.toContain('0%');
  });

  it('renders an indeterminate track when there is no percentage', () => {
    const { container } = renderProgress({ stage: 'downloading' });
    const fill = container.querySelector('.animate-pulse');
    expect(fill).not.toBeNull();
    // 不确定态不能偷偷带上写死的宽度百分比。
    expect(fill?.getAttribute('style')).toBeNull();
  });

  it('renders a determinate bar and the percentage when the daemon measures one', () => {
    const { container } = renderProgress({ stage: 'downloading', percent: 64 });
    expect(container.textContent).toContain('64%');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('formats byte counters only when both ends are known', () => {
    const { container } = renderProgress({
      stage: 'downloading',
      bytesDone: 2 * 1024 * 1024,
      bytesTotal: 4 * 1024 * 1024,
    });
    expect(container.textContent).toContain('2.0 MB / 4.0 MB');
  });

  it('always shows elapsed time so a quiet install still looks alive', () => {
    const { container } = renderProgress({ stage: 'downloading' });
    expect(container.textContent).toContain('已用时 0 秒');
  });
});
