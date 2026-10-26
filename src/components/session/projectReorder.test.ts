import { describe, expect, it } from 'vitest';

import {
  moveProjectToIndex,
  reorderFromDragEnd,
  resolveProjectDropPosition,
} from './projectReorder';

describe('moveProjectToIndex', () => {
  it('moves a project up and down by index', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveProjectToIndex(ids, 'c', 1)).toEqual(['a', 'c', 'b']);
    expect(moveProjectToIndex(ids, 'a', 1)).toEqual(['b', 'a', 'c']);
  });

  it('clamps out-of-range targets and ignores unknown ids', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveProjectToIndex(ids, 'a', -5)).toEqual(['a', 'b', 'c']);
    expect(moveProjectToIndex(ids, 'c', 99)).toEqual(['a', 'b', 'c']);
    expect(moveProjectToIndex(ids, 'missing', 1)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same array reference when nothing moves', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveProjectToIndex(ids, 'b', 1)).toBe(ids);
  });
});

describe('reorderFromDragEnd', () => {
  it('moves the active project to the over project position', () => {
    expect(reorderFromDragEnd(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(reorderFromDragEnd(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('keeps the order when the drop target is missing or unchanged', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderFromDragEnd(ids, 'a', null)).toBe(ids);
    expect(reorderFromDragEnd(ids, 'a', 'a')).toBe(ids);
    expect(reorderFromDragEnd(ids, 'missing', 'a')).toBe(ids);
  });
});

describe('resolveProjectDropPosition', () => {
  it('draws the line before the target when dragging upwards', () => {
    expect(resolveProjectDropPosition(true, false, 3, 1)).toBe('before');
  });

  it('draws the line after the target when dragging downwards', () => {
    expect(resolveProjectDropPosition(true, false, 1, 3)).toBe('after');
  });

  it('skips the active row and idle states', () => {
    expect(resolveProjectDropPosition(true, true, 1, 3)).toBeNull();
    expect(resolveProjectDropPosition(false, false, 1, 3)).toBeNull();
    expect(resolveProjectDropPosition(true, false, -1, 3)).toBeNull();
  });
});
