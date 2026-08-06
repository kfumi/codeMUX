// Runtime Loader：从 Rust 传入的 ProviderRuntimeRef 解析 SDK 路径。
//
// 当 ensure_session 命令携带 runtimeRef 时，sidecar 从显式路径加载 SDK，
// 不再依赖 bundled node_modules 或用户全局 npm 目录。
//
// 托管 npm Runtime 目录结构：
//   <runtimePath>/
//     package.json
//     node_modules/
//       @anthropic-ai/claude-agent-sdk/
//       @anthropic-ai/claude-agent-sdk-win32-x64/
//         claude.exe
//       @openai/codex-sdk/
//       @opencode-ai/sdk/
//       opencode-ai/
//         bin/
//           opencode.exe

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ProviderRuntimeRef, Provider, RuntimeError } from './runtimeContract.js';
import { validateProviderRuntimeRef } from './runtimeContract.js';

/** Runtime 加载结果。 */
export interface RuntimeLoadResult {
  ref: ProviderRuntimeRef;
  /** Runtime 的 node_modules 目录绝对路径。 */
  nodeModulesPath: string;
  /**
   * 从 runtimePath 创建的 require 函数，用于从外部 runtime 加载 SDK 模块。
   * 等价于在 runtimePath/package.json 下执行 require.resolve()。
   */
  runtimeRequire: NodeRequire;
  /** 从 Runtime 根目录按 ESM exports 规则动态导入模块。 */
  runtimeImport: (pkg: string) => Promise<unknown>;
}

/** `loadProviderRuntime` 的返回类型（成功或错误）。 */
export type RuntimeLoadOutcome = RuntimeLoadResult | RuntimeError;

/** 类型守卫：判断 `loadProviderRuntime` 的返回值是否为错误。 */
export function isRuntimeError(
  outcome: RuntimeLoadOutcome,
): outcome is RuntimeError {
  return outcome !== null && typeof outcome === 'object' && 'kind' in outcome;
}

/**
 * 校验并加载 Provider Runtime。
 *
 * 1. 校验 ProviderRuntimeRef 必填字段
 * 2. 校验 runtimePath 存在且包含 package.json
 * 3. 校验 node_modules 目录存在
 * 4. 创建 runtimeRequire 供后续 SDK 模块加载使用
 *
 * 返回 `RuntimeError` 表示加载失败（Runtime 缺失、损坏或路径无效）。
 */
export function loadProviderRuntime(ref: ProviderRuntimeRef): RuntimeLoadResult | RuntimeError {
  const validationError = validateProviderRuntimeRef(ref);
  if (validationError) return validationError;

  const { runtimePath } = ref;

  // 校验 runtimePath 存在
  if (!fs.existsSync(runtimePath)) {
    return {
      kind: 'integrity_failed',
      provider: ref.provider,
      stage: 'verifying_integrity',
      message: `Runtime 路径不存在: ${runtimePath}`,
      recoverable: false,
    };
  }

  // 校验 package.json 存在（托管 Runtime 的关键文件）
  const packageJsonPath = path.join(runtimePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      kind: 'integrity_failed',
      provider: ref.provider,
      stage: 'verifying_integrity',
      message: `Runtime 缺少 package.json: ${runtimePath}`,
      recoverable: false,
    };
  }

  // 校验 node_modules 目录存在
  const nodeModulesPath = path.join(runtimePath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return {
      kind: 'integrity_failed',
      provider: ref.provider,
      stage: 'verifying_integrity',
      message: `Runtime 缺少 node_modules: ${runtimePath}`,
      recoverable: false,
    };
  }

  // 创建从 runtimePath 解析模块的 require 函数
  const runtimeRequire = createRequire(path.join(runtimePath, 'package.json'));
  const runtimeImport = (pkg: string): Promise<unknown> => {
    const modulePath = resolveRuntimeImportPath(runtimePath, pkg);
    return import(pathToFileURL(modulePath).href);
  };

  return { ref, nodeModulesPath, runtimeRequire, runtimeImport };
}

/**
 * 解析 Runtime 内部的 ESM 包入口。
 *
 * Provider SDK 可能只声明 `exports.import`，此时 createRequire 无法加载；
 * 解析必须仍然以 Runtime 的 node_modules 为根，不能退回 sidecar 的依赖树。
 */
