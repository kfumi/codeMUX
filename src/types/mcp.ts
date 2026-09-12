export interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
  pi: boolean;
}

export type McpServerSpec = {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export interface McpServer {
  id: string;
  name: string;
  description: string;
  server: McpServerSpec;
  apps: McpApps;
  /** 内置 server(daemon 动态提供):展示为「内置」,不可编辑/删除/单独开关。 */
  builtin?: boolean;
}
