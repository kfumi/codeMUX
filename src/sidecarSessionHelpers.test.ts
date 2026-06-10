import { describe, expect, it } from 'vitest';

import {
  buildMcpInstructions,
  getProviderMode,
} from '../src-tauri/sidecar/src/sessionRuntimeHelpers';

describe('getProviderMode', () => {
  it('treats the default Anthropic endpoint as deferred-capable', () => {
    expect(getProviderMode(undefined)).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });

    expect(getProviderMode('https://api.anthropic.com')).toEqual({
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    });
  });

  it('treats custom base urls as limited-provider mode', () => {
    expect(getProviderMode('https://example-proxy.internal/anthropic')).toEqual({
      providerMode: 'custom',
      supportsDeferredToolSearch: false,
    });
  });
});

describe('buildMcpInstructions', () => {
  it('includes server instructions without forcing WaitForMcpServers first', () => {
    const text = buildMcpInstructions(
      { context7: {}, filesystem: {} },
      { context7: 'Use for docs lookups.' },
      false,
    );

    expect(text).toContain('## context7');
    expect(text).toContain('Use for docs lookups.');
    expect(text).toContain('MCP servers available: context7, filesystem.');
    expect(text).not.toContain('Before using any MCP tool, call WaitForMcpServers first.');
  });

  it('mentions limited provider mode when deferred tool search is unavailable', () => {
    const text = buildMcpInstructions(
      { context7: {} },
      {},
      true,
    );

    expect(text).toContain('Tool discovery may be limited on this provider.');
  });
});
