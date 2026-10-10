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
  /**
   * 列表投影(仅内置条目由 daemon 现算填入):当前开关下模型看得见的工具名。
   * 用户自建 server 留空 —— 它的工具名来自探测结果(`probeTools`),不在这里。
   */
  tools?: string[];
}
