// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitPullRequestSuggestion } from '../../../lib/gitTypes';
import { GitPullRequestPopover } from './GitPullRequestPopover';

const suggestion: GitPullRequestSuggestion = {
  title: 'feat: 新增 Git 生成设置',
  body: '本分支新增 Git 设置面板。\n\n- 支持自定义提交指引',
  base: 'main',
};

const writeTextMock = vi.fn(async () => undefined);

describe('GitPullRequestPopover', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const renderPopover = (overrides: Partial<Parameters<typeof GitPullRequestPopover>[0]> = {}) => render(
    <GitPullRequestPopover
      trigger={<button type="button" data-testid="pr-trigger">打开</button>}
      branch="feature/git-settings"
      branches={[
        { name: 'main', current: false },
        { name: 'feature/git-settings', current: true },
      ]}
      base="main"
      suggestion={null}
      generating={false}
      creating={false}
      error={null}
      createError={null}
      result={null}
      open
      onOpenChange={() => {}}
      onGenerate={() => {}}
      onBaseChange={() => {}}
      onCreate={() => {}}
      {...overrides}
    />,
  );

  it('fills title and body from the suggestion', () => {
    renderPopover({ suggestion });

    expect((screen.getByTestId('git-pr-title') as HTMLInputElement).value).toBe('feat: 新增 Git 生成设置');
    expect((screen.getByTestId('git-pr-body') as HTMLTextAreaElement).value).toContain('支持自定义提交指引');
    expect(screen.getByText('基准分支: main')).toBeTruthy();
  });

  it('copies title and body to the clipboard', async () => {
    renderPopover({ suggestion });

    fireEvent.click(screen.getByTestId('git-pr-copy'));

    await waitFor(() => expect(screen.getByText('已复制')).toBeTruthy());
    expect(writeTextMock).toHaveBeenCalledWith('feat: 新增 Git 生成设置\n\n本分支新增 Git 设置面板。\n\n- 支持自定义提交指引');
  });

  it('disables copy when there is no content', () => {
    renderPopover();

    expect(screen.getByTestId('git-pr-copy').hasAttribute('disabled')).toBe(true);
  });

  it('shows regenerate label with a suggestion and disables while generating', () => {
    renderPopover({ suggestion, generating: true });

    const generateButton = screen.getByTestId('git-pr-generate');
    expect(generateButton.textContent).toContain('生成中');
    expect(generateButton.hasAttribute('disabled')).toBe(true);
  });

  it('renders the error message', () => {
    renderPopover({ error: '当前分支相对基准分支没有新提交' });

    expect(screen.getByText('当前分支相对基准分支没有新提交')).toBeTruthy();
  });
});
