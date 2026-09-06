import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_MANIFEST,
  DAEMON_CAPABILITIES,
  FORBIDDEN_SHELL_METHODS,
  SHELL_CAPABILITIES,
} from './capability-manifest';
import { daemonFacade } from './daemon-facade';
import { shellFacade } from './shell-facade';

describe('facade boundary', () => {
  it('classifies every spec capability as daemon or shell', () => {
    expect(CAPABILITY_MANIFEST.length).toBeGreaterThan(10);
    for (const entry of CAPABILITY_MANIFEST) {
      expect(['daemon', 'shell']).toContain(entry.owner);
    }
  });

  it('does not expose agent send/interrupt on shell facade', () => {
    for (const method of FORBIDDEN_SHELL_METHODS) {
      expect((shellFacade as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('maps daemon manifest entries to daemon facade methods or protocol helpers', () => {
    for (const entry of DAEMON_CAPABILITIES) {
      if (!entry.daemonMethod) continue;
      const method = entry.daemonMethod;
      const hasMethod =
        method in daemonFacade ||
        `${method}` in daemonFacade;
      expect(hasMethod).toBe(true);
    }
  });

  it('keeps browser host on shell facade only', () => {
    const shellIds = new Set(SHELL_CAPABILITIES.map((entry) => entry.id));
    expect(shellIds.has('browser.host')).toBe(true);
    expect(shellFacade.browser).toBeDefined();
  });
});
