import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src-mobile', 'dist');
const target = path.join(root, 'dist-mobile');

function runNpm(args) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCmd, args, {
    cwd: path.join(root, 'src-mobile'),
    stdio: 'inherit',
    // Windows 上 nvm 的 npm.cmd 是批处理，Node >= 20 直接 spawn .cmd 会 EINVAL，必须走 shell
    shell: process.platform === 'win32',
  });
}

function ensureMobileBuild() {
  if (existsSync(path.join(source, 'index.html'))) {
    console.log('Mobile build up to date; skipping rebuild');
    return;
  }
  console.log('Mobile build output missing; building src-mobile first...');
  const install = runNpm(['install']);
  if (install.status !== 0) {
    console.error('Failed to install mobile dependencies');
    process.exit(1);
  }
  const build = runNpm(['run', 'build']);
  if (build.status !== 0) {
    console.error('Failed to build mobile app');
    process.exit(1);
  }
}

ensureMobileBuild();

if (!existsSync(source)) {
  console.error(`Mobile build output not found: ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`Copied mobile build to ${target}`);
