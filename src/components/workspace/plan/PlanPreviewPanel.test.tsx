// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PlanPreviewPanel } from './PlanPreviewPanel';

// FileView 内部是懒加载的 Monaco(与 hljs 占位),与面板本身的门控无关,替换掉
// 让用例只关注 markdown / code 两种容器的选择;FileView 自己的行为见其同名测试。
vi.mock('../../preview/FileView', () => ({
  FileView: ({ content }: { content: string }) => (
    <div data-testid="file-view-stub">{content}</div>
  ),
}));

const providerProps: { documentPath?: string } = {};

vi.mock('../../assistant-ui/markdown-image', () => ({
  // markdown-text 的 img 覆盖也要满足，否则导入整条链会因缺少导出而失败。
  CodeMuxMarkdownImage: () => null,
  MarkdownImageDocumentProvider: ({
    documentPath,
    children,
  }: {
    documentPath: string;
    children: ReactNode;
  }) => {
    providerProps.documentPath = documentPath;
    return <div data-testid="markdown-image-document">{children}</div>;
  },
}));

describe('PlanPreviewPanel', () => {
  it('renders markdown files with markdown formatting', () => {
    render(
      <PlanPreviewPanel
        planFilePath="D:/project/codeMUX/docs/design.md"
        planContent={'# Design Doc\n\n- First item'}
      />,
    );

    expect(screen.getByTestId('file-preview-markdown')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Design Doc' })).toBeTruthy();
    expect(screen.getByTestId('markdown-image-document')).toBeTruthy();
    expect(providerProps.documentPath).toBe('D:/project/codeMUX/docs/design.md');
  });

  it('keeps long markdown content inside the preview width', () => {
    render(
      <PlanPreviewPanel
        planFilePath="D:/project/codeMUX/docs/design.md"
        planContent="D:\\project\\codeMUX\\docs\\superpowers\\plans\\2026-08-18-very-long-plan-name.md"
      />,
    );

    const previews = screen.getAllByTestId('file-preview-markdown');
    const preview = previews[previews.length - 1]!;
    const markdown = preview.querySelector('.aui-md');

    expect(preview.className).toContain('min-w-0');
    expect(preview.className).toContain('max-w-3xl');
    expect(markdown?.className).toContain('min-w-0');
    expect(markdown?.className).toContain('max-w-full');
  });

  it('renders source files with the code preview component', () => {
    render(
      <PlanPreviewPanel
        planFilePath="D:/project/codeMUX/src/main.ts"
        planContent={'const answer: number = 42;\nconsole.log(answer);\n'}
      />,
    );

    expect(screen.getByTestId('file-preview-code')).toBeTruthy();
    expect(screen.getByTestId('file-view-stub').textContent).toContain('const answer');
  });
});
