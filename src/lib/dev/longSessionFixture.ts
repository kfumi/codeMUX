/**
 * 长会话夹具：供「长会话渲染规模」的基准与真实引擎探针共用。
 *
 * 存在的理由：本仓库此前四轮流式性能修复的共同缺口是没有端到端实测，长会话
 * 场景只有几十条事件的玩具夹具，且没有一条可复现的读数。这里把「一条像真实长
 * 会话的历史」定义成一处，让基准（jsdom）与真实引擎探针（无头 Chromium）用同一
 * 份数据，避免两边的夹具各自漂移后结论不可比。
 *
 * 形状刻意做成「行高差异大」：每轮 4 条事件（用户文本、工具调用、工具结果、
 * 带标题列表与代码围栏的助手总结），文本长度与工具结果行数随轮次变化。行高差异
 * 是必需的——离屏行的占位高度一旦与真实高度不同，累计偏移误差才会显现，这正是
 * 探针要裁决的对象。
 */
import type { AgentMessage } from '../../stores/agentStore';

/** 夹具使用的会话 id（基准与探针共用同一条身份）。 */
export const LONG_SESSION_ID = 'session-perf-large';

/** 每轮事件数，供断言与规模推算使用。 */
export const LONG_SESSION_EVENTS_PER_TURN = 4;

/**
 * 基准用的轮数。约 200 轮 / 800 条事件，与真实长会话同量级；
 * 单次挂载需要落在测试超时预算内（本仓库已有 30s 超时的先例）。
 */
export const LONG_SESSION_TURN_COUNT = 200;

/**
 * 真实引擎探针用的轮数。真实浏览器要跑真实 markdown 与真实样式表，成本远高于
 * jsdom；60 轮 / 240 条事件已经足以让首条消息远离视口（因而在离屏跳过渲染下
 * 始终未被渲染过），同时把单次探针控制在可接受的时间内。
 */
export const PROBE_TURN_COUNT = 60;

/** 短会话轮数：用于验证「阈值以下不进入新增度量路径」。 */
export const SHORT_SESSION_TURN_COUNT = 8;

/** 长会话事件数阈值之上——与生产里判定长会话的阈值保持同向（120 条事件）。 */
export const LONG_SESSION_EVENT_THRESHOLD = 120;

/** 基准与探针共用的固定种子：同一夹具 + 同一种子必须得到同一段到达节奏。 */
export const LONG_SESSION_BURST_SEED = 20260918;

/**
 * 生成一条合成的长会话历史。
 *
 * 参数只暴露轮数与会话 id，使调用方无法顺手改变事件形状——形状一旦分叉，
 * 基准与探针的读数就不可比了。
 */
export function buildLongSessionEvents(
  turnCount: number = LONG_SESSION_TURN_COUNT,
  sessionId: string = LONG_SESSION_ID,
): AgentMessage[] {
  const events: AgentMessage[] = [];

  for (let index = 0; index < turnCount; index += 1) {
    const toolUseId = `perf-tool-${index}`;
    // 让用户文本长度随轮次变化：用户行高度在真实会话里本来就不均匀。
    const promptTail = index % 4 === 0 ? `，并说明第 ${index} 步与上一步的差异` : '';

    events.push(
      { kind: 'user', data: { content: `性能测试消息 ${index}${promptTail}` } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-tool-${index}`,
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'Read',
                input: { file_path: `src/perf/${index}.tsx`, note: 'x'.repeat(80) },
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: `perf-tool-result-${index}`,
          session_id: sessionId,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                // 工具结果行数在 4–12 之间变化：工具行高度的主要来源。
                content: `result ${index}\n${'result-line\n'.repeat(4 + (index % 9))}`,
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-final-${index}`,
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `### 结果 ${index}\n\n- 项目 A\n- 项目 B\n\n\`\`\`ts\nconst value${index} = ${index};\n\`\`\``,
              },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    );
  }

  return events;
}

/** 夹具的事件总数——用于断言规模确实超过长会话阈值。 */
export function longSessionEventCount(turnCount: number = LONG_SESSION_TURN_COUNT): number {
  return turnCount * LONG_SESSION_EVENTS_PER_TURN;
}

/**
 * 夹具里第 `turnIndex` 轮用户消息对应的事件下标。
 *
 * 探针与基准都要「跳到较早的一条用户消息」，两边必须指向同一行，否则结论不可比。
 */
export function userMessageEventIndex(turnIndex: number): number {
  return turnIndex * LONG_SESSION_EVENTS_PER_TURN;
}
