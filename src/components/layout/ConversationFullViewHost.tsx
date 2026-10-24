import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { cn } from '../../lib/utils';

const GEOMETRY_PROPERTIES = ['left', 'top', 'width', 'height'] as const;

/**
 * 完整视图的对话宿主（工单 side-panel-full-view/02）：对话列的常驻包装层。
 * 只改变定位方式，不移动 DOM、不重新挂载 —— 草稿、光标、滚动位置、上传中的
 * 附件因此只有一份，对话标签与面板标签之间来回切换全部保留。
 *
 * - 普通形态：普通 flex 容器，布局与宿主不存在时一致；
 * - 对话 surface 激活且拿到面板内容区（slot）元素：`fixed` 盖住 slot 的窗口投影，
 *   几何值由实测 slot rect + ResizeObserver 写进 style —— 这是 DOM 布局投影，
 *   不进 React state，测量重渲染不会波及对话树。
 *
 * 层叠：宿主 z 序高于展开面板（z-30），但几何上只覆盖 slot（tab 栏下方），
 * 面板头与 tab 栏保持可见可点。
 */
export function ConversationFullViewHost({
  active,
  slotElement,
  children,
}: {
  /** 对话 surface 是否激活（面板开 && 展开 && conversationActive，由宿主外的布局层派生）。 */
  active: boolean;
  /** 侧面板内容区（tab 栏下方）元素；未就绪时宿主保持普通布局，不浮动。 */
  slotElement: HTMLDivElement | null;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const floating = active && slotElement !== null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!floating || !slotElement) {
      GEOMETRY_PROPERTIES.forEach((property) => host?.style.removeProperty(property));
      return;
    }
    const apply = () => {
      if (!hostRef.current) return;
      const rect = slotElement.getBoundingClientRect();
      hostRef.current.style.left = `${rect.left}px`;
      hostRef.current.style.top = `${rect.top}px`;
      hostRef.current.style.width = `${rect.width}px`;
      hostRef.current.style.height = `${rect.height}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(slotElement);
    window.addEventListener('resize', apply);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', apply);
      GEOMETRY_PROPERTIES.forEach((property) => host?.style.removeProperty(property));
    };
  }, [floating, slotElement]);

  return (
    <div
      ref={hostRef}
      data-conversation-full-view-host={floating ? 'active' : 'idle'}
      className={cn(
        'relative flex min-h-0 flex-1 flex-col',
        floating && 'fixed z-40 overflow-hidden',
      )}
    >
      {children}
    </div>
  );
}
