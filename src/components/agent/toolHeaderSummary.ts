export interface ToolHeaderSummary {
  displayName?: string;
  text?: string;
  /** Original full path for path-based tools (Read/Write/Edit/etc.), shown in tooltip */
  fullPath?: string;
  consumedKeys: string[];
}

const BUILT_IN_TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  MultiEdit: '批量编辑文件',
  NotebookRead: '读取 Notebook',
  NotebookEdit: '编辑 Notebook',
  LS: '列目录',
  Glob: '匹配文件',
  Grep: '搜索文本',
  Bash: '运行命令',
  shell_command: '运行命令',
  apply_patch: '应用补丁',
  Agent: '子智能体',
  Task: '子智能体',
  subagent: '子智能体',
  WebSearch: '网页搜索',
  WebFetch: '读取网页',
  Skill: '技能',
  TodoWrite: '更新待办',
  TaskGet: '查看任务',
  TaskCreate: '创建任务',
  TaskUpdate: '更新任务',
  TaskList: '任务列表',
  update_plan: '更新计划',
  AskUserQuestion: '询问用户',
  request_user_input: '询问用户',
  EnterPlanMode: '进入计划模式',
  ExitPlanMode: '退出计划模式',
  EnterWorktree: '进入工作树',
  ExitWorktree: '退出工作树',
  WaitForMcpServers: '等待 MCP 服务',
  tool_search: '搜索工具',
};

export function getToolDisplayName(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[1] || toolName;
  }

  return BUILT_IN_TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

export function getToolHeaderSummary(toolName: string, input: Record<string, unknown>): ToolHeaderSummary {
  if (toolName.startsWith('mcp__')) {
    const queryKey = firstPresentKey(input, ['query', 'libraryName', 'libraryId', 'url', 'path']);
    const query = queryKey ? asDisplayText(input[queryKey]) : '';

    return {
      displayName: getToolDisplayName(toolName),
      text: query || undefined,
      consumedKeys: queryKey ? [queryKey] : [],
    };
  }

  const summary = (() => {
    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookRead':
      case 'NotebookEdit':
        return fromFirstKey(input, ['file_path', 'notebook_path', 'path']);

      case 'LS':
        return fromFirstKey(input, ['path']);

      case 'Glob':
      case 'Grep':
        return fromFirstKey(input, ['pattern', 'query']);

      case 'Bash':
      case 'shell_command':
        return shellCommandSummary(toolName, input);

      case 'Agent':
      case 'Task':
      case 'subagent':
        return fromFirstKey(input, ['description', 'prompt']);

      case 'WebSearch':
        return fromFirstKey(input, ['query']);

      case 'WebFetch':
        return fromFirstKey(input, ['url']);

      case 'Skill':
        return fromFirstKey(input, ['skill', 'name']);

      case 'TaskGet':
        return fromFirstKey(input, ['taskId', 'id']);

      case 'TaskCreate':
        return fromFirstKey(input, ['subject', 'description']);

      case 'TaskUpdate':
        return taskUpdateSummary(input);

      case 'update_plan':
        return fromFirstKey(input, ['explanation']);

      case 'AskUserQuestion':
        return fromFirstKey(input, ['question', 'header']);

      case 'TaskList':
      case 'EnterPlanMode':
      case 'ExitPlanMode':
      case 'WaitForMcpServers':
        return { consumedKeys: [] };

      default:
        return fromFirstKey(input, ['description', 'pattern', 'query', 'url', 'file_path', 'path', 'prompt', 'command']);
    }
  })();

  return {
    ...summary,
    displayName: getToolDisplayName(toolName),
  };
}

export function getDisplayableArgs(input: Record<string, unknown>, consumedKeys: string[]): Record<string, unknown> | null {
  const consumed = new Set(consumedKeys);
  const entries = Object.entries(input).filter(([key]) => !consumed.has(key));
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function shellCommandSummary(toolName: string, input: Record<string, unknown>): ToolHeaderSummary {
  const key = firstPresentKey(input, ['description', 'command', 'cmd', 'script']);
  if (!key) return { consumedKeys: [] };

  return {
    text: asDisplayText(input[key]),
    consumedKeys: toolName === 'shell_command' ? [] : Object.keys(input),
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\\\/g, '\\');
}

function fromFirstKey(input: Record<string, unknown>, keys: string[]): ToolHeaderSummary {
  const key = firstPresentKey(input, keys);
  if (!key) return { consumedKeys: [] };

  const rawValue = asDisplayText(input[key]);
  // For file paths, show only the filename (last segment), keep full path for tooltip
  const isPath = key.toLowerCase().includes('path');
  const value = isPath ? getFileName(normalizePath(rawValue)) : rawValue;
  return {
    text: value,
    fullPath: isPath ? normalizePath(rawValue) : undefined,
    consumedKeys: [key],
  };
}

function getFileName(path: string): string {
  // Extract filename from path (handles both / and \ separators)
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function taskUpdateSummary(input: Record<string, unknown>): ToolHeaderSummary {
  const consumedKeys = ['taskId', 'id', 'status', 'subject'].filter((key) => input[key] != null);
  const parts = [];
  const id = asDisplayText(input.taskId ?? input.id);
  if (id) parts.push(`#${id}`);
  const status = asDisplayText(input.status);
  if (status) parts.push(`[${status}]`);
  const subject = asDisplayText(input.subject);
  if (subject) parts.push(subject);

  return {
    text: parts.join(' '),
    consumedKeys,
  };
}

function firstPresentKey(input: Record<string, unknown>, keys: string[]) {
  return keys.find((key) => {
    const value = input[key];
    return value !== undefined && value !== null && asDisplayText(value) !== '';
  });
}

function asDisplayText(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
