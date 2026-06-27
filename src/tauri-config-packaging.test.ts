import { describe, expect, it } from 'vitest';

import tauriConfig from '../src-tauri/tauri.conf.json';

describe('tauri bundle resources', () => {
  it('bundles the sidecar without bundling a Node.js runtime', () => {
    const resources = tauriConfig.bundle?.resources;

    expect(resources).toBeDefined();
    expect(resources).toMatchObject({
      'sidecar/': 'sidecar/',
    });
    expect(resources).not.toHaveProperty('target/node-runtime/');
  });
});
