import { describe, expect, it } from 'vitest';

import tauriConfig from '../src-tauri/tauri.conf.json';

describe('tauri bundle resources', () => {
  it('bundles only the compiled sidecar without bundling a Node.js runtime or SDK node_modules', () => {
    const resources = tauriConfig.bundle?.resources;

    expect(resources).toBeDefined();
    // 仅打包编译后的 sidecar dist，不打包完整 node_modules 或 SDK
    expect(resources).toMatchObject({
      'sidecar/dist/': 'sidecar/dist/',
    });
    // 不应包含完整 sidecar 目录或 Node.js 运行时
    expect(resources).not.toHaveProperty('sidecar/');
    expect(resources).not.toHaveProperty('sidecar/node_modules/');
    expect(resources).not.toHaveProperty('target/node-runtime/');
  });
});
