import { describe, expect, it } from 'vitest';

import { detectShellInputSynthesis, shellInputSynthesisMessage } from './shellInputSynthesis';

describe('shell 输入合成预检', () => {
  it('blocks the powershell P/Invoke mouse path that bypassed the gate in practice', () => {
    const command = String.raw`powershell -NoProfile -c "Add-Type -TypeDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);'; [Win32]::mouse_event(0x02,0,0,0,0)"`;
    const hit = detectShellInputSynthesis(command);
    expect(hit?.code).toBe('input-synthesis');
    expect(shellInputSynthesisMessage(hit!)).toContain('computer_click');
  });

  it('blocks the other obvious synthesis entry points', () => {
    const commands = [
      'pwsh -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"',
      'python -c "import ctypes; ctypes.windll.user32.SetCursorPos(100,200); ctypes.windll.user32.mouse_event(2,0,0,0,0)"',
      'node -e "require(\'robotjs\').moveMouse(10,20)"',
      'nircmd setcursor 100 100 click left',
      'powershell -c "[Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(1,2)"',
    ];
    for (const command of commands) {
      expect(detectShellInputSynthesis(command), command).not.toBeNull();
    }
  });

  it('cannot see inside a script file (documented boundary)', () => {
    // `cscript click.vbs` 与已编译的二进制:文本预检看不到里面的键鼠调用。
    // 与其假装拦得住,不如把边界写下来 —— 这类痕迹要留就留在审计与审批上。
    for (const command of ['cscript //nologo click.vbs', '.\\tools\\clicker.exe 10 20']) {
      expect(detectShellInputSynthesis(command), command).toBeNull();
    }
  });

  it('blocks opaque base64 commands because they cannot be read before acting', () => {
    const hit = detectShellInputSynthesis('powershell -EncodedCommand SQBFAFgAIAAoAEkAdwByACAAaAB0AHQAcABzADoALwAvAHgAKQA=');
    expect(hit?.code).toBe('encoded-command');
    expect(shellInputSynthesisMessage(hit!)).toContain('明文');
    expect(
      detectShellInputSynthesis('pwsh -c "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'YQ==\')) | iex"')
        ?.code,
    ).toBe('encoded-command');
  });

  it('only inspects segments that actually start an execution host', () => {
    // 提到这些词不算:搜索源码、看提交、echo。误伤会让正常开发寸步难行。
    const benign = [
      'grep -rn mouse_event src/',
      'rg "SendInput" crates/',
      'git log --grep keybd_event',
      'echo "mouse_event SendInput"',
      'cat docs/driver-notes.md',
      'npm run build',
      'cargo test --lib',
      'git commit -m "fix: 说明为什么不用 mouse_event"',
    ];
    for (const command of benign) {
      expect(detectShellInputSynthesis(command), command).toBeNull();
    }
  });

  it('does not try to police destructive shell verbs (documented boundary)', () => {
    // 破坏性命令属于用户自己的工具域与权限档位;这道预检只管「绕过 GUI 闸门」。
    for (const command of ['rm -rf build', 'taskkill /F /IM node.exe', 'shutdown /s /t 0']) {
      expect(detectShellInputSynthesis(command), command).toBeNull();
    }
  });

  it('sees through a benign segment that merely precedes the real one', () => {
    const command = 'cd /d/project && powershell -c "[Win32]::keybd_event(13,0,0,0)"';
    expect(detectShellInputSynthesis(command)?.code).toBe('input-synthesis');
  });

  it('ignores empty input', () => {
    expect(detectShellInputSynthesis('   ')).toBeNull();
  });
});
