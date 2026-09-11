/**
 * 工作区文件树契约(原 src/lib/tauri.ts 类型段,Tauri 壳退役后迁入)。
 * 形状与 daemon `listWorkspaceDirectory` 响应对齐。
 */

export interface FileTreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileTreeNode[];
}
