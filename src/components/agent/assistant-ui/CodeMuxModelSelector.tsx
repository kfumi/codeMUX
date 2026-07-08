import { useAui } from '@assistant-ui/react';
import { Check, ChevronDown } from 'lucide-react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
  const selectedModel = value || normalizedModels[0] || '';
  const normalizedProviders = useMemo(() => providers.filter((provider) => provider.id.trim()), [providers]);
  const selectedProviderId = providerId || normalizedProviders[0]?.id || null;
  const selectedModelDisplayName = selectedModel ? getDisplayName(selectedModel) : '';
  const selectedEffortName = EFFORT_OPTIONS.find((option) => option.id === reasoningEffort)?.name;

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
      const openUpward = availableBelow < MIN_PANEL_HEIGHT && availableAbove > availableBelow;

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
          className="surface-panel fixed z-160 flex flex-col overflow-hidden rounded-xl border border-border/70 bg-popover/98 p-0 text-popover-foreground shadow-[0_18px_48px_-24px_hsl(var(--foreground)/0.34)] backdrop-blur-md"
          style={{
            ...(position.side === 'top' ? { bottom: position.bottom } : { top: position.top }),
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
        >
          {normalizedProviders.length > 1 ? (
            <div
              role="listbox"
              aria-label="Providers"
              data-slot="provider-selector-list"
              className="max-h-36 flex-none overflow-y-auto border-b border-border/62 p-1.5"
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
                      'relative flex w-full items-center rounded-lg py-2 pl-3 pr-9 text-left text-sm outline-none transition-colors hover:bg-muted/56 focus:bg-muted/56',
                      active ? 'text-foreground' : 'text-foreground/76',
                    )}
                  >
                    <span className="truncate font-medium">{provider.name}</span>
                    {active ? (
                      <span className="absolute right-3 flex h-4 w-4 items-center justify-center">
                        <Check className="h-4 w-4" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div
            role="listbox"
            aria-label="Models"
            data-slot="model-selector-list"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {normalizedModels.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">未找到模型</div>
            ) : (
              normalizedModels.map((model) => {
                const displayName = getDisplayName(model);
                return (
                  <button
                    key={model}
                    type="button"
                    role="option"
                    aria-selected={model === selectedModel}
                    data-slot="model-selector-item"
                    onClick={() => handleModelSelect(model)}
                    className={cn(
                      'relative flex w-full items-center rounded-lg py-2 pl-3 pr-9 text-left text-sm outline-none transition-colors hover:bg-muted/56 focus:bg-muted/56',
                      model === selectedModel ? 'text-foreground' : 'text-foreground/82',
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{displayName}</span>
                    </span>
                    {model === selectedModel ? (
                      <span className="absolute right-3 flex h-4 w-4 items-center justify-center">
                        <Check className="h-4 w-4" />
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div data-slot="model-selector-effort" className="flex flex-none items-center justify-between gap-3 border-t border-border/62 px-3 py-2">
            <span className="text-xs text-muted-foreground">推理强度</span>
            <div role="group" aria-label="Thinking" className="flex items-center gap-0.5">
              {EFFORT_OPTIONS.map((option) => {
                const active = option.id === reasoningEffort;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onReasoningEffortChange?.(option.id)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                      active
                        ? 'bg-muted text-foreground font-medium'
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
          'inline-flex h-8 max-w-72 items-center justify-between gap-2 overflow-hidden rounded-md border-border/45 bg-[hsl(var(--surface-2))]/64 px-2.5 py-1 text-xs text-foreground/88 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'min-w-0' : 'min-w-40',
          className,
        )}
      >
        <span data-slot="model-selector-value" className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{selectedModelDisplayName || '选择模型'}</span>
          {!compact && selectedEffortName ? (
            <span className="truncate text-muted-foreground">{selectedEffortName}</span>
          ) : null}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
      {panel}
    </>
  );
}
