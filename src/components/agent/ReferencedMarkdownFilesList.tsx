import { ChevronDown, Copy } from 'lucide-react';
import { toast } from 'sonner';

import { FileTypeIcon } from '@/components/assistant-ui/file-type-icon';
import { resolveLocalMarkdownBasePath } from '@/components/assistant-ui/markdown-link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getProjectRelativePath } from '@/lib/composerReferences';
import { getOpenTargetOption } from '@/lib/openTargets';
import { fileApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useSidePanelStore } from '@/stores/sidePanelStore';

const FILE_EXPLORER_OPTION = getOpenTargetOption('file_explorer');
const VSCODE_OPTION = getOpenTargetOption('vscode');

type ReferencedMarkdownFilesListProps = {
  files: string[];
  className?: string;
};

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('已复制');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function openWithTarget(path: string, target: 'file_explorer' | 'vscode') {
  try {
    await fileApi.openProjectPath(path, target);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

function getFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function ReferencedMarkdownFileCard({ filePath }: { filePath: string }) {
  const openFileTab = useSidePanelStore((state) => state.openFileTab);
  const basePath = resolveLocalMarkdownBasePath(filePath);
  const relativePath = basePath ? getProjectRelativePath(filePath, basePath) : filePath;

  const handleOpenInApp = () => {
    void openFileTab(basePath, filePath);
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/55 bg-[hsl(var(--surface-2))]/55 px-3 py-2.5">
      <button
        type="button"
        onClick={handleOpenInApp}
        className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:opacity-90"
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/45 bg-[hsl(var(--surface-3))]/45">
          <FileTypeIcon filePath={filePath} className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground/88">{getFileName(filePath)}</span>
          <span className="mt-0.5 block text-ui-caption text-muted-foreground/68">文档 · MD</span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2.5 text-ui-caption text-muted-foreground/78 hover:text-foreground"
          >
            打开
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            icon={<FILE_EXPLORER_OPTION.Icon className="h-3.5 w-3.5" />}
            onClick={() => void openWithTarget(filePath, 'file_explorer')}
          >
            资源管理器
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<VSCODE_OPTION.Icon className="h-3.5 w-3.5" />}
            onClick={() => void openWithTarget(filePath, 'vscode')}
          >
            VS Code
          </DropdownMenuItem>
          <div className="my-1 h-px bg-border/60" />
          <DropdownMenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => void copyText(filePath)}
          >
            复制绝对路径
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => void copyText(relativePath)}
          >
            复制相对路径
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ReferencedMarkdownFilesList({ files, className }: ReferencedMarkdownFilesListProps) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="referenced-markdown-files"
      className={cn('space-y-2', className)}
    >
      {files.map((filePath) => (
        <ReferencedMarkdownFileCard key={filePath} filePath={filePath} />
      ))}
    </div>
  );
}
