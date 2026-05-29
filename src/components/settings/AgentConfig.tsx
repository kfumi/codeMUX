import { useState, useEffect } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Save, CheckCircle, Eye, EyeOff } from 'lucide-react';

const STORAGE_KEY_ANTHROPIC_KEY = 'agent-anthropic-api-key';

export function AgentConfig() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success'>('idle');

  useEffect(() => {
    setApiKey(localStorage.getItem(STORAGE_KEY_ANTHROPIC_KEY) || '');
  }, []);

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY_ANTHROPIC_KEY, apiKey);
    setSaveStatus('success');
    setTimeout(() => setSaveStatus('idle'), 2000);
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium">智能体配置</h3>
      <p className="text-sm text-muted-foreground">
        智能体使用 Claude Code 的配置（模型、API 端点等）。
        如需自定义 API Key，可在此设置。
      </p>

      <div className="space-y-2">
        <label className="text-sm">API Key（可选）</label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="留空则使用 Claude Code 的认证"
          />
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          留空时使用 Claude Code 的本地认证（推荐）
        </p>
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
