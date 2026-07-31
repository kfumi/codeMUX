"use client";

import {
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type FC,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEvent,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor as LexicalEditorType,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';
import { useAui, useAuiState, INTERNAL } from '@assistant-ui/react';
import type { Unstable_DirectiveFormatter, Unstable_DirectiveSegment } from '@assistant-ui/core';
import { unstable_defaultDirectiveFormatter } from '@assistant-ui/core';
import {
  DirectiveNode,
  DirectiveChipProvider,
  DirectivePlugin,
  $createDirectiveNodeWithFormatter,
  type DirectiveChipProps,
} from '@assistant-ui/react-lexical';

export const CODEMUX_LEXICAL_SYNC_TAG = 'codemux-external-set';

export type CodeMuxLexicalComposerInputHandle = {
  getText: () => string;
  setText: (text: string) => void;
  send: () => void;
  focus: () => void;
  reset: () => void;
};

export type CodeMuxLexicalComposerInputProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'autoFocus' | 'onPaste' | 'onKeyDownCapture' | 'contentEditable'
> & {
  submitMode?: 'enter' | 'ctrlEnter' | 'none';
  cancelOnEscape?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  directiveChip?: FC<DirectiveChipProps>;
  formatter?: Unstable_DirectiveFormatter;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onTextChange?: (text: string) => void;
  onCursorChange?: (offset: number) => void;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
};

function KeyboardPlugin({
  submitMode,
  cancelOnEscape,
  sendEditor,
}: {
  submitMode: 'enter' | 'ctrlEnter' | 'none';
  cancelOnEscape: boolean;
  sendEditor: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();
  const pluginRegistry = INTERNAL.useComposerInputPluginRegistryOptional();

  useEffect(() => {
    const delegateToPlugins = (event: unknown): boolean => {
      if (!event || !pluginRegistry) return false;
      for (const plugin of pluginRegistry.getPlugins()) {
        if (plugin.handleKeyDown(event as KeyboardEvent<HTMLDivElement>)) return true;
      }
      return false;
    };

    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event) return false;
          if (event.isComposing) return false;
          if (event.shiftKey) return false;

          if (delegateToPlugins(event)) return true;

          if (submitMode === 'none') return false;

          const isRunning = aui.thread().getState().isRunning;
          if (isRunning) return false;

          let shouldSubmit = false;
          if (submitMode === 'ctrlEnter') {
            shouldSubmit = event.ctrlKey || event.metaKey;
          } else if (submitMode === 'enter') {
            shouldSubmit = !event.ctrlKey && !event.metaKey;
          }

          if (shouldSubmit) {
            event.preventDefault();
            sendEditor();
            return true;
          }

          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),

      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (event && delegateToPlugins(event)) return true;

          if (!cancelOnEscape) return false;
          const composer = aui.composer();
          if (composer.getState().canCancel) {
            composer.cancel();
            event?.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),

      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => {
          if (event && delegateToPlugins(event)) return true;
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),

      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => {
          if (event && delegateToPlugins(event)) return true;
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),

      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          if (event && delegateToPlugins(event)) return true;
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, submitMode, cancelOnEscape, aui, pluginRegistry, sendEditor]);

  return null;
}

function computeCursorOffset(): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return 0;
  const anchor = selection.anchor;
  if (anchor.type !== 'text') return 0;
  const anchorNode = anchor.getNode();
  if (!$isTextNode(anchorNode)) return 0;

  let offset = 0;
  const paragraph = anchorNode.getParent();
  if (paragraph && $isElementNode(paragraph)) {
    const root = $getRoot();
    for (const child of root.getChildren()) {
      if (child === paragraph) break;
      if ($isElementNode(child)) {
        for (const c of child.getChildren()) {
          offset += c.getTextContent().length;
        }
      }
      offset += 1;
    }
    for (const child of paragraph.getChildren()) {
      if (child === anchorNode) {
        offset += anchor.offset;
        break;
      }
      offset += child.getTextContent().length;
    }
  } else {
    offset = anchor.offset;
  }
  return offset;
}

