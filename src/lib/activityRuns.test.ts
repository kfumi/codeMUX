import { describe, expect, it } from 'vitest';

import { buildConversationTurns } from '@/lib/conversationTurns';
import { buildActivityRuns, rowRunContinues } from '@/lib/activityRuns';
import type { AgentMessage } from '@/stores/agentStore';

function user(content: string): AgentMessage {
  return { kind: 'user', data: { content } } as unknown as AgentMessage;
}

function thinking(text: string): AgentMessage {
  return {
    kind: 'assistant',
    data: { uuid: `think-${text}`, message: { content: [{ type: 'thinking', thinking: text }] } },
  } as unknown as AgentMessage;
}

function tool(id: string, name: string, input: Record<string, unknown> = {}): AgentMessage {
  return {
    kind: 'assistant',
    data: { uuid: id, message: { content: [{ type: 'tool_use', id, name, input }] } },
  } as unknown as AgentMessage;
}

/** 一个事件里含多个内容块（思考 / 工具 / 文本）：块之间不可拆段。 */
function blocksEvent(id: string, content: Record<string, unknown>[]): AgentMessage {
  return {
    kind: 'assistant',
    data: { uuid: id, message: { content } },
  } as unknown as AgentMessage;
}

function text(value: string): AgentMessage {
  return {
    kind: 'assistant',
    data: { uuid: `text-${value}`, message: { content: [{ type: 'text', text: value }] } },
  } as unknown as AgentMessage;
}

function result(): AgentMessage {
  return {
    kind: 'result',
    data: { type: 'result', subtype: 'success', duration_ms: 1000 },
  } as unknown as AgentMessage;
}

/** 只含工具结果的用户事件（协议里的 tool_result），渲染层不画行。 */
function toolResult(id: string): AgentMessage {
  return {
    kind: 'user',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }],
      },
    },
  } as unknown as AgentMessage;
}

function askUserQuestion(id: string): AgentMessage {
  return {
    kind: 'ask_user_question',
    data: { tool_use_id: id, questions: [{ question: 'q', options: [{ label: 'a' }] }] },
  } as unknown as AgentMessage;
}

/** 提供方错误事件：前面还有「已调用、没拿到结果」的工具时会被折进那张工具卡，自己不画行。 */
function agentError(text: string): AgentMessage {
  return { kind: 'error', data: { type: 'error', error: text } } as unknown as AgentMessage;
}

/** 问询超时事件：只把结果贴回已有的问询卡片，同样不画行。 */
function askUserQuestionTimeout(id: string): AgentMessage {
  return {
    kind: 'ask_user_question_timeout',
    data: { tool_use_id: id, message: '等待用户回复超时，请重新发送消息继续' },
  } as unknown as AgentMessage;
}

function runsFor(events: AgentMessage[], isRunning = false) {
  const timestamps = events.map((_, index) => (index + 1) * 1000);
  const turns = buildConversationTurns(events, { isRunning, timestamps });
  return { ...buildActivityRuns(events, turns, timestamps, { isRunning }), timestamps, turns };
}

