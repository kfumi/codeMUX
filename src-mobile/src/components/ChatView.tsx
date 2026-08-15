import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useCompanionSocket } from '../hooks/useCompanionSocket';
import { fetchSessionEvents, respondPermission, respondUserInput, sendSessionMessage } from '../lib/api';
import type { CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface ChatViewProps {
  connection: CompanionConnection;
  sessionId: string;
  onBack: () => void;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'permission' | 'question' | 'tool';
  content: string;
  requestId?: string;
  toolUseId?: string;
  questions?: Array<{ question: string; options: QuestionOption[] }>;
  collapsed?: boolean;
}

function eventToChatItem(event: Record<string, unknown>): ChatItem | null {
  const type = typeof event.type === 'string' ? event.type : '';
  const id = typeof event.event_id === 'string' ? event.event_id : crypto.randomUUID();

  if (type === 'user_message') {
    const content = typeof event.content === 'string'
      ? event.content
      : JSON.stringify(event.content);
    return { id, role: 'user', content };
  }

  if (type === 'assistant_message') {
    const message = event.content as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = Array.isArray(message?.content)
      ? message.content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n')
      : '';
    return text ? { id, role: 'assistant', content: text } : null;
  }

  if (type === 'system_event') {
    const content = typeof event.content === 'string' ? event.content : type;
    return { id, role: 'system', content };
  }

  if (type === 'permission_requested') {
    const description = typeof event.description === 'string' ? event.description : '需要审批';
    const requestId = typeof event.request_id === 'string' ? event.request_id : undefined;
    return { id, role: 'permission', content: description, requestId };
  }

  if (type === 'user_input_requested') {
    const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : undefined;
    const questions = Array.isArray(event.questions)
      ? event.questions
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          question: typeof entry.question === 'string' ? entry.question : '请回答',
          options: Array.isArray(entry.options)
            ? entry.options
              .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
              .map((option) => ({
                label: typeof option.label === 'string' ? option.label : '选项',
                description: typeof option.description === 'string' ? option.description : undefined,
              }))
            : [],
        }))
      : [];
    return {
      id,
      role: 'question',
      content: questions[0]?.question ?? '需要你的回答',
      toolUseId,
      questions,
    };
  }

  if (type === 'tool_started') {
    const name = typeof event.name === 'string' ? event.name : 'tool';
    return { id, role: 'tool', content: `工具开始：${name}`, collapsed: true };
  }

  if (type === 'tool_finished') {
    const name = typeof event.name === 'string' ? event.name : 'tool';
    const isError = event.is_error === true;
    return {
      id,
      role: 'tool',
      content: isError ? `工具失败：${name}` : `工具完成：${name}`,
      collapsed: true,
    };
  }

  if (type === 'text_delta' && typeof event.text === 'string') {
    return { id: `${id}-delta`, role: 'assistant', content: event.text };
  }

  return null;
}

