// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { useSubagentStore } from '../../../stores/subagentStore';
import { usePreviewStore } from '../../../stores/previewStore';
import { getKnownSidecarErrorDisplay, getStreamStatusDisplay } from './CodeMuxMessageParts';
import { CodeMuxDataMessagePart, CodeMuxToolCallMessagePart } from './CodeMuxMessageParts';

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('getStreamStatusDisplay', () => {
  it('renders Codex mode-blocked diagnostics without labeling them as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'Codex collaboration mode blocked item/tool/requestUserInput: request_user_input_blocked_in_default_mode.',
      is_reconnecting: false,
      mode_blocked: {
        blocked_method: 'item/tool/requestUserInput',
        effective_mode: 'code',
        reason_code: 'request_user_input_blocked_in_default_mode',
        reason: 'requestUserInput is blocked while effective_mode=code',
        suggestion: 'Switch to Plan mode and resend the prompt when user input is needed.',
        request_id: 'tool-1',
      },
    });

    expect(display.tone).toBe('warning');
    expect(display.text).toContain('协作模式已阻止');
    expect(display.text).toContain('request_user_input_blocked_in_default_mode');
    expect(display.text).not.toContain('连接断开');
  });

  it('keeps non-reconnecting stream failures labeled as disconnected', () => {
    const display = getStreamStatusDisplay({
      message: 'stream closed before response.completed',
      is_reconnecting: false,
    });

    expect(display.tone).toBe('error');
    expect(display.text).toBe('连接断开: stream closed before response.completed');
  });
});

