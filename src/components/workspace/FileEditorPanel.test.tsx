// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const sidePanelState = {
  updateFileContent: vi.fn(),
  saveFileTab: vi.fn(),
};

vi.mock('../../stores/sidePanelStore', () => ({
  useSidePanelStore: (selector: (state: typeof sidePanelState) => unknown) => selector(sidePanelState),
}));

vi.mock('../assistant-ui/file-type-icon', () => ({
  FileTypeIcon: () => null,
}));

vi.mock('../preview/FileView', () => ({
  EditableFileView: () => <div data-testid="editable-file-view" />,
}));

vi.mock('../assistant-ui/markdown-text', () => ({
  CODEMUX_MARKDOWN_STREAMDOWN_PROPS: {
    components: {},
    plugins: [],
    shikiTheme: ['github-dark', 'github-light'],
    controls: {},
    rehypePlugins: [],
    linkSafety: 'safe',
  },
  CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS: {
    components: {},
    plugins: [],
    shikiTheme: ['github-dark', 'github-light'],
    controls: {},
    rehypePlugins: [],
    linkSafety: 'safe',
  },
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  /** 生产代码用它做增量分块；mock 只返回单块，增量缓存自然退化为整体解析。 */
  parseMarkdownIntoBlocks: (markdown: string) => [markdown],
}));

import { FileEditorPanel } from './FileEditorPanel';

describe('FileEditorPanel', () => {
  it('opens Markdown files in preview mode and allows switching to source', () => {
    render(
      <FileEditorPanel
        tab={{
          id: 'global:file:readme.md',
          kind: 'file',
          title: 'README.md',
          filePath: 'D:/project/app/README.md',
          fileContent: '# CodeMUX',
          fileOriginalContent: '# CodeMUX',
          fileLoading: false,
          fileSaveState: 'idle',
        }}
      />,
    );

    expect(screen.getByTestId('markdown-file-preview')).toBeTruthy();
    expect(screen.queryByTestId('editable-file-view')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '源码' }));

    expect(screen.queryByTestId('markdown-file-preview')).toBeNull();
    expect(screen.getByTestId('editable-file-view')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '预览' }));
    expect(screen.getByTestId('markdown-file-preview')).toBeTruthy();
  });
});
