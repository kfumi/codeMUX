export interface ToolHeaderSummary {
  displayName?: string;
  text?: string;
  /** Original full path for path-based tools (Read/Write/Edit/etc.), shown in tooltip */
  fullPath?: string;
  consumedKeys: string[];
}

const BUILT_IN_TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: '读取',
  Write: '写入',
  Edit: '编辑',
  MultiEdit: '批量编辑',
  NotebookRead: '读取 Notebook',
  NotebookEdit: '编辑 Notebook',
  LS: '列目录',
  Glob: '匹配文件',
  Grep: '搜索文本',
  Bash: '终端',
  shell_command: '终端',
  apply_patch: '应用补丁',
  Agent: '子智能体',
  Task: '任务',
  subagent: '子智能体',
  WebSearch: '网页搜索',
  WebFetch: '读取网页',
  Skill: '技能',
  TodoWrite: '更新待办',
  TaskGet: '查看任务',
  TaskCreate: '创建任务',
  TaskUpdate: '更新任务',
  TaskList: '任务列表',
  TaskStop: '子智能体结束',
  update_plan: '更新计划',
  AskUserQuestion: '询问用户',
  ask_user_question: '询问用户',
  request_user_input: '询问用户',
  EnterPlanMode: '进入计划模式',
  ExitPlanMode: '退出计划模式',
  EnterWorktree: '进入工作树',
  ExitWorktree: '退出工作树',
  WaitForMcpServers: '等待 MCP 服务',
  tool_search: '搜索工具',
  spawn_agent: '启动子智能体',
  send_input: '发送子智能体输入',
  wait_agent: '等待子智能体',
  close_agent: '关闭子智能体',
  resume_agent: '恢复子智能体',
  view_image: '查看图片',
  js: '运行 JS',
  js_repl: '运行 JS',
  js_repl_reset: '重置 JS',
};

const BUILT_IN_TOOL_ALIASES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  ls: 'LS',
  grep: 'Grep',
  glob: 'Glob',
  skill: 'Skill',
  task: 'Task',
  todowrite: 'TodoWrite',
  question: 'AskUserQuestion',
  ask_user_question: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
};

const CODEX_MULTI_AGENT_TOOL_PATTERN = /^multi_agent_v\d+_+/;

function normalizeToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName;
  const stripped = CODEX_MULTI_AGENT_TOOL_PATTERN.test(toolName)
    ? toolName.replace(CODEX_MULTI_AGENT_TOOL_PATTERN, '')
    : toolName;
  const normalized = BUILT_IN_TOOL_ALIASES[stripped.toLowerCase()] ?? stripped;
  return normalized || toolName;
}

export function getToolDisplayName(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[1] || toolName;
  }

  const normalizedToolName = normalizeToolName(toolName);
  return BUILT_IN_TOOL_DISPLAY_NAMES[normalizedToolName] ?? toolName;
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

  const normalizedToolName = normalizeToolName(toolName);
  const summary = (() => {
    switch (normalizedToolName) {
      case 'Read':
        return readSummary(input);
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookRead':
      case 'NotebookEdit':
        return fromFirstKey(input, ['file_path', 'filePath', 'notebook_path', 'path']);

      case 'LS':
        return fromFirstKey(input, ['path']);

      case 'Glob':
      case 'Grep':
        return fromFirstKey(input, ['pattern', 'query']);

      case 'Bash':
      case 'shell_command':
      case 'shell':
        return shellCommandSummary(normalizedToolName, input);

      case 'Agent':
      case 'Task':
      case 'subagent':
        return fromFirstKey(input, ['description', 'prompt']);

      case 'spawn_agent':
        return { consumedKeys: ['fork_context'] };

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

      case 'view_image':
        return readSummary(input);

      case 'js':
      case 'js_repl':
        return fromFirstKey(input, ['title', 'description']);

      case 'js_repl_reset':
        return { consumedKeys: [] };

      case 'TodoWrite':
        return { consumedKeys: ['todos'] };

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

function readSummary(input: Record<string, unknown>): ToolHeaderSummary {
  const fileKey = firstPresentKey(input, ['file_path', 'filePath', 'path']);
  if (!fileKey) return { consumedKeys: [] };

  const rawValue = asDisplayText(input[fileKey]);
  const filename = getFileName(normalizePath(rawValue));
  const consumedKeys = [fileKey];

  const rawOffset = input.offset;
  const rawLimit = input.limit;
  if (rawOffset != null && rawLimit != null) {
    const offset = Number(rawOffset);
    const limit = Number(rawLimit);
    if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
      const start = offset;
      const end = offset + limit - 1;
      consumedKeys.push('offset', 'limit');
      return {
        text: `${filename} ${start}-${end}行`,
        fullPath: normalizePath(rawValue),
        consumedKeys,
      };
    }
  }

  return {
    text: filename,
    fullPath: normalizePath(rawValue),
    consumedKeys,
  };
}

function shellCommandSummary(toolName: string, input: Record<string, unknown>): ToolHeaderSummary {
  const key = firstPresentKey(input, ['command', 'cmd', 'script', 'description']);
  if (!key) return { consumedKeys: [] };

  return {
    text: asDisplayText(input[key]),
    consumedKeys: toolName === 'shell_command' ? [] : Object.keys(input),
  };
}

export function isShellCommandTool(toolName: string): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  return normalizedToolName === 'Bash' || normalizedToolName === 'shell_command' || normalizedToolName === 'shell';
}

const FILE_MUTATION_KEYS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'applypatch',
]);

function fileMutationKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[-_\s]/g, '');
}

export function isFileMutationTool(toolName: string, args?: Record<string, unknown>): boolean {
  if (FILE_MUTATION_KEYS.has(fileMutationKey(toolName))) {
    return true;
  }

  if (!args || !isShellCommandTool(toolName)) {
    return false;
  }

  const command = getShellCommand(args);
  return Boolean(command?.includes('*** Begin Patch'));
}

export function getShellCommand(input: Record<string, unknown>): string | undefined {
  const key = firstPresentKey(input, ['command', 'cmd', 'script']);
  if (!key) return undefined;

  const command = asDisplayText(input[key]);
  return command || undefined;
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

export function buildToolGroupSummary(toolNames?: string[], count = toolNames?.length ?? 0): string | undefined {
  if (!toolNames || toolNames.length === 0) {
    return count > 0 ? `工具调用×${count}` : undefined;
  }

  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const displayName = getToolDisplayName(name);
    counts.set(displayName, (counts.get(displayName) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [name, toolCount] of counts) {
    parts.push(`${name}×${toolCount}`);
  }

  return parts.join('、');
}
