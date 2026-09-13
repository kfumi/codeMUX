/**
 * 文件/目录对话框(工单 06,工单 09 终态):走壳桥 →
 * main `dialog.showOpenDialog/showSaveDialog`;返回形状与原 Tauri
 * plugin-dialog 一致(取消/关闭一律 null,multiple 为数组)。
 *
 * 桥缺失(非 Electron 壳/preload 未注入)时以 rejected Promise 报错,由调用方
 * 决定降级 —— 声明为 async 是为了把 `requireDesktopBridge` 的同步抛出折叠成
 * rejection,否则调用方的 `.catch` 接不住(同 shell-facade 的约定)。
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
