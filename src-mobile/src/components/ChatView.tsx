import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useCompanionSocket } from '../hooks/useCompanionSocket';
import { fetchSessionEvents, respondPermission, sendSessionMessage } from '../lib/api';
import type { CompanionConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface ChatViewProps {
  connection: CompanionConnection;
  sessionId: string;
  onBack: () => void;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'permission';
  content: string;
  requestId?: string;
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
  const [lastSequence, setLastSequence] = useState(-1);

  const appendEvent = useCallback((event: Record<string, unknown>) => {
    const sequence = typeof event.sequence === 'number' ? event.sequence : null;
    if (sequence !== null) {
      setLastSequence((current) => Math.max(current, sequence));
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
      return [...current, item];
    });
  }, []);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const events = await fetchSessionEvents(connection, sessionId, lastSequence);
      for (const event of events) {
        if (event && typeof event === 'object') {
          appendEvent(event as Record<string, unknown>);
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [appendEvent, connection, lastSequence, sessionId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const { connected } = useCompanionSocket(connection, sessionId, appendEvent);

  const pendingPermissions = useMemo(
    () => items.filter((item) => item.role === 'permission' && item.requestId),
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
            )}
          >
            {item.role === 'assistant' ? (
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
          </div>
        ))}
      </div>

      {pendingPermissions.length > 0 ? (
        <div className="border-t border-amber-400/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
          有 {pendingPermissions.length} 个待审批请求
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
