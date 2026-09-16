import { useCallback, useRef, useState } from 'react';
import { DiffEditor, type Monaco, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

import { resolveMonacoLanguage } from '../../lib/monacoLanguage';
import { defineMonacoTheme, useMonacoAppearance } from '../../lib/monacoTheme';
import { configureMonacoLoader } from './monacoLoader';

configureMonacoLoader();

export interface MonacoDiffViewProps {
  oldContent: string;
  newContent: string;
  filePath?: string;
  /** AMD 运行时拉取期间显示的占位(调用方传内置 diff 视图)。 */
  loadingFallback?: React.ReactNode;
  className?: string;
}

export default function MonacoDiffView({
  oldContent,
  newContent,
  filePath,
  loadingFallback,
  className,
}: MonacoDiffViewProps) {
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const { themeName, options } = useMonacoAppearance(monaco);

  const handleMount = useCallback<DiffOnMount>((mountedEditor, mountedMonaco) => {
    editorRef.current = mountedEditor;
    setMonaco(mountedMonaco);

    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    void fonts?.ready?.then(() => {
      mountedMonaco.editor.remeasureFonts();
      mountedEditor.layout();
    });
  }, []);

  return (
    <DiffEditor
      className={className}
      original={oldContent}
      modified={newContent}
      language={resolveMonacoLanguage(filePath)}
      theme={themeName}
      beforeMount={defineMonacoTheme}
      onMount={handleMount}
      loading={loadingFallback}
      options={{
        ...options,
        readOnly: true,
        originalEditable: false,
        // 侧栏可拖拽改宽,必须自动跟随容器尺寸。
        automaticLayout: true,
        // 并排是 VS Code 的默认观感;容器太窄时 Monaco 自动切内联,
        // 侧栏通常都不到那个宽度,所以窄栏下就是内联 diff。
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        // 与旧实现「把未变更段落折叠成 ...」等价的能力,但可展开。
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3 },
        // 空白差异要看得见,否则 diff 会看起来「没有变化」。
        ignoreTrimWhitespace: false,
        renderOverviewRuler: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        overviewRulerBorder: false,
        diffWordWrap: 'off',
      }}
    />
  );
}
