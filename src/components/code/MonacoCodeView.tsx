import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

import { resolveMonacoLanguage } from '../../lib/monacoLanguage';
import { defineMonacoTheme, useMonacoAppearance } from '../../lib/monacoTheme';
import { configureMonacoLoader } from './monacoLoader';
import { MonacoLoading } from './MonacoLoading';

// AMD loader 的路径必须在任何实例创建前定好,所以放在模块顶层。
configureMonacoLoader();

export interface MonacoCodeViewProps {
  value: string;
  filePath?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** 覆盖由 filePath 推导的语言(用于没有文件路径的编辑器,如设置里的 JSON 配置)。 */
  language?: string;
  /** 容器高度,默认填满父容器。 */
  height?: string | number;
  wordWrap?: 'on' | 'off';
  className?: string;
}

/**
 * Monaco 用 `path` 区分文档模型:每个文件一个模型,撤销栈与滚动位置因此按文件保留。
 * 反斜杠的 Windows 路径会被 `Uri.parse` 当成 scheme,统一成正斜杠并补一个固定前缀。
 *
 * 只在**可编辑**时使用:只读浏览(预览面板)刻意不给 path,用单一模型。因为
 * `@monaco-editor/react` 的 `keepCurrentModel` 默认为 false 只会释放当前模型,按
 * path 切换留下的旧模型不会回收 —— 在文件树里连续点开上百个文件就会持续累积。
 * 只读浏览不需要按文件的撤销栈,所以这里不需要付那个代价。
 */
export function monacoModelPath(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized ? `file:///${normalized}` : undefined;
}

export default function MonacoCodeView({
  value,
  filePath,
  readOnly = true,
  onChange,
  language,
  height = '100%',
  wordWrap = 'off',
  className,
}: MonacoCodeViewProps) {
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const { themeName, options } = useMonacoAppearance(monaco);

  const handleMount = useCallback<OnMount>((mountedEditor, mountedMonaco) => {
    editorRef.current = mountedEditor;
    setMonaco(mountedMonaco);

    // JetBrains Mono 是随包的 web 字体:字体就绪前 Monaco 会用回退字体量字符宽度,
    // 等字体真正加载完重新测量,否则列对齐会一直错位。
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    void fonts?.ready?.then(() => {
      mountedMonaco.editor.remeasureFonts();
      mountedEditor.layout();
    });
  }, []);

  useEffect(() => () => {
    editorRef.current = null;
  }, []);

  return (
    <Editor
      className={className}
      height={height}
      value={value}
      path={readOnly ? undefined : monacoModelPath(filePath)}
      language={language ?? resolveMonacoLanguage(filePath)}
      theme={themeName}
      beforeMount={defineMonacoTheme}
      onMount={handleMount}
      onChange={readOnly ? undefined : (next) => onChange?.(next ?? '')}
      loading={<MonacoLoading />}
      options={{
        ...options,
        readOnly,
        // 侧栏可拖拽改宽,必须自动跟随容器尺寸。
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: readOnly ? 'none' : 'line',
        renderWhitespace: 'selection',
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        overviewRulerBorder: false,
        // 只读视图保留选择与复制能力(预览面板的主要用途),只是不可编辑。
        domReadOnly: false,
        wordWrap,
        tabSize: 2,
      }}
    />
  );
}
