import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../types/provider';
import {
  buildScheduledTaskDraftFromSettings,
  getDefaultAgentKindFromConfig,
  getConfiguredAgentModelIds,
  resolvePreferredAgentModel,
} from './scheduledTaskDefaults';

const baseConfig = {
  agent_defaults: { default_agent_kind: 'codex' as const },
  active_provider_id: 'provider-active',
  agent_configs: {
    claude_code: {
      default_provider_id: 'provider-claude',
      default_model: 'claude-model',
    },
    codex: {
      default_provider_id: 'provider-codex',
      default_model: 'codex-model',
    },
    gemini_cli: {},
    opencode: {
      default_provider_id: 'provider-opencode',
      default_model: 'opencode-model',
    },
  },
} as AppConfig;

describe('scheduledTaskDefaults', () => {
  it('reads default agent kind from settings', () => {
    expect(getDefaultAgentKindFromConfig(baseConfig)).toBe('codex');
  });

  it('builds new task draft from settings defaults', () => {
    const draft = buildScheduledTaskDraftFromSettings(baseConfig, { projectId: 'project-1' });
    expect(draft.agentKind).toBe('codex');
    expect(draft.providerId).toBe('provider-codex');
    expect(draft.model).toBe('codex-model');
    expect(draft.projectId).toBe('project-1');
    expect(draft.permissionConfig.kind).toBe('codex');
  });

  it('reads per-agent default model from agent_configs', () => {
    expect(getConfiguredAgentModelIds('codex', baseConfig)).toEqual({
      providerId: 'provider-codex',
      model: 'codex-model',
    });
  });

  it('prefers configured default model over active provider fallback', () => {
    const resolved = resolvePreferredAgentModel(
      'codex',
      baseConfig,
      [
        { modelId: 'other-model', providerId: 'provider-active' },
        { modelId: 'codex-model', providerId: 'provider-codex' },
      ],
      null,
      null,
    );
    expect(resolved).toEqual({ modelId: 'codex-model', providerId: 'provider-codex' });
  });
});
