import type { ReactNode } from 'react';
import { File, Folder, Terminal } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type CodeMuxDirectiveKind = 'file' | 'directory' | 'command';

type DirectiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; directiveKind: CodeMuxDirectiveKind; value: string; label: string };

// Match commands only at line start (not in paths like root/root/dist)
// Commands and file mentions must be at the start of text or after whitespace.
// Avoid treating log fragments like "emit@http://..." as file references.
const DIRECTIVE_RE = /(^|\s)(\/[A-Za-z][\w:-]*)(?=\s|$)|(^|\s)(@(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s]+)/g;
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
  const isDirectory = kind === 'directory';

  const Icon = isCommand ? Terminal : isDirectory ? Folder : File;

  return (
    <span
      data-directive-type={kind}
      data-directive-value={value}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium align-baseline',
        tone === 'inverted'
          ? isCommand
            ? 'codemux-directive-command border-[hsl(var(--accent)/0.42)] bg-[hsl(var(--accent)/0.22)] text-[hsl(var(--accent))]'
            : 'codemux-directive-file border-[hsl(var(--primary)/0.24)] bg-[hsl(var(--primary)/0.14)] text-[hsl(var(--primary))]'
          : isCommand
            ? 'codemux-directive-command border-[hsl(var(--accent)/0.26)] bg-[hsl(var(--accent)/0.14)] text-[hsl(var(--accent))]'
            : 'codemux-directive-file border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]',
        className,
      )}
      contentEditable={false}
    >
      <Icon className="h-3 w-3 shrink-0" />
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
    const leading = match[1] ?? match[3] ?? '';
    // Group 2 is slash command, Group 4 is @file
    const value = match[2] || match[4] || '';
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