function resolveRuntimeImportPath(runtimePath: string, specifier: string): string {
  const parts = specifier.split('/');
  const packageParts = specifier.startsWith('@') ? 2 : 1;
  const packageName = parts.slice(0, packageParts).join('/');
  const subpath = parts.slice(packageParts).join('/');
  const packageRoot = path.join(runtimePath, 'node_modules', packageName);
  const packageJsonPath = path.join(packageRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Runtime 包不存在: ${specifier}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };
  const exportKey = subpath ? `./${subpath}` : '.';
  const target = resolveRuntimeExportTarget(packageJson.exports, exportKey);
  const relativeTarget = target ?? packageJson.module ?? packageJson.main ?? 'index.js';
  const modulePath = path.resolve(packageRoot, relativeTarget);
  const relative = path.relative(packageRoot, modulePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime 包入口越界: ${specifier}`);
  }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Runtime 包入口不存在: ${specifier} -> ${modulePath}`);
  }
  return modulePath;
}

function resolveRuntimeExportTarget(exportsField: unknown, exportKey: string): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (Array.isArray(exportsField)) {
    for (const candidate of exportsField) {
      const resolved = resolveRuntimeExportTarget(candidate, exportKey);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const hasSubpathKeys = Object.keys(record).some((key) => key.startsWith('.'));
  if (hasSubpathKeys) {
    return resolveRuntimeExportTarget(record[exportKey], exportKey);
  }
  for (const condition of ['import', 'node', 'default', 'require']) {
    const resolved = resolveRuntimeExportTarget(record[condition], exportKey);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * 从 Runtime 加载结果解析 Claude 可执行文件路径。
 *
 * 查找 `node_modules/@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude[.exe]`。
 */
export function resolveClaudeFromRuntime(
  loaded: RuntimeLoadResult,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  const packageName = claudePlatformPackageName(platform, arch);
  if (!packageName) return undefined;

  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(
    loaded.nodeModulesPath,
    packageName,
    binaryName,
  );
  return fs.existsSync(candidate) ? candidate : undefined;
}

function claudePlatformPackageName(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  const archSuffix = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!archSuffix) return undefined;

  switch (platform) {
    case 'win32':
      return `@anthropic-ai/claude-agent-sdk-win32-${archSuffix}`;
    case 'darwin':
      return `@anthropic-ai/claude-agent-sdk-darwin-${archSuffix}`;
    case 'linux':
      return `@anthropic-ai/claude-agent-sdk-linux-${archSuffix}`;
    default:
      return undefined;
  }
}

/**
 * 从 Runtime 加载结果解析 OpenCode 可执行文件路径。
 *
 * 查找 `node_modules/opencode-ai/bin/opencode[.cmd|.exe]`。
 */
export function resolveOpenCodeFromRuntime(
  loaded: RuntimeLoadResult,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const names =
    platform === 'win32'
      ? ['opencode.cmd', 'opencode.exe', 'opencode']
      : ['opencode'];

  const binDir = path.join(loaded.nodeModulesPath, 'opencode-ai', 'bin');
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 也检查 .bin 目录
  const dotBinDir = path.join(loaded.nodeModulesPath, '.bin');
  for (const name of names) {
    const candidate = path.join(dotBinDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * 获取 Runtime 的 node_modules/.bin 目录路径，用于注入 PATH。
 * 这样 SDK 内部 spawn 的 CLI 进程能命中 runtime 中的版本。
 */
export function runtimeBinPath(loaded: RuntimeLoadResult): string {
  return path.join(loaded.nodeModulesPath, '.bin');
}

/**
 * 将 runtime 的 bin 目录前置注入 PATH 环境变量。
 * 确保 SDK 内部 spawn 的 CLI 进程能命中 runtime 中的版本。
 */
export function injectRuntimePath(loaded: RuntimeLoadResult): void {
  const binPath = runtimeBinPath(loaded);
  if (fs.existsSync(binPath)) {
    const currentPath = process.env.PATH ?? '';
    const entries = currentPath.split(path.delimiter).filter(Boolean);
    if (!entries.includes(binPath)) {
      process.env.PATH = [binPath, ...entries].join(path.delimiter);
    }
  }
}

/** 判断 ensure_session 命令是否携带了有效的 runtimeRef。 */
export function hasRuntimeRef(
  runtimeRef: unknown,
): runtimeRef is ProviderRuntimeRef {
  if (!runtimeRef || typeof runtimeRef !== 'object') return false;
  const ref = runtimeRef as Record<string, unknown>;
  return (
    typeof ref.provider === 'string' &&
    typeof ref.runtimePath === 'string' &&
    typeof ref.runtimeVersion === 'string'
  );
}

/** Provider 对应的 SDK 包名（用于诊断日志）。 */
export function sdkPackageName(provider: Provider): string {
  switch (provider) {
    case 'claude_code':
      return '@anthropic-ai/claude-agent-sdk';
    case 'codex':
      return '@openai/codex-sdk';
    case 'opencode':
      return '@opencode-ai/sdk';
  }
}
