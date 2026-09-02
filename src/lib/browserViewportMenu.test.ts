import { beforeEach, describe, expect, it, vi } from 'vitest';

import { popupViewportMenu } from './browserViewportMenu';

const popupMock = vi.fn();
const menuNewMock = vi.fn();

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: (...args: unknown[]) => menuNewMock(...args),
  },
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
}));

describe('popupViewportMenu', () => {
  beforeEach(() => {
    popupMock.mockReset();
    menuNewMock.mockReset();
  });

  it('pops a native check menu at the trigger and returns the chosen scale', async () => {
    menuNewMock.mockImplementation(async ({ items }: { items: Array<{ id: string; checked: boolean; action: () => void }> }) => {
      expect(items.map((item) => item.id)).toEqual(['fit', '50', '75', '100', '125', '150', '200']);
      expect(items[0]?.checked).toBe(true);
      popupMock.mockImplementation(async () => {
        items[1]?.action();
      });
      return { popup: popupMock };
    });

    await expect(popupViewportMenu('fit', { x: 40, y: 80 })).resolves.toBe(50);
    expect(popupMock).toHaveBeenCalledWith(expect.objectContaining({ x: 40, y: 80 }));
  });

  it('returns null when the native menu is dismissed', async () => {
    menuNewMock.mockResolvedValue({ popup: vi.fn().mockResolvedValue(undefined) });
    await expect(popupViewportMenu('fit', { x: 0, y: 0 })).resolves.toBeNull();
  });
});
