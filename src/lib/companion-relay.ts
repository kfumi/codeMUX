export function parseRelayEndpoint(endpoint: string): { host: string; port: string } {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return { host: '', port: '443' };
  }
  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0) {
    return { host: trimmed, port: '443' };
  }
  return {
    host: trimmed.slice(0, separator),
    port: trimmed.slice(separator + 1),
  };
}

export function formatRelayEndpoint(host: string, port: string): string {
  return `${host.trim()}:${port.trim()}`;
}

export function isRelayEndpointValid(endpoint: string): boolean {
  const { host, port } = parseRelayEndpoint(endpoint);
  if (!host.trim()) return false;
  const parsedPort = Number.parseInt(port, 10);
  return Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535;
}

export function buildRelayBaseUrl(endpoint: string, useTls: boolean): string | null {
  if (!isRelayEndpointValid(endpoint)) return null;
  const { host, port } = parseRelayEndpoint(endpoint);
  const protocol = useTls ? 'https' : 'http';
  return `${protocol}://${host}:${port}`;
}
