// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Streamdown } from 'streamdown';

import { useSidePanelStore } from '@/stores/sidePanelStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  CODEMUX_MARKDOWN_REHYPE_PLUGINS,
  CodeMuxMarkdownLink,
  normalizeLocalMarkdownHref,
} from './markdown-link';

const readFile = vi.fn();
const openExternal = vi.fn();

vi.mock('@/lib/tauri', () => ({
  fileApi: {
    readFile: (...args: unknown[]) => readFile(...args),
  },
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (...args: unknown[]) => openExternal(...args),
}));

describe('normalizeLocalMarkdownHref', () => {
  it('recognizes Windows drive paths that Streamdown treats as protocol URLs', () => {
    expect(normalizeLocalMarkdownHref('D:/project/ai-code/codeMUX/docs/spec.md')).toBe(
      'D:/project/ai-code/codeMUX/docs/spec.md',
    );
  });

  it('strips trailing line numbers from local file links without stripping Windows drive letters', () => {
    expect(normalizeLocalMarkdownHref('D:/project/ai-code/codeMUX/src/App.tsx:359')).toBe(
      'D:/project/ai-code/codeMUX/src/App.tsx',
    );
    expect(normalizeLocalMarkdownHref('D:/project/ai-code/codeMUX/src/App.tsx:359:12')).toBe(
      'D:/project/ai-code/codeMUX/src/App.tsx',
    );
  });

  it('does not treat web links as local files', () => {
    expect(normalizeLocalMarkdownHref('https://example.com/docs/spec.md')).toBeNull();
  });
});

describe('CodeMuxMarkdownLink', () => {
  beforeEach(() => {
    readFile.mockReset();
    openExternal.mockReset();
    useSidePanelStore.getState().reset();
    useProjectStore.setState({
      projects: [{
        id: 'project-1',
        name: 'codeMUX',
        path: 'D:/project/ai-code/codeMUX',
        created_at: '2026-07-03T00:00:00.000Z',
        updated_at: '2026-07-03T00:00:00.000Z',
      }],
      activeProjectId: 'project-1',
    });
  });

  it('opens a clicked local markdown file in the side panel preview tab', async () => {
    readFile.mockResolvedValue('# 设计文档\n\n- 已渲染');

    render(
      <CodeMuxMarkdownLink href="D:/project/ai-code/codeMUX/docs/superpowers/specs/2026-07-03-git-branch-management-design.md">
        2026-07-03-git-branch-management-design.md
      </CodeMuxMarkdownLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: '2026-07-03-git-branch-management-design.md' }));

    await waitFor(() => {
      expect(useSidePanelStore.getState()).toMatchObject({
        isOpen: true,
        tabs: [
          expect.objectContaining({
            kind: 'plan',
            planFilePath: 'D:/project/ai-code/codeMUX/docs/superpowers/specs/2026-07-03-git-branch-management-design.md',
            planContent: '# 设计文档\n\n- 已渲染',
          }),
        ],
      });
    });

    expect(readFile).toHaveBeenCalledWith(
      'D:/project/ai-code/codeMUX/docs/superpowers/specs/2026-07-03-git-branch-management-design.md',
      'D:/project/ai-code/codeMUX',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a clicked local file link with a line suffix by reading the file path only', async () => {
    readFile.mockResolvedValue('export function App() {}');

    render(
      <CodeMuxMarkdownLink href="D:/project/ai-code/codeMUX/src/App.tsx:359">
        App.tsx:359
      </CodeMuxMarkdownLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'App.tsx:359' }));

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith(
        'D:/project/ai-code/codeMUX/src/App.tsx',
        'D:/project/ai-code/codeMUX',
      );
    });
  });

  it('keeps external links opening through the shell', () => {
    render(<CodeMuxMarkdownLink href="https://example.com/docs">外部文档</CodeMuxMarkdownLink>);

    fireEvent.click(screen.getByRole('link', { name: '外部文档' }));

    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('keeps Streamdown-rendered Windows file links clickable after sanitize runs', async () => {
    readFile.mockResolvedValue('# Streamdown 文件\n\n已打开。');

    render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'[设计文档](D:/project/ai-code/codeMUX/docs/design.md)'}
      </Streamdown>,
    );

    fireEvent.click(screen.getByRole('link', { name: '设计文档' }));

    await waitFor(() => {
      expect(useSidePanelStore.getState().tabs[0]).toMatchObject({
        kind: 'plan',
        planFilePath: 'D:/project/ai-code/codeMUX/docs/design.md',
        planContent: '# Streamdown 文件\n\n已打开。',
      });
    });
  });
});
