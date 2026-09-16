import { Suspense, lazy } from 'react';

import { useSupportsRichCodeEditor } from '../../lib/monacoHost';
import { cn } from '../../lib/utils';
import { MonacoLoading } from './MonacoLoading';

const MonacoCodeView = lazy(() => import('./MonacoCodeView'));

export interface CodeEditorSurfaceProps {
  value: string;
  onChange: (value: string) => void;
  /** 编辑器语言 id(如 `json`)。缺省时 Monaco 按 filePath 推导,这里没有路径。 */
  language?: string;
  /** 高度,默认 260px(与旧的内联编辑器一致)。 */
  height?: string | number;
  wordWrap?: 'on' | 'off';
  ariaLabel?: string;
  className?: string;
}

/**
 * 可编辑的代码/配置输入框,按宿主形态取能力:
 * - 桌面与 PC 浏览器:Monaco(带补全、括号匹配、结构高亮);
 * - 移动浏览器:普通 textarea(Monaco 官方不支持移动端)。
 *
 * 两条路径共用同一个调用点,调用方不做宿主判断 —— 见 lib/monacoHost.ts。
 */
export function CodeEditorSurface({
  value,
  onChange,
  language,
  height = 260,
  wordWrap = 'on',
  ariaLabel,
  className,
}: CodeEditorSurfaceProps) {
  const richEditor = useSupportsRichCodeEditor();

  // 移动形态的真实编辑视图( textarea);桌面加载期占位由 MonacoLoading 承担。
  if (!richEditor) {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label={ariaLabel}
        style={{ height }}
        className={cn(
          'w-full resize-y bg-transparent p-3 font-mono text-code leading-relaxed outline-none',
          className,
        )}
      />
    );
  }

  return (
    <div data-testid="monaco-code-surface" style={{ height }} className="min-h-0">
      <Suspense fallback={<MonacoLoading />}>
        <MonacoCodeView
          value={value}
          readOnly={false}
          onChange={onChange}
          language={language}
          height="100%"
          wordWrap={wordWrap}
        />
      </Suspense>
    </div>
  );
}
