import type { AgentMessage } from '../../../stores/agentStore';
import { MarkdownText, CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { Streamdown } from 'streamdown';
import { memo, useMemo, useState } from 'react';
import {
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackCommandOutput,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackArgs,
} from '@/components/assistant-ui/tool-fallback';
import { AskUserQuestionCard, type AskUserQuestion } from '../AskUserQuestionCard';
import type { ToolCallMessagePartStatus } from '@assistant-ui/react';
import { findSubagentIdByToolCallId } from '../../../lib/subagentActivity';
import { useSubagentStore } from '../../../stores/subagentStore';
import { INTERRUPT_MARKER } from '../../../stores/agentEventParsing';
import { AlertTriangle, Check, Copy, Maximize2, ListTodo, XCircle, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { getCodeChangeFilePath, getCodeChangeStats, isCodeChangeTool, ToolCodeDiff } from '../ToolCodeDiff';
import { TodoToolList } from '../TodoToolList';
import { BrowserToolResult } from '../BrowserToolResult';
import { isBrowserToolName } from '../../../lib/browserToolShots';
import { getTodoListForTool, readTodoExplanation } from '../../../lib/todoToolArgs';
import { getDisplayableArgs, getShellCommand, getToolHeaderSummary, isShellCommandTool } from '../toolHeaderSummary';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipHint } from '@/components/ui/tooltip';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { cn } from '../../../lib/utils';
import { isAskUserQuestionToolName } from '../../../lib/askUserQuestionTools';
import { countDiffLines, parseUnifiedDiffPatch } from '../../../lib/diffStats';
import { getProposedPlanPreview, getProposedPlanTitle, parseProposedPlan } from './proposedPlan';
import { FileTypeIcon } from '@/components/assistant-ui/file-type-icon';
import { getAgentDefinition } from '@/types/agentRegistry';
import type { AgentKind } from '@/types/session';
import { ReferencedMarkdownFilesList } from '../ReferencedMarkdownFilesList';
import { extractReferencedMarkdownFiles } from '@/lib/referencedMarkdownFiles';
import { isSubagentToolName } from '../../../lib/subagentTools';

type CodeMuxToolCallPartProps = {
  toolName: string;
  toolCallId?: string;
  sessionId?: string;
  args: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  status?: ToolCallMessagePartStatus;

  browserStep?: number;
  beforeShot?: string;
  afterShot?: string;};

type CodeMuxDataPartProps = {
  name: string;
  data: unknown;
  sessionId?: string;
  messageText?: string;
};

/**
 * 把工具参数规整成对象。
 *
 * 从 `CodeMuxThread.tsx` 的 `asRecord` 搬进来：只有把这次规整放在叶子组件**内部**并用
 * `useMemo` 记住，传给叶子的 `args` 才可能是同一个引用，`memo` 才有机会判等——在调用方
 * 每次 render 都新建一个对象会把 memo 直接击穿。
 */
function asToolArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type StreamStatusDisplayInput = Extract<AgentMessage, { kind: 'stream_status' }>['data'];

export type StreamStatusDisplay = {
  tone: 'warning' | 'error';
  text: string;
  icon: 'warning' | 'error';
  pulse?: boolean;
};

type AskUserQuestionData = {
  eventKind: string;
  event: Extract<AgentMessage, { kind: 'ask_user_question' }>;
};

type AskUserQuestionCardData = {
  tool_use_id: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
    multiple?: boolean;
  }>;
};

function CodeMuxTextMessagePartImpl({
  text,
  parsePlan = false,
}: {
  text?: string;
  parsePlan?: boolean;
}) {
  const parsedPlan = parsePlan && text ? parseProposedPlan(text) : null;

  if (!parsedPlan) {
    return (
      <div className="pl-1">
        <MarkdownText />
      </div>
    );
  }

  return (
    <div className="space-y-2 pl-1">
      {parsedPlan.beforeText ? <StaticMarkdownText text={parsedPlan.beforeText} /> : null}
      <ProposedPlanCard planMarkdown={parsedPlan.planMarkdown} />
      {parsedPlan.afterText ? <StaticMarkdownText text={parsedPlan.afterText} /> : null}
    </div>
  );
}

export function CodeMuxReasoningMessagePart() {
  return <MarkdownText />;
}

function StaticMarkdownText({ text }: { text: string }) {
  return (
    <Streamdown
      mode="static"
      {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}
    >
      {text}
    </Streamdown>
  );
}

