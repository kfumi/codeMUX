// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlanPreviewPanel } from './PlanPreviewPanel';

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
  });

  it('renders source files with the code preview component', () => {
    render(
      <PlanPreviewPanel
        planFilePath="D:/project/codeMUX/src/main.ts"
        planContent={'const answer: number = 42;\nconsole.log(answer);\n'}
      />,
    );

    expect(screen.getByTestId('file-preview-code')).toBeTruthy();
    expect(screen.getByTestId('file-preview-code').textContent).toContain('const answer');
    expect(screen.getByText('1')).toBeTruthy();
  });
});
