// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  CodeMuxLexicalComposerInput,
  type CodeMuxLexicalComposerInputHandle,
} from './CodeMuxLexicalComposerInput';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    composer: () => ({
      setText: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      getState: () => ({ canCancel: false }),
    }),
    on: () => () => {},
  }),
  useAuiState: (selector: (state: { thread: { isDisabled: boolean }; composer: Record<string, never> }) => unknown) =>
    selector({ thread: { isDisabled: false }, composer: {} }),
  INTERNAL: {
    useComposerInputPluginRegistryOptional: () => null,
  },
}));

describe('CodeMuxLexicalComposerInput', () => {
  it('notifies onTextChange when text is set programmatically', async () => {
    const onTextChange = vi.fn();
    const editorRef = createRef<CodeMuxLexicalComposerInputHandle>();

    render(<CodeMuxLexicalComposerInput ref={editorRef} onTextChange={onTextChange} />);

    await act(async () => {
      editorRef.current?.setText('回退的文本');
    });

    await waitFor(() => {
      expect(onTextChange).toHaveBeenCalledWith('回退的文本');
    });
    expect(editorRef.current?.getText()).toBe('回退的文本');
  });

  it('notifies onTextChange with an empty string when reset', async () => {
    const onTextChange = vi.fn();
    const editorRef = createRef<CodeMuxLexicalComposerInputHandle>();

    render(<CodeMuxLexicalComposerInput ref={editorRef} onTextChange={onTextChange} />);

    await act(async () => {
      editorRef.current?.setText('draft');
      editorRef.current?.reset();
    });

    await waitFor(() => {
      expect(onTextChange).toHaveBeenLastCalledWith('');
    });
    expect(editorRef.current?.getText()).toBe('');
  });
});
