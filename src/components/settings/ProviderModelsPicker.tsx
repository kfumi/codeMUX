import { useMemo, useState } from 'react';
import { Loader2, Minus, Plus, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { resolveModelDisplayName } from '@/lib/providerModels';
import { inferDefaultInputModalities } from '@/lib/inputModalities';
import { cn } from '@/lib/utils';
import type { InputModality, ProviderModel } from '@/types/provider';

export type PickerModel = {
  id: string;
  name: string;
  input_modalities?: InputModality[] | null;
};

type ProviderModelsPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  loading?: boolean;
  source: 'api' | 'builtin' | 'empty';
  catalog: PickerModel[];
  selected: ProviderModel[];
  onChangeSelected: (models: ProviderModel[]) => void;
};

export function ProviderModelsPicker({
  open,
  onOpenChange,
  title,
  loading = false,
  source,
  catalog,
  selected,
  onChangeSelected,
}: ProviderModelsPickerProps) {
  const [search, setSearch] = useState('');
  const selectedIds = useMemo(
    () => new Set(selected.map((model) => model.id.trim()).filter(Boolean)),
    [selected],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (model) =>
        model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q),
    );
  }, [catalog, search]);

  function addModel(model: PickerModel) {
    if (selectedIds.has(model.id)) return;
    onChangeSelected([
      ...selected,
      {
        id: model.id,
        name: resolveModelDisplayName(model),
        input_modalities: inferDefaultInputModalities(model.id, model.input_modalities),
      },
    ]);
  }

  function removeModel(modelId: string) {
    onChangeSelected(selected.filter((model) => model.id.trim() !== modelId));
  }

  function addAll() {
    const merged = new Map(
      selected
        .filter((model) => model.id.trim())
        .map((model) => [model.id.trim(), model] as const),
    );
    for (const model of filtered) {
      if (!merged.has(model.id)) {
        merged.set(model.id, {
          id: model.id,
          name: resolveModelDisplayName(model),
          input_modalities: inferDefaultInputModalities(model.id, model.input_modalities),
        });
      }
    }
    onChangeSelected(Array.from(merged.values()));
  }

  const sourceLabel =
    source === 'api' ? '来自接口' : source === 'builtin' ? '系统内置' : '无可用模型';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch('');
        onOpenChange(next);
      }}
    >
      <DialogContent
        overlayClassName="z-[240]"
        className={cn(
          'fixed inset-y-0 right-0 left-auto top-0 z-[240] flex h-full w-full max-w-md translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l border-r-0 p-0 shadow-xl sm:max-w-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          'data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100',
        )}
      >
        <DialogHeader className="space-y-0 border-b border-border/60 px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-2 pr-8">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">
                {title}
                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {catalog.length}
                </span>
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {loading ? '正在获取模型…' : sourceLabel}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-xs"
              disabled={loading || filtered.length === 0}
              onClick={addAll}
            >
              添加全部模型
            </Button>
          </div>
        </DialogHeader>

        <div className="border-b border-border/60 px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索模型..."
              className="h-9 pl-8"
              disabled={loading}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在获取模型列表
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground">
              <X className="mb-1 h-4 w-4 opacity-50" />
              {catalog.length === 0 ? '暂无可添加的模型' : '无匹配模型'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((model) => {
                const added = selectedIds.has(model.id);
                return (
                  <div
                    key={model.id}
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors',
                      added ? 'bg-emerald-500/10' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {resolveModelDisplayName(model)}
                      </div>
                      <div className="truncate text-ui-caption text-muted-foreground">{model.id}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'h-8 w-8 shrink-0 p-0',
                        added
                          ? 'text-emerald-600 hover:text-emerald-700'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      aria-label={added ? `移除 ${model.id}` : `添加 ${model.id}`}
                      onClick={() => (added ? removeModel(model.id) : addModel(model))}
                    >
                      {added ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
