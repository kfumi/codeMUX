import type { DaemonConnectionConfig } from './client';
import type { FetchedModelNameInput } from '../modelRegistry';
import type { ModelCatalogLookup, ModelDisplayNameIndex } from '../modelCatalog';
import type { BuiltinProviderTemplate } from '../../types/provider';

type Fetcher = <T>(config: DaemonConnectionConfig, path: string, init?: RequestInit) => Promise<T>;

export function createControlPlaneMethods(config: DaemonConnectionConfig, fetch: Fetcher) {
  return {
    // MCP
    mcpList: () => fetch<unknown[]>(config, '/mcp'),
    mcpUpsert: (server: unknown) =>
      fetch(config, '/mcp', { method: 'POST', body: JSON.stringify(server) }),
    mcpDelete: (id: string) => fetch(config, `/mcp/${id}`, { method: 'DELETE' }),
    mcpToggleApp: (id: string, app: string, enabled: boolean) =>
      fetch(config, `/mcp/${id}/apps`, {
        method: 'PATCH',
        body: JSON.stringify({ app, enabled }),
      }),
    mcpProbe: (id: string) => fetch<{ connected: boolean; instructions?: string | null; tools?: string[] }>(config, `/mcp/${id}/probe`, { method: 'POST' }),
    mcpProbeAll: () => fetch<Record<string, { connected: boolean; tools?: string[] }>>(config, '/mcp/probe-all', { method: 'POST' }),
    mcpProbeSpec: (spec: unknown) =>
      fetch<{ connected: boolean; instructions?: string | null; tools?: string[] }>(config, '/mcp/probe-spec', {
        method: 'POST',
        body: JSON.stringify({ spec }),
      }),
    mcpImport: () => fetch<{ total: number }>(config, '/mcp/import', { method: 'POST' }),

    // Skills
    skillsList: () => fetch<unknown[]>(config, '/skills'),
    skillsListImportable: () => fetch<unknown[]>(config, '/skills/importable'),
    skillsUninstall: (id: string) => fetch<{ removed: boolean }>(config, `/skills/${id}`, { method: 'DELETE' }),
    skillsToggleApp: (id: string, app: string, enabled: boolean) =>
      fetch(config, `/skills/${id}/apps`, {
        method: 'PATCH',
        body: JSON.stringify({ app, enabled }),
      }),
    skillsGetContent: async (id: string) => {
      const result = await fetch<{ content: string }>(config, `/skills/${id}/content`);
      return result.content;
    },
    skillsSync: () => fetch<unknown[]>(config, '/skills/sync', { method: 'POST' }),
    skillsRegister: (name: string) =>
      fetch(config, '/skills/register', { method: 'POST', body: JSON.stringify({ name }) }),
    skillsImport: (selected?: string[] | null) =>
      fetch<{ total: number }>(config, '/skills/import', {
        method: 'POST',
        body: JSON.stringify({ selected: selected ?? null }),
      }),
    skillsListProject: (projectRoot: string, agentKind: string, force = false) => {
      const params = new URLSearchParams({
        projectRoot,
        agentKind,
        force: String(force),
      });
      return fetch<unknown[]>(config, `/skills/project?${params.toString()}`);
    },

    // Scheduled tasks
    scheduledList: () => fetch<unknown[]>(config, '/scheduled-tasks'),
    scheduledGet: (taskId: string) => fetch<unknown | null>(config, `/scheduled-tasks/${taskId}`),
    scheduledCreate: (input: unknown) =>
      fetch(config, '/scheduled-tasks', { method: 'POST', body: JSON.stringify(input) }),
    scheduledUpdate: (taskId: string, input: unknown) =>
      fetch(config, `/scheduled-tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    scheduledDelete: (taskId: string) =>
      fetch(config, `/scheduled-tasks/${taskId}`, { method: 'DELETE' }),
    scheduledSetEnabled: (taskId: string, enabled: boolean) =>
      fetch(config, `/scheduled-tasks/${taskId}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    scheduledListRuns: (taskId: string) =>
      fetch<unknown[]>(config, `/scheduled-tasks/${taskId}/runs`),
    scheduledRunNow: (taskId: string) =>
      fetch(config, `/scheduled-tasks/${taskId}/run`, { method: 'POST' }),
    scheduledDeleteRun: (runId: string) =>
      fetch(config, `/scheduled-tasks/runs/${runId}`, { method: 'DELETE' }),
    scheduledGetTimezone: async () => {
      const result = await fetch<{ timezone: string }>(config, '/scheduled-tasks/timezone');
      return result.timezone;
    },

    // Workspace files
    readWorkspaceFile: async (path: string, basePath?: string) => {
      const result = await fetch<{ content: string }>(config, '/workspace/files/read', {
        method: 'POST',
        body: JSON.stringify({ path, basePath }),
      });
      return result.content;
    },
    writeWorkspaceFile: (path: string, content: string, basePath?: string) =>
      fetch(config, '/workspace/files/write', {
        method: 'POST',
        body: JSON.stringify({ path, content, basePath }),
      }),
    deleteWorkspaceFile: (path: string, basePath?: string) =>
      fetch(config, '/workspace/files/delete', {
        method: 'POST',
        body: JSON.stringify({ path, basePath }),
      }),
    listWorkspaceDirectory: (
      path: string,
      depth?: number,
      basePath?: string,
      includeHidden = false,
    ) =>
      fetch<unknown[]>(config, '/workspace/files/list', {
        method: 'POST',
        body: JSON.stringify({ path, depth, basePath, includeHidden }),
      }),

    // Git (subset used by desktop)
    gitChangedFiles: (projectPath: string, baselineTree: string) =>
      fetch<unknown[]>(config, '/workspace/git/changed-files', {
        method: 'POST',
        body: JSON.stringify({ projectPath, baselineTree }),
      }),
    gitChangedFilesSinceHead: (projectPath: string) =>
      fetch<unknown[]>(config, '/workspace/git/changed-files-since-head', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      }),
    gitRepositoryState: (projectPath: string) =>
      fetch(config, '/workspace/git/repository-state', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      }),
    gitStatusChanges: (projectPath: string, area: string) =>
      fetch<unknown[]>(config, '/workspace/git/status-changes', {
        method: 'POST',
        body: JSON.stringify({ projectPath, area }),
      }),
    gitStatusChangeDetail: (projectPath: string, area: string, filePath: string) =>
      fetch(config, '/workspace/git/status-change-detail', {
        method: 'POST',
        body: JSON.stringify({ projectPath, area, filePath }),
      }),
    gitStage: (projectPath: string, filePath?: string) =>
      fetch(config, '/workspace/git/stage', {
        method: 'POST',
        body: JSON.stringify({ projectPath, filePath }),
      }),
    gitUnstage: (projectPath: string, filePath?: string) =>
      fetch(config, '/workspace/git/unstage', {
        method: 'POST',
        body: JSON.stringify({ projectPath, filePath }),
      }),
    gitRevert: (projectPath: string, area: string, filePath?: string) =>
      fetch(config, '/workspace/git/revert', {
        method: 'POST',
        body: JSON.stringify({ projectPath, area, filePath }),
      }),
    gitCreateBranch: (projectPath: string, branchName: string, checkout: boolean) =>
      fetch(config, '/workspace/git/create-branch', {
        method: 'POST',
        body: JSON.stringify({ projectPath, branchName, checkout }),
      }),
    gitCheckoutBranch: (projectPath: string, branchName: string) =>
      fetch(config, '/workspace/git/checkout-branch', {
        method: 'POST',
        body: JSON.stringify({ projectPath, branchName }),
      }),
    gitListWorktrees: (projectPath: string) => {
      const params = new URLSearchParams({ projectPath });
      return fetch<unknown[]>(config, `/workspace/git/worktrees?${params.toString()}`);
    },
    gitCreateWorktree: (
      projectPath: string,
      branchName: string,
      baseBranch?: string | null,
    ) =>
      fetch(config, '/workspace/git/worktrees', {
        method: 'POST',
        body: JSON.stringify({ projectPath, branchName, baseBranch }),
      }),
    gitCommit: (projectPath: string, message: string) =>
      fetch<{ commit: string }>(config, '/workspace/git/commit', {
        method: 'POST',
        body: JSON.stringify({ projectPath, message }),
      }),
    gitPush: (projectPath: string) =>
      fetch(config, '/workspace/git/push', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      }),
    gitGenerateCommitMessage: (projectPath: string) =>
      fetch(config, '/workspace/git/generate-commit-message', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      }),
    gitGeneratePullRequestDescription: (projectPath: string) =>
      fetch(config, '/workspace/git/generate-pr-description', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      }),
    gitCreatePullRequest: (request: unknown) =>
      fetch(config, '/workspace/git/pull-request', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    gitGiteeCredentialStatus: () =>
      fetch<{ configured: boolean }>(config, '/workspace/git/gitee/credentials'),
    gitSetGiteeToken: async (token: string) => {
      await fetch(config, '/workspace/git/gitee/token', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },
    gitClearGiteeToken: async () => {
      await fetch(config, '/workspace/git/gitee/token', { method: 'DELETE' });
    },

    // Runtime
    checkManagedRuntimes: () => fetch(config, '/runtime/managed'),
    managedRuntimeListVersions: (provider: string) =>
      fetch<string[]>(config, `/runtime/managed/${encodeURIComponent(provider)}/versions`),
    managedRuntimeRefresh: (provider: string) =>
      fetch(config, `/runtime/managed/${encodeURIComponent(provider)}/refresh`, { method: 'POST' }),
    managedRuntimeInstall: (provider: string, version?: string) =>
      fetch(config, '/runtime/managed/install', {
        method: 'POST',
        body: JSON.stringify({ provider, version }),
      }),
    managedRuntimeUpgrade: (provider: string) =>
      fetch(config, '/runtime/managed/upgrade', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      }),
    managedRuntimeRepair: (provider: string) =>
      fetch(config, '/runtime/managed/repair', {
        method: 'POST',
        body: JSON.stringify({ provider }),
      }),
    managedRuntimeRemove: async (provider: string) => {
      await fetch(config, `/runtime/managed/${encodeURIComponent(provider)}`, { method: 'DELETE' });
    },

    // Usage
    usageGetStats: (agentKind?: string, days?: number) => {
      const params = new URLSearchParams();
      if (agentKind) params.set('agentKind', agentKind);
      if (days != null) params.set('days', String(days));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return fetch(config, `/usage/stats${suffix}`);
    },
    usageGetTokenBreakdown: (agentKind?: string, days?: number) => {
      const params = new URLSearchParams();
      if (agentKind) params.set('agentKind', agentKind);
      if (days != null) params.set('days', String(days));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return fetch(config, `/usage/token-breakdown${suffix}`);
    },

    // Model providers
    providersList: () => fetch<{ providers: unknown[]; activeProviderId: string | null }>(config, '/providers'),
    providersUpsert: (provider: unknown) =>
      fetch(config, '/providers', { method: 'POST', body: JSON.stringify(provider) }),
    providersDelete: (id: string) => fetch(config, `/providers/${id}`, { method: 'DELETE' }),
    providersTemplates: () => fetch<BuiltinProviderTemplate[]>(config, '/providers/templates'),
    providersInstantiateTemplate: (templateId: string) =>
      fetch(config, `/providers/templates/${templateId}/instantiate`, { method: 'POST' }),
    providersSetActive: (providerId: string) =>
      fetch(config, `/providers/${providerId}/active`, { method: 'POST', body: '{}' }),
    providersSetEnabled: (providerId: string, enabled: boolean) =>
      fetch(config, `/providers/${providerId}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    providersUsable: (providerId: string, agentKind: string) =>
      fetch<{ usable: boolean }>(config, `/providers/${providerId}/usable?agentKind=${encodeURIComponent(agentKind)}`),
    providersTest: (apiKey: string, baseUrl: string) =>
      fetch<{ message: string }>(config, '/providers/test', {
        method: 'POST',
        body: JSON.stringify({ apiKey, baseUrl }),
      }),
    providersFetchModels: (apiKey: string, baseUrl: string) =>
      fetch<FetchedModelNameInput[]>(config, '/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ apiKey, baseUrl }),
      }),
    providersFetchOpenCodeFreeModels: () =>
      fetch<unknown[]>(config, '/providers/opencode-free-models'),
    providersLookupModelCatalog: (model: string, provider?: string | null) => {
      const query = new URLSearchParams({ model });
      if (provider) query.set('provider', provider);
      return fetch<ModelCatalogLookup>(config, `/providers/catalog/lookup?${query.toString()}`);
    },
    providersFetchModelCatalogNames: () =>
      fetch<ModelDisplayNameIndex>(config, '/providers/catalog/names'),

    // Companion(移动伴侣配对):daemon 侧管理面路由(状态/开关/配对码/中继),
    // 限回环来源 + Local Daemon Token。
    companionGetStatus: () => fetch(config, '/companion/status'),
    companionSetEnabled: (enabled: boolean) =>
      fetch(config, '/companion/enabled', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    companionRefreshPairingCode: () =>
      fetch(config, '/companion/pairing-code/refresh', { method: 'POST' }),
    companionSetRelayEnabled: (enabled: boolean) =>
      fetch(config, '/companion/relay/enabled', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    companionSetRelayConfig: (endpoint: string, useTls: boolean) =>
      fetch(config, '/companion/relay/config', {
        method: 'POST',
        body: JSON.stringify({ endpoint, useTls }),
      }),

    // Session maintenance
    rewindSession: (
      sessionId: string,
      body: { agentKind: string; target?: unknown; mode?: string },
    ) =>
      fetch(config, `/sessions/${sessionId}/rewind`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // Agent runtime
    ensureAgentSession: (sessionId: string, cwd: string, reasoningEffort?: string | null) =>
      fetch(config, `/sessions/${sessionId}/ensure-agent`, {
        method: 'POST',
        body: JSON.stringify({ cwd, reasoningEffort }),
      }),
    enrichAttachments: (attachments: unknown[]) =>
      fetch<{ blocks: unknown[] }>(config, '/agent/enrich-attachments', {
        method: 'POST',
        body: JSON.stringify({ attachments }),
      }),
    getAgentSessionInfo: (sessionId: string, agentKind: string) => {
      const params = new URLSearchParams({ agentKind });
      return fetch<{ agentSessionId?: string | null; messagePath?: string | null }>(
        config,
        `/sessions/${sessionId}/agent-info?${params.toString()}`,
      );
    },
    loadLatestTokenUsage: (
      sessionId: string,
      agentKind: string,
      freshness?: string,
    ) => {
      const params = new URLSearchParams({ agentKind });
      if (freshness) params.set('freshness', freshness);
      return fetch(config, `/sessions/${sessionId}/token-usage?${params.toString()}`);
    },
    loadSessionSubagents: (sessionId: string) =>
      fetch<{ subagents: unknown[]; timelines: Record<string, unknown[]> }>(
        config,
        `/sessions/${sessionId}/subagents`,
      ),
    deleteSessionNativeFiles: (sessionId: string, agentKind: string) => {
      const params = new URLSearchParams({ agentKind });
      return fetch<{ deleted: string[] }>(
        config,
        `/sessions/${sessionId}/native-files?${params.toString()}`,
        { method: 'DELETE' },
      );
    },
    // Work tasks（待办看板）
    workTaskList: () => fetch<unknown[]>(config, '/work-tasks'),
    workTaskGet: (taskId: string) => fetch<unknown | null>(config, `/work-tasks/${taskId}`),
    workTaskCreate: (input: unknown) =>
      fetch(config, '/work-tasks', { method: 'POST', body: JSON.stringify(input) }),
    workTaskUpdate: (taskId: string, input: unknown) =>
      fetch(config, `/work-tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    workTaskDelete: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}`, { method: 'DELETE' }),
    workTaskArchive: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/archive`, { method: 'POST' }),
    workTaskUnarchive: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/unarchive`, { method: 'POST' }),
    workTaskReorder: (projectId: string, ids: string[]) =>
      fetch(config, '/work-tasks/reorder', {
        method: 'POST',
        body: JSON.stringify({ projectId, ids }),
      }),
    workTaskStart: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/start`, { method: 'POST' }),
    workTaskCancel: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/cancel`, { method: 'POST' }),
    workTaskRetry: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/retry`, { method: 'POST' }),
    workTaskRestart: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/restart`, { method: 'POST' }),
    workTaskMerge: (taskId: string, message?: string) =>
      fetch(config, `/work-tasks/${taskId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ message: message ?? null }),
      }),
    workTaskComplete: (taskId: string) =>
      fetch(config, `/work-tasks/${taskId}/complete`, { method: 'POST' }),
    workTaskListEvents: (taskId: string) =>
      fetch<unknown[]>(config, `/work-tasks/${taskId}/events`),
  };
}

export type ControlPlaneMethods = ReturnType<typeof createControlPlaneMethods>;
