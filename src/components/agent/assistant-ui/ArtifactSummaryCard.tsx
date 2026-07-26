import { useState } from 'react';
import { ChevronDown, ChevronRight, Undo2, Loader2, FilePlus, FileMinus, RefreshCw } from 'lucide-react';
import type { TurnArtifact, ArtifactFile, RevertConflict } from '../../../lib/tauri';
import { useAgentStore } from '../../../stores/agentStore';
import { usePreviewStore } from '../../../stores/previewStore';
import { createLogger, serializeError } from '../../../lib/logger';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';

const logger = createLogger('ArtifactSummaryCard');

interface ArtifactSummaryCardProps {
  artifact: TurnArtifact;
  sessionId: string;
}

const STATUS_LABEL: Record<ArtifactFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
};

const STATUS_ICON = {
  added: FilePlus,
  modified: RefreshCw,
  deleted: FileMinus,
};

/**
 * Turn Artifact Summary Card (UI2 / CARD1 / ROW1 / DIFF1 / UNDO1 / V2).
 *
 * Mounts under the final assistant message of each turn. Renders collapsed by
 * default: header shows file count + +/- stats + "已撤销" tag if reverted.
 * Expanded state lists each file with status, +/- and a click-to-preview action
 * that opens the persisted snapshot (no disk read).
 *
 * The revert button lives in the header and is always visible. It triggers
 * a confirmation, then calls `revert_turn_artifact`. On success the card
 * transitions to "已撤销" state; on conflict the failure reasons are shown
 * inline without changing the artifact state.
 */
export function ArtifactSummaryCard({ artifact, sessionId }: ArtifactSummaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [conflicts, setConflicts] = useState<RevertConflict[]>([]);
  const [reverted, setReverted] = useState(artifact.summary.reverted);

  // E1: zero files — don't render the card at all.
  if (artifact.summary.files.length === 0) {
    return null;
  }

  const fileCount = artifact.summary.files.length;
  const additions = artifact.summary.totalAdditions;
  const deletions = artifact.summary.totalDeletions;

  const handleRevertClick = () => {
    if (reverted || reverting) return;
    setConflicts([]);
    setConfirming(true);
  };

  const handleConfirmRevert = async () => {
    setConfirming(false);
    setReverting(true);
    try {
      const result = await useAgentStore.getState().revertTurnArtifact(sessionId, artifact.id);
      if (result && result.status === 'reverted') {
        setReverted(true);
      } else if (result && result.status === 'conflict') {
        setConflicts(result.conflicts);
      }
    } catch (err) {
      logger.error('[artifact] revert threw', { artifactId: artifact.id }, serializeError(err));
    } finally {
      setReverting(false);
    }
  };

  const handleCancelConfirm = () => setConfirming(false);

  const handleFileClick = (file: ArtifactFile) => {
    if (!file.contentAvailable) return;
    usePreviewStore.getState().openFile(file.path, {
      source: 'artifact',
      originalContent: file.original ?? undefined,
      currentContent: file.current ?? undefined,
    });
  };

  return (
    <div
      data-artifact-card
      className={cn(
        'mt-1 rounded-lg border border-border/45 bg-muted/28 text-sm',
        reverted && 'opacity-70',
      )}
    >
      {/* Header (always visible, CARD1 / UNDO1) */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-label={expanded ? '收起' : '展开'}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <span className="text-xs font-medium text-foreground">
            {fileCount} 个文件
          </span>
          <span className="text-xs text-emerald-600 dark:text-emerald-400">+{additions}</span>
          <span className="text-xs text-rose-600 dark:text-rose-400">-{deletions}</span>
        </button>
        {reverted ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            已撤销
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={reverting}
            onClick={handleRevertClick}
            aria-label="撤销"
          >
            {reverting ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Undo2 className="mr-1 h-3 w-3" />
            )}
            撤销
          </Button>
        )}
      </div>

      {/* Confirm dialog (inline, UNDO1) */}
      {confirming ? (
        <div className="border-t border-border/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">
            确认撤销本轮全部 {fileCount} 个文件的改动？此操作将恢复文件到本轮开始前的状态。
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleCancelConfirm}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleConfirmRevert}
            >
              确认
            </Button>
          </div>
        </div>
      ) : null}

      {/* Conflict reasons (RF2) */}
      {conflicts.length > 0 ? (
        <div className="border-t border-border/40 bg-rose-500/5 px-3 py-2">
          <div className="text-xs font-medium text-rose-700 dark:text-rose-300">
            无法撤销：{conflicts.length} 个文件冲突
          </div>
          <ul className="mt-1 space-y-0.5">
            {conflicts.map((c) => (
              <li key={c.path} className="text-[11px] text-rose-700/86 dark:text-rose-300/86">
                <span className="font-mono">{c.path}</span> — {c.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* File list (expanded, ROW1) */}
      {expanded ? (
        <ul className="border-t border-border/40 px-3 py-1.5">
          {artifact.summary.files.map((file) => {
            const StatusIcon = STATUS_ICON[file.status];
            const clickable = file.contentAvailable;
            return (
              <li
                key={file.path}
                className={cn(
                  'flex items-center gap-2 py-1 text-xs',
                  clickable && 'cursor-pointer hover:bg-muted/40 rounded',
                )}
                onClick={() => handleFileClick(file)}
                title={!clickable ? '文件过大或为二进制，无法查看 Diff' : undefined}
              >
                <StatusIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="font-mono text-foreground/86 truncate flex-1">{file.path}</span>
                <span className="text-[10px] text-muted-foreground">{STATUS_LABEL[file.status]}</span>
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
