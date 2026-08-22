import { describe, expect, it } from 'vitest';
import { buildMobilePermissionResponse } from './permissionResponse';

describe('buildMobilePermissionResponse', () => {
  it('uses native decision strings for Claude and Codex', () => {
    expect(buildMobilePermissionResponse('claude_code', 'once')).toBe('once');
    expect(buildMobilePermissionResponse('codex', 'reject')).toBe('reject');
    // Issue 12: Codex app-server bridge maps always → acceptForSession.
    expect(buildMobilePermissionResponse('codex', 'always')).toBe('always');
    expect(buildMobilePermissionResponse('claude_code', 'always')).toBe('always');
  });

  it('uses the OpenCode approval object for OpenCode sessions', () => {
    expect(buildMobilePermissionResponse('opencode', 'once')).toEqual({ approved: true });
    expect(buildMobilePermissionResponse('opencode', 'always')).toEqual({ approved: true });
    expect(buildMobilePermissionResponse('opencode', 'reject')).toEqual({ approved: false });
  });
});
