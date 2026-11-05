/**
 * PowerShell / PSReadLine 的输出归一化。
 *
 * PSReadLine 重画光标所在行时，会把行尾的空白 cell 刷成 **ANSI 黑底**（`SGR 40`）。
 * 在纯黑终端里看不出来，但 CodeMUX 的终端背景跟随应用表面色（浅色是近白、深色是
 * 近黑但不是纯黑），这些 cell 就变成一块块灰块。
 *
 * 修复只针对**这一种**重绘：单行、含光标显示序列、且确实带黑底。普通输出里的
 * `SGR 40`（用户程序有意画的黑色背景）一律不改。
 */

const ESC = '\u001b';

/** 光标重新显示（PSReadLine 每次重绘结束都会发）。 */
const CURSOR_SHOW = '\u001b[?25h';

/** 任意 SGR 序列（捕获参数部分）；用来判断这一段输出是否真的在画属性。 */
const SGR_SEQUENCE = /\u001b\[([0-9;]*)m/g;

export function isPowerShellShell(shell: string | null | undefined): boolean {
  if (!shell) return false;
  const normalized = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return normalized.startsWith('powershell') || normalized === 'pwsh' || normalized === 'pwsh.exe';
}

/** 把一条 SGR 序列里的参数 `40` 换成 `49`（默认背景），其余参数保持原样。 */
function replaceBlackBackground(data: string): string {
  return data.replace(/\u001b\[([0-9;]*)m/g, (whole, params: string) => {
    if (!params) return whole;
    let changed = false;
    const next = params.split(';').map((part) => {
      if (part === '40') {
        changed = true;
        return '49';
      }
      return part;
    });
    return changed ? `\u001b[${next.join(';')}m` : whole;
  });
}

export function normalizePowerShellReadlineRedraw(
  data: string,
  shell: string | null | undefined,
): string {
  if (!isPowerShellShell(shell)) return data;
  if (!data.includes(ESC)) return data;
  // 多行输出不是光标重绘：整段日志里的 `40` 属于用户程序。
  if (data.includes('\n')) return data;
  if (!data.includes(CURSOR_SHOW)) return data;

  const hasBlackBackground = Array.from(data.matchAll(SGR_SEQUENCE)).some((match) =>
    match[1]?.split(';').includes('40'));
  if (!hasBlackBackground) return data;

  return replaceBlackBackground(data);
}
