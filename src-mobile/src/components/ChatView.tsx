import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { ChatMarkdown } from './chat/ChatMarkdown';
import { ChatSeamRow } from './chat/ChatSeamRow';
import { CompactProcessToggle } from './chat/CompactProcessToggle';
import { DesktopOfflineOverlay } from './DesktopOfflineOverlay';
import { DirectiveText } from './chat/DirectiveText';
import { ToolGroupRow } from './chat/ToolGroupRow';
import { MessageFooter } from './chat/MessageFooter';
import { ReasoningRow } from './chat/ReasoningRow';
import { SessionSummaryRow } from './chat/SessionSummaryRow';
import { ToolCallRow } from './chat/ToolCallRow';
import { ThinkingGroupRow } from './chat/ThinkingGroupRow';
import { MobileComposer } from './MobileComposer';
import { ScrollToBottomButton, useChatScrollToBottom } from '../hooks/useChatScrollToBottom';
import { useCompanionSocket } from '../hooks/useCompanionSocket';
import { useDesktopReachability } from '../hooks/useDesktopReachability';
import {
  fetchBootstrap,
  fetchSessionEvents,
  interruptSession,
  isAuthError,
  respondPermission,
  respondUserInput,
  sendSessionMessage,
  type MobileBootstrap,
  type MobileInputPayload,
  type MobileSession,
  type MobileSessionSettingsPatch,
  updateSessionSettings,
} from '../lib/api';
import { isPlanApprovalPermission } from '@shared/lib/agentPermissions';
import { appendEvent, eventsToMessages, type ChatMessage } from '../lib/eventToMessages';
import {
  buildDisplayRows,
  isSeamMessage,
  type DisplayRow,
  type MessageFooterData,
} from '../lib/messageLayout';
import { buildMobilePermissionResponse, type MobilePermissionDecision } from '../lib/permissionResponse';
import { resolveMobileRunningState } from '../lib/runtimeState';
import { buildTurnDurationMap } from '../lib/turnDuration';
import {
  cacheSessionEvents,
  clearConnection,
  maxEventSequence,
  type CompanionConnection,
} from '../lib/storage';
import { cn } from '../lib/utils';

interface ChatViewProps {
  connection: CompanionConnection;
  session: MobileSession;
  onBack: () => void;
  onDisconnected: (reason?: string) => void;
}

function applyEvents(messages: ChatMessage[], events: unknown[]): ChatMessage[] {
  let next = messages;
  for (const event of events) {
    if (event && typeof event === 'object') {
      next = appendEvent(next, event as Record<string, unknown>);
    }
  }
  return next;
}

