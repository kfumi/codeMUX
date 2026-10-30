import type { ModelProvider, Provider } from '../../../types/provider';
import type { ModelDisplayNameIndex } from '../../modelCatalog';
import { ensureDaemonClient } from './lifecycle';

/** 模型供应商目录与配置。 */
export const provider = {
  listTemplates: async () => (await ensureDaemonClient()).providersTemplates(),
  instantiateTemplate: async (templateId: string) =>
    (await ensureDaemonClient()).providersInstantiateTemplate(templateId),
  upsert: async (entry: Provider | ModelProvider) => {
    await (await ensureDaemonClient()).providersUpsert(entry);
  },
  delete: async (providerId: string) => {
    await (await ensureDaemonClient()).providersDelete(providerId);
  },
  setActive: async (providerId: string) => {
    await (await ensureDaemonClient()).providersSetActive(providerId);
  },
  setEnabled: async (providerId: string, enabled: boolean) => {
    await (await ensureDaemonClient()).providersSetEnabled(providerId, enabled);
  },
  test: async (apiKey: string, baseUrl: string) => {
    const result = await (await ensureDaemonClient()).providersTest(apiKey, baseUrl);
    return result.message;
  },
  fetchModels: async (apiKey: string, baseUrl: string, providerName?: string | null) =>
    (await ensureDaemonClient()).providersFetchModels(apiKey, baseUrl, providerName),
  fetchOpenCodeFreeModels: async () =>
    (await ensureDaemonClient()).providersFetchOpenCodeFreeModels(),
  lookupCatalog: async (model: string, providerName?: string | null) =>
    (await ensureDaemonClient()).providersLookupModelCatalog(model, providerName),
  fetchCatalogNames: async (): Promise<ModelDisplayNameIndex> =>
    (await ensureDaemonClient()).providersFetchModelCatalogNames(),
};

export type ProviderDomain = typeof provider;
