import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { cn } from '../../lib/utils';
import { usageApi } from '../../lib/tauri';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { TokenBreakdownResponse, UsageStatsResponse } from '../../types/usage';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';
import { UsageBarChart } from './UsageBarChart';
import { UsageHeatmap, UsageHeatmapLegend } from './UsageHeatmap';

interface FormSectionProps {
  label: string;
  hint?: string;
  rightContent?: ReactNode;
  children: ReactNode;
}

function FormSection({ label, hint, rightContent, children }: FormSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-medium text-foreground/70">{label}</h3>
          {hint && <span className="text-xs text-foreground/38">{hint}</span>}
        </div>
        {rightContent}
      </div>
      {children}
    </section>
  );
}

const AGENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini_cli', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
];

const AGENT_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_OPTIONS.map((opt) => [opt.value, opt.label]),
);

const TIME_RANGE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 7, label: '最近 7 天' },
  { value: 30, label: '最近 30 天' },
];

function formatTokenValue(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(n);
}

function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${rate.toFixed(1)}%`;
}

function agentLabel(kind: string): string {
  return AGENT_LABELS[kind] ?? kind;
}

interface OverviewCardProps {
  label: string;
  loading: boolean;
  value: string;
}

function OverviewCard({ label, loading, value }: OverviewCardProps) {
  return (
    <div className="rounded-lg border border-border/55 bg-muted/25 p-4">
      <div className="text-xs text-foreground/55">{label}</div>
      {loading ? (
        <div className="mt-2 h-7 w-20 animate-pulse rounded bg-muted/60" />
      ) : (
        <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      )}
    </div>
  );
}

export function UsageStatistics() {
  const [agentKind, setAgentKind] = useState<string>('all');
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<UsageStatsResponse | null>(null);
  const [tokenBreakdown, setTokenBreakdown] = useState<TokenBreakdownResponse | null>(null);
  const [loadingStats, setLoadingStats] = useState<boolean>(true);
  const [loadingTokens, setLoadingTokens] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingStats(true);
    setLoadingTokens(true);

    const agentArg = agentKind === 'all' ? undefined : agentKind;

    usageApi
      .getStats(agentArg, days)
      .then((response) => {
        if (cancelled) return;
        setStats(response);
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false);
      });

    usageApi
      .getTokenBreakdown(agentArg, days)
      .then((response) => {
        if (cancelled) return;
        setTokenBreakdown(response);
      })
      .finally(() => {
        if (!cancelled) setLoadingTokens(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentKind, days]);

  const mergedAgentDistribution = useMemo(() => {
    const statsList = stats?.agentDistribution ?? [];
    const tokenList = tokenBreakdown?.agentTokens ?? [];

    const tokenMap = new Map(tokenList.map((t) => [t.agentKind, t]));
    const result = statsList.map((item) => {
      const tokenData = tokenMap.get(item.agentKind);
      return {
        agentKind: item.agentKind,
        count: item.count,
        totalTokens: tokenData?.totalTokens ?? 0,
      };
    });

    const statsKinds = new Set(statsList.map((s) => s.agentKind));
    for (const tokenItem of tokenList) {
      if (!statsKinds.has(tokenItem.agentKind)) {
        result.push({
          agentKind: tokenItem.agentKind,
          count: tokenItem.sessionCount,
          totalTokens: tokenItem.totalTokens,
        });
      }
    }

    result.sort((a, b) => b.totalTokens - a.totalTokens);
    return result;
  }, [stats, tokenBreakdown]);

  const agentTokenTotal = useMemo(
    () => mergedAgentDistribution.reduce((sum, item) => sum + item.totalTokens, 0),
    [mergedAgentDistribution],
  );

  const heatmapTokenMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of tokenBreakdown?.heatmapTokens ?? []) {
      map.set(day.date, day.totalTokens);
    }
    return map;
  }, [tokenBreakdown]);

  const mergedModelDistribution = useMemo(() => {
    const statsList = stats?.modelDistribution ?? [];
    const tokenList = tokenBreakdown?.modelTokens ?? [];

    const tokenMap = new Map(tokenList.map((t) => [t.model, t]));
    const result = statsList.map((item) => {
      const tokenData = tokenMap.get(item.model || '未知模型');
      return {
        model: item.model,
        sessionCount: item.sessionCount,
        totalTokens: tokenData?.totalTokens ?? 0,
      };
    });

    const statsModels = new Set(statsList.map((s) => s.model || '未知模型'));
    for (const tokenItem of tokenList) {
      if (!statsModels.has(tokenItem.model)) {
        result.push({
          model: tokenItem.model,
          sessionCount: tokenItem.sessionCount,
          totalTokens: tokenItem.totalTokens,
        });
      }
    }

    result.sort((a, b) => b.totalTokens - a.totalTokens);
    return result;
  }, [stats, tokenBreakdown]);

  const totalTokensValue = tokenBreakdown?.total.totalTokens ?? null;
  const cacheRateValue = tokenBreakdown?.total.cacheRate ?? null;

  return (
    <div className="space-y-8">
      {/* Filter bar */}
      <div className="flex flex-row items-center justify-between gap-3">
        <Select value={agentKind} onValueChange={setAgentKind}>
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_OPTIONS.map((opt) => {
              const agentDef = opt.value === 'all' ? null : getAgentDefinition(opt.value as never);
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="flex items-center gap-2">
                    {agentDef && <AgentBrandIcon agent={agentDef} size="sm" />}
                    {opt.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1 rounded-lg border border-border/55 bg-muted/25 p-1">
          {TIME_RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={days === opt.value ? 'secondary' : 'ghost'}
              className={cn('h-7 px-3 text-xs', days === opt.value && 'shadow-sm')}
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Overview cards */}
      <FormSection label="概览">
        <div className="grid grid-cols-4 gap-3">
          <OverviewCard
            label="Token 总用量"
            loading={loadingTokens}
            value={formatTokenValue(totalTokensValue)}
          />
          <OverviewCard
            label="会话数量"
            loading={loadingStats}
            value={String(stats?.overview.totalSessions ?? 0)}
          />
          <OverviewCard
            label="活跃天数"
            loading={loadingStats}
            value={String(stats?.overview.activeDays ?? 0)}
          />
          <OverviewCard
            label="缓存共享率"
            loading={loadingTokens}
            value={formatPercent(cacheRateValue)}
          />
        </div>
      </FormSection>

      {/* Heatmap */}
      <FormSection
        label="活跃热力图"
        hint="过去 365 天的 Token 消耗活跃度"
        rightContent={<UsageHeatmapLegend />}
      >
        <UsageHeatmap data={stats?.heatmap ?? []} tokenMap={heatmapTokenMap} />
      </FormSection>

      {/* Daily token bar chart */}
      <FormSection label="每日 Token 用量">
        {loadingTokens ? (
          <div className="h-[200px] animate-pulse rounded-lg bg-muted/30" />
        ) : (
          <UsageBarChart data={tokenBreakdown?.daily ?? []} />
        )}
      </FormSection>

      {/* Agent distribution (only when no specific agent selected) */}
      {agentKind === 'all' && (
        <FormSection label="智能体分布" hint="按 Token 消耗总量排名">
          {mergedAgentDistribution.length === 0 ? (
            <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-6 text-sm text-foreground/40">
              暂无智能体分布数据
            </div>
          ) : (
            <div className="space-y-2.5">
              {mergedAgentDistribution.map((item) => {
                const percent =
                  agentTokenTotal > 0 ? (item.totalTokens / agentTokenTotal) * 100 : 0;
                const agentDef = getAgentDefinition(item.agentKind as never);
                return (
                  <div key={item.agentKind} className="flex items-center gap-3 text-sm">
                    <span className="flex w-28 shrink-0 items-center gap-2 truncate text-foreground/72">
                      {agentDef && <AgentBrandIcon agent={agentDef} size="sm" />}
                      {agentLabel(item.agentKind)}
                    </span>
                    <div className="relative h-6 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className="h-full rounded bg-primary/55 transition-all"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="w-32 shrink-0 text-right tabular-nums text-foreground/60">
                      {formatTokenValue(item.totalTokens)} · {percent.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </FormSection>
      )}

      {/* Model distribution table */}
      <FormSection label="模型统计" hint="按 Token 消耗总量排名">
        {mergedModelDistribution.length === 0 ? (
          <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-6 text-sm text-foreground/40">
            暂无模型统计数据
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/55">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/55 bg-muted/30 text-left text-xs text-foreground/55">
                  <th className="px-4 py-2.5 font-medium">模型名称</th>
                  <th className="px-4 py-2.5 text-right font-medium">会话数</th>
                  <th className="px-4 py-2.5 text-right font-medium">Token 用量</th>
                </tr>
              </thead>
              <tbody>
                {mergedModelDistribution.map((item) => (
                  <tr
                    key={`${item.model}-${item.sessionCount}`}
                    className="border-b border-border/40 last:border-b-0"
                  >
                    <td className="px-4 py-2.5 text-foreground/82">
                      {item.model || '未知模型'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground/72">
                      {item.sessionCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground/72">
                      {formatTokenValue(item.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormSection>
    </div>
  );
}
