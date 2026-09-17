import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { daemonFacade } from '../../lib/facades/daemon-facade';
import { isCodeMuxPersistedTimelineEvent } from '../../lib/codeMuxProtocol';
import { cn } from '../../lib/utils';
import { mapPersistedClaudeMessage } from '../../stores/agentEventParsing';
import { parseAgentEvent } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types/session';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

interface ChatSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (sessionId: string, projectId: string | null) => void;
}

type PreviewState = {
  loading: boolean;
  text: string;
};

type ChatSearchItem = {
  session: Session;
  projectName: string;
  preview: string;
  searchText: string;
  updatedAt: number;
};

const MAX_RECENT_RESULTS = 9;
const PREVIEW_LIMIT = 92;

export function ChatSearchDialog({ open, onOpenChange, onSelectSession }: ChatSearchDialogProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const projects = useProjectStore((state) => state.projects);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const previewsRef = useRef(previews);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    if (!open) return;

    setQuery('');
    setSelectedIndex(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open || sessions.length === 0) return;

    let cancelled = false;
    const missingSessions = sessions.filter((session) => previewsRef.current[session.id] === undefined);
    if (missingSessions.length === 0) return;

    setPreviews((state) => {
      const next = { ...state };
      for (const session of missingSessions) {
        next[session.id] = { loading: true, text: '' };
      }
      return next;
    });

    for (const session of missingSessions) {
      void loadFirstUserMessage(session).then((text) => {
        if (cancelled) return;
        setPreviews((state) => ({
          ...state,
          [session.id]: { loading: false, text },
        }));
      });
    }

    return () => {
      cancelled = true;
    };
  }, [open, sessions]);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(project.id, project.name);
    }
    return map;
  }, [projects]);

  const items = useMemo<ChatSearchItem[]>(() => {
    const sorted = [...sessions].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));

    return sorted.map((session) => {
      const projectName = session.project_id ? projectNameById.get(session.project_id) ?? session.project_id : '对话';
      const preview = previews[session.id]?.text ?? '';
      return {
        session,
        projectName,
        preview,
        searchText: `${session.title} ${projectName} ${preview}`.toLowerCase(),
        updatedAt: Date.parse(session.updated_at) || 0,
      };
    });
  }, [previews, projectNameById, sessions]);

  const visibleItems = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) {
      return items.slice(0, MAX_RECENT_RESULTS);
    }
    return items.filter((item) => item.searchText.includes(trimmedQuery));
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex >= visibleItems.length) {
      setSelectedIndex(Math.max(visibleItems.length - 1, 0));
    }
  }, [selectedIndex, visibleItems.length]);

  const selectItem = (item: ChatSearchItem) => {
    onSelectSession(item.session.id, item.session.project_id ?? null);
    onOpenChange(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => visibleItems.length === 0 ? 0 : (index + 1) % visibleItems.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => visibleItems.length === 0 ? 0 : (index - 1 + visibleItems.length) % visibleItems.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = visibleItems[selectedIndex];
      if (selected) selectItem(selected);
      return;
    }

    if (event.key === 'Escape') {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18vh] w-[min(46rem,calc(100vw-2rem))] translate-y-0 gap-0 overflow-hidden rounded-2xl border border-[hsl(var(--surface-edge))]/90 p-0 shadow-[0_18px_46px_-30px_hsl(var(--surface-shadow-strong)/0.82)] sm:rounded-2xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>搜索聊天</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border/55 px-4 py-3 outline-none ring-0 focus-within:outline-none focus-within:ring-0">
          <Search className="h-4 w-4 shrink-0 text-foreground/42" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索聊天或运行命令"
            className="chat-search-input h-8 min-w-0 flex-1 border-0 bg-transparent text-ui-title text-foreground shadow-none outline-none ring-0 placeholder:text-foreground/42 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
          />
        </div>

        <div className="max-h-[min(28rem,calc(100vh-10rem))] overflow-y-auto px-1.5 py-2">
          <div className="px-2.5 pb-1.5 text-ui-meta font-medium text-foreground/55">聊天</div>
          {visibleItems.length > 0 ? (
            <div className="space-y-0.5">
              {visibleItems.map((item, index) => (
                <button
                  key={item.session.id}
                  type="button"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => selectItem(item)}
                  className={cn(
                    'grid h-15 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-3 text-left transition-colors duration-120',
                    index === selectedIndex
                      ? 'bg-foreground/[0.075] text-foreground dark:bg-foreground/[0.105]'
                      : 'text-foreground/82 hover:bg-foreground/[0.055] hover:text-foreground',
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate text-ui-compact font-semibold leading-5">{item.session.title || '新对话'}</div>
                    <div className="truncate text-ui-meta leading-5 text-foreground/48">
                      {item.preview || '暂无消息预览'}
                    </div>
                  </div>
                  <span className="max-w-26 truncate text-ui-meta text-foreground/45">{item.projectName}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-8 text-center text-sm text-foreground/48">没有匹配的聊天</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function loadFirstUserMessage(session: Session): Promise<string> {
  try {
    const page = await daemonFacade.getTimeline(session.id, { direction: 'tail', limit: 200 });

    for (const raw of page.events ?? []) {
      const rawMsg = raw as Record<string, unknown>;
      const event = isCodeMuxPersistedTimelineEvent(rawMsg)
        ? parseAgentEvent(rawMsg)
        : mapPersistedClaudeMessage(rawMsg, session.agent_kind);
      if (event?.kind === 'user') {
        return truncatePreview(event.data.content);
      }
    }
  } catch {
    return '';
  }

  return '';
}

function truncatePreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= PREVIEW_LIMIT) {
    return compact;
  }
  return `${compact.slice(0, PREVIEW_LIMIT - 1)}…`;
}
