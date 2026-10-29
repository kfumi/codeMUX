/**
 * Agent Kind 的数据形状 —— 纯类型，无逻辑。
 *
 * 这里放的是**会被持久化或跨层传递**的形状：`AgentPermissionConfig` 写进
 * `sessions.permission_config` 与 Scheduled Task 记录，是 `types/provider.ts`
 * 的字段类型；`AgentExecutionMode` 是选择器与设置页共用的档位枚举。
 *
 * 为什么形状与行为同处 `lib/agentKind/` 而不是拆去 `src/types/`：它们回答的是
 * 同一个问题（「这个 kind 有哪些档位、档位怎么落地」）。分开住正是本轮重构要修的
 * 毛病 —— 曾经 `types/provider.ts` 反向依赖 `lib/agentPermissions.ts` 的行为模块，
 * 方向是倒的。现在它只依赖这个无逻辑的文件。
 */

import type { AgentKind } from '../../types/session';

/**
 * 界面层的统一档位枚举 —— 四个 Agent Kind 的原生权限词汇各不相同
 * （Claude 的 permissionMode、Codex 的 workflowMode、pi 的拦截策略），
 * 选择器与设置页只讲这一套。
 */
export type AgentExecutionMode =
  | 'confirm_before_edit'
  | 'auto_edit'
  | 'plan'
  | 'full_access'
  | 'read_only'
  | 'auto_review';

export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

export type CodexWorkflowMode = 'read-only' | 'auto' | 'auto-review' | 'full-access';

export type OpenCodePermissionConfig = {
  kind: 'opencode';
  /**
   * Mirrors the official OpenCode "auto-approve permissions" toggle: when on,
   * permission rules that would ask are auto-approved (explicit deny rules are
   * still enforced by the server). Plan vs build stays an orthogonal
   * plan_mode toggle, like the official Build/Plan agent selector.
   */
  autoApprovePermissions: boolean;
};

export type ClaudePermissionConfig = {
  kind: 'claude_code';
  permissionMode: ClaudePermissionMode;
};

export type CodexPermissionConfig = {
  kind: 'codex';
  workflowMode: CodexWorkflowMode;
  networkAccessEnabled: boolean;
};

/**
 * pi 无原生权限模式，档位由临时扩展的 tool_call 拦截策略实现：确认编辑/
 * 仅确认命令/全放行（plan 档对 pi 不适用，选择器不提供）。变更经 pi 进程
 * 重建于下一轮生效（与模型/思考等级同机制）。
 */
export type PiPermissionConfig = {
  kind: 'pi';
  executionMode: 'confirm_before_edit' | 'auto_edit' | 'full_access';
};

export type AgentPermissionConfig =
  | ClaudePermissionConfig
  | CodexPermissionConfig
  | OpenCodePermissionConfig
  | PiPermissionConfig;

/**
 * 某一种 Agent Kind 声明拥有的能力。
 *
 * 前五项当前没有 UI 读取者，它们是**声明性契约**：四家 runtime 的能力差异是真实
 * 的领域事实（Claude 有文件快照、OpenCode 没有；Codex 没有 resume）。写在这里
 * 让 `agentKind.test.ts` 能对拍它们，而不是让事实只活在文档里。
 * `supports_steer` 是唯一被运行时逻辑读取的一项（Immediate Run 的注入分支）。
 */
export type AgentCapability =
  | 'supports_resume'
  | 'supports_tools'
  | 'supports_file_snapshots'
  | 'supports_cost'
  | 'supports_ask_user_question'
  | 'supports_steer';

/** 档位图标在数据层是名字，组件层才映射成具体图标组件。 */
export type TierIconName =
  | 'hand'
  | 'shield-check'
  | 'zap'
  | 'clipboard-list'
  | 'shield'
  | 'eye';

/** 品牌图标标识（`AgentBrandIcon` 据此选 SVG）。 */
export type AgentBrandIconName = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi';

/**
 * 一个权限档位。
 *
 * `dangerous` 说的是**事实**（这一档会跳过权限确认），不是「该画成橙色」——
 * 具体颜色由两个消费方各自决定（下拉改图标色、卡片改 hover 描边）。
 */
export interface AgentTier {
  mode: AgentExecutionMode;
  label: string;
  description: string;
  iconName: TierIconName;
  dangerous: boolean;
}

/** 回退能力：会话回退与文件回退是两件事，`both` 表示两者同时可用。 */
export interface AgentRewindCapability {
  conversation: boolean;
  files: boolean;
  both: boolean;
}

/** 一种 Agent Kind 的完整规格。表见 `kinds.ts`，读取请走 `index.ts` 的窄接口。 */
export interface AgentKindSpec {
  kind: AgentKind;
  label: string;
  description: string;
  /** 品牌图标标识（`AgentBrandIcon` 据此选 SVG），不是档位图标。 */
  brandIcon: AgentBrandIconName;
  /**
   * 是否出现在「新建会话」的智能体选择里。
   *
   * 曾经这件事靠 `capabilities.length > 0` 兼职 —— 给 `gemini_cli` 填空数组
   * 只是为了让 `AgentSelector` 滤掉它，不是因为「它什么都不会」。空数组一旦被
   * 填上，它会悄悄出现在选择器里。
   */
  selectable: boolean;
  capabilities: AgentCapability[];
  rewind: AgentRewindCapability;
  /** 常规档位。 */
  tiers: AgentTier[];
  /**
   * 只在会话已存于该档时才出现的档位（Codex 的只读档是唯一一例：
   * legacy 快照迁移后仍要能看见并退出）。
   */
  legacyTiers?: AgentTier[];
  /**
   * Plan Mode 在这家身上如何表达 —— 这一条把 ADR 0010 的正交性变成数据，
   * 而不是让每个组件各写一次 `agentKind === 'codex'`。
   *
   * - `via-tier`：plan 就是其中一个档位，选中它即开启、选走即关闭（Claude、OpenCode）。
   * - `orthogonal-toggle`：plan 是独立开关，选档位**不得**触碰它（Codex）。
   * - `unsupported`：没有 plan 概念，选档位也不触碰（pi）。
   */
  planMode: AgentPlanModeShape;
}

export type AgentPlanModeShape = 'via-tier' | 'orthogonal-toggle' | 'unsupported';
