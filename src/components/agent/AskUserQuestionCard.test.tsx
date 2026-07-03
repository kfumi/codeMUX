// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendToolResponse } = vi.hoisted(() => ({
  sendToolResponse: vi.fn(),
}));

const { updateSessionPermissions } = vi.hoisted(() => ({
  updateSessionPermissions: vi.fn(),
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

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { updateSessionPermissions: typeof updateSessionPermissions }) => unknown) =>
    selector({ updateSessionPermissions }),
}));

import { AskUserQuestionCard } from './AskUserQuestionCard';

describe('AskUserQuestionCard', () => {
  afterEach(() => {
    cleanup();
    sendToolResponse.mockReset();
    updateSessionPermissions.mockReset();
  });

  it('renders readable approval copy and sends the selected allow answer', async () => {
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
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('阻止这一次操作。')).toBeTruthy();

    fireEvent.click(screen.getByText('允许'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['允许']);
    });
  });

  it('sends the selected deny answer', async () => {
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

    expect(screen.getByText('拒绝')).toBeTruthy();

    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', ['拒绝']);
    });
  });

  it('sends structured option values when present', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          header: '审批',
          question: '允许 Claude 编辑 src/app.ts 吗？',
          options: [
            { label: '允许', value: { action: 'allow' } },
            {
              label: '允许并允许编辑',
              value: {
                action: 'allow_and_elevate_permissions',
                permissionConfig: { kind: 'claude_code', permissionMode: 'acceptEdits' },
                planMode: 'off',
              },
            },
          ],
        }]}
      />,
    );

    fireEvent.click(screen.getByText('允许并允许编辑'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(updateSessionPermissions).toHaveBeenCalledWith(
        'session-1',
        { kind: 'claude_code', permissionMode: 'acceptEdits' },
        'off',
      );
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'tool-1', [{
        action: 'allow_and_elevate_permissions',
        permissionConfig: { kind: 'claude_code', permissionMode: 'acceptEdits' },
        planMode: 'off',
      }]);
    });
  });

  it('can hide the free-form other option for approval questions', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        questions={[{
          header: '审批',
          question: '接受这次编辑吗？',
          allowOther: false,
          options: [
            { label: '接受', value: { action: 'allow' } },
            { label: '接受并允许编辑', value: { action: 'allow_and_elevate_permissions' } },
            { label: '拒绝', value: { action: 'deny' } },
          ],
        }]}
      />,
    );

    expect(screen.queryByText('其他')).toBeNull();
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
