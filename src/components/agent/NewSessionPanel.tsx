import { ArrowUp, FolderKanban, Loader2 } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';

import { cn } from '../../lib/utils';
import { useNewSessionStore } from '../../stores/newSessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { getAgentDefinition } from '../../types/agentRegistry';
import { AgentSelector } from './AgentSelector';

interface NewSessionPanelProps {
  onSubmit: (message: string) => Promise<void> | void;
}

const STARTER_PROMPTS = [
  '帮我梳理这个项目的结构和关键入口',
  '修复当前项目里最明显的报错或异常',
  '根据现有代码生成一个实施计划',
];

export function NewSessionPanel({ onSubmit }: NewSessionPanelProps) {
  const { selectedAgentKind, setSelectedAgentKind, draftProjectId } = useNewSessionStore();
  const projects = useProjectStore((state) => state.projects);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedAgent = getAgentDefinition(selectedAgentKind);
  const draftProject = useMemo(
    () => projects.find((project) => project.id === draftProjectId) ?? null,
    [draftProjectId, projects],
  );
  const placeholder = useMemo(() => {
    const label = selectedAgent?.label ?? 'Claude Code';
    return `给 ${label} 发送消息...`;
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
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-14 h-56 w-56 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.15),transparent_70%)] blur-3xl" />
        <div className="absolute left-[16%] top-[26%] h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(236,122,73,0.10),transparent_72%)] blur-3xl dark:bg-[radial-gradient(circle,rgba(236,122,73,0.16),transparent_72%)]" />
        <div className="absolute right-[16%] top-[30%] h-44 w-44 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.08),transparent_74%)] blur-3xl" />
      </div>

      <div className="relative flex w-full max-w-5xl flex-col items-center gap-9">
        <div className="flex flex-col items-center gap-5 text-center animate-fade-in-up">
          <span
            className="rounded-full border border-border/50 bg-background/75 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground shadow-[0_8px_24px_-18px_hsl(var(--foreground)/0.28)] backdrop-blur"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            New Session
          </span>

          <div className="relative mx-auto inline-flex">
            <AgentSelector
              value={selectedAgentKind}
              onChange={setSelectedAgentKind}
              variant="floating"
            />
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
              开始新对话
            </h1>
            <p className="mx-auto max-w-2xl text-sm leading-7 text-muted-foreground sm:text-[15px]">
              选择合适的编码智能体，给出你的第一条任务指令，
              让这次会话从更清晰的上下文开始。
            </p>
          </div>

          {draftProject && (
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-[hsl(var(--primary)/0.14)] bg-[hsl(var(--primary)/0.06)] px-4 py-2 text-sm text-foreground shadow-[0_10px_24px_-18px_hsl(var(--primary)/0.38)]">
              <FolderKanban className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" />
              <span className="shrink-0 text-muted-foreground">当前关联项目</span>
              <span className="max-w-[280px] truncate font-medium">{draftProject.name}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => setMessage(prompt)}
                className="rounded-full border border-border/45 bg-background/72 px-4 py-2 text-sm text-muted-foreground transition-all duration-200 hover:border-[hsl(var(--primary)/0.22)] hover:bg-[hsl(var(--primary)/0.05)] hover:text-foreground"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full max-w-3xl animate-fade-in-up" style={{ animationDelay: '0.08s' }}>
          <div className="relative overflow-hidden rounded-[32px] border border-border/50 bg-[linear-gradient(180deg,hsl(var(--background))/0.96,hsl(var(--background))/0.84)] p-4 shadow-[0_30px_80px_-42px_hsl(var(--foreground)/0.28)] backdrop-blur-2xl transition-all duration-200 focus-within:border-[hsl(var(--primary)/0.24)] focus-within:shadow-[0_30px_80px_-38px_hsl(var(--primary)/0.22)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,hsl(var(--primary)/0.24),transparent)]" />

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="min-h-[156px] w-full resize-none border-0 bg-transparent px-4 py-4 text-left text-[15px] leading-8 text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground/54 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none"
              disabled={isSubmitting}
            />

            <div className="flex items-center justify-between gap-3 border-t border-border/40 px-2 pt-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span
                  className="rounded-full border border-border/45 bg-background/74 px-2.5 py-1 font-medium uppercase tracking-[0.18em]"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {selectedAgent?.label ?? 'Claude Code'}
                </span>
                {draftProject && (
                  <span className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-border/45 bg-background/74 px-2.5 py-1">
                    <FolderKanban className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{draftProject.name}</span>
                  </span>
                )}
                <span>Enter 发送，Shift + Enter 换行</span>
              </div>

              <button
                type="button"
                aria-label="发送消息"
                onClick={() => void handleSubmit()}
                disabled={!message.trim() || isSubmitting}
                className={cn(
                  'inline-flex h-12 min-w-[48px] items-center justify-center rounded-2xl px-4 transition-all duration-200',
                  message.trim() && !isSubmitting
                    ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] shadow-[0_14px_28px_-18px_hsl(var(--foreground)/0.55)] hover:scale-[1.02] hover:shadow-[0_18px_34px_-16px_hsl(var(--foreground)/0.45)] dark:bg-[#E8E8E8] dark:text-[#090909] dark:hover:bg-white'
                    : 'cursor-not-allowed bg-muted text-muted-foreground/50',
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
        </div>
      </div>
    </div>
  );
}
