// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchConfig, listTemplates } = vi.hoisted(() => ({
  fetchConfig: vi.fn(() => Promise.resolve()),
  listTemplates: vi.fn(() => Promise.resolve([])),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => ({
    config: {
      model_providers: [],
      active_provider_id: null,
    },
    fetchConfig,
    upsertModelProvider: vi.fn(),
    deleteModelProvider: vi.fn(),
    setActiveProvider: vi.fn(),
    setModelProviderEnabled: vi.fn(),
    instantiateBuiltinTemplate: vi.fn(),
    testModelProvider: vi.fn(),
  }),
}));

vi.mock('@/lib/tauri', () => ({
  configApi: {
    listBuiltinProviderTemplates: listTemplates,
  },
}));

import { ProviderConfigPanel } from './ProviderConfig';

describe('ProviderConfigPanel', () => {
  beforeEach(() => {
    fetchConfig.mockClear();
    listTemplates.mockClear();
  });

  it('renders empty state and loads templates', async () => {
    render(<ProviderConfigPanel />);
    expect(await screen.findByText(/从左侧选择或添加供应商/)).toBeTruthy();
    expect(fetchConfig).toHaveBeenCalled();
    expect(listTemplates).toHaveBeenCalled();
  });
});