describe('CodeMuxToolCallMessagePart', () => {
  beforeEach(() => {
    useSidePanelStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('没有子智能体描述符时委派工具调用退化成普通工具行，不再渲染子智能体详情面板', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Agent"
        args={{ description: '检查消息渲染', prompt: '内部子智能体提示词\n\n请只返回结论' }}
        result="子智能体最终结果：已完成"
      />,
    );

    // 找不到描述符时无法确认这是真正的委派：保留工具行，委派不会在对话流里凭空消失。
    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    expect(trigger).not.toBeNull();
    // 子智能体预览入口由委派卡片的节点卡承担，工具行上不再挂 chip。
    expect(container.querySelector('[data-slot="subagent-preview-chip"]')).toBeNull();
    expect(screen.queryByText(/内部子智能体提示词/)).toBeNull();

    fireEvent.click(trigger as HTMLElement);

    // 展开后是普通工具参数/结果详情，不再走子智能体对话式气泡。
    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');
    expect(argsBlock?.textContent).toContain('内部子智能体提示词');
    expect(argsBlock?.className).not.toContain('justify-end');
    expect(resultBlock?.textContent).toContain('子智能体最终结果');
  });

  it('普通工具参数和结果保持原始详情样式，不使用子智能体对话式气泡或 Markdown 渲染', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Grep"
        args={{ pattern: '**not bold**', path: 'src' }}
        result="结果包含 **not bold**"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /搜索文本/ }));

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const chevron = container.querySelector('[data-slot="tool-fallback-trigger-chevron"]');
    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    const resultBlock = container.querySelector('[data-slot="tool-fallback-result"]');
    const toolRoot = container.querySelector('[data-slot="tool-fallback-root"]') as HTMLElement;
    const toolContent = container.querySelector('[data-slot="tool-fallback-content"]') as HTMLElement;

    expect(trigger?.className).toContain('font-normal');
    expect(trigger?.querySelector('b')).toBeNull();
    expect(chevron?.getAttribute('class')).toContain('opacity-0');
    expect(chevron?.getAttribute('class')).toContain('group-hover/trigger:opacity-100');
    expect(chevron?.getAttribute('class')).toContain('group-data-[state=open]/trigger:opacity-100');
    expect(argsBlock?.className).not.toContain('justify-end');
    expect(resultBlock?.className).not.toContain('justify-start');
    expect(resultBlock?.querySelector('strong')).toBeNull();
    expect(resultBlock?.textContent).toContain('结果包含 **not bold**');
    expect(resultBlock?.textContent).toContain('结果：');
    expect(toolRoot.style.getPropertyValue('--animation-duration')).toBe('200ms');
    expect(toolContent.className).toContain('animate-collapsible-down');
    expect(toolContent.className).toContain('duration-(--animation-duration)');
  });

  it('工具标题行按内容收缩，参数可截断但不把折叠按钮和 diff 统计推到行尾', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Grep"
        args={{ pattern: 'getInstallTodoListByTerrCodeV2', path: 'src' }}
        result="1 match"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const param = screen.getByText('getInstallTodoListByTerrCodeV2');

    expect(trigger?.className).toContain('inline-flex');
    expect(trigger?.className).toContain('max-w-full');
    expect(trigger?.className.split(/\s+/)).not.toContain('w-full');
    expect(param.className).toContain('truncate');
    expect(param.className).not.toContain('flex-1');
  });

  it('编辑类工具把 diff 统计紧跟在文件路径后面', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Edit"
        args={{
          file_path: 'src/main/java/InstallListPage.java',
          old_string: 'foo',
          new_string: 'bar',
        }}
        result="ok"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const label = container.querySelector('[data-slot="tool-fallback-trigger-label"]');
    const path = screen.getByText('InstallListPage.java');
    const chevron = container.querySelector('[data-slot="tool-fallback-trigger-chevron"]');

    expect(trigger?.className.split(/\s+/)).not.toContain('w-full');
    expect(label?.className).not.toContain('flex-1');
    expect(path.className).not.toContain('flex-1');
    expect(label?.textContent).toMatch(/\+\d+/);
    expect(label?.textContent).toMatch(/-\d+/);
    expect(path.compareDocumentPosition(chevron!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('终端的长参数仍可在最大宽度内截断展示', () => {
    const command = 'cd /d/project/ai-code/codeMUX && git diff --stat HEAD | head -40 && npm run build -- --mode production';
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Bash"
        args={{ command }}
        result="done"
      />,
    );

    const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const param = screen.getByText(command);

    expect(trigger?.className).toContain('max-w-full');
    expect(param.className).toContain('truncate');
    expect(param.className).not.toContain('flex-1');
  });

  it('终端展开后以终端面板展示命令和输出，不再拆成参数 JSON 和结果标签', () => {
    const command = 'cd /d/project/ai-code/codeMUX && git diff --stat HEAD | head -40';
    const output = [
      'src/components/agent/assistant-ui/CodeMuxMessageParts.tsx | 10 +++-',
      'src/components/assistant-ui/tool-fallback.tsx           |  4 +',
      ' 2 files changed, 12 insertions(+), 2 deletions(-)',
    ].join('\n');

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="shell_command"
        args={{ command, timeout_ms: 10000, workdir: 'D:\\project\\ai-code\\codeMUX' }}
        result={output}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    const commandLine = container.querySelector('[data-slot="tool-fallback-command-line"]');
    const outputBlock = container.querySelector('[data-slot="tool-fallback-command-output"]');
    const contentBody = container.querySelector('[data-slot="tool-fallback-content"]')?.firstElementChild;

    expect(panel?.textContent).toContain(`$ ${command}`);
    expect(panel?.textContent).toContain('CodeMuxMessageParts.tsx');
    expect(panel?.textContent).toContain('2 files changed');
    expect(panel?.className).toContain('font-mono');
    expect(panel?.className).toContain('overflow-hidden');
    expect(panel?.className).not.toMatch(/overflow-(?:y-)?auto/);
    expect(commandLine?.className).toContain('wrap-anywhere');
    expect(commandLine?.className).not.toMatch(/overflow-(?:y-)?auto/);
    expect(outputBlock?.className).toContain('overflow-y-auto');
    expect(outputBlock?.className).toContain('overflow-x-hidden');
    expect(outputBlock?.className).toContain('whitespace-pre-wrap');
    expect(outputBlock?.className).toContain('wrap-anywhere');
    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(contentBody?.className).not.toContain('max-h-40');
    expect(container.querySelector('[data-slot="tool-fallback-args"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-fallback-result"]')).toBeNull();
    expect(container.textContent).not.toContain('结果：');
    expect(container.textContent).not.toContain('"timeout_ms"');
    expect(container.textContent).not.toContain('"workdir"');
  });

  it('Bash 展开面板展示真实命令而不是 header 里的 description', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Bash"
        args={{ description: 'Check git diff', command: 'git diff --stat HEAD' }}
        result="1 file changed, 4 insertions(+)"
      />,
    );

    fireEvent.click(within(container).getByRole('button', { name: /终端/ }));

    const panel = container.querySelector('[data-slot="tool-fallback-command"]');
    expect(panel?.textContent).toContain('$ git diff --stat HEAD');
    expect(panel?.textContent).toContain('1 file changed, 4 insertions(+)');
    expect(panel?.textContent).not.toContain('Check git diff');
  });

  it('在 AI 消息中将询问用户工具渲染为问题回单卡片', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="question"
        toolCallId="question-message-1"
        sessionId="session-1"
        args={{
          questions: [{
            header: '技术栈',
            question: '你主要使用哪些技术栈？',
            multiple: true,
            options: [{ label: 'TypeScript' }, { label: 'Rust' }],
          }, {
            header: '周末',
            question: '周末你喜欢做什么？',
            options: [{ label: '写代码' }],
          }],
        }}
        result={JSON.stringify({ answers: [['TypeScript', 'Rust'], ['写代码']] })}
      />,
    );

    const trigger = screen.getByRole('button', { name: /询问用户/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    expect(screen.getByText('技术栈')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('Rust')).toBeTruthy();
    expect(screen.getByText('多选')).toBeTruthy();
    expect(screen.getByText('2 已回答')).toBeTruthy();
    expect(screen.getByText('你主要使用哪些技术栈？')).toBeTruthy();
    expect(screen.getByRole('button', { name: /下一个/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /下一个/ }));
    expect(screen.getByText('周末')).toBeTruthy();
    expect(screen.getByText('写代码')).toBeTruthy();
    expect(container.querySelector('[data-slot="tool-fallback-root"]')).toBeTruthy();
    expect(container.querySelector('[data-compact="true"]')).toBeTruthy();
  });

  it('将未回答的询问工具渲染为不可操作的工具预览', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="AskUserQuestion"
        toolCallId="pending-question-message-1"
        sessionId="session-1"
        args={{
          questions: [{
            header: '编程习惯',
            question: '你的日常编程习惯有哪些?(可多选)',
            multiple: true,
            options: [{ label: '自动化测试' }, { label: '代码审查' }],
          }],
        }}
      />,
    );

    expect(container.textContent).toContain('等待用户回答');
    expect(container.textContent).not.toContain('自动化测试');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('点击 ExitPlanMode 的 planFilePath 后在右侧计划标签中预览 plan 快照，展开区不重复展示整段 plan', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="ExitPlanMode"
        args={{
          plan: '# 优化 ExitPlanMode\n\n- 这段计划内容不应该塞进工具展开参数里',
          planFilePath: 'docs/superpowers/plans/exit-plan.md',
        }}
        result="No response requested."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /预览计划 docs\/superpowers\/plans\/exit-plan\.md/ }));

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [
        expect.objectContaining({
          kind: 'plan',
          planFilePath: 'docs/superpowers/plans/exit-plan.md',
          planContent: '# 优化 ExitPlanMode\n\n- 这段计划内容不应该塞进工具展开参数里',
        }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /退出计划模式/ }));

    const argsBlock = container.querySelector('[data-slot="tool-fallback-args"]');
    expect(argsBlock?.textContent).not.toContain('"plan"');
    expect(argsBlock?.textContent).not.toContain('这段计划内容不应该塞进工具展开参数里');
    expect(argsBlock?.textContent).toContain('"planFilePath"');
  });

  it('写入文件工具展开时只让 diff 区滚动，避免外层和内层出现双滚动条', () => {
    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Write"
        args={{
          file_path: 'snappy-splashing-lobster.md',
          content: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
        }}
        result="File written successfully"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /写入/ }));

    const content = container.querySelector('[data-slot="tool-fallback-content"]');
    const contentBody = content?.firstElementChild;
    const diffViewer = container.querySelector('[data-slot="diff-viewer"]');

    expect(contentBody?.className).not.toContain('overflow-y-auto');
    expect(contentBody?.className).not.toContain('max-h-40');
    expect(diffViewer?.className).toContain('overflow-auto');
  });

  it('描述符存在时委派工具行不再渲染，入口由委派卡片的节点卡承担', () => {
    useSubagentStore.setState({
      sessions: {
        'session-1': {
          order: ['toolu_1'],
          descriptors: {
            toolu_1: {
              subagentId: 'toolu_1',
              provider: 'claude',
              title: 'Explore',
              description: '检查消息渲染',
              status: 'running',
              toolCallId: 'toolu_1',
              subtitle: null,
              updatedAt: 0,
            },
          },
          events: { toolu_1: [] },
          seenEventIds: {},
        },
      },
    });

    const { container } = renderWithTooltip(
      <CodeMuxToolCallMessagePart
        toolName="Task"
        toolCallId="toolu_1"
        sessionId="session-1"
        args={{ description: '检查消息渲染', prompt: '内部提示词' }}
        result="Async agent launched successfully"
      />,
    );

    // 能按 toolCallId 找到描述符 = 这是一次真正的委派：委派卡片取代工具行，
    // 这里什么都不画（打开预览的入口是卡片的节点卡，见 subagent-activity.test.tsx）。
    expect(container.querySelector('[data-slot="tool-fallback-root"]')).toBeNull();
    expect(container.querySelector('[data-slot="subagent-preview-chip"]')).toBeNull();
    expect(useSidePanelStore.getState().isOpen).toBe(false);
  });
});

