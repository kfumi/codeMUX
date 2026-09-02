import { beforeEach, describe, expect, it } from 'vitest';

import { extractReferencedMarkdownFiles } from './referencedMarkdownFiles';
import { usePreviewStore } from '@/stores/previewStore';
import { useProjectStore } from '@/stores/projectStore';

describe('extractReferencedMarkdownFiles', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      treeRoot: [{
        name: 'docs',
        path: 'D:/project/ai-code/codeMUX/docs',
        isDir: true,
        children: [
          {
            name: '2026-08-31-eqzw-online-check.md',
            path: 'D:/project/ai-code/codeMUX/docs/2026-08-31-eqzw-online-check.md',
            isDir: false,
          },
          {
            name: '2026-08-31-eqzw-online-check-design.md',
            path: 'D:/project/ai-code/codeMUX/docs/2026-08-31-eqzw-online-check-design.md',
            isDir: false,
          },
        ],
      }],
      treeRootPath: 'D:/project/ai-code/codeMUX',
      projectPath: 'D:/project/ai-code/codeMUX',
    });
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

  it('extracts markdown files mentioned in assistant text', () => {
    const files = extractReferencedMarkdownFiles(
      '已写入 `docs/2026-08-31-eqzw-online-check.md` 和 [设计文档](D:/project/ai-code/codeMUX/docs/2026-08-31-eqzw-online-check-design.md)',
    );

    expect(files).toEqual([
      'D:/project/ai-code/codeMUX/docs/2026-08-31-eqzw-online-check.md',
      'D:/project/ai-code/codeMUX/docs/2026-08-31-eqzw-online-check-design.md',
    ]);
  });

  it('ignores markdown paths that only appear in change diffs, not message text', () => {
    const files = extractReferencedMarkdownFiles('已按 spec 完成修订，未在正文列出文件路径。');

    expect(files).toEqual([]);
  });

  it('ignores non-markdown paths', () => {
    const files = extractReferencedMarkdownFiles('修改了 `src/App.tsx` 和 `docs/readme.txt`');

    expect(files).toEqual([]);
  });
});
