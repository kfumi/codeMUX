import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor, type Monaco, type DiffOnMount } from '@monaco-editor/react';
import type { IDisposable, editor } from 'monaco-editor';

import { cn } from '../../lib/utils';
import { resolveMonacoLanguage } from '../../lib/monacoLanguage';
import { defineMonacoTheme, useMonacoAppearance } from '../../lib/monacoTheme';
import { configureMonacoLoader } from './monacoLoader';
import { MonacoLoading } from './MonacoLoading';

configureMonacoLoader();

export type DiffViewMode = 'split' | 'unified';

export interface MonacoDiffViewProps {
  oldContent: string;
  newContent: string;
  filePath?: string;
  /** 并排(split,默认)或内联(unified)。切换只改 options,不触发重算。 */
  viewMode?: DiffViewMode;
  className?: string;
}

/**
 * diff 计算在 editor worker 里异步完成:结果回来前两侧先按普通文本渲染,且
 * hideUnchangedRegions 不折叠 —— 直接露出来就是「整份文件内容 → 算完闪成 diff」。
 * 所以在 onDidUpdateDiff 报告 diff 算完之前,用加载占位盖住编辑器。
 *
 * 事件与折叠虽在同一事务里生效,但 Monaco 的视图渲染排到下一个动画帧;React 撤掉
 * 遮罩是微任务,更快 —— 直接露出会把「未折叠的全内容」那一帧画出来,还得再等两帧
 * 让折叠后的画面真正上屏。
 * 定时器兜底防止个别边缘场景事件不触发、永远停在加载态。
 */
const DIFF_READY_FAILSAFE_MS = 3000;

export default function MonacoDiffView({
  oldContent,
  newContent,
  filePath,
  viewMode = 'split',
  className,
}: MonacoDiffViewProps) {
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const [diffReady, setDiffReady] = useState(false);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const diffListenerRef = useRef<IDisposable | null>(null);
  const { themeName, options } = useMonacoAppearance(monaco);

  const handleMount = useCallback<DiffOnMount>((mountedEditor, mountedMonaco) => {
    editorRef.current = mountedEditor;
    setMonaco(mountedMonaco);

    diffListenerRef.current?.dispose();
    diffListenerRef.current = mountedEditor.onDidUpdateDiff(() => {
      // 等两帧:第一帧 Monaco 完成折叠后的渲染调度,第二帧确保已上屏。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setDiffReady(true));
      });
    });

    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    void fonts?.ready?.then(() => {
      mountedMonaco.editor.remeasureFonts();
      mountedEditor.layout();
    });
  }, []);

  useEffect(() => () => {
    diffListenerRef.current?.dispose();
    diffListenerRef.current = null;
    editorRef.current = null;
  }, []);

  // 挂载与内容原位更新(openDiffTab 同 id 刷新)都会重走「计算中 → 就绪」。
  useEffect(() => {
    setDiffReady(false);
    const failsafe = window.setTimeout(() => setDiffReady(true), DIFF_READY_FAILSAFE_MS);
    return () => window.clearTimeout(failsafe);
  }, [oldContent, newContent]);

  // options 引用必须稳定:否则每次渲染都会让 @monaco-editor/react 调 updateOptions。
  const diffOptions = useMemo<editor.IStandaloneDiffEditorConstructionOptions>(
    () => ({
      ...options,
      readOnly: true,
      originalEditable: false,
      // 侧栏可拖拽改宽,必须自动跟随容器尺寸。
      automaticLayout: true,
      // 视图方式由调用方的切换按钮显式决定,不再按容器宽度自动降级为内联:
      // Monaco 默认在宽度 ≤ renderSideBySideInlineBreakpoint(900px)时强制内联,
      // 侧栏永远低于这个阈值,显式选中的并排会一直被吞掉。
      renderSideBySide: viewMode !== 'unified',
      useInlineViewWhenSpaceIsLimited: false,
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
    }),
    [options, viewMode],
  );

  return (
    <div className={cn('relative h-full', className)}>
      <div className={cn('h-full', !diffReady && 'invisible')}>
        <DiffEditor
          original={oldContent}
          modified={newContent}
          language={resolveMonacoLanguage(filePath)}
          theme={themeName}
          beforeMount={defineMonacoTheme}
          onMount={handleMount}
          loading={<MonacoLoading label="Diff 加载中" />}
          options={diffOptions}
        />
      </div>
      {!diffReady && (
        <div className="absolute inset-0">
          <MonacoLoading label="Diff 计算中" />
        </div>
      )}
    </div>
  );
}
