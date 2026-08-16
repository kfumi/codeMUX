import { useState } from 'react';
import { Check, ChevronDown, Loader2, XCircle } from 'lucide-react';

import { getCodeChangeStats, isCodeChangeTool, ToolCodeDiff } from '../../lib/diff/toolCodeDiff';
import {
  getDisplayableArgs,
  getShellCommand,
  getToolHeaderSummary,
  isShellCommandTool,
} from '../../lib/toolHeaderSummary';
import { formatShellCommandOutput, resolveToolStatus } from '../../lib/toolOutput';
import { cn } from '../../lib/utils';

interface ToolCallRowProps {
  name: string;
  status: 'running' | 'complete' | 'error';
  input?: string;
  inputObj?: Record<string, unknown>;
  result?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function ToolCallRow({
  name,
  status,
  input,
  inputObj,
  result,
  collapsed = true,
  onToggle,
}: ToolCallRowProps) {
  const [open, setOpen] = useState(!collapsed);
  const parsedInput = inputObj ?? tryParseInput(input);
  const resolvedStatus = resolveToolStatus(status, result);
  const summary = parsedInput ? getToolHeaderSummary(name, parsedInput) : undefined;
  const shellCommand = parsedInput && isShellCommandTool(name) ? getShellCommand(parsedInput) : undefined;
  const showCodeDiff = parsedInput && isCodeChangeTool(name, parsedInput);
  const codeStats = showCodeDiff && parsedInput ? getCodeChangeStats(parsedInput) : null;
  const shellOutput = shellCommand ? formatShellCommandOutput(result) : undefined;
  const displayableArgs = parsedInput && summary
    ? getDisplayableArgs(parsedInput, summary.consumedKeys)
    : parsedInput;
  const hideResult = Boolean(showCodeDiff && resolvedStatus !== 'error');
  const hasDetails = Boolean(
    showCodeDiff
    || shellCommand
    || (displayableArgs && Object.keys(displayableArgs).length > 0)
    || (result && !hideResult),
  );
  const isOpen = onToggle ? !collapsed : open;

  const Icon = resolvedStatus === 'running'
    ? Loader2
    : resolvedStatus === 'error'
      ? XCircle
      : Check;

  const headerLabel = summary?.displayName ?? name;
  const headerDetail = summary?.text;

  const handleToggle = () => {
    if (onToggle) {
      onToggle();
      return;
    }
    setOpen((value) => !value);
  };

  return (
    <div className="w-full py-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm font-normal text-muted-foreground/52 transition-colors hover:text-muted-foreground/78"
        onClick={hasDetails ? handleToggle : undefined}
        disabled={!hasDetails}
        title={summary?.fullPath}
      >
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            resolvedStatus === 'running' && 'animate-spin text-muted-foreground/72',
            resolvedStatus === 'complete' && 'text-muted-foreground/68',
            resolvedStatus === 'error' && 'text-destructive/72',
          )}
        />
        <span className="min-w-0 flex-1 truncate leading-none">
          <span>{headerLabel}</span>
          {headerDetail ? (
            <span className="text-muted-foreground/45"> · {headerDetail}</span>
          ) : null}
        </span>
        {codeStats ? (
          <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-[11px]">
            {codeStats.additions > 0 ? (
              <span className="text-[hsl(var(--success))]">+{codeStats.additions}</span>
            ) : null}
            {codeStats.deletions > 0 ? (
              <span className="text-[hsl(var(--destructive))]">−{codeStats.deletions}</span>
            ) : null}
          </span>
        ) : null}
        {hasDetails ? (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/52 transition-transform',
              !isOpen && '-rotate-90',
            )}
          />
        ) : null}
      </button>
      {hasDetails && isOpen ? (
        <div className="mt-2 space-y-2 pl-5">
          {showCodeDiff && parsedInput ? (
            <ToolCodeDiff toolName={name} input={parsedInput} />
          ) : null}
          {shellCommand ? (
            <div className="overflow-hidden rounded-md border border-border/45 bg-[hsl(var(--surface-2))]">
              <div className="border-b border-border/35 px-3 py-2 font-mono text-xs text-muted-foreground">
                <span className="text-primary/80">$</span> {shellCommand}
              </div>
              {shellOutput ? (
                <pre className="max-h-48 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground/85 whitespace-pre-wrap">
                  {shellOutput}
                </pre>
              ) : resolvedStatus === 'running' ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">运行中…</div>
              ) : null}
            </div>
          ) : null}
          {!showCodeDiff && !shellCommand && displayableArgs && Object.keys(displayableArgs).length > 0 ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(displayableArgs, null, 2)}
            </pre>
          ) : null}
          {result && !hideResult ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {result}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function tryParseInput(input?: string): Record<string, unknown> | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
