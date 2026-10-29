/**
 * Agent Kind —— 「这个 kind 能做什么、有哪些档位、档位怎么落地」的唯一答案。
 *
 * 这个模块只回答能力与档位，不回答模型从哪来（那是 Model Provider 侧的知识，
 * 变化轴是「供应商配了什么」而不是「kind 能做什么」），也不回答命令目录与 fork
 * 策略（`Shortcut Catalog` 与 Session 生命周期各有自己的真值源）。
 *
 * 对外只出按问题回答的函数，不出规格表本身：调用方问「这个 kind 的菜单长什么样」
 * 而不是「把 spec 给我，我自己挑字段」—— 后者会让 interface 宽度追上实现宽度。
 */

import type { AgentKind } from '../../types/session';
import { AGENT_KIND_SPECS, DEFAULT_AGENT_KIND } from './kinds';
import { inferExecutionMode, serializePermissionConfig } from './permissionMapping';
import {
  type AgentBrandIconName,
  type AgentCapability,
  type AgentExecutionMode,
  type AgentKindSpec,
  type AgentPermissionConfig,
  type AgentPlanModeShape,
  type AgentTier,
} from './types';

export * from './types';

/** `AgentPlanMode` 属于 Session 的领域形状（`plan_mode` 列），不从本模块重新定义。 */
export type { AgentPlanMode } from '../../types/session';
export {
  applyTier,
  buildDefaultPermissionConfig,
  codexWorkflowModeToExecutionMode,
  inferExecutionMode,
  isPlanApprovalPermission,
  mapExecutionModeToPermissionConfig,
  serializePermissionConfig,
} from './permissionMapping';

/** 回退能力三档：会话回退与文件回退是两件事。 */
export type RewindMode = 'conversation' | 'files' | 'both';

function specFor(kind: AgentKind): AgentKindSpec | undefined {
  return AGENT_KIND_SPECS.find((entry) => entry.kind === kind);
}

/** 这个 kind 是否声明拥有某项能力。未知 kind 一律 false。 */
export function supports(kind: AgentKind | undefined, capability: AgentCapability): boolean {
  if (!kind) {
    return false;
  }
  return specFor(kind)?.capabilities.includes(capability) ?? false;
}

/** 这个 kind 能否用某种回退。未知 kind 一律 false。 */
export function supportsRewind(kind: AgentKind | undefined, mode: RewindMode): boolean {
  if (!kind) {
    return false;
  }
  return specFor(kind)?.rewind[mode] ?? false;
}

/** 这个 kind 当前可用的全部回退模式（供菜单直接遍历）。 */
export function availableRewindModes(kind: AgentKind | undefined): RewindMode[] {
  if (!kind) {
    return [];
  }
  return (['conversation', 'files', 'both'] as const).filter((mode) => supportsRewind(kind, mode));
}

/** 展示所需的最小信息：名称、说明、品牌图标、是否可选，以及 plan 语义。 */
export interface AgentKindDescriptor {
  kind: AgentKind;
  label: string;
  description: string;
  brandIcon: AgentBrandIconName;
  selectable: boolean;
  /** Plan Mode 的承载方式（ADR 0010 的正交性以数据形式给出）。 */
  planMode: AgentPlanModeShape;
}

function toDescriptor(spec: AgentKindSpec): AgentKindDescriptor {
  return {
    kind: spec.kind,
    label: spec.label,
    description: spec.description,
    brandIcon: spec.brandIcon,
    selectable: spec.selectable,
    planMode: spec.planMode,
  };
}

export function describeKind(kind: AgentKind): AgentKindDescriptor | undefined {
  const spec = specFor(kind);
  return spec ? toDescriptor(spec) : undefined;
}

/**
 * 新建会话可选的全部 kind。
 *
 * 过去这件事靠 `capabilities.length > 0` 兼职 —— 给 `gemini_cli` 填空数组只是
 * 为了让选择器滤掉它。现在读显式的 `selectable`。
 */
export function selectableKinds(): AgentKindDescriptor[] {
  return AGENT_KIND_SPECS.filter((spec) => spec.selectable).map(toDescriptor);
}

/** 全部 kind 的展示信息（含未接入的），供归档筛选、用量统计这类需要覆盖历史的场景。 */
export function allKinds(): AgentKindDescriptor[] {
  return AGENT_KIND_SPECS.map(toDescriptor);
}

/** 配置缺失时新建会话用的 kind。 */
export function getDefaultAgentKind(): AgentKind {
  return DEFAULT_AGENT_KIND;
}

/** 某种 kind 在给定 plan 状态下的可选档位 + 当前选中项 + plan 语义。 */
export interface AgentPermissionMenu {
  tiers: AgentTier[];
  selectedMode: AgentExecutionMode;
  planMode: AgentPlanModeShape;
  /** 已存于 legacy 档（目前只有 Codex 只读）时该档出现在列表首位。 */
  legacyTierActive: boolean;
}

/**
 * 选择器与设置页共用的唯一入口。
 *
 * `legacyTiers` 的处理写在这里而不是各调用点：Codex 的只读档只在会话已存于该档时
 * 出现，这个判断属于规格，不属于渲染。
 */
export function permissionMenu(
  kind: AgentKind,
  config: AgentPermissionConfig | null | undefined,
  planMode: 'off' | 'on',
): AgentPermissionMenu {
  const spec = specFor(kind);
  const normalized = config
    ? serializePermissionConfig(kind, config)
    : serializePermissionConfig(kind, null);
  const selectedMode = inferExecutionMode(kind, normalized, planMode);

  const legacyTier = spec?.legacyTiers?.find((tier) => tier.mode === selectedMode);
  const tiers = legacyTier
    ? [legacyTier, ...(spec?.tiers ?? [])]
    : [...(spec?.tiers ?? [])];

  return {
    tiers,
    selectedMode,
    planMode: spec?.planMode ?? 'unsupported',
    legacyTierActive: Boolean(legacyTier),
  };
}
