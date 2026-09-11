import type { FileTreeNode } from '../../lib/workspaceTypes';

/** True when a directory node's children were returned by the backend (including empty folders). */
export function hasLoadedChildren(node: FileTreeNode): boolean {
  if (!node.is_dir) return true;
  return node.children !== undefined && node.children !== null;
}

/** True when expanding this directory should fetch children on demand. */
export function needsLazyLoad(node: FileTreeNode): boolean {
  return node.is_dir && !hasLoadedChildren(node);
}
