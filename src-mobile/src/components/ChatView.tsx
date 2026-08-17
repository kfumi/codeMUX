import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Send } from 'lucide-react';

import { ChatMarkdown } from './chat/ChatMarkdown';
import { ChatSeamRow } from './chat/ChatSeamRow';
import { CompactProcessToggle } from './chat/CompactProcessToggle';
import { DesktopOfflineOverlay } from './DesktopOfflineOverlay';
import { DirectiveText } from './chat/DirectiveText';
import { ExploreGroupRow } from './chat/ExploreGroupRow';
import { ReasoningRow } from './chat/ReasoningRow';
import { RuntimeSwitchRow } from './chat/RuntimeSwitchRow';
import { SessionSummaryRow } from './chat/SessionSummaryRow';
import { ToolCallRow } from './chat/ToolCallRow';
import { ScrollToBottomButton, useChatScrollToBottom } from '../hooks/useChatScrollToBottom';
import { useCompanionSocket } from '../hooks/useCompanionSocket';
import { useDesktopReachability } from '../hooks/useDesktopReachability';
import { fetchBootstrap, fetchSessionEvents, isAuthError, respondPermission, respondUserInput, sendSessionMessage } from '../lib/api';
import { appendEvent, eventsToMessages, type ChatMessage } from '../lib/eventToMessages';
import { buildDisplayRows, isSeamMessage, type DisplayRow } from '../lib/messageLayout';
import {
  cacheSessionEvents,
  clearConnection,
  maxEventSequence,
  type CompanionConnection,
} from '../lib/storage';
import { cn } from '../lib/utils';

interface ChatViewProps {
  connection: CompanionConnection;
  sessionId: string;
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

export function ChatView({ connection, sessionId, onBack, onDisconnected }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compactAiOutput, setCompactAiOutput] = useState(false);
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
    void persistEvents(rawEventsRef.current);
  }, [persistEvents]);

  const loadCompactSetting = useCallback(async () => {
    try {
      const bootstrap = await fetchBootstrap(connection);
      setCompactAiOutput(Boolean(bootstrap.compactAiOutput));
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
      void loadCompactSetting();
      void loadHistory(-1);
    },
  });

  useEffect(() => {
    lastSequenceRef.current = -1;
    rawEventsRef.current = [];
    setMessages([]);
    setLoading(true);
    setError(null);

    void (async () => {
      await Promise.all([loadCompactSetting(), loadHistory(-1)]);
      setLoading(false);
    })();
  }, [connection, loadCompactSetting, loadHistory, sessionId]);

  const appendIncomingEvent = useCallback((event: Record<string, unknown>) => {
    rawEventsRef.current = [...rawEventsRef.current, event];
    lastSequenceRef.current = maxEventSequence(rawEventsRef.current);
    setMessages((current) => appendEvent(current, event));
    void persistEvents(rawEventsRef.current);
  }, [persistEvents]);

  const handleReconnect = useCallback(() => {
    void loadHistory(lastSequenceRef.current);
  }, [loadHistory]);

  const displayRows = useMemo(
    () => buildDisplayRows(messages, { compactAiOutput, expandedTurnKeys }),
    [compactAiOutput, expandedTurnKeys, messages],
  );

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

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      await sendSessionMessage(connection, sessionId, text);
      setPrompt('');
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  const handlePermission = async (requestId: string, allow: boolean) => {
    try {
      await respondPermission(connection, sessionId, requestId, { behavior: allow ? 'allow' : 'deny' });
      setMessages((current) => current.filter((message) => (
        message.kind !== 'permission' || message.requestId !== requestId
      )));
    } catch (err) {
      setError(String(err));
    }
  };

  const handleQuestion = async (toolUseId: string, answer: string) => {
    try {
      await respondUserInput(connection, sessionId, toolUseId, [answer]);
      setMessages((current) => current.filter((message) => (
        message.kind !== 'question' || message.toolUseId !== toolUseId
      )));
    } catch (err) {
      setError(String(err));
    }
  };

  const renderMessage = useCallback((message: ChatMessage) => {
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
          </div>
        </div>
      );
    }

    if (message.kind === 'assistant') {
      return (
        <div data-message-row className="flex w-full justify-start">
          <div className="w-full min-w-0 space-y-2 text-sm leading-relaxed">
            <ChatMarkdown content={message.content} streaming={message.streaming} />
          </div>
        </div>
      );
    }

    if (message.kind === 'runtime_switch') {
      return (
        <div data-message-row className="flex w-full justify-center">
          <RuntimeSwitchRow
            fromKind={message.fromKind}
            toKind={message.toKind}
            briefing={message.briefing}
          />
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
      return (
        <div
          data-message-row
          className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm"
        >
          <div className="text-foreground">{message.description}</div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
              onClick={() => void handlePermission(message.requestId, true)}
            >
              允许
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
              onClick={() => void handlePermission(message.requestId, false)}
            >
              拒绝
            </button>
          </div>
        </div>
      );
    }

    if (message.kind === 'question') {
      const firstQuestion = message.questions[0];
      const options = firstQuestion?.options.length
        ? firstQuestion.options
        : [{ label: '继续' }];
      return (
        <div
          data-message-row
          className="rounded-xl border border-border bg-[hsl(var(--surface-2))] px-4 py-3 text-sm"
        >
          <div className="font-medium text-foreground">
            {firstQuestion?.question ?? '需要你的回答'}
          </div>
          <div className="mt-3 space-y-2">
            {options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="block w-full rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left text-xs transition-colors hover:bg-muted/60"
                onClick={() => void handleQuestion(message.toolUseId, option.label)}
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
            </div>
          </div>
        );
      }
      return renderMessage(row.message);
    }

    if (row.kind === 'compact-toggle') {
      return (
        <CompactProcessToggle
          expanded={expandedTurnKeys.has(row.turnKey)}
          onToggle={() => toggleTurnExpanded(row.turnKey)}
        />
      );
    }

    const active = row.messages.some((message) => (
      message.kind === 'tool' && message.status === 'running'
    )) || row.messages.some((message) => message.kind === 'reasoning' && message.streaming);

    return (
      <ExploreGroupRow
        toolNames={row.toolNames}
        messages={row.messages}
        active={active}
        renderMessage={renderMessage}
      />
    );
  }, [expandedTurnKeys, renderMessage, toggleTurnExpanded]);

  const { connected } = useCompanionSocket(
    offline ? null : connection,
    offline ? null : sessionId,
    appendIncomingEvent,
    handleReconnect,
    {
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
          <div className="truncate text-sm font-medium">会话</div>
          <div className="text-xs text-muted-foreground">
            {offline ? '电脑端离线' : connected ? '已连接' : '连接中…'}
          </div>
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
            <div key={row.kind === 'single' ? row.message.id : row.kind === 'explore' ? row.id : row.turnKey}>
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

        <form
          className="bg-[linear-gradient(180deg,hsl(var(--background)/0),hsl(var(--background))_24%,hsl(var(--background)))] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => void handleSend(event)}
        >
          <div className="flex items-end gap-2" style={{ maxWidth: 'var(--content-width)', marginInline: 'auto' }}>
            <textarea
              className="min-h-11 flex-1 resize-none rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed outline-none transition-colors focus:border-primary/60 focus:bg-muted/60"
              placeholder="发送消息…"
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={offline}
            />
            <button
              type="submit"
              disabled={sending || !prompt.trim() || !connected || offline}
              className={cn(
                'rounded-xl bg-primary p-3 text-primary-foreground transition-opacity',
                (sending || !prompt.trim() || !connected || offline) && 'opacity-50',
              )}
              aria-label="发送"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
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
