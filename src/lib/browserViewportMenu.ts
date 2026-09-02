import type { BrowserViewportMode } from './browserViewport';
import { BROWSER_VIEWPORT_OPTIONS } from './browserViewport';

export async function popupViewportMenu(
  selected: BrowserViewportMode,
  position: { x: number; y: number },
): Promise<BrowserViewportMode | null> {
  const { Menu } = await import('@tauri-apps/api/menu');
  const { LogicalPosition } = await import('@tauri-apps/api/dpi');

  let chosen: BrowserViewportMode | null = null;
  const menu = await Menu.new({
    items: BROWSER_VIEWPORT_OPTIONS.map((option) => ({
      id: String(option.value),
      text: option.label,
      checked: option.value === selected,
      action: () => {
        chosen = option.value;
      },
    })),
  });
  await menu.popup(new LogicalPosition(position.x, position.y));
  return chosen;
}
