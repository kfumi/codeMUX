import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DEFAULT_IMAGE_RECOGNITION_CONFIG,
  type ImageRecognitionConfig,
} from '@/types/provider';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsRow';

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
    <div className="space-y-8">
      <SettingsSection label="图片识别">
        <SettingsCard>
          <SettingsRow
            inlineControl
            label="启用图片识别"
            description="会话模型不支持图片时，自动调用解析模型读图"
            control={
              <Switch
                aria-label="启用图片识别"
                checked={imageRecognition.enabled}
                onCheckedChange={(checked) => {
                  updateConfig({ enabled: checked });
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="解析服务">
        <SettingsCard>
          <SettingsRow
            stacked
            htmlFor="image-recognition-api-key"
            label="API 密钥"
            control={
              <div className="relative">
                <Input
                  id="image-recognition-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  className="h-8 pr-10"
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
            }
          />

          <SettingsRow
            stacked
            htmlFor="image-recognition-base-url"
            label="API 地址"
            control={
              <Input
                id="image-recognition-base-url"
                className="h-8"
                value={imageRecognition.base_url}
                placeholder="https://open.bigmodel.cn/api/paas/v4"
                disabled={!imageRecognition.enabled}
                onChange={(event) => updateConfig({ base_url: event.target.value })}
              />
            }
          />

          <SettingsRow
            stacked
            label="解析模型"
            description="需为支持 vision 的多模态模型"
            control={
              <Input
                id="image-recognition-model"
                className="h-8"
                value={imageRecognition.model}
                placeholder="例如 glm-4.6v-flash"
                disabled={!imageRecognition.enabled}
                onChange={(event) => updateConfig({ model: event.target.value })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
