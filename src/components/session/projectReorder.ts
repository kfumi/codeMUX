export type ProjectDropIndicator = 'before' | 'after';

/** 把 id 移到 targetIndex（0..n-1）；越界夹取，顺序不变时返回原数组。 */
export function moveProjectToIndex(ids: string[], id: string, targetIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, targetIndex));
  if (to === from) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** dnd-kit onDragEnd → 新顺序；没落在有效目标上时原样返回。 */
export function reorderFromDragEnd(
  ids: string[],
  activeId: string,
  overId: string | null,
): string[] {
  if (!overId || activeId === overId) return ids;
  const to = ids.indexOf(overId);
  if (to < 0) return ids;
  return moveProjectToIndex(ids, activeId, to);
}

/**
 * 落点线位置：被拖项在目标项下方时插到目标之前，反之插到目标之后。
 * 被拖项自身不画线；没有有效 active 时也不画。
 */
export function resolveProjectDropPosition(
  isOver: boolean,
  isDragging: boolean,
  activeIndex: number,
  index: number,
): ProjectDropIndicator | null {
  if (!isOver || isDragging || activeIndex < 0) return null;
  return activeIndex > index ? 'before' : 'after';
}
