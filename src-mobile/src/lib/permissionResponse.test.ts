import { describe, expect, it } from 'vitest';
import { buildMobilePermissionResponse } from './permissionResponse';

describe('buildMobilePermissionResponse', () => {
  it('uses native once/reject values for Claude and Codex', () => {
    expect(buildMobilePermissionResponse('claude_code', true)).toBe('once');
    expect(buildMobilePermissionResponse('codex', false)).toBe('reject');
  });

  it('uses the OpenCode approval object for OpenCode sessions', () => {
    expect(buildMobilePermissionResponse('opencode', true)).toEqual({ approved: true });
    expect(buildMobilePermissionResponse('opencode', false)).toEqual({ approved: false });
  });
});
