import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

export type CodeMuxDirectiveKind = 'file' | 'directory' | 'command';

type DirectiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; directiveKind: CodeMuxDirectiveKind; value: string; label: string };

const DIRECTIVE_RE = /(^|\s)(\/[A-Za-z][\w-]*|@[^\s]+)/g;
type DirectiveTone = 'default' | 'inverted';

export function CodeMuxDirectiveChip({
  kind,
  value,
  label,
  className,
  tone = 'default',
}: {
  kind: CodeMuxDirectiveKind;
  value: string;
  label: string;
  className?: string;
  tone?: DirectiveTone;
}) {
  const isCommand = kind === 'command';

  return (
    <span
      data-directive-type={kind}
      data-directive-value={value}
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium align-baseline',
        tone === 'inverted'
          ? isCommand
            ? 'codemux-directive-command border-[hsl(var(--accent)/0.42)] bg-[hsl(var(--accent)/0.22)] text-primary-foreground'
            : 'codemux-directive-file border-[hsl(var(--primary-foreground)/0.24)] bg-[hsl(var(--primary-foreground)/0.14)] text-primary-foreground'
          : isCommand
            ? 'codemux-directive-command border-[hsl(var(--accent)/0.26)] bg-[hsl(var(--accent)/0.14)] text-[hsl(var(--accent))]'
            : 'codemux-directive-file border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]',
        className,
      )}
      contentEditable={false}
    >
      <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
    </span>
  );
}

export function CodeMuxDirectiveText({ text, tone = 'default' }: { text: string; tone?: DirectiveTone }) {
  return <>{parseDirectiveText(text).map((segment, index) => renderSegment(segment, index, tone))}</>;
}

function renderSegment(segment: DirectiveSegment, index: number, tone: DirectiveTone): ReactNode {
  if (segment.kind === 'text') {
    return segment.text;
  }

  return (
    <CodeMuxDirectiveChip
      key={`${segment.value}-${index}`}
      kind={segment.directiveKind}
      value={segment.value}
      label={segment.label}
      className="mx-0.5"
      tone={tone}
    />
  );
}

export function parseDirectiveText(text: string): DirectiveSegment[] {
  const segments: DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const leading = match[1] ?? '';
    const value = match[2] ?? '';
    const valueStart = match.index + leading.length;

    if (valueStart > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, valueStart) });
    }

    const directive = toDirectiveSegment(value);
    if (directive) {
      segments.push(directive);
      lastIndex = valueStart + value.length;
    }
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function toDirectiveSegment(value: string): DirectiveSegment | null {
  if (value.startsWith('/')) {
    return {
      kind: 'directive',
      directiveKind: 'command',
      value,
      label: value,
    };
  }

  if (value.startsWith('@')) {
    const path = value.slice(1);
    if (!path) return null;
    return {
      kind: 'directive',
      directiveKind: path.endsWith('/') ? 'directory' : 'file',
      value,
      label: getPathLabel(path),
    };
  }

  return null;
}

function getPathLabel(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
}
