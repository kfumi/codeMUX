/**
 * 斜杠命令注册表
 * 定义所有可用的斜杠命令，包括本地命令和 Claude Code 内置命令
 */

export type CommandCategory = 'session' | 'info' | 'builtin' | 'custom' | 'skill';
export type CommandHandler = 'local' | 'prompt';

export interface CommandContext {
  sessionId: string;
  cwd: string;
  /** 弹窗展示信息内容 (markdown) */
  showInfoDialog: (title: string, content: string) => void;
  /** 创建新会话 */
  createSession: () => void;
  /** 清空当前会话事件 */
  clearEvents: (sessionId: string) => void;
  /** 重置 sidecar 的 Claude 会话 (清除 session ID 映射) */
  resetSession: () => void;
  /** 删除 Claude Code 会话文件 (磁盘) */
  deleteClaudeSessionFiles: () => Promise<string[]>;
  /** 清除数据库中保存的事件 */
  clearSavedEvents: (sessionId: string) => Promise<void>;
  /** 获取当前活跃 provider */
  getActiveProvider: () => { default_model: string; name: string } | null;
  /** 获取当前主题 */
  getTheme: () => string;
  /** 获取会话费用信息 */
  getCostInfo: () => string;
}

export interface SlashCommand {
  name: string;
  description: string;
  alias?: string[];
  category: CommandCategory;
  handler: CommandHandler;
  /** 需要参数提示 (如 "<文件路径>") */
  argsHint?: string;
  /** 本地处理函数 */
  action?: (ctx: CommandContext, args: string) => void | Promise<void>;
  /** 发送给 agent 的 prompt 模板，{args} 会被替换为用户输入的参数 */
  prompt?: string;
}

// ─── 命令定义 ─────────────────────────────────────────

