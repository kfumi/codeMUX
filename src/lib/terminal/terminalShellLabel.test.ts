import { describe, expect, it } from 'vitest';

import { terminalShellLabel } from './terminalShellLabel';

describe('terminalShellLabel', () => {
  it('maps the shells we support to short labels', () => {
    expect(terminalShellLabel('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('PowerShell');
    expect(terminalShellLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('Windows PowerShell');
    expect(terminalShellLabel('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(terminalShellLabel('/bin/zsh')).toBe('zsh');
    expect(terminalShellLabel('/usr/bin/bash')).toBe('bash');
  });

  it('returns null when the daemon did not report a shell', () => {
    expect(terminalShellLabel(null)).toBeNull();
    expect(terminalShellLabel(undefined)).toBeNull();
    expect(terminalShellLabel('')).toBeNull();
  });
});
