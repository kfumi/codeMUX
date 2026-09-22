import { Bot, ChevronRight, Target, Workflow } from 'lucide-react';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { formatElapsed } from '@/components/agent/assistant-ui/RunningElapsed';
import { useRefreshOnVisible } from '@/hooks/useRefreshOnVisible';
import { cn } from '@/lib/utils';
import {
  subagentActivityLabel,
  type SubagentActivity,
  type SubagentActivityNode,
} from '@/lib/subagentActivity';

/**
 * 委派（Task/Agent）卡片：一个处理段里的子智能体用一张可开合的卡片表达。
 *
 * 收起态只有一行组头（`Subagent 正在工作 · 1 个 Subagent · 已完成 0/1 · 8m 57s`）；
 * 展开态先画一级拓扑（主 Agent → N 个子智能体），再平铺该段其余步骤。
 *
 * 结构与数值对齐参考实现（PI-Desktop 的 `ActivityGroup` + `SubagentDetail` +
 * `ToolRow` 拓扑变体）；样式在 `src/styles/globals.css` 的 `.subagent-activity*` /
 * `.subagent-topology*`。全部交互都是原生 `<button>`。
 */

export type SubagentActivityCardProps = {
  activity: SubagentActivity;
  /** 这一段（或其中任一子智能体）仍在运行。 */
  live: boolean;
  /**
   * 受控开合（线程的处理段状态：运行中展开、结束后收起、用户点过之后由用户接管）。
   * 不传则由卡片自己按同一条规则管理，见 `useAutomaticSubagentDisclosure`。
   */
  open?: boolean;
  onToggle?: () => void;
  /** 点节点卡：打开右侧子智能体预览。 */
  onOpenSubagent?: (subagentId: string) => void;
  /** 展开后平铺的该段其余步骤（委派工具调用自己不再渲染）。 */
  children?: ReactNode;
};

