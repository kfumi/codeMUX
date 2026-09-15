// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore, type AgentMessage } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSubagentStore } from '../../../stores/subagentStore';
import type { Session } from '../../../types/session';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { TooltipProvider } from '../../ui/tooltip';
import {
  buildAgentInputPayloadFromAppendMessage,
  CodeMuxImageAttachmentAdapter,
  CodeMuxAssistantRuntimeProvider,
  resolveChipCommand,
  resolveSlashCommand,
  shouldRouteChipCommandToHandler,
} from './CodeMuxAssistantRuntime';
import { CodeMuxThread, buildToolDurationMap, extractUserNavTitle } from './CodeMuxThread';

const sessionOneEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session one user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session one assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const sessionTwoEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'session two user' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-2',
      session_id: 'session-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'session two assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const failedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-tool',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'error',
    data: {
      type: 'sidecar_error',
      error: 'Command failed with exit code 1',
    },
  },
];

const timestampOnlyAssistantEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-timestamp-only',
      session_id: 'session-timestamp',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'timestamp only assistant' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const reasoningEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-reasoning',
      session_id: 'session-reasoning',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'thinking through it' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const groupedToolEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'app' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-tool-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'src/main.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'tool-result-2',
      session_id: 'session-grouped-tools',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'main' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const exploreGroupEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-text-1',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '先确认范围。' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-think-1',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '先探索下当前桌面端架构。' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-tool-1',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'explore-read-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'explore-tool-result-1',
      session_id: 'session-explore-group',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'explore-read-1', content: 'app' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-think-2',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '再核对任务入口。' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-tool-2',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'explore-task-1', name: 'Task', input: { description: 'Inspect architecture' } },
          { type: 'tool_use', id: 'explore-glob-1', name: 'Glob', input: { pattern: 'src/**/*.tsx' } },
          { type: 'tool_use', id: 'explore-bash-1', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'explore-tool-result-2',
      session_id: 'session-explore-group',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'explore-task-1', content: 'done' },
          { type: 'tool_result', tool_use_id: 'explore-glob-1', content: 'files' },
          { type: 'tool_result', tool_use_id: 'explore-bash-1', content: '/' },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'explore-text-2',
      session_id: 'session-explore-group',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '架构已摸清。先给你我的分析，再确认几个关键决策点。' },
          { type: 'text', text: '架构已摸清。' },
        ],
      },
      parent_tool_use_id: null,
    },
  },
];

const fileMutationSplitEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'mutation-read-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'mutation-read-1', name: 'Read', input: { file_path: 'src/App.tsx' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'mutation-read-result-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'mutation-read-1', content: 'app' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'mutation-write-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'mutation-write-1', name: 'Write', input: { file_path: 'src/App.tsx', content: 'updated' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'mutation-write-result-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'mutation-write-1', content: 'Wrote file successfully.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'mutation-bash-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'mutation-bash-1', name: 'Bash', input: { command: 'pwd' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'mutation-bash-result-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'mutation-bash-1', content: '/' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'mutation-text-1',
      session_id: 'session-file-mutation-split',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '文件已写好。' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const directiveUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '/review @src/App.tsx please check this' } },
];

const skillDirectiveUserEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: { content: '[$to-spec](C:\\Users\\94910\\.codemux\\skills\\to-spec\\SKILL.md) 下面是我和codex对话得到的计划，生成spec:' },
  },
];

const longUserText = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');

const longUserEvents: AgentMessage[] = [
  { kind: 'user', data: { content: longUserText } },
];

const imageOnlyUserEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: {
      content: '',
      attachments: [
        {
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    },
  },
];

const imageAndTextUserEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: {
      content: 'what is in this screenshot?',
      attachments: [
        {
          type: 'image',
          name: 'screen.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    },
  },
];

const completedTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'please fix it' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-process',
      session_id: 'session-completed-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am checking files first.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-final',
      session_id: 'session-completed-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Fixed and verified.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-1',
      session_id: 'session-completed-turn',
      duration_ms: 73_000,
      duration_api_ms: 0,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    },
  },
];

const completedTurnWithEmptyThinkingEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'ask me another question' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-empty-thinking-start',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-empty-thinking-process',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am preparing the next question.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-empty-thinking-tool',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'empty-thinking-tool', name: 'AskUserQuestion', input: {} }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'assistant-empty-thinking-tool-result',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'empty-thinking-tool', content: 'answered' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-empty-thinking-before-final',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-empty-thinking-final',
      session_id: 'session-empty-thinking-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the final answer.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'empty-thinking-result',
      session_id: 'session-empty-thinking-turn',
      duration_ms: 1200,
      duration_api_ms: 1200,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
];

const completedClaudeThinkingTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'say hello' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-assistant-final-thinking',
      session_id: 'session-claude-thinking-turn',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考过程' },
          { type: 'text', text: '最终总结结果' },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'claude-result-final-thinking',
      session_id: 'session-claude-thinking-turn',
      duration_ms: 100,
      duration_api_ms: 100,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
];

const historicalClaudeSplitTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '/statusline' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-history-thinking-1',
      session_id: 'session-claude-split-history',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '第一段内部思考' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-history-text-1',
      session_id: 'session-claude-split-history',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "I'll create a statusline-setup agent..." }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-history-tool-1',
      session_id: 'session-claude-split-history',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'claude-history-task-1', name: 'Task', input: { description: 'Configure statusline from PS1' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'claude-history-tool-result-1',
      session_id: 'session-claude-split-history',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'claude-history-task-1', content: 'agent completed' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-history-thinking-2',
      session_id: 'session-claude-split-history',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '第二段内部思考' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'claude-history-final-1',
      session_id: 'session-claude-split-history',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '最终总结结果' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const completedOpenCodeToolTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'inspect the project' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'opencode-assistant-tool',
      session_id: 'session-opencode-tool-turn',
      opencode_session_id: 'opencode-session-tool-turn',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'opencode-tool-1', name: 'bash', input: { command: 'pwd' } }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'tool_result',
    data: {
      type: 'user',
      uuid: 'opencode-tool-result',
      session_id: 'session-opencode-tool-turn',
      opencode_session_id: 'opencode-session-tool-turn',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'opencode-tool-1', content: 'D:\\project\\ai-code\\codeMUX' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'opencode-result',
      session_id: 'session-opencode-tool-turn',
      agent_session_id: 'opencode-session-tool-turn',
      duration_ms: 1200,
      duration_api_ms: 1200,
      num_turns: 1,
      result: 'ok',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
];

const historicalOpenCodeTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'inspect the project history' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'opencode-history-process-1',
      session_id: 'session-opencode-history-turn',
      opencode_session_id: 'opencode-session-history-turn',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '历史思考一' },
          { type: 'text', text: '历史过程一' },
          { type: 'tool_use', id: 'opencode-history-tool-1', name: 'Read', input: { file_path: 'package.json' } },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'opencode-history-result-1',
      session_id: 'session-opencode-history-turn',
      duration_ms: 400,
      duration_api_ms: 400,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'opencode-history-process-2',
      session_id: 'session-opencode-history-turn',
      opencode_session_id: 'opencode-session-history-turn',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '历史思考二' },
          { type: 'text', text: '历史过程二' },
          { type: 'tool_use', id: 'opencode-history-tool-2', name: 'Grep', input: { pattern: 'compact_ai_output' } },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'opencode-history-result-2',
      session_id: 'session-opencode-history-turn',
      duration_ms: 800,
      duration_api_ms: 800,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 2, output_tokens: 2 },
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'opencode-history-final',
      session_id: 'session-opencode-history-turn',
      opencode_session_id: 'opencode-session-history-turn',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '最终思考泄漏' },
          { type: 'text', text: '历史最终结果' },
        ],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'opencode-history-result-final',
      session_id: 'session-opencode-history-turn',
      duration_ms: 1_200,
      duration_api_ms: 1_200,
      num_turns: 1,
      result: '',
      usage: { input_tokens: 3, output_tokens: 3 },
    },
  },
];

const mixedFooterStatsEvents: AgentMessage[] = [
  { kind: 'user', data: { content: 'first request' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-history-final',
      session_id: 'session-footer-snapshot',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier answer.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-history-final',
      session_id: 'session-footer-snapshot',
      duration_ms: 1_000,
      duration_api_ms: 0,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
      },
    },
  },
  {
    kind: 'compact',
    data: {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 100 },
    },
  },
  { kind: 'user', data: { content: 'latest request' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-latest-final',
      session_id: 'session-footer-snapshot',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Latest answer.' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-latest-final',
      session_id: 'session-footer-snapshot',
      duration_ms: 2_000,
      duration_api_ms: 0,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 30,
        output_tokens: 40,
        cache_read_input_tokens: 10,
      },
    },
  },
];

const proposedPlanFinalEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '实现一个贪吃蛇程序' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-plan-final',
      session_id: 'session-plan-final',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `计划如下：

<proposed_plan>
# 贪吃蛇浏览器小游戏

## Summary
做一个可以直接运行的浏览器小游戏。

## Key Changes
- 实现游戏循环
</proposed_plan>`,
        }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'result',
    data: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'result-plan-final',
      session_id: 'session-plan-final',
      duration_ms: 1000,
      duration_api_ms: 1000,
      num_turns: 1,
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    },
  },
];

const proposedPlanNonFinalEvents: AgentMessage[] = [
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-plan-non-final',
      session_id: 'session-plan-non-final',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<proposed_plan>\n# 不应解析\n\n## Summary\n这是中间消息。\n</proposed_plan>',
        }],
      },
      parent_tool_use_id: null,
    },
  },
];

const navigationTurnEvents: AgentMessage[] = [
  { kind: 'user', data: { content: '修复子智能体展示\n需要保持 Codex 风格' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-1-process',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我先检查现有实现。' }],
      },
      parent_tool_use_id: null,
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-1-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '已按计划完成这次修复，核心路径都接上了：后端新增索引加载，从 Claude 的 subagents/agent-* metadata 建立映射。',
        }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '调整权限审批功能' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-2-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '权限审批入口已经调整完成，按钮状态、禁用态和审核动作都按新的交互逻辑联动。',
        }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '检查未提交变更' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-3-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '未提交变更已经检查完成，当前只包含导航相关文件。' }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '整理展示提示' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-4-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '展示提示已整理为更短的标题和更稳定的摘要。' }],
      },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: '补充测试覆盖' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-nav-5-final',
      session_id: 'session-nav',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '测试覆盖已经补充，包含悬停、聚焦和点击滚动行为。' }],
      },
      parent_tool_use_id: null,
    },
  },
];

const rewindHistoryEvents: AgentMessage[] = [
  {
    kind: 'user',
    data: {
      content: 'first instruction',
      locator: {
        providerMessageId: 'u-rewind-first',
        role: 'user',
        textFingerprint: 'first instruction',
        turnOrdinal: 1,
      },
    },
  },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-rewind-history-1',
      session_id: 'session-rewind-history',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first done' }] },
      parent_tool_use_id: null,
    },
  },
  { kind: 'user', data: { content: 'latest instruction' } },
  {
    kind: 'assistant',
    data: {
      type: 'assistant',
      uuid: 'assistant-rewind-history-2',
      session_id: 'session-rewind-history',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second done' }] },
      parent_tool_use_id: null,
    },
  },
];

function buildLargeToolHistoryEvents(turnCount: number): AgentMessage[] {
  const events: AgentMessage[] = [];

  for (let index = 0; index < turnCount; index += 1) {
    const toolUseId = `perf-tool-${index}`;
    events.push(
      { kind: 'user', data: { content: `性能测试消息 ${index}` } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-tool-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: 'Read',
              input: { file_path: `src/perf/${index}.tsx`, note: 'x'.repeat(80) },
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: `perf-tool-result-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `result ${index}\n${'result-line\n'.repeat(6)}`,
            }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: `perf-assistant-final-${index}`,
          session_id: 'session-perf-large',
          message: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: `### 结果 ${index}\n\n- 项目 A\n- 项目 B\n\n\`\`\`ts\nconst value${index} = ${index};\n\`\`\``,
            }],
          },
          parent_tool_use_id: null,
        },
      },
    );
  }

  return events;
}

const originalScrollTo = HTMLElement.prototype.scrollTo;
const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = [];

