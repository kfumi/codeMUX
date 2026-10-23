import { useEffect, useMemo, useState } from 'react';

import { providerDisplayName } from '@/components/settings/ProviderBrandIcon';
import { daemonFacade } from '@/lib/facades/daemon-facade';
import { logger, serializeError } from '@/lib/logger';
import { isProviderUsable } from '../lib/modelProviders';
import { useModelDisplayNames } from './useModelDisplayNames';
import { resolveModelDisplayName } from '../lib/providerModels';
import type { ModelProvider } from '../types/provider';
import type { AgentKind } from '../types/session';

export interface ModelOption {
  /** Unique selector value: `${providerId}::${modelId}` */
  id: string;
  modelId: string;
  providerId: string;
  providerTemplateId: string | null;
  name: string;
  group: string;
  description?: string;
  efforts?: boolean;
  source?: 'provider' | 'catalog' | 'config' | 'builtin';
  /**
   * models.dev 的上下文窗口，仅免费模型条目携带（daemon 免费目录接口 join，
   * ADR 0015 建议值）。供应商模型条目不带 —— 它们的窗口走 provider 配置。
   */
  contextWindow?: number | null;
}

/**
 * OpenCode Zen 免费模型的虚拟供应商 id。它不对应 ModelProvider 记录：
 * 选择器把它追加进 opencode 智能体的模型列表，发送链路由 daemon 识别该 id
 * 后落到 opencode 原生 `opencode` provider（凭据走本机 opencode 登录态）。
 * 见 ADR 0017。
 */
export const OPENCODE_FREE_PROVIDER_ID = 'opencode-free';
export const OPENCODE_FREE_GROUP = 'OpenCode 免费模型';

export function isOpenCodeFreeProviderId(providerId: string | null | undefined): boolean {
  return providerId === OPENCODE_FREE_PROVIDER_ID;
}

interface OpenCodeFreeModelRow {
  id: string;
  name: string | null;
  /** daemon join 的 models.dev 窗口；目录没有就是 null（不猜，ADR 0015）。 */
  contextWindow: number | null;
}

interface OpenCodeFreeModelPayloadRow {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
}

/**
 * 免费目录缓存（模块级）：成功即缓存到应用退出，由 App 启动预热填充——
 * 免费列表每次应用生命周期只拉一次，进会话/切换会话不再等远程。失败不
 * 缓存，下次挂载按 pending 门槛重试。
 */
let freeModelsCache: OpenCodeFreeModelRow[] | null = null;

/** 免费目录是否已有缓存：有缓存时新建面板首屏就能解析配置默认值，无需等待网络。 */
function hasOpenCodeFreeModelsCache(): boolean {
  return !!freeModelsCache;
}
let freeModelsInFlight: Promise<OpenCodeFreeModelRow[]> | null = null;

/** 测试专用：清空免费模型模块缓存，保证用例之间互不影响。 */
export function resetOpenCodeFreeModelsCacheForTests(): void {
  freeModelsCache = null;
  freeModelsInFlight = null;
}

/**
 * 拉取 Zen 免费模型目录（daemon `/providers/opencode-free-models`）。
 * 成功即入模块级缓存（用到应用退出）；在途去重：选择器在新建面板、自动化
 * 编辑器、会话 composer 三处各挂一个实例，避免重复打 daemon。失败不缓存，
 * 下次挂载重试。
 */
function fetchOpenCodeFreeModelRows(): Promise<OpenCodeFreeModelRow[]> {
  if (freeModelsCache) {
    return Promise.resolve(freeModelsCache);
  }
  if (!freeModelsInFlight) {
    freeModelsInFlight = daemonFacade
      .fetchOpenCodeFreeModels()
      .then((payload) => {
        const list: unknown[] = Array.isArray(payload) ? payload : [];
        const rows = list
          .map((row) => (row && typeof row === 'object' ? (row as OpenCodeFreeModelPayloadRow) : null))
          .filter((row): row is OpenCodeFreeModelPayloadRow =>
            row !== null && typeof row.id === 'string' && row.id.trim().length > 0)
          .map((row) => ({
            id: (row.id as string).trim(),
            name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
            contextWindow: typeof row.context_window === 'number' && row.context_window > 0
              ? row.context_window
              : null,
          }));
        freeModelsCache = rows;
        return rows;
      })
      .finally(() => {
        freeModelsInFlight = null;
      });
  }
  return freeModelsInFlight;
}

