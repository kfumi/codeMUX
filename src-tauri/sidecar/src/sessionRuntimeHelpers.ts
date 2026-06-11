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

export function buildMcpInstructions(
  mcpServers?: Record<string, unknown>,
  serverInstructions?: Record<string, string>,
  isLimitedProvider = false,
): string | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined;

  const lines: string[] = [];
  const serverNames = Object.keys(mcpServers);

  if (serverInstructions && Object.keys(serverInstructions).length > 0) {
    for (const name of serverNames) {
      const instruction = serverInstructions[name];
      if (!instruction) continue;
      lines.push(`## ${name}`);
      lines.push(instruction);
      lines.push('');
    }
  }

  lines.push(`MCP servers available: ${serverNames.join(', ')}.`);
  lines.push('Use MCP tools when they are relevant to the task.');

  if (isLimitedProvider) {
    lines.push('Tool discovery may be limited on this provider.');
    lines.push('If an MCP server is still pending when needed, WaitForMcpServers can be used as a fallback.');
  }

  return lines.join('\n');
}
