import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DAEMON_API_PATTERN =
  /\b(sessionApi|agentApi|mcpApi|gitApi|historyImportApi|configApi|projectApi)\.[a-zA-Z_]+\(/;

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
  it('keeps daemon capabilities out of store-level Tauri invoke calls', () => {
    const storeDir = join(process.cwd(), 'src/stores');
    const violations: string[] = [];

    for (const file of listStoreFiles(storeDir)) {
      const relative = file.replace(`${process.cwd()}\\`, '').replace(`${process.cwd()}/`, '');
      const content = readFileSync(file, 'utf8');
      if (!content.includes("from '../lib/tauri'") && !content.includes('from "../lib/tauri"')) {
        continue;
      }

      if (relative.endsWith('settingsStore.ts')) {
        const stripped = content
          .replace(/configApi\.setBrowserControl\([^)]*\)/g, '')
          .replace(/agentApi\.stopProxy\([^)]*\)/g, '');
        if (!DAEMON_API_PATTERN.test(stripped)) {
          continue;
        }
      }

      if (DAEMON_API_PATTERN.test(content)) {
        violations.push(relative);
      }
    }

    expect(violations).toEqual([]);
  });
});
