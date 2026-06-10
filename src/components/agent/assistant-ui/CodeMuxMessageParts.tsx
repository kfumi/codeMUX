import type { AgentMessage } from '../../../stores/agentStore';
import { usePreviewStore } from '../../../stores/previewStore';
import { MarkdownText } from '@/components/assistant-ui/markdown-text';
import {
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackArgs,
} from '@/components/assistant-ui/tool-fallback';
import { AskUserQuestionCard } from '../AskUserQuestionCard';
import type { ToolCallMessagePartStatus } from '@assistant-ui/react';
import { cn } from '@/lib/utils';
import { INTERRUPT_MARKER } from '../../../stores/agentEventParsing';

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

export function CodeMuxToolCallMessagePart({
  toolName,
  args,
  argsText,
  result,
  isError,
  durationMs,
  status,
}: CodeMuxToolCallPartProps) {
  const openFile = usePreviewStore((state) => state.openFile);
  const summary = getToolSummary(args, openFile);
  const resolvedArgsText = argsText ?? JSON.stringify(args, null, 2);
  const resolvedStatus = resolveToolStatus(status, result, isError);

  return (
    <ToolFallbackRoot defaultOpen={resolvedStatus?.type === 'requires-action'}>
      <ToolFallbackTrigger toolName={toolName} status={resolvedStatus}>
        {durationMs != null && (
          <span className="ml-2 inline-flex rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground/70">
            {formatDuration(durationMs)}
          </span>
        )}
      </ToolFallbackTrigger>
      <ToolFallbackContent>
        {summary && (
          <div className="px-4 text-sm text-muted-foreground">
            {summary}
          </div>
        )}
        <ToolFallbackArgs argsText={resolvedArgsText} />
        <ToolFallbackResult result={stringifyResult(result)} />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

export function CodeMuxDataMessagePart({ name, data, sessionId }: CodeMuxDataPartProps) {
  if (name !== 'codemux-event' || !isAskUserQuestionData(data) || !sessionId) {
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

function getToolSummary(
  args: Record<string, unknown>,
  openFile: (path: string, originalContent?: string) => void,
) {
  const filePath = typeof args.file_path === 'string' ? normalizePath(args.file_path) : undefined;
  if (!filePath) {
    return null;
  }

  const originalContent = typeof args.old_string === 'string' ? args.old_string : undefined;
  return (
    <button
      className={cn('text-primary hover:text-primary/80 underline underline-offset-2')}
      onClick={(event) => {
        event.stopPropagation();
        openFile(filePath, originalContent);
      }}
    >
      {filePath}
    </button>
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\\\/g, '\\');
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
