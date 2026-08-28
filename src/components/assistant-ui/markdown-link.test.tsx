// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Streamdown } from 'streamdown';

import { useSidePanelStore } from '@/stores/sidePanelStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePreviewStore } from '@/stores/previewStore';
import {
  CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS,
  CODEMUX_MARKDOWN_REHYPE_PLUGINS,
  CodeMuxMarkdownLink,
  normalizeLocalMarkdownHref,
  parsePlainFileReferences,
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
    expect(normalizeLocalMarkdownHref('src/App.tsx#L359')).toBe('src/App.tsx');
    expect(normalizeLocalMarkdownHref('src/App.tsx:66-96')).toBe('src/App.tsx');
  });

  it('does not treat web links as local files', () => {
    expect(normalizeLocalMarkdownHref('https://example.com/docs/spec.md')).toBeNull();
  });
});

describe('parsePlainFileReferences', () => {
  it('parses relative paths (including non-ASCII segments) for later link resolution', () => {
    expect(parsePlainFileReferences('请查看 src/components/App.tsx:120:8。')).toMatchObject([
      {
        label: 'src/components/App.tsx:120:8',
        path: 'src/components/App.tsx:120:8',
      },
    ]);
    expect(
      parsePlainFileReferences(
        '调研完成，文档已写入：lnwlcsMicroServiceUniApp\\docs\\research\\企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md',
      ),
    ).toMatchObject([
      {
        label: 'lnwlcsMicroServiceUniApp\\docs\\research\\企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md',
        path: 'lnwlcsMicroServiceUniApp\\docs\\research\\企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md',
      },
    ]);
  });

  it('recognizes absolute paths with the human-readable line format', () => {
    expect(parsePlainFileReferences('修复见 D:/project/codeMUX/CodeMuxThread.tsx (line 1007)。')).toMatchObject([
      {
        label: 'D:/project/codeMUX/CodeMuxThread.tsx (line 1007)',
        path: 'D:/project/codeMUX/CodeMuxThread.tsx:1007',
      },
    ]);
  });

  it('recognizes absolute line ranges and preserves them as link metadata', () => {
    expect(parsePlainFileReferences('查看 D:/project/codeMUX/types.rs:66-96 和 D:/project/codeMUX/builtins.rs:4-18。')).toMatchObject([
      {
        label: 'D:/project/codeMUX/types.rs:66-96',
        path: 'D:/project/codeMUX/types.rs:66-96',
      },
      {
        label: 'D:/project/codeMUX/builtins.rs:4-18',
        path: 'D:/project/codeMUX/builtins.rs:4-18',
      },
    ]);
  });

  it('does not turn web URLs into local file references', () => {
    expect(parsePlainFileReferences('参考 https://example.com/src/App.tsx:20。')).toEqual([]);
  });

  it('removes Chinese punctuation and ignores directory-only Windows paths', () => {
    expect(parsePlainFileReferences('文件 D:\\project\\codeMUX\\src\\schema.rs：用于数据库。')).toEqual([
      {
        start: 3,
        end: 35,
        label: 'D:\\project\\codeMUX\\src\\schema.rs',
        path: 'D:\\project\\codeMUX\\src\\schema.rs',
      },
    ]);
    expect(parsePlainFileReferences('目录 D:\\project\\codeMUX\\src\\：后续说明')).toEqual([]);
  });
});

