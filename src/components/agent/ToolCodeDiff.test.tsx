// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';
import { ToolCodeDiff, getCodeChangeStats } from './ToolCodeDiff';
import { TooltipProvider } from '../ui/tooltip';

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ToolCodeDiff', () => {
  it('renders edit arguments as an inline diff', () => {
    const { container } = render(
      <ToolCodeDiff
        toolName="Edit"
        input={{
          file_path: 'D:\\project\\index.html',
          old_string: '<title>old blog</title>',
          new_string: '<title>new blog</title>',
        }}
      />,
    );

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]')?.textContent).toContain('old blog');
    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent).toContain('new blog');
  });

  it('renders opencode edit (lowercase) with camelCase params as an inline diff', () => {
    const { container } = render(
      <ToolCodeDiff
        toolName="edit"
        input={{
          filePath: 'D:\\project\\compiler.xml',
          oldString: '    <bytecodeTargetLevel target="8" />',
          newString: '    <bytecodeTargetLevel target="7" />',
        }}
      />,
    );

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]')?.textContent).toContain('target="8"');
    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent).toContain('target="7"');
  });

  it('renders pi edit (path + edits array) as an inline diff', () => {
    const { container } = render(
      <ToolCodeDiff
        toolName="edit"
        input={{
          path: 'D:\\project\\GitEnvironmentPopover.tsx',
          edits: [
            {
              oldText: '                <ChevronDown className="h-3.5 w-3.5" />',
              newText: '                <ChevronRight className="h-4 w-4" />',
            },
          ],
        }}
      />,
    );

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]')?.textContent).toContain('ChevronDown');
    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent).toContain('ChevronRight');
  });

  it('counts additions and deletions across all pi edit hunks', () => {
    const stats = getCodeChangeStats({
      path: 'D:\\project\\GitEnvironmentPopover.tsx',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    });

    expect(stats).toEqual({ additions: 2, deletions: 2 });
  });

  it('renders write arguments as a new-file diff', () => {
    const { container } = render(
      <ToolCodeDiff
        toolName="Write"
        input={{
          file_path: 'D:\\project\\index.html',
          content: '<!DOCTYPE html>\n<title>new blog</title>\n',
        }}
      />,
    );

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent).toContain('<!DOCTYPE html>');
  });

  it('shows write and edit file names (not full paths) on the tool block without making them clickable', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Edit"
        input={{
          file_path: 'D:\\project\\index.html',
          old_string: 'old',
          new_string: 'new',
        }}
        result="Done"
        status="done"
      />,
    );

    // Now shows only filename, not full path
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'index.html' })).toBeNull();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"file_path"');
    expect(container.textContent).not.toContain('Done');
    expect(container.textContent).not.toContain('@@');
    expect(container.textContent).not.toContain('No newline at end of file');
  });

  // Codex app-server 的 file_change 形状：一次编辑多个文件，kind 在 update 时可能是空串，
  // diff 是不带 ---/+++ 头的 unified diff。
  const CODEX_CHANGES_INPUT = {
    changes: [
      {
        kind: '',
        path: 'D:\\project\\ai-code\\codeMUX\\apps\\desktop\\scripts\\verify-node-runtime.cjs',
        diff: "@@ -49,4 +49,4 @@\n missing.map((file) => file).join('\\n') +\n-        '\\n检查 win.extraResources 是否把 ',\n+        '\\n检查 extraResources 配置，确保完整 ',\n     );",
      },
      {
        kind: '',
        path: 'D:\\project\\ai-code\\codeMUX\\apps\\desktop\\test\\verify-node-runtime.test.ts',
        diff: "@@ -88,2 +88,12 @@\n \n+  it('gives platform-neutral guidance', async () => {\n+    expect(true).toBe(true);\n+  });\n \n   it('looks inside the .app bundle', async () => {",
      },
    ],
  };

  it('renders codex file_change changes (multi-file, unified diff) as inline diffs', () => {
    const { container } = render(
      <ToolCodeDiff toolName="apply_patch" input={CODEX_CHANGES_INPUT} />,
    );

    const deleted = Array.from(
      container.querySelectorAll('[data-slot="diff-viewer-line"][data-type="del"]'),
    ).map((line) => line.textContent);
    const added = Array.from(
      container.querySelectorAll('[data-slot="diff-viewer-line"][data-type="add"]'),
    ).map((line) => line.textContent);

    // 两个文件各出一块 diff，且不把 `@@` 或整段 JSON 当正文渲染。
    expect(container.querySelectorAll('[data-slot="diff-viewer"]')).toHaveLength(2);
    expect(deleted.some((text) => text?.includes('win.extraResources'))).toBe(true);
    expect(added.some((text) => text?.includes('extraResources 配置'))).toBe(true);
    expect(added.some((text) => text?.includes('platform-neutral guidance'))).toBe(true);
    expect(container.textContent).not.toContain('"changes"');
  });

  it('counts codex file_change stats across all changed files', () => {
    expect(getCodeChangeStats(CODEX_CHANGES_INPUT)).toEqual({ additions: 4, deletions: 1 });
  });

  it('shows codex file_change file names and hides raw changes JSON in the tool card', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="apply_patch"
        input={CODEX_CHANGES_INPUT}
        result="Patch completed"
        status="done"
      />,
    );

    expect(screen.getByText('verify-node-runtime.cjs, verify-node-runtime.test.ts')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent)
      .toContain('extraResources 配置');
    expect(container.textContent).not.toContain('"changes"');
    expect(container.textContent).not.toContain('"diff"');
  });

  it('renders codex file_change add and delete kinds from their full file content', () => {
    const { container } = render(
      <ToolCodeDiff
        toolName="apply_patch"
        input={{
          changes: [
            { kind: 'add', path: 'src/new-file.ts', diff: 'export const added = true;' },
            { kind: 'delete', path: 'src/old-file.ts', diff: 'export const removed = true;' },
          ],
        }}
      />,
    );

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent)
      .toContain('export const added = true;');
    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]')?.textContent)
      .toContain('export const removed = true;');
  });

  it('renders codex apply_patch shell commands as an inline patch diff', () => {
    const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: src/App.tsx
@@
-const title = 'old';
+const title = 'new';
*** End Patch
PATCH`;

    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Bash"
        input={{
          command,
          description: 'Update app title',
        }}
        result="Done"
        status="done"
      />,
    );

    // Now shows only filename, not full path
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'App.tsx' })).toBeNull();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]')?.textContent).toContain("const title = 'old';");
    expect(container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]')?.textContent).toContain("const title = 'new';");
    expect(container.textContent).not.toContain('"command"');
    expect(container.textContent).not.toContain('Done');
    expect(container.textContent).not.toContain('@@');
    expect(container.textContent).not.toContain('No newline at end of file');
  });
});
