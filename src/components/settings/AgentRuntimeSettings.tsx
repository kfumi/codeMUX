import { Bot, Layers3 } from 'lucide-react';

import { AgentPreferencesPanel } from './AgentSettings';
import { RuntimeSettingsPanel } from './RuntimeSettings';

/**
 * 智能体设置的统一入口。
 *
 * 偏好设置和托管 Runtime 在同一页呈现，但仍保持各自独立的内部模块：
 * 偏好模块负责会话配置，Runtime 模块负责 SDK 生命周期。
 */
export function AgentRuntimeSettingsPanel() {
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
              默认智能体与新建会话的权限；托管 Runtime 决定它能不能真的跑起来
            </p>
          </div>
        </div>
        <AgentPreferencesPanel />
      </section>

      <section className="space-y-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
            <Layers3 className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-ui-heading-sm font-semibold text-foreground">托管 SDK Runtime</h3>
            <p className="mt-1 text-ui-compact leading-relaxed text-muted-foreground">
              CodeMUX 使用的 SDK 与 CLI 都来自这里，与系统全局 CLI 的安装状态无关
            </p>
          </div>
        </div>
        <RuntimeSettingsPanel />
      </section>
    </div>
  );
}
