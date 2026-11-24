import { create } from 'zustand';

import { activityRunCompletedText, activityToolCallSummary, type ActivityRun } from '@/lib/activityRuns';

/**
 * 过程组（Activity Run）的展开状态：应用运行期 UI 状态，独立于组件挂载生命周期。
 *
 * 为什么放 store 而不是线程组件的 `useState`：主线程按「尾部窗口」挂载历史行，离屏卸载、
 * 切换会话、整轮折叠再展开都会重挂组件——局部状态会丢，用户的选择就被自动行为覆盖。
 * 这里的条目只随用户第一次点击产生（存在即「已接管」），随会话清理销毁，不写入任何持久层，
 * 应用重启后全部回到默认折叠。
 */

/** 组状态的作用域键：主会话用 sessionId，子智能体轨道用 `sessionId::subagentId`。 */
export function activityGroupScopeKey(sessionId: string, subagentId?: string): string {
  return subagentId ? `${sessionId}::${subagentId}` : sessionId;
}

export type ActivityGroupDisclosure = {
  /** 用户是否点过这个组：点过之后流式追加 / 段完成都不得自动翻转。 */
  claimed: boolean;
  /** 接管后的目标开合状态。 */
  open: boolean;
};

type ActivityGroupStoreState = {
  /** `${scopeKey}:${runKey}` → 接管后的目标开合状态。 */
  openByKey: Record<string, boolean>;
  /** 首次点击与后续点击都走这里：写入即接管。 */
  setRunOpen: (scopeKey: string, runKey: string, open: boolean) => void;
  /** 会话（含其子智能体轨道）数据被清理时同步清理对应条目。 */
  pruneScope: (scopeKey: string) => void;
};

export const useActivityGroupStore = create<ActivityGroupStoreState>()((set) => ({
  openByKey: {},
  setRunOpen: (scopeKey, runKey, open) => set((state) => {
    const key = `${scopeKey}:${runKey}`;
    if (state.openByKey[key] === open) {
      return state;
    }
    return { openByKey: { ...state.openByKey, [key]: open } };
  }),
  pruneScope: (scopeKey) => set((state) => {
    const prefix = `${scopeKey}:`;
    let changed = false;
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(state.openByKey)) {
      if (key.startsWith(prefix)) {
        changed = true;
        continue;
      }
      next[key] = value;
    }
    return changed ? { openByKey: next } : state;
  }),
}));

/** 读取某个组当前的开合语义；未接管的组返回默认（折叠）。 */
export function readActivityGroupDisclosure(
  openByKey: Record<string, boolean>,
  scopeKey: string,
  runKey: string,
): ActivityGroupDisclosure {
  const value = openByKey[`${scopeKey}:${runKey}`];
  return value === undefined
    ? { claimed: false, open: false }
    : { claimed: true, open: value };
}

/**
 * 组开合判定（单一真源，主线程与子智能体共用）：
 * - 用户接管过 → 用户说了算，任何自动事件都不再翻转；
 * - 委派段 → 维持既有行为：运行中默认展开、结束后收起（卡片自己表达子代理状态）；
 * - 普通段 → 一律默认折叠（实时与历史、成功与失败都一样；单步骤段没有组头，
 *   步骤可见性由「是否成组」决定，不走这条判定）。
 */
export function resolveActivityRunOpen(
  disclosure: ActivityGroupDisclosure,
  run: { delegation: boolean; live: boolean } | null | undefined,
  delegationRunning: boolean,
): boolean {
  if (run == null) {
    return true;
  }
  if (disclosure.claimed) {
    return disclosure.open;
  }
  if (run.delegation) {
    return run.live || delegationRunning;
  }
  return false;
}

export type ActivityRunGroupSemantics = {
  /** 本段是否渲染为折叠组（≥2 个有效步骤、非委派；实时思考附加步骤已计入）。 */
  eligible: boolean;
  /** 组开合语义（接管优先；委派段运行中默认展开）。 */
  open: boolean;
  /** 段内过程步骤是否可见：未成组恒可见，成组后跟随开合；无卡片承载的委派段恒可见。 */
  partsVisible: boolean;
  /** 组头的分类统计文案（成组时非空：完成段，以及展开中的实时段）。 */
  completedText?: string;
  /** 实时组头收起时的未决工具摘要（投影按最新参数解析）。 */
  activeToolSummary?: string;
};

/**
 * 过程组展示语义的**单一真源**：主线程行绑定与子智能体只读时间线共用这一份派生，
 * 避免两边各写一份开合 / 可见性 / 统计口径再悄悄漂移。
 */
export function deriveActivityRunGroup(input: {
  run: ActivityRun | null | undefined;
  disclosure: ActivityGroupDisclosure;
  /** 委派段是否由活动卡承载步骤（主线程按子智能体拓扑判定；子代理轨道传 false）。 */
  hasDelegationCard?: boolean;
  /** 委派段「卡片运行中」的汇总标志（主线程来自活动卡；子代理轨道传 false）。 */
  delegationRunning?: boolean;
  /** 实时思考是否并入该段（仅运行尾段为真）。 */
  liveThinkingAttached?: boolean;
}): ActivityRunGroupSemantics {
  const {
    run,
    disclosure,
    hasDelegationCard = false,
    delegationRunning = false,
    liveThinkingAttached = false,
  } = input;
  if (run == null) {
    return { eligible: false, open: true, partsVisible: true, completedText: undefined, activeToolSummary: undefined };
  }
  const eligible = !run.delegation && run.stepCount + (liveThinkingAttached ? 1 : 0) >= 2;
  const open = resolveActivityRunOpen(disclosure, run, delegationRunning);
  // 过程步骤的可见性：未成组的段（单步骤、0 步刷新段）恒可见；成组后跟随开合。
  // 委派段跟随卡片开合，但没有卡片承载步骤（历史会话常见）时按普通工具卡平铺，
  // 不得凭空消失。
  const partsVisible = run.delegation
    ? (hasDelegationCard ? open : true)
    : eligible ? open : true;
  return {
    eligible,
    open,
    partsVisible,
    // 统计文案对成组段恒可算：完成态组头用它，展开中的实时段组头也用它
    // （组内步骤已经铺开，组头再重复「正在读取 xx」既冗余又抢注意力）。
    // 实时思考尚未提交时按一个额外思考块计入，否则「已思考 N 段」会慢半拍。
    completedText: eligible
      ? activityRunCompletedText(run, liveThinkingAttached && run.live ? 1 : 0)
      : undefined,
    activeToolSummary: run.live && run.activeTool ? activityToolCallSummary(run.activeTool) : undefined,
  };
}
