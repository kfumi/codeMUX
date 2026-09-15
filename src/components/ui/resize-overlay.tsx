import { createPortal } from 'react-dom';

interface ResizeOverlayProps {
  active: boolean;
  cursor?: string;
}

/**
 * 面板拖拽期间的全窗口透明遮罩。
 *
 * 内置浏览器是 Electron `<webview>`(独立 guest 进程),当指针移到已加载的
 * 网页上时,宿主 `document` 收不到 `mousemove`/`mouseup` —— 分割线拖拽会
 * 「松手不释放」,只能再点一下鼠标才停。遮罩盖在 webview 之上接管指针事件,
 * 保证拖拽全程的事件都落在宿主文档里,`mouseup` 必定触发。
 */
export function ResizeOverlay({ active, cursor = 'col-resize' }: ResizeOverlayProps) {
  if (!active || typeof document === 'undefined') return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="panel-resize-overlay"
      className="fixed inset-0 z-[200]"
      style={{ cursor }}
    />,
    document.body,
  );
}
