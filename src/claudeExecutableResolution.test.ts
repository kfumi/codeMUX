import { describe, expect, it } from 'vitest';

import { resolveClaudeExecutable } from '../apps/sidecar/src/claudeExecutable';

describe('resolveClaudeExecutable', () => {
  it('only resolves the native Claude binary from the managed Runtime', () => {
    const resolved = resolveClaudeExecutable({
      platform: 'win32',
      fileExists: (candidate) =>
        candidate === 'C:\\Users\\kuangdi\\AppData\\Local\\CodeMUX\\runtimes\\claude_code\\0.3.220\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe' ||
        candidate === 'C:\\Users\\kuangdi\\AppData\\Roaming\\nvm\\nodejs\\claude',
      runtimePath: 'C:\\Users\\kuangdi\\AppData\\Local\\CodeMUX\\runtimes\\claude_code\\0.3.220',
    });

    expect(resolved).toBe('C:\\Users\\kuangdi\\AppData\\Local\\CodeMUX\\runtimes\\claude_code\\0.3.220\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe');
  });
});
