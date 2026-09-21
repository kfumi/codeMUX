// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog, DialogContent } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * 弹层在模态 Dialog 里的可交互性。
 *
 * Radix 的模态 Dialog 会把 `document.body` 设成 `pointer-events: none`(只给它自己
 * 那个 layer 节点重新开启),并把外部内容标记 aria-hidden。弹层(下拉/浮层)portal 到
 * body 后不是该 layer 节点,于是继承到 `none`:菜单挂上了却点不动,点击还会被当成
 * 「外部交互」——工作任务的编辑对话框里踩到过(智能体下拉、模型下拉点了没反应)。
 *
 * 两条修复各自有一条回归守卫:
 * 1. 弹层内容自带 `pointer-events-auto`(Radix 给自家模态 Select 的做法);
 * 2. 承载这些选择器的对话框改用非模态(`modal={false}`),从根上不产生 body 级
 *    指针屏蔽与焦点抢占——见 TaskEditorDialog。
 *
 * jsdom 不跑 Tailwind、也不完整模拟指针事件,所以这里只守样式契约;交互行为由
 * 真机验证(在对话框里点开智能体下拉)。
 */
describe('弹层可交互性契约', () => {
  it('下拉内容自带 pointer-events-auto', async () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>智能体</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Claude Code</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '智能体' }), {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() =>
      expect(document.querySelector('[role="menu"]')?.getAttribute('data-state')).toBe('open'),
    );
    expect(document.querySelector('[role="menu"]')?.className).toContain('pointer-events-auto');
  });

  it('浮层内容自带 pointer-events-auto', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>模型</PopoverTrigger>
        <PopoverContent>Deepseek Flash</PopoverContent>
      </Popover>,
    );

    expect(screen.getByText('Deepseek Flash').className).toContain('pointer-events-auto');
  });

  it('非模态对话框不再把 body 设成 pointer-events: none', () => {
    render(
      <Dialog open modal={false}>
        <DialogContent>
          <Popover defaultOpen>
            <PopoverTrigger>模型</PopoverTrigger>
            <PopoverContent>Deepseek Flash</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    );

    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('模态对话框确实会屏蔽 body 指针事件(对照组,解释上面那条为何必要)', () => {
    render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    expect(document.body.style.pointerEvents).toBe('none');
  });
});