function LocalStatePlugin({
  onTextChange,
  onCursorChange,
}: {
  onTextChange?: (text: string) => void;
  onCursorChange?: (offset: number) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    let lastAnchorKey: string | null = null;
    let lastAnchorOffset = -1;

    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has(CODEMUX_LEXICAL_SYNC_TAG)) return;

      editorState.read(() => {
        const rootNode = $getRoot();
        let fullText = '';
        for (const paragraph of rootNode.getChildren()) {
          if (fullText.length > 0) fullText += '\n';
          if (!$isElementNode(paragraph)) continue;
          for (const child of paragraph.getChildren()) {
            fullText += child.getTextContent();
          }
        }
        onTextChangeRef.current?.(fullText);

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          lastAnchorKey = null;
          lastAnchorOffset = -1;
          onCursorChangeRef.current?.(0);
          return;
        }
        const anchor = selection.anchor;
        if (anchor.type !== 'text') {
          lastAnchorKey = null;
          lastAnchorOffset = -1;
          onCursorChangeRef.current?.(0);
          return;
        }
        if (anchor.key === lastAnchorKey && anchor.offset === lastAnchorOffset) return;
        lastAnchorKey = anchor.key;
        lastAnchorOffset = anchor.offset;
        const offset = computeCursorOffset();
        onCursorChangeRef.current?.(offset);
      });
    });
  }, [editor]);

  return null;
}

function CursorPlugin() {
  const [editor] = useLexicalComposerContext();
  const pluginRegistry = INTERNAL.useComposerInputPluginRegistryOptional();

  useEffect(() => {
    if (!pluginRegistry) return undefined;

    let lastAnchorKey: string | null = null;
    let lastAnchorOffset = -1;

    const broadcastCursor = (pos: number) => {
      for (const plugin of pluginRegistry.getPlugins()) {
        plugin.setCursorPosition(pos);
      }
    };

    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          broadcastCursor(0);
          return;
        }
        const anchor = selection.anchor;
        if (anchor.type !== 'text') {
          broadcastCursor(0);
          return;
        }
        const anchorNode = anchor.getNode();
        if (!$isTextNode(anchorNode)) {
          broadcastCursor(0);
          return;
        }
        if (anchor.key === lastAnchorKey && anchor.offset === lastAnchorOffset) return;
        lastAnchorKey = anchor.key;
        lastAnchorOffset = anchor.offset;
        const offset = computeCursorOffset();
        broadcastCursor(offset);
      });
    });
  }, [editor, pluginRegistry]);

  return null;
}

function FocusPlugin({ autoFocus }: { autoFocus: boolean }) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();

  useEffect(() => {
    if (autoFocus) editor.focus();
  }, [editor, autoFocus]);

  useEffect(() => {
    return aui.on('thread.runStart', () => {
      editor.focus();
    });
  }, [editor, aui]);

  return null;
}

function EditablePlugin({ isDisabled }: { isDisabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!isDisabled);
  }, [editor, isDisabled]);
  return null;
}

function parseLineWithFormatter(line: string, formatter: Unstable_DirectiveFormatter): readonly { segment: Unstable_DirectiveSegment; formatter: Unstable_DirectiveFormatter }[] {
  const segments = formatter.parse(line);
  if (segments.some((s) => s.kind === 'mention')) {
    return segments.map((segment) => ({ segment, formatter }));
  }
  const fallback = unstable_defaultDirectiveFormatter.parse(line);
  return fallback.map((segment) => ({ segment, formatter: unstable_defaultDirectiveFormatter }));
}

function applyTextToEditor(editor: LexicalEditorType, text: string, formatter: Unstable_DirectiveFormatter) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      if (text.length === 0) {
        root.append($createParagraphNode());
        root.selectEnd();
        return;
      }

      const lines = text.split('\n');
      for (const line of lines) {
        const paragraph = $createParagraphNode();
        const segments = parseLineWithFormatter(line, formatter);
        for (const { segment, formatter: segFormatter } of segments) {
          if (segment.kind === 'text') {
            if (segment.text.length > 0) {
              paragraph.append($createTextNode(segment.text));
            }
          } else {
            paragraph.append(
              $createDirectiveNodeWithFormatter(
                {
                  id: segment.id,
                  type: segment.type,
                  label: segment.label,
                },
                segFormatter,
              ),
            );
          }
        }
        root.append(paragraph);
      }
      root.selectEnd();
    },
    { tag: CODEMUX_LEXICAL_SYNC_TAG },
  );
}

function readEditorText(editor: LexicalEditorType): string {
  return editor.getEditorState().read(() => {
    const rootNode = $getRoot();
    let fullText = '';
    for (const paragraph of rootNode.getChildren()) {
      if (fullText.length > 0) fullText += '\n';
      if (!$isElementNode(paragraph)) continue;
      for (const child of paragraph.getChildren()) {
        fullText += child.getTextContent();
      }
    }
    return fullText;
  });
}

function clearEditor(editor: LexicalEditorType) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      root.append($createParagraphNode());
      root.selectEnd();
    },
    { tag: CODEMUX_LEXICAL_SYNC_TAG },
  );
}

