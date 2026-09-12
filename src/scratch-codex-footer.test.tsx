// @vitest-environment jsdom
// 临时复现:同步后的 codex 会话 + 紧凑输出开启,渲染整线程数 footer。
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { CodeMuxAssistantRuntimeProvider } from '@/components/agent/assistant-ui/CodeMuxAssistantRuntime';
import { CodeMuxThread } from '@/components/agent/assistant-ui/CodeMuxThread';
import { collapsePersistedCompactTimeline } from '@/stores/agentEventParsing';
import { normalizeTurnProcessTimeline } from '@/lib/agentTurnOrdering';
import { parseAgentEvent, useAgentStore } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AppConfig } from '@/types/provider';
import type { AgentMessage } from '@/stores/agentStore';

const SESSION = 'scratch-codex';
const EVENTS_FILE = process.env.SCRATCH_EVENTS ?? 'codex-events-scratch.jsonl';
const COMPACT = process.env.SCRATCH_COMPACT === '1';

const rawLines = readFileSync(EVENTS_FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function buildTimeline(): { events: AgentMessage[]; timestamps: number[] } {
  const loaded = rawLines.map((raw) => ({
    event: parseAgentEvent(JSON.stringify(raw)),
    ts: raw.timestamp ? Date.parse(raw.timestamp) : 0,
  }));
  const normalized = normalizeTurnProcessTimeline(collapsePersistedCompactTimeline(loaded));
  return {
    events: normalized.map((entry) => entry.event),
    timestamps: normalized.map((entry) => entry.ts),
  };
}

const config: AppConfig = {
  model_providers: [],
  active_provider_id: null,
  agent_defaults: { default_agent_kind: 'claude_code' },
  agent_configs: {
    claude_code: { executable_mode: 'auto', resume_sessions: true },
    codex: {},
    gemini_cli: {},
    opencode: {},
  },
  theme: 'System',
  compact_ai_output: COMPACT,
  default_open_target: 'file_explorer',
  notifications: { system_enabled: true, sound_enabled: false, sound: 'ding' },
};

describe('scratch: rendered footers for synced codex timeline', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class MockResizeObserver {
      observe() {} unobserve() {} disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    useSettingsStore.setState({ config });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it(`counts rendered footers (compact=${COMPACT})`, () => {
    const { events, timestamps } = buildTimeline();

    // 模拟真实顺序:先挂载 resync 前的实时时间线(sidecar 落盘形态),
    // 点击 resync 后原位换成 CLI 重建的时间线(组件不重挂)。
    const liveTimeline: AgentMessage[] = [
      { kind: 'user', data: { content: '你好', uuid: 'live-u1' } },
      { kind: 'assistant', data: { type: 'assistant', uuid: 'live-a1', message: { role: 'assistant', content: [{ type: 'text', text: '你好！有什么可以帮你的吗？\n\n比如：修 bug、加功能、代码审查、重构，或者看看某个模块的实现。直接说需求就行。' }] } } },
      { kind: 'result', data: { type: 'result', subtype: 'success', is_error: false, duration_ms: 1500 } },
      { kind: 'user', data: { content: '你是什么模型', uuid: 'live-u2' } },
      { kind: 'assistant', data: { type: 'assistant', uuid: 'live-a2', message: { role: 'assistant', content: [{ type: 'text', text: '我是运行在 Codex CLI 里的编码代理（OpenAI 的 Codex 智能体）。' }] } } },
      { kind: 'result', data: { type: 'result', subtype: 'success', is_error: false, duration_ms: 2100 } },
    ];

    act(() => {
      useAgentStore.setState({
        events: { [SESSION]: liveTimeline },
        eventTimestamps: { [SESSION]: liveTimeline.map((_, i) => Date.parse('2026-09-12T15:40:4Z') + i * 1000) },
        isRunning: { [SESSION]: false },
        turns: {},
      });
    });

    render(
      <TooltipProvider>
        <CodeMuxAssistantRuntimeProvider sessionId={SESSION} agentKind="codex" onSend={vi.fn()} onCommand={vi.fn()}>
          <CodeMuxThread sessionId={SESSION} />
        </CodeMuxAssistantRuntimeProvider>
      </TooltipProvider>,
    );

    const reportRows = () => Array.from(document.querySelectorAll('.group\\/message-row')).map((row) => {
      const hasFooter = Boolean(row.querySelector('[data-message-footer]'));
      const text = (row.textContent ?? '').slice(0, 16).replace(/\s+/g, ' ');
      return `${row.className.includes('justify-end') ? 'user-row   ' : 'assistant-row'} footer=${hasFooter} "${text}"`;
    });

    console.log('--- live timeline (pre-resync) ---');
    console.log(reportRows().join('\n'));

    // === 点击"从CLI同步历史": clearEvents + loadSessionMessages(原位换数据) ===
    const { events: resynced, timestamps: resyncedTs } = { events, timestamps };
    act(() => {
      useAgentStore.setState((state) => {
        const events = { ...state.events };
        delete events[SESSION];
        return { events, isRunning: {} };
      });
    });
    act(() => {
      useAgentStore.setState({
        events: { [SESSION]: resynced },
        eventTimestamps: { [SESSION]: resyncedTs },
      });
    });

    console.log('--- after resync (same mount) ---');
    console.log(reportRows().join('\n'));
    const footers = document.querySelectorAll('[data-message-footer]');
    expect(footers.length).toBeGreaterThan(0);
  });
});