describe('CodeMuxMarkdownLink', () => {
  beforeEach(() => {
    readFile.mockReset();
    openExternal.mockReset();
    useSidePanelStore.getState().reset();
    usePreviewStore.setState({ treeRoot: null, treeRootPath: null, projectPath: null });
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

  it('opens a clicked local markdown file in the editable file tab', async () => {
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
            kind: 'file',
            filePath: 'D:/project/ai-code/codeMUX/docs/superpowers/specs/2026-07-03-git-branch-management-design.md',
            fileContent: '# 设计文档\n\n- 已渲染',
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

  it('strips line ranges before reading a local file link', async () => {
    readFile.mockResolvedValue('pub fn example() {}');

    render(
      <CodeMuxMarkdownLink href="D:/project/ai-code/codeMUX/src/types.rs:66-96">
        types.rs:66-96
      </CodeMuxMarkdownLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'types.rs:66-96' }));

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith(
        'D:/project/ai-code/codeMUX/src/types.rs',
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

    fireEvent.click(screen.getByRole('link', { name: 'design.md' }));

    await waitFor(() => {
      expect(useSidePanelStore.getState().tabs[0]).toMatchObject({
        kind: 'file',
        filePath: 'D:/project/ai-code/codeMUX/docs/design.md',
        fileContent: '# Streamdown 文件\n\n已打开。',
      });
    });
  });

  it('renders plain file paths in Streamdown as clickable file links', async () => {
    readFile.mockResolvedValue('export function App() {}');

    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'已修复 D:/project/ai-code/codeMUX/src/App.tsx:20，请查看 D:/project/ai-code/codeMUX/CodeMuxThread.tsx (line 1007)，入口在 `src-tauri/src/main.rs`。'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'App.tsx:20',
      'CodeMuxThread.tsx:1007',
      'main.rs',
    ]);

    fireEvent.click(links[1]!);

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith(
        'D:/project/ai-code/codeMUX/CodeMuxThread.tsx',
        'D:/project/ai-code/codeMUX',
      );
    });
  });

  it('renders absolute paths inside inline code as clickable file links', async () => {
    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'请查看 `D:/project/ai-code/codeMUX/src/App.tsx`。'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['App.tsx']);
  });

  it('rejects bare filenames, paths outside the project, and directories', async () => {
    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'package.json D:/other-project/src/App.tsx:20 D:/project/ai-code/codeMUX/src/: directory D:/project/ai-code/codeMUX/src/App.tsx:20'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['App.tsx:20']);
  });

  it('resolves formatted relative paths in inline code against the session project path', async () => {
    readFile.mockResolvedValue('# 调研报告');
    usePreviewStore.setState({ treeRoot: null, treeRootPath: null, projectPath: 'D:/project/ai-code/codeMUX' });

    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'调研完成，文档已写入：**`docs/research/企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md`**'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      '企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md',
    ]);

    fireEvent.click(links[0]!);

    await waitFor(() => {
      expect(useSidePanelStore.getState().tabs[0]).toMatchObject({
        kind: 'file',
        filePath: 'D:/project/ai-code/codeMUX/docs/research/企宽竣工FTTO与AC-AP-企业路由器设备组件调研.md',
        fileContent: '# 调研报告',
      });
    });
  });

  it('resolves relative paths through the loaded file tree when the file lives outside the session project', async () => {
    readFile.mockResolvedValue('# README');
    usePreviewStore.setState({
      treeRoot: [{
        name: 'lnwlcsMicroServiceUniApp',
        path: 'D:/workspace/lnwlcsMicroServiceUniApp',
        isDir: true,
        children: [
          { name: 'README.md', path: 'D:/workspace/lnwlcsMicroServiceUniApp/README.md', isDir: false },
        ],
      }],
      treeRootPath: 'D:/workspace',
      projectPath: 'D:/project/ai-code/codeMUX',
    });
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'codeMUX',
          path: 'D:/project/ai-code/codeMUX',
          created_at: '2026-07-03T00:00:00.000Z',
          updated_at: '2026-07-03T00:00:00.000Z',
        },
        {
          id: 'project-2',
          name: 'lnwlcsMicroServiceUniApp',
          path: 'D:/workspace/lnwlcsMicroServiceUniApp',
          created_at: '2026-07-03T00:00:00.000Z',
          updated_at: '2026-07-03T00:00:00.000Z',
        },
      ],
      activeProjectId: 'project-1',
    });

    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'参见 `lnwlcsMicroServiceUniApp/README.md`。'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['README.md']);

    fireEvent.click(links[0]!);

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith(
        'D:/workspace/lnwlcsMicroServiceUniApp/README.md',
        'D:/workspace/lnwlcsMicroServiceUniApp',
      );
    });
  });

  it('keeps relative paths unlinked in the file preview pipeline while absolute paths stay linked', async () => {
    usePreviewStore.setState({ treeRoot: null, treeRootPath: null, projectPath: 'D:/project/ai-code/codeMUX' });

    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'已写入 `docs/research/调研.md`，另见 D:/project/ai-code/codeMUX/docs/design.md'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['design.md']);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('keeps relative paths that escape the session directory unlinked', async () => {
    usePreviewStore.setState({ treeRoot: null, treeRootPath: null, projectPath: 'D:/project/ai-code/codeMUX' });

    const { container } = render(
      <Streamdown
        mode="static"
        components={{ a: CodeMuxMarkdownLink }}
        rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
        linkSafety={{ enabled: false }}
      >
        {'外部引用 ../sibling/design.md 与内部 docs/design.md'}
      </Streamdown>,
    );

    const links = await within(container).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['design.md']);
    expect(readFile).not.toHaveBeenCalled();
  });
});
