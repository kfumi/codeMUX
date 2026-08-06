// SDK 动态加载器：从 CodeMUX 托管 Runtime 路径加载 Provider SDK 模块。
//
// 生产安装包只打包 sidecar/dist/，不包含 node_modules（spec L54/L68）。
// 因此生产环境必须通过 runtimeRef 从外部 Runtime 路径加载 SDK。
//
// 当 ensure_session 命令携带 runtimeRef 时，从 Runtime 路径的 node_modules 加载 SDK；
// 否则（仅开发模式 / vitest mock 场景）回退到 sidecar 自身的 node_modules。
// 生产构建中该回退路径不可达（node_modules 不打包），符合 spec "不保留安装包内 SDK fallback"。

import type { RuntimeLoadResult } from './runtimeLoader.js';

/** Claude Agent SDK 模块导出。 */
export interface ClaudeSdkModule {
  query: typeof import('@anthropic-ai/claude-agent-sdk').query;
  startup: typeof import('@anthropic-ai/claude-agent-sdk').startup;
}

/** Codex SDK 模块导出。 */
export interface CodexSdkModule {
  Codex: typeof import('@openai/codex-sdk').Codex;
}

/** OpenCode SDK client 模块导出。 */
export interface OpenCodeClientSdkModule {
  createOpencodeClient: typeof import('@opencode-ai/sdk/client').createOpencodeClient;
}

/** OpenCode SDK server 模块导出。 */
export interface OpenCodeServerSdkModule {
  createOpencodeServer: typeof import('@opencode-ai/sdk/server').createOpencodeServer;
}

/**
 * 从 Runtime 加载结果加载指定 SDK 模块的共享实现。
 *
 * 生产路径：通过 `loaded.runtimeRequire(pkg)` 从外部 Runtime 的 node_modules 加载。
 * 开发/测试回退：当 `loaded` 为 null 时，回退到 sidecar 自身的 `import(pkg)`，
 *   供 `npm run dev` 和 vitest mock 使用。生产构建不含 node_modules，此分支不可达。
 */
async function loadSdkModule<T>(loaded: RuntimeLoadResult | null, pkg: string): Promise<T> {
  if (loaded) {
    return loaded.runtimeRequire(pkg) as T;
  }
  const mod = await import(pkg);
  return mod as unknown as T;
}

/** 从 Runtime 加载结果或 sidecar 自身加载 Claude Agent SDK。 */
export function loadClaudeSdk(loaded: RuntimeLoadResult | null): Promise<ClaudeSdkModule> {
  return loadSdkModule<ClaudeSdkModule>(loaded, '@anthropic-ai/claude-agent-sdk');
}

/** 从 Runtime 加载结果或 sidecar 自身加载 Codex SDK。 */
export function loadCodexSdk(loaded: RuntimeLoadResult | null): Promise<CodexSdkModule> {
  return loadSdkModule<CodexSdkModule>(loaded, '@openai/codex-sdk');
}

/** 从 Runtime 加载结果或 sidecar 自身加载 OpenCode SDK client。 */
export function loadOpenCodeClientSdk(
  loaded: RuntimeLoadResult | null,
): Promise<OpenCodeClientSdkModule> {
  return loadSdkModule<OpenCodeClientSdkModule>(loaded, '@opencode-ai/sdk/client');
}

/** 从 Runtime 加载结果或 sidecar 自身加载 OpenCode SDK server。 */
export function loadOpenCodeServerSdk(
  loaded: RuntimeLoadResult | null,
): Promise<OpenCodeServerSdkModule> {
  return loadSdkModule<OpenCodeServerSdkModule>(loaded, '@opencode-ai/sdk/server');
}
