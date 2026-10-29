/**
 * 四种 Agent Kind（外加未接入的 `gemini_cli`）的规格表 —— 一张表并排，四家差异
 * 按列可见。这是本模块唯一的真值源：能力、回退、档位、plan 语义都从这里出。
 *
 * 刻意不做成「每家一个 adapter 文件」：四家差异是**同一张表的不同列**，不是同一
 * interface 的不同实现。它们没有各自的行为，只有各自的数据；拆成四个文件会让
 * 「改一句档位文案」在表和 adapter 之间来回跳，拿 locality 换形式整齐。
 *
 * 档位文案与图标对齐官方客户端的措辞（Codex 的「请求批准 / 帮我批准 / 完全访问」
 * 取自 ChatGPT Codex App 的 approval selector；OpenCode 的「构建 / 计划」取自它的
 * agent selector）。`dangerous` 只标「跳过权限确认」那一档。
 */

import type { AgentKindSpec } from './types';

/** Claude Code：原生 permissionMode 五档，plan 是其中一个档位。 */
const CLAUDE_TIERS: AgentKindSpec['tiers'] = [
  {
    mode: 'confirm_before_edit',
    label: '变更前确认',
    description: '修改文件或运行敏感工具前先询问。',
    iconName: 'hand',
    dangerous: false,
  },
  {
    mode: 'auto_edit',
    label: '自动编辑',
    description: '允许 Claude 自动编辑文件。',
    iconName: 'shield-check',
    dangerous: false,
  },
  {
    mode: 'auto_review',
    label: '自动模式',
    description: '所有操作自动执行，后台进行安全检查。',
    iconName: 'zap',
    dangerous: false,
  },
  {
    mode: 'plan',
    label: '计划模式',
    description: '先分析和规划，暂不直接修改。',
    iconName: 'clipboard-list',
    dangerous: false,
  },
  {
    mode: 'full_access',
    label: '完全访问',
    description: '跳过权限确认，风险更高。',
    iconName: 'shield',
    dangerous: true,
  },
];

/**
 * Codex：Workflow Mode 三档（ADR 0010）。`read-only` 仍是合法内部枚举（legacy
 * 快照会迁到它），但只作为已存于该档的会话的退出通道出现，不在常规列表里。
 * 图标复用 Claude 那套，让「要批准 / 自动批准」的语义跨智能体一致。
 */
const CODEX_TIERS: AgentKindSpec['tiers'] = [
  {
    mode: 'auto_edit',
    label: '请求批准',
    description: '编辑外部文件和使用互联网时始终询问。',
    iconName: 'hand',
    dangerous: false,
  },
  {
    mode: 'auto_review',
    label: '帮我批准',
    description: '仅对检测到的风险操作请求批准。',
    iconName: 'shield-check',
    dangerous: false,
  },
  {
    mode: 'full_access',
    label: '完全访问',
    description: '可不受限制地访问互联网和你电脑上的任何文件。',
    iconName: 'shield',
    dangerous: true,
  },
];

const CODEX_LEGACY_TIERS: NonNullable<AgentKindSpec['legacyTiers']> = [
  {
    mode: 'read_only',
    label: '只读模式',
    description: '只读探索代码库，不写入文件。',
    iconName: 'eye',
    dangerous: false,
  },
];

/**
 * OpenCode：官方暴露 Build/Plan 两个 agent 档位；「自动接受权限」是正交的盾牌开关，
 * 不在这个列表里（它由选择器旁边的独立按钮承载）。
 */
const OPENCODE_TIERS: AgentKindSpec['tiers'] = [
  {
    mode: 'confirm_before_edit',
    label: '构建模式',
    description: '正常执行，敏感操作按 OpenCode 权限规则确认。',
    iconName: 'zap',
    dangerous: false,
  },
  {
    mode: 'plan',
    label: '计划模式',
    description: '先分析和规划，暂不直接修改。',
    iconName: 'clipboard-list',
    dangerous: false,
  },
];

/** pi：无原生权限模式，档位由临时扩展的 tool_call 拦截策略实现；plan 不适用。 */
const PI_TIERS: AgentKindSpec['tiers'] = [
  {
    mode: 'confirm_before_edit',
    label: '变更前确认',
    description: '修改文件或运行命令前先询问。',
    iconName: 'hand',
    dangerous: false,
  },
  {
    mode: 'auto_edit',
    label: '自动编辑',
    description: '允许 pi 自动编辑文件，运行命令前询问。',
    iconName: 'shield-check',
    dangerous: false,
  },
  {
    mode: 'full_access',
    label: '完全访问',
    description: '跳过权限确认，直接执行所有工具。',
    iconName: 'shield',
    dangerous: true,
  },
];

export const AGENT_KIND_SPECS: AgentKindSpec[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    description: '默认编码智能体，当前运行时支持最完整。',
    brandIcon: 'claude',
    selectable: true,
    capabilities: [
      'supports_resume',
      'supports_tools',
      'supports_file_snapshots',
      'supports_cost',
      'supports_ask_user_question',
      'supports_steer',
    ],
    rewind: { conversation: true, files: true, both: true },
    tiers: CLAUDE_TIERS,
    planMode: 'via-tier',
  },
  {
    kind: 'codex',
    label: 'Codex',
    description: '基于 OpenAI Codex SDK 的编码智能体。',
    brandIcon: 'codex',
    selectable: true,
    capabilities: [
      'supports_tools',
      'supports_file_snapshots',
      'supports_cost',
      'supports_ask_user_question',
      'supports_steer',
    ],
    rewind: { conversation: true, files: false, both: false },
    tiers: CODEX_TIERS,
    legacyTiers: CODEX_LEGACY_TIERS,
    planMode: 'orthogonal-toggle',
  },
  {
    kind: 'gemini_cli',
    label: 'Gemini CLI',
    description: '为后续扩展预留的 Gemini 接入入口。',
    brandIcon: 'gemini',
    // 未接入：类型与规格保留（CONTEXT.md 的 Out of Scope 把它记为「当前未接入」
    // 而非已删除），但不出现在新建会话的选择器里，也没有任何能力声明。
    selectable: false,
    capabilities: [],
    rewind: { conversation: false, files: false, both: false },
    tiers: [],
    planMode: 'unsupported',
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    description: '基于 OpenCode SDK 的可恢复编码 Agent。',
    brandIcon: 'opencode',
    selectable: true,
    capabilities: ['supports_resume', 'supports_tools', 'supports_steer'],
    rewind: { conversation: true, files: false, both: false },
    tiers: OPENCODE_TIERS,
    planMode: 'via-tier',
  },
  {
    kind: 'pi',
    label: 'pi',
    description: '基于 pi RPC 的极简多供应商编码 Agent，经临时扩展支持审批与提问。',
    brandIcon: 'pi',
    selectable: true,
    capabilities: [
      'supports_resume',
      'supports_tools',
      'supports_cost',
      'supports_ask_user_question',
      'supports_steer',
    ],
    rewind: { conversation: true, files: false, both: false },
    tiers: PI_TIERS,
    planMode: 'unsupported',
  },
];

/** 新建会话在配置缺失时回落到这个 kind。 */
export const DEFAULT_AGENT_KIND = 'claude_code' as const;
