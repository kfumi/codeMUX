import type { AgentKind } from './session';

export type AgentCapability =
  | 'supports_resume'
  | 'supports_tools'
  | 'supports_file_snapshots'
  | 'supports_cost'
  | 'supports_ask_user_question';

export interface AgentDefinition {
  kind: AgentKind;
  label: string;
  description: string;
  icon: 'claude' | 'codex' | 'gemini' | 'opencode';
  capabilities: AgentCapability[];
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: '默认编码智能体，当前运行时支持最完整。',
    icon: 'claude',
    capabilities: [
      'supports_resume',
      'supports_tools',
      'supports_file_snapshots',
      'supports_cost',
      'supports_ask_user_question',
    ],
  },
  {
    kind: 'codex',
    label: 'Codex',
    description: '基于 OpenAI Codex SDK 的编码智能体。',
    icon: 'codex',
    capabilities: ['supports_tools', 'supports_file_snapshots', 'supports_cost', 'supports_ask_user_question'],
  },
  {
    kind: 'gemini_cli',
    label: 'Gemini CLI',
    description: '为后续扩展预留的 Gemini 接入入口。',
    icon: 'gemini',
    capabilities: [],
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: '基于 OpenCode SDK 的可恢复编码 Agent。',
    icon: 'opencode',
    capabilities: [
      'supports_resume',
      'supports_tools',
    ],
  },
];

export function getAgentDefinition(kind: AgentKind): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((entry) => entry.kind === kind);
}

export function getDefaultAgentKind(): AgentKind {
  return 'claude_code';
}
