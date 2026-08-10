// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from './PermissionApprovalCard';

describe('PermissionApprovalCard', () => {
  afterEach(() => cleanup());

  it('submits the selected Claude permission decision without rendering as a question tool', async () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);

    render(
      <PermissionApprovalCard
        request={{
          request_id: 'tool-1',
          permission_type: 'Bash',
          description: '允许 Claude 运行命令：npm test',
          metadata: {
            command: 'npm test',
            cwd: 'D:/project/ai-code/codeMUX',
          },
        }}
        onResponse={onResponse}
      />,
    );

    expect(screen.getByTestId('permission-approval-card')).toBeTruthy();
    expect(screen.getByText('$ cd D:/project/ai-code/codeMUX && npm test')).toBeTruthy();
    expect(screen.getByText('始终允许匹配规则')).toBeTruthy();

    fireEvent.click(screen.getByText('始终允许匹配规则'));
    fireEvent.click(screen.getByRole('button', { name: /确认/ }));

    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('always'));
  });

  it('renders ExitPlanMode as a dedicated plan approval', () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);

    render(
      <PermissionApprovalCard
        request={{
          request_id: 'exit-plan-1',
          permission_type: 'ExitPlanMode',
          description: '退出计划模式并开始实施。',
          metadata: { presentation: 'plan-approval', title: '实施计划' },
        }}
        onResponse={onResponse}
      />,
    );

    expect(screen.getByText('需要权限')).toBeTruthy();
    expect(screen.getByText('实施计划')).toBeTruthy();
    expect(screen.getByText('批准')).toBeTruthy();
    expect(screen.getByText('忽略')).toBeTruthy();
    expect(screen.getByPlaceholderText('输入你的回答...')).toBeTruthy();
    expect(screen.queryByText('始终允许匹配规则')).toBeNull();

    fireEvent.click(screen.getByText('忽略'));
    return waitFor(() => expect(onResponse).toHaveBeenCalledWith('reject'));
  });

  it('moves between approval options with arrows and selects with Enter', async () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);

    render(
      <PermissionApprovalCard
        request={{ request_id: 'permission-2', permission_type: 'Bash', description: '执行命令' }}
        onResponse={onResponse}
      />,
    );

    const once = screen.getByText('允许').closest('button');
    const always = screen.getByText('始终允许匹配规则').closest('button');
    expect(once).toBeTruthy();
    expect(always).toBeTruthy();

    fireEvent.keyDown(once!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(always));
    fireEvent.keyDown(always!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /确认/ }));

    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('always'));
  });

  it('presents OpenCode directory permissions with a readable title and keeps actions outside the option list', () => {
    const onResponse = vi.fn().mockResolvedValue(undefined);

    render(
      <PermissionApprovalCard
        request={{
          request_id: 'directory-1',
          permission_type: 'external_directory',
          description: 'external_directory',
          metadata: { filepath: 'C:\\Users\\94910\\.agents' },
        }}
        onResponse={onResponse}
      />,
    );

    expect(screen.getByText('访问外部目录')).toBeTruthy();
    expect(screen.getByText('C:\\Users\\94910\\.agents')).toBeTruthy();
    expect(screen.queryByText('external_directory')).toBeNull();
    const options = screen.getByTestId('permission-options');
    const footer = screen.getByTestId('permission-footer');
    const card = screen.getByTestId('permission-approval-card');
    expect(options.contains(footer)).toBe(false);
    expect(footer.parentElement).toBe(card);
    expect(options.parentElement).not.toBe(card);
    expect(screen.getByText('允许').closest('button')?.className).toContain('border-0');
  });
});
