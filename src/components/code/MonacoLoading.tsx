import { Loader2 } from 'lucide-react';

/**
 * Monaco 就绪前(懒加载 chunk + AMD 运行时拉取)的统一占位。
 *
 * 刻意不拿 highlight.js 渲染的内容当占位:两套渲染器先后出同一份内容,切换时
 * 会明显闪一下;加载中只给一个安静的 spinner,Monaco 就绪后一次性呈现最终形态。
 * Monaco 资产本地且只加载一次,占位只出现在首次打开。
 */
export function MonacoLoading({ label = '编辑器加载中' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full w-full items-center justify-center gap-2 text-ui-compact text-muted-foreground/55"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