export function SubagentActivityCard({
  activity,
  live,
  open: controlledOpen,
  onToggle,
  onOpenSubagent,
  children,
}: SubagentActivityCardProps) {
  const detailsId = useId();
  const disclosure = useAutomaticSubagentDisclosure(live);
  const open = controlledOpen ?? disclosure.open;
  const now = useLiveNow(live);
  const { summary } = activity;
  const label = subagentActivityLabel(summary, live);
  const durationMs = summary.startedAt != null
    ? Math.max(0, (live ? now : (summary.endedAt ?? now)) - summary.startedAt)
    : undefined;
  const duration = durationMs != null ? formatElapsed(durationMs) : '';

  const handleToggle = useCallback(() => {
    if (controlledOpen === undefined) {
      disclosure.toggle();
    }
    onToggle?.();
  }, [controlledOpen, disclosure, onToggle]);

  return (
    <div
      data-slot="subagent-activity-card"
      data-live={live ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
      className={cn('subagent-activity-card', open && 'open', live && 'active')}
    >
      <button
        type="button"
        data-slot="subagent-activity-header"
        className="subagent-activity-header"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={handleToggle}
      >
        <span data-slot="subagent-activity-icon" className="subagent-activity-icon" aria-hidden>
          <Workflow size={15} />
        </span>
        <span data-slot="subagent-activity-label" className={cn('subagent-activity-label', live && 'running')}>
          {label}
        </span>
        <span data-slot="subagent-activity-metrics" className="subagent-activity-metrics">
          {`${summary.total} 个 Subagent`}
          <span aria-hidden> · </span>
          {`已完成 ${summary.finished}/${summary.total}`}
          {duration ? (
            <>
              <span aria-hidden> · </span>
              {duration}
            </>
          ) : null}
        </span>
        <ChevronRight
          data-slot="subagent-activity-caret"
          className={cn('subagent-activity-caret', open && 'open')}
          size={12}
          aria-hidden
        />
      </button>
      {/* 收起态只把展开区置为惰性：grid-rows 0fr 保留过渡，节点也因此不必卸载。 */}
      <div
        id={detailsId}
        data-slot="subagent-activity-body"
        className={cn('subagent-activity-collapse', open && 'open')}
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="subagent-activity-collapse-inner">
          {activity.nodes.length > 0 ? (
            <SubagentTopology
              activity={activity}
              now={now}
              {...(onOpenSubagent ? { onOpenSubagent } : {})}
            />
          ) : null}
          {children ? (
            <div data-slot="subagent-activity-steps" className="subagent-activity-steps">
              {children}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 一级拓扑：主 Agent 节点 →（连接线）→ N 个子智能体节点卡。
 *
 * 运行时不支持子智能体之间的依赖，所以这里只有主 Agent → 子智能体一层，不暗示节点间的关系。
 */
export function SubagentTopology({
  activity,
  onOpenSubagent,
  now,
}: {
  activity: SubagentActivity;
  onOpenSubagent?: (subagentId: string) => void;
  /** 运行中节点的时长截止点（卡片每秒推进），节点按它算实时时长。 */
  now?: number;
}) {
  return (
    <div data-slot="subagent-topology" className="subagent-topology">
      <div data-slot="subagent-topology-root" className="subagent-topology-root">
        <span data-slot="subagent-topology-root-icon" className="subagent-topology-root-icon" aria-hidden>
          <Target size={16} />
        </span>
        <span data-slot="subagent-topology-root-copy" className="subagent-topology-root-copy">
          <strong>主 Agent</strong>
          <span>{`正在协调 ${activity.nodes.length} 个委派任务`}</span>
        </span>
      </div>
      <span data-slot="subagent-topology-connector" className="subagent-topology-connector" aria-hidden />
      <div
        data-slot="subagent-topology-agents"
        className="subagent-topology-agents"
        role="list"
        aria-label="委派任务"
      >
        {activity.nodes.map((node) => (
          <SubagentNodeCard
            key={node.subagentId}
            node={node}
            {...(now !== undefined ? { now } : {})}
            {...(onOpenSubagent ? { onOpenSubagent } : {})}
          />
        ))}
      </div>
    </div>
  );
}

/** 一个子智能体节点：状态点 + 名称 + 模型 + `状态 · 时长` + 描述 + 步骤数。 */
export function SubagentNodeCard({
  node,
  onOpenSubagent,
  now,
}: {
  node: SubagentActivityNode;
  onOpenSubagent?: (subagentId: string) => void;
  now?: number;
}) {
  // 事件里还没带出模型名时退回 provider（claude / opencode），不留空。
  const model = node.model ?? node.provider;
  // 运行中的节点按「现在 - 首条事件」推时长，避免子智能体一段时间没有事件时时长卡住
  // （卡片头部已经每秒推进，节点必须跟着走）。
  const durationMs = node.live && node.startedAt != null && now != null
    ? Math.max(0, now - node.startedAt)
    : node.durationMs;
  const duration = durationMs != null ? formatElapsed(Math.max(0, durationMs)) : '';

  return (
    <div
      data-slot="subagent-topology-node"
      data-status={node.status}
      className={cn('subagent-topology-node', `is-${node.status}`)}
      role="listitem"
    >
      {/* 短接线（脊线 → 本卡中线）与脊线两段（顶→中线、中线→下一个节点顶）都由这里和
          `::before` / `::after` 画：线正好停在首尾节点的中线上，不依赖节点高度写死的数字。 */}
      <span data-slot="subagent-topology-branch" className="subagent-topology-branch" aria-hidden />
      <button
        type="button"
        data-slot="subagent-topology-node-header"
        className="subagent-topology-node-header"
        aria-label={`查看子智能体：${node.name}`}
        onClick={() => onOpenSubagent?.(node.subagentId)}
      >
        <span data-slot="subagent-topology-node-avatar" className="subagent-topology-node-avatar" aria-hidden>
          <Bot size={15} />
          <span data-slot="subagent-topology-node-status-dot" className="subagent-topology-node-status-dot" />
        </span>
        <span data-slot="subagent-topology-node-copy" className="subagent-topology-node-copy">
          <span data-slot="subagent-topology-node-title-row" className="subagent-topology-node-title-row">
            <span data-slot="subagent-topology-node-title" className="subagent-topology-node-title">
              {node.name}
            </span>
            <span
              data-slot="subagent-topology-node-model"
              data-model-source={node.model ? 'event' : 'provider'}
              className="subagent-topology-node-model"
              title={model}
            >
              {model}
            </span>
            <span data-slot="subagent-topology-node-status" className="subagent-topology-node-status">
              {duration ? `${node.statusLabel} · ${duration}` : node.statusLabel}
            </span>
          </span>
          {node.detail ? (
            <span data-slot="subagent-topology-node-summary" className="subagent-topology-node-summary">
              {node.detail}
            </span>
          ) : null}
          <span data-slot="subagent-topology-node-steps" className="subagent-topology-node-steps">
            {`${node.stepCount} 个步骤`}
          </span>
        </span>
        {node.live ? (
          <span
            data-slot="subagent-topology-node-spinner"
            className="subagent-topology-node-spinner animate-spin"
            aria-label="运行中"
          />
        ) : null}
      </button>
    </div>
  );
}

/**
 * 未受控时的开合规则（对齐参考实现的 `useAutomaticDisclosure`）：运行中默认展开、
 * 结束后自动收起；用户点过一次之后由用户接管，之后的状态变化不再覆盖他的选择。
 */
export function useAutomaticSubagentDisclosure(automaticOpen: boolean) {
  const [open, setOpen] = useState(automaticOpen);
  const claimedRef = useRef(false);
  const previousAutomaticOpenRef = useRef(automaticOpen);

  useLayoutEffect(() => {
    if (claimedRef.current) return;
    if (previousAutomaticOpenRef.current === automaticOpen) return;
    previousAutomaticOpenRef.current = automaticOpen;
    setOpen(automaticOpen);
  }, [automaticOpen]);

  const toggle = useCallback(() => {
    claimedRef.current = true;
    setOpen((value) => !value);
  }, []);

  return { open, toggle };
}

/** 运行中每秒推进的时钟：组头时长与子智能体节点的时长都要跟着走。 */
function useLiveNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useLayoutEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  // 与 RunningElapsedTimer 同理：节流只推迟刷新时机，值一直按 Date.now() 算，
  // 恢复可见时补一次就够，不必为了这个关掉整窗节流。
  useRefreshOnVisible(() => setNow(Date.now()));

  return now;
}
