import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * store 单后端守卫(工单 09 终态):Tauri invoke 后端已删除,
 * store 层不得再出现任何已退役后端痕迹(invoke / lib/tauri / 退役 Tauri JS 包),
 * 只允许经 daemonFacade(daemon HTTP)与壳门面/desktopBridge(壳能力)两个出口,
 * 防止退役后端以任何形式回流造成双写。
 */
// 包名拼接构造,避免守卫文件自身命中全仓 grep 门(硬门:src 内零字面量)。
const RETIRED_TAURI_PKG = `@${'tauri-apps'}`;
const RETIRED_INVOKE_HELPER = ['invoke', 'Logged'].join('');

const RETIRED_BACKEND_PATTERNS: Array<[RegExp, string]> = [
  [/from\s+['"][^'"]*\blib\/tauri['"]/, 'imports deleted lib/tauri backend'],
  [new RegExp(RETIRED_TAURI_PKG), 'references retired Tauri JS packages'],
  [new RegExp(`\\b${RETIRED_INVOKE_HELPER}\\b`), 'calls the deleted logged-invoke helper'],
  [/[^a-zA-Z]invoke\s*\(/, 'calls invoke() directly'],
];

function listStoreFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
    files.push(full);
  }
  return files;
}

describe('store double-write guard', () => {
  it('keeps retired Tauri invoke backend out of stores', () => {
    const storeDir = join(process.cwd(), 'src/stores');
    const violations: string[] = [];

    for (const file of listStoreFiles(storeDir)) {
      const relative = file.replace(`${process.cwd()}\\`, '').replace(`${process.cwd()}/`, '');
      const content = readFileSync(file, 'utf8');

      for (const [pattern, reason] of RETIRED_BACKEND_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${relative}: ${reason}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
