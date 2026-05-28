import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { configApi } from '../../lib/tauri';
import type { ProviderConfig as ProviderConfigType } from '../../types/provider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Save, TestTube, Loader2, CheckCircle, XCircle } from 'lucide-react';

export function ProviderConfig() {
  const { config, updateProvider } = useSettingsStore();
  const activeProvider = config?.providers.find(
    (p) => p.id === config.active_provider_id
  );

  const [formData, setFormData] = useState<Partial<ProviderConfigType>>(
    activeProvider || {}
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  if (!activeProvider) {
    return <div>未配置供应商</div>;
  }

  const handleSave = async () => {
    if (!formData.id) return;
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      await updateProvider({ ...activeProvider, ...formData } as ProviderConfigType);
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestStatus('idle');
    setTestMessage('');
    try {
      const provider = { ...activeProvider, ...formData } as ProviderConfigType;
      const response = await configApi.testConnection(provider);
      setTestStatus('success');
      setTestMessage(`连接成功: ${response.slice(0, 100)}`);
      setTimeout(() => setTestStatus('idle'), 5000);
    } catch (err) {
      setTestStatus('error');
      setTestMessage(`连接失败: ${err}`);
      setTimeout(() => setTestStatus('idle'), 5000);
    } finally {
      setIsTesting(false);
    }
  };

  const getSaveButtonContent = () => {
    if (isSaving) return <><Loader2 className="h-4 w-4 animate-spin" />保存中...</>;
    if (saveStatus === 'success') return <><CheckCircle className="h-4 w-4" />已保存</>;
    if (saveStatus === 'error') return <><XCircle className="h-4 w-4" />保存失败</>;
    return <><Save className="h-4 w-4" />保存</>;
  };

  const getTestButtonContent = () => {
    if (isTesting) return <><Loader2 className="h-4 w-4 animate-spin" />测试中...</>;
    if (testStatus === 'success') return <><CheckCircle className="h-4 w-4" />连接成功</>;
    if (testStatus === 'error') return <><XCircle className="h-4 w-4" />连接失败</>;
    return <><TestTube className="h-4 w-4" />测试连接</>;
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
        <Button
          onClick={handleSave}
          disabled={isSaving}
          variant={saveStatus === 'error' ? 'destructive' : 'default'}
          className="flex items-center gap-2"
        >
          {getSaveButtonContent()}
        </Button>
        <Button
          variant={testStatus === 'error' ? 'destructive' : 'outline'}
          onClick={handleTest}
          disabled={isTesting}
          className="flex items-center gap-2"
        >
          {getTestButtonContent()}
        </Button>
      </div>
      {testMessage && (
        <p className={`text-sm ${testStatus === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {testMessage}
        </p>
      )}
    </div>
  );
}
