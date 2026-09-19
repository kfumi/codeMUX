// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { assistantMessageBottomSpacing, shouldRenderAssistantFooter } from './CodeMuxThread';

const baseInput = {
  role: 'assistant' as const,
  isFinalAssistantMessage: true,
  turnStatus: 'completed' as const,
  turnId: 'turn-1',
};

describe('shouldRenderAssistantFooter', () => {
  it('已完成轮次的 footer 正常渲染', () => {
    expect(shouldRenderAssistantFooter(baseInput)).toBe(true);
  });

  it('子智能体流未落定时，只有进行中的那一轮隐藏 footer', () => {
    // 历史轮次（turn-1）不受进行中流程（pendingTurnId=turn-2）影响。
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      pendingTurnId: 'turn-2',
    })).toBe(true);
    // 进行中的那一轮 footer 等待落定。
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      turnId: 'turn-2',
      pendingTurnId: 'turn-2',
    })).toBe(false);
  });

  it('流程落定后（无 pendingTurnId）footer 恢复显示', () => {
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      pendingTurnId: undefined,
    })).toBe(true);
  });

  it('未完成的轮次不显示 footer', () => {
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      turnStatus: 'running',
    })).toBe(false);
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      turnStatus: 'interrupted',
    })).toBe(false);
  });

  it('非最终 assistant 消息和 system 行不显示 footer', () => {
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      isFinalAssistantMessage: false,
    })).toBe(false);
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      role: 'system' as const,
    })).toBe(false);
  });

  it('消息无法归属到轮次时不显示 footer', () => {
    expect(shouldRenderAssistantFooter({
      ...baseInput,
      turnId: undefined,
    })).toBe(false);
  });
});

describe('assistantMessageBottomSpacing', () => {
  it('紧邻发送框的最后一条消息只保留小间距', () => {
    expect(assistantMessageBottomSpacing({
      isLastRow: true,
      isToggleMessage: false,
      shouldRenderFooter: true,
    })).toBe('mb-2');
    expect(assistantMessageBottomSpacing({
      isLastRow: true,
      isToggleMessage: false,
      shouldRenderFooter: false,
    })).toBe('mb-2');
  });

  it('回合边界保持原有分隔：footer 行 mb-4，回合内消息行 mb-2，已处理开关 mb-2', () => {
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: false,
      shouldRenderFooter: true,
    })).toBe('mb-4');
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: false,
      shouldRenderFooter: false,
    })).toBe('mb-2');
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: true,
      shouldRenderFooter: false,
    // 「已处理」开关是它领起的正文的标题：末尾留 8px，再加开关下方那条分隔线。
    })).toBe('mb-2');
  });

  it('同一个处理段跨行时行距压到段内步距（3px），开关行除外', () => {
    // 段内的步距是 gap-[3px]：跨行的行距必须与它一致，否则每跨一行都会多出空隙、竖线断开。
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: false,
      shouldRenderFooter: false,
      continuesRun: true,
    })).toBe('mb-[3px]');
    // 「本轮处理」开关是标题而不是段内的一行：保留 8px 与它的分隔线，竖线由多探部分接上。
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: true,
      shouldRenderFooter: false,
      continuesRun: true,
    })).toBe('mb-2');
    // 段收起时不压行距（后面那几行整行不渲染，行距要照旧）。
    expect(assistantMessageBottomSpacing({
      isLastRow: false,
      isToggleMessage: false,
      shouldRenderFooter: false,
      continuesRun: false,
    })).toBe('mb-2');
  });
});