function triggerResize(target: Element, width: number, height = 720) {
  Object.defineProperty(target, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(target, 'clientHeight', { configurable: true, value: height });

  for (const observer of resizeObservers) {
    if (observer.target !== target) {
      continue;
    }

    observer.callback([
      {
        target,
        contentRect: {
          width,
          height,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: height,
          right: width,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry,
    ], {} as ResizeObserver);
  }
}

function Harness({
  sessionId,
  onSend = vi.fn(async () => {}),
}: {
  sessionId: string;
  onSend?: (content: any) => Promise<void>;
}) {
  const content = (
    <CodeMuxAssistantRuntimeProvider
      sessionId={sessionId}
      onSend={onSend}
      onCommand={vi.fn(async () => {})}
    >
      <CodeMuxThread sessionId={sessionId} />
    </CodeMuxAssistantRuntimeProvider>
  );
  const wrapped = <TooltipProvider>{content}</TooltipProvider>;
  return wrapped;
}

function openRewindMenu(trigger: Element) {
  // Radix dropdown menus open on pointerdown, which jsdom does not derive
  // from fireEvent.click.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe('CodeMuxAssistantRuntimeProvider', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    class MockResizeObserver {
      private callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        resizeObservers.push({ callback: this.callback, target });
      }

      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    useAgentStore.setState({
      events: {
        'session-1': sessionOneEvents,
        'session-2': sessionTwoEvents,
        'session-tool': failedToolEvents,
        'session-timestamp': timestampOnlyAssistantEvents,
        'session-reasoning': reasoningEvents,
        'session-grouped-tools': groupedToolEvents,
        'session-explore-group': exploreGroupEvents,
        'session-file-mutation-split': fileMutationSplitEvents,
        'session-directives': directiveUserEvents,
        'session-skill-directive': skillDirectiveUserEvents,
        'session-long-user': longUserEvents,
        'session-image-only': imageOnlyUserEvents,
        'session-image-text': imageAndTextUserEvents,
        'session-completed-turn': completedTurnEvents,
        'session-empty-thinking-turn': completedTurnWithEmptyThinkingEvents,
        'session-claude-thinking-turn': completedClaudeThinkingTurnEvents,
        'session-claude-split-history': historicalClaudeSplitTurnEvents,
        'session-opencode-tool-turn': completedOpenCodeToolTurnEvents,
        'session-opencode-history-turn': historicalOpenCodeTurnEvents,
        'session-footer-snapshot': mixedFooterStatsEvents,
        'session-plan-final': proposedPlanFinalEvents,
        'session-plan-non-final': proposedPlanNonFinalEvents,
        'session-nav': navigationTurnEvents,
        'session-rewind-history': rewindHistoryEvents,
      },
      eventTimestamps: {
        'session-1': [1, 2],
        'session-2': [3, 4],
        'session-tool': [5, 6],
        'session-timestamp': [Date.parse('2026-06-12T21:40:00+08:00')],
        'session-completed-turn': [
          Date.parse('2026-06-28T10:00:00Z'),
          Date.parse('2026-06-28T10:00:12Z'),
          Date.parse('2026-06-28T10:01:13Z'),
          Date.parse('2026-06-28T10:01:13Z'),
        ],
        'session-empty-thinking-turn': [1, 2, 3, 4, 5, 6, 7, 8],
        'session-claude-split-history': [1, 2, 3, 4, 5, 6, 7, 8],
        'session-opencode-tool-turn': [1, 2, 3, 4],
        'session-opencode-history-turn': [1, 2, 3, 4, 5, 6, 7],
        'session-footer-snapshot': [
          Date.parse('2026-06-29T10:00:00Z'),
          Date.parse('2026-06-29T10:00:05Z'),
          Date.parse('2026-06-29T10:00:05Z'),
          Date.parse('2026-06-29T10:01:00Z'),
          Date.parse('2026-06-29T10:02:00Z'),
          Date.parse('2026-06-29T10:02:08Z'),
          Date.parse('2026-06-29T10:02:08Z'),
        ],
      },
      tokenUsageBySession: {
        'session-footer-snapshot': {
          total: {
            totalTokens: 205,
            inputTokens: 80,
            cachedInputTokens: 120,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 205,
            inputTokens: 80,
            cachedInputTokens: 120,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_400,
          contextUsageSource: 'history_file',
          contextUsageFreshness: 'live_synced',
        },
      },
      isRunning: {},
      error: {},
      mcpRuntimeStatus: {},
      todos: {},
      streamingThinking: {},
      streamingText: {},
      forceStopped: {},
      streamingToolInputs: {},
      streamingToolMeta: {},
      streamingToolIndexMap: {},
      streamedToolUseIds: {},
      changedFiles: {},
      fileOriginals: {},
      acknowledgedFiles: {},
    });

    const threadSessions: Session[] = [
      'session-nav',
      'session-rewind-history',
      'session-image-rewind',
      'session-long-rewind',
    ].map((id) => ({
      id,
      title: id,
      agent_kind: id === 'session-nav' || id === 'session-image-rewind' ? 'claude_code' : 'codex',
      provider_id: null,
      model: null,
      mode: 'agent',
      project_id: null,
      created_at: '',
      updated_at: '',
    }));
    useSessionStore.setState({
      sessions: threadSessions,
      archivedSessions: [],
      activeSessionId: threadSessions[0]?.id ?? null,
      isLoading: false,
      error: null,
    });

    useSettingsStore.setState((state) => ({
      ...state,
      config: {
        providers: [],
        active_provider_id: null,
        agent_defaults: {
          default_agent_kind: 'claude_code',
        },
        agent_configs: {
          claude_code: {
            executable_mode: 'auto',
            resume_sessions: true,
          },
          codex: {
          },
          gemini_cli: {},
          opencode: {},
        },
        theme: 'System',
        compact_ai_output: false,
        default_open_target: 'file_explorer',
      },
    }));
    useSidePanelStore.getState().reset();
  });

  afterEach(() => {
    resizeObservers.length = 0;
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: originalScrollTo,
    });
    cleanup();
  });

  it('switches rendered messages when the active session changes', async () => {
    const view = render(<Harness sessionId="session-1" />);

    expect(await screen.findByText('session one assistant')).toBeTruthy();
    expect(screen.queryByText('session two assistant')).toBeNull();

    view.rerender(<Harness sessionId="session-2" />);

    expect(await screen.findByText('session two assistant')).toBeTruthy();
    expect(screen.queryByText('session one assistant')).toBeNull();
  });

  it('renders a session with no computed turns without changing its external-store snapshot', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Harness sessionId="session-without-turns" />)).not.toThrow();

    const messages = consoleError.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => (
      message.includes('getSnapshot should be cached')
      || message.includes('Maximum update depth exceeded')
    ))).toBe(false);

    consoleError.mockRestore();
  });

  it('renders failed tool calls as errors instead of leaving them running', () => {
    const { container } = render(<Harness sessionId="session-tool" />);

    expect(screen.getByRole('button', { name: /运行 1 个命令/ })).toBeTruthy();
    expect(screen.getByText('运行 1 个命令')).toBeTruthy();
    expect(screen.queryByText(/Error: Command failed with exit code 1/)).toBeNull();

    const trigger = container.querySelector('[data-slot="tool-group-trigger"]');
    if (trigger) fireEvent.click(trigger);

    expect(container.querySelector('.lucide-circle-x')).toBeTruthy();
    expect(container.querySelector('.lucide-loader')).toBeNull();
  });

  it('hides footer (copy button + timestamp) on intermediate or incomplete assistant messages', () => {
    render(<Harness sessionId="session-timestamp" />);

    expect(screen.getByText('timestamp only assistant')).toBeTruthy();
    // No result event means no isFinalAssistantMessage, so footer (timestamp) should not render.
    expect(screen.queryByText('21:40')).toBeNull();

    const row = screen.getByText('timestamp only assistant').closest('[data-message-row]');
    // 末行间距由 LastMessageIdContext 决定（mb-2），与 footer 是否渲染解耦。
    expect(row?.className).toContain('mb-2');
  });

  it('keeps final message footer hidden until the full message row is hovered', () => {
    render(<Harness sessionId="session-completed-turn" />);

    const footer = screen.getByText('耗时 1m 13s').closest('[data-message-footer]');
    const row = screen.getByText('Fixed and verified.').closest('[data-message-row]');

    expect(row?.className).toContain('group/message-row');
    expect(footer?.className).toContain('opacity-0');
    expect(footer?.className).toContain('group-hover/message-row:opacity-100');
  });

  it('does not show token usage on the latest footer after a context refresh', () => {
    render(<Harness sessionId="session-footer-snapshot" />);

    const earlierRow = screen.getByText('Earlier answer.').closest('[data-message-row]');
    const latestRow = screen.getByText('Latest answer.').closest('[data-message-row]');

    expect(earlierRow?.textContent).toContain('耗时 1s');
    expect(earlierRow?.textContent).not.toContain('token');
    expect(earlierRow?.textContent).not.toContain('缓存命中');

    expect(latestRow?.textContent).toContain('耗时 2s');
    expect(latestRow?.textContent).not.toContain('token');
    expect(latestRow?.textContent).not.toContain('缓存命中');
  });

  it('keeps historical footer visible before a compaction boundary', () => {
    render(<Harness sessionId="session-footer-snapshot" />);

    const earlierRow = screen.getByText('Earlier answer.').closest('[data-message-row]');

    expect(earlierRow?.textContent).toContain('耗时 1s');
    expect(earlierRow?.textContent).not.toContain('token');
  });

  it('binds final footer stats to trailing text after a same-turn tool-only replay', async () => {
    const sessionId = 'session-footer-rebound';
    const initialEvents: AgentMessage[] = [
      { kind: 'user', data: { content: 'check latest version' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-initial',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-initial',
          session_id: sessionId,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '1.0.0' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-footer-rebound',
          session_id: sessionId,
          duration_ms: 1_000,
          duration_api_ms: 0,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
          },
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        [sessionId]: initialEvents,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        [sessionId]: [1, 2, 3, 4],
      },
    }));

    const { container } = render(<Harness sessionId={sessionId} />);

    act(() => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          [sessionId]: [
            ...initialEvents,
            {
              kind: 'assistant',
              data: {
                type: 'assistant',
                uuid: 'assistant-tool-replay',
                session_id: sessionId,
                message: {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } }],
                },
                parent_tool_use_id: null,
              },
            },
            {
              kind: 'tool_result',
              data: {
                type: 'user',
                uuid: 'tool-result-replay',
                session_id: sessionId,
                message: {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'docs' }],
                },
                parent_tool_use_id: null,
              },
            },
            {
              kind: 'assistant',
              data: {
                type: 'assistant',
                uuid: 'assistant-final-text',
                session_id: sessionId,
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Latest version is 1.0.0.' }],
                },
                parent_tool_use_id: null,
              },
            },
          ],
        },
        eventTimestamps: {
          ...state.eventTimestamps,
          [sessionId]: [1, 2, 3, 4, 5, 6, 7],
        },
      }));
    });

    const finalMessageText = await screen.findByText('Latest version is 1.0.0.');
    const finalMessageRow = finalMessageText.closest('[data-message-row]');
    const toolGroupRow = container.querySelector('[data-slot="tool-group-root"]')?.closest('[data-message-row]');

    await waitFor(() => {
      expect(within(finalMessageRow as HTMLElement).getByText(/耗时 1s/)).toBeTruthy();
    });
    expect(within(finalMessageRow as HTMLElement).queryByText(/token/)).toBeNull();
    expect(toolGroupRow).toBeTruthy();
    expect(within(toolGroupRow as HTMLElement).queryByText(/耗时 1s/)).toBeNull();
    expect(within(toolGroupRow as HTMLElement).queryByText(/token/)).toBeNull();
  });

  it('renders the reasoning trigger like the native assistant-ui component', () => {
    const { container } = render(<Harness sessionId="session-reasoning" />);
    const trigger = container.querySelector('[data-slot="reasoning-trigger"]');
    const childSlots = Array.from(trigger?.children ?? []).map((element) =>
      element.getAttribute('data-slot'),
    );

    expect(childSlots).toEqual([
      'reasoning-trigger-icon',
      'reasoning-trigger-label',
      'reasoning-trigger-chevron',
    ]);
  });

  it('renders consecutive related tool calls inside one tool group', () => {
    const { container } = render(<Harness sessionId="session-grouped-tools" />);
    const toolGroup = container.querySelector('[data-slot="tool-group-root"]');

    expect(toolGroup).toBeTruthy();
    expect(toolGroup?.getAttribute('data-variant')).toBe('ghost');
    expect(container.querySelector('[data-slot="tool-group-trigger"]')).toBeTruthy();
  });

  it('keeps thinking separate from grouped tools between two text messages', () => {
    const { container } = render(<Harness sessionId="session-explore-group" />);

    expect(screen.getByText('先确认范围。')).toBeTruthy();
    expect(screen.getByText('架构已摸清。')).toBeTruthy();
    expect(screen.getByText('读取 1 次文件')).toBeTruthy();
    expect(screen.getByText('执行 1 次任务 · 匹配 1 次文件 · 运行 1 个命令')).toBeTruthy();
    expect(screen.queryByText('先探索下当前桌面端架构。')).toBeNull();
    expect(screen.queryByText('再核对任务入口。')).toBeNull();
    expect(screen.queryByText('架构已摸清。先给你我的分析，再确认几个关键决策点。')).toBeNull();
    expect(container.querySelectorAll('[data-slot="tool-group-root"]')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /思考/ })).toHaveLength(3);

    const exploreGroupTriggers = container.querySelectorAll('[data-slot="tool-group-trigger"]');
    fireEvent.click(exploreGroupTriggers[0]!);
    fireEvent.click(exploreGroupTriggers[1]!);

    const reasoningTriggers = screen.getAllByRole('button', { name: /思考/ });
    fireEvent.click(reasoningTriggers[0]!);
    fireEvent.click(reasoningTriggers[1]!);
    fireEvent.click(reasoningTriggers[2]!);

    expect(screen.getByText('先探索下当前桌面端架构。')).toBeTruthy();
    expect(screen.getByText('再核对任务入口。')).toBeTruthy();
    expect(screen.getByText('架构已摸清。先给你我的分析，再确认几个关键决策点。')).toBeTruthy();
    expect(screen.getByText('读取')).toBeTruthy();
    expect(screen.getByText('任务')).toBeTruthy();
    expect(screen.getByText('匹配文件')).toBeTruthy();
    expect(screen.getByText('终端')).toBeTruthy();
  });

  it('groups write tools with surrounding tools in one tool group', () => {
    const { container } = render(<Harness sessionId="session-file-mutation-split" />);

    const toolGroupTrigger = screen.getByRole('button', { name: /读取 1 次文件/ });
    expect(toolGroupTrigger.textContent).toContain('读取 1 次文件');
    expect(toolGroupTrigger.textContent).toContain('写入 1 次文件');
    expect(toolGroupTrigger.textContent).toContain('运行 1 个命令');
    expect(screen.getByText('文件已写好。')).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="tool-group-root"]')).toHaveLength(1);

    fireEvent.click(toolGroupTrigger);
    expect(screen.getByText('写入')).toBeTruthy();
  });

  it('keeps expanded tool details open across large-history running updates', async () => {
    const largeEvents = buildLargeToolHistoryEvents(200);
    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        'session-perf-large': largeEvents,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        'session-perf-large': largeEvents.map((_, index) => index + 1),
      },
      isRunning: {
        ...state.isRunning,
        'session-perf-large': false,
      },
    }));

    const { container } = render(<Harness sessionId="session-perf-large" />);

    const firstToolGroupTrigger = container.querySelector('[data-slot="tool-group-trigger"]');
    expect(firstToolGroupTrigger).toBeTruthy();
    fireEvent.click(firstToolGroupTrigger!);

    const firstTrigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
    expect(firstTrigger).toBeTruthy();
    fireEvent.click(firstTrigger!);
    expect(firstTrigger?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      useAgentStore.setState((state) => ({
        isRunning: {
          ...state.isRunning,
          'session-perf-large': true,
        },
        streamingThinking: {
          ...state.streamingThinking,
          'session-perf-large': '正在分析大量历史消息\n'.repeat(200),
        },
      }));
    });

    const triggerAfterRunning = container.querySelector('[data-slot="tool-fallback-trigger"]');
    const expandedAfterRunning = triggerAfterRunning?.getAttribute('aria-expanded');

    expect(expandedAfterRunning).toBe('true');

    await act(async () => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          'session-perf-large': [
            ...(state.events['session-perf-large'] ?? []),
            {
              kind: 'raw',
              data: {
                type: 'tool_progress',
                tool_use_id: 'perf-tool-0',
                elapsed_time_seconds: 2,
              },
            } as AgentMessage,
          ],
        },
      }));
    });

    const expandedAfterEvent = container.querySelector('[data-slot="tool-fallback-trigger"]')?.getAttribute('aria-expanded');

    expect(expandedAfterEvent).toBe('true');
  }, 30_000);

  it('does not resolve Claude-only slash commands in Codex sessions', () => {
    expect(resolveSlashCommand('/security-review', 'codex')).toBeNull();
    expect(resolveSlashCommand('/permissions', 'codex')).toBeNull();
    expect(resolveSlashCommand('/init', 'codex')).toMatchObject({
      command: expect.objectContaining({ name: 'init' }),
    });
    expect(resolveSlashCommand('/security-review', 'claude_code')?.command.name).toBe('security-review');
  });

  it('routes OpenCode session command chips to command handling instead of agent input', () => {
    const compact = resolveChipCommand('[$compact](compact)', 'opencode');

    expect(compact?.command.name).toBe('compact');
    expect(shouldRouteChipCommandToHandler(compact!.command, 'opencode')).toBe(true);
    expect(shouldRouteChipCommandToHandler(compact!.command, 'codex')).toBe(true);
  });

  it('builds image payloads from assistant-ui attachments', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'look at this' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'screenshot.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,abc123' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload).toEqual({
      text: 'look at this',
      attachments: [
        {
          type: 'image',
          name: 'screenshot.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
          size: undefined,
        },
      ],
      images: [
        {
          name: 'screenshot.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,abc123',
          size: undefined,
        },
      ],
    });
  });

  it('builds image payloads from multiple assistant-ui attachments', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'compare these' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'first.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,first' }],
        },
        {
          id: 'image-2',
          type: 'image',
          name: 'second.jpg',
          contentType: 'image/jpeg',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/jpeg;base64,second' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload).toEqual({
      text: 'compare these',
      attachments: [
        {
          type: 'image',
          name: 'first.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,first',
          size: undefined,
        },
        {
          type: 'image',
          name: 'second.jpg',
          mediaType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,second',
          size: undefined,
        },
      ],
      images: [
        {
          name: 'first.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,first',
          size: undefined,
        },
        {
          name: 'second.jpg',
          mediaType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,second',
          size: undefined,
        },
      ],
    });
  });

  it('assigns unique attachment ids for same-name image files', async () => {
    const adapter = new CodeMuxImageAttachmentAdapter();
    const first = await adapter.add({ file: new File(['first'], 'pasted.png', { type: 'image/png' }) });
    const second = await adapter.add({ file: new File(['second'], 'pasted.png', { type: 'image/png' }) });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe('pasted.png');
    expect(second.name).toBe('pasted.png');
  });

  it('renders historical user image attachments without requiring text', () => {
    const { container } = render(<Harness sessionId="session-image-only" />);

    const image = container.querySelector('img[alt="screen.png"]') as HTMLImageElement | null;
    expect(image).toBeTruthy();
    expect(image?.src).toBe('data:image/png;base64,abc123');
  });

  it('renders user image thumbnails above the text bubble and opens a preview', () => {
    const { container } = render(<Harness sessionId="session-image-text" />);

    const bubble = container.querySelector('[data-user-message-bubble="true"]');
    const thumbnail = container.querySelector('img[alt="screen.png"]') as HTMLImageElement | null;

    expect(thumbnail).toBeTruthy();
    expect(bubble?.contains(thumbnail)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '预览图片 screen.png' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByAltText('screen.png')).toHaveLength(2);
  });

  it('does not treat slash text as a command when an image is attached', () => {
    const payload = buildAgentInputPayloadFromAppendMessage({
      role: 'user',
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: '/init inspect this screenshot' }],
      attachments: [
        {
          id: 'image-1',
          type: 'image',
          name: 'init.png',
          contentType: 'image/png',
          status: { type: 'complete' },
          content: [{ type: 'image', image: 'data:image/png;base64,abc123' }],
        },
      ],
      metadata: { custom: {} },
      createdAt: new Date(),
    });

    expect(payload.images).toHaveLength(1);
    // resolveSlashCommand parses text regardless of attachments; image-gating lives in handleMessage
    expect(resolveSlashCommand(payload.text, 'codex')).toMatchObject({
      command: expect.objectContaining({ name: 'init' }),
      args: 'inspect this screenshot',
    });
  });

  it('renders command directives as chips while preserving legacy @file text', () => {
    const { container } = render(<Harness sessionId="session-directives" />);

    expect(screen.getByText('review').closest('[data-directive-type="command"]')).toBeTruthy();
    expect(container.querySelector('[data-directive-type="file"]')).toBeNull();
    expect(container.querySelector('[data-user-message-bubble]')?.textContent).toContain('@src/App.tsx');
    expect(container.querySelector('[data-user-message-bubble]')?.textContent).toContain('please check this');
  });

  it('renders skill-link directives with the visible command treatment in user messages', () => {
    const { container } = render(<Harness sessionId="session-skill-directive" />);
    const chip = container.querySelector('[data-user-message-bubble] [data-directive-type="command"]');

    expect(chip).toBeTruthy();
    expect((chip as HTMLElement).style.color).toBe('hsl(var(--codemux-directive-accent, 221 83% 46%))');
    expect(chip?.querySelector('.lucide-wand-sparkles')).toBeTruthy();
  });

  it('rewinds the latest user message into the composer', async () => {
    const rewindToMessage = vi.fn().mockResolvedValue({ text: '补充测试覆盖' });
    const requestComposerRestore = vi.fn();
    const onSend = vi.fn(async () => {});
    useAgentStore.setState({ rewindToMessage, requestComposerRestore } as any);

    render(<Harness sessionId="session-nav" onSend={onSend} />);

    const rewindButtons = screen.getAllByRole('button', { name: '回退到此消息' });
    expect(rewindButtons).toHaveLength(5);

    openRewindMenu(rewindButtons[rewindButtons.length - 1]);
    fireEvent.click(await screen.findByText('回退对话'));

    await waitFor(() => {
      expect(rewindToMessage).toHaveBeenCalledWith('session-nav', expect.any(Number), 'conversation');
      expect(requestComposerRestore).toHaveBeenCalledWith('session-nav', '补充测试覆盖');
    });
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('rewinds the latest user message text into the composer without inline edit', async () => {
    const rewindToMessage = vi.fn().mockResolvedValue({ text: 'describe this image' });
    const requestComposerRestore = vi.fn();
    const onSend = vi.fn(async () => {});
    useAgentStore.setState((state) => ({
      rewindToMessage,
      requestComposerRestore,
      events: {
        ...state.events,
        'session-image-rewind': [
          {
            kind: 'user',
            data: {
              content: 'describe this image',
              attachments: [{
                type: 'image',
                name: 'screen.png',
                mediaType: 'image/png',
                dataUrl: 'data:image/png;base64,abc123',
              }],
            },
          },
          {
            kind: 'assistant',
            data: {
              type: 'assistant',
              uuid: 'assistant-image-rewind-final',
              session_id: 'session-image-rewind',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'image described' }],
              },
              parent_tool_use_id: null,
            },
          },
        ],
      },
    } as any));

    render(<Harness sessionId="session-image-rewind" onSend={onSend} />);

    openRewindMenu(screen.getByRole('button', { name: '回退到此消息' }));
    fireEvent.click(await screen.findByText('回退对话'));

    await waitFor(() => {
      expect(rewindToMessage).toHaveBeenCalledWith('session-image-rewind', 0, 'conversation');
      expect(requestComposerRestore).toHaveBeenCalledWith('session-image-rewind', 'describe this image');
    });
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not read stale message indexes when rewind removes the tail of a long thread', async () => {
    const longSessionId = 'session-long-rewind';
    const longEvents = buildLargeToolHistoryEvents(120);
    const latestUserIndex = longEvents.findLastIndex((event) => event.kind === 'user');
    const onSend = vi.fn(async () => {});
    const requestComposerRestore = vi.fn();
    const rewindToMessage = vi.fn(async () => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          [longSessionId]: longEvents.slice(0, latestUserIndex),
        },
        eventTimestamps: {
          ...state.eventTimestamps,
          [longSessionId]: longEvents.slice(0, latestUserIndex).map((_, index) => index + 1),
        },
      }));
      return { text: `性能测试消息 ${latestUserIndex}` };
    });

    useAgentStore.setState((state) => ({
      rewindToMessage,
      requestComposerRestore,
      events: {
        ...state.events,
        [longSessionId]: longEvents,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        [longSessionId]: longEvents.map((_, index) => index + 1),
      },
    } as any));

    render(<Harness sessionId={longSessionId} onSend={onSend} />);

    const rewindButtons = screen.getAllByRole('button', { name: '回退到此消息' });
    openRewindMenu(rewindButtons[rewindButtons.length - 1]);
    fireEvent.click(await screen.findByText('回退对话'));

    await waitFor(() => {
      expect(rewindToMessage).toHaveBeenCalledWith(longSessionId, latestUserIndex, 'conversation');
      expect(requestComposerRestore).toHaveBeenCalledWith(longSessionId, `性能测试消息 ${latestUserIndex}`);
    });
    expect(screen.queryByText('结果 119')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  }, 30_000);

  it('offers in-place rewind on a historical user message with a strong locator', async () => {
    const onSend = vi.fn(async () => {});
    const rewindToMessage = vi.fn().mockResolvedValue({ text: 'first instruction' });
    const requestComposerRestore = vi.fn();
    useAgentStore.setState({ rewindToMessage, requestComposerRestore } as any);

    render(<Harness sessionId="session-rewind-history" onSend={onSend} />);

    const rewindButtons = screen.getAllByRole('button', { name: '回退到此消息' });
    expect(rewindButtons).toHaveLength(2);

    openRewindMenu(rewindButtons[0]);
    fireEvent.click(await screen.findByText('回退对话'));

    await waitFor(() => {
      expect(rewindToMessage).toHaveBeenCalledWith('session-rewind-history', 0, 'conversation');
      expect(requestComposerRestore).toHaveBeenCalledWith('session-rewind-history', 'first instruction');
    });
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers in-place rewind on historical user messages without a provider locator', () => {
    render(<Harness sessionId="session-nav" />);

    expect(screen.getAllByRole('button', { name: '回退到此消息' })).toHaveLength(5);
  });

  it('hides rewind entries in read-only sessions', () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-rewind-history' ? { ...session, is_read_only: true } : session,
      ),
    }));

    render(<Harness sessionId="session-rewind-history" />);

    expect(screen.queryByRole('button', { name: '回退到此消息' })).toBeNull();
  });

  it('offers file rewind modes only for agents that declare them', async () => {
    const rewindToMessage = vi.fn().mockResolvedValue(null);
    useAgentStore.setState({ rewindToMessage } as any);

    // session-rewind-history is primed as a Codex session (conversation-only).
    render(<Harness sessionId="session-rewind-history" />);

    openRewindMenu(screen.getAllByRole('button', { name: '回退到此消息' })[0]);

    expect(await screen.findByText('回退对话')).toBeTruthy();
    expect(screen.queryByText('回退文件')).toBeNull();
    expect(screen.queryByText('回退对话和文件')).toBeNull();
  });

  it('offers Claude file rewind modes without a provider locator', async () => {
    render(<Harness sessionId="session-nav" />);

    openRewindMenu(screen.getAllByRole('button', { name: '回退到此消息' })[0]);

    expect(await screen.findByText('回退对话')).toBeTruthy();
    expect(screen.getByText('回退文件')).toBeTruthy();
    expect(screen.getByText('回退对话和文件')).toBeTruthy();
  });

  it('renders streaming thinking content in a live reasoning panel', () => {
    const shortThinking = 'short thinking stays fully visible';
    const longThinking = `${'x'.repeat(21_000)}`;

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-short': true, 'session-stream-long': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-short': Date.now(), 'session-stream-long': Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        'session-stream-short': shortThinking,
        'session-stream-long': longThinking,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-short" />);

    // 流式思考仍显示在思考面板中，但默认保持折叠。
    expect(container.textContent).not.toContain(shortThinking);
    expect(container.querySelector('[data-testid="thread-viewport"] [data-streaming-reasoning="true"]')).not.toBeNull();
    const trigger = container.querySelector('[data-slot="reasoning-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain('思考');
    expect(container.textContent).not.toContain('tokens');

    cleanup();
    const longView = render(<Harness sessionId="session-stream-long" />);
    expect(longView.container.querySelector('[data-slot="reasoning-trigger"]')).not.toBeNull();
    expect(longView.container.textContent).toContain('思考');
    expect(longView.container.textContent).not.toContain(longThinking);
    expect(longView.container.textContent).not.toContain('tokens');
  });

  it('renders live thinking alongside answer text while pi streams the final reply', () => {
    const sessionId = 'session-pi-thinking-and-text';
    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, [sessionId]: true },
      queryStartTime: { ...state.queryStartTime, [sessionId]: Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        [sessionId]: '先理解 handleOneClickAction 的职责',
      },
      streamingText: {
        ...state.streamingText,
        [sessionId]: '你说得对！让我分析一下。',
      },
    }));

    const { container } = render(<Harness sessionId={sessionId} />);

    expect(container.querySelector('[data-streaming-reasoning="true"]')).not.toBeNull();
    expect(container.querySelector('[data-streaming-text="markdown"]')).not.toBeNull();
    expect(container.textContent).toContain('你说得对！让我分析一下。');
  });

  it('shows live thinking in the streaming panel while a tool group is active', () => {
    const sessionId = 'session-live-explore';
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '检查项目接入方式' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'live-explore-tool',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'live-explore-read', name: 'Read', input: { file_path: 'package.json' } }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: { ...state.events, [sessionId]: events },
      eventTimestamps: { ...state.eventTimestamps, [sessionId]: [1, 2] },
      isRunning: { ...state.isRunning, [sessionId]: true },
      queryStartTime: { ...state.queryStartTime, [sessionId]: Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        [sessionId]: '正在确认项目入口',
      },
    }));

    const { container } = render(<Harness sessionId={sessionId} />);
    const toolGroupRoot = container.querySelector('[data-slot="tool-group-root"]');

    expect(toolGroupRoot?.getAttribute('data-active')).toBe('true');
    expect(toolGroupRoot?.textContent).not.toContain('正在确认项目入口');
    expect(useAgentStore.getState().streamingThinking[sessionId]).toBe('正在确认项目入口');
  });

  it('keeps the normal bottom rhythm on the last message row while the turn is streaming', () => {
    const sessionId = 'session-running-last-row-rhythm';
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '继续改' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'running-rhythm-tool',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'running-rhythm-edit', name: 'Edit', input: { file_path: 'src/App.tsx' } }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: { ...state.events, [sessionId]: events },
      eventTimestamps: { ...state.eventTimestamps, [sessionId]: [1, 2] },
      isRunning: { ...state.isRunning, [sessionId]: true },
      queryStartTime: { ...state.queryStartTime, [sessionId]: Date.now() },
    }));

    render(<Harness sessionId={sessionId} />);

    // Running turn: the row above StreamingContent keeps the normal tail (mb-5),
    // not the composer-tightened mb-2.
    const row = screen.getByRole('button', { name: /编辑 1 次文件/ }).closest('[data-message-row]');
    expect(row?.className).toContain('mb-5');
    expect(row?.className).not.toContain('mb-2');
  });

  it('suppresses the stale live preview once thinking is committed across assistant messages', () => {
    const sessionId = 'session-live-explore-across-messages';
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '检查项目接入方式' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'thinking-message',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '当前思考消息来自另一个 assistant event' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'explore-tool-message',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'explore-read', name: 'Read', input: { file_path: 'package.json' } },
            ],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: { ...state.events, [sessionId]: events },
      eventTimestamps: { ...state.eventTimestamps, [sessionId]: [1, 2, 3] },
      isRunning: { ...state.isRunning, [sessionId]: true },
      queryStartTime: { ...state.queryStartTime, [sessionId]: Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        [sessionId]: '正在继续探索项目结构',
      },
    }));

    const { container } = render(<Harness sessionId={sessionId} />);
    const toolGroupRoot = container.querySelector('[data-slot="tool-group-root"]');

    expect(toolGroupRoot?.getAttribute('data-active')).toBe('true');
    expect(container.querySelector('[data-streaming-reasoning="true"]')).toBeNull();
  });

  it('does not render a stale live preview after an intervening answer segment', () => {
    const sessionId = 'session-live-explore-after-answer';
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '检查项目接入方式' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'explore-before-answer',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'explore-read-2', name: 'Read', input: { file_path: 'package.json' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'answer-before-thinking',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '先说明当前检查范围。' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'thinking-after-answer',
          session_id: sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '继续检查剩余入口' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: { ...state.events, [sessionId]: events },
      eventTimestamps: { ...state.eventTimestamps, [sessionId]: [1, 2, 3, 4] },
      isRunning: { ...state.isRunning, [sessionId]: true },
      queryStartTime: { ...state.queryStartTime, [sessionId]: Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        [sessionId]: '正在继续探索剩余入口',
      },
    }));

    const { container } = render(<Harness sessionId={sessionId} />);

    expect(container.querySelector('[data-streaming-reasoning="true"]')).toBeNull();
    expect(container.textContent).not.toContain('正在继续探索剩余入口');
  });

  it('keeps the live reasoning viewport pinned to the newest content', async () => {
    const thinking = 'streaming thinking that grows beyond the viewport';

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-follow': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-follow': Date.now() },
      streamingThinking: {
        ...state.streamingThinking,
        'session-stream-follow': thinking,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-follow" />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement;

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 0;

    act(() => {
      useAgentStore.setState((state) => ({
      streamingThinking: {
        ...state.streamingThinking,
        'session-stream-follow': `${thinking} plus a newly committed token`,
      },
      streamingVersion: {
        ...state.streamingVersion,
        'session-stream-follow': (state.streamingVersion['session-stream-follow'] ?? 0) + 1,
      },
      }));
    });

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(viewport.scrollTop).toBe(1000);
  });

  it('scrolls to the bottom after asynchronously hydrated history commits', async () => {
    const historySessionId = 'session-history-hydration';
    const { container } = render(<Harness sessionId={historySessionId} />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement;

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 0;

    act(() => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          [historySessionId]: [
            { kind: 'user', data: { content: '历史用户消息' } },
            {
              kind: 'assistant',
              data: {
                type: 'assistant',
                uuid: 'history-hydration-assistant',
                session_id: historySessionId,
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: '历史助手消息' }],
                },
                parent_tool_use_id: null,
              },
            },
          ],
        },
        eventTimestamps: {
          ...state.eventTimestamps,
          [historySessionId]: [1, 2],
        },
      }));
    });

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
    });

    expect(viewport.scrollTop).toBe(1000);
  });

  it('scrolls a new message to the bottom after scrolling up in a historical conversation', async () => {
    const historySessionId = 'session-1';
    const { container } = render(<Harness sessionId={historySessionId} />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement;
    let scrollHeight = 1000;

    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 0;

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    });

    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    scrollHeight = 1400;

    act(() => {
      useAgentStore.setState((state) => ({
        events: {
          ...state.events,
          [historySessionId]: [
            ...(state.events[historySessionId] ?? []),
            { kind: 'user', data: { content: '发送到历史会话的新消息' } },
          ],
        },
        eventTimestamps: {
          ...state.eventTimestamps,
          [historySessionId]: [...(state.eventTimestamps[historySessionId] ?? []), 3],
        },
      }));
    });

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    });

    expect(viewport.scrollTop).toBe(1400);
  });

  it('shows the scroll-to-bottom button inside the sticky thread footer when scrolled up', async () => {
    const { container } = render(<Harness sessionId="session-scroll-button" />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement;
    const button = container.querySelector('[data-testid="scroll-to-bottom"]') as HTMLButtonElement;

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 256 });
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.closest('[data-testid="thread-viewport-footer"]')).not.toBeNull();
    expect(button.className).toContain('-top-12');

    // 回归:点击后必须立即钉底。Chromium 会把点击手势里发起的
    // viewport.scrollTo({behavior:'smooth'}) 立刻取消(表现为点了没反应),
    // 所以这里把 scrollTo 打桩成 no-op,钉底必须依然靠 scrollTop 赋值生效。
    const scrollSpy = vi
      .spyOn(viewport, 'scrollTo')
      .mockImplementation(() => undefined);
    button.click();

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(1000);
    await waitFor(() => expect(button.disabled).toBe(true));
    scrollSpy.mockRestore();
  });

  it('renders live streaming text with markdown parsing using Streamdown', () => {
    const streamingText = '**streaming bold**\n\n```ts\nconst value = 1;\n```';

    useAgentStore.setState((state) => ({
      isRunning: { ...state.isRunning, 'session-stream-text': true },
      queryStartTime: { ...state.queryStartTime, 'session-stream-text': Date.now() },
      streamingText: {
        ...state.streamingText,
        'session-stream-text': streamingText,
      },
    }));

    const { container } = render(<Harness sessionId="session-stream-text" />);

    // Now uses Streamdown for real-time markdown rendering
    expect(container.querySelector('[data-streaming-text="markdown"]')).toBeTruthy();
    expect(container.querySelector('.aui-md')).toBeTruthy();
  });

  it('collapses very long user messages behind a show-more control', () => {
    const { container } = render(<Harness sessionId="session-long-user" />);

    expect(screen.getByText(/line 80/)).toBeTruthy();
    const userMessageRoot = container.querySelector('[data-message-id="user-0"]');
    const bubbleColumn = userMessageRoot?.querySelector('[data-user-message-column="true"]');
    const bubble = userMessageRoot?.querySelector('[data-user-message-bubble="true"]');

    expect(bubbleColumn?.className).toContain('max-w-10/12');
    expect(bubbleColumn?.className).not.toContain('max-w-[78%]');
    expect(bubble?.className).toContain('max-h-80');
    expect(bubble?.className).toContain('overflow-hidden');
    expect(bubble?.className).not.toContain('overflow-y-auto');

    const showMore = screen.getByRole('button', { name: '查看更多' });
    fireEvent.click(showMore);

    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse.querySelector('.lucide-chevron-up')).toBeTruthy();
    expect(bubble?.className).not.toContain('max-h-80');
  });

  it('collapses completed assistant process messages when compact output is enabled', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-completed-turn" />);

    expect(screen.getByText('Fixed and verified.')).toBeTruthy();
    expect(screen.queryByText('I am checking files first.')).toBeNull();

    const toggle = screen.getByRole('button', { name: /灞曞紑AI杩囩▼|展开AI过程/ });
    expect(toggle.textContent).toContain('已处理');
    expect(toggle.textContent).toContain('1m 13s');

    fireEvent.click(toggle);

    expect(screen.getByText('I am checking files first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /鏀惰捣AI杩囩▼|收起AI过程/ })).toBeTruthy();
  });

  it('keeps the latest turn expanded with a live wait row while background subagents run', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));
    useSubagentStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'session-completed-turn': {
          order: ['toolu-sub-1'],
          descriptors: {
            'toolu-sub-1': {
              subagentId: 'toolu-sub-1',
              provider: 'claude',
              title: 'Explore',
              description: null,
              status: 'running',
              toolCallId: 'toolu-sub-1',
              subtitle: null,
              updatedAt: 1,
            },
          },
          events: {},
          seenEventIds: {},
        },
      },
    }));

    try {
      render(<Harness sessionId="session-completed-turn" />);

      // The async flow is still running: the wait row is visible with a live
      // timer, and the turn being waited on is not collapsed as finished.
      expect(screen.getByTestId('subagent-running-row')).toBeTruthy();
      // The shimmer overlay duplicates the timer text, hence getAllByText.
      expect(screen.getAllByText(/子智能体仍在后台运行 ×1/).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /展开AI过程/ })).toBeNull();
      expect(screen.getByText('I am checking files first.')).toBeTruthy();
      expect(screen.getByText('Fixed and verified.')).toBeTruthy();
    } finally {
      useSubagentStore.setState((state) => {
        const { 'session-completed-turn': _removed, ...rest } = state.sessions;
        return { sessions: rest };
      });
    }
  });

  it('keeps the flow alive between the last subagent terminal and the summary settle', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));
    useSubagentStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'session-completed-turn': {
          order: ['toolu-sub-1'],
          descriptors: {
            'toolu-sub-1': {
              subagentId: 'toolu-sub-1',
              provider: 'claude',
              title: 'Explore',
              description: null,
              status: 'completed',
              toolCallId: 'toolu-sub-1',
              subtitle: null,
              updatedAt: 1,
            },
          },
          events: {},
          seenEventIds: {},
        },
      },
      continuationPending: { 'session-completed-turn': true },
    }));

    try {
      render(<Harness sessionId="session-completed-turn" />);

      // No child is running anymore, but the parent's summary turn has not
      // settled: keep the spinner row and the expanded turn.
      expect(screen.getByTestId('subagent-running-row')).toBeTruthy();
      expect(screen.getAllByText(/子智能体已完成，主智能体继续输出中/).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /展开AI过程/ })).toBeNull();
      expect(screen.getByText('I am checking files first.')).toBeTruthy();
    } finally {
      useSubagentStore.setState((state) => {
        const { 'session-completed-turn': _removed, ...rest } = state.sessions;
        return { sessions: rest, continuationPending: {} };
      });
    }
  });

  it('keeps the compact process toggle when the turn starts with empty thinking', () => {    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-empty-thinking-turn" />);

    expect(screen.getByText('Here is the final answer.')).toBeTruthy();
    expect(screen.queryByText('I am preparing the next question.')).toBeNull();
    const toggle = screen.getByRole('button', { name: /展开AI过程/ });
    expect(toggle.textContent).toContain('已处理');

    fireEvent.click(toggle);

    expect(screen.getByText('I am preparing the next question.')).toBeTruthy();
  });

  it('puts completed Claude thinking under the compact process toggle', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-claude-thinking-turn" />);

    expect(screen.getByText('最终总结结果')).toBeTruthy();
    expect(screen.queryByText('内部思考过程')).toBeNull();
    expect(screen.getByRole('button', { name: /展开AI过程/ })).toBeTruthy();

    const textRow = screen.getByText('最终总结结果').closest('[data-message-row]');
    const toggleRow = screen.getByRole('button', { name: /展开AI过程/ }).closest('[data-message-row]');
    expect(textRow?.querySelector('[data-message-footer]')).toBeTruthy();
    expect(textRow).toBe(toggleRow);
    expect(screen.getAllByText(/耗时/)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /展开AI过程/ }));

    const reasoningTrigger = screen.getByRole('button', { name: /思考/ });
    expect(reasoningTrigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(reasoningTrigger);

    expect(screen.getByText('内部思考过程')).toBeTruthy();
  });

  it('collapses split Claude history output without a persisted result event', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-claude-split-history" />);

    expect(screen.getByText('最终总结结果')).toBeTruthy();
    expect(screen.queryByText('第一段内部思考')).toBeNull();
    expect(screen.queryByText("I'll create a statusline-setup agent...")).toBeNull();
    expect(screen.queryByText('第二段内部思考')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /展开AI过程/ }));

    expect(screen.getByText("I'll create a statusline-setup agent...")).toBeTruthy();
    expect(screen.getByRole('button', { name: /执行 1 次任务/ })).toBeTruthy();

    const firstReasoningTrigger = screen.getAllByRole('button', { name: /思考/ })[0]!;
    expect(firstReasoningTrigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(firstReasoningTrigger);
    expect(screen.getByText('第一段内部思考')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /执行 1 次任务/ }));
    const reasoningTriggers = screen.getAllByRole('button', { name: /思考/ });
    expect(reasoningTriggers).toHaveLength(2);
    expect(reasoningTriggers[1]?.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(reasoningTriggers[1]!);
    expect(screen.getByText('第二段内部思考')).toBeTruthy();
  });

  it('shows completed OpenCode tool-only turns directly instead of collapsing them', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-opencode-tool-turn" />);

    expect(screen.queryByRole('button', { name: /展开AI过程/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /运行 1 个命令/ }));
    expect(screen.getByText('终端')).toBeTruthy();
  });

  it('collapses OpenCode historical process messages across intermediate results', () => {
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    const { container } = render(<Harness sessionId="session-opencode-history-turn" />);

    expect(screen.getByText('历史最终结果')).toBeTruthy();
    expect(screen.queryByText('历史过程一')).toBeNull();
    expect(screen.queryByText('历史过程二')).toBeNull();
    expect(screen.queryByText('最终思考泄漏')).toBeNull();

    const toggle = screen.getByRole('button', { name: /展开AI过程/ });
    expect(toggle.textContent).toContain('已处理');

    fireEvent.click(toggle);

    expect(screen.getByText('历史过程一')).toBeTruthy();
    expect(screen.getByText('历史过程二')).toBeTruthy();
    expect(screen.queryByText('最终思考泄漏')).toBeNull();

    const exploreTriggers = container.querySelectorAll('[data-slot="tool-group-trigger"]');
    fireEvent.click(exploreTriggers[exploreTriggers.length - 1]!);
    const reasoningTriggers = screen.getAllByRole('button', { name: /思考/ });
    fireEvent.click(reasoningTriggers[reasoningTriggers.length - 1]!);

    expect(screen.getByText('最终思考泄漏')).toBeTruthy();
    const finalRow = screen.getByText('历史最终结果').closest('[data-message-row]');
    expect(finalRow?.querySelector('[data-slot="reasoning-trigger"]')).toBeTruthy();
  });

  it('keeps the session summary card outside the compact process group', () => {
    const events: AgentMessage[] = [
      { kind: 'user', data: { content: '将About页面的Ztwo改为Ztwo123' } },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          session_id: 'session-summary-outside-process',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'edit', input: { filePath: 'index.html' } }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-summary-outside-process',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Edit applied successfully.' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'session_summary',
        data: {
          type: 'system',
          subtype: 'session_summary',
          diffs: [{ file: 'index.html', additions: 1, deletions: 1, status: 'modified' }],
          uuid: 'summary-1',
          session_id: 'session-summary-outside-process',
        },
      },
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-final-1',
          session_id: 'session-summary-outside-process',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '改完 About 文案就可以收尾了。' },
              { type: 'text', text: '已完成。About 页面中的 Ztwo 已改为 Ztwo123。' },
            ],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'result',
        data: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          uuid: 'result-1',
          session_id: 'session-summary-outside-process',
          duration_ms: 6000,
          duration_api_ms: 10,
          num_turns: 1,
          result: '',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
          },
        },
      },
    ];

    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        'session-summary-outside-process': events,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        'session-summary-outside-process': events.map((_, index) => index + 1),
      },
    }));
    useSettingsStore.setState((state) => ({
      config: state.config ? { ...state.config, compact_ai_output: true } : state.config,
    }));

    render(<Harness sessionId="session-summary-outside-process" />);

    expect(screen.getByText('已完成。About 页面中的 Ztwo 已改为 Ztwo123。')).toBeTruthy();
    expect(screen.getByText('1 个文件已更改')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();

    const toggle = screen.getByRole('button', { name: /展开AI过程/ });
    const summaryRow = screen.getByText('1 个文件已更改').closest('[data-message-row]');
    const textRow = screen.getByText('已完成。About 页面中的 Ztwo 已改为 Ztwo123。').closest('[data-message-row]');
    expect(summaryRow).toBe(textRow);
    expect(toggle.closest('[data-message-row]')).not.toBe(summaryRow);

    fireEvent.click(toggle);

    const executedTrigger = screen.getByRole('button', { name: /编辑 1 次文件/ });
    fireEvent.click(executedTrigger);

    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getByText('1 个文件已更改').closest('[data-message-row]')).toBe(textRow);
  });

  it('renders proposed_plan in final assistant messages as a plan preview card', () => {
    render(<Harness sessionId="session-plan-final" />);

    expect(screen.getByText('计划如下：')).toBeTruthy();
    expect(screen.getByText('贪吃蛇浏览器小游戏')).toBeTruthy();
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText(/做一个可以直接运行的浏览器小游戏/)).toBeTruthy();
    expect(screen.getByTestId('proposed-plan-preview').className).toContain('max-h-24');
    expect(document.body.textContent).not.toContain('<proposed_plan>');

    fireEvent.click(screen.getByRole('button', { name: '展开计划 贪吃蛇浏览器小游戏' }));

    expect(useSidePanelStore.getState()).toMatchObject({
      isOpen: true,
      tabs: [
        expect.objectContaining({
          kind: 'plan',
          planFilePath: '计划.md',
          planContent: expect.stringContaining('# 贪吃蛇浏览器小游戏'),
        }),
      ],
    });
  });

  it('copies proposed_plan markdown from the plan preview card', async () => {
    render(<Harness sessionId="session-plan-final" />);

    fireEvent.click(screen.getByRole('button', { name: '复制计划 贪吃蛇浏览器小游戏' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('# 贪吃蛇浏览器小游戏'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('## Key Changes'));
    });
  });

  it('keeps proposed_plan approval on the normal thread footer layout', () => {
    const { container } = render(<Harness sessionId="session-plan-final" />);

    const footer = container.querySelector('[data-testid="thread-viewport-footer"]');

    expect(footer?.className).toContain('mt-auto');
    expect(container.querySelector('[data-testid="thread-messages-stack"]')).toBeNull();
  });

  it('does not parse proposed_plan in non-final assistant messages', () => {
    render(<Harness sessionId="session-plan-non-final" />);

    expect(document.body.textContent).toContain('<proposed_plan>');
    expect(screen.queryByRole('button', { name: /展开计划/ })).toBeNull();
  });

  it('renders Codex-style message navigation with user title and latest assistant summary', () => {
    render(<Harness sessionId="session-nav" />);

    const nav = screen.getByTestId('message-nav');
    expect(nav.className).toContain('left-');

    const firstNavButton = screen.getByRole('button', { name: /跳转到消息 修复子智能体展示/ });
    fireEvent.mouseEnter(firstNavButton);

    expect(within(nav).getByText('修复子智能体展示')).toBeTruthy();
    expect(within(nav).getByText(/已按计划完成这次修复，核心路径都接上了/)).toBeTruthy();
    expect(within(nav).queryByText('我先检查现有实现。')).toBeNull();
  });

  it('keeps long navigation titles on one line and lets the preview truncate them by width', () => {
    const title = '我这次项目重构为Electron桌面应用的完整实施计划';

    expect(extractUserNavTitle(title)).toBe(title);

    render(<Harness sessionId="session-nav" />);
    const nav = screen.getByTestId('message-nav');
    const firstNavButton = screen.getByRole('button', { name: /跳转到消息 修复子智能体展示/ });
    fireEvent.mouseEnter(firstNavButton);

    const titleElement = within(nav).getByText('修复子智能体展示');
    expect(titleElement.className).toContain('truncate');
    expect(titleElement.className).toContain('whitespace-nowrap');
    expect(titleElement.className).toContain('w-full');
  });

  it('hides the message navigation when the thread viewport becomes narrow', async () => {
    const { container } = render(<Harness sessionId="session-nav" />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement | null;

    expect(viewport).toBeTruthy();
    expect(screen.getByTestId('message-nav')).toBeTruthy();

    triggerResize(viewport!, 720);

    await waitFor(() => {
      expect(screen.queryByTestId('message-nav')).toBeNull();
    });

    const shell = screen.getByTestId('thread-content-shell');
    expect(shell.className).toContain('px-5');
    expect(shell.className).not.toContain('px-20');
  });

  it('ignores resize updates while the document is hidden and re-measures on restore', async () => {
    const { container } = render(<Harness sessionId="session-nav" />);
    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLElement | null;

    expect(viewport).toBeTruthy();
    expect(screen.getByTestId('message-nav')).toBeTruthy();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    triggerResize(viewport!, 720);
    expect(screen.getByTestId('message-nav')).toBeTruthy();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(screen.queryByTestId('message-nav')).toBeNull();
    });

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('keeps the message navigation floating without shifting thread content off center', () => {
    render(<Harness sessionId="session-nav" />);

    const shell = screen.getByTestId('thread-content-shell');
    expect(shell.className).toContain('px-20');
    expect(shell.className).not.toContain('pl-14');
    expect(shell.className).not.toContain('pr-4');
    expect((shell as HTMLElement).style.maxWidth).toBe('var(--content-width, 52rem)');
  });

  it('shows the message navigation popover on keyboard focus and scrolls to the selected turn', () => {
    render(<Harness sessionId="session-nav" />);

    const nav = screen.getByTestId('message-nav');
    const secondNavButton = screen.getByRole('button', { name: /跳转到消息 调整权限审批功能/ });
    fireEvent.focus(secondNavButton);

    expect(within(nav).getByText('调整权限审批功能')).toBeTruthy();
    expect(within(nav).getByText(/权限审批入口已经调整完成/)).toBeTruthy();

    fireEvent.click(secondNavButton);

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });

  it('keeps message navigation compact and animates marker widths as a mountain around hover', () => {
    render(<Harness sessionId="session-nav" />);

    const navButtons = screen.getAllByRole('button', { name: /跳转到消息/ });
    expect(navButtons).toHaveLength(5);

    const markerTops = navButtons.map((button) =>
      Number.parseFloat((button.parentElement as HTMLElement).style.top),
    );
    const markerGaps = markerTops.slice(1).map((top, index) => top - markerTops[index]);
    expect(Math.max(...markerGaps)).toBeLessThanOrEqual(8);

    fireEvent.mouseEnter(navButtons[2]);

    const widths = navButtons.map((button) =>
      Number.parseFloat(((button as HTMLElement).firstElementChild as HTMLElement).style.width),
    );
    expect(widths).toEqual([14, 22, 34, 22, 14]);
  });

  it('keeps every message navigation item accessible for long histories', () => {
    const manyTurns: AgentMessage[] = Array.from({ length: 30 }, (_, index) => ({
      kind: 'user',
      data: { content: `历史消息 ${index + 1}` },
    }));
    useAgentStore.setState((state) => ({
      events: {
        ...state.events,
        'session-many-nav': manyTurns,
      },
      eventTimestamps: {
        ...state.eventTimestamps,
        'session-many-nav': manyTurns.map((_, index) => index + 1),
      },
    }));

    render(<Harness sessionId="session-many-nav" />);

    const navButtons = screen.getAllByRole('button', { name: /跳转到消息/ });
    expect(navButtons).toHaveLength(30);
    expect(screen.getByRole('button', { name: '跳转到消息 历史消息 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '跳转到消息 历史消息 30' })).toBeTruthy();
  });

  it('uses a larger hit target than the visible message navigation marker', () => {
    render(<Harness sessionId="session-nav" />);

    const firstNavButton = screen.getAllByRole('button', { name: /跳转到消息/ })[0] as HTMLElement;
    const marker = firstNavButton.firstElementChild as HTMLElement;

    expect(firstNavButton.className).toContain('h-4');
    expect(firstNavButton.className).toContain('w-12');
    expect(marker.style.height).toBe('2px');
  });

  it('returns tool durations from event-reported data only', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-repeat',
          session_id: 'session-tool-repeat',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-repeat', name: 'mcp__context7__query_docs', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-first',
          session_id: 'session-tool-repeat',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-repeat', content: 'first' }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'raw',
        data: {
          type: 'tool_progress',
          tool_use_id: 'call-repeat',
          elapsed_time_seconds: 0.25,
        },
      },
    ];

    // Now uses event-reported durations only
    expect(buildToolDurationMap(events)).toEqual({
      'call-repeat': 250,
    });
  });

  it('returns empty durations when no tool_progress or task_notification events', () => {
    const events: AgentMessage[] = [
      {
        kind: 'assistant',
        data: {
          type: 'assistant',
          uuid: 'assistant-tool-no-progress',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
          parent_tool_use_id: null,
        },
      },
      {
        kind: 'tool_result',
        data: {
          type: 'user',
          uuid: 'tool-result-1',
          session_id: 'session-tool-no-progress',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }],
          },
          parent_tool_use_id: null,
        },
      },
    ];

    // No event-reported durations, so returns empty
    expect(buildToolDurationMap(events)).toEqual({});
  });
});
