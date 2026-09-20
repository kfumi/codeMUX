import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Electron 壳打包契约(工单 09:Tauri 壳退役后,打包守护对象从
 * src-tauri/tauri.conf.json 迁到 apps/desktop/electron-builder.yml)。
 * 以文本断言保持零依赖(不引入 yaml 解析器)。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_YML = readFileSync(
  join(REPO_ROOT, 'apps', 'desktop', 'electron-builder.yml'),
  'utf8',
);
const COPY_SIDECAR_SCRIPT = join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'copy-sidecar-dist.mjs');
const DESKTOP_PACKAGE_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const ROOT_PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** daemon 侧常量是 sidecar 资源路径的唯一真相,断言两边一致而非各自硬编码。 */
const AGENT_MOD_RS = readFileSync(join(REPO_ROOT, 'crates', 'daemon', 'src', 'agent', 'mod.rs'), 'utf8');

function rustConst(name: string): string {
  const match = AGENT_MOD_RS.match(new RegExp(`const ${name}: &str = "([^"]+)"`));
  if (!match) {
    throw new Error(`crates/daemon/src/agent/mod.rs 缺少常量 ${name}`);
  }
  return match[1];
}

describe('electron bundle resources', () => {
  it('ships the renderer with the shell (dist-electron + renderer-dist)', () => {
    expect(BUILDER_YML).toMatch(/^\s+- dist-electron\/\*\*/m);
    expect(BUILDER_YML).toMatch(/^\s+- renderer-dist\/\*\*/m);
    expect(BUILDER_YML).toMatch(/^\s+- package\.json$/m);
  });

  it('bundles the supervisor daemon binary into the resource daemon/ directory', () => {
    // supervisor 在 release 下从资源根 daemon/ 解析 codemux-daemon.exe。
    expect(BUILDER_YML).toMatch(
      /from:\s*\.\.\/\.\.\/crates\/daemon\/target\/release\/codemux-daemon\.exe\s*\n\s*to:\s*daemon\/codemux-daemon\.exe/,
    );
  });

  it('bundles the tray/app icon', () => {
    expect(BUILDER_YML).toMatch(/from:\s*build\/icons\/icon\.ico\s*\n\s*to:\s*icons\/icon\.ico/);
  });

  it('publishes to the GitHub Releases feed used by electron-updater', () => {
    expect(BUILDER_YML).toMatch(/provider:\s*github/);
    expect(BUILDER_YML).toMatch(/owner:\s*kfumi/);
    expect(BUILDER_YML).toMatch(/repo:\s*codeMUX/);
  });

  it('keeps the notification identity aligned with main.ts setAppUserModelId', () => {
    expect(BUILDER_YML).toMatch(/appId:\s*com\.codemux\.desktop/);
  });

  // 缺 sidecar 的实际表现:安装后新建对话发送直接弹
  // `Bundled sidecar was not found at sidecar\dist/index.js`。
  it('bundles the agent sidecar at the path the daemon resolves', () => {
    const sidecarDir = rustConst('SIDECAR_RELATIVE_DIR');
    const entrypoint = rustConst('SIDECAR_ENTRYPOINT');

    expect(sidecarDir).toBe('sidecar');
    expect(entrypoint).toBe('dist/index.js');
    // extraResources: apps/desktop/sidecar-dist → <resources>/sidecar
    expect(BUILDER_YML).toMatch(
      new RegExp(`from:\\s*sidecar-dist\\s*\\n\\s*to:\\s*${sidecarDir}\\s*(\\n|$)`),
    );
  });

  it('rebuilds and copies the sidecar in the installer pipeline', () => {
    expect(ROOT_PACKAGE_JSON.scripts['build:electron-installer']).toContain('build:sidecar');
    expect(DESKTOP_PACKAGE_JSON.scripts['pack:win']).toContain('scripts/copy-sidecar-dist.mjs');
  });
});

/**
 * sidecar 拷贝脚本的端到端行为:布局(资源根 sidecar/dist/index.js)+ ESM 标记
 * (sidecar 是 ESM,dist/ 最近父级没有 package.json 时 Node 会按 CJS 解析)+ 陈旧
 * 产物拦截。用临时 fixture 跑真实脚本,避免只断言脚本文本。
 */
describe('copy-sidecar-dist script', () => {
  const fixtures: string[] = [];

  afterEach(() => {
    while (fixtures.length > 0) {
      rmSync(fixtures.pop()!, { recursive: true, force: true });
    }
  });

  function makeFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'codemux-sidecar-dist-'));
    fixtures.push(root);

    const sidecarDir = join(root, 'apps', 'sidecar');
    mkdirSync(join(sidecarDir, 'src'), { recursive: true });
    mkdirSync(join(sidecarDir, 'dist'), { recursive: true });
    writeFileSync(join(sidecarDir, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(sidecarDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'codemux-agent-sidecar',
          private: true,
          version: '0.0.1',
          type: 'module',
          scripts: { build: 'tsc' },
          devDependencies: { vitest: '^4.1.8' },
        },
        null,
        2,
      )}\n`,
    );

    const scriptsDir = join(root, 'apps', 'desktop', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(COPY_SIDECAR_SCRIPT, join(scriptsDir, 'copy-sidecar-dist.mjs'));

    // 先 src 后 dist:dist 更新才算“新鲜”,否则触发陈旧拦截。
    writeFileSync(join(sidecarDir, 'dist', 'index.js'), 'export {};\n');
    return root;
  }

  function runScript(root: string): string {
    return execFileSync(process.execPath, [join(root, 'apps', 'desktop', 'scripts', 'copy-sidecar-dist.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CODEMUX_ALLOW_STALE_SIDECAR: '' },
    });
  }

  it('emits <out>/dist/index.js plus an ESM-marking package.json', () => {
    const root = makeFixture();
    runScript(root);

    const outDir = join(root, 'apps', 'desktop', 'sidecar-dist');
    const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));

    expect(readFileSync(join(outDir, 'dist', 'index.js'), 'utf8')).toContain('export {};');
    expect(manifest).toEqual({
      name: 'codemux-agent-sidecar',
      private: true,
      version: '0.0.1',
      type: 'module',
    });
  });

  it('refuses to bundle a dist/ older than the sidecar source', () => {
    const root = makeFixture();
    const srcEntry = join(root, 'apps', 'sidecar', 'src', 'index.ts');
    utimesSync(srcEntry, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    let failure: { status?: number; stderr?: string } | null = null;
    try {
      runScript(root);
    } catch (error) {
      failure = error as { status?: number; stderr?: string };
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toContain('比源码旧');
  });
});
