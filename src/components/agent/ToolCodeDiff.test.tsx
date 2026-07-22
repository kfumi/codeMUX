// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';
import { ToolCodeDiff } from './ToolCodeDiff';
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
