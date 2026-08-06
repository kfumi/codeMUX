import { Bot, Layers3 } from 'lucide-react';

import { AgentPreferencesPanel } from './AgentSettings';
import { RuntimeSettingsPanel } from './RuntimeSettings';

interface AgentRuntimeSettingsPanelProps {
  onOpenSystemTools?: () => void;
}

/**
 * 智能体设置的统一入口。
 *
 * 偏好设置和托管 Runtime 在同一页呈现，但仍保持各自独立的内部模块：
 * 偏好模块负责会话配置，Runtime 模块负责 SDK 生命周期。
 */
export function AgentRuntimeSettingsPanel({
  onOpenSystemTools,
}: AgentRuntimeSettingsPanelProps) {
  return (
    <div className="space-y-10">
      <section className="rounded-2xl border border-[hsl(var(--primary)/0.16)] bg-[hsl(var(--primary)/0.035)] p-5">
        <div className="mb-5 flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-ui-heading-sm font-semibold text-foreground">引擎偏好</h3>
            <p className="mt-1 text-ui-compact leading-relaxed text-muted-foreground">
              选择默认智能体并配置会话权限。下面的托管 Runtime 决定智能体是否具备实际运行能力。
            </p>
          </div>
        </div>
        <AgentPreferencesPanel />
      </section>

      <section className="space-y-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/60">
            <Layers3 className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-ui-heading-sm font-semibold text-foreground">托管 SDK Runtime</h3>
            <p className="mt-1 text-ui-compact leading-relaxed text-muted-foreground">
              CodeMUX 使用的 SDK 和 CLI 均来自这里，不会因系统全局 CLI 的安装状态而改变。
            </p>
          </div>
        </div>
        <RuntimeSettingsPanel onOpenSystemTools={onOpenSystemTools} />
      </section>
    </div>
  );
}
