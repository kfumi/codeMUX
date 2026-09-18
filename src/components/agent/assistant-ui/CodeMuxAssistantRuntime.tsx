import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';

import type { SlashCommand } from '../../../lib/slashCommands';
import { findCommand } from '../../../lib/slashCommands';
import { useAgentStore } from '../../../stores/agentStore';
import type { AgentMessage } from '../../../stores/agentStore';

import { consumeBrowserElementsForSend, useBrowserElementStore } from '../../../stores/browserElementStore';
import { payloadHasAttachments, type AgentInputPayload } from '../../../types/agentInput';
import type { AgentKind } from '../../../types/session';
import type { ProjectSkill } from '../../../types/skill';
import type { ConversationTurn } from '../../../types/conversationTurn';
import {
  convertAgentEventsToAssistantMessages,
  type CodeMuxAssistantMessage,
  type CodeMuxAssistantPart,
} from './convertAgentEvents';
import {
  reduceThreadWindow,
  resolveMountedTurnStartEventIndex,
  THREAD_WINDOW_EVENT_THRESHOLD,
  THREAD_WINDOW_INITIAL_COMMIT_TURNS,
} from '../../../lib/threadWindow';
import { reconcileAssistantMessages } from './assistantMessageIdentity';

type CodeMuxAssistantRuntimeProviderProps = {
  sessionId: string;
  agentKind?: AgentKind;
  projectSkills?: ProjectSkill[];
  onSend: (content: AgentInputPayload, displayContent?: string) => Promise<void>;
  onCommand: (command: SlashCommand, args: string) => void | Promise<void>;
  sendDisabled?: boolean;
  children: ReactNode;
};

type ThreadMessagePartLike = Exclude<ThreadMessageLike['content'], string>[number];

const EMPTY_EVENTS: AgentMessage[] = [];
const EMPTY_TURNS: ConversationTurn<AgentMessage>[] = [];
const EMPTY_TIMESTAMPS: number[] = [];

