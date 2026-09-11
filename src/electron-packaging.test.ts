import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Electron 壳打包契约(工单 09:Tauri 壳退役后,打包守护对象从
 * src-tauri/tauri.conf.json 迁到 desktop-electron/electron-builder.yml)。
 * 以文本断言保持零依赖(不引入 yaml 解析器)。
 */
const BUILDER_YML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop-electron', 'electron-builder.yml'),
  'utf8',
);

describe('electron bundle resources', () => {
  it('ships the renderer with the shell (dist-electron + renderer-dist)', () => {
    expect(BUILDER_YML).toMatch(/^\s+- dist-electron\/\*\*/m);
    expect(BUILDER_YML).toMatch(/^\s+- renderer-dist\/\*\*/m);
    expect(BUILDER_YML).toMatch(/^\s+- package\.json$/m);
  });

  it('bundles the supervisor daemon binary into the resource daemon/ directory', () => {
    // supervisor 在 release 下从资源根 daemon/ 解析 codemux-daemon.exe。
    expect(BUILDER_YML).toMatch(
      /from:\s*\.\.\/src-tauri\/target\/release\/codemux-daemon\.exe\s*\n\s*to:\s*daemon\/codemux-daemon\.exe/,
    );
  });

  it('bundles the tray/app icon', () => {
    expect(BUILDER_YML).toMatch(/from:\s*\.\.\/src-tauri\/icons\/icon\.ico\s*\n\s*to:\s*icons\/icon\.ico/);
  });

  it('publishes to the GitHub Releases feed used by electron-updater', () => {
    expect(BUILDER_YML).toMatch(/provider:\s*github/);
    expect(BUILDER_YML).toMatch(/owner:\s*kfumi/);
    expect(BUILDER_YML).toMatch(/repo:\s*codeMUX/);
  });

  it('keeps the notification identity aligned with main.ts setAppUserModelId', () => {
    expect(BUILDER_YML).toMatch(/appId:\s*com\.codemux\.desktop/);
  });
});
