export function buildRelayWsUrl(args: {
  endpoint: string;
  useTls: boolean;
  serverId: string;
  role: 'client' | 'server';
  connectionId?: string;
}): string {
  const trimmed = args.endpoint.trim();
  const [host, portText] = trimmed.includes(':')
    ? (trimmed.split(':') as [string, string])
    : [trimmed, args.useTls ? '443' : '80'];
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port)) {
    throw new Error('Invalid relay port');
  }
  const protocol = args.useTls ? 'wss' : 'ws';
  const params = new URLSearchParams({
    serverId: args.serverId,
    role: args.role,
    v: '2',
  });
  if (args.connectionId) {
    params.set('connectionId', args.connectionId);
  }
  return `${protocol}://${host}:${port}/ws?${params.toString()}`;
}

export function createRelayConnectionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