export function CodeMuxAssistantRuntimeProvider({
  sessionId,
  agentKind = 'claude_code',
  projectSkills = [],
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
      projectSkills={projectSkills}
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
  projectSkills = [],
  onSend,
  onCommand,
  sendDisabled = false,
  children,
}: CodeMuxAssistantRuntimeProviderProps) {
  const events = useAgentStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
  const conversationTurns = useAgentStore((state) => state.turns[sessionId] ?? EMPTY_TURNS);
  const eventTimestamps = useAgentStore((state) => state.eventTimestamps[sessionId] ?? EMPTY_TIMESTAMPS);
  const isRunning = useAgentStore((state) => state.isRunning[sessionId] ?? false);
  const rewindLastTurn = useAgentStore((state) => state.rewindLastTurn);
  const attachmentAdapter = useMemo(() => new CodeMuxImageAttachmentAdapter(), []);
  const eventTimestampsRef = useRef(eventTimestamps);
  eventTimestampsRef.current = eventTimestamps;

  // 尾部挂载窗口（工单 03）：render 期派生，不由 layout effect 翻转。键缺失 = 首帧提交
  // （只挂载首帧预算）；跨过长会话阈值才启用，短会话逐字节保持全量。
  const storedWindowSize = useAgentStore((state) => state.threadWindowSizes[sessionId]);
  const windowingActive = events.length > THREAD_WINDOW_EVENT_THRESHOLD;
  const threadWindow = useMemo(
    () =>
      windowingActive
        ? reduceThreadWindow({
            totalTurns: conversationTurns.length,
            windowSize: storedWindowSize ?? THREAD_WINDOW_INITIAL_COMMIT_TURNS,
            initialCommit: storedWindowSize === undefined,
          })
        : { mountedTurns: conversationTurns.length, hiddenAboveTurns: 0, bounded: false },
    [windowingActive, conversationTurns.length, storedWindowSize],
  );
  const mountStartEventIndex = useMemo(
    () =>
      windowingActive && threadWindow.bounded
        ? resolveMountedTurnStartEventIndex(conversationTurns, threadWindow.mountedTurns)
        : 0,
    [windowingActive, threadWindow.bounded, threadWindow.mountedTurns, conversationTurns],
  );
  const mountedEvents = useMemo(
    () => (mountStartEventIndex > 0 ? events.slice(mountStartEventIndex) : events),
    [events, mountStartEventIndex],
  );
  const mountedTurns = useMemo(
    () =>
      mountStartEventIndex > 0
        ? conversationTurns.slice(-threadWindow.mountedTurns)
        : conversationTurns,
    [conversationTurns, mountStartEventIndex, threadWindow.mountedTurns],
  );

  // 历史身份稳定：把本次转换结果与上一次的产出做引用协调，让未变化的消息与部件
  // 保持对象身份。下游 assistant-ui 的转换缓存是 `WeakMap<外部消息对象, ThreadMessage>`，
  // 只有身份稳定时它才会真正命中；否则整条线程消息每次事件都被重新转换。
  const stableMessagesRef = useRef<CodeMuxAssistantMessage[] | undefined>(undefined);
  const messages = useMemo(() => {
    // 切片偏移保证 sourceEventIndex / msg-N / 去重 id 仍以绝对下标命名 ——
    // 与全量转换逐字节一致（正确性红线：rewind 与跳转都依赖它）。
    const converted = convertAgentEventsToAssistantMessages(mountedEvents, mountedTurns, mountStartEventIndex);
    const stable = reconcileAssistantMessages(converted, stableMessagesRef.current);
    stableMessagesRef.current = stable;
    return stable;
  }, [mountedEvents, mountedTurns, mountStartEventIndex]);

  const handleMessage = useCallback(
    async (message: AppendMessage) => {
      const payload = buildAgentInputPayloadFromAppendMessage(message);

      if (sendDisabled) {
        return;
      }

      const hasPendingElements = (useBrowserElementStore.getState().elementsBySession[sessionId] ?? []).length > 0;
      if (payload.text.length === 0 && !payloadHasAttachments(payload) && !hasPendingElements) {
        return;
      }

      const hasImages = payloadHasAttachments(payload);
      const chipCommand = hasImages ? null : resolveChipCommand(payload.text, agentKind, projectSkills);

      if (chipCommand) {
        if (shouldRouteChipCommandToHandler(chipCommand.command, agentKind)) {
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

      const slashCommand = hasImages ? null : resolveSlashCommand(payload.text, agentKind, projectSkills);
      if (slashCommand) {
        await onCommand(slashCommand.command, slashCommand.args);
        return;
      }

      await onSend(consumeBrowserElementsForSend(sessionId, payload));
    },
    [onCommand, onSend, agentKind, projectSkills, sendDisabled, sessionId],
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

  // adapters 必须保持引用稳定：`useExternalStoreRuntime` 内部用
  // `if (this._store === store) return` 做守卫，且 setAdapter 的 effect 没有依赖
  // 数组 —— 每次渲染都新建字面量会让守卫永不生效、adapter 每次渲染都被重灌。
  const adapters = useMemo(() => ({ attachments: attachmentAdapter }), [attachmentAdapter]);

  const runtime = useExternalStoreRuntime<CodeMuxAssistantMessage>({
    messages,
    isRunning,
    convertMessage,
    onNew: handleNew,
    onEdit: handleEdit,
    adapters,
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
  const sourceRole = message.role;

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
        sourceRole,
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
        type: 'image' as const,
        name: attachment.name,
        mediaType: attachment.contentType || mediaTypeFromDataUrl(part.image) || 'image/png',
        dataUrl: part.image,
        size: attachment.file?.size,
      }));
    });

  if (images.length === 0) {
    return { text };
  }

  return {
    text,
    attachments: images,
    images: images.map(({ name, mediaType, dataUrl, size }) => ({ name, mediaType, dataUrl, size })),
  };
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

export function resolveSlashCommand(
  content: string,
  agentKind: AgentKind = 'claude_code',
  projectSkills: ProjectSkill[] = [],
): { command: SlashCommand; args: string } | null {
  if (!content.startsWith('/')) {
    return null;
  }

  const firstSpaceIndex = content.indexOf(' ');
  const name = (firstSpaceIndex === -1 ? content.slice(1) : content.slice(1, firstSpaceIndex)).trim().toLowerCase();

  if (!name) {
    return null;
  }

  const command = findCommand(name, agentKind, projectSkills);
  return command
    ? { command, args: firstSpaceIndex === -1 ? '' : content.slice(firstSpaceIndex + 1).trim() }
    : null;
}

const CHIP_COMMAND_RE = /^\[\$([^\]]+)\]\([^)]+\)\s*([\s\S]*)$/;

export function resolveChipCommand(
  content: string,
  agentKind: AgentKind = 'claude_code',
  projectSkills: ProjectSkill[] = [],
): { command: SlashCommand; args: string } | null {
  const match = CHIP_COMMAND_RE.exec(content.trim());
  if (!match) return null;
  const [, name, rest] = match;
  const args = rest.trim();
  const command = findCommand(name, agentKind, projectSkills);
  return command ? { command, args } : null;
}

export function shouldRouteChipCommandToHandler(command: SlashCommand, agentKind: AgentKind): boolean {
  return (
    agentKind === 'claude_code'
    || command.handler === 'local'
    || command.category === 'session'
  );
}
