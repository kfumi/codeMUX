// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeMuxAssistantRuntimeProvider } from './CodeMuxAssistantRuntime';
import { CodeMuxModelSelector } from './CodeMuxModelSelector';

describe('CodeMuxModelSelector', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders the assistant-ui style selector without model icons and emits model changes', () => {
    const onChange = vi.fn();

    render(
      <CodeMuxAssistantRuntimeProvider sessionId="session-1" onSend={vi.fn()} onCommand={vi.fn()}>
        <CodeMuxModelSelector
          value="gpt-5"
          models={['gpt-5', 'gpt-5-mini']}
          onChange={onChange}
          reasoningEffort="medium"
          onReasoningEffortChange={vi.fn()}
        />
      </CodeMuxAssistantRuntimeProvider>,
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('gpt-5');
    expect(trigger.textContent).toContain('中');

    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    expect(within(list).queryByTestId('model-icon')).toBeNull();
    expect(screen.queryByText('当前供应商模型')).toBeNull();
    fireEvent.click(within(list).getByText('gpt-5-mini'));

    expect(onChange).toHaveBeenCalledWith('gpt-5-mini');
  });

  it('lets users switch providers and picks the next provider default model', () => {
    const onChange = vi.fn();
    const onProviderChange = vi.fn();

    render(
      <CodeMuxAssistantRuntimeProvider sessionId="session-1" onSend={vi.fn()} onCommand={vi.fn()}>
        <CodeMuxModelSelector
          value="claude-sonnet-4"
          models={['claude-sonnet-4']}
          providers={[
            {
              id: 'anthropic',
              name: 'Anthropic',
              api_key: 'key',
              anthropic_base_url: 'https://api.anthropic.com',
              openai_base_url: '',
              default_model: 'claude-sonnet-4',
              models: ['claude-sonnet-4'],
            },
            {
              id: 'openrouter',
              name: 'OpenRouter',
              api_key: 'key',
              anthropic_base_url: 'https://openrouter.ai/api/v1',
              openai_base_url: 'https://openrouter.ai/api/v1',
              default_model: 'claude-opus-4-1',
              models: ['claude-opus-4-1', 'claude-haiku-3-5'],
            },
          ]}
          providerId="anthropic"
          onProviderChange={onProviderChange}
          onChange={onChange}
        />
      </CodeMuxAssistantRuntimeProvider>,
    );

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'OpenRouter' }));

    expect(onProviderChange).toHaveBeenCalledWith('openrouter', 'claude-opus-4-1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows switching reasoning effort from the selector panel', () => {
    const onReasoningEffortChange = vi.fn();

    render(
      <CodeMuxAssistantRuntimeProvider sessionId="session-1" onSend={vi.fn()} onCommand={vi.fn()}>
        <CodeMuxModelSelector
          value="gpt-5"
          models={['gpt-5']}
          onChange={vi.fn()}
          reasoningEffort="medium"
          onReasoningEffortChange={onReasoningEffortChange}
        />
      </CodeMuxAssistantRuntimeProvider>,
    );

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: '高' }));

    expect(onReasoningEffortChange).toHaveBeenCalledWith('high');
  });

  it('can display runtime suffixes while emitting clean model ids', () => {
    const onChange = vi.fn();

    render(
      <CodeMuxAssistantRuntimeProvider sessionId="session-1" onSend={vi.fn()} onCommand={vi.fn()}>
        <CodeMuxModelSelector
          value="claude-sonnet-4-20250514"
          models={['claude-sonnet-4-20250514', 'claude-opus-4-1']}
          onChange={onChange}
          reasoningEffort="medium"
          onReasoningEffortChange={vi.fn()}
          getDisplayName={(model) => `${model}[1m]`}
        />
      </CodeMuxAssistantRuntimeProvider>,
    );

    expect(screen.getByRole('combobox').textContent).toContain('claude-sonnet-4-20250514[1m]');

    fireEvent.click(screen.getByRole('combobox'));
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('claude-opus-4-1[1m]')).toBeTruthy();

    fireEvent.click(within(list).getByText('claude-opus-4-1[1m]'));

    expect(onChange).toHaveBeenCalledWith('claude-opus-4-1');
  });

  it('opens upward when there is not enough space below the trigger', () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 760,
    });

    try {
      render(
        <CodeMuxAssistantRuntimeProvider sessionId="session-1" onSend={vi.fn()} onCommand={vi.fn()}>
          <CodeMuxModelSelector
            value="model-1"
            models={Array.from({ length: 12 }, (_, index) => `model-${index + 1}`)}
            onChange={vi.fn()}
            reasoningEffort="medium"
            onReasoningEffortChange={vi.fn()}
          />
        </CodeMuxAssistantRuntimeProvider>,
      );

      const trigger = screen.getByRole('combobox');
      trigger.getBoundingClientRect = vi.fn(() => ({
        x: 24,
        y: 704,
        top: 704,
        left: 24,
        right: 224,
        bottom: 736,
        width: 200,
        height: 32,
        toJSON: () => ({}),
      } as DOMRect));

      fireEvent.click(trigger);

      const panel = screen.getByTestId('model-selector-content');
      expect(panel.dataset.side).toBe('top');
      expect(panel.style.bottom).toBe('62px');
      expect(panel.style.maxHeight).toBe('680px');
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: originalInnerHeight,
      });
    }
  });
});
