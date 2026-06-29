// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendToolResponse } = vi.hoisted(() => ({
  sendToolResponse: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  agentApi: {
    sendToolResponse,
  },
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: (state: { forceStopped: Record<string, boolean> }) => boolean) =>
    selector({ forceStopped: {} }),
}));

import { AskUserQuestionCard } from './AskUserQuestionCard';

describe('AskUserQuestionCard', () => {
  afterEach(() => {
    cleanup();
    sendToolResponse.mockReset();
  });

  it('renders readable approval copy and sends the selected answer', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          header: '审批',
          question: '允许 Claude 编辑 src/app.ts 吗？',
          options: [
            { label: '允许', description: '执行这一次操作。' },
            { label: '拒绝', description: '阻止这一次操作。' },
          ],
        }]}
      />,
    );

    expect(screen.getByText('审批')).toBeTruthy();
    expect(screen.getByText('允许 Claude 编辑 src/app.ts 吗？')).toBeTruthy();
    expect(screen.getByText('执行这一次操作。')).toBeTruthy();

    fireEvent.click(screen.getByText('允许'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['允许']);
    });
  });

  it('cancels with a readable submitted answer', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          question: '需要继续吗？',
          options: [{ label: '继续' }],
        }]}
      />,
    );

    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['__cancelled__']);
      expect(screen.getByText('已取消')).toBeTruthy();
    });
  });
});
