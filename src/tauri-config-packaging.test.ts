import { describe, expect, it } from 'vitest';

import tauriConfig from '../src-tauri/tauri.conf.json';

describe('tauri bundle resources', () => {
  it('bundles the sidecar runtime assets required by MSI installs', () => {
    const resources = tauriConfig.bundle?.resources;

    expect(resources).toBeDefined();
    expect(resources).toMatchObject({
      'sidecar/': 'sidecar/',
      'target/node-runtime/': 'runtime/node/',
    });
  });
});
