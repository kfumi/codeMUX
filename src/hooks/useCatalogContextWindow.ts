import { useEffect, useState } from 'react';

import { stripContext1mSuffix } from '@/components/agent/modelDisplay';
import { daemonFacade } from '@/lib/facades/daemon-facade';

/**
 * 目录里公布的上下文窗口，models.dev 查不到时为 `null`。
 *
 * 用途只有一类会话：绑定虚拟供应商 `opencode-free` 的 OpenCode 免费模型。
 * 那些会话不对应 ModelProvider 记录，没有 `provider.models[].context_window`
 * 可读，Zen 官方 `/zen/v1/models` 又只公布 id（ADR 0017），所以上下文只能
 * 从目录取。取不到就是取不到 —— ADR 0015 要求查不到就留空，绝不猜。
 *
 * 目录本身的权威仍是用户配置；这里只在用户无从配置的场景补一个只读答案。
 */
export function useCatalogContextWindow(
  model: string | null | undefined,
  provider?: string | null,
): number | null {
  const baseId = stripContext1mSuffix((model ?? '').trim());
  const cacheKey = baseId ? `${provider ?? ''}::${baseId}` : null;

  const [contextWindow, setContextWindow] = useState<number | null>(null);

  useEffect(() => {
    if (!cacheKey) {
      setContextWindow(null);
      return;
    }

    const cached = contextWindowCache.get(cacheKey);
    if (cached !== undefined) {
      setContextWindow(cached);
      return;
    }

    // 切回一个已查过的模型时先把上一轮的值清掉，避免短暂显示错的窗口。
    setContextWindow(null);
    let active = true;

    void lookupContextWindow(cacheKey, baseId, provider)
      .then((value) => {
        if (active) setContextWindow(value);
      })
      .catch(() => {
        // daemon 没起来 / 目录不可达：留 null，不缓存，下次挂载重试。
        if (active) setContextWindow(null);
      });

    return () => {
      active = false;
    };
  }, [cacheKey, baseId, provider]);

  return contextWindow;
}

/**
 * 命中与落空都缓存：重复查询没有意义，落空（`found: false`）在本次应用
 * 运行内也视为终态 —— daemon 的 models.dev 快照中途从 bundled 回落恢复
 * 时，已 miss 的模型要到重启应用后才能拿到窗口（免费目录行的窗口是另一
 * 条兜底路径，见 useAgentModels）。**异常不缓存**，下次挂载重试。
 */
const contextWindowCache = new Map<string, number | null>();
const contextWindowInFlight = new Map<string, Promise<number | null>>();

function lookupContextWindow(
  cacheKey: string,
  model: string,
  provider?: string | null,
): Promise<number | null> {
  const existing = contextWindowInFlight.get(cacheKey);
  if (existing) return existing;

  const request = daemonFacade
    .lookupModelCatalog(model, provider)
    .then((lookup) => {
      const contextWindow = lookup.found && typeof lookup.entry?.context_window === 'number'
        && lookup.entry.context_window > 0
        ? lookup.entry.context_window
        : null;
      contextWindowCache.set(cacheKey, contextWindow);
      return contextWindow;
    })
    .catch((error) => {
      // 目录不可用不是错误答案：不在这里吞成 null 入缓存，让下次挂载重试。
      throw error;
    })
    .finally(() => {
      contextWindowInFlight.delete(cacheKey);
    });

  contextWindowInFlight.set(cacheKey, request);
  return request;
}

/** 测试专用：清空目录查询缓存。 */
export function __resetCatalogContextWindowCacheForTests(): void {
  contextWindowCache.clear();
  contextWindowInFlight.clear();
}