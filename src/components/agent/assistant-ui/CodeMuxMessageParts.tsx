import type { AgentMessage } from '../../../stores/agentStore';
import { MarkdownText } from '@/components/assistant-ui/markdown-text';
import {
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackConversationResult,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackArgs,
  ToolFallbackConversationArgs,
} from '@/components/assistant-ui/tool-fallback';
import { AskUserQuestionCard } from '../AskUserQuestionCard';
import type { ToolCallMessagePartStatus } from '@assistant-ui/react';
import { INTERRUPT_MARKER } from '../../../stores/agentEventParsing';
import { AlertTriangle, XCircle } from 'lucide-react';
import { getCodeChangeFilePath, isCodeChangeTool, ToolCodeDiff } from '../ToolCodeDiff';
import { getDisplayableArgs, getToolHeaderSummary } from '../toolHeaderSummary';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useSidePanelStore } from '../../../stores/sidePanelStore';

type CodeMuxToolCallPartProps = {
  toolName: string;
  args: Record<string, unknown>;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  status?: ToolCallMessagePartStatus;
};

type CodeMuxDataPartProps = {
  name: string;
  data: unknown;
  sessionId?: string;
};

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
  }>;
};

export function CodeMuxTextMessagePart() {
  return (
    <div className="pl-1">
      <MarkdownText />
    </div>
  );
}

export function CodeMuxReasoningMessagePart() {
  return <MarkdownText />;
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

export function CodeMuxToolCallMessagePart({
  toolName,
  args,
  argsText,
  result,
  isError,
  durationMs,
  status,
}: CodeMuxToolCallPartProps) {
  const openPlanTab = useSidePanelStore((state) => state.openPlanTab);
  const resolvedStatus = resolveToolStatus(status, result, isError);
  const headerSummary = getToolHeaderSummary(toolName, args);
  const codeFilePath = isCodeChangeTool(toolName, args) ? getCodeChangeFilePath(args) : undefined;
  const headerText = codeFilePath || headerSummary.text;
  const displayableArgs = codeFilePath ? null : getToolDisplayableArgs(toolName, args, headerSummary.consumedKeys);
  const subAgentPrompt = getSubAgentPrompt(toolName, args);
  const isSubAgentToolCall = isSubAgentTool(toolName);
  const resolvedArgsText = subAgentPrompt
    ?? (argsText && displayableArgs ? JSON.stringify(displayableArgs, null, 2) : displayableArgs ? JSON.stringify(displayableArgs, null, 2) : undefined);

  const tooltipPath = headerSummary.fullPath;
  const exitPlanModePlanFilePath = toolName === 'ExitPlanMode' ? getStringArg(args, 'planFilePath') : undefined;
  const exitPlanModePlanContent = toolName === 'ExitPlanMode' ? getStringArg(args, 'plan') ?? '' : '';

  return (
    <ToolFallbackRoot defaultOpen={resolvedStatus?.type === 'requires-action'}>
      <ToolFallbackTrigger toolName={headerSummary.displayName || toolName} status={resolvedStatus}>
        {exitPlanModePlanFilePath ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`预览计划 ${exitPlanModePlanFilePath}`}
            title={exitPlanModePlanFilePath}
            className="ml-2 inline-block max-w-[min(33rem,54vw)] truncate align-middle text-xs font-normal text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
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
        ) : null}
        {headerText && (
          tooltipPath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-2 inline-block max-w-[min(33rem,54vw)] truncate align-middle text-xs font-normal text-muted-foreground/72">
                  {headerText}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="break-all">{tooltipPath}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="ml-2 inline-block max-w-[min(33rem,56vw)] truncate align-middle text-xs font-normal text-muted-foreground/68">
              {headerText}
            </span>
          )
        )}
        {durationMs != null && (
          <span className="inline-flex rounded-md border border-border/16 bg-[hsl(var(--surface-3))]/20 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground/56">
            {formatDuration(durationMs)}
          </span>
        )}
      </ToolFallbackTrigger>
      <ToolFallbackContent scrollable={!codeFilePath}>
        {resolvedArgsText && (
          isSubAgentToolCall
            ? <ToolFallbackConversationArgs argsText={resolvedArgsText} />
            : <ToolFallbackArgs argsText={resolvedArgsText} />
        )}
        {resolvedStatus?.type !== 'incomplete' && <ToolCodeDiff toolName={toolName} input={args} />}
        {(!codeFilePath || resolvedStatus?.type === 'incomplete') && (
          isSubAgentToolCall
            ? <ToolFallbackConversationResult result={stringifyResult(result)} />
            : <ToolFallbackResult result={stringifyResult(result)} />
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

export function CodeMuxDataMessagePart({ name, data, sessionId }: CodeMuxDataPartProps) {
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
    // Parse codex stderr format: "[codex] <label>: <message>"
    const match = errorMsg.match(/^\[codex\]\s*(?:SDK\s*)?(\w[\w\s]*?):\s*(.+)$/s);
    const label = match ? match[1].trim() : undefined;
    const message = match ? match[2].trim() : errorMsg;
    return (
      <div className="text-xs rounded-xl p-3 my-1 border animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease] text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]">
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
      <div className={`text-xs rounded-xl p-3 my-1 border animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease] ${toneClass}`}>
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
      <div className={`text-xs rounded-xl p-3 my-1 border animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease] ${
        isLastRetry
          ? 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.06)] border-[hsl(var(--destructive)/0.12)]'
          : 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.06)] border-[hsl(var(--warning)/0.12)]'
      }`}>
        {isLastRetry ? '请求失败' : `请求重试 ${attempt}/${max_retries}`} · {error_status}: {error}
      </div>
    );
  }

  if (isCompactData(data)) {
    const preTokens = data.event.data.compact_metadata?.pre_tokens;
    const tokenText = preTokens >= 1000 ? ` · 节省 ${(preTokens / 1000).toFixed(1)}k tokens` : preTokens > 0 ? ` · 节省 ${preTokens} tokens` : '';
    return (
      <div className="text-center py-3 animate-in fade-in fill-mode-forwards animation-duration-[350ms] [animation-timing-function:ease]">
        <span className="text-[11px] text-muted-foreground/35 tracking-normal font-medium">
          — 上下文已压缩{tokenText} —
        </span>
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

    return question.options.every((option) => {
      if (!isRecord(option) || typeof option.label !== 'string') {
        return false;
      }

      return !('description' in option) || typeof option.description === 'string';
    });
  });
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

function getSubAgentPrompt(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!isSubAgentTool(toolName)) {
    return undefined;
  }

  const prompt = args.prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : undefined;
}

function isSubAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName === 'subagent';
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
