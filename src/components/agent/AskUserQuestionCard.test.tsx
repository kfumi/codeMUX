// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendToolResponse } = vi.hoisted(() => ({
  sendToolResponse: vi.fn(),
}));

const { updateSessionPermissions } = vi.hoisted(() => ({
  updateSessionPermissions: vi.fn(),
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    respondToInteractiveViaDaemon: sendToolResponse,
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

  it('supports keyboard selection with arrows, Tab, Enter, and Space', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="keyboard-1"
        questions={[{
          question: '需要继续吗？',
          options: [{ label: '继续' }, { label: '停止' }],
        }]}
      />,
    );

    const continueButton = screen.getByText('继续').closest('button');
    const stopButton = screen.getByText('停止').closest('button');
    expect(continueButton).toBeTruthy();
    expect(stopButton).toBeTruthy();

    fireEvent.keyDown(continueButton!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(stopButton));
    fireEvent.keyDown(stopButton!, { key: ' ' });
    expect(stopButton?.getAttribute('aria-pressed')).toBe('true');
    expect(stopButton?.classList.contains('bg-muted/92')).toBe(true);
    fireEvent.keyDown(stopButton!, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'keyboard-1', ['停止']));
  });

  it('renders the ExitPlanMode approval presentation with an always-visible input', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="exit-plan-1"
        variant="composer"
        questions={[{
          presentation: 'plan-approval',
          header: '需要权限',
          question: '实施计划',
          options: [{ label: '批准', description: '退出计划模式并开始实施。' }],
          inputPlaceholder: '输入你的回答...',
        }]}
      />,
    );

    expect(screen.getByText('需要权限')).toBeTruthy();
    expect(screen.getByText('实施计划')).toBeTruthy();
    expect(screen.getByText('批准')).toBeTruthy();
    expect(screen.getByText('退出计划模式并开始实施。')).toBeTruthy();
    expect(screen.getByPlaceholderText('输入你的回答...')).toBeTruthy();
    expect(screen.getByText('批准').closest('button')?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('批准').closest('button')?.classList.contains('bg-muted/92')).toBe(false);
    const otherRow = screen.getByPlaceholderText('输入你的回答...').closest('[data-other-input-row]');
    expect(otherRow?.classList.contains('bg-muted/92')).toBe(false);
    expect(otherRow?.textContent).toContain('2');

    fireEvent.focus(screen.getByPlaceholderText('输入你的回答...'));
    expect(screen.getByText('批准').closest('button')?.getAttribute('aria-pressed')).toBe('false');
    expect(otherRow?.classList.contains('bg-muted/92')).toBe(true);
  });

  it('renders the composer other input as the next numbered list row', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="numbered-other-1"
        variant="composer"
        questions={[{
          question: '你写代码时更接近哪种习惯?',
          options: [
            { label: '频繁调试', description: '边写边跑，快速验证' },
            { label: '先规划后编码', description: '先设计好再动手写' },
            { label: 'TDD 先行', description: '先写测试再写实现' },
            { label: '直接开写', description: '直接上手，边写边想' },
          ],
        }]}
      />,
    );

    const otherRow = screen.getByPlaceholderText('输入你的回答...').closest('[data-other-input-row]');
    expect(otherRow?.textContent).toContain('5');
    expect(otherRow?.querySelector('.rounded-md.border')).toBeNull();
  });

  it('does not mark composer questions as answered before the user chooses', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="multi-question-defaults-1"
        variant="composer"
        questions={[
          { header: '音乐', question: '选择音乐', options: [{ label: '轻音乐', description: '安静治愈' }, { label: '摇滚', description: '节奏感强' }] },
          { header: '键盘', question: '选择键盘', options: [{ label: '机械键盘' }] },
        ]}
      />,
    );

    expect(screen.getByText('轻音乐').closest('button')?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('摇滚').closest('button')?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('轻音乐').closest('button')?.className).toContain('border-0');
    expect(screen.getByText('摇滚').closest('button')?.className).toContain('border-0');
    expect(screen.getByRole('tablist').querySelectorAll('svg')).toHaveLength(0);
  });

  it('uses square controls for composer multi-select options and round controls for single-select options', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="composer-shapes-1"
        variant="composer"
        questions={[
          { question: '选择多个', multiSelect: true, options: [{ label: '甲' }] },
          { question: '选择一个', multiSelect: false, options: [{ label: '乙' }] },
        ]}
      />,
    );

    const multiSelectControl = screen.getByText('甲').closest('button')?.firstElementChild?.firstElementChild;

    expect(multiSelectControl?.className).toContain('rounded-none');
    expect(multiSelectControl?.className).not.toContain('rounded-full');

    cleanup();
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="composer-shapes-2"
        variant="composer"
        questions={[{ question: '选择一个', multiSelect: false, options: [{ label: '乙' }] }]}
      />,
    );

    const singleSelectControl = screen.getByText('乙').closest('button')?.firstElementChild?.firstElementChild;
    expect(singleSelectControl?.className).toContain('rounded-full');
  });

  it('accepts OpenCode multiple field for multi-select rendering', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="opencode-multiple-1"
        variant="composer"
        questions={[{ question: '选择多个', multiple: true, options: [{ label: '甲' }] }]}
      />,
    );

    const control = screen.getByText('甲').closest('button')?.firstElementChild?.firstElementChild;
    expect(control?.className).toContain('rounded-none');
    expect(control?.className).not.toContain('rounded-full');
  });

  it('does not infer multi-select from question text without metadata', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="opencode-multiple-hint-1"
        variant="composer"
        questions={[{ question: '你的日常编程习惯有哪些?(可多选)', multiSelect: false, options: [{ label: '自动化测试' }] }]}
      />,
    );

    const control = screen.getByText('自动化测试').closest('button')?.firstElementChild?.firstElementChild;
    expect(control?.className).toContain('rounded-full');
    expect(control?.className).not.toContain('rounded-none');
  });

  it('renders Claude answers as a readable question summary', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="claude-result-1"
        submitted
        resultContent={'Your questions have been answered: "如果你有一台时间机器，你最想去哪个时代看看？"="中国古代", "周末闲暇时，你更喜欢怎么放松？"="宅家打游戏".'}
        questions={[
          { header: '时间机器', question: '如果你有一台时间机器，你最想去哪个时代看看？', options: [{ label: '中国古代' }] },
          { header: '周末', question: '周末闲暇时，你更喜欢怎么放松？', options: [{ label: '宅家打游戏' }] },
        ]}
      />,
    );

    expect(screen.getByText('中国古代')).toBeTruthy();
    expect(screen.getByText('宅家打游戏')).toBeTruthy();
    expect(screen.getAllByText('时间机器')).toHaveLength(2);
    expect(screen.getByText('周末')).toBeTruthy();
  });

  it('renders structured OpenCode answers as chips and expands numeric multi-select answers', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="opencode-result-1"
        submitted
        resultContent={JSON.stringify({
          answers: [['PWA / 手机浏览器网页 (Recommended)'], ['Rust axum，直接在 Tauri 核心 (Recommended)'], ['1+2+3'], ['扫码配对 (Recommended)']],
        })}
        questions={[
          { header: '移动端形态', question: '移动端客户端用什么形态？', options: [{ label: 'PWA / 手机浏览器网页 (Recommended)' }] },
          { header: 'Server 实现', question: '桌面端 Sync Server 用什么实现？', options: [{ label: 'Rust axum，直接在 Tauri 核心 (Recommended)' }] },
          {
            header: '操作范围',
            question: '移动端需要哪些对话操作？',
            multiple: true,
            options: [{ label: '查看会话列表' }, { label: '发送消息' }, { label: '中断生成' }],
          },
          { header: '连接方式', question: '手机如何连接到桌面端？', options: [{ label: '扫码配对 (Recommended)' }] },
        ]}
      />,
    );

    expect(screen.getByText('PWA / 手机浏览器网页 (Recommended)')).toBeTruthy();
    expect(screen.getByText('Rust axum，直接在 Tauri 核心 (Recommended)')).toBeTruthy();
    expect(screen.getByText('查看会话列表')).toBeTruthy();
    expect(screen.getByText('发送消息')).toBeTruthy();
    expect(screen.getByText('中断生成')).toBeTruthy();
    expect(screen.getByText('多选')).toBeTruthy();
    expect(screen.getByText('扫码配对 (Recommended)')).toBeTruthy();
    expect(screen.queryByText('1+2+3')).toBeNull();
  });

  it('submits the plan approval input as the answer when it is focused', async () => {
    sendToolResponse.mockResolvedValue(undefined);

    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="exit-plan-input-1"
        variant="composer"
        questions={[{
          presentation: 'plan-approval',
          question: '实施计划',
          options: [{ label: '批准' }],
        }]}
      />,
    );

    const input = screen.getByPlaceholderText('输入你的回答...');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '请先补充测试' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => {
      expect(sendToolResponse).toHaveBeenCalledWith('session-1', 'exit-plan-input-1', ['请先补充测试']);
    });
  });

  it('does not select the first option when Enter is pressed in the composer other input inside a form', async () => {
    render(
      <form onSubmit={(event) => event.preventDefault()}>
        <AskUserQuestionCard
          sessionId="session-1"
          toolUseId="form-enter-1"
          variant="composer"
          questions={[
            {
              header: 'SPEC 文件',
              question: '本次 SDD 开发使用的 SPEC 文件是？',
              options: [
                { label: '暂无 SPEC 文件', description: '不反馈' },
                { label: '手动输入路径', description: '填写相对路径' },
              ],
            },
            {
              header: '仓库地址',
              question: '仓库地址是？',
              options: [{ label: '默认' }],
            },
          ]}
        />
      </form>,
    );

    const input = screen.getByPlaceholderText('输入你的回答...');
    const firstOption = screen.getByText('暂无 SPEC 文件').closest('button');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'openspec/changes/foo/proposal.md' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(firstOption?.getAttribute('aria-pressed')).toBe('false');
      expect(input.closest('[data-other-input-row]')?.classList.contains('bg-muted/92')).toBe(true);
      expect(screen.getByRole('tab', { name: /仓库地址/ }).getAttribute('data-state')).toBe('active');
    }, { timeout: 500 });
  });

  it('keeps a multi-question tab row horizontally scrollable without vertical overflow', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="multi-question-1"
        variant="composer"
        questions={[
          { header: '语言', question: '选择语言', options: [{ label: 'Python' }] },
          { header: '系统', question: '选择系统', options: [{ label: 'Windows' }] },
        ]}
      />,
    );

    const tabList = screen.getByRole('tablist');
    expect(tabList.classList.contains('overflow-x-auto')).toBe(true);
    expect(tabList.classList.contains('overflow-y-hidden')).toBe(true);
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

  it('renders expired questions as disabled and does not send stale tool responses', () => {
    render(
      <AskUserQuestionCard
        sessionId="session-1"
        toolUseId="tool-1"
        expired
        questions={[{
          question: '需要继续吗？',
          options: [{ label: '继续' }],
        }]}
      />,
    );

    expect(screen.getByText('等待用户回复超时，请重新发送消息继续')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByText('继续'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(sendToolResponse).not.toHaveBeenCalled();
  });
});