/**
 * App 启动预热：提前把免费目录拉进模块缓存，进会话时选择器首屏即有免费
 * 分组、免费会话不闪供应商模型。成败都不阻塞启动——失败不缓存，进入
 * opencode 会话时按 pending 门槛重试。
 */
export function prefetchOpenCodeFreeModels(): void {
  void fetchOpenCodeFreeModelRows().catch(() => {});
}

function providersFingerprint(providers: ModelProvider[]): string {
  return JSON.stringify(
    providers.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      name: provider.name,
      default_model: provider.default_model,
      models: provider.models.map((model) => [model.id, model.name]),
      endpoints: provider.endpoints.map((endpoint) => [
        endpoint.protocol,
        endpoint.base_url,
        Boolean(endpoint.api_key_override?.trim()),
      ]),
      api_key: Boolean(provider.api_key.trim()),
    })),
  );
}

export function encodeModelSelectorValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function decodeModelSelectorValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const separator = value.indexOf('::');
  if (separator <= 0) return null;
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 2);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/**
 * OpenCode Zen 免费模型选项（虚拟供应商 `opencode-free`）。
 * 仅 opencode 智能体返回条目，其余智能体恒为空：Zen 免费层有客户端门禁，
 * 只能在 OpenCode 运行时里跑，其他智能体选了也发不出请求。
 */