export function ChatView({ connection, sessionId, onBack }: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSequenceRef = useRef(-1);
  const historyLoadedRef = useRef(false);

  const appendEvent = useCallback((event: Record<string, unknown>) => {
    const sequence = typeof event.sequence === 'number' ? event.sequence : null;
    if (sequence !== null) {
      lastSequenceRef.current = Math.max(lastSequenceRef.current, sequence);
    }

    const item = eventToChatItem(event);
    if (!item) return;

    setItems((current) => {
      if (item.role === 'assistant' && item.id.endsWith('-delta')) {
        const last = current[current.length - 1];
        if (last?.role === 'assistant' && last.id.endsWith('-delta')) {
          return [...current.slice(0, -1), { ...last, content: last.content + item.content }];
        }
      }
      const duplicate = current.some((entry) => entry.id === item.id);
      if (duplicate && item.role !== 'assistant') {
        return current;
      }
      return [...current, item];
    });
  }, []);

  useEffect(() => {
    historyLoadedRef.current = false;
    lastSequenceRef.current = -1;
    setItems([]);
    setLoading(true);
    setError(null);

    void fetchSessionEvents(connection, sessionId, -1)
      .then((events) => {
        for (const event of events) {
          if (event && typeof event === 'object') {
            appendEvent(event as Record<string, unknown>);
          }
        }
        historyLoadedRef.current = true;
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [appendEvent, connection, sessionId]);

  const { connected } = useCompanionSocket(connection, sessionId, appendEvent);

  const pendingPermissions = useMemo(
    () => items.filter((item) => item.role === 'permission' && item.requestId),
    [items],
  );

  const pendingQuestions = useMemo(
    () => items.filter((item) => item.role === 'question' && item.toolUseId),
    [items],
  );

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      await sendSessionMessage(connection, sessionId, text);
      setPrompt('');
      setItems((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }]);
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  const handlePermission = async (requestId: string, allow: boolean) => {
    try {
      await respondPermission(connection, sessionId, requestId, { behavior: allow ? 'allow' : 'deny' });
      setItems((current) => current.filter((item) => item.requestId !== requestId));
    } catch (err) {
      setError(String(err));
    }
  };

  const handleQuestion = async (toolUseId: string, answer: string) => {
    try {
      await respondUserInput(connection, sessionId, toolUseId, [answer]);
      setItems((current) => current.filter((item) => item.toolUseId !== toolUseId));
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleToolItem = (id: string) => {
    setItems((current) => current.map((item) => (
      item.id === id ? { ...item, collapsed: !item.collapsed } : item
    )));
  };

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 pb-4 pt-10">
        <button type="button" className="rounded-lg border border-white/10 p-2" onClick={onBack} aria-label="返回">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">会话</div>
          <div className="text-xs text-slate-400">{connected ? '实时连接中' : '重连中…'}</div>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {loading ? <div className="text-sm text-slate-400">加载历史…</div> : null}
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'rounded-2xl px-4 py-3 text-sm leading-relaxed',
              item.role === 'user' && 'ml-8 bg-sky-500/20',
              item.role === 'assistant' && 'mr-4 bg-white/5',
              item.role === 'system' && 'bg-amber-500/10 text-amber-100',
              item.role === 'permission' && 'border border-amber-400/30 bg-amber-500/10',
              item.role === 'question' && 'border border-sky-400/30 bg-sky-500/10',
              item.role === 'tool' && 'border border-white/10 bg-white/5 text-slate-300',
            )}
          >
            {item.role === 'tool' ? (
              <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => toggleToolItem(item.id)}>
                {item.collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                <span>{item.content}</span>
              </button>
            ) : item.role === 'assistant' ? (
              <div className="prose prose-invert max-w-none prose-p:my-2 prose-pre:my-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
              </div>
            ) : (
              item.content
            )}

            {item.role === 'permission' && item.requestId ? (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-slate-950"
                  onClick={() => void handlePermission(item.requestId!, true)}
                >
                  允许
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-white/10 px-3 py-2 text-xs"
                  onClick={() => void handlePermission(item.requestId!, false)}
                >
                  拒绝
                </button>
              </div>
            ) : null}

            {item.role === 'question' && item.toolUseId ? (
              <div className="mt-3 space-y-2">
                {(item.questions?.[0]?.options.length ? item.questions[0].options : [{ label: '继续' }]).map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="block w-full rounded-lg border border-white/10 px-3 py-2 text-left text-xs"
                    onClick={() => void handleQuestion(item.toolUseId!, option.label)}
                  >
                    <div>{option.label}</div>
                    {option.description ? <div className="mt-1 text-slate-400">{option.description}</div> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {pendingPermissions.length > 0 ? (
        <div className="border-t border-amber-400/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
          有 {pendingPermissions.length} 个待审批请求
        </div>
      ) : null}
      {pendingQuestions.length > 0 ? (
        <div className="border-t border-sky-400/20 bg-sky-500/10 px-4 py-2 text-xs text-sky-100">
          有 {pendingQuestions.length} 个待回答问题
        </div>
      ) : null}

      {error ? <div className="px-4 py-2 text-sm text-red-300">{error}</div> : null}

      <form className="border-t border-white/10 p-4" onSubmit={(event) => void handleSend(event)}>
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-11 flex-1 resize-none rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none focus:border-sky-400"
            placeholder="发送消息…"
            rows={1}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button
            type="submit"
            disabled={sending || !prompt.trim()}
            className="rounded-2xl bg-sky-500 p-3 text-slate-950 disabled:opacity-50"
            aria-label="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
