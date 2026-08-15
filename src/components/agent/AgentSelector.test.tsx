// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentSelector } from './AgentSelector';

describe('AgentSelector', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = '';
  });

  afterAll(() => {
    document.body.style.pointerEvents = '';
  });

  it('does not lock the rest of the app when the menu is open', () => {
    const onOutside = vi.fn();
    render(
      <>
        <AgentSelector value="claude_code" onChange={() => {}} />
        <button type="button" onClick={onOutside}>
          outside action
        </button>
      </>,
    );

    const trigger = screen.getByRole('button', { name: 'Claude Code' });
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.click(trigger);

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Codex/ })).toBeTruthy();
    expect(trigger.textContent).not.toContain('Claude Code');
    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'outside action' }));
    expect(onOutside).toHaveBeenCalled();
  });

  it('does not open the menu when disabled', () => {
    render(<AgentSelector value="claude_code" onChange={() => {}} disabled />);

    const trigger = screen.getByRole('button', { name: 'Claude Code' });
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.click(trigger);

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
