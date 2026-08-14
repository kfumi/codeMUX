import { invoke } from '@tauri-apps/api/core';

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
    pendingLoad = invoke<string[]>('get_system_fonts')
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
