import type { SubagentStatus } from './codeMuxProtocol';

/**
 * 子智能体状态的语义色：**全仓唯一出处**。
 *
 * 运行中 = 黄（warning）、已完成 = 绿（success）、失败 = 红（destructive）、
 * 已取消 = 中性灰（muted-foreground）。这套语义与评审浮层
 * `GitEnvironmentPopover.getSubagentStatusIcon` 里既有的配色一致，三处状态指示器
 * 都从这里取色，不再各写一份（改前它们各不相同：节点点把「运行中」画成灰、「已取消」
 * 画成黄，标签页点把「运行中」画成绿、「已完成」画成主色，面板胶囊把「运行中」
 * 画成主色）：
 *
 * 1. 委派卡片的节点状态点 —— `src/styles/globals.css` 的 `.subagent-topology-node.is-*`；
 * 2. 侧栏标签页的状态点 —— `src/components/workspace/SidePanel.tsx`；
 * 3. 子智能体面板表头的状态胶囊 —— `src/components/workspace/SubagentPreviewPanel.tsx`。
 *
 * `token` 是语义 token 名（不含 `hsl()`）：CSS 里写不了 Tailwind 类，靠它把 `.is-*`
 * 的底色与这里对齐，守卫见 `subagentStatusTone.test.ts`。
 */
export type SubagentStatusToneToken = 'warning' | 'success' | 'destructive' | 'muted-foreground';

export type SubagentStatusTone = {
  /** 语义 token 名，与 `globals.css` 的 `.is-*` 规则一一对应。 */
  token: SubagentStatusToneToken;
  /** 实心状态点的底色。运行中的呼吸动画由调用方按 `status === 'running'` 叠加。 */
  dot: string;
  /** 状态胶囊：同色浅底 + 同色文字。 */
  pill: string;
};

export const SUBAGENT_STATUS_TONES: Record<SubagentStatus, SubagentStatusTone> = {
  running: { token: 'warning', dot: 'bg-warning', pill: 'bg-warning/10 text-warning' },
  completed: { token: 'success', dot: 'bg-success', pill: 'bg-success/10 text-success' },
  failed: { token: 'destructive', dot: 'bg-destructive', pill: 'bg-destructive/10 text-destructive' },
  canceled: {
    token: 'muted-foreground',
    dot: 'bg-muted-foreground',
    pill: 'bg-muted-foreground/10 text-muted-foreground',
  },
};

export function subagentStatusTone(status: SubagentStatus): SubagentStatusTone {
  return SUBAGENT_STATUS_TONES[status];
}
