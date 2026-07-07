import type { AgentKind } from '../types/session';

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
  /** 获取当前活跃 provider */
  getActiveProvider: () => { default_model: string; name: string } | null;
  /** 获取当前主题 */
  getTheme: () => string;
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
  /** Skill 命令对应的 SKILL.md 文件绝对路径 (仅 skill 类别) */
  filePath?: string;
}

export function renderCommandPrompt(command: SlashCommand, args: string): string {
  return (command.prompt ?? '').replace(/\{args\}/g, args || '').trim();
}

export function formatCommandDisplay(command: SlashCommand, args: string): string {
  return `/${command.name}${args ? ` ${args}` : ''}`;
}

export function formatPromptAsCommandDisplay(prompt: string, agentKind: AgentKind = 'claude_code'): string | null {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return null;
  }

  for (const command of getAllCommands(agentKind)) {
    if (command.handler !== 'prompt' || !command.prompt) {
      continue;
    }

    const args = matchPromptTemplate(command.prompt, normalizedPrompt);
    if (args == null) {
      continue;
    }

    return formatCommandDisplay(command, args);
  }

  return null;
}

const codexPromptTemplates = {
  init: `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.

`,
} as const;

const sharedCommands: SlashCommand[] = [
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
];

const claudeBuiltInCommands: SlashCommand[] = [
  { name: 'init', description: '初始化项目，生成 CLAUDE.md', alias: ['初始化'], category: 'builtin', handler: 'prompt', prompt: '/init' },
  { name: 'review', description: '审查最近的代码变更', alias: ['审查'], category: 'builtin', handler: 'prompt', prompt: '/review' },
  { name: 'code-review', description: '代码审查', alias: [], category: 'builtin', handler: 'prompt', prompt: '/code-review' },
  { name: 'security-review', description: '安全审查', alias: ['安全'], category: 'builtin', handler: 'prompt', prompt: '/security-review' },
//   { name: 'context', description: '查看当前上下文使用情况', alias: ['上下文'], category: 'builtin', handler: 'prompt', prompt: '/context' },
//   { name: 'usage', description: '查看 token 用量统计', alias: ['用量'], category: 'builtin', handler: 'prompt', prompt: '/usage' },
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
//   { name: 'team-onboarding', description: '团队入职引导', alias: ['入职'], category: 'builtin', handler: 'prompt', prompt: '/team-onboarding' },
//   { name: 'claude-api', description: 'Claude API 相关操作', alias: [], category: 'builtin', handler: 'prompt', prompt: '/claude-api' },
//   { name: 'fewer-permission-prompts', description: '减少权限提示', alias: ['权限'], category: 'builtin', handler: 'prompt', prompt: '/fewer-permission-prompts' },
];

const codexBuiltInCommands: SlashCommand[] = [
  { name: 'init', description: '生成 AGENTS.md 项目指导文件', alias: ['初始化'], category: 'builtin', handler: 'prompt', prompt: codexPromptTemplates.init },
];

const customCommands: SlashCommand[] = [];

function getBuiltInCommands(agentKind: AgentKind = 'claude_code'): SlashCommand[] {
  return agentKind === 'codex' ? codexBuiltInCommands : claudeBuiltInCommands;
}

function getCommands(agentKind: AgentKind = 'claude_code'): SlashCommand[] {
  const commands = agentKind === 'codex'
    ? [...getBuiltInCommands(agentKind), ...sharedCommands, ...customCommands]
    : [...sharedCommands, ...getBuiltInCommands(agentKind), ...customCommands];
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

// ─── Skill 命令 (动态注册) ─────────────────────────────

import type { SkillApps } from '../types/skill';

interface SkillInfo {
  name: string;
  description: string;
  /** 该 skill 在哪些智能体上启用 */
  apps: SkillApps;
  /** SKILL.md 文件绝对路径 */
  diskPath?: string | null;
}

interface SkillCommandWithApps {
  command: SlashCommand;
  apps: SkillApps;
}

const skillCommandsWithApps: SkillCommandWithApps[] = [];

/** 注册 skill 命令（应用启动时和 skill 变更时调用） */
export function registerSkillCommands(skills: SkillInfo[]): void {
  skillCommandsWithApps.length = 0;
  for (const skill of skills) {
    const command: SlashCommand = {
      name: skill.name,
      description: skill.description || skill.name,
      alias: [],
      category: 'skill',
      handler: 'prompt',
      prompt: `/${skill.name} {args}`,
      filePath: skill.diskPath ?? undefined,
    };
    skillCommandsWithApps.push({ command, apps: skill.apps });
  }
}

/** 获取指定智能体启用的 skill 命令 */
function getSkillCommandsForAgent(agentKind: AgentKind): SlashCommand[] {
  const enabledApps = {
    claude_code: 'claude',
    codex: 'codex',
    gemini_cli: 'gemini',
    opencode: 'opencode',
  } as const;
  const appKey = enabledApps[agentKind] || 'claude';
  return skillCommandsWithApps
    .filter((item) => item.apps[appKey] === true)
    .map((item) => item.command);
}

// ─── 公开 API ─────────────────────────────────────────

/** 获取所有命令 */
export function getAllCommands(agentKind: AgentKind = 'claude_code'): SlashCommand[] {
  return [...getCommands(agentKind), ...getSkillCommandsForAgent(agentKind)];
}

/** 按名称或别名查找命令 */
export function findCommand(name: string, agentKind: AgentKind = 'claude_code'): SlashCommand | undefined {
  const lower = name.toLowerCase();
  const all = getAllCommands(agentKind);
  return all.find(
    (c) => c.name === lower || c.alias?.some((a) => a === lower)
  );
}

/** 按前缀过滤命令 (用于自动补全) */
export function filterCommands(prefix: string, agentKind: AgentKind = 'claude_code'): SlashCommand[] {
  const all = getAllCommands(agentKind);
  if (!prefix) return all;
  const lower = prefix.toLowerCase();
  return all.filter(
    (c) =>
      c.name.startsWith(lower) ||
      c.description.includes(lower) ||
      c.alias?.some((a) => a.startsWith(lower))
  );
}

function matchPromptTemplate(template: string, prompt: string): string | null {
  const normalizedTemplate = template.trim();

  if (!normalizedTemplate.includes('{args}')) {
    return normalizedTemplate === prompt ? '' : null;
  }

  const [prefix, ...suffixParts] = normalizedTemplate.split('{args}');
  const suffix = suffixParts.join('{args}');

  if (!prompt.startsWith(prefix) || !prompt.endsWith(suffix)) {
    return null;
  }

  const argsEnd = suffix.length > 0 ? prompt.length - suffix.length : prompt.length;
  return prompt.slice(prefix.length, argsEnd).trim();
}