export function ChatView({ connection, session: initialSession, onBack, onDisconnected }: ChatViewProps) {
  const sessionId = initialSession.id;
  const [session, setSession] = useState<MobileSession>(initialSession);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null);
  const [compactAiOutput, setCompactAiOutput] = useState(false);
  const [desktopRunning, setDesktopRunning] = useState(false);
  const [turnDurationsByUserId, setTurnDurationsByUserId] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<Set<string>>(() => new Set());
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastSequenceRef = useRef(-1);
  const rawEventsRef = useRef<unknown[]>([]);

  const persistEvents = useCallback(async (events: unknown[]) => {
    await cacheSessionEvents(sessionId, {
      updatedAt: new Date().toISOString(),
      lastSequence: maxEventSequence(events),
      events,
    });
  }, [sessionId]);

  const ingestEvents = useCallback((events: unknown[], replace = false) => {
    if (replace) {
      rawEventsRef.current = [...events];
      setMessages(eventsToMessages(events));
    } else if (events.length > 0) {
      rawEventsRef.current = [...rawEventsRef.current, ...events];
      setMessages((current) => applyEvents(current, events));
    }
    lastSequenceRef.current = maxEventSequence(rawEventsRef.current);
    setTurnDurationsByUserId(buildTurnDurationMap(rawEventsRef.current));
    void persistEvents(rawEventsRef.current);
  }, [persistEvents]);

  const loadBootstrap = useCallback(async () => {
    try {
      const nextBootstrap = await fetchBootstrap(connection);
      setBootstrap(nextBootstrap);
      setCompactAiOutput(Boolean(nextBootstrap.compactAiOutput));
    } catch {
      // Keep the previous setting when bootstrap is temporarily unavailable.
    }
  }, [connection]);

  const loadHistory = useCallback(async (after = -1) => {
    setError(null);
    try {
      const events = await fetchSessionEvents(connection, sessionId, after);
      if (after < 0) {
        ingestEvents(events, true);
      } else if (events.length > 0) {
        ingestEvents(events, false);
      } else {
        lastSequenceRef.current = maxEventSequence(rawEventsRef.current);
      }
      return true;
    } catch (err) {
      if (isAuthError(err)) {
        await clearConnection();
        onDisconnected('桌面端已撤销此设备或配对已失效，请重新配对。');
        return false;
      }
      setError(String(err));
      return false;
    }
  }, [connection, ingestEvents, onDisconnected, sessionId]);

  const handleAuthFailure = useCallback(() => {
    void (async () => {
      await clearConnection();
      onDisconnected('桌面端已撤销此设备或配对已失效，请重新配对。');
    })();
  }, [onDisconnected]);

  const {
    offline,
    detail,
    reconnecting,
    reconnect,
    reportUnreachable,
    check,
  } = useDesktopReachability(connection, {
    onAuthFailure: handleAuthFailure,
    onRecovered: () => {
      void loadBootstrap();
      void loadHistory(-1);
    },
  });

  useEffect(() => {
    lastSequenceRef.current = -1;
    rawEventsRef.current = [];
    setMessages([]);
    setLoading(true);
    setError(null);
    setBootstrap(null);
    setDesktopRunning(false);
    setTurnDurationsByUserId(new Map());

    void (async () => {
      await Promise.all([loadBootstrap(), loadHistory(-1)]);
      setLoading(false);
    })();
  }, [connection, loadBootstrap, loadHistory, sessionId]);

  const appendIncomingEvent = useCallback((event: Record<string, unknown>) => {
    rawEventsRef.current = [...rawEventsRef.current, event];
    lastSequenceRef.current = maxEventSequence(rawEventsRef.current);
    setTurnDurationsByUserId(buildTurnDurationMap(rawEventsRef.current));
    setMessages((current) => appendEvent(current, event));
    void persistEvents(rawEventsRef.current);
  }, [persistEvents]);

  const handleReconnect = useCallback(() => {
    void loadHistory(lastSequenceRef.current);
  }, [loadHistory]);

  const displayRows = useMemo(
    () => buildDisplayRows(messages, {
      compactAiOutput,
      expandedTurnKeys,
      turnDurationsByUserId,
    }),
    [compactAiOutput, expandedTurnKeys, messages, turnDurationsByUserId],
  );

  const running = resolveMobileRunningState({ sending, desktopRunning });

  const streamTick = useMemo(() => {
    let tick = 0;
    for (const message of messages) {
      if ((message.kind === 'assistant' || message.kind === 'reasoning') && message.streaming) {
        tick += message.content.length;
      }
    }
    return tick;
  }, [messages]);

  const { isAtBottom, contentVisible, scrollToBottom } = useChatScrollToBottom(viewportRef, {
    contentKey: sessionId,
    loading,
    contentLength: messages.length,
    rowCount: displayRows.length,
    streamTick,
  });

  const toggleTurnExpanded = useCallback((turnKey: string) => {
    setExpandedTurnKeys((current) => {
      const next = new Set(current);
      if (next.has(turnKey)) {
        next.delete(turnKey);
      } else {
        next.add(turnKey);
      }
      return next;
    });
  }, []);

  const toggleToolCollapsed = useCallback((id: string) => {
    setMessages((current) => current.map((message) => (
      message.kind === 'tool' && message.id === id
        ? { ...message, collapsed: !message.collapsed }
        : message
    )));
  }, []);

  const toggleReasoningCollapsed = useCallback((id: string) => {
    setMessages((current) => current.map((message) => (
      message.kind === 'reasoning' && message.id === id
        ? { ...message, collapsed: !message.collapsed }
        : message
    )));
  }, []);

  const handleComposerSend = useCallback(async (text: string, inputPayload: MobileInputPayload) => {
    setSending(true);
    setError(null);
    try {
      await sendSessionMessage(connection, sessionId, text, inputPayload);
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setSending(false);
    }
  }, [connection, sessionId]);

  const handleComposerStop = useCallback(async () => {
    setError(null);
    try {
      await interruptSession(connection, sessionId);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [connection, sessionId]);

  const handleSettingsChange = useCallback(async (settings: MobileSessionSettingsPatch) => {
    setError(null);
    try {
      const nextSession = await updateSessionSettings(connection, sessionId, settings);
      setSession(nextSession);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [connection, sessionId]);

  const handlePermission = async (requestId: string, decision: MobilePermissionDecision) => {
    try {
      await respondPermission(
        connection,
        sessionId,
        requestId,
        buildMobilePermissionResponse(session.agent_kind, decision),
      );
      setMessages((current) => current.filter((message) => (
        message.kind !== 'permission' || message.requestId !== requestId
      )));
    } catch (err) {
      setError(String(err));
    }
  };

  const handleQuestion = async (toolUseId: string, answers: string[]) => {
    try {
      await respondUserInput(connection, sessionId, toolUseId, answers);
      setMessages((current) => current.filter((message) => (
        message.kind !== 'question' || message.toolUseId !== toolUseId
      )));
    } catch (err) {
      setError(String(err));
    }
  };

  const renderMessage = useCallback((message: ChatMessage, footer?: MessageFooterData) => {
    if (message.kind === 'user') {
      return (
        <div data-message-row className="flex w-full justify-end">
          <div className="flex w-fit max-w-[83%] min-w-0 flex-col items-end gap-2">
            {message.attachments?.length ? (
              <div className="flex flex-wrap justify-end gap-2">
                {message.attachments.map((attachment, index) => (
                  <img
                    key={`${message.id}-attachment-${index}`}
                    src={attachment.dataUrl}
                    alt={attachment.name ?? '附件图片'}
                    className="h-20 w-20 rounded-lg border border-border/50 object-cover"
                  />
                ))}
              </div>
            ) : null}
            {message.content ? (
              <div
                data-user-message-bubble
                className="min-w-0 max-w-full whitespace-pre-wrap wrap-break-word rounded-xl rounded-tr-md border border-border/50 bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground"
              >
                <DirectiveText text={message.content} />
              </div>
            ) : null}
            {footer ? (
              <MessageFooter
                content={message.content}
                timestamp={footer.timestamp}
                durationMs={footer.durationMs}
                sourceUuid={footer.sourceUuid}
                align="end"
              />
            ) : null}
          </div>
        </div>
      );
    }

    if (message.kind === 'assistant') {
      return (
        <div data-message-row className="flex w-full justify-start">
          <div className="w-full min-w-0 space-y-2 text-sm leading-relaxed">
            <ChatMarkdown content={message.content} streaming={message.streaming} />
            {!message.streaming && footer ? (
              <MessageFooter
                content={message.content}
                timestamp={footer.timestamp}
                durationMs={footer.durationMs}
                sourceUuid={footer.sourceUuid}
              />
            ) : null}
          </div>
        </div>
      );
    }

    if (message.kind === 'system') {
      if (isSeamMessage(message)) {
        return (
          <div data-message-row className="flex w-full justify-center">
            <ChatSeamRow>{message.content}</ChatSeamRow>
          </div>
        );
      }
      return (
        <div data-message-row className="flex w-full justify-center">
          <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            {message.content}
          </div>
        </div>
      );
    }

    if (message.kind === 'reasoning') {
      return (
        <div data-message-row className="flex w-full justify-start pl-1">
          <ReasoningRow
            content={message.content}
            collapsed={message.streaming ? false : message.collapsed}
            streaming={message.streaming}
            onToggle={() => toggleReasoningCollapsed(message.id)}
          />
        </div>
      );
    }

    if (message.kind === 'tool') {
      return (
        <div data-message-row className="flex w-full justify-start pl-1">
          <ToolCallRow
            name={message.name}
            status={message.status}
            input={message.input}
            inputObj={message.inputObj}
            result={message.result}
            collapsed={message.collapsed}
            onToggle={() => toggleToolCollapsed(message.id)}
          />
        </div>
      );
    }

    if (message.kind === 'session_summary') {
      return (
        <div data-message-row className="flex w-full justify-start pl-1">
          <SessionSummaryRow diffs={message.diffs} />
        </div>
      );
    }

    if (message.kind === 'permission') {
      const isPlanApproval = isPlanApprovalPermission(message.permissionType);
      return (
        <div
          data-message-row
          className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm"
        >
          <div className="font-medium text-foreground">
            {isPlanApproval ? '实施计划' : message.description}
          </div>
          {message.command ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-border/50 bg-background/70 px-3 py-2 font-mono text-xs leading-5 text-foreground/90 whitespace-pre-wrap wrap-break-word">
              <code>$ {message.command}</code>
            </pre>
          ) : null}
          {message.planMarkdown ? (
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {message.planMarkdown}
            </div>
          ) : null}
          {isPlanApproval ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                onClick={() => void handlePermission(message.requestId, 'once')}
              >
                批准并实施
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
                onClick={() => void handlePermission(message.requestId, 'reject')}
              >
                忽略
              </button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                onClick={() => void handlePermission(message.requestId, 'once')}
              >
                允许一次
              </button>
              <button
                type="button"
                className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary"
                onClick={() => void handlePermission(message.requestId, 'always')}
              >
                始终允许
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
                onClick={() => void handlePermission(message.requestId, 'reject')}
              >
                拒绝
              </button>
            </div>
          )}
        </div>
      );
    }

    if (message.kind === 'question') {
      return (
        <MobileQuestionCard
          key={message.id}
          questions={message.questions}
          onAnswer={(answers) => void handleQuestion(message.toolUseId, answers)}
        />
      );
    }

    return null;
  }, [handlePermission, handleQuestion, toggleReasoningCollapsed, toggleToolCollapsed]);

  const renderDisplayRow = useCallback((row: DisplayRow) => {
    if (row.kind === 'single') {
      if (row.message.kind === 'assistant' && row.sessionSummaries?.length) {
        return (
          <div data-message-row className="flex w-full justify-start">
            <div className="w-full min-w-0 space-y-2 text-sm leading-relaxed">
              <ChatMarkdown content={row.message.content} />
              <div className="mt-1">
                <SessionSummaryRow diffs={row.sessionSummaries} />
              </div>
              {row.footer ? (
                <MessageFooter
                  content={row.message.content}
                  timestamp={row.footer.timestamp}
                  durationMs={row.footer.durationMs}
                  sourceUuid={row.footer.sourceUuid}
                />
              ) : null}
            </div>
          </div>
        );
      }
      return renderMessage(row.message, row.footer);
    }

    if (row.kind === 'compact-toggle') {
      return (
        <CompactProcessToggle
          expanded={expandedTurnKeys.has(row.turnKey)}
          durationMs={row.durationMs}
          onToggle={() => toggleTurnExpanded(row.turnKey)}
        />
      );
    }

    if (row.kind === 'thinking') {
      return (
        <div data-message-row className="flex w-full justify-start pl-1">
          <ThinkingGroupRow messages={row.messages} />
        </div>
      );
    }

    if (row.kind === 'tool-group') {
      const active = row.messages.some((message) => message.status === 'running');

      return (
        <ToolGroupRow
          toolNames={row.toolNames}
          messages={row.messages}
          active={active}
          renderMessage={renderMessage}
        />
      );
    }

    return null;
  }, [expandedTurnKeys, renderMessage, toggleTurnExpanded]);

  const { connected } = useCompanionSocket(
    offline ? null : connection,
    offline ? null : sessionId,
    appendIncomingEvent,
    handleReconnect,
    {
      onRuntimeState: setDesktopRunning,
      onConnectionLost: () => {
        reportUnreachable('桌面端 WebSocket 已断开');
        void check();
      },
    },
  );

  const pendingPermissions = useMemo(
    () => messages.filter((message) => message.kind === 'permission'),
    [messages],
  );

  const pendingQuestions = useMemo(
    () => messages.filter((message) => message.kind === 'question'),
    [messages],
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="mobile-safe-header sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <button
          type="button"
          className="rounded-md border border-border/60 p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={onBack}
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session.title || '会话'}</div>
        </div>
      </header>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        style={{ maxWidth: 'var(--content-width)', marginInline: 'auto', width: '100%' }}
      >
        {loading ? (
          <div className="text-sm text-muted-foreground">加载历史…</div>
        ) : null}
        {!loading && messages.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无消息记录，发送第一条消息开始对话。</div>
        ) : null}

        <div
          className={cn(
            'flex min-h-min flex-col gap-5',
            !contentVisible && !loading && messages.length > 0 && 'invisible',
          )}
        >
          {displayRows.map((row) => (
            <div
              key={
                row.kind === 'single'
                  ? row.message.id
                  : row.kind === 'tool-group' || row.kind === 'thinking'
                    ? row.id
                    : row.turnKey
              }
            >
              {renderDisplayRow(row)}
            </div>
          ))}
        </div>
      </div>

      <div className="relative shrink-0 border-t border-border bg-background">
        <ScrollToBottomButton
          visible={!isAtBottom && !loading}
          onClick={() => scrollToBottom()}
        />

        {pendingPermissions.length > 0 ? (
          <div className="border-b border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-2 text-xs text-muted-foreground">
            有 {pendingPermissions.length} 个待审批请求
          </div>
        ) : null}
        {pendingQuestions.length > 0 ? (
          <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            有 {pendingQuestions.length} 个待回答问题
          </div>
        ) : null}

        {error && !offline ? <div className="px-4 py-2 text-sm text-destructive">{error}</div> : null}

        <div className="bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))]" style={{ maxWidth: 'var(--content-width)', marginInline: 'auto' }}>
          <MobileComposer
            connection={connection}
            session={session}
            bootstrap={bootstrap}
            connected={connected}
            offline={offline}
            running={running}
            onSend={handleComposerSend}
            onStop={handleComposerStop}
            onSettingsChange={handleSettingsChange}
          />
        </div>
      </div>

      {offline ? (
        <DesktopOfflineOverlay
          detail={detail ?? error}
          reconnecting={reconnecting}
          onReconnect={() => {
            void reconnect().then((recovered) => {
              if (recovered) {
                setLoading(true);
                void loadHistory(-1).finally(() => setLoading(false));
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Issue 12: question card with sequential multi-question support. Answers are
 * collected per question and submitted positionally, matching the sidecar
 * bridge's `string[][]` zip for app-server user-input requests.
 */
function MobileQuestionCard({ questions, onAnswer }: {
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
  onAnswer: (answers: string[]) => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const current = questions[stepIndex];
  const options = current?.options.length ? current.options : [{ label: '继续' }];

  const pick = (label: string) => {
    const nextAnswers = [...answers, label];
    if (stepIndex + 1 < questions.length) {
      setAnswers(nextAnswers);
      setStepIndex(stepIndex + 1);
      return;
    }
    onAnswer(nextAnswers);
  };

  return (
    <div
      data-message-row
      className="rounded-xl border border-border bg-[hsl(var(--surface-2))] px-4 py-3 text-sm"
    >
      {questions.length > 1 ? (
        <div className="text-xs text-muted-foreground">
          第 {stepIndex + 1} / {questions.length} 题
        </div>
      ) : null}
      <div className="font-medium text-foreground">
        {current?.question ?? '需要你的回答'}
      </div>
      <div className="mt-3 space-y-2">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="block w-full rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left text-xs transition-colors hover:bg-muted/60"
            onClick={() => pick(option.label)}
          >
            <div className="text-foreground">{option.label}</div>
            {option.description ? (
              <div className="mt-1 text-muted-foreground">{option.description}</div>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
