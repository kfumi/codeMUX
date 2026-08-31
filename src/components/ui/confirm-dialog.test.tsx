// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

describe('ConfirmDialog', () => {
  it('wraps long descriptions and keeps footer actions visible', () => {
    const longTitle =
      '看下企宽工单 micro 的竣工环节业务、AC、AP 及企业路由器 的? InwlcsMicroServiceUniApp\\pages\\jiakeMic... ·分支';

    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="删除对话"
        description={`确定要删除"${longTitle}"吗？此操作不可撤销。`}
        confirmLabel="删除"
        variant="destructive"
        onConfirm={vi.fn()}
      />,
    );

    const description = screen.getByText(/确定要删除/);
    expect(description.className).toContain('break-words');
    expect(description.className).toContain('[overflow-wrap:anywhere]');

    const cancelButton = screen.getByRole('button', { name: '取消' });
    const footer = cancelButton.parentElement;
    expect(footer?.className).toContain('shrink-0');
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });
});
