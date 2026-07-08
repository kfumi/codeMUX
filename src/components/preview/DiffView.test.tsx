// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from './DiffView';

describe('DiffView', () => {
  it('只展示变更行及其上下三行上下文', () => {
    const oldContent = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const newContent = oldContent.replace('line 7', 'line seven');

    render(<DiffView oldContent={oldContent} newContent={newContent} />);

    expect(screen.getByText('line 4')).toBeTruthy();
    expect(screen.getByText('line 10')).toBeTruthy();
    expect(screen.getByText('-')).toBeTruthy();
    expect(screen.getByText('+')).toBeTruthy();
    expect(screen.queryByText('line 3')).toBeNull();
    expect(screen.queryByText('line 11')).toBeNull();
    expect(screen.getAllByText('...').length).toBeGreaterThan(0);
  });
});
