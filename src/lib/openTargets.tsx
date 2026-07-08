import type { ComponentType, SVGProps } from 'react';
import cursorSvg from '@lobehub/icons-static-svg/icons/cursor.svg?raw';

export const OPEN_TARGETS = ['vscode', 'cursor', 'file_explorer', 'terminal', 'git_bash'] as const;
export type OpenTarget = typeof OPEN_TARGETS[number];

export const DEFAULT_OPEN_TARGET: OpenTarget = 'file_explorer';

type OpenTargetIconProps = SVGProps<SVGSVGElement> & {
  className?: string;
};

function VsCodeIcon({ className, ...props }: OpenTargetIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true" {...props}>
      <path fill="#007ACC" d="M21.4 4.2 16.9 2 7.9 10.7 3.9 7.6 2 8.6v6.8l1.9 1 4-3.1 9 8.7 4.5-2.2V4.2Z" />
      <path fill="#1F9CF0" d="m16.9 7.5-5.4 4.5 5.4 4.5V7.5Z" />
      <path fill="#FFFFFF" fillOpacity="0.22" d="M16.9 2v20l4.5-2.2V4.2L16.9 2Z" />
    </svg>
  );
}

function CursorIcon({ className }: OpenTargetIconProps) {
  const cleanedSvg = cursorSvg
    .replace(/<title>.*?<\/title>/, '')
    .replace(/(<svg\b[^>]*\bstyle=")[^"]*(")/, '$1display:block$2')
    .replace(/(<svg\b[^>]*) width="[^"]*"/, '$1')
    .replace(/(<svg\b[^>]*) height="[^"]*"/, '$1')
    .replace(/<svg\b/, '<svg width="100%" height="100%"');

  return (
    <span
      className={['inline-flex shrink-0 items-center justify-center', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: cleanedSvg }}
    />
  );
}

function FileExplorerIcon({ className, ...props }: OpenTargetIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true" {...props}>
      <path fill="#F4B400" d="M2.8 6.6c0-1 .8-1.8 1.8-1.8h5.1l2 2.2h7.7c1 0 1.8.8 1.8 1.8v1.4H2.8V6.6Z" />
      <path fill="#FFD45A" d="M2.8 9.2h18.4v8.2c0 1-.8 1.8-1.8 1.8H4.6c-1 0-1.8-.8-1.8-1.8V9.2Z" />
      <path fill="#E69A00" d="M2.8 9.2h18.4v1.6H2.8V9.2Z" />
    </svg>
  );
}

function TerminalIcon({ className, ...props }: OpenTargetIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true" {...props}>
      <rect width="18.8" height="14.8" x="2.6" y="4.6" fill="#1F2937" rx="2.2" />
      <path fill="#22C55E" d="m6 8.4 3.4 3.2L6 14.8l-1.1-1.2 2-2-2-2L6 8.4Z" />
      <path fill="#E5E7EB" d="M10.8 14h6.8v1.5h-6.8z" />
      <path fill="#4B5563" d="M4.8 6.6h14.4v1.2H4.8z" />
    </svg>
  );
}

function GitBashIcon({ className, ...props }: OpenTargetIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true" {...props}>
      <path fill="#F05032" d="M10.4 2.9a2.2 2.2 0 0 1 3.1 0l7.6 7.6a2.2 2.2 0 0 1 0 3.1l-7.6 7.6a2.2 2.2 0 0 1-3.1 0l-7.6-7.6a2.2 2.2 0 0 1 0-3.1l7.6-7.6Z" />
      <path fill="#FFFFFF" d="M14.9 8.6a1.4 1.4 0 0 0-1.8 1.3l-2.5 1.3a1.5 1.5 0 0 0-.6-.4V8.5a1.4 1.4 0 1 0-1.4 0v6.9a1.4 1.4 0 1 0 1.4 0v-2.9c.2-.1.4-.2.6-.4l2.5 1.3a1.4 1.4 0 1 0 .7-1.1l-2.5-1.3v-.3l2.5-1.3c.3.3.7.4 1.1.4a1.4 1.4 0 0 0 0-2.8Z" />
    </svg>
  );
}

export interface OpenTargetOption {
  value: OpenTarget;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

export const OPEN_TARGET_OPTIONS: OpenTargetOption[] = [
  { value: 'vscode', label: 'VS Code', Icon: VsCodeIcon },
  { value: 'cursor', label: 'Cursor', Icon: CursorIcon },
  { value: 'file_explorer', label: 'File Explorer', Icon: FileExplorerIcon },
  { value: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { value: 'git_bash', label: 'Git Bash', Icon: GitBashIcon },
];

export function normalizeOpenTarget(target: unknown): OpenTarget {
  return OPEN_TARGETS.includes(target as OpenTarget) ? target as OpenTarget : DEFAULT_OPEN_TARGET;
}

export function getOpenTargetOption(target: unknown): OpenTargetOption {
  const normalized = normalizeOpenTarget(target);
  return OPEN_TARGET_OPTIONS.find((option) => option.value === normalized) ?? OPEN_TARGET_OPTIONS[2];
}