export function useOpenCodeFreeModelOptions(agentKind: AgentKind): ModelOption[] {
  const [freeModels, setFreeModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    if (agentKind !== 'opencode') {
      setFreeModels([]);
      return;
    }
    let cancelled = false;
    fetchOpenCodeFreeModelRows()
      .then((rows) => {
        if (cancelled) return;
        setFreeModels(rows.map(toOpenCodeFreeModelOption));
      })
      .catch((error) => {
        // 免费模型是补充项：目录不可达/离线时静默降级，不影响供应商模型。
        logger.warn('Failed to fetch OpenCode free models', {}, serializeError(error));
        if (!cancelled) setFreeModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentKind]);

  return freeModels;
}

function toOpenCodeFreeModelOption(row: OpenCodeFreeModelRow): ModelOption {
  return {
    id: encodeModelSelectorValue(OPENCODE_FREE_PROVIDER_ID, row.id),
    modelId: row.id,
    providerId: OPENCODE_FREE_PROVIDER_ID,
    // 仅作显示用的品牌 hint:选择器据此渲染 OpenCode logo,并把
    // models.dev 展示名查找限定到 opencode provider(目录仅是建议,
    // ADR 0015)。不对应真实 ModelProvider 模板。
    providerTemplateId: 'opencode',
    name: resolveModelDisplayName({
      id: row.id,
      name: row.name,
      providerTemplateId: 'opencode',
    }),
    group: OPENCODE_FREE_GROUP,
    // 免费目录不带 reasoning 档位声明，保守不提供档位选择。
    efforts: false,
    source: 'catalog',
    contextWindow: row.contextWindow,
  };
}

/**
 * 免费模型会话的上下文窗口（来自免费目录行的 models.dev join）。
 *
 * 与 `useCatalogContextWindow` 同源（都是 daemon 的 models.dev 快照），
 * 互为兜底：目录按 key 查询的 miss 会被永久缓存，而免费目录行自带 join
 * 好的窗口 —— 两条路径的缓存时点不同，任何一条先拿到真值环就能显示。
 * 免费目录本身缓存到应用退出，所以运行中途 daemon 目录从 bundled 回落
 * 恢复后，已 miss 的模型要重启应用才能拿到窗口。查不到仍为 null。
 */
export function useOpenCodeFreeContextWindow(
  agentKind: AgentKind,
  model: string | null | undefined,
): number | null {
  const options = useOpenCodeFreeModelOptions(agentKind);
  const id = (model ?? '').trim();
  return useMemo(() => {
    if (agentKind !== 'opencode' || !id) return null;
    return options.find((option) => option.modelId === id)?.contextWindow ?? null;
  }, [agentKind, id, options]);
}

/**
 * opencode 免费目录是否仍在途（启动预热未完成，或上次失败后的挂载重试中）。
 * 仅 opencode 智能体会等待，其余恒为 false。
 */
export function useOpenCodeFreeModelsPending(agentKind: AgentKind): boolean {
  const [pending, setPending] = useState(
    () => agentKind === 'opencode' && !hasOpenCodeFreeModelsCache(),
  );
  useEffect(() => {
    if (agentKind !== 'opencode' || hasOpenCodeFreeModelsCache()) {
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    fetchOpenCodeFreeModelRows().then(
      () => { if (!cancelled) setPending(false); },
      () => { if (!cancelled) setPending(false); },
    );
    return () => { cancelled = true; };
  }, [agentKind]);
  return pending;
}

/** Collect usable provider models for an agent, grouped by provider. */
export function useAgentModels(
  agentKind: AgentKind,
  providers: ModelProvider[] | ModelProvider | null,
  _activeProviderId: string | null = null,
): { models: ModelOption[]; isLoading: boolean; freePending: boolean } {
  const providerList = useMemo(() => {
    if (!providers) return [] as ModelProvider[];
    return Array.isArray(providers) ? providers : [providers];
  }, [providers]);

  const [tick, setTick] = useState(0);
  const freeModels = useOpenCodeFreeModelOptions(agentKind);
  // 首屏直达默认值的关键：opencode 且免费缓存未命中时，免费目录在途，此时用供应商列表算出的
  // preferredModel 只是兜底（models[0]），调用方据此把发送门槛挂起，等目录回来再按配置默认值展示/发送。
  // 与 useOpenCodeFreeModelOptions 共用模块级在途去重，不会多发一次网络请求；isLoading 保持 false，
  // 避免其他调用方（自动化编辑器等）的转圈逻辑被误触。
  const freePending = useOpenCodeFreeModelsPending(agentKind);
  // Display names come from the models.dev index, which arrives after the first
  // render; without this the list would keep its prettified names.
  useModelDisplayNames();
  useEffect(() => {
    setTick((value) => value + 1);
  }, [agentKind, providersFingerprint(providerList)]);

  const models = useMemo(() => {
    void tick;
    const usable = providerList.filter((provider) => isProviderUsable(provider, agentKind));
    // Keep enabled + configured order: enabled already required by usable; preserve list order.
    const providerModels = usable.flatMap((provider) => {
      const group = providerDisplayName(provider.name, provider.builtin_template_id);
      return provider.models
        .filter((model) => model.id.trim())
        .map((model) => {
          const modelId = model.id.trim();
          return {
            id: encodeModelSelectorValue(provider.id, modelId),
            modelId,
            providerId: provider.id,
            providerTemplateId: provider.builtin_template_id ?? null,
            name: resolveModelDisplayName({
              id: modelId,
              name: model.name,
              providerTemplateId: provider.builtin_template_id,
            }),
            group,
            efforts: true,
            source: 'provider' as const,
          };
        });
    });
    // 免费模型追加在所有供应商模型之后：默认选中仍是配置的供应商模型。
    return [...providerModels, ...freeModels];
  }, [agentKind, providerList, freeModels, tick]);

  return { models, isLoading: false, freePending };
}
