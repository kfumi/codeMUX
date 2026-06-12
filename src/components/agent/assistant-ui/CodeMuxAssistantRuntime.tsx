import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { useCallback, useMemo, type ReactNode } from 'react';

import type { SlashCommand } from '../../../lib/slashCommands';
import { findCommand } from '../../../lib/slashCommands';
import { useAgentStore } from '../../../stores/agentStore';
import type { AgentMessage } from '../../../stores/agentStore';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
  type CodeMuxAssistantPart,
} from './convertAgentEvents';

type CodeMuxAssistantRuntimeProviderProps = {
  sessionId: string;
  onSend: (content: string) => Promise<void>;
  onCommand: (command: SlashCommand, args: string) => void | Promise<void>;
  children: ReactNode;
};

type ThreadMessagePartLike = Exclude<ThreadMessageLike['content'], string>[number];

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TIMESTAMPS: number[] = [];

export function CodeMuxAssistantRuntimeProvider({
  sessionId,
  onSend,
  onCommand,
  children,
}: CodeMuxAssistantRuntimeProviderProps) {
  return (
    <SessionScopedAssistantRuntime
      sessionId={sessionId}
      onSend={onSend}
      onCommand={onCommand}
    >
      {children}
    </SessionScopedAssistantRuntime>
  );
}

function SessionScopedAssistantRuntime({
  sessionId,
  onSend,
  onCommand,
  children,
}: CodeMuxAssistantRuntimeProviderProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);

  const messages = useMemo(
    () => convertAgentEventsToAssistantMessages(events),
    [events],
  );

  const handleNew = useCallback(
    async (message: AppendMessage) => {
      const content = getTextContent(message);

      if (content.length === 0) {
        return;
      }

      const slashCommand = parseSlashCommand(content);
      if (slashCommand) {
        const command = findCommand(slashCommand.name);

        if (command) {
          await onCommand(command, slashCommand.args);
          return;
        }
      }

      await onSend(content);
    },
    [onCommand, onSend],
  );

  const runtime = useExternalStoreRuntime<CodeMuxAssistantMessage>({
    messages,
    isRunning,
    convertMessage: (message) => convertCodeMuxMessageToThreadMessageLike(message, eventTimestamps),
    onNew: handleNew,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function convertCodeMuxMessageToThreadMessageLike(
  message: CodeMuxAssistantMessage,
  eventTimestamps: number[],
): ThreadMessageLike {
  const sourceTimestamp =
    typeof message.metadata.sourceEventIndex === 'number'
      ? eventTimestamps[message.metadata.sourceEventIndex]
      : undefined;

  return {
    id: message.id,
    role: message.role === 'system' ? 'assistant' : message.role,
    createdAt: sourceTimestamp ? new Date(sourceTimestamp) : undefined,
    content: message.content.map(convertCodeMuxPartToThreadPart),
    metadata: {
      custom: {
        ...message.metadata,
        sourceRole: message.role,
        sourceTimestamp,
        isFinalAssistantMessage: message.metadata.isFinalAssistantMessage,
      },
    },
  };
}

function convertCodeMuxPartToThreadPart(
  part: CodeMuxAssistantPart,
): ThreadMessagePartLike {
  if (part.type === 'data-codemux-event') {
    return {
      type: 'data',
      name: 'codemux-event',
      data: {
        eventKind: part.eventKind,
        event: part.event,
      },
    };
  }

  if (part.type === 'tool-call') {
    return {
      ...part,
      argsText: JSON.stringify(part.args, null, 2),
    } as ThreadMessagePartLike;
  }

  return part as ThreadMessagePartLike;
}

function getTextContent(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function parseSlashCommand(content: string): { name: string; args: string } | null {
  if (!content.startsWith('/')) {
    return null;
  }

  const firstSpaceIndex = content.indexOf(' ');
  const name = (firstSpaceIndex === -1 ? content.slice(1) : content.slice(1, firstSpaceIndex)).trim().toLowerCase();

  if (!name) {
    return null;
  }

  return {
    name,
    args: firstSpaceIndex === -1 ? '' : content.slice(firstSpaceIndex + 1).trim(),
  };
}
