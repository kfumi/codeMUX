import { ArrowUp, GripVertical, Pencil, Trash2, Play } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { queuedRunNowHint, normalizeImmediateRunMode } from '../../../lib/agentSteer';
import { useIsNarrowViewport } from '../../../hooks/useIsNarrowViewport';
import { useAgentStore } from '../../../stores/agentStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { QueuedAgentQuery } from '../../../types/agentQueue';
import { cn } from '../../../lib/utils';
import { TooltipHint } from '../../ui/tooltip';

interface QueuedMessagesProps {
  sessionId: string;
  onEdit: (query: QueuedAgentQuery) => void | Promise<void>;
}

const EMPTY_QUEUED_QUERIES: QueuedAgentQuery[] = [];

export function QueuedMessages({ sessionId, onEdit }: QueuedMessagesProps) {
  const queuedQueries = useAgentStore((state) => state.queuedQueries[sessionId] ?? EMPTY_QUEUED_QUERIES);
  const queuePaused = useAgentStore((state) => state.queuePaused[sessionId] ?? false);
  const removeQueuedQuery = useAgentStore((state) => state.removeQueuedQuery);
  const reorderQueuedQuery = useAgentStore((state) => state.reorderQueuedQuery);
  const resumeQueuedQueries = useAgentStore((state) => state.resumeQueuedQueries);
  const clearQueuedQueries = useAgentStore((state) => state.clearQueuedQueries);
  const runQueuedQueryNow = useAgentStore((state) => state.runQueuedQueryNow);
  const agentKind = useSessionStore((state) => (
    state.sessions.find((session) => session.id === sessionId)
    ?? state.archivedSessions.find((session) => session.id === sessionId)
  )?.agent_kind);
  const immediateRunMode = useSettingsStore((state) => normalizeImmediateRunMode(state.config?.immediate_run_mode));
  const runNowHint = queuedRunNowHint(agentKind, immediateRunMode);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<{
    x: number;
    y: number;
    width: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!draggedId) {
      return;
    }

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      setDragPosition((current) => current
        ? {
            ...current,
            x: event.clientX - current.offsetX,
            y: event.clientY - current.offsetY,
          }
        : current);
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const row = element?.closest<HTMLElement>('[data-queued-message-id]');
      const nextId = row?.dataset.queuedMessageId;
      if (nextId) {
        setDragOverId(nextId);
      }
    };

    const handlePointerUp = () => {
      if (dragOverId && dragOverId !== draggedId) {
        const targetIndex = queuedQueries.findIndex((query) => query.id === dragOverId);
        if (targetIndex >= 0) {
          reorderQueuedQuery(sessionId, draggedId, targetIndex);
        }
      }
      setDraggedId(null);
      setDragOverId(null);
      setDragPosition(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragOverId, draggedId, queuedQueries, reorderQueuedQuery, sessionId]);

  if (queuedQueries.length === 0) {
    return null;
  }

  return (
    <>
      <div
        ref={panelRef}
        className="mx-auto mb-0 w-[calc(100%-1.5rem)] overflow-hidden rounded-t-2xl rounded-b-none border border-b-0 border-border/70 bg-[hsl(var(--surface-1))]/90 shadow-[0_16px_40px_-32px_hsl(var(--surface-shadow-strong)/0.6)]"
        data-testid="queued-messages"
      >
      <div className="flex items-center justify-between border-b border-border/45 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground/86">排队消息</span>
          <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {queuedQueries.length}
          </span>
          {queuePaused ? (
            <span className="text-[10px] text-muted-foreground">已暂停</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {queuePaused ? (
            <button
              type="button"
              onClick={() => resumeQueuedQueries(sessionId)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-foreground/72 transition-colors hover:bg-muted/70 hover:text-foreground"
              aria-label="继续执行排队消息"
            >
              <Play className="h-3 w-3" />
              <span>继续</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => clearQueuedQueries(sessionId)}
            className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            aria-label="清空排队消息"
          >
            清空
          </button>
        </div>
      </div>

        <div className="max-h-44 space-y-1 overflow-y-auto p-1.5">
          {queuedQueries.map((query, index) => (
            <QueuedMessageRow
              key={query.id}
              query={query}
              index={index}
              isDragging={draggedId === query.id}
              isDragOver={dragOverId === query.id}
              onDragStart={(event) => {
                const row = event.currentTarget.closest<HTMLElement>('[data-queued-message-id]');
                const rowRect = row?.getBoundingClientRect();
                const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 320;
                const offsetX = rowRect ? event.clientX - rowRect.left : 0;
                const offsetY = rowRect ? event.clientY - rowRect.top : 0;
                setDraggedId(query.id);
                setDragOverId(query.id);
                setDragPosition({
                  x: event.clientX - offsetX,
                  y: event.clientY - offsetY,
                  width: rowRect?.width ?? panelWidth - 24,
                  offsetX,
                  offsetY,
                });
              }}
              onEdit={() => onEdit(query)}
              onDelete={() => removeQueuedQuery(sessionId, query.id)}
              onRunNow={() => void runQueuedQueryNow(sessionId, query.id)}
              runNowHint={runNowHint}
            />
          ))}
        </div>
      </div>
      {draggedId && dragPosition ? (
        <QueuedMessageGhost
          query={queuedQueries.find((query) => query.id === draggedId)}
          style={{
            left: dragPosition.x,
            top: dragPosition.y,
            width: dragPosition.width,
          }}
        />
      ) : null}
    </>
  );
}

function QueuedMessageRow({
  query,
  index,
  isDragging,
  isDragOver,
  onDragStart,
  onEdit,
  onDelete,
  onRunNow,
  runNowHint,
}: {
  query: QueuedAgentQuery;
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEdit: () => void | Promise<void>;
  onDelete: () => void;
  onRunNow: () => void;
  runNowHint: string;
}) {
  // 窄屏没有 hover:操作簇常显(桌面是“变淡、悬停提亮”的降噪音设计)。
  const isNarrow = useIsNarrowViewport();
  const content = query.displayContent?.trim() || query.prompt.trim() || '空消息';
  const hasImages = (query.inputPayload?.attachments?.length ?? query.inputPayload?.images?.length ?? 0) > 0;

  return (
    <div
      data-queued-message-id={query.id}
      className={cn(
        'group flex items-center gap-1 rounded-xl border px-1.5 py-1.5 transition-colors',
        'border-border/45 bg-[hsl(var(--surface-2))]/72 hover:border-border/80 hover:bg-muted/38',
        isDragOver && 'border-primary/55 bg-primary/8',
        isDragging && 'opacity-45',
      )}
      data-testid={`queued-message-${index}`}
    >
      <button
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDragStart(event);
        }}
        className="cursor-grab touch-none rounded-md p-1 text-muted-foreground/45 hover:bg-muted/65 hover:text-muted-foreground active:cursor-grabbing"
        aria-label={`拖动第 ${index + 1} 条排队消息`}
        title="拖动调整顺序"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/55">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-xs text-foreground/82" title={content}>
        {content}
        {hasImages ? <span className="ml-1 text-[10px] text-muted-foreground">· 图片</span> : null}
      </span>
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity',
          isNarrow ? 'opacity-100' : 'opacity-70 group-hover:opacity-100',
        )}
      >
        <TooltipHint content={runNowHint}>
          <button
            type="button"
            onClick={onRunNow}
            className="inline-flex items-center gap-1 rounded-md border border-border/55 px-1.5 py-1 text-ui-meta text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/10 hover:text-primary"
            aria-label={`立即执行第 ${index + 1} 条排队消息`}
          >
            <ArrowUp className="h-3 w-3" />
            <span>立即</span>
          </button>
        </TooltipHint>
        <button
          type="button"
          onClick={() => void onEdit()}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/75 hover:text-foreground"
          aria-label={`编辑第 ${index + 1} 条排队消息`}
          title="编辑消息"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/12 hover:text-destructive"
          aria-label={`删除第 ${index + 1} 条排队消息`}
          title="删除消息"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function QueuedMessageGhost({
  query,
  style,
}: {
  query: QueuedAgentQuery | undefined;
  style: { left: number; top: number; width: number };
}) {
  if (!query) {
    return null;
  }

  const content = query.displayContent?.trim() || query.prompt.trim() || '空消息';
  const hasImages = (query.inputPayload?.attachments?.length ?? query.inputPayload?.images?.length ?? 0) > 0;

  return (
    <div
      className="pointer-events-none fixed z-100 flex items-center gap-2 rounded-xl border border-primary/55 bg-[hsl(var(--surface-1))]/96 px-2.5 py-2 text-xs text-foreground shadow-[0_18px_38px_-16px_hsl(var(--surface-shadow-strong)/0.78)] backdrop-blur-md"
      style={style}
      aria-hidden="true"
    >
      <GripVertical className="h-4 w-4 shrink-0 text-primary/75" />
      <span className="min-w-0 flex-1 truncate">
        {content}
        {hasImages ? <span className="ml-1 text-[10px] text-muted-foreground">· 图片</span> : null}
      </span>
    </div>
  );
}
