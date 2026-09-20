import { execFile } from 'node:child_process';

/**
 * Windows 通知身份(未打包 Win32 应用):通知卡片归属区(应用名左侧)显示的名字与
 * 图标来自 HKCU\Software\Classes\AppUserModelId\<AUMID> 的 DisplayName / IconUri。
 * 旧 Tauri 版本写过同一个键,但 IconUri 指向 dev 产物路径;文件不存在时 Windows
 * 只显示名字、不显示图标,所以打包态启动都要把该键刷新成本次随包分发的图标。
 */

/** 注册表根路径:HKCU 写入无需管理员权限。 */
const REG_ROOT = 'HKCU\\Software\\Classes\\AppUserModelId';

export interface NotificationIdentity {
  appId: string;
  displayName: string;
  iconPath: string | null;
}

/** 执行命令并返回 stdout;非 0 退出码以 reject 表达(reg query 键不存在即如此)。 */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

export function notificationIdentityRegistryPath(appId: string): string {
  return `${REG_ROOT}\\${appId}`;
}

/**
 * 尽力而为地把通知身份刷新到注册表:与现值一致的值不重复写,失败只影响通知图标,
 * 不应影响启动。
 */
export async function ensureNotificationIdentity(
  identity: NotificationIdentity,
  run: CommandRunner = runCommand,
): Promise<void> {
  const key = notificationIdentityRegistryPath(identity.appId);
  const existing = await readValues(run, key);
  const writes: string[][] = [];

  if (existing.get('DisplayName') !== identity.displayName) {
    writes.push(['add', key, '/v', 'DisplayName', '/t', 'REG_EXPAND_SZ', '/d', identity.displayName, '/f']);
  }
  if (identity.iconPath) {
    if (existing.get('IconUri') !== identity.iconPath) {
      writes.push(['add', key, '/v', 'IconUri', '/t', 'REG_EXPAND_SZ', '/d', identity.iconPath, '/f']);
    }
  } else if (existing.has('IconUri')) {
    // 图标文件缺失时清掉旧值:留着指向不存在文件的 IconUri 会让 Windows 不显示图标。
    writes.push(['delete', key, '/v', 'IconUri', '/f']);
  }
  if (existing.get('ShowInSettings') !== '1') {
    writes.push(['add', key, '/v', 'ShowInSettings', '/t', 'REG_DWORD', '/d', '1', '/f']);
  }

  for (const args of writes) {
    try {
      await run('reg.exe', args);
    } catch {
      // 忽略:注册表写入失败不回滚,也不阻断启动。
    }
  }
}

async function readValues(run: CommandRunner, key: string): Promise<Map<string, string>> {
  try {
    return parseRegQuery(await run('reg.exe', ['query', key]));
  } catch {
    return new Map();
  }
}

/** `reg query <key>` 每行形如 `    DisplayName    REG_EXPAND_SZ    CodeMUX`(REG_DWORD 值为 0x1)。 */
function parseRegQuery(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{4}(\S+)\s+REG_\w+\s+(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    values.set(match[1], normalizeValue(match[2]));
  }
  return values;
}

function normalizeValue(value: string): string {
  return /^0x[0-9a-f]+$/i.test(value) ? String(parseInt(value, 16)) : value;
}
