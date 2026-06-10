import { describe, expect, it } from 'vitest';

import { resolveClaudeExecutable } from '../src-tauri/sidecar/src/claudeExecutable';

describe('resolveClaudeExecutable', () => {
  it('prefers the SDK-bundled native Claude binary over a PATH-discovered shim', () => {
    const resolved = resolveClaudeExecutable({
      platform: 'win32',
      fileExists: (candidate) =>
        candidate === 'C:\\app\\sidecar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe' ||
        candidate === 'C:\\Users\\kuangdi\\AppData\\Roaming\\nvm\\nodejs\\claude',
      sidecarDir: 'C:\\app\\sidecar\\dist',
      pathClaude: 'C:\\Users\\kuangdi\\AppData\\Roaming\\nvm\\nodejs\\claude',
    });

    expect(resolved).toBe('C:\\app\\sidecar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe');
  });
});
