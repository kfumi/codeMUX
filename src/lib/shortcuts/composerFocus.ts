/**
 * 当前活跃 composer 输入框的聚焦入口。
 *
 * composer 的 imperative handle（`focus`/`setText`/`send`）只存在于 `CodeMuxComposer`
 * 的组件局部 ref 里（`CodeMuxLexicalComposerInput.tsx` 暴露 handle，但 ref 没有出口），
 * 仓库里没有任何全局注册表，所以「聚焦输入框」这条命令需要一个。
 *
 * 用模块级注册而不是 store：聚焦是命令式副作用，不该引起任何渲染。
 */
type ComposerFocusHandler = () => void;

let activeHandler: ComposerFocusHandler | null = null;

/** 返回取消注册的函数，供 composer 卸载时调用。 */
export function registerComposerFocus(handler: ComposerFocusHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/** 焦点给活跃 composer；当前没有挂载的输入框时返回 `false`。 */
export function focusActiveComposer(): boolean {
  if (!activeHandler) return false;
  activeHandler();
  return true;
}
