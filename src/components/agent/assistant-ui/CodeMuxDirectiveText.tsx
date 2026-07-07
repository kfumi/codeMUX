import type { ReactNode } from 'react';
import { File, Folder, Terminal } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type CodeMuxDirectiveKind = 'file' | 'directory' | 'command';

type DirectiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; directiveKind: CodeMuxDirectiveKind; value: string; label: string };

// Match commands, file mentions, and markdown-link references.
// Commands and file mentions must be at the start of text or after whitespace.
// Avoid treating log fragments like "emit@http://..." as file references.
// [label](path) is the format for files (label without prefix) and commands (label starts with $).
// <command-message>...</command-name>...</command-args> is Claude Code CLI's command XML format.
// @path is legacy.
const COMMAND_XML_RE = /<command-message>[\s\S]*?<\/command-message>\s*<command-name>[\s\S]*?<\/command-name>(?:\s*<command-args>[\s\S]*?<\/command-args>)?/;
const DIRECTIVE_RE = new RegExp(
  [
    `(${COMMAND_XML_RE.source})`,
    `(^|\\s)(\\/[A-Za-z][\\w:-]*)(?=\\s|$)`,
    `(^|\\s)(@(?![A-Za-z][A-Za-z0-9+.-]*://)[^\\s]+)`,
    `(^|\\s)(\\[[^\\]]+\\]\\([^)]+\\))`,
  ].join('|'),
  'g',
);
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
    // Group 1: XML command (no leading)
    // Group 2/3: bare /command leading+value
    // Group 4/5: @file leading+value
    // Group 6/7: [label](path) leading+value
    const isXml = Boolean(match[1]);
    const leading = isXml ? '' : (match[2] ?? match[4] ?? match[6] ?? '');
    const value = match[1] || match[3] || match[5] || match[7] || '';
    const valueStart = match.index + leading.length;

    if (valueStart > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, valueStart) });
    }

    if (isXml) {
      // Claude Code XML splits into command chip (name) + text (args)
      const xmlSegments = parseClaudeCommandXmlSegments(value);
      for (const seg of xmlSegments) {
        segments.push(seg);
      }
      lastIndex = valueStart + value.length;
      continue;
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
      label: value.replace(/^\//, ''),
    };
  }

  if (value.startsWith('[')) {
    const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(value);
    if (linkMatch) {
      const label = linkMatch[1];
      const path = linkMatch[2];
      if (label.startsWith('$')) {
        return {
          kind: 'directive',
          directiveKind: 'command',
          value,
          label: label.slice(1),
        };
      }
      return {
        kind: 'directive',
        directiveKind: path.endsWith('/') ? 'directory' : 'file',
        value,
        label: label || getPathLabel(path),
      };
    }
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

function parseClaudeCommandXmlSegments(value: string): DirectiveSegment[] {
  const match = COMMAND_XML_RE.exec(value);
  if (!match) return [{ kind: 'text', text: value }];
  const fullMatch = match[0];
  const nameMatch = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/.exec(fullMatch);
  const argsMatch = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(fullMatch);
  const commandName = (nameMatch?.[1]?.trim() || '').replace(/^\//, '');
  const commandArgs = argsMatch?.[1]?.trim() || '';

  const segments: DirectiveSegment[] = [
    { kind: 'directive', directiveKind: 'command', value: fullMatch, label: commandName },
  ];

  if (commandArgs) {
    segments.push({ kind: 'text', text: ` ${commandArgs}` });
  }

  return segments;
}

function getPathLabel(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
}
