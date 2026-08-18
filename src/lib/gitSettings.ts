import type { GitSettings } from '../types/provider';

export function normalizeGitSettings(
  settings: Partial<GitSettings> | null | undefined,
): GitSettings {
  return {
    commit_instructions: settings?.commit_instructions ?? '',
    pull_request_instructions: settings?.pull_request_instructions ?? '',
    provider_id: settings?.provider_id ?? null,
    model: settings?.model ?? '',
  };
}
