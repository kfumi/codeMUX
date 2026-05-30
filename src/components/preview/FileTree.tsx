import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileCode } from 'lucide-react';
import { usePreviewStore, type FileTreeNodeData } from '../../stores/previewStore';
import { cn } from '../../lib/utils';

function TreeNode({ node, onFileClick, level = 0 }: { node: FileTreeNodeData; onFileClick: (path: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(level < 1);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      setExpanded((prev) => !prev);
    } else {
      onFileClick(node.path);
    }
  }, [node, onFileClick]);

  return (
    <div>
      <button
        className={cn(
          'flex items-center gap-1.5 w-full px-2 py-0.5 text-xs hover:bg-muted/40 transition-colors text-left',
          'text-foreground/70 hover:text-foreground'
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
      >
        {node.isDir ? (
          <>
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            )}
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-yellow-500/70" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-yellow-500/70" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.isDir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} onFileClick={onFileClick} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const treeRoot = usePreviewStore((s) => s.treeRoot);
  const openFile = usePreviewStore((s) => s.openFile);

  const handleFileClick = useCallback(
    (path: string) => {
      openFile(path);
    },
    [openFile]
  );

  if (!treeRoot || treeRoot.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/40 text-xs p-4 text-center">
        暂无文件<br />请先选择项目
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-1">
      {treeRoot.map((node) => (
        <TreeNode key={node.path} node={node} onFileClick={handleFileClick} level={0} />
      ))}
    </div>
  );
}
