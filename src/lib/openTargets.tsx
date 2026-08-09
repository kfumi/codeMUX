import type { ComponentType } from 'react';
import vscodePng from '../assets/open-targets/vscode.png';
import cursorPng from '../assets/open-targets/cursor.png';
import fileExplorerPng from '../assets/open-targets/file-explorer.png';
import windowsTerminalPng from '../assets/open-targets/windows-terminal.png';
import gitBashPng from '../assets/open-targets/git-bash.png';
import { cn } from './utils';

export const OPEN_TARGETS = ['vscode', 'cursor', 'file_explorer', 'terminal', 'git_bash'] as const;
export type OpenTarget = typeof OPEN_TARGETS[number];

export const DEFAULT_OPEN_TARGET: OpenTarget = 'file_explorer';

type OpenTargetIconProps = {
  className?: string;
};

function PngIcon({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('inline-block shrink-0 object-contain', className)}
    />
  );
}

function VsCodeIcon({ className }: OpenTargetIconProps) {
  return <PngIcon src={vscodePng} className={className} />;
}

function CursorIcon({ className }: OpenTargetIconProps) {
  return <PngIcon src={cursorPng} className={className} />;
}

function FileExplorerIcon({ className }: OpenTargetIconProps) {
  return <PngIcon src={fileExplorerPng} className={className} />;
}

function FileTerminalIcon({ className }: OpenTargetIconProps) {
  return <PngIcon src={windowsTerminalPng} className={className} />;
}

function GitBashIcon({ className }: OpenTargetIconProps) {
  return <PngIcon src={gitBashPng} className={className} />;
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
