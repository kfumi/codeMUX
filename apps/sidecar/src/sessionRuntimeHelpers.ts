export type ProviderMode = 'anthropic' | 'custom';

export function getProviderMode(baseUrl?: string | null): {
  providerMode: ProviderMode;
  supportsDeferredToolSearch: boolean;
} {
  if (!baseUrl) {
    return {
      providerMode: 'anthropic',
      supportsDeferredToolSearch: true,
    };
  }

  try {
    const parsed = new URL(baseUrl);
    const normalizedHost = parsed.host.toLowerCase();
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    const isDefaultAnthropic =
      normalizedHost === 'api.anthropic.com' &&
      (normalizedPath === '' || normalizedPath === '/');

    if (isDefaultAnthropic) {
      return {
        providerMode: 'anthropic',
        supportsDeferredToolSearch: true,
      };
    }
  } catch {
    // Invalid custom URLs should still follow the safer custom-provider path.
  }

  return {
    providerMode: 'custom',
    supportsDeferredToolSearch: false,
  };
}

export function buildMcpInstructions(): undefined {
  return undefined;
}

export function shouldUseCodexChatCompatProxy(baseUrl?: string | null, explicitNeedsProxy?: boolean): boolean {
  if (explicitNeedsProxy !== undefined) {
    return explicitNeedsProxy;
  }

  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    const normalizedHost = parsed.host.toLowerCase();
    return normalizedHost !== 'api.openai.com' && normalizedHost !== 'api.deepseek.com';
  } catch {
    return true;
  }
}

/**
 * Windows sandbox 兼容：过滤 PATH 中的 WindowsApps 目录，避免 Codex 子进程
 * 命中商店版 python/node shim 导致沙箱探测失败。
 */
export function applyCodexWindowsSandboxPathCompatibility(env: Record<string, string>): void {
  if (process.platform !== 'win32') {
    return;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const pathValue = env[pathKey];
  if (!pathValue) {
    return;
  }

  const filtered = pathValue
    .split(';')
    .filter((entry) => entry.trim().length > 0)
    .filter((entry) => !entry.toLowerCase().includes('\\windowsapps'))
    .join(';');

  if (filtered) {
    env[pathKey] = filtered;
  }
}