describe('CodeMuxDataMessagePart', () => {
  beforeEach(() => {
    cleanup();
    usePreviewStore.setState({
      treeRoot: [{
        name: 'docs',
        path: 'D:/project/ai-code/codeMUX/docs',
        isDir: true,
        children: [
          {
            name: 'feature.md',
            path: 'D:/project/ai-code/codeMUX/docs/feature.md',
            isDir: false,
          },
        ],
      }],
      treeRootPath: 'D:/project/ai-code/codeMUX',
      projectPath: 'D:/project/ai-code/codeMUX',
    });
  });

  it('在产物卡片上方仅列出正文里提到的 Markdown 文件', () => {
    renderWithTooltip(
      <CodeMuxDataMessagePart
        name="codemux-event"
        messageText="已写入 `docs/feature.md`"
        data={{
          eventKind: 'session_summary',
          event: {
            kind: 'session_summary',
            data: {
              type: 'system',
              subtype: 'session_summary',
              diffs: [{ file: 'src/App.tsx', additions: 1, deletions: 0 }],
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId('referenced-markdown-files')).toBeTruthy();
    expect(screen.getByText('feature.md')).toBeTruthy();
    expect(screen.getByText('文档 · MD')).toBeTruthy();
    expect(screen.getByText('1 个文件已更改')).toBeTruthy();
  });

  it('正文未提到 md 文件时不展示 Markdown 列表，即使改动产物里有 md', () => {
    renderWithTooltip(
      <CodeMuxDataMessagePart
        name="codemux-event"
        messageText="已按 spec 完成修订。"
        data={{
          eventKind: 'session_summary',
          event: {
            kind: 'session_summary',
            data: {
              type: 'system',
              subtype: 'session_summary',
              diffs: [
                { file: 'MEMORY.md', additions: 1, deletions: 0 },
                { file: 'docs/design.md', additions: 2, deletions: 1 },
              ],
            },
          },
        }}
      />,
    );

    expect(screen.queryByTestId('referenced-markdown-files')).toBeNull();
    expect(screen.getByText('2 个文件已更改')).toBeTruthy();
  });

  it('把 Claude 空闲超时的 sidecar 错误展示成中文提示', () => {
    render(
      <CodeMuxDataMessagePart
        name="codemux-event"
        data={{
          eventKind: 'error',
          event: {
            kind: 'error',
            data: {
              type: 'sidecar_error',
              error: 'Query timed out: no message received for 300s (after msg #412)\nError: Query timed out: no message received for 300s (after msg #412)\n    at Timeout._onTimeout (file:///D:/project/ai-code/codeMUX/apps/sidecar/dist/index.js:692:32)',
            },
          },
        }}
      />,
    );

    expect(screen.getByText('引擎空闲超时（300 秒无响应），请重新发送消息继续')).toBeTruthy();
    expect(screen.queryByText(/Timeout\._onTimeout/)).toBeNull();
    expect(screen.queryByText(/Query timed out/)).toBeNull();
  });
});

describe('getKnownSidecarErrorDisplay', () => {
  it('maps configured Claude idle timeouts to engine idle copy', () => {
    expect(getKnownSidecarErrorDisplay('Query timed out: no message received for 120s (after msg #9)')).toBe(
      '引擎空闲超时（120 秒无响应），请重新发送消息继续',
    );
  });

  it('keeps real user-input timeout copy distinct from idle timeout', () => {
    expect(getKnownSidecarErrorDisplay('等待用户回复超时，请重新发送消息继续')).toBe(
      '等待用户回复超时，请重新发送消息继续',
    );
  });

  it('maps Codex idle timeout errors', () => {
    expect(getKnownSidecarErrorDisplay('Turn idle timeout: no progress events received')).toBe(
      '引擎空闲超时（无进展事件），请重新发送消息继续',
    );
  });

  it('maps OpenCode idle timeout errors', () => {
    expect(getKnownSidecarErrorDisplay('No progress events for 300000ms; turn idle timed out')).toBe(
      '引擎空闲超时（300 秒无响应），请重新发送消息继续',
    );
  });
});
