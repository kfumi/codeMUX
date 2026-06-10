import type { AgentKind } from './session';

export type AgentCapability =
  | 'supports_resume'
  | 'supports_tools'
  | 'supports_file_snapshots'
  | 'supports_cost'
  | 'supports_context_window'
  | 'supports_mcp'
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
    description: 'Default coding agent with the most complete runtime support.',
    icon: 'claude',
    capabilities: [
      'supports_resume',
      'supports_tools',
      'supports_file_snapshots',
      'supports_cost',
      'supports_context_window',
      'supports_mcp',
      'supports_ask_user_question',
    ],
  },
  {
    kind: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex SDK backed coding agent.',
    icon: 'codex',
    capabilities: ['supports_tools', 'supports_file_snapshots'],
  },
  {
    kind: 'gemini_cli',
    label: 'Gemini CLI',
    description: 'Future coding agent entry kept in the registry for menu stability.',
    icon: 'gemini',
    capabilities: [],
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: 'Future coding agent entry kept in the registry for menu stability.',
    icon: 'opencode',
    capabilities: [],
  },
];

export function getAgentDefinition(kind: AgentKind): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((entry) => entry.kind === kind);
}

export function getDefaultAgentKind(): AgentKind {
  return 'claude_code';
}
