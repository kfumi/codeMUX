import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

import { ProviderBrandIcon } from '@/components/settings/ProviderBrandIcon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ModelProvider } from '@/types/provider';

type AddProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (provider: ModelProvider) => Promise<void>;
};

export function buildCustomProvider(input: {
  name: string;
  apiKey: string;
  openaiUrl: string;
  anthropicUrl: string;
}): ModelProvider {
  const endpoints = [];
  if (input.anthropicUrl.trim()) {
    endpoints.push({
      protocol: 'anthropic' as const,
      base_url: input.anthropicUrl.trim(),
      api_key_override: null,
      codex_needs_proxy: null,
    });
  }
  if (input.openaiUrl.trim()) {
    endpoints.push({
      protocol: 'openai_compatible' as const,
      base_url: input.openaiUrl.trim(),
      api_key_override: null,
      codex_needs_proxy: true,
    });
  }

  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    enabled: false,
    api_key: input.apiKey.trim(),
    endpoints,
    models: [],
    default_model: '',
    builtin_template_id: null,
    opencode_provider_key: 'codemux-openai',
    opencode_npm: '@ai-sdk/openai-compatible',
  };
}

export function AddProviderDialog({ open, onOpenChange, onSubmit }: AddProviderDialogProps) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [openaiUrl, setOpenaiUrl] = useState('');
  const [anthropicUrl, setAnthropicUrl] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName('');
    setApiKey('');
    setOpenaiUrl('');
    setAnthropicUrl('');
    setShowApiKey(false);
    setSubmitting(false);
  }

  async function handleAdd() {
    if (!name.trim()) {
      toast.error('请填写提供商名称');
      return;
    }
    if (!openaiUrl.trim() && !anthropicUrl.trim()) {
      toast.error('至少填写一个 API 地址');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(
        buildCustomProvider({
          name,
          apiKey,
          openaiUrl,
          anthropicUrl,
        }),
      );
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加自定义供应商</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="flex justify-center pt-1">
            <ProviderBrandIcon
              name={name.trim() || 'P'}
              className="h-12 w-12 text-base"
              size={28}
            />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">
              提供商名称 <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 OpenAI"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">API 密钥</label>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入 API 密钥"
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 text-muted-foreground"
                onClick={() => setShowApiKey((value) => !value)}
                aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="grid gap-3">
            <label className="text-sm font-medium">端点设置</label>
            <div className="grid gap-2 rounded-lg border border-border/60 p-3">
              <div className="text-xs font-medium text-muted-foreground">OpenAI 兼容</div>
              <Input
                value={openaiUrl}
                onChange={(event) => setOpenaiUrl(event.target.value)}
                placeholder="https://example.com"
              />
              <p className="text-[11px] text-muted-foreground">
                填写根地址即可，请求时会自动拼接 /v1/...
              </p>
            </div>
            <div className="grid gap-2 rounded-lg border border-border/60 p-3">
              <div className="text-xs font-medium text-muted-foreground">Anthropic</div>
              <Input
                value={anthropicUrl}
                onChange={(event) => setAnthropicUrl(event.target.value)}
                placeholder="https://example.com"
              />
              <p className="text-[11px] text-muted-foreground">
                填写根地址即可，请求时会自动拼接 /v1/messages
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void handleAdd()}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
