import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';

import type { SlashCommand } from '../../../lib/slashCommands';
import { findCommand } from '../../../lib/slashCommands';
import { useAgentStore } from '../../../stores/agentStore';
import type { AgentMessage } from '../../../stores/agentStore';

import type { AgentInputPayload } from '../../../types/agentInput';
import type { AgentKind } from '../../../types/session';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
  type CodeMuxAssistantPart,
} from './convertAgentEvents';

type CodeMuxAssistantRuntimeProviderProps = {
  sessionId: string;
  agentKind?: AgentKind;
  onSend: (content: AgentInputPayload, displayContent?: string) => Promise<void>;
  onCommand: (command: SlashCommand, args: string) => void | Promise<void>;
  sendDisabled?: boolean;
  children: ReactNode;
};

type ThreadMessagePartLike = Exclude<ThreadMessageLike['content'], string>[number];

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TIMESTAMPS: number[] = [];

export function CodeMuxAssistantRuntimeProvider({
  sessionId,
  agentKind = 'claude_code',
  onSend,
  onCommand,
  sendDisabled = false,
  children,
}: CodeMuxAssistantRuntimeProviderProps) {
  return (
    <SessionScopedAssistantRuntime
      key={sessionId}
      sessionId={sessionId}
      agentKind={agentKind}
      onSend={onSend}
      onCommand={onCommand}
      sendDisabled={sendDisabled}
    >
      {children}
    </SessionScopedAssistantRuntime>
  );
}

function SessionScopedAssistantRuntime({
  sessionId,
  agentKind = 'claude_code',
  onSend,
  onCommand,
  sendDisabled = false,
  children,
}: CodeMuxAssistantRuntimeProviderProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const rewindLastTurn = useAgentStore((state) => state.rewindLastTurn);
  const attachmentAdapter = useMemo(() => new CodeMuxImageAttachmentAdapter(), []);
  const eventTimestampsRef = useRef(eventTimestamps);
  eventTimestampsRef.current = eventTimestamps;

  const messages = useMemo(() => {
    return convertAgentEventsToAssistantMessages(events);
  }, [events, sessionId]);

  const handleMessage = useCallback(
    async (message: AppendMessage) => {
      const payload = buildAgentInputPayloadFromAppendMessage(message);

      if (sendDisabled) {
        return;
      }

      if (payload.text.length === 0 && (payload.images?.length ?? 0) === 0) {
        return;
      }

      const hasImages = (payload.images?.length ?? 0) > 0;
      const chipCommand = hasImages ? null : resolveChipCommand(payload.text, agentKind);

      if (chipCommand) {
        if (agentKind === 'claude_code') {
          await onCommand(chipCommand.command, chipCommand.args);
          return;
        }
        if (chipCommand.command.name === 'init') {
          const initPrompt = chipCommand.command.prompt || '';
          await onSend({ text: initPrompt }, payload.text);
          return;
        }
        await onSend(payload);
        return;
      }

      const slashCommand = hasImages ? null : resolveSlashCommand(payload.text, agentKind);
      if (slashCommand) {
        await onCommand(slashCommand.command, slashCommand.args);
        return;
      }

      await onSend(payload);
    },
    [onCommand, onSend, agentKind, sendDisabled],
  );

  const handleNew = useCallback(
    async (message: AppendMessage) => {
      await handleMessage(message);
    },
    [handleMessage],
  );

  const handleEdit = useCallback(
    async (message: AppendMessage) => {
      await rewindLastTurn(sessionId);
      await handleMessage(message);
    },
    [handleMessage, rewindLastTurn, sessionId],
  );

  const convertMessage = useCallback(
    (message: CodeMuxAssistantMessage) =>
      convertCodeMuxMessageToThreadMessageLike(message, eventTimestampsRef.current),
    [],
  );

  const runtime = useExternalStoreRuntime<CodeMuxAssistantMessage>({
    messages,
    isRunning,
    convertMessage,
    onNew: handleNew,
    onEdit: handleEdit,
    adapters: {
      attachments: attachmentAdapter,
    },
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
    attachments: message.role === 'user'
      ? message.metadata.attachments?.map((attachment, index) => ({
        id: `${message.id}-${attachment.name}-${index}`,
        type: 'image',
        name: attachment.name,
        contentType: attachment.mediaType,
        status: { type: 'complete' as const },
        content: [{ type: 'image' as const, image: attachment.dataUrl }],
      }))
      : undefined,
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

export function buildAgentInputPayloadFromAppendMessage(message: AppendMessage): AgentInputPayload {
  const text = getTextContent(message);
  const images = (message.attachments ?? [])
    .filter((attachment) => attachment.type === 'image')
    .flatMap((attachment) => {
      const imageParts = (attachment.content ?? []).filter(
        (part): part is { type: 'image'; image: string } =>
          part.type === 'image' && typeof (part as { image?: unknown }).image === 'string',
      );

      return imageParts.map((part) => ({
        name: attachment.name,
        mediaType: attachment.contentType || mediaTypeFromDataUrl(part.image) || 'image/png',
        dataUrl: part.image,
        size: attachment.file?.size,
      }));
    });

  return images.length > 0 ? { text, images } : { text };
}

export class CodeMuxImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  public override async add(state: { file: File }) {
    const attachment = await super.add(state);
    return {
      ...attachment,
      id: `${state.file.name}-${createUniqueAttachmentSuffix()}`,
    };
  }
}

function createUniqueAttachmentSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mediaTypeFromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

export function resolveSlashCommand(content: string, agentKind: AgentKind = 'claude_code'): { command: SlashCommand; args: string } | null {
  if (!content.startsWith('/')) {
    return null;
  }

  const firstSpaceIndex = content.indexOf(' ');
  const name = (firstSpaceIndex === -1 ? content.slice(1) : content.slice(1, firstSpaceIndex)).trim().toLowerCase();

  if (!name) {
    return null;
  }

  const command = findCommand(name, agentKind);
  return command
    ? { command, args: firstSpaceIndex === -1 ? '' : content.slice(firstSpaceIndex + 1).trim() }
    : null;
}

const CHIP_COMMAND_RE = /^\[\$([^\]]+)\]\([^)]+\)\s*([\s\S]*)$/;

export function resolveChipCommand(
  content: string,
  agentKind: AgentKind = 'claude_code',
): { command: SlashCommand; args: string } | null {
  const match = CHIP_COMMAND_RE.exec(content.trim());
  if (!match) return null;
  const [, name, rest] = match;
  const args = rest.trim();
  const command = findCommand(name, agentKind);
  return command ? { command, args } : null;
}
