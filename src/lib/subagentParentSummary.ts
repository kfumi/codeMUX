import type { CodeMuxAssistantMessage } from '@/components/agent/assistant-ui/convertAgentEvents';
import { extractAgentToolResultText } from '@/components/agent/assistant-ui/convertAgentEvents';
import type { AgentMessage } from '@/stores/agentStore';

export function subagentTimelineHasAssistantText(messages: CodeMuxAssistantMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant'
      && message.content.some((part) => part.type === 'text' && part.text.trim().length > 0),
  );
}

/**
 * When live capture dropped the subagent's final summary, the parent Task tool
 * result often still carries it. Surface that text in the read-only subagent panel.
 */
export function supplementSubagentMessagesWithParentSummary(
  messages: CodeMuxAssistantMessage[],
  parentEvents: AgentMessage[],
  toolCallId: string,
  options?: { isRunning?: boolean },
): CodeMuxAssistantMessage[] {
  if (options?.isRunning || toolCallId.trim().length === 0) {
    return messages;
  }
  if (subagentTimelineHasAssistantText(messages)) {
    return messages;
  }

  const summary = extractAgentToolResultText(parentEvents, toolCallId);
  if (!summary?.trim()) {
    return messages;
  }

  return [
    ...messages,
    {
      id: `parent-task-result-${toolCallId}`,
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      metadata: {
        sourceEventIndex: -1,
        sourceEventIndices: [],
        sourceKind: 'assistant',
        isFinalAssistantMessage: true,
      },
    },
  ];
}
