import type { FileTreeNode } from '../../workspaceTypes';
import { ensureDaemonClient } from './lifecycle';

/** 工作区文件读写与目录浏览。 */
export const workspace = {
  read: async (path: string, basePath?: string) =>
    (await ensureDaemonClient()).readWorkspaceFile(path, basePath),
  previewImage: async (path: string) =>
    (await ensureDaemonClient()).previewImageFile(path),
  write: async (path: string, content: string, basePath?: string) => {
    await (await ensureDaemonClient()).writeWorkspaceFile(path, content, basePath);
  },
  list: async (
    path: string,
    depth?: number,
    basePath?: string,
    includeHidden = false,
  ) =>
    (await ensureDaemonClient()).listWorkspaceDirectory(
      path,
      depth,
      basePath,
      includeHidden,
    ) as Promise<FileTreeNode[]>,
};

export type WorkspaceDomain = typeof workspace;
