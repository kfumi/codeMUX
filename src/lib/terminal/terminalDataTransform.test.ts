import { describe, expect, it } from 'vitest';

import { isPowerShellShell, normalizePowerShellReadlineRedraw } from './terminalDataTransform';

const CURSOR_SHOW = '\u001b[?25h';

describe('isPowerShellShell', () => {
  it('recognises powershell and pwsh on any path', () => {
    expect(isPowerShellShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    expect(isPowerShellShell('/usr/local/bin/pwsh')).toBe(true);
    expect(isPowerShellShell('bash')).toBe(false);
    expect(isPowerShellShell(null)).toBe(false);
  });
});

describe('normalizePowerShellReadlineRedraw', () => {
  it('rewrites the black background of a single-line cursor redraw', () => {
    const redraw = `\u001b[1;40mPS> \u001b[0m${CURSOR_SHOW}`;
    expect(normalizePowerShellReadlineRedraw(redraw, 'pwsh')).toBe(
      `\u001b[1;49mPS> \u001b[0m${CURSOR_SHOW}`,
    );
  });

  it('keeps other SGR parameters intact', () => {
    expect(normalizePowerShellReadlineRedraw(`\u001b[1;40;32mX${CURSOR_SHOW}`, 'powershell')).toBe(
      `\u001b[1;49;32mX${CURSOR_SHOW}`,
    );
  });

  it('leaves non-PowerShell output untouched', () => {
    const data = `\u001b[1;40mX${CURSOR_SHOW}`;
    expect(normalizePowerShellReadlineRedraw(data, 'bash')).toBe(data);
  });

  it('leaves multi-line output untouched', () => {
    const data = `\u001b[1;40mX${CURSOR_SHOW}\nblack background from a program`;
    expect(normalizePowerShellReadlineRedraw(data, 'pwsh')).toBe(data);
  });

  it('leaves single-line output without a cursor redraw untouched', () => {
    const data = '\u001b[40mblack\u001b[0m';
    expect(normalizePowerShellReadlineRedraw(data, 'pwsh')).toBe(data);
  });

  it('does nothing when no black background is present', () => {
    const data = `\u001b[1;32mPS> \u001b[0m${CURSOR_SHOW}`;
    expect(normalizePowerShellReadlineRedraw(data, 'pwsh')).toBe(data);
  });
});
