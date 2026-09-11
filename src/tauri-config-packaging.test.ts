import { describe, expect, it } from 'vitest';

import tauriConfig from '../src-tauri/tauri.conf.json';
import tauriWindowsConfig from '../src-tauri/tauri.windows.conf.json';

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

  it('bundles the supervisor daemon binary into the resource daemon/ directory', () => {
    // supervisor(supervisor.rs)在 release 下从 resource_dir/daemon 解析
    // codemux-daemon。映射放在 Windows 平台配置(tauri.windows.conf.json,
    // 与主配置深度合并):当前仅覆盖 Windows 打包,unix 打包归工单 09。
    const resources = tauriWindowsConfig.bundle?.resources;

    expect(resources).toMatchObject({
      'target/release/codemux-daemon.exe': 'daemon/codemux-daemon.exe',
    });
    // 主配置不得包含该映射(unix 上 target/release/codemux-daemon.exe 不存在,
    // 会直接打断 cargo check / cargo test 的构建脚本)。
    expect(tauriConfig.bundle?.resources).not.toHaveProperty('target/release/codemux-daemon.exe');
  });
});
