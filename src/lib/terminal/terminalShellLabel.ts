/**
 * 把 daemon 返回的 shell 绝对路径压成界面里适合显示的短标签。
 *
 * 只做展示用途：判断 shell 类型（PowerShell 输出归一化）用完整路径，
 * 见 `terminalDataTransform.ts` 的 `isPowerShellShell`。
 */
export function terminalShellLabel(shell: string | null | undefined): string | null {
  if (!shell) return null;

  const base = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!base) return null;

  if (base === 'pwsh' || base === 'pwsh.exe') return 'PowerShell';
  if (base.startsWith('powershell')) return 'Windows PowerShell';
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  return base.replace(/\.exe$/, '');
}
