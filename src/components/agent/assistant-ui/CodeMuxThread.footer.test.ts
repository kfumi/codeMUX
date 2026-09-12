// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { shouldRenderAssistantFooter } from './CodeMuxThread';

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
