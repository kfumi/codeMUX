import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DEFAULT_IMAGE_RECOGNITION_CONFIG,
  type ImageRecognitionConfig,
} from '@/types/provider';

function buildImageRecognitionConfig(
  current: ImageRecognitionConfig | undefined,
  patch: Partial<ImageRecognitionConfig>,
): ImageRecognitionConfig {
  return {
    ...DEFAULT_IMAGE_RECOGNITION_CONFIG,
    ...current,
    ...patch,
  };
}

export function ImageRecognitionSettings() {
  const config = useSettingsStore((state) => state.config);
  const setAttachmentEnrichment = useSettingsStore((state) => state.setAttachmentEnrichment);
  const imageRecognition = config?.attachment_enrichment ?? DEFAULT_IMAGE_RECOGNITION_CONFIG;
  const [showApiKey, setShowApiKey] = useState(false);

  const updateConfig = (patch: Partial<ImageRecognitionConfig>) => {
    void setAttachmentEnrichment(buildImageRecognitionConfig(imageRecognition, patch));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/40 p-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground/90">启用图片识别</div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/60">
            当会话模型未勾选「视觉」输入模态时，自动调用下方配置的 vision 模型解析图片，并将结果注入对话上下文。
          </p>
        </div>
        <Switch
          aria-label="启用图片识别"
          checked={imageRecognition.enabled}
          onCheckedChange={(checked) => {
            updateConfig({ enabled: checked });
          }}
        />
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 p-4">
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="image-recognition-api-key">
            API 密钥
          </label>
          <div className="relative">
            <Input
              id="image-recognition-api-key"
              type={showApiKey ? 'text' : 'password'}
              className="h-9 pr-10"
              value={imageRecognition.api_key}
              placeholder={imageRecognition.api_key_configured ? '已配置（留空保持不变）' : '输入 API Key'}
              disabled={!imageRecognition.enabled}
              onChange={(event) => updateConfig({ api_key: event.target.value })}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'}
              onClick={() => setShowApiKey((current) => !current)}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="image-recognition-base-url">
            API 地址
          </label>
          <Input
            id="image-recognition-base-url"
            className="h-9"
            value={imageRecognition.base_url}
            placeholder="https://open.bigmodel.cn/api/paas/v4"
            disabled={!imageRecognition.enabled}
            onChange={(event) => updateConfig({ base_url: event.target.value })}
          />
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="image-recognition-model">
            解析模型
          </label>
          <Input
            id="image-recognition-model"
            className="h-9"
            value={imageRecognition.model}
            placeholder="例如 glm-4.6v-flash"
            disabled={!imageRecognition.enabled}
            onChange={(event) => updateConfig({ model: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            需为支持 vision 的多模态模型；会话模型若在编辑时已勾选「视觉」，则不会调用此配置。
          </p>
        </div>
      </div>
    </div>
  );
}
