// 通知身份注册表契约测试:reg.exe 以替身注入,验证「键不存在/值不一致才写」、
// IconUri 清理、失败静默、注册表路径拼接(Windows 归属区名字与图标来源)。
import { describe, expect, it, vi } from 'vitest';

import {
  ensureNotificationIdentity,
  notificationIdentityRegistryPath,
  type CommandRunner,
} from '../src/notification-identity';

const KEY = 'HKCU\\Software\\Classes\\AppUserModelId\\com.codemux.desktop';
const ICON = 'D:\\app\\resources\\icons\\Square150x150Logo.png';

function queryOutput(values: Record<string, string>): string {
  const lines = [`HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\com.codemux.desktop`];
  for (const [name, value] of Object.entries(values)) {
    lines.push(`    ${name}    REG_EXPAND_SZ    ${value}`);
  }
  return lines.join('\r\n');
}

function createRunner(options: { stdout?: string; queryFails?: boolean; writeFails?: boolean } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'query') {
      if (options.queryFails) {
        throw new Error('ERROR: The system was unable to find the specified registry key');
      }
      return options.stdout ?? '';
    }
    if (options.writeFails) {
      throw new Error('ERROR: Access is denied');
    }
    return '';
  });
  return { run, calls };
}

describe('notificationIdentityRegistryPath', () => {
  it('拼接 HKCU 下的 AppUserModelId 键路径', () => {
    expect(notificationIdentityRegistryPath('com.codemux.desktop')).toBe(KEY);
  });
});

describe('ensureNotificationIdentity', () => {
  it('键不存在时写入 DisplayName/IconUri/ShowInSettings', async () => {
    const { run, calls } = createRunner({ queryFails: true });

    await ensureNotificationIdentity({ appId: 'com.codemux.desktop', displayName: 'CodeMUX', iconPath: ICON }, run);

    expect(calls[0]).toEqual(['query', KEY]);
    expect(calls).toContainEqual(['add', KEY, '/v', 'DisplayName', '/t', 'REG_EXPAND_SZ', '/d', 'CodeMUX', '/f']);
    expect(calls).toContainEqual(['add', KEY, '/v', 'IconUri', '/t', 'REG_EXPAND_SZ', '/d', ICON, '/f']);
    expect(calls).toContainEqual(['add', KEY, '/v', 'ShowInSettings', '/t', 'REG_DWORD', '/d', '1', '/f']);
  });

  it('值与现值一致时不重复写(REG_DWORD 的 0x1 视为 1)', async () => {
    const stdout = [
      'HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\com.codemux.desktop',
      '    DisplayName    REG_EXPAND_SZ    CodeMUX',
      `    IconUri    REG_EXPAND_SZ    ${ICON}`,
      '    ShowInSettings    REG_DWORD    0x1',
    ].join('\r\n');
    const { run, calls } = createRunner({ stdout });

    await ensureNotificationIdentity({ appId: 'com.codemux.desktop', displayName: 'CodeMUX', iconPath: ICON }, run);

    expect(calls).toEqual([['query', KEY]]);
  });

  it('图标文件缺失时清理旧的 IconUri,并保留名字', async () => {
    const { run, calls } = createRunner({
      stdout: queryOutput({ DisplayName: 'CodeMUX', IconUri: 'D:\\old\\Square150x150Logo.png' }),
    });

    await ensureNotificationIdentity({ appId: 'com.codemux.desktop', displayName: 'CodeMUX', iconPath: null }, run);

    expect(calls).toContainEqual(['delete', KEY, '/v', 'IconUri', '/f']);
    expect(calls.some((args) => args[0] === 'add' && args.includes('IconUri'))).toBe(false);
  });

  it('注册表写入失败时不抛错(单次 reg.exe 失败不影响启动)', async () => {
    const { run } = createRunner({ queryFails: true, writeFails: true });

    await expect(
      ensureNotificationIdentity({ appId: 'com.codemux.desktop', displayName: 'CodeMUX', iconPath: ICON }, run),
    ).resolves.toBeUndefined();
  });

  it('DisplayName 变化时只重写变化的项', async () => {
    const { run, calls } = createRunner({
      stdout: queryOutput({ DisplayName: '旧名字', IconUri: ICON, ShowInSettings: '0x1' }),
    });

    await ensureNotificationIdentity({ appId: 'com.codemux.desktop', displayName: 'CodeMUX', iconPath: ICON }, run);

    expect(calls).toEqual([
      ['query', KEY],
      ['add', KEY, '/v', 'DisplayName', '/t', 'REG_EXPAND_SZ', '/d', 'CodeMUX', '/f'],
    ]);
  });
});
