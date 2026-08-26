import { describe, expect, it } from 'vitest';

import type { FileTreeNode } from '../../lib/tauri';
import { hasLoadedChildren, needsLazyLoad } from './projectExplorerTree';

function dir(name: string, children?: FileTreeNode[] | null): FileTreeNode {
  return {
    name,
    path: `/project/${name}`,
    is_dir: true,
    children: children === null ? undefined : children,
  };
}

function file(name: string): FileTreeNode {
  return {
    name,
    path: `/project/${name}`,
    is_dir: false,
  };
}

describe('projectExplorerTree', () => {
  it('treats directories without children as not loaded', () => {
    expect(hasLoadedChildren(dir('specs'))).toBe(false);
    expect(needsLazyLoad(dir('specs'))).toBe(true);
  });

  it('treats directories with an empty children array as loaded', () => {
    expect(hasLoadedChildren(dir('empty', []))).toBe(true);
    expect(needsLazyLoad(dir('empty', []))).toBe(false);
  });

  it('does not lazy-load files', () => {
    expect(hasLoadedChildren(file('README.md'))).toBe(true);
    expect(needsLazyLoad(file('README.md'))).toBe(false);
  });
});
