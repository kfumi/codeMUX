import { useDaemonConnectionStore } from '../stores/daemonConnectionStore';
import type { HostForm } from './host/host-form';

/**
 * 代码编辑器按宿主形态取能力。
 *
 * Monaco 官方明确不支持移动浏览器(monaco-editor README:移动浏览器与移动 web 框架
 * 均不支持),所以移动形态继续用 highlight.js 的只读视图。这不是代码分叉 ——
 * host-form.ts 的原则就是「差异只在能力取舍与布局」,这里只是一个能力判定,两条
 * 路径共用调用点(见 components/preview/FileView.tsx)。
 *
 * `browser`(PC 浏览器)拿完整的 Monaco:它是真 Chrome,没有移动端的限制。
 */
export function supportsRichCodeEditor(hostForm: HostForm): boolean {
  return hostForm !== 'mobile';
}

export function useSupportsRichCodeEditor(): boolean {
  return useDaemonConnectionStore((state) => supportsRichCodeEditor(state.hostForm));
}
