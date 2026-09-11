/**
 * 系统字体清单(工单 09):经壳桥 listSystemFonts 获取;
 * main 侧返回常见字体常量清单。桥缺失(纯 Web)时降级为空清单。
 */
import { desktopBridge } from './desktop-bridge';

let cachedFonts: string[] | null = null;
let pendingLoad: Promise<string[]> | null = null;

function normalizeFontName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export async function loadSystemFonts(): Promise<string[]> {
  if (cachedFonts) return cachedFonts;
  if (!pendingLoad) {
    pendingLoad = (desktopBridge
      ? desktopBridge.listSystemFonts()
      : Promise.reject(new Error('codemuxDesktop 桥不可用(Electron preload 未注入)')))
      .then((fonts) => {
        cachedFonts = fonts.map(normalizeFontName).filter(Boolean);
        return cachedFonts;
      })
      .catch(() => {
        cachedFonts = [];
        return cachedFonts;
      });
  }
  return pendingLoad;
}

export function clearSystemFontsCache(): void {
  cachedFonts = null;
  pendingLoad = null;
}
