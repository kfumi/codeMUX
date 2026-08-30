// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AddProviderDialog, buildCustomProvider } from './AddProviderDialog';

afterEach(cleanup);

describe('AddProviderDialog', () => {
  it('builds a disabled custom provider from basic fields', () => {
    const provider = buildCustomProvider({
      name: 'My Gateway',
      apiKey: 'sk-test',
      openaiUrl: 'https://example.com/v1',
      anthropicUrl: '',
    });

    expect(provider.enabled).toBe(false);
    expect(provider.name).toBe('My Gateway');
    expect(provider.api_key).toBe('sk-test');
    expect(provider.endpoints).toHaveLength(1);
    expect(provider.endpoints[0]?.protocol).toBe('openai_compatible');
    expect(provider.models).toEqual([]);
    expect(provider.default_model).toBe('');
  });

  it('submits after filling required fields and allows empty api key', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();

    render(
      <AddProviderDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如 OpenAI'), {
      target: { value: 'Custom' },
    });
    fireEvent.change(screen.getAllByPlaceholderText('https://example.com')[0]!, {
      target: { value: 'https://api.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    const provider = onSubmit.mock.calls[0]?.[0];
    expect(provider.enabled).toBe(false);
    expect(provider.name).toBe('Custom');
    expect(provider.api_key).toBe('');
  });

  it('includes the openai responses endpoint when provided', () => {
    const provider = buildCustomProvider({
      name: 'Zhipu',
      apiKey: '',
      openaiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      responsesUrl: 'https://open.bigmodel.cn/api/v1',
      anthropicUrl: '',
    });

    const responses = provider.endpoints.find(
      (endpoint) => endpoint.protocol === 'openai_responses',
    );
    expect(responses?.base_url).toBe('https://open.bigmodel.cn/api/v1');
    expect(responses?.codex_needs_proxy).toBe(false);
  });

  it('accepts a responses-only custom provider', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();

    render(
      <AddProviderDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByPlaceholderText('例如 OpenAI'), {
      target: { value: 'Responses Only' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/v1'), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      const provider = onSubmit.mock.calls[0]?.[0];
      expect(provider.endpoints).toHaveLength(1);
      expect(provider.endpoints[0]?.protocol).toBe('openai_responses');
    });
  });
});
