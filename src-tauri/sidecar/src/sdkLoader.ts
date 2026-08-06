// SDK 动态加载器：从 CodeMUX 托管 Runtime 路径加载 Provider SDK 模块。
//
// 当 ensure_session 命令携带 runtimeRef 时，从 Runtime 路径的 node_modules 加载 SDK；
// 否则（开发模式或未安装 Runtime 时）回退到 sidecar 自身的 node_modules。
//
// 生产安装包只打包 sidecar/dist/，不包含 node_modules，
// 因此生产环境必须通过 runtimeRef 加载 SDK。
//
// Ticket 07：移除安装包内 SDK 依赖。

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
 * 从 Runtime 加载结果或 sidecar 自身加载 Claude Agent SDK。
 *
 * 优先使用 runtimeRequire（生产路径），回退到动态 import（开发模式，vitest mock 可拦截）。
 */
export async function loadClaudeSdk(loaded: RuntimeLoadResult | null): Promise<ClaudeSdkModule> {
  if (loaded) {
    return loaded.runtimeRequire('@anthropic-ai/claude-agent-sdk') as ClaudeSdkModule;
  }
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  return mod as unknown as ClaudeSdkModule;
}

/**
 * 从 Runtime 加载结果或 sidecar 自身加载 Codex SDK。
 */
export async function loadCodexSdk(loaded: RuntimeLoadResult | null): Promise<CodexSdkModule> {
  if (loaded) {
    return loaded.runtimeRequire('@openai/codex-sdk') as CodexSdkModule;
  }
  const mod = await import('@openai/codex-sdk');
  return mod as unknown as CodexSdkModule;
}

/**
 * 从 Runtime 加载结果或 sidecar 自身加载 OpenCode SDK client。
 */
export async function loadOpenCodeClientSdk(loaded: RuntimeLoadResult | null): Promise<OpenCodeClientSdkModule> {
  if (loaded) {
    return loaded.runtimeRequire('@opencode-ai/sdk/client') as OpenCodeClientSdkModule;
  }
  const mod = await import('@opencode-ai/sdk/client');
  return mod as unknown as OpenCodeClientSdkModule;
}

/**
 * 从 Runtime 加载结果或 sidecar 自身加载 OpenCode SDK server。
 */
export async function loadOpenCodeServerSdk(loaded: RuntimeLoadResult | null): Promise<OpenCodeServerSdkModule> {
  if (loaded) {
    return loaded.runtimeRequire('@opencode-ai/sdk/server') as OpenCodeServerSdkModule;
  }
  const mod = await import('@opencode-ai/sdk/server');
  return mod as unknown as OpenCodeServerSdkModule;
}
