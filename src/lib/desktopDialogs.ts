/**
 * 文件/目录对话框(工单 06,工单 09 终态):走壳桥 →
 * main `dialog.showOpenDialog/showSaveDialog`;返回形状与原 Tauri
 * plugin-dialog 一致(取消/关闭一律 null,multiple 为数组)。
 *
 * 桥缺失(非 Electron 壳/preload 未注入)时显式报错,由调用方决定降级。
 *
 * 调用点(审计于工单 06):DraftWorkspaceToolbar / Sidebar(open)、PerfOverlay(save)。
 */
import { requireDesktopBridge } from './desktop-bridge';

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  /** true = 选目录;false/缺省 = 选文件。 */
  directory?: boolean;
  multiple?: boolean;
  filters?: DialogFilter[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

/** 目录/文件选择;取消返回 null,multiple 为 string[]。 */
export async function openDialog(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  return requireDesktopBridge().showDialogOpen(options);
}

/** 保存路径选择;取消返回 null。 */
export async function saveDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  return requireDesktopBridge().showDialogSave(options);
}
