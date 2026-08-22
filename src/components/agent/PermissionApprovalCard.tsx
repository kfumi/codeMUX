import { Check, Info } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../../lib/utils';
import { isPlanApprovalPermission } from '../../lib/agentPermissions';
import type { AgentPermissionRequest, AgentPermissionResponse } from '../../types/agent';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

interface PermissionApprovalCardProps {
  request: AgentPermissionRequest;
  onResponse: (response: AgentPermissionResponse) => void | Promise<void>;
}

interface PermissionApprovalBodyProps {
  request: AgentPermissionRequest;
  selectedResponse: AgentPermissionResponse;
  comment: string;
  submitting: boolean;
  onSelectResponse: (response: AgentPermissionResponse) => void;
  onCommentChange: (comment: string) => void;
  variant?: 'card' | 'tab';
}

interface PermissionApprovalFooterProps {
  isPlanApproval: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onIgnore: () => void;
}

interface PermissionApprovalTabsProps {
  requests: AgentPermissionRequest[];
  onResponse: (request: AgentPermissionRequest, response: AgentPermissionResponse) => void | Promise<void>;
}

type PermissionMetadata = Record<string, unknown>;

type PermissionApprovalOption = {
  response: AgentPermissionResponse;
  label: string;
  description: string;
};

type PermissionDraft = {
  selectedResponse: AgentPermissionResponse;
  comment: string;
};

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

function getPermissionResource(request: AgentPermissionRequest): string | undefined {
  const metadata = request.metadata ?? {};
  const directPath = getText(metadata, 'filepath') ?? getText(metadata, 'path') ?? getText(metadata, 'parentDir');
  if (directPath) return directPath;
  const patterns = metadata.patterns;
  return Array.isArray(patterns) && typeof patterns[0] === 'string' ? patterns[0] : undefined;
}

function getPermissionTitle(request: AgentPermissionRequest): string {
  const metadata = request.metadata ?? {};
  const explicitTitle = getText(metadata, 'title');
  if (explicitTitle) return explicitTitle;

  const description = request.description.trim();
  if (description && description !== request.permission_type) return description;

  switch (request.permission_type) {
    case 'external_directory':
      return '访问外部目录';
    case 'read':
      return '读取文件';
    case 'write':
    case 'edit':
      return '修改文件';
    case 'execute':
      return '运行命令';
    default:
      return '需要确认权限';
  }
}

function isPlanApproval(request: AgentPermissionRequest): boolean {
  return isPlanApprovalPermission(request.permission_type, request.metadata);
}

function getPlanMarkdown(request: AgentPermissionRequest): string | null {
  const plan = request.metadata?.plan;
  return typeof plan === 'string' && plan.trim() ? plan : null;
}

function getPermissionOptions(planApproval: boolean): PermissionApprovalOption[] {
  return planApproval
    ? [{ response: 'once', label: '批准', description: '按计划开始实施。' }]
    : [
        { response: 'once', label: '允许', description: '仅允许这一次操作。' },
        { response: 'always', label: '始终允许匹配规则', description: '后续匹配到相同规则时不再询问。' },
        { response: 'reject', label: '拒绝', description: '这次先拒绝。' },
      ];
}