export const CodeMuxLexicalComposerInput = forwardRef<
  CodeMuxLexicalComposerInputHandle,
  CodeMuxLexicalComposerInputProps
>(
  (
    {
      submitMode = 'enter',
      cancelOnEscape = true,
      placeholder,
      autoFocus = false,
      directiveChip,
      formatter: formatterProp,
      className,
      onPaste,
      onTextChange,
      onCursorChange,
      onKeyDownCapture,
      ...rest
    },
    ref,
  ) => {
    const isDisabled = useAuiState(
      (s) => s.thread.isDisabled || s.composer.dictation?.inputDisabled,
    );
    const resolvedFormatter = useMemo(
      () => formatterProp ?? unstable_defaultDirectiveFormatter,
      [formatterProp],
    );

    const initialConfig = useMemo(
      () => ({
        namespace: 'codemux-lexical-composer',
        nodes: [DirectiveNode],
        onError: (error: Error) => {
          console.error('[CodeMuxLexicalComposerInput]', error);
        },
      }),
      [],
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <DirectiveChipProvider value={directiveChip ?? null}>
          <InnerCodeMuxLexicalComposerInput
            ref={ref}
            submitMode={submitMode}
            cancelOnEscape={cancelOnEscape}
            placeholder={placeholder}
            autoFocus={autoFocus}
            resolvedFormatter={resolvedFormatter}
            isDisabled={!!isDisabled}
            className={className}
            onPaste={onPaste}
            onTextChange={onTextChange}
            onCursorChange={onCursorChange}
            onKeyDownCapture={onKeyDownCapture}
            restProps={rest}
          />
        </DirectiveChipProvider>
      </LexicalComposer>
    );
  },
);

CodeMuxLexicalComposerInput.displayName = 'CodeMuxLexicalComposerInput';

type InnerProps = {
  submitMode: 'enter' | 'ctrlEnter' | 'none';
  cancelOnEscape: boolean;
  placeholder?: string;
  autoFocus: boolean;
  resolvedFormatter: Unstable_DirectiveFormatter;
  isDisabled: boolean;
  className?: string;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onTextChange?: (text: string) => void;
  onCursorChange?: (offset: number) => void;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  restProps: Omit<ComponentPropsWithoutRef<'div'>, 'autoFocus' | 'onPaste' | 'onKeyDownCapture' | 'contentEditable'>;
};

const InnerCodeMuxLexicalComposerInput = forwardRef<
  CodeMuxLexicalComposerInputHandle,
  InnerProps
>(
  (
    {
      submitMode,
      cancelOnEscape,
      placeholder,
      autoFocus,
      resolvedFormatter,
      isDisabled,
      className,
      onPaste,
      onTextChange,
      onCursorChange,
      onKeyDownCapture,
      restProps,
    },
    ref,
  ) => {
    const [editor] = useLexicalComposerContext();
    const aui = useAui();

    const sendWithAui = useMemo(() => {
      return () => {
        const text = readEditorText(editor);
        aui.composer().setText(text);
        aui.composer().send();
        clearEditor(editor);
      };
    }, [editor, aui]);

    useImperativeHandle(
      ref,
      () => ({
        getText: () => readEditorText(editor),
        setText: (text: string) => applyTextToEditor(editor, text, resolvedFormatter),
        send: sendWithAui,
        focus: () => editor.focus(),
        reset: () => clearEditor(editor),
      }),
      [editor, resolvedFormatter, sendWithAui],
    );

    return (
      <div
        className={className ? `aui-lexical-editor ${className}` : 'aui-lexical-editor'}
        {...restProps}
        onPaste={onPaste}
        onKeyDownCapture={onKeyDownCapture}
        style={{ overflowY: 'auto', ...restProps.style }}
      >
        <PlainTextPlugin
          contentEditable={<ContentEditable className="aui-lexical-input" />}
          placeholder={
            placeholder ? <div className="aui-lexical-placeholder">{placeholder}</div> : null
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <LocalStatePlugin onTextChange={onTextChange} onCursorChange={onCursorChange} />
        <DirectivePlugin />
        <KeyboardPlugin
          submitMode={submitMode}
          cancelOnEscape={cancelOnEscape}
          sendEditor={sendWithAui}
        />
        <CursorPlugin />
        <FocusPlugin autoFocus={autoFocus} />
        <EditablePlugin isDisabled={isDisabled} />
      </div>
    );
  },
);

InnerCodeMuxLexicalComposerInput.displayName = 'InnerCodeMuxLexicalComposerInput';
