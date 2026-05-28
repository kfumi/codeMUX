import { useState, useEffect } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Save, CheckCircle, Eye, EyeOff } from 'lucide-react';

const STORAGE_KEY_ANTHROPIC_KEY = 'agent-anthropic-api-key';
const STORAGE_KEY_ANTHROPIC_MODEL = 'agent-anthropic-model';

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (推荐)' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (最强)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (最快)' },
];

export function AgentConfig() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success'>('idle');

  useEffect(() => {
    setApiKey(localStorage.getItem(STORAGE_KEY_ANTHROPIC_KEY) || '');
    setModel(localStorage.getItem(STORAGE_KEY_ANTHROPIC_MODEL) || 'claude-sonnet-4-6');
  }, []);

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY_ANTHROPIC_KEY, apiKey);
    localStorage.setItem(STORAGE_KEY_ANTHROPIC_MODEL, model);
    setSaveStatus('success');
    setTimeout(() => setSaveStatus('idle'), 2000);
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">智能体配置</h3>
      <p className="text-sm text-muted-foreground">
        配置 Claude Agent SDK 的 API Key。此 Key 用于调用 Anthropic API 执行智能体任务。
      </p>

      <div className="space-y-2">
        <label className="text-sm">ANTHROPIC_API_KEY</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
            />
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          在 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="underline">Anthropic Console</a> 获取 API Key
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm">模型</label>
        <select
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <Button
        onClick={handleSave}
        className="flex items-center gap-2"
      >
        {saveStatus === 'success' ? (
          <><CheckCircle className="h-4 w-4" />已保存</>
        ) : (
          <><Save className="h-4 w-4" />保存</>
        )}
      </Button>
    </div>
  );
}
