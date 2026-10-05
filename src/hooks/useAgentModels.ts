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
}

interface OpenCodeFreeModelPayloadRow {
  id?: unknown;
  name?: unknown;
}

const FREE_MODELS_CACHE_TTL_MS = 60_000;
let freeModelsCache: { at: number; rows: OpenCodeFreeModelRow[] } | null = null;
let freeModelsInFlight: Promise<OpenCodeFreeModelRow[]> | null = null;

/** 测试专用：清空免费模型模块缓存，保证用例之间互不影响。 */
export function resetOpenCodeFreeModelsCacheForTests(): void {
  freeModelsCache = null;
  freeModelsInFlight = null;
}

/**
 * 拉取 Zen 免费模型目录（daemon `/providers/opencode-free-models`）。
 * 模块级短缓存 + 在途去重：选择器在新建面板、自动化编辑器、会话 composer
 * 三处各挂一个实例，避免重复打 daemon。失败不缓存，下次挂载重试。
 */
function fetchOpenCodeFreeModelRows(): Promise<OpenCodeFreeModelRow[]> {
  const now = Date.now();
  if (freeModelsCache && now - freeModelsCache.at < FREE_MODELS_CACHE_TTL_MS) {
    return Promise.resolve(freeModelsCache.rows);
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
          }));
        freeModelsCache = { at: now, rows };
        return rows;
      })
      .finally(() => {
        freeModelsInFlight = null;
      });
  }
  return freeModelsInFlight;
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
  };
}

/** Collect usable provider models for an agent, grouped by provider. */
export function useAgentModels(
  agentKind: AgentKind,
  providers: ModelProvider[] | ModelProvider | null,
  _activeProviderId: string | null = null,
): { models: ModelOption[]; isLoading: boolean } {
  const providerList = useMemo(() => {
    if (!providers) return [] as ModelProvider[];
    return Array.isArray(providers) ? providers : [providers];
  }, [providers]);

  const [tick, setTick] = useState(0);
  const freeModels = useOpenCodeFreeModelOptions(agentKind);
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

  return { models, isLoading: false };
}
