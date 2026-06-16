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

export function shouldUseCodexChatCompatProxy(baseUrl?: string | null): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    return parsed.host.toLowerCase() !== 'api.openai.com';
  } catch {
    return true;
  }
}
