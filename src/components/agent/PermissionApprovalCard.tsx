import { Check, Clock3, Info, Terminal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../../lib/utils';
import type { AgentPermissionRequest, AgentPermissionResponse } from '../../types/agent';

interface PermissionApprovalCardProps {
  request: AgentPermissionRequest;
  onResponse: (response: AgentPermissionResponse) => void | Promise<void>;
}

type PermissionMetadata = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getText(metadata: PermissionMetadata, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getPermissionCommand(request: AgentPermissionRequest): string | null {
  const metadata = request.metadata ?? {};
  const input = isRecord(metadata.input) ? metadata.input : null;
  const command = getText(metadata, 'command') ?? (input ? getText(input, 'command') : undefined);
  if (!command) return null;

  const cwd = getText(metadata, 'cwd');
  return cwd ? `cd ${cwd} && ${command}` : command;
}

export function PermissionApprovalCard({ request, onResponse }: PermissionApprovalCardProps) {
  const metadata = request.metadata ?? {};
  const isPlanApproval = request.permission_type === 'ExitPlanMode' || metadata.presentation === 'plan-approval';
  const [selectedResponse, setSelectedResponse] = useState<AgentPermissionResponse>('once');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const command = getPermissionCommand(request);
  const title = getText(metadata, 'title') ?? request.description;
  const options = isPlanApproval
    ? [{ response: 'once' as const, label: '批准', description: '退出计划模式并开始实施。' }]
    : [
        { response: 'once' as const, label: '允许', description: '仅允许这一次操作。' },
        { response: 'always' as const, label: '始终允许本项目', description: '后续相同命令不再询问。' },
        { response: 'reject' as const, label: '拒绝', description: '这次先拒绝。' },
      ];

  const focusOption = (index: number) => {
    const nextIndex = (index + options.length) % options.length;
    window.requestAnimationFrame(() => optionRefs.current[String(nextIndex)]?.focus());
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusOption(index + 1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusOption(index - 1);
      return;
    }
    if (event.key === 'Tab') {
      const nextIndex = event.shiftKey ? index - 1 : index + 1;
      if (nextIndex >= 0 && nextIndex < options.length) {
        event.preventDefault();
        focusOption(nextIndex);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedResponse(options[index].response);
    }
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResponse(selectedResponse);
    } finally {
      setSubmitting(false);
    }
  };

  const ignore = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResponse('reject');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-[hsl(var(--surface-2))]/94 p-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]" data-testid="permission-approval-card">
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded-md border border-border/65 px-2 py-0.5 text-xs font-medium text-foreground/82">需要权限</span>
        <span className="min-w-0 truncate text-foreground/85">{isPlanApproval ? '实施计划' : title}</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground/78">
        {isPlanApproval ? <Terminal className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
        <span>{isPlanApproval ? '等待批准' : '等待确认'}</span>
      </div>

      {command ? (
        <pre className="max-h-36 overflow-auto rounded-xl border border-border/40 bg-background/72 px-3 py-2.5 font-mono text-code leading-5 text-foreground/88 whitespace-pre-wrap break-words">
          <code>$ {command}</code>
        </pre>
      ) : null}

      <div className="space-y-1">
        {options.map((option, index) => {
          const active = selectedResponse === option.response;
          return (
            <button
              key={option.response}
              type="button"
              ref={(element) => { optionRefs.current[String(index)] = element; }}
              disabled={submitting}
              onClick={() => setSelectedResponse(option.response)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              autoFocus={index === 0}
              aria-pressed={active}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors',
                active
                  ? 'border-border/55 bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground',
                submitting && 'cursor-wait opacity-70',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35',
              )}
            >
              <span className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors',
                active ? 'bg-foreground text-background' : 'border border-muted-foreground/30 text-muted-foreground/75',
              )}>
                {index + 1}.
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 max-w-[58%] truncate whitespace-nowrap text-sm font-medium" title={option.label}>{option.label}</span>
                <span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs text-muted-foreground/72" title={option.description}>{option.description}</span>
              </span>
              {active ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>

      {isPlanApproval ? (
        <div className="rounded-lg border border-border/35 bg-background/45 p-0.5 transition-colors focus-within:border-foreground/30 focus-within:bg-muted/18">
          <input
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="输入你的回答..."
            disabled={submitting}
            className="w-full rounded-md border-0 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0"
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-border/20 pt-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground/72">
          <Info className="h-3.5 w-3.5" />
          使用 Tab / 上下键选择，回车或空格选中
        </span>
        <div className="flex items-center gap-2">
          {isPlanApproval ? (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void ignore()}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/42 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35 disabled:cursor-wait disabled:opacity-60"
            >
              忽略
            </button>
          ) : null}
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35 disabled:cursor-wait disabled:opacity-60"
          >
            {submitting ? '提交中...' : '确认'}
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
}
