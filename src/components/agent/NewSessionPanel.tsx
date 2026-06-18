import { ArrowUp, FileCode2, FolderKanban, Loader2, MessageSquareText, Sparkles } from 'lucide-react';
import { Cpu } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';

import { cn } from '../../lib/utils';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import { AgentSelector } from './AgentSelector';

interface NewSessionPanelProps {
  onSubmit: (message: string) => Promise<void> | void;
}

const STARTER_PROMPTS = [
  {
    title: '理解项目',
    prompt: '帮我梳理这个项目的结构和关键入口',
    icon: FolderKanban,
  },
  {
    title: '修复问题',
    prompt: '修复当前项目里最明显的报错或异常',
    icon: Sparkles,
  },
  {
    title: '生成计划',
    prompt: '根据现有代码生成一个实施计划',
    icon: FileCode2,
  },
];

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const { selectedAgentKind, setSelectedAgentKind, draftProjectId } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const activeProvider = useSettingsStore((s) => s.getActiveProvider());
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );
  const placeholder = useMemo(() => {
    const label = selectedAgent?.label ?? 'Claude Code';
    return `给 ${label} 发送第一条任务指令...`;
  }, [selectedAgent]);

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
      setMessage('');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="flex flex-1 overflow-auto bg-[hsl(var(--background))] transition-[background] duration-300">
      <div className="mx-auto flex w-full max-w-6xl flex-col justify-center gap-5 px-6 py-8 lg:px-10">
        <div className="grid min-h-[min(720px,calc(100vh-8rem))] gap-5 lg:grid-cols-[minmax(260px,0.84fr)_minmax(520px,1.36fr)]">
          <aside className="surface-panel surface-panel-muted flex animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[340ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] flex-col justify-between gap-5 rounded-xl border border-border/60 bg-card/76 p-5 dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.96,hsl(var(--surface-1))/0.9)]">
            <div className="space-y-6">
              <div className="space-y-3">
                <span
                  className="inline-flex rounded-md border border-border/55 bg-background/72 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  New Session
                </span>
                <div className="space-y-2">
                  <h1 className="text-[26px] font-semibold leading-tight text-foreground">
                    开始新的编码任务
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    选好模型，描述目标，让这次会话从清楚的上下文开始。
                  </p>
                </div>
              </div>

              <div className="surface-panel rounded-lg border border-border/55 bg-background/56 p-4 dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.86,hsl(var(--surface-2))/0.76)]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      Agent
                    </p>
                    <p className="truncate text-sm font-semibold text-foreground">
                      {selectedAgent?.label ?? 'Claude Code'}
                    </p>
                  </div>
                  <MessageSquareText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex justify-center py-2">
                  <AgentSelector value={selectedAgentKind} onChange={setSelectedAgentKind} variant="floating" />
                </div>
              </div>

              <div className="surface-panel rounded-lg border border-border/55 bg-background/56 p-4 dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.86,hsl(var(--surface-2))/0.76)]">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Model
                  </p>
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="truncate text-sm font-semibold text-foreground">
                  {activeProvider?.default_model || '未配置模型'}
                </p>
                {activeProvider?.name && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {activeProvider.name}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {draftProject ? (
                <div className="surface-panel rounded-lg border border-[hsl(var(--primary)/0.18)] bg-[hsl(var(--primary)/0.07)] p-3 dark:bg-[linear-gradient(180deg,hsl(var(--surface-glow))/0.12,hsl(var(--surface-2))/0.72)]">
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <FolderKanban className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" />
                    <span className="font-medium">当前关联项目</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">{draftProject.name}</p>
                </div>
              ) : (
                <div className="surface-panel rounded-lg border border-dashed border-border/70 bg-background/42 p-3 dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.72,hsl(var(--surface-1))/0.62)]">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FolderKanban className="h-4 w-4 shrink-0" />
                    <span>未绑定项目</span>
                  </div>
                </div>
              )}
              <div
                className="surface-panel rounded-lg border border-border/45 bg-background/42 px-3 py-2 text-[11px] text-muted-foreground dark:bg-[linear-gradient(180deg,hsl(var(--surface-3))/0.74,hsl(var(--surface-1))/0.64)]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Enter to send · Shift Enter for newline
              </div>
            </div>
          </aside>

          <section className="flex animate-in fade-in slide-in-from-right-3 fill-mode-both animation-duration-[420ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] flex-col gap-4" style={{ animationDelay: '0.06s' }}>
            <div className="grid gap-3 sm:grid-cols-3">
              {STARTER_PROMPTS.map(({ title, prompt, icon: Icon }) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setMessage(prompt)}
                  className="surface-panel surface-interactive group flex min-h-24 flex-col justify-between rounded-xl border border-border/55 bg-card/72 p-4 text-left dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.9,hsl(var(--surface-1))/0.82)]"
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground transition-colors group-hover:text-foreground dark:bg-[hsl(var(--surface-3))/0.8]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold text-foreground">{title}</span>
                    <span className="line-clamp-2 block text-xs leading-5 text-muted-foreground">{prompt}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="new-session-input surface-panel animate-in fade-in zoom-in-95 slide-in-from-bottom-2 fill-mode-both animation-duration-[340ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] flex flex-1 flex-col rounded-xl border border-border/60 bg-card dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.95,hsl(var(--surface-1))/0.88)]">
              <div className="flex items-center justify-between gap-3 border-b border-border/45 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">任务输入</p>
                  <p className="text-xs text-muted-foreground">
                    用自然语言描述你想让模型完成的第一步。
                  </p>
                </div>
                <span
                  className="surface-panel hidden rounded-md border border-border/45 bg-background/66 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground dark:bg-[hsl(var(--surface-3))/0.82] sm:inline-flex"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {selectedAgent?.label ?? 'Claude Code'}
                </span>
              </div>

              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="min-h-65 flex-1 resize-none border-0 bg-transparent px-5 py-5 text-left text-[15px] leading-7 text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground/54 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none"
                disabled={isSubmitting}
              />

              <div className="flex flex-col gap-3 border-t border-border/45 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {draftProject && (
                    <span className="surface-panel inline-flex max-w-60 items-center gap-1.5 rounded-md border border-border/45 bg-background/66 px-2.5 py-1 dark:bg-[hsl(var(--surface-3))/0.84]">
                      <FolderKanban className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{draftProject.name}</span>
                    </span>
                  )}
                  <span>准备好后直接发送，系统会自动创建会话。</span>
                </div>

                <button
                  type="button"
                  aria-label="发送消息"
                  onClick={() => void handleSubmit()}
                  disabled={!message.trim() || isSubmitting}
                  className={cn(
                    'inline-flex h-10 min-w-10 shrink-0 items-center justify-center rounded-lg px-3 transition-all duration-200',
                    message.trim() && !isSubmitting
                      ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] shadow-[0_14px_28px_-18px_hsl(var(--foreground)/0.55)] hover:scale-[1.02] hover:shadow-[0_18px_34px_-16px_hsl(var(--foreground)/0.45)] dark:bg-[hsl(var(--surface-glow))] dark:text-[hsl(var(--background))] dark:shadow-[0_16px_36px_-20px_hsl(var(--surface-glow)/0.55)] dark:hover:bg-[hsl(var(--surface-glow))/0.94] dark:hover:shadow-[0_22px_42px_-18px_hsl(var(--surface-glow)/0.48)]'
                      : 'cursor-not-allowed bg-muted text-muted-foreground/50 dark:bg-[hsl(var(--surface-3))/0.86]',
                  )}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                  )}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