function ProposedPlanCard({ planMarkdown }: { planMarkdown: string }) {
  const openPlanTab = useSidePanelStore((state) => state.openPlanTab);
  const title = getProposedPlanTitle(planMarkdown);
  const preview = getProposedPlanPreview(planMarkdown);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(planMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/55 bg-[hsl(var(--surface-2))]/42 p-3.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <div className="mb-3 flex items-center justify-between gap-3 text-muted-foreground/72">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <ListTodo className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">计划</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <TooltipHint content={copied ? '已复制计划' : '复制计划内容'}>
            <button
              type="button"
              aria-label={`复制计划 ${title}`}
              onClick={() => void handleCopy()}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </TooltipHint>
          <TooltipHint content="在右侧面板展开计划">
            <button
              type="button"
              aria-label={`展开计划 ${title}`}
              onClick={() => openPlanTab('计划.md', planMarkdown)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/45 hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          </TooltipHint>
        </div>
      </div>
      <h2 className="mb-2 text-xl font-semibold leading-7 text-foreground">{title}</h2>
      {preview ? (
        <div
          data-testid="proposed-plan-preview"
          className={cn(
            'relative max-h-24 overflow-hidden text-sm leading-6 text-foreground/88',
            '[&_.aui-md>*:last-child]:mb-0',
            '[&_.aui-md-h2]:mt-0 [&_.aui-md-h2]:mb-1 [&_.aui-md-h2]:text-base [&_.aui-md-h2]:leading-6',
            '[&_.aui-md-h3]:mt-0 [&_.aui-md-h3]:mb-1 [&_.aui-md-h3]:text-sm [&_.aui-md-h3]:leading-5',
            'after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-6 after:bg-[linear-gradient(180deg,hsl(var(--surface-2)/0),hsl(var(--surface-2)))]',
          )}
        >
          <StaticMarkdownText text={preview} />
        </div>
      ) : null}
    </div>
  );
}

export function getStreamStatusDisplay(data: StreamStatusDisplayInput): StreamStatusDisplay {
  if (data.mode_blocked) {
    const reasonCode = data.mode_blocked.reason_code || 'mode_blocked';
    const suggestion = data.mode_blocked.suggestion ? ` · ${data.mode_blocked.suggestion}` : '';
    return {
      tone: 'warning',
      icon: 'warning',
      text: `协作模式已阻止: ${reasonCode}${suggestion}`,
    };
  }

  const reconnectMatch = data.message.match(/Reconnecting\.\.\.\s*(\d+)\/(\d+)(?:\s*\((.+)\))?/);
  if (reconnectMatch) {
    const [, current, total, reason] = reconnectMatch;
    return {
      tone: 'warning',
      icon: 'warning',
      pulse: true,
      text: `正在重新连接 ${current}/${total}${reason ? ` · ${reason}` : ''}`,
    };
  }

  if (!data.is_reconnecting) {
    return {
      tone: 'error',
      icon: 'error',
      text: `连接断开: ${data.message}`,
    };
  }

  return {
    tone: 'warning',
    icon: 'warning',
    pulse: true,
    text: data.message,
  };
}

function CodeMuxToolCallMessagePartImpl({
  toolName,
  toolCallId,
  sessionId,
  args: rawArgs,
  argsText,
  result,
  isError,
  durationMs,
  status,
  browserStep,
  beforeShot,
  afterShot,
}: CodeMuxToolCallPartProps) {
  // 参数规整必须在**组件内部**记住，见文件末尾三个 `memo` 导出的说明。
  const args = useMemo(() => asToolArgs(rawArgs), [rawArgs]);
  const openPlanTab = useSidePanelStore((state) => state.openPlanTab);
  const isBrowserTool = isBrowserToolName(toolName);
  const headerSummary = getToolHeaderSummary(toolName, args);
  // 委派（Task/Agent）工具行由委派卡片取代：一个段里的委派由卡片表达（组头 + 拓扑 + 步骤），
  // 工具行只会重复它的信息，卡片节点才是打开预览的入口。
  //
  // 只在**能按 toolCallId 找到子智能体描述符**时才吞掉这一行：没有描述符（例如历史里没带
  // 子智能体元数据、或同名工具并非真正的委派）时保留工具行，否则委派会在对话流里凭空消失。
  const delegatedSubagentId = useSubagentStore((state) => {
    if (!sessionId || !toolCallId || !isSubAgentTool(toolName)) return undefined;
    const descriptors = state.sessions[sessionId]?.descriptors;
    return descriptors ? findSubagentIdByToolCallId(descriptors, toolCallId) : undefined;
  });
  if (delegatedSubagentId !== undefined) {
    return null;
  }
  const resolvedStatus: ToolCallMessagePartStatus | undefined = resolveToolStatus(status, result, isError);
  const askQuestions = getAskUserQuestions(toolName, args);
  if (askQuestions && sessionId && toolCallId) {
    const resultContent = typeof result === 'string' ? result : result == null ? undefined : stringifyResult(result);
    const isSubmittedQuestion = result !== undefined && !isError;
    if (isSubmittedQuestion) {
      return (
        <ToolFallbackRoot>
          <ToolFallbackTrigger toolName={toolName} status={resolvedStatus}>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-ui-caption font-medium text-primary">
              {askQuestions.length} 已回答
            </span>
          </ToolFallbackTrigger>
          <ToolFallbackContent scrollable={false}>
            <AskUserQuestionCard
              sessionId={sessionId}
              toolUseId={toolCallId}
              questions={askQuestions}
              compact
              submitted
              resultContent={resultContent}
            />
          </ToolFallbackContent>
        </ToolFallbackRoot>
      );
    }

    return <AskUserQuestionPreview />;
  }

  const codeFilePath = isCodeChangeTool(toolName, args) ? getCodeChangeFilePath(args) : undefined;
  const headerText = codeFilePath || headerSummary.text;
  const codeChangeStats = codeFilePath ? getCodeChangeStats(args) : null;
  const shellCommand = isShellCommandTool(toolName) ? getShellCommand(args) : undefined;
  const isShellCommandPanel = Boolean(shellCommand) && !codeFilePath;
  // 待办类工具展开后渲染成一行行待办（`todos` / `plan` 各家字段名不同，解析在
  // `getTodoListForTool`），因此参数 JSON 不再重复展示。返回空数组表示「是待办工具但没解析出条目」。
  const todoItems = getTodoListForTool(toolName, args);
  const displayableArgs = codeFilePath || isShellCommandPanel || todoItems
    ? null
    : getToolDisplayableArgs(toolName, args, []);
  const resolvedArgsText = argsText && displayableArgs
    ? JSON.stringify(displayableArgs, null, 2)
    : displayableArgs ? JSON.stringify(displayableArgs, null, 2) : undefined;

  const tooltipPath = headerSummary.fullPath;
  const exitPlanModePlanFilePath = toolName === 'ExitPlanMode' ? getStringArg(args, 'planFilePath') : undefined;
  const exitPlanModePlanContent = toolName === 'ExitPlanMode' ? getStringArg(args, 'plan') ?? '' : '';

  return (
    <ToolFallbackRoot defaultOpen={resolvedStatus?.type === 'requires-action'}>
      <ToolFallbackTrigger toolName={toolName} status={resolvedStatus}>
        {exitPlanModePlanFilePath ? (
          <TooltipHint content={exitPlanModePlanFilePath}>
            <span
              role="button"
              tabIndex={0}
              aria-label={`预览计划 ${exitPlanModePlanFilePath}`}
              className="min-w-0 truncate align-middle text-ui-caption font-normal text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openPlanTab(exitPlanModePlanFilePath, exitPlanModePlanContent);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                openPlanTab(exitPlanModePlanFilePath, exitPlanModePlanContent);
              }}
            >
              {exitPlanModePlanFilePath}
            </span>
          </TooltipHint>
        ) : null}
        {headerText && (
          tooltipPath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate font-mono text-ui-meta font-normal text-muted-foreground">
                  {headerText}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="break-all">{tooltipPath}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate font-mono text-ui-meta font-normal text-muted-foreground">
              {headerText}
            </span>
          )
        )}
        {codeChangeStats && (
          <span className="inline-flex shrink-0 gap-1.5 font-mono text-ui-caption tabular-nums">
            {(codeChangeStats.additions > 0 || codeChangeStats.deletions > 0) && (
              <>
                <span className="text-green-600 dark:text-green-400">
                  +{codeChangeStats.additions}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  -{codeChangeStats.deletions}
                </span>
              </>
            )}
          </span>
        )}
        {durationMs != null && (
          <span
            data-slot="tool-fallback-duration"
            className="shrink-0 text-ui-caption tabular-nums text-muted-foreground"
          >
            {formatDuration(durationMs)}
          </span>
        )}
      </ToolFallbackTrigger>
      <ToolFallbackContent scrollable={!codeFilePath && !isShellCommandPanel}>
        {isShellCommandPanel ? (
          <ToolFallbackCommandOutput
            command={shellCommand}
            output={formatShellCommandOutput(result)}
          />
        ) : todoItems ? (
          <TodoToolList items={todoItems} explanation={readTodoExplanation(args)} />
        ) : (
          <>
            {resolvedArgsText && <ToolFallbackArgs argsText={resolvedArgsText} />}
            {resolvedStatus?.type !== 'incomplete' && <ToolCodeDiff toolName={toolName} input={args} />}
            {isBrowserTool ? (
              <BrowserToolResult
                toolName={toolName}
                result={result}
                step={browserStep}
                beforeShot={beforeShot}
                afterShot={afterShot}
              />
            ) : (
              (!codeFilePath || resolvedStatus?.type === 'incomplete') && (
              <ToolFallbackResult result={stringifyResult(result)} />
              ))
            }
          </>
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

function AskUserQuestionPreview() {
  return <div className="px-1 py-1 text-xs text-muted-foreground/65">等待用户回答</div>;
}

function CodeMuxDataMessagePartImpl({ name, data, sessionId, messageText }: CodeMuxDataPartProps) {
  if (name !== 'codemux-event') {
    return null;
  }

  if (isErrorData(data)) {
    const errorMsg = data.event.data.error?.trim();
    if (!errorMsg) return null;
    // Suppress abort errors — these are expected when the user interrupts a turn.
    if (/abort/i.test(errorMsg) || errorMsg.includes('The operation was aborted')) {
      return null;
    }
    const knownError = getKnownSidecarErrorDisplay(errorMsg);
    if (knownError) {
      return (
        <div className="text-xs rounded-xl px-3 py-2 my-1 border animate-in fade-in fill-mode-forwards duration-slow ease-motion-out text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.06)] border-[hsl(var(--warning)/0.14)]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="break-all whitespace-pre-wrap">{knownError}</span>
          </div>
        </div>
      );
    }
    // Parse codex stderr format: "[codex] <label>: <message>"
    const match = errorMsg.match(/^\[codex\]\s*(?:SDK\s*)?(\w[\w\s]*?):\s*(.+)$/s);
    const label = match ? match[1].trim() : undefined;
    const message = match ? match[2].trim() : errorMsg;
    return (
      <div className="text-xs rounded-xl px-3 py-2 my-1 border animate-in fade-in fill-mode-forwards duration-slow ease-motion-out text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]">
        <div className="flex items-start gap-2">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="min-w-0">
            {label && <span className="font-medium">{label}: </span>}
            <span className="break-all whitespace-pre-wrap">{message}</span>
          </div>
        </div>
      </div>
    );
  }

  if (isStreamStatusData(data)) {
    const display = getStreamStatusDisplay(data.event.data);
    const toneClass = display.tone === 'error'
      ? 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]'
      : 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.06)] border-[hsl(var(--warning)/0.12)]';
    const Icon = display.icon === 'error' ? XCircle : AlertTriangle;

    return (
      <div className={`text-xs rounded-xl px-3 py-2 my-1 border animate-in fade-in fill-mode-forwards duration-slow ease-motion-out ${toneClass}`}>
        <div className="flex items-start gap-2">
          <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${display.pulse ? 'animate-pulse' : ''}`} />
          <span className="break-all whitespace-pre-wrap">{display.text}</span>
        </div>
      </div>
    );
  }

  if (isApiRetryData(data)) {
    const { attempt, max_retries, error_status, error } = data.event.data as any;
    const isLastRetry = attempt >= max_retries;
    return (
      <div className={`text-xs rounded-xl px-3 py-2 my-1 border animate-in fade-in fill-mode-forwards duration-slow ease-motion-out ${
        isLastRetry
          ? 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]'
          : 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.06)] border-[hsl(var(--warning)/0.12)]'
      }`}>
        {isLastRetry ? '请求失败' : `请求重试 ${attempt}/${max_retries}`} · {error_status}: {error}
      </div>
    );
  }

  if (isCompactData(data)) {
    const metadata = data.event.data.compact_metadata;
    if (metadata?.status === 'compacting') {
      return (
        <div className="text-center py-2 animate-in fade-in fill-mode-forwards duration-slow ease-motion-out">
          <span className="text-ui-caption text-muted-foreground tracking-normal font-medium animate-pulse">
            — 正在压缩上下文… —
          </span>
        </div>
      );
    }
    const preTokens = metadata?.pre_tokens;
    const tokenText = preTokens >= 1000 ? ` · 节省 ${(preTokens / 1000).toFixed(1)}k tokens` : preTokens > 0 ? ` · 节省 ${preTokens} tokens` : '';
    return (
      <div className="text-center py-2 animate-in fade-in fill-mode-forwards duration-slow ease-motion-out">
        <span className="text-ui-caption text-muted-foreground tracking-normal font-medium">
          — 上下文已压缩{tokenText} —
        </span>
      </div>
    );
  }

  if (isNativeSessionRebuiltData(data)) {
    return <NativeSessionRebuiltSeam event={data.event} />;
  }

  if (isPermissionUpdateDeferredData(data)) {
    return <PermissionUpdateDeferredSeam event={data.event} />;
  }

  if (isSessionSummaryData(data)) {
    const markdownFiles = extractReferencedMarkdownFiles(messageText ?? '');

    return (
      <div className="space-y-3">
        <ReferencedMarkdownFilesList files={markdownFiles} />
        <SessionSummaryCard event={data.event} />
      </div>
    );
  }

  if (!isAskUserQuestionData(data) || !sessionId) {
    return null;
  }

  const eventData = data.event.data;
  if (!isAskUserQuestionCardData(eventData)) {
    return null;
  }

  return (
    <AskUserQuestionCard
      sessionId={sessionId}
      toolUseId={eventData.tool_use_id}
      questions={eventData.questions}
      submitted={getBooleanRecordValue(eventData, 'submitted')}
      resultContent={getStringRecordValue(eventData, 'resultContent')}
    />
  );
}

const USER_INPUT_TIMEOUT_MESSAGE = '等待用户回复超时，请重新发送消息继续';

export function getKnownSidecarErrorDisplay(errorMsg: string): string | null {
  if (errorMsg.includes(USER_INPUT_TIMEOUT_MESSAGE)) {
    return USER_INPUT_TIMEOUT_MESSAGE;
  }

  const claudeIdleMatch = errorMsg.match(/Query timed out: no message received for (\d+)s/);
  if (claudeIdleMatch) {
    return `引擎空闲超时（${claudeIdleMatch[1]} 秒无响应），请重新发送消息继续`;
  }

  if (/Turn idle timeout: no progress events received/.test(errorMsg)) {
    return '引擎空闲超时（无进展事件），请重新发送消息继续';
  }

  const openCodeIdleMatch = errorMsg.match(/No progress events for (\d+)ms; (?:turn idle|native compaction) timed out/);
  if (openCodeIdleMatch) {
    const seconds = Math.round(Number(openCodeIdleMatch[1]) / 1000);
    return `引擎空闲超时（${seconds} 秒无响应），请重新发送消息继续`;
  }

  return null;
}

function isAskUserQuestionData(value: unknown): value is AskUserQuestionData {
  return (
    isRecord(value) &&
    value.eventKind === 'ask_user_question' &&
    isRecord(value.event) &&
    value.event.kind === 'ask_user_question'
  );
}

function isApiRetryData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'api_retry' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'api_retry' &&
    isRecord(value.event) &&
    value.event.kind === 'api_retry'
  );
}

function isCompactData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'compact' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'compact' &&
    isRecord(value.event) &&
    value.event.kind === 'compact'
  );
}

function isNativeSessionRebuiltData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'native_session_rebuilt' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'native_session_rebuilt' &&
    isRecord(value.event) &&
    value.event.kind === 'native_session_rebuilt'
  );
}

function isPermissionUpdateDeferredData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'permission_update_deferred' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'permission_update_deferred' &&
    isRecord(value.event) &&
    value.event.kind === 'permission_update_deferred'
  );
}

function PermissionUpdateDeferredSeam({ event }: { event: Extract<AgentMessage, { kind: 'permission_update_deferred' }> }) {
  return (
    <div className="text-center py-2 animate-in fade-in fill-mode-forwards duration-slow ease-motion-out">
      <span className="text-ui-caption text-muted-foreground tracking-normal font-medium">
        — {event.data.content} —
      </span>
    </div>
  );
}

function agentKindDisplayLabel(kind?: string): string | undefined {
  if (!kind) {
    return undefined;
  }

  return getAgentDefinition(kind as AgentKind)?.label ?? kind;
}

function nativeSessionRebuiltCaption(agentKind?: string): string {
  const label = agentKindDisplayLabel(agentKind);
  return label ? `— ${label} 原生会话已重建 —` : '— 原生会话已重建 —';
}

function NativeSessionRebuiltSeam({ event }: { event: Extract<AgentMessage, { kind: 'native_session_rebuilt' }> }) {
  const caption = nativeSessionRebuiltCaption(event.data.agent_kind);

  return (
    <TooltipHint content={event.data.content}>
      <div className="text-center py-2 animate-in fade-in fill-mode-forwards duration-slow ease-motion-out">
        <span className="text-ui-caption text-muted-foreground tracking-normal font-medium">
          {caption}
        </span>
      </div>
    </TooltipHint>
  );
}

function isSessionSummaryData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'session_summary' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'session_summary' &&
    isRecord(value.event) &&
    value.event.kind === 'session_summary'
  );
}

function isErrorData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'error' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'error' &&
    isRecord(value.event) &&
    value.event.kind === 'error'
  );
}

function isStreamStatusData(value: unknown): value is { eventKind: string; event: Extract<AgentMessage, { kind: 'stream_status' }> } {
  return (
    isRecord(value) &&
    value.eventKind === 'stream_status' &&
    isRecord(value.event) &&
    value.event.kind === 'stream_status'
  );
}

function isAskUserQuestionCardData(value: unknown): value is AskUserQuestionCardData {
  if (!isRecord(value) || typeof value.tool_use_id !== 'string' || !Array.isArray(value.questions)) {
    return false;
  }

  return value.questions.every((question) => {
    if (!isRecord(question) || typeof question.question !== 'string' || !Array.isArray(question.options)) {
      return false;
    }

    if ('header' in question && typeof question.header !== 'string') {
      return false;
    }

    if ('multiSelect' in question && typeof question.multiSelect !== 'boolean') {
      return false;
    }

    if ('multiple' in question && typeof question.multiple !== 'boolean') {
      return false;
    }

    return question.options.every((option) => {
      if (!isRecord(option) || typeof option.label !== 'string') {
        return false;
      }

      return !('description' in option) || typeof option.description === 'string';
    });
  });
}

function getAskUserQuestions(toolName: string, args: Record<string, unknown>): AskUserQuestion[] | null {
  if (
    !isAskUserQuestionToolName(toolName)
    || !Array.isArray(args.questions)
    || args.questions.length === 0
  ) {
    return null;
  }

  const questions = args.questions
    .filter(isRecord)
    .filter((question) => typeof question.question === 'string' && Array.isArray(question.options))
    .map((question) => ({
      question: question.question as string,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      options: (question.options as unknown[])
        .filter(isRecord)
        .filter((option) => typeof option.label === 'string')
        .map((option) => ({
          label: option.label as string,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
          ...(Object.prototype.hasOwnProperty.call(option, 'value') ? { value: option.value } : {}),
        })),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(question.multiple === true ? { multiple: true } : {}),
      ...(question.allowOther === false ? { allowOther: false } : {}),
      ...(question.presentation === 'plan-approval' ? { presentation: 'plan-approval' as const } : {}),
      ...(typeof question.inputPlaceholder === 'string' ? { inputPlaceholder: question.inputPlaceholder } : {}),
    }));

  return questions.length > 0 ? questions : null;
}

function stringifyResult(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }

  if (typeof result === 'string') {
    return result;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function formatShellCommandOutput(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }

  if (typeof result === 'string') {
    const parsed = tryParseJson(result);
    if (parsed !== undefined) {
      return formatShellCommandOutput(parsed);
    }

    return result;
  }

  if (isRecord(result)) {
    const parts = ['stdout', 'stderr', 'output']
      .map((key) => result[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (parts.length > 0) {
      return parts.join('\n');
    }

    // pi 把工具输出放在 `content` 块数组里。实时投影已在 sidecar 拍平
    // （`piEvents.ts` 的 `flattenPiResultText`），但**升级前落盘的**工具结果
    // 仍是 `{"content":[{"type":"text",...}]}` 的转储串，这里补一次拆包，
    // 避免历史会话里的命令输出渲染成 JSON。
    const content = flattenContentBlocks(result.content);
    if (content !== undefined) {
      return content;
    }
  }

  return stringifyResult(result);
}

/**
 * `[{type:"text",text}]` → 文本；`text` 字符串 → 原样；不可识别时返回 undefined。
 * 与 `convertAgentEvents.ts` 的 `stringifyToolResultContent` 同口径。
 */
function flattenContentBlocks(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text as string);

  return textParts.length > 0 ? textParts.join('\n') : undefined;
}

/**
 * 委派工具判定（口径在 `@/lib/subagentTools`，段分组也用它）：Claude 的 `Task`、
 * Codex/OpenCode 的 `Agent`/`subagent` 都算。段内命中它、且能按 toolCallId 找到子智能体
 * 描述符时，这一行由委派卡片取代。
 */
export function isSubAgentTool(toolName: string): boolean {
  return isSubagentToolName(toolName);
}

function getToolDisplayableArgs(
  toolName: string,
  args: Record<string, unknown>,
  consumedKeys: string[],
): Record<string, unknown> | null {
  const displayableArgs = getDisplayableArgs(args, consumedKeys);
  if (!displayableArgs || toolName !== 'ExitPlanMode') {
    return displayableArgs;
  }

  const { plan: _plan, ...rest } = displayableArgs;
  return Object.keys(rest).length > 0 ? rest : null;
}

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function inferStatus(result: unknown, isError?: boolean): ToolCallMessagePartStatus {
  if (isError) {
    return { type: 'incomplete', reason: 'error', error: result };
  }
  if (result === undefined) {
    return { type: 'running' };
  }

  if (isCancelledResult(result)) {
    return { type: 'incomplete', reason: 'cancelled', error: result };
  }

  if (hasExplicitFailureSignal(result)) {
    return { type: 'incomplete', reason: 'error', error: result };
  }

  return { type: 'complete' };
}

function resolveToolStatus(
  status: ToolCallMessagePartStatus | undefined,
  result: unknown,
  isError?: boolean,
): ToolCallMessagePartStatus {
  if (status?.type === 'requires-action') {
    return status;
  }

  return inferStatus(result, isError);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getSummaryFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function getSummaryDiffStats(diff: {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}): { additions: number; deletions: number } {
  if (typeof diff.before === 'string' && typeof diff.after === 'string') {
    return countDiffLines(diff.before, diff.after);
  }
  if (diff.patch) {
    const parsed = parseUnifiedDiffPatch(diff.patch);
    if (parsed) {
      return countDiffLines(parsed.oldContent, parsed.newContent);
    }
  }
  return { additions: diff.additions ?? 0, deletions: diff.deletions ?? 0 };
}

function SessionSummaryCard({ event }: { event: Extract<AgentMessage, { kind: 'session_summary' }> }) {
  const [expanded, setExpanded] = useState(false);
  const openDiffTab = useSidePanelStore((state) => state.openDiffTab);
  const diffs = event.data.diffs
    .map((diff) => ({ diff, stats: getSummaryDiffStats(diff) }))
    .filter(({ stats }) => stats.additions > 0 || stats.deletions > 0);
  const totalAdditions = diffs.reduce((sum, entry) => sum + entry.stats.additions, 0);
  const totalDeletions = diffs.reduce((sum, entry) => sum + entry.stats.deletions, 0);

  const handleFileClick = (diff: { file: string; patch?: string; before?: string; after?: string }) => {
    const patch = diff.patch;
    if (patch) {
      const parsed = parseUnifiedDiffPatch(patch);
      if (parsed) {
        openDiffTab(diff.file, parsed.oldContent, parsed.newContent);
        return;
      }
    }
    if (typeof diff.before === 'string' && typeof diff.after === 'string') {
      openDiffTab(diff.file, diff.before, diff.after);
    }
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-[hsl(var(--surface-2))]/88 shadow-[0_4px_16px_-14px_hsl(var(--surface-shadow-strong)/0.55)] animate-in fade-in fill-mode-forwards duration-slow ease-motion-out">
      <button
        className="group flex w-full items-center gap-3 bg-[hsl(var(--surface-2))]/72 px-3.5 py-2.5 text-left text-sm transition-[background-color,border-color] duration-normal hover:bg-[hsl(var(--surface-3))]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary)/0.35)] focus-visible:ring-inset"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground/75" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground/75" />
        )}
        <FileText className="h-4 w-4 shrink-0 text-[hsl(var(--primary)/0.82)]" />
        <span className="font-medium text-foreground/85">{diffs.length} 个文件已更改</span>
        <span className="ml-auto inline-flex items-center gap-1.5 tabular-nums">
          {totalAdditions > 0 && (
            <span className="rounded-md bg-[hsl(var(--success)/0.11)] px-1.5 py-0.5 text-xs font-medium text-[hsl(var(--success))]">+{totalAdditions}</span>
          )}
          {totalDeletions > 0 && (
            <span className="rounded-md bg-[hsl(var(--destructive)/0.11)] px-1.5 py-0.5 text-xs font-medium text-[hsl(var(--destructive))]">−{totalDeletions}</span>
          )}
          {totalAdditions === 0 && totalDeletions === 0 && (
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-muted-foreground/70">0</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-border/35 border-t border-border/45 bg-[hsl(var(--surface-1))]/38">
          {diffs.map(({ diff, stats }, i) => (
            <div
              key={`${diff.file}-${i}`}
              role="button"
              tabIndex={0}
              className="group/row flex cursor-pointer items-center gap-3 px-4 py-2.5 text-xs transition-colors duration-fast hover:bg-[hsl(var(--surface-2))]/72 focus-visible:bg-[hsl(var(--surface-2))]/72 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary)/0.3)] focus-visible:ring-inset"
              onClick={() => handleFileClick(diff)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleFileClick(diff);
                }
              }}
            >
              <FileTypeIcon filePath={diff.file} />
              <span className="max-w-[28%] shrink-0 truncate font-mono text-foreground/80">
                {getSummaryFileName(diff.file)}
              </span>
              <TooltipHint content={diff.file}>
                <span className="flex-1 truncate text-left text-muted-foreground/70">
                  {diff.file}
                </span>
              </TooltipHint>
              <span className="inline-flex w-18 shrink-0 justify-end gap-1.5 tabular-nums">
                <span className="rounded bg-[hsl(var(--success)/0.09)] px-1 py-0.5 text-right text-[hsl(var(--success))]">+{stats.additions}</span>
                <span className="rounded bg-[hsl(var(--destructive)/0.09)] px-1 py-0.5 text-right text-[hsl(var(--destructive))]">−{stats.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getBooleanRecordValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getStringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isCancelledResult(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  return value.trim() === INTERRUPT_MARKER;
}

function hasExplicitFailureSignal(value: unknown): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      return hasExplicitFailureSignal(parsed);
    }

    const exitCode = extractExitCode(value);
    return exitCode != null && exitCode !== 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitFailureSignal(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (
    value.is_error === true ||
    value.error === true ||
    value.success === false ||
    value.ok === false ||
    value.status === 'error' ||
    value.status === 'failed' ||
    value.status === 'failure'
  ) {
    return true;
  }

  const exitCode = getNumericField(value, ['exit_code', 'exitCode', 'code']);
  if (exitCode != null) {
    return exitCode !== 0;
  }

  return Object.values(value).some((nested) => hasExplicitFailureSignal(nested));
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractExitCode(value: string): number | undefined {
  const match = value.match(/\bexit code\s+(-?\d+)\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNumericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

/**
 * 三个叶子组件都包上 `memo`。
 *
 * **为什么必须**：`CodeMuxThreadRenderContext` 的值依赖 `activityRuns` / `toolDurations` /
 * `subagentRunActivity` 这三张**每次事件追加都会换身份**的查找表，所以每次追加都会把每一行的
 * 子树重新协调一遍。实测（见 `CodeMuxThread.rowRenderCounts.test.tsx`）：
 * 不加 memo 时，挂载 40 轮后追加**一个**事件会让这三个叶子重渲染 **161** 次；挂载 8 轮时 33 次
 * ——严格按挂载行数线性增长，也就是"历史行跟着每次追加全部重渲染"。
 *
 * **为什么语义安全**：它们只读 props 与自己持有的订阅（`useSubagentStore`、
 * `useSidePanelStore`、assistant-ui 的 `useMessagePartText`）。React 的 `memo` 只在浅比较
 * 相等时跳过渲染；那些订阅仍然会独立触发渲染，所以不会出现"数据变了但界面不更新"。
 * `MarkdownText` 本身早已是 `memo`（`src/components/assistant-ui/markdown-text.tsx:141`），
 * 这里补的是它外面那一层。
 */
export const CodeMuxTextMessagePart = memo(CodeMuxTextMessagePartImpl);
export const CodeMuxToolCallMessagePart = memo(CodeMuxToolCallMessagePartImpl);
export const CodeMuxDataMessagePart = memo(CodeMuxDataMessagePartImpl);
