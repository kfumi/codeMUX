export type McpTransportType = 'stdio' | 'http' | 'sse';

export interface McpTransportStdio {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpTransportHttp {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpTransportSse {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpTransport = McpTransportStdio | McpTransportHttp | McpTransportSse;

export interface McpServer {
  id: string;
  name: string;
  description: string;
  subtitle: string;
  transport: McpTransport;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
