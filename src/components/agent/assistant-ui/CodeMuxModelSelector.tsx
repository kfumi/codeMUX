import { useAui } from '@assistant-ui/react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getPrimaryProviderModel, getProviderModelList } from '../../../lib/providerModels';
import { cn } from '../../../lib/utils';
import type { Provider } from '../../../types/provider';

type ReasoningEffort = 'low' | 'medium' | 'high';
type PanelPosition = {
  side: 'top' | 'bottom';
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

interface CodeMuxModelSelectorProps {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  providers?: Provider[];
  providerId?: string | null;
  onProviderChange?: (providerId: string, model: string) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  getDisplayName?: (model: string) => string;
  disabled?: boolean;
  className?: string;
  /** 紧凑模式：隐藏推理强度标签，缩短模型名显示 */
  compact?: boolean;
}

const EFFORT_OPTIONS: Array<{ id: ReasoningEffort; name: string }> = [
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
];
const PANEL_OFFSET = 6;
const VIEWPORT_PADDING = 24;
const MIN_PANEL_HEIGHT = 180;
const DEFAULT_PANEL_WIDTH = 288;
const STAGGER_CAP = 7;

export function CodeMuxModelSelector({
  value,
  models,
  onChange,
  providers = [],
  providerId,
  onProviderChange,
  reasoningEffort = 'medium',
  onReasoningEffortChange,
  getDisplayName = (model) => model,
  disabled,
  className,
  compact,
}: CodeMuxModelSelectorProps) {
  const api = useAui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<PanelPosition>({
    side: 'bottom',
    top: 0,
    left: 0,
    width: DEFAULT_PANEL_WIDTH,
    maxHeight: 320,
  });

  const normalizedModels = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((model) => {
      const trimmed = model.trim();
      if (!trimmed || seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    });
  }, [models]);

  const normalizedProviders = useMemo(
    () => providers.filter((provider) => provider.id.trim()),
    [providers],
  );

  const selectedModel = value || normalizedModels[0] || '';
  const selectedProviderId = providerId || normalizedProviders[0]?.id || null;
  const selectedProvider = useMemo(
    () => normalizedProviders.find((provider) => provider.id === selectedProviderId) ?? null,
    [normalizedProviders, selectedProviderId],
  );
  const selectedModelDisplayName = selectedModel ? getDisplayName(selectedModel) : '';
  const selectedEffortName = EFFORT_OPTIONS.find((option) => option.id === reasoningEffort)?.name;

  const filteredModels = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) return normalizedModels;
    return normalizedModels.filter((model) => {
      const display = getDisplayName(model).toLowerCase();
      return model.toLowerCase().includes(trimmedQuery) || display.includes(trimmedQuery);
    });
  }, [normalizedModels, query, getDisplayName]);

  // Keep assistant-ui's ModelContext in sync so the selection reaches the backend.
  useEffect(() => {
    if (!selectedModel) return;
    const config = {
      config: {
        modelName: selectedModel,
        reasoningEffort,
      },
    };
    return api.modelContext().register({
      getModelContext: () => config,
    });
  }, [api, selectedModel, reasoningEffort]);

  // Panel positioning — opens toward the side with more room. The selector lives
  // in the composer footer, so the chat area above is usually far taller than the
  // sliver below the trigger; this makes it open upward into that space instead of
  // collapsing into a single-row strip.
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || DEFAULT_PANEL_WIDTH;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
      const width = Math.min(Math.max(rect.width, DEFAULT_PANEL_WIDTH), Math.max(DEFAULT_PANEL_WIDTH, viewportWidth - 16));
      const left = Math.min(Math.max(rect.left, 8), Math.max(8, viewportWidth - width - 8));
      const availableBelow = viewportHeight - rect.bottom - VIEWPORT_PADDING;
      const availableAbove = rect.top - VIEWPORT_PADDING;
      const openUpward = availableAbove > availableBelow;

      if (openUpward) {
        setPosition({
          side: 'top',
          bottom: viewportHeight - rect.top + PANEL_OFFSET,
          left,
          width,
          maxHeight: Math.max(MIN_PANEL_HEIGHT, availableAbove),
        });
        return;
      }

      setPosition({
        side: 'bottom',
        top: rect.bottom + PANEL_OFFSET,
        left,
        width,
        maxHeight: Math.max(MIN_PANEL_HEIGHT, availableBelow),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  // Outside-click dismissal.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  // Focus the search field on open and reset it on close.
  useEffect(() => {
    if (!open) {
      if (query) setQuery('');
      return;
    }
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleModelSelect = (model: string) => {
    if (model !== selectedModel) {
      onChange(model);
    }
    setOpen(false);
  };

  const handleProviderSelect = (provider: Provider) => {
    if (!onProviderChange || provider.id === selectedProviderId) {
      return;
    }

    const nextModel = getPrimaryProviderModel(provider) || getProviderModelList(provider)[0] || '';
    onProviderChange(provider.id, nextModel);
  };

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          data-testid="model-selector-content"
          data-slot="model-selector-content"
          data-side={position.side}
          className={cn(
            'surface-panel fixed z-160 flex flex-col overflow-hidden rounded-xl border border-border/55 bg-popover/97 p-0 text-popover-foreground shadow-[0_18px_48px_-24px_hsl(var(--foreground)/0.34)] backdrop-blur-md',
            'animate-in fade-in-0 zoom-in-95 duration-150 fill-mode-both [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]',
            'dark:border-[hsl(var(--foreground)/0.06)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.97,hsl(var(--surface-1))/0.96)]',
          )}
          style={{
            ...(position.side === 'top' ? { bottom: position.bottom } : { top: position.top }),
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
        >
          {/* Search — hairline underline that warms to the accent on focus */}
          <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型…"
              aria-label="搜索模型"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:font-light placeholder:italic placeholder:text-muted-foreground/55 focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清除搜索"
                className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/55 transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          {/* Provider filter chips — only when more than one provider is configured */}
          {normalizedProviders.length > 1 ? (
            <div
              role="listbox"
              aria-label="Providers"
              data-slot="provider-selector-list"
              className="flex flex-wrap gap-1 border-b border-border/40 px-2.5 py-2"
            >
              {normalizedProviders.map((provider) => {
                const active = provider.id === selectedProviderId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => handleProviderSelect(provider)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium tracking-wide outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                      active
                        ? 'bg-foreground/[0.06] text-foreground dark:bg-foreground/[0.1]'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full transition-colors',
                        active ? 'bg-accent' : 'bg-transparent',
                      )}
                    />
                    <span className="truncate">{provider.name}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Model list — grouped under the active provider name */}
          <div
            role="listbox"
            aria-label={selectedProvider ? `${selectedProvider.name} · 模型` : 'Models'}
            data-slot="model-selector-list"
            key={selectedProviderId ?? 'default'}
            className="min-h-0 flex-1 overflow-y-auto p-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {selectedProvider && !query.trim() ? (
              <div
                aria-hidden="true"
                className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1.5"
              >
                <span className="size-1 rounded-full bg-accent/80" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                  {selectedProvider.name}
                </span>
              </div>
            ) : null}

            {filteredModels.length === 0 ? (
              <div className="px-3 py-7 text-center text-[13px] text-muted-foreground/70">
                {query.trim() ? '无匹配模型' : '未找到模型'}
              </div>
            ) : (
              filteredModels.map((model, index) => {
                const displayName = getDisplayName(model);
                const isSelected = model === selectedModel;
                const showSubline = displayName !== model;
                return (
                  <button
                    key={model}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-slot="model-selector-item"
                    onClick={() => handleModelSelect(model)}
                    style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * 26}ms` }}
                    className={cn(
                      'group relative flex w-full items-center gap-2.5 rounded-lg ps-3 pe-9 py-2 text-left outline-none transition-colors',
                      'animate-in fade-in-50 slide-in-from-left-1 duration-200 fill-mode-both',
                      'before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-transparent before:transition-colors',
                      isSelected
                        ? 'before:bg-accent bg-accent/[0.07] text-foreground'
                        : 'text-foreground/75 hover:bg-muted/45 hover:text-foreground focus-visible:bg-muted/45 focus-visible:text-foreground',
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="truncate text-[13px] font-medium">{displayName}</span>
                      {showSubline ? (
                        <span className="truncate font-mono text-[10.5px] leading-none text-muted-foreground/55">
                          {model}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <span className="absolute end-3 flex size-4 items-center justify-center text-accent">
                        <Check className="size-3.5" />
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          {/* Effort — segmented control with a floating active pill */}
          <div
            data-slot="model-selector-effort"
            className="flex flex-none items-center justify-between gap-3 border-t border-border/40 px-3 py-2"
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              推理强度
            </span>
            <div role="group" aria-label="Thinking" className="flex items-center rounded-md bg-muted/50 p-0.5">
              {EFFORT_OPTIONS.map((option) => {
                const active = option.id === reasoningEffort;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onReasoningEffortChange?.(option.id)}
                    className={cn(
                      'relative z-10 rounded-[5px] px-2.5 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                      active
                        ? 'bg-background text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.1)]'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        data-slot="model-selector-trigger"
        disabled={disabled || !selectedModel}
        onClick={() => setOpen((next) => !next)}
        className={cn(
          'inline-flex h-8 max-w-72 items-center gap-2 overflow-hidden rounded-lg bg-[hsl(var(--surface-2))]/70 ps-2.5 pe-2 text-[13px] text-foreground/90 transition-all hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'min-w-0' : 'min-w-40',
          className,
        )}
      >
        <span data-slot="model-selector-value" className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{selectedModelDisplayName || '选择模型'}</span>
          {!compact && selectedEffortName ? (
            <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-px text-[10px] font-semibold tracking-[0.08em] text-muted-foreground dark:bg-foreground/[0.1]">
              {selectedEffortName}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 opacity-40 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      {panel}
    </>
  );
}