function PermissionApprovalBody({
  request,
  selectedResponse,
  comment,
  submitting,
  onSelectResponse,
  onCommentChange,
  variant = 'card',
}: PermissionApprovalBodyProps) {
  const planApproval = isPlanApproval(request);
  const command = getPermissionCommand(request);
  const title = getPermissionTitle(request);
  const resource = getPermissionResource(request);
  const options = getPermissionOptions(planApproval);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});

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
      onSelectResponse(options[index].response);
    }
  };

  return (
    <section className={cn(variant === 'card' && 'rounded-lg bg-[hsl(var(--surface-2))]/66 p-2')}>
      <div className="px-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-md border border-border/65 px-2 py-0.5 text-xs font-medium text-foreground/82">需要权限</span>
          <span className="min-w-0 truncate text-foreground/85">{planApproval ? '实施计划' : title}</span>
        </div>
        {resource ? (
          <div
            className="mt-1.5 max-h-24 overflow-auto rounded-lg border border-border/40 bg-background/72 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground/80 whitespace-pre-wrap break-all"
            title={resource}
          >
            {resource}
          </div>
        ) : null}
      </div>

      {command ? (
        <pre className="max-h-36 overflow-auto rounded-xl border border-border/40 bg-background/72 px-3 py-2.5 font-mono text-code leading-5 text-foreground/88 whitespace-pre-wrap wrap-break-word">
          <code>$ {command}</code>
        </pre>
      ) : null}

      {planApproval ? (() => {
        const planMarkdown = getPlanMarkdown(request);
        if (!planMarkdown) return null;
        return (
          <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border/40 bg-background/72 px-3 py-2">
            <MarkdownRenderer content={planMarkdown} />
          </div>
        );
      })() : null}

      <div data-testid="permission-options" className="space-y-0 overflow-hidden rounded-lg border border-border/18 bg-[hsl(var(--surface-3))]/22">
        {options.map((option, index) => {
          const active = selectedResponse === option.response;
          return (
            <button
              key={option.response}
              type="button"
              ref={(element) => { optionRefs.current[String(index)] = element; }}
              disabled={submitting}
              onClick={() => onSelectResponse(option.response)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              autoFocus={index === 0}
              aria-pressed={active}
              className={cn(
                'flex w-full items-start gap-3 border-0 px-3 py-2 text-left transition-colors',
                active
                  ? 'bg-muted/92 text-foreground dark:bg-[hsl(var(--muted-foreground))/0.28]'
                  : 'text-muted-foreground hover:bg-muted/42 hover:text-foreground',
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

      {planApproval ? (
        <div className="rounded-lg border border-border/35 bg-background/45 p-0.5 transition-colors focus-within:border-foreground/30 focus-within:bg-muted/18">
          <input
            value={comment}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="输入你的回答..."
            disabled={submitting}
            className="w-full rounded-md border-0 bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0"
          />
        </div>
      ) : null}
    </section>
  );
}

function PermissionApprovalFooter({ isPlanApproval, submitting, onSubmit, onIgnore }: PermissionApprovalFooterProps) {
  return (
    <div data-testid="permission-footer" className="flex items-center justify-between gap-3 px-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground/72">
        <Info className="h-3.5 w-3.5" />
        使用 Tab / 上下键选择，回车或空格选中
      </span>
      <div className="flex items-center gap-2">
        {isPlanApproval ? (
          <button
            type="button"
            disabled={submitting}
            onClick={onIgnore}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/42 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35 disabled:cursor-wait disabled:opacity-60"
          >
            忽略
          </button>
        ) : null}
        <button
          type="button"
          disabled={submitting}
          onClick={onSubmit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35 disabled:cursor-wait disabled:opacity-60"
        >
          {submitting ? '提交中...' : '确认'}
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function PermissionApprovalPanel({ request, onResponse }: PermissionApprovalCardProps) {
  const planApproval = isPlanApproval(request);
  const [draft, setDraft] = useState<PermissionDraft>({ selectedResponse: 'once', comment: '' });
  const [submitting, setSubmitting] = useState(false);

  const respond = async (response: AgentPermissionResponse) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResponse(response);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="permission-approval-card">
      <PermissionApprovalBody
        request={request}
        selectedResponse={draft.selectedResponse}
        comment={draft.comment}
        submitting={submitting}
        onSelectResponse={(selectedResponse) => setDraft((current) => ({ ...current, selectedResponse }))}
        onCommentChange={(comment) => setDraft((current) => ({ ...current, comment }))}
      />
      <PermissionApprovalFooter
        isPlanApproval={planApproval}
        submitting={submitting}
        onSubmit={() => void respond(draft.selectedResponse)}
        onIgnore={() => void respond('reject')}
      />
    </div>
  );
}

function getPermissionTabLabel(request: AgentPermissionRequest, index: number): string {
  const resource = getPermissionResource(request);
  const label = resource?.split(/[\\/]/).filter(Boolean).pop() ?? getPermissionTitle(request);
  return `${index + 1}. ${label}`;
}

export function PermissionApprovalTabs({ requests, onResponse }: PermissionApprovalTabsProps) {
  const [activeRequestId, setActiveRequestId] = useState(requests[0]?.request_id ?? '');
  const [drafts, setDrafts] = useState<Record<string, PermissionDraft>>({});
  const [submittingRequestId, setSubmittingRequestId] = useState<string | null>(null);
  const activeRequest = requests.find((request) => request.request_id === activeRequestId) ?? requests[0];
  const activeId = activeRequest?.request_id ?? '';

  const getDraft = (requestId: string): PermissionDraft => drafts[requestId] ?? { selectedResponse: 'once', comment: '' };
  const updateDraft = (requestId: string, patch: Partial<PermissionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [requestId]: { ...getDraftFromState(current, requestId), ...patch },
    }));
  };

  const handleResponse = async (request: AgentPermissionRequest, response: AgentPermissionResponse) => {
    if (submittingRequestId) return;
    setSubmittingRequestId(request.request_id);
    try {
      await onResponse(request, response);
    } finally {
      setSubmittingRequestId(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="permission-approval-tabs">
      <div className="rounded-lg bg-[hsl(var(--surface-2))]/66 p-2">
        <Tabs value={activeId} onValueChange={setActiveRequestId}>
          <TabsList className="mb-2 w-full min-w-0 max-w-full flex-nowrap justify-start overflow-x-auto overflow-y-hidden overscroll-x-contain">
            {requests.map((request, index) => (
              <TabsTrigger key={request.request_id} value={request.request_id} className="relative min-w-0 max-w-60 flex-1">
                <span className="truncate">{getPermissionTabLabel(request, index)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {requests.map((request) => {
            const draft = getDraft(request.request_id);
            return (
              <TabsContent key={request.request_id} value={request.request_id}>
                <PermissionApprovalBody
                  request={request}
                  selectedResponse={draft.selectedResponse}
                  comment={draft.comment}
                  submitting={submittingRequestId === request.request_id}
                  onSelectResponse={(selectedResponse) => updateDraft(request.request_id, { selectedResponse })}
                  onCommentChange={(comment) => updateDraft(request.request_id, { comment })}
                  variant="tab"
                />
              </TabsContent>
            );
          })}
        </Tabs>
      </div>
      {activeRequest ? (
        <PermissionApprovalFooter
          isPlanApproval={isPlanApproval(activeRequest)}
          submitting={submittingRequestId === activeId}
          onSubmit={() => void handleResponse(activeRequest, getDraft(activeId).selectedResponse)}
          onIgnore={() => void handleResponse(activeRequest, 'reject')}
        />
      ) : null}
    </div>
  );
}

function getDraftFromState(drafts: Record<string, PermissionDraft>, requestId: string): PermissionDraft {
  return drafts[requestId] ?? { selectedResponse: 'once', comment: '' };
}

export function PermissionApprovalCard({ request, onResponse }: PermissionApprovalCardProps) {
  return <PermissionApprovalPanel request={request} onResponse={onResponse} />;
}
