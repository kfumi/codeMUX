import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ProviderConfig as ProviderConfigType } from '../../types/provider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Save, TestTube } from 'lucide-react';

export function ProviderConfig() {
  const { config } = useSettingsStore();
  const activeProvider = config?.providers.find(
    (p) => p.id === config.active_provider_id
  );

  const [formData, setFormData] = useState<Partial<ProviderConfigType>>(
    activeProvider || {}
  );

  if (!activeProvider) {
    return <div>未配置供应商</div>;
  }

  const handleSave = async () => {
    console.log('Save config:', formData);
  };

  const handleTest = async () => {
    console.log('Test connection');
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">供应商配置</h3>
      <p className="text-sm text-muted-foreground">配置 AI 服务提供商。</p>
      <div className="space-y-2">
        <label className="text-sm">API Key</label>
        <Input
          type="password"
          value={formData.api_key || ''}
          onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
          placeholder="输入 API Key"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm">API 端点</label>
        <Input
          value={formData.endpoint_url || ''}
          onChange={(e) => setFormData({ ...formData, endpoint_url: e.target.value })}
          placeholder="https://api.deepseek.com"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm">默认模型</label>
        <Input
          value={formData.default_model || ''}
          onChange={(e) => setFormData({ ...formData, default_model: e.target.value })}
          placeholder="deepseek-chat"
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} className="flex items-center gap-2">
          <Save className="h-4 w-4" />
          保存
        </Button>
        <Button variant="outline" onClick={handleTest} className="flex items-center gap-2">
          <TestTube className="h-4 w-4" />
          测试连接
        </Button>
      </div>
    </div>
  );
}
