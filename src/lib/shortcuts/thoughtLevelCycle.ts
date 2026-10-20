/**
 * 「切换思考强度」（`Mod+T`）的活跃处理器。
 *
 * 与 `composerFocus` 同理：切档是命令式副作用，用模块级注册而不是 store ——
 * 敲一次快捷键不该引起任何渲染。
 *
 * 只有会话发送框注册（`AgentPanel` 的会话态与 `NewSessionPanel` 的草稿态，
 * 二者互斥）。原因有两条：
 * - 档位阶梯是**按当前模型收窄**的，只有发送框知道该循环哪几档；
 * - 工单任务与自定化的编辑对话框仍用独立下拉，不该被这条全局命令碰到。
 *
 * 所以没注册时（例如停在设置页、或当前模型只有一个档位）命令是空操作。
 */
type ThoughtLevelCycleHandler = () => void;

let activeHandler: ThoughtLevelCycleHandler | null = null;

/** 返回取消注册的函数，供发送框卸载或切模型时调用。 */
export function registerThoughtLevelCycle(handler: ThoughtLevelCycleHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/** 切到下一档；当前没有注册的发送框时返回 `false`。 */
export function cycleActiveThoughtLevel(): boolean {
  if (!activeHandler) return false;
  activeHandler();
  return true;
}
