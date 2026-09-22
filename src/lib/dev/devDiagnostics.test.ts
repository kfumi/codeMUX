// @vitest-environment node
/**
 * `isDevDiagnosticsEnabled` 的取值口径。
 *
 * 这里锁住的是**不缓存**：取值每次实时读 `import.meta.env.DEV`，所以同一模块实例
 * 上先 false 再 true 必须跟着变。若哪天有人把它改成模块级常量，本用例会失败 ——
 * 而那样改会让"测试里覆盖 DEV 观察生产分支"的手段失效（门控就再也没法回归防护）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isDevDiagnosticsEnabled } from './devDiagnostics';

describe('isDevDiagnosticsEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('实时跟随 import.meta.env.DEV，不做模块级缓存', () => {
    vi.stubEnv('DEV', false);
    expect(isDevDiagnosticsEnabled()).toBe(false);

    vi.stubEnv('DEV', true);
    expect(isDevDiagnosticsEnabled()).toBe(true);

    vi.stubEnv('DEV', false);
    expect(isDevDiagnosticsEnabled()).toBe(false);
  });
});
