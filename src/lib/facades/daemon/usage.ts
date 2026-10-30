import type { TokenBreakdownResponse, UsageStatsResponse } from '../../../types/usage';
import { ensureDaemonClient } from './lifecycle';

/** 用量统计。 */
export const usage = {
  getStats: async (agentKind?: string, days?: number): Promise<UsageStatsResponse> =>
    (await ensureDaemonClient()).usageGetStats(agentKind, days) as Promise<UsageStatsResponse>,
  getTokenBreakdown: async (
    agentKind?: string,
    days?: number,
  ): Promise<TokenBreakdownResponse> =>
    (await ensureDaemonClient()).usageGetTokenBreakdown(agentKind, days) as Promise<TokenBreakdownResponse>,
};

export type UsageDomain = typeof usage;
