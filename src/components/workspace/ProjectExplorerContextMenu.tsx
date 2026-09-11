import { shellFacade } from '../../lib/facades/shell-facade';
import { toast } from 'sonner';

import { getProjectRelativePath } from '../../lib/composerReferences';
import { getOpenTargetOption } from '../../lib/openTargets';
import { useAgentStore } from '../../stores/agentStore';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '../ui/context-menu';

const FILE_EXPLORER_OPTION = getOpenTargetOption('file_explorer');
const VSCODE_OPTION = getOpenTargetOption('vscode');

interface ProjectExplorerContextMenuProps {
  path: string;
  projectPath: string;
  isDirectory: boolean;
  sessionId: string | null;
  onOpen: () => void;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('已复制');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function openInExplorer(path: string) {
  try {
    await shellFacade.openInExplorer(path);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function openWithTarget(path: string, target: 'file_explorer' | 'vscode') {
  try {
    await shellFacade.openProjectPath(path, target);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

export function ProjectExplorerContextMenu({
  path,
  projectPath,
  isDirectory,
  sessionId,
  onOpen,
}: ProjectExplorerContextMenuProps) {
  const requestComposerReferenceInsert = useAgentStore((state) => state.requestComposerReferenceInsert);
  const relativePath = getProjectRelativePath(path, projectPath);

  const handleAddToChat = () => {
    if (!sessionId) {
      toast.error('请先打开一个对话');
      return;
    }
    requestComposerReferenceInsert(sessionId, relativePath, isDirectory);
    toast.success('已添加到聊天');
  };

  return (
    <ContextMenuContent className="surface-panel z-180 min-w-40 rounded-lg border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_48px_-28px_hsl(var(--foreground)/0.38)] backdrop-blur-md animate-in fade-in fill-mode-both animation-duration-[180ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
      <ContextMenuItem onClick={onOpen}>打开</ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>打开方式</ContextMenuSubTrigger>
        <ContextMenuSubContent className="surface-panel min-w-36 rounded-lg border border-border/70 bg-popover/98 p-1.5 shadow-[0_18px_48px_-28px_hsl(var(--foreground)/0.38)] backdrop-blur-md">
          <ContextMenuItem
            icon={<FILE_EXPLORER_OPTION.Icon className="h-3.5 w-3.5" />}
            onClick={() => void openWithTarget(path, 'file_explorer')}
          >
            资源管理器
          </ContextMenuItem>
          <ContextMenuItem
            icon={<VSCODE_OPTION.Icon className="h-3.5 w-3.5" />}
            onClick={() => void openWithTarget(path, 'vscode')}
          >
            VS Code
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void openInExplorer(path)}>在资源管理器中打开</ContextMenuItem>
      <ContextMenuItem onClick={() => void copyText(path)}>复制绝对路径</ContextMenuItem>
      <ContextMenuItem onClick={() => void copyText(relativePath)}>复制相对路径</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!sessionId} onClick={handleAddToChat}>
        添加到聊天
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
