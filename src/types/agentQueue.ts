import type { AgentInputPayload } from './agentInput';
import type { ReasoningEffort } from './session';

export interface QueuedAgentQuery {
  id: string;
  prompt: string;
  cwd: string;
  reasoningEffort?: ReasoningEffort;
  displayContent?: string;
  inputPayload?: AgentInputPayload;
  modelForVision?: string;
  createdAt: number;
}