describe('buildActivityRuns', () => {
  it('keeps interleaved thinking and tool calls in one run, in source order', () => {
    const events = [
      user('go'),
      thinking('先探索架构'),
      tool('read-1', 'Read', { file_path: 'src/components/agent/AssistantPanel.tsx' }),
      thinking('再核对任务入口'),
      tool('bash-1', 'Bash', { command: 'npm run build' }),
      text('最终答复'),
      result(),
    ];

    const { runs, placementByEventIndex } = runsFor(events);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 2, 3, 4]);
    expect(runs[0]!.kinds).toEqual(['thinking', 'tool', 'thinking', 'tool']);
    expect(runs[0]!.stepCount).toBe(4);
    expect(runs[0]!.onlyThinking).toBe(false);
    expect(runs[0]!.live).toBe(false);
    // 段首才是组头，其余都是缩进步骤行。
    expect(placementByEventIndex.get(1)?.isHead).toBe(true);
    expect(placementByEventIndex.get(2)?.isHead).toBe(false);
    expect(placementByEventIndex.get(4)?.isHead).toBe(false);
    expect(placementByEventIndex.get(1)?.stepIndex).toBe(0);
    expect(placementByEventIndex.get(4)?.stepIndex).toBe(3);
  });

  it('splits runs on text and keeps the source order of the runs', () => {
    const events = [
      user('go'),
      thinking('第一段思考'),
      text('先确认范围。'),
      thinking('第二段思考'),
      result(),
    ];

    const { runs } = runsFor(events);

    expect(runs.map((run) => run.eventIndices)).toEqual([[1], [3]]);
    expect(runs.every((run) => run.onlyThinking)).toBe(true);
  });

  it('splits runs on non-process events such as an ask-user question seam', () => {
    const events = [user('go'), tool('read-1', 'Read'), askUserQuestion('read-1'), tool('bash-1', 'Bash')];

    const { runs } = runsFor(events, true);

    expect(runs.map((run) => run.eventIndices)).toEqual([[1], [3]]);
  });

  it('never merges process events across turns', () => {
    const events = [user('first'), thinking('a'), thinking('b'), user('second'), thinking('c')];

    const { runs } = runsFor(events);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.eventIndices).toEqual([1, 2]);
    expect(runs[1]!.eventIndices).toEqual([4]);
  });

  it('counts one event with reasoning and tool blocks as two steps of kind tool', () => {
    const both = {
      kind: 'assistant',
      data: {
        uuid: 'both',
        message: {
          content: [
            { type: 'thinking', thinking: '边想边调' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
    } as unknown as AgentMessage;

    const { runs } = runsFor([user('go'), both]);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.stepCount).toBe(2);
    expect(runs[0]!.kinds).toEqual(['tool']);
    expect(runs[0]!.onlyThinking).toBe(false);
  });

  it('ignores empty thinking and empty text blocks', () => {
    const emptyThinking = {
      kind: 'assistant',
      data: { uuid: 'empty', message: { content: [{ type: 'thinking', thinking: '' }] } },
    } as unknown as AgentMessage;
    const blankText = {
      kind: 'assistant',
      data: { uuid: 'blank', message: { content: [{ type: 'text', text: '\n\n' }] } },
    } as unknown as AgentMessage;

    const { runs, placementByEventIndex } = runsFor([user('go'), emptyThinking, blankText, tool('read-1', 'Read')]);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([3]);
    expect(placementByEventIndex.has(1)).toBe(false);
    expect(placementByEventIndex.has(2)).toBe(false);
  });

  it('marks only the trailing run of a running turn as live and leaves it open-ended', () => {
    const events = [
      user('go'),
      thinking('第一段'),
      text('中间说明'),
      tool('bash-1', 'Bash', { command: 'npm run build' }),
    ];

    const { runs } = runsFor(events, true);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.live).toBe(false);
    expect(runs[0]!.startedAt).toBe(2000);
    expect(runs[0]!.endedAt).toBe(3000);
    expect(runs[1]!.live).toBe(true);
    expect(runs[1]!.endedAt).toBeUndefined();
  });

  it('ends a settled trailing run at the turn settlement event', () => {
    const events = [user('go'), thinking('思考'), text('答案'), result()];

    const { runs } = runsFor(events);

    expect(runs[0]!.startedAt).toBe(2000);
    // 段末的时间取段后第一个事件（这里是最终文本事件）的时间戳。
    expect(runs[0]!.endedAt).toBe(3000);
    expect(runs[0]!.live).toBe(false);
  });

  it('exposes the last step summary as the collapsed tail', () => {
    const toolEvents = [user('go'), thinking('# 标题\n**正在核对**任务入口'), tool('read-1', 'Read', { file_path: 'src/App.tsx' })];
    const { runs } = runsFor(toolEvents, true);

    expect(runs[0]!.tail).toBe('App.tsx');

    const thinkingEvents = [user('go'), thinking('第一行\n## 结尾这一行')];
    const thinkingRuns = runsFor(thinkingEvents, true);

    expect(thinkingRuns.runs[0]!.tail).toBe('结尾这一行');
  });

  it('keeps a mixed thinking+text event in its own run and settles it', () => {
    const mixed = {
      kind: 'assistant',
      data: {
        uuid: 'mixed',
        message: {
          content: [
            { type: 'thinking', thinking: '最后一段思考' },
            { type: 'text', text: '最终答复' },
          ],
        },
      },
    } as unknown as AgentMessage;

    const { runs } = runsFor([user('go'), mixed, result()], true);

    // 「思考 + 最终答复」在同一个事件里：思考仍然开启一个段（有组头、有步骤行）。
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1]);
    expect(runs[0]!.stepCount).toBe(1);
    expect(runs[0]!.onlyThinking).toBe(true);
    // 文本落地即该段结束：回合还在跑也不再是 live，计时不再往上走。
    expect(runs[0]!.live).toBe(false);
    expect(runs[0]!.startedAt).toBe(2000);
    // 段后第一个事件（结算事件）的时间戳就是这一步真正做完的时刻。
    expect(runs[0]!.endedAt).toBe(3000);
  });

  it('lets the thinking of a mixed event continue the previous run before its text ends it', () => {
    const mixed = {
      kind: 'assistant',
      data: {
        uuid: 'mixed-tail',
        message: {
          content: [
            { type: 'thinking', thinking: '收尾思考' },
            { type: 'text', text: '最终答复' },
          ],
        },
      },
    } as unknown as AgentMessage;

    const { runs } = runsFor([user('go'), tool('read-1', 'Read', { file_path: 'a.ts' }), mixed], true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 2]);
    expect(runs[0]!.stepCount).toBe(2);
    expect(runs[0]!.kinds).toEqual(['tool', 'thinking']);
    expect(runs[0]!.onlyThinking).toBe(false);
    expect(runs[0]!.live).toBe(false);
  });

  it('starts a new run after a mixed event whose text ends the previous one', () => {
    // 「思考 + 答复」同在一个事件里时，文本把这一段结在那里：它后面的过程行属于新的一段。
    // 不在这里断开的话前后两段会被并成一段，后一段的段头（组头）就永远不会出现。
    const mixed = {
      kind: 'assistant',
      data: {
        uuid: 'mixed-middle',
        message: {
          content: [
            { type: 'thinking', thinking: '中间思考' },
            { type: 'text', text: '中间答复' },
          ],
        },
      },
    } as unknown as AgentMessage;

    const events = [
      user('go'),
      thinking('开头的思考'),
      mixed,
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      toolResult('read-1'),
    ];
    const { runs, placementByEventIndex } = runsFor(events, true);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.eventIndices).toEqual([1, 2]);
    expect(runs[0]!.stepCount).toBe(2);
    expect(runs[0]!.live).toBe(false);

    // 新一段以它自己的第一个过程事件为段首：段头画在那里，步骤行不缩进到别的段下面。
    expect(runs[1]!.eventIndices).toEqual([3]);
    expect(runs[1]!.kinds).toEqual(['tool']);
    expect(runs[1]!.live).toBe(true);
    expect(placementByEventIndex.get(3)).toMatchObject({ runKey: runs[1]!.runKey, isHead: true });
  });

  it('bridges tool-result-only user events instead of splitting the run', () => {
    // Claude/Codex 的流是 assistant(tool_use) ↔ user(tool_result) 交替；工具结果本身不画行，
    // 而相邻的工具调用在界面上是同一行里的多张卡，所以它不能把段切开。
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      toolResult('read-1'),
      tool('read-2', 'Read', { file_path: 'b.ts' }),
      toolResult('read-2'),
    ];

    const { runs, placementByEventIndex } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 3]);
    expect(runs[0]!.stepCount).toBe(2);
    // 尾段仍算「进行中」：后面只有不画行的事件。
    expect(runs[0]!.live).toBe(true);
    expect(placementByEventIndex.has(2)).toBe(false);
  });

  it('treats an assistant event that renders no row as transparent too', () => {
    const emptyThinking = {
      kind: 'assistant',
      data: { uuid: 'empty-again', message: { content: [{ type: 'thinking', thinking: '' }] } },
    } as unknown as AgentMessage;
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      emptyThinking,
      tool('bash-1', 'Bash', { command: 'npm run build' }),
    ];

    const { runs } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 3]);
    expect(runs[0]!.stepCount).toBe(2);
  });

  it('bridges provider events that render no row, such as an opencode diagnostic part', () => {
    // OpenCode 会把解析不了的 part 落成 kind='raw' 的 diagnostic 事件（如 part_type=patch）。
    // 渲染层不画这种行（只拿它算流状态 / 工具时长），它夹在两个工具调用之间时不能把段切开。
    const diagnostic = {
      kind: 'raw',
      data: { type: 'diagnostic', subtype: 'unknown_opencode_part', part_type: 'patch' },
    } as unknown as AgentMessage;
    const events = [
      user('go'),
      tool('glob-1', 'Glob', { pattern: 'docs/**' }),
      diagnostic,
      thinking('再写文件'),
      tool('write-1', 'Write', { file_path: 'docs/a.md' }),
    ];

    const { runs, placementByEventIndex } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 3, 4]);
    expect(runs[0]!.stepCount).toBe(3);
    expect(placementByEventIndex.has(2)).toBe(false);
  });

  it('bridges subagent stream deltas, which render no row', () => {
    // 子智能体时间线把流式增量（text_delta / reasoning_delta / content_started /
    // content_finished）也原样留着，一个回合里它们占九成以上；主线程的同名事件由
    // agentStore 就地消费、从不进入事件序列。convertAgentEvents 对它们不产出行，
    // 所以它们不能当成分段边界——否则每个内容块都会切开一次，一个回合变成一串
    // 「已处理 N 个步骤」组（线上实例：opencode 子智能体 102 步被切成 10 段）。
    const delta = (type: string, value: string) => ({
      kind: 'streaming',
      data: { event: { type, session_id: 'sub-1', text: value } },
    } as unknown as AgentMessage);
    const events = [
      user('go'),
      thinking('先找 Cargo.toml'),
      delta('reasoning_delta', '先找 '),
      delta('content_finished', ''),
      tool('glob-1', 'Glob', { pattern: '**/Cargo.toml' }),
      toolResult('glob-1'),
      delta('content_started', ''),
      delta('reasoning_delta', '再看 package.json'),
      thinking('再看 package.json'),
      tool('glob-2', 'Glob', { pattern: '**/package.json' }),
    ];

    const { runs, placementByEventIndex } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 4, 8, 9]);
    expect(runs[0]!.stepCount).toBe(4);
    expect(placementByEventIndex.has(2)).toBe(false);
  });

  it('bridges an error that gets absorbed by a pending tool card instead of splitting the run', () => {
    // convertAgentEvents 会把错误文本当成最近一个尚无结果的工具的结果贴上去
    // （attachLatestPendingToolError）：这时错误事件一行都画不出来，两次调用仍属同一段（各自一行）。
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      agentError('Command failed with exit code 1'),
      tool('read-2', 'Read', { file_path: 'b.ts' }),
      toolResult('read-2'),
    ];

    const { runs, placementByEventIndex } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 3]);
    expect(runs[0]!.stepCount).toBe(2);
    expect(placementByEventIndex.has(2)).toBe(false);
    // 段后只剩不画行的事件：这一段仍是进行中的尾段。
    expect(runs[0]!.live).toBe(true);
  });

  it('keeps an error as a boundary when no pending tool call can absorb it', () => {
    // 前面没有待结果的工具时，错误会自己画成一行（渲染层走 data-codemux-event），
    // 这时它必须切断分段：它下面是新的一段。
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      toolResult('read-1'),
      agentError('Stream disconnected'),
      thinking('重试'),
    ];

    const { runs } = runsFor(events, true);

    expect(runs.map((run) => run.eventIndices)).toEqual([[1], [4]]);
  });

  it('bridges turn-result and question-timeout events, which never render a row', () => {
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      result(),
      askUserQuestionTimeout('read-1'),
      tool('read-2', 'Read', { file_path: 'b.ts' }),
    ];

    const { runs } = runsFor(events, true);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 4]);
    expect(runs[0]!.stepCount).toBe(2);
  });

  it('reports whether the run continues into the next row', () => {
    // 一个段跨多个消息行：思考/工具各成一行时，前一行要让竖线接上下一行。
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      toolResult('read-1'),
      thinking('看完了'),
      tool('read-2', 'Read', { file_path: 'b.ts' }),
    ];

    const { runs, placementByEventIndex } = runsFor(events, true);
    const run = runs[0]!;

    expect(run.eventIndices).toEqual([1, 3, 4]);
    // 第一行只有步骤 0、1：这一段还没完。
    expect(rowRunContinues(placementByEventIndex, run, [1, 3])).toBe(true);
    // 第二行带着段末步骤：到此为止。
    expect(rowRunContinues(placementByEventIndex, run, [4])).toBe(false);
    // 行内没有本段步骤（用户消息那行）时也返回 false。
    expect(rowRunContinues(placementByEventIndex, run, [0])).toBe(false);
    // 没有段时同样返回 false。
    expect(rowRunContinues(placementByEventIndex, undefined, [1])).toBe(false);
  });
});

