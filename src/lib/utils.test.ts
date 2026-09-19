// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';

/**
 * `cn` 是 twMerge(clsx(...))：它必须知道 codeMUX 的自定义字号 token 属于 font-size，
 * 否则 `text-ui-compact text-muted-foreground` 这类组合里的字号会被当成「文字颜色」
 * 的同类冲突而丢掉，文本悄悄回落到继承字号（曾经真的发生过：行内小字号全部失效）。
 */
describe('cn', () => {
  it('自定义字号 token 不会被同串里的文字颜色吃掉', () => {
    expect(cn('text-ui-compact text-muted-foreground')).toContain('text-ui-compact');
    expect(cn('text-ui-body text-muted-foreground')).toContain('text-ui-body');
    expect(cn('font-mono text-ui-meta font-normal text-muted-foreground')).toContain('text-ui-meta');
    expect(cn('text-ui-caption text-foreground')).toContain('text-ui-caption');
    expect(cn('text-code text-muted-foreground')).toContain('text-code');
  });

  it('字号之间仍然互相覆盖（后者胜）', () => {
    expect(cn('text-ui-compact text-ui-meta')).toBe('text-ui-meta');
    expect(cn('text-sm text-ui-body')).toBe('text-ui-body');
    expect(cn('text-ui-body text-sm')).toBe('text-sm');
  });

  it('内置字号与颜色的常规覆盖不受影响', () => {
    expect(cn('text-sm text-muted-foreground')).toBe('text-sm text-muted-foreground');
    expect(cn('text-muted-foreground text-foreground')).toBe('text-foreground');
  });
});
