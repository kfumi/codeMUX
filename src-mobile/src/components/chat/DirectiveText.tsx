import type { ReactNode } from 'react';
import { File, Folder, WandSparkles } from 'lucide-react';

import { cn } from '../../lib/utils';

type DirectiveSegment =
  | { kind: 'text'; text: string }
  | { kind: 'directive'; directiveKind: 'file' | 'directory' | 'command'; value: string; label: string };

const COMMAND_XML_RE = /<command-message>[\s\S]*?<\/command-message>\s*<command-name>[\s\S]*?<\/command-name>(?:\s*<command-args>[\s\S]*?<\/command-args>)?/;
const DIRECTIVE_RE = new RegExp(
  [
    `(${COMMAND_XML_RE.source})`,
    `(^|\\s)(\\/[A-Za-z][\\w:-]*)(?=\\s|$)`,
    `(^|\\s)(\\[[^\\]]+\\]\\([^)]+\\))`,
  ].join('|'),
  'g',
);

function DirectiveChip({
  kind,
  label,
}: {
  kind: 'file' | 'directory' | 'command';
  label: string;
}) {
  const Icon = kind === 'command' ? WandSparkles : kind === 'directory' ? Folder : File;
  const isCommand = kind === 'command';

  return (
    <span
      className={cn(
        'mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-xs font-medium',
        isCommand
          ? 'border-[hsl(var(--codemux-directive-border,214_100%_82%))] bg-[hsl(var(--codemux-directive-bg,214_100%_93%))] text-[hsl(var(--codemux-directive-accent,221_83%_46%))]'
          : 'border-[hsl(var(--primary)/0.24)] bg-[hsl(var(--primary)/0.14)] text-[hsl(var(--primary))]',
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function DirectiveText({ text }: { text: string }) {
  return <>{parseDirectiveText(text).map((segment, index) => renderSegment(segment, index))}</>;
}

function renderSegment(segment: DirectiveSegment, index: number): ReactNode {
  if (segment.kind === 'text') {
    return <span key={`text-${index}`}>{segment.text}</span>;
  }

  return (
    <DirectiveChip
      key={`${segment.value}-${index}`}
      kind={segment.directiveKind}
      label={segment.label}
    />
  );
}

function parseDirectiveText(text: string): DirectiveSegment[] {
  const segments: DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const isXml = Boolean(match[1]);
    const leading = isXml ? '' : (match[2] ?? match[4] ?? '');
    const value = match[1] || match[3] || match[5] || '';
    const valueStart = match.index + leading.length;

    if (valueStart > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, valueStart) });
    }

    if (isXml) {
      for (const seg of parseClaudeCommandXmlSegments(value)) {
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

  return segments.length > 0 ? segments : [{ kind: 'text', text }];
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
