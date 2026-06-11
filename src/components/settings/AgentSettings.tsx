import { Check, Sparkles, CircleDot, Play, Square } from 'lucide-react';

import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { AGENT_REGISTRY } from '../../types/agentRegistry';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';

const SELECTABLE_AGENTS = AGENT_REGISTRY.filter((agent) => agent.capabilities.length > 0);

export function AgentSettingsPanel() {
  const { config, getDefaultAgentKind, setDefaultAgentKind, proxyRunning, proxyUrl, startProxy, stopProxy } = useSettingsStore();
  const selectedKind = config?.agent_defaults.default_agent_kind ?? getDefaultAgentKind();

  // Determine if the active provider needs a compat proxy for codex
  const activeProvider = config?.providers.find((p) => p.id === config.active_provider_id) ?? null;
  const codexBaseUrl = activeProvider?.openai_base_url ?? '';
  const needsProxy = codexBaseUrl && (() => {
    try { return new URL(codexBaseUrl).host.toLowerCase() !== 'api.openai.com'; } catch { return true; }
  })();

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">默认智能体</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          选择新建对话时默认预选的智能体，侧边栏和空状态输入区都会使用这里的设置。
        </p>
      </div>

      <div className="grid gap-3">
        {SELECTABLE_AGENTS.map((agent) => {
          const isSelected = agent.kind === selectedKind;

          return (
            <button
              key={agent.kind}
              type="button"
              onClick={() => void setDefaultAgentKind(agent.kind)}
              className={cn(
                'group flex items-start justify-between gap-4 rounded-2xl border px-4 py-4 text-left transition-all duration-200',
                isSelected
                  ? 'border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.06)] shadow-[0_16px_34px_-30px_hsl(var(--primary)/0.55)]'
                  : 'border-border/55 bg-background hover:border-border hover:bg-muted/25',
              )}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/45 bg-background/78">
                  <AgentBrandIcon agent={agent} size="md" />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{agent.label}</span>
                    {agent.kind === 'claude_code' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        <Sparkles className="h-3 w-3" />
                        默认
                      </span>
                    )}
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">{agent.description}</p>
                </div>
              </div>

              <span
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors',
                  isSelected
                    ? 'border-[hsl(var(--primary)/0.22)] bg-[hsl(var(--primary)/0.14)] text-[hsl(var(--primary))]'
                    : 'border-border/55 text-transparent group-hover:text-muted-foreground/40',
                )}
                aria-hidden="true"
              >
                <Check className="h-4 w-4" />
              </span>
            </button>
          );
        })}
      </div>

      {needsProxy && (
        <div className="space-y-3 rounded-2xl border border-border/45 bg-muted/15 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                {proxyRunning ? (
                  <CircleDot className="h-4 w-4 text-green-500" />
                ) : (
                  <CircleDot className="h-4 w-4 text-muted-foreground" />
                )}
                本地代理路由
              </h4>
              <p className="text-xs leading-5 text-muted-foreground">
                {proxyRunning
                  ? <>运行中 · {proxyUrl || '等待地址...'}</>
                  : '未运行 · Codex 需要代理将 Responses API 转换为 Chat Completions'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void (proxyRunning ? stopProxy() : startProxy())}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                proxyRunning
                  ? 'border-red-500/30 bg-red-500/08 text-red-500 hover:bg-red-500/15'
                  : 'border-green-500/30 bg-green-500/08 text-green-500 hover:bg-green-500/15',
              )}
            >
              {proxyRunning ? (
                <><Square className="h-3 w-3" /> 停止</>
              ) : (
                <><Play className="h-3 w-3" /> 启动</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
