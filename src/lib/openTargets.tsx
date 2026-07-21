import type { ComponentType, SVGProps } from 'react';
import { FolderOpen, Terminal } from 'lucide-react';
import cursorSvg from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
import vscodeSvg from 'devicon/icons/vscode/vscode-original.svg?raw';
import gitSvg from 'devicon/icons/git/git-original.svg?raw';
import { cn } from './utils';

export const OPEN_TARGETS = ['vscode', 'cursor', 'file_explorer', 'terminal', 'git_bash'] as const;
export type OpenTarget = typeof OPEN_TARGETS[number];

export const DEFAULT_OPEN_TARGET: OpenTarget = 'file_explorer';

type OpenTargetIconProps = SVGProps<SVGSVGElement> & {
  className?: string;
};

function cleanSvg(raw: string): string {
  return raw
    .replace(/<title>.*?<\/title>/, '')
    .replace(/(<svg\b[^>]*\bstyle=")[^"]*(")/, '$1display:block$2')
    .replace(/(<svg\b[^>]*) width="[^"]*"/, '$1')
    .replace(/(<svg\b[^>]*) height="[^"]*"/, '$1')
    .replace(/<svg\b/, '<svg width="100%" height="100%"');
}

function RawSvgIcon({ svg, className }: { svg: string; className?: string }) {
  return (
    <span
      className={['inline-flex shrink-0 items-center justify-center', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: cleanSvg(svg) }}
    />
  );
}

function VsCodeIcon({ className }: OpenTargetIconProps) {
  return <RawSvgIcon svg={vscodeSvg} className={className} />;
}

function CursorIcon({ className }: OpenTargetIconProps) {
  return <RawSvgIcon svg={cursorSvg} className={className} />;
}

function FileExplorerIcon({ className }: OpenTargetIconProps) {
  return <FolderOpen className={cn(className, 'text-amber-500')} />;
}

function FileTerminalIcon({ className }: OpenTargetIconProps) {
  return <Terminal className={cn(className, 'text-black-500')} />;
}

function GitBashIcon({ className }: OpenTargetIconProps) {
  return <RawSvgIcon svg={gitSvg} className={className} />;
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
  { value: 'terminal', label: 'Terminal', Icon: FileTerminalIcon },
  { value: 'git_bash', label: 'Git Bash', Icon: GitBashIcon },
];

export function normalizeOpenTarget(target: unknown): OpenTarget {
  return OPEN_TARGETS.includes(target as OpenTarget) ? target as OpenTarget : DEFAULT_OPEN_TARGET;
}

export function getOpenTargetOption(target: unknown): OpenTargetOption {
  const normalized = normalizeOpenTarget(target);
  return OPEN_TARGET_OPTIONS.find((option) => option.value === normalized) ?? OPEN_TARGET_OPTIONS[2];
}