describe('delegation runs', () => {
  it('isolates a delegation event into its own run between the plain step groups', () => {
    const events = [
      user('go'),
      thinking('先看入口'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      tool('task-1', 'Task', { description: 'Inspect architecture' }),
      tool('glob-1', 'Glob', { pattern: 'src/**' }),
    ];

    const { runs, placementByEventIndex } = runsFor(events);

    // 委派事件像正文一样把左右两边的步骤组切开：2 步 ｜ 1 步（委派）｜ 1 步。
    expect(runs.map((run) => run.eventIndices)).toEqual([[1, 2], [3], [4]]);
    expect(runs.map((run) => run.stepCount)).toEqual([2, 1, 1]);
    expect(runs.map((run) => run.delegation)).toEqual([false, true, false]);
    // 中间那一段只含委派事件本身，左右两边的步骤不会被并进来，它自己独占段首。
    expect(runs[1]!.eventIndices).toEqual([3]);
    expect(runs[1]!.kinds).toEqual(['tool']);
    expect(placementByEventIndex.get(3)).toMatchObject({ runKey: runs[1]!.runKey, isHead: true });
    expect(placementByEventIndex.get(1)?.isHead).toBe(true);
    expect(placementByEventIndex.get(4)?.isHead).toBe(true);
  });

  it('merges adjacent delegation events into one delegation run', () => {
    const events = [
      user('go'),
      tool('task-1', 'Task', { description: 'A' }),
      tool('task-2', 'Task', { description: 'B' }),
    ];

    const { runs } = runsFor(events);

    // 相邻的委派事件合成同一个委派段，步数是两者之和。
    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 2]);
    expect(runs[0]!.delegation).toBe(true);
    expect(runs[0]!.stepCount).toBe(2);
  });

  it('keeps plain process runs out of the delegation class', () => {
    const events = [
      user('go'),
      thinking('先看入口'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      tool('bash-1', 'Bash', { command: 'pwd' }),
    ];

    const { runs } = runsFor(events);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.eventIndices).toEqual([1, 2, 3]);
    expect(runs[0]!.stepCount).toBe(3);
    expect(runs[0]!.delegation).toBe(false);
  });

  it('keeps the thinking of a delegation event inside that delegation run', () => {
    const events = [
      user('go'),
      tool('read-1', 'Read', { file_path: 'a.ts' }),
      blocksEvent('think-and-task', [
        { type: 'thinking', thinking: '先委派一个子智能体' },
        { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'A' } },
      ]),
      tool('glob-1', 'Glob', { pattern: 'src/**' }),
    ];

    const { runs, placementByEventIndex } = runsFor(events);

    // 事件是最小分段单位：思考与委派同在一个事件里，不能把它们拆到两段。
    expect(runs.map((run) => run.eventIndices)).toEqual([[1], [2], [3]]);
    expect(runs[1]!.delegation).toBe(true);
    expect(runs[1]!.stepCount).toBe(2);
    expect(runs[1]!.kinds).toEqual(['tool']);
    expect(runs[1]!.onlyThinking).toBe(false);
    expect(placementByEventIndex.get(2)).toMatchObject({ runKey: runs[1]!.runKey, isHead: true });
  });

  it('同一个 tool_use_id 的重复投影（输入刷新）只算一步', () => {
    const events = [
      user('go'),
      tool('call-1', 'Read', {}),
      tool('call-1', 'Read', { file_path: 'a.ts' }),
      tool('call-2', 'Bash', { command: 'pwd' }),
      text('最终答复'),
      result(),
    ];

    const { runs } = runsFor(events);

    // OpenCode 的 tool_started 是一对帧（pending 空 input → running 补全 input，各自新
    // event_id）：渲染层命中已有卡片就刷新参数、不再多画一行，所以段内只能算 2 步。
    expect(runs[0]!.stepCount).toBe(2);
    expect(runs[0]!.eventIndices).toEqual([1, 2, 3]);
  });

  it('重复帧被文本切开落进两段时，整段仍只算一步', () => {
    const events = [
      user('go'),
      tool('call-1', 'Read', {}),
      text('先说明一句'),
      tool('call-1', 'Read', { file_path: 'a.ts' }),
    ];

    const { runs } = runsFor(events);

    // 首见的那一段计这一步；后一段那一帧在渲染层不画行（同一次调用的参数刷新），计 0。
    expect(runs.map((run) => run.stepCount)).toEqual([1, 0]);
    expect(runs.map((run) => run.eventIndices)).toEqual([[1], [3]]);
  });
});
