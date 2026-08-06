// SDK 动态加载器：只从 CodeMUX 托管 Runtime 路径加载 Provider SDK 模块。
// sidecar 本身不包含 SDK，也不允许从 PATH 或自身 node_modules 回退加载。

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

/** 从托管 Runtime 加载指定 SDK 模块。 */
async function loadSdkModule<T>(
  loaded: RuntimeLoadResult | null,
  pkg: string,
  providerLabel: string,
): Promise<T> {
  if (!loaded) {
    throw new Error(`${providerLabel} Runtime is required before loading ${pkg}`);
  }
  process.stderr.write(
    `[runtime] provider=${loaded.ref.provider} sdk=${pkg} runtime=${loaded.ref.runtimePath} version=${loaded.ref.runtimeVersion} node=${process.execPath}\n`,
  );
  try {
    return loaded.runtimeRequire(pkg) as T;
  } catch (requireError) {
    try {
      return (await loaded.runtimeImport(pkg)) as T;
    } catch (importError) {
      const requireMessage = requireError instanceof Error ? requireError.message : String(requireError);
      const importMessage = importError instanceof Error ? importError.message : String(importError);
      throw new Error(`${providerLabel} Runtime 加载 ${pkg} 失败（require: ${requireMessage}; import: ${importMessage}）`);
    }
  }
}

/** 从托管 Runtime 加载 Claude Agent SDK。 */
export function loadClaudeSdk(loaded: RuntimeLoadResult | null): Promise<ClaudeSdkModule> {
  return loadSdkModule<ClaudeSdkModule>(loaded, '@anthropic-ai/claude-agent-sdk', 'Claude Code');
}

/** 从托管 Runtime 加载 Codex SDK。 */
export function loadCodexSdk(loaded: RuntimeLoadResult | null): Promise<CodexSdkModule> {
  return loadSdkModule<CodexSdkModule>(loaded, '@openai/codex-sdk', 'Codex');
}

/** 从托管 Runtime 加载 OpenCode SDK client。 */
export function loadOpenCodeClientSdk(
  loaded: RuntimeLoadResult | null,
): Promise<OpenCodeClientSdkModule> {
  return loadSdkModule<OpenCodeClientSdkModule>(loaded, '@opencode-ai/sdk/client', 'OpenCode');
}

/** 从托管 Runtime 加载 OpenCode SDK server。 */
export function loadOpenCodeServerSdk(
  loaded: RuntimeLoadResult | null,
): Promise<OpenCodeServerSdkModule> {
  return loadSdkModule<OpenCodeServerSdkModule>(loaded, '@opencode-ai/sdk/server', 'OpenCode');
}