const commands: SlashCommand[] = [
  // ── Session 命令 (本地) ──
  {
    name: 'new',
    description: '新建对话',
    alias: ['新建'],
    category: 'session',
    handler: 'local',
    action: (ctx) => ctx.createSession(),
  },
  {
    name: 'clear',
    description: '重置对话上下文',
    alias: ['清空'],
    category: 'session',
    handler: 'local',
    action: async (ctx) => {
      ctx.clearEvents(ctx.sessionId);
      ctx.resetSession();
      // Delete Claude Code session files from disk
      try { await ctx.deleteClaudeSessionFiles(); } catch { /* ignore */ }
      // Clear saved events from database
      try { await ctx.clearSavedEvents(ctx.sessionId); } catch { /* ignore */ }
    },
  },
  {
    name: 'compact',
    description: '压缩上下文',
    alias: ['压缩'],
    category: 'session',
    handler: 'prompt',
    prompt: '/compact',
  },

  // ── Info 命令 (本地弹窗) ──
  {
    name: 'cost',
    description: 'Token 用量和费用',
    alias: ['费用', 'token'],
    category: 'info',
    handler: 'local',
    action: (ctx) => {
      const info = ctx.getCostInfo();
      ctx.showInfoDialog('会话费用', info);
    },
  },
  {
    name: 'status',
    description: '会话状态',
    alias: ['状态'],
    category: 'info',
    handler: 'local',
    action: (ctx) => {
      const provider = ctx.getActiveProvider();
      const lines = [
        `**Session ID**`,
        `\`${ctx.sessionId}\``,
        '',
        `**工作目录**`,
        `\`${ctx.cwd}\``,
        '',
        `**模型**`,
        `\`${provider?.default_model || '未配置'}\``,
        '',
        `**Provider**`,
        `\`${provider?.name || '未配置'}\``,
        '',
        `**主题**`,
        `\`${ctx.getTheme()}\``,
      ];
      ctx.showInfoDialog('会话状态', lines.join('\n'));
    },
  },

  // ── Claude Code 内置命令 (直接发送 /command) ──
  { name: 'init', description: '初始化项目，生成 CLAUDE.md', alias: ['初始化'], category: 'builtin', handler: 'prompt', prompt: '/init' },
  { name: 'review', description: '审查最近的代码变更', alias: ['审查'], category: 'builtin', handler: 'prompt', prompt: '/review' },
  { name: 'code-review', description: '代码审查', alias: [], category: 'builtin', handler: 'prompt', prompt: '/code-review' },
  { name: 'security-review', description: '安全审查', alias: ['安全'], category: 'builtin', handler: 'prompt', prompt: '/security-review' },
  { name: 'context', description: '查看当前上下文使用情况', alias: ['上下文'], category: 'builtin', handler: 'prompt', prompt: '/context' },
  { name: 'usage', description: '查看 token 用量统计', alias: ['用量'], category: 'builtin', handler: 'prompt', prompt: '/usage' },
  { name: 'debug', description: '调试当前项目', alias: ['调试'], category: 'builtin', handler: 'prompt', prompt: '/debug' },
  { name: 'verify', description: '验证代码正确性', alias: ['验证'], category: 'builtin', handler: 'prompt', prompt: '/verify' },
  { name: 'deep-research', description: '深度研究', alias: ['研究'], category: 'builtin', handler: 'prompt', prompt: '/deep-research' },
  { name: 'simplify', description: '简化代码', alias: ['精简'], category: 'builtin', handler: 'prompt', prompt: '/simplify' },
  { name: 'batch', description: '批量处理', alias: ['批量'], category: 'builtin', handler: 'prompt', prompt: '/batch' },
  { name: 'loop', description: '循环执行', alias: [], category: 'builtin', handler: 'prompt', prompt: '/loop' },
  { name: 'run', description: '运行命令', alias: ['执行'], category: 'builtin', handler: 'prompt', prompt: '/run' },
  { name: 'heapdump', description: '生成堆转储', alias: [], category: 'builtin', handler: 'prompt', prompt: '/heapdump' },
  { name: 'insights', description: '查看洞察', alias: ['洞察'], category: 'builtin', handler: 'prompt', prompt: '/insights' },
  { name: 'goal', description: '设置目标', alias: ['目标'], category: 'builtin', handler: 'prompt', prompt: '/goal' },
  { name: 'team-onboarding', description: '团队入职引导', alias: ['入职'], category: 'builtin', handler: 'prompt', prompt: '/team-onboarding' },
  { name: 'claude-api', description: 'Claude API 相关操作', alias: [], category: 'builtin', handler: 'prompt', prompt: '/claude-api' },
  { name: 'fewer-permission-prompts', description: '减少权限提示', alias: ['权限'], category: 'builtin', handler: 'prompt', prompt: '/fewer-permission-prompts' },

  // ── 自定义命令 (自然语言 prompt) ──
  {
    name: 'explain',
    description: '解释指定文件或代码',
    alias: ['解释'],
    argsHint: '<文件路径>',
    category: 'custom',
    handler: 'prompt',
    prompt: 'Explain the code in {args}. Describe its purpose, key functions, and how it fits into the larger project.',
  },
  {
    name: 'test',
    description: '为当前项目生成或运行测试',
    alias: ['测试'],
    category: 'custom',
    handler: 'prompt',
    prompt: 'Generate unit tests for the current project. Focus on critical paths and edge cases. Run existing tests if available.',
  },
  {
    name: 'fix',
    description: '修复当前项目中的问题',
    alias: ['修复'],
    argsHint: '[问题描述]',
    category: 'custom',
    handler: 'prompt',
    prompt: 'Find and fix issues in this project. {args}',
  },
  {
    name: 'refactor',
    description: '重构指定代码',
    alias: ['重构'],
    argsHint: '<目标文件或描述>',
    category: 'custom',
    handler: 'prompt',
    prompt: 'Refactor {args}. Focus on readability, maintainability, and following best practices.',
  },
];

// ─── Skill 命令 (动态注册) ─────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  is_builtin: boolean;
}

const skillCommands: SlashCommand[] = [];

/** 注册 skill 命令（应用启动时和 skill 变更时调用） */
export function registerSkillCommands(skills: SkillInfo[]): void {
  skillCommands.length = 0;
  for (const skill of skills) {
    skillCommands.push({
      name: skill.name,
      description: skill.description || skill.name,
      alias: [],
      category: 'skill',
      handler: 'prompt',
      prompt: `/${skill.name} {args}`,
    });
  }
}

// ─── 公开 API ─────────────────────────────────────────

/** 获取所有命令 */
export function getAllCommands(): SlashCommand[] {
  return [...commands, ...skillCommands];
}

/** 按名称或别名查找命令 */
export function findCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  const all = [...commands, ...skillCommands];
  return all.find(
    (c) => c.name === lower || c.alias?.some((a) => a === lower)
  );
}

/** 按前缀过滤命令 (用于自动补全) */
export function filterCommands(prefix: string): SlashCommand[] {
  const all = [...commands, ...skillCommands];
  if (!prefix) return all;
  const lower = prefix.toLowerCase();
  return all.filter(
    (c) =>
      c.name.startsWith(lower) ||
      c.description.includes(lower) ||
      c.alias?.some((a) => a.startsWith(lower))
  );
}
