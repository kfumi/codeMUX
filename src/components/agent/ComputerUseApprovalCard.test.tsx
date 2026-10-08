// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComputerUseApprovalRequest } from '../../lib/computerUseApprovals';
import { ComputerUseApprovalCard } from './ComputerUseApprovalCard';

function request(overrides: Partial<ComputerUseApprovalRequest> = {}): ComputerUseApprovalRequest {
  return {
    request_id: 'req-1',
    session_id: 'session-1',
    tool: 'browser_click',
    op: 'click',
    summary: '点击元素 e3',
    risk: 'input',
    sensitive: null,
    rememberable: false,
    ...overrides,
  };
}

describe('ComputerUseApprovalCard', () => {
  afterEach(() => cleanup());

  it('offers only allow-once and reject for input actions', async () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);
    render(<ComputerUseApprovalCard request={request()} onResponse={onResponse} />);

    expect(screen.getByText('点击元素 e3')).toBeTruthy();
    expect(screen.queryByText('本会话记住')).toBeNull();

    fireEvent.click(screen.getByText('放行'));
    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('once'));

    fireEvent.click(screen.getByText('拦截'));
    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('reject'));
  });

  it('offers session memory for read-only requests that allow it', async () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);
    render(
      <ComputerUseApprovalCard
        request={request({
          op: 'snapshot',
          risk: 'readOnly',
          rememberable: true,
          summary: '读取页面快照(编号截图加元素列表)',
        })}
        onResponse={onResponse}
      />,
    );

    fireEvent.click(screen.getByText('本会话记住'));
    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('always'));
  });

  it('flags sensitive scenarios and explains why remembering is unavailable', () => {
    render(
      <ComputerUseApprovalCard
        request={request({ sensitive: '支付', summary: '点击元素 e9' })}
        onResponse={vi.fn()}
      />,
    );

    expect(screen.getByText('敏感场景 · 支付')).toBeTruthy();
    expect(screen.getByText(/敏感场景（支付）/)).toBeTruthy();
    expect(screen.queryByText('本会话记住')).toBeNull();
  });
});
