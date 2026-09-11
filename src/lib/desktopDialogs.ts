/**
 * 文件/目录对话框平台分流(工单 06)。
 *
 * - Electron 壳:走 preload 桥 → main `dialog.showOpenDialog/showSaveDialog`;
 *   返回形状对齐 @tauri-apps/plugin-dialog(取消/关闭一律 null,multiple 为数组)。
 * - Tauri 壳/纯 Web:动态 import 既有 plugin-dialog,行为不变(带回退)。
 *
 * 调用点(审计于工单 06):DraftWorkspaceToolbar / Sidebar(open)、PerfOverlay(save)。
 */
import { desktopBridge, isElectronDesktop } from './desktop-bridge';

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

/** 目录/文件选择;取消返回 null,multiple 为 string[](对齐 plugin-dialog.open)。 */
export async function openDialog(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (isElectronDesktop() && desktopBridge) {
    return desktopBridge.showDialogOpen(options);
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open(options);
}

/** 保存路径选择;取消返回 null(对齐 plugin-dialog.save)。 */
export async function saveDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  if (isElectronDesktop() && desktopBridge) {
    return desktopBridge.showDialogSave(options);
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save(options);
}
