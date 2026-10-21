// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InstructionComposer } from './InstructionComposer';

describe('InstructionComposer', () => {
  it('keeps a visible outline on the instruction box', () => {
    // 深色下 `--border` 与弹窗底（surface-3）同值，`border-border/70` 会整条
    // 消失；外壳必须与 Input 一样走 border-input（深色即 borderHeavy）。
    render(<InstructionComposer value="" onChange={() => {}} placeholder="指令" />);

    const shell = screen.getByPlaceholderText('指令').parentElement;
    expect(shell?.className).toContain('border-input');
    expect(shell?.className).not.toContain('border-border/70');
  });
});
