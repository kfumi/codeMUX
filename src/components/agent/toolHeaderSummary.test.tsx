// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';
import { TooltipProvider } from '../ui/tooltip';

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('tool header summaries', () => {
  it('shows Read file name in the header (not full path) and removes it from expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Read"
        input={{
          file_path: 'D:\\project\\src\\App.tsx',
        }}
        status="done"
      />,
    );

    // Now shows only filename, not full path
    expect(screen.getByText('App.tsx')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"file_path"');
  });

  it('shows Bash description in the header without expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="Bash"
        input={{
          description: 'Run typecheck',
          command: 'npm run build',
        }}
        status="done"
      />,
    );

    expect(screen.getByText('Run typecheck')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).not.toContain('"description"');
    expect(container.textContent).not.toContain('"command"');
    expect(container.textContent).not.toContain('npm run build');
  });

  it('shows shell_command command in the header and keeps it in expanded args', () => {
    const { container } = renderWithTooltip(
      <ToolCallCard
        toolName="shell_command"
        input={{
          command: 'node --check script.js',
          timeout_ms: 10000,
          workdir: 'D:\\project\\ai-code\\code-demo',
        }}
        status="done"
      />,
    );

    expect(screen.getByText('node --check script.js')).toBeTruthy();

    fireEvent.click(within(container).getByRole('button'));

    expect(container.textContent).toContain('"command"');
    expect(container.textContent).toContain('"timeout_ms"');
    expect(container.textContent).toContain('"workdir"');
  });

  it('shows Grep pattern and Agent description in the header', () => {
    renderWithTooltip(
      <>
        <ToolCallCard toolName="Grep" input={{ pattern: 'ToolCallCard', path: 'src' }} status="done" />
        <ToolCallCard toolName="Agent" input={{ description: 'Explore tool message rendering', prompt: 'Full prompt' }} status="done" />
      </>,
    );

    expect(screen.getByText('ToolCallCard')).toBeTruthy();
    expect(screen.getByText('Explore tool message rendering')).toBeTruthy();
  });
});
