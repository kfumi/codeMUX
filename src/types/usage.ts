export interface UsageHeatmapDay {
  date: string;
  count: number;
}

export interface UsageOverview {
  totalSessions: number;
  activeDays: number;
}

export interface AgentDistribution {
  agentKind: string;
  count: number;
}

export interface ModelDistribution {
  model: string;
  sessionCount: number;
}

export interface UsageStatsResponse {
  heatmap: UsageHeatmapDay[];
  overview: UsageOverview;
  agentDistribution: AgentDistribution[];
  modelDistribution: ModelDistribution[];
}

export interface DailyTokenBreakdown {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface TokenTotal {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cacheRate: number;
}

export interface TokenBreakdownResponse {
  daily: DailyTokenBreakdown[];
  total: TokenTotal;
  heatmapTokens: HeatmapTokenDay[];
  modelTokens: ModelTokenTotal[];
  agentTokens: AgentTokenTotal[];
}

export interface HeatmapTokenDay {
  date: string;
  totalTokens: number;
}

export interface ModelTokenTotal {
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface AgentTokenTotal {
  agentKind: string;
  totalTokens: number;
  sessionCount: number;
}
