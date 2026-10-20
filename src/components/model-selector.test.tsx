// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ModelSelector, hoveredStopAt } from './model-selector';

// cmdk measures its list and Radix positions its popper; neither exists in
// jsdom, and both are irrelevant to what these tests assert.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(cleanup);

const models = [
  { id: 'a', name: 'Model A', efforts: true },
  { id: 'b', name: 'Model B', efforts: true },
];

/** The canonical ladder, so index 3 is 高 and index 5 is 最高. */
const LEVELS = [
  { id: 'none', name: '关闭' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
  { id: 'xhigh', name: '极高' },
  { id: 'max', name: '最高' },
];

function renderOpen({
  onValueChange = vi.fn(),
  onEffortChange = vi.fn(),
  onOpenChange = vi.fn(),
  effort = 'high',
  effortProps = {},
  selectorModels = models,
}: {
  onValueChange?: (value: string) => void;
  onEffortChange?: (effort: string) => void;
  onOpenChange?: (open: boolean) => void;
  effort?: string;
  effortProps?: Record<string, unknown>;
  selectorModels?: typeof models;
} = {}) {
  const view = render(
    <ModelSelector.Root
      models={selectorModels}
      defaultValue="a"
      defaultEffort={effort}
      defaultOpen
      onValueChange={onValueChange}
      onEffortChange={onEffortChange}
      onOpenChange={onOpenChange}
    >
      <ModelSelector.Trigger />
      <ModelSelector.Content searchable>
        <ModelSelector.Search />
        <ModelSelector.List />
        <ModelSelector.Effort {...effortProps} />
      </ModelSelector.Content>
    </ModelSelector.Root>,
  );
  return { ...view, onValueChange, onEffortChange, onOpenChange };
}

const getSlider = () =>
  screen.getByRole('slider', { name: '思考强度' }) as HTMLInputElement;

/**
 * The effort row lives in a Radix portal, so it is outside `render`'s
 * container. Scoped lookups matter here: the trigger renders
 * `ModelSelector.Value`, which shows the current level too — an unscoped
 * `getByText('高')` matches both.
 */
const getEffortRow = () => {
  const row = document.querySelector('[data-slot="model-selector-effort"]');
  if (!row) throw new Error('effort row not rendered');
  return within(row as HTMLElement);
};

describe('ModelSelector.Effort slider', () => {
  it('reflects the current level and reports it as the value text', () => {
    renderOpen();

    const slider = getSlider();
    expect(slider.value).toBe('3');
    expect(slider.getAttribute('aria-valuetext')).toBe('高');
    expect(getEffortRow().getByText('思考强度')).toBeTruthy();
    expect(getEffortRow().getByText('高')).toBeTruthy();
  });

  it('commits a new level through the range input', () => {
    const { onEffortChange } = renderOpen();

    fireEvent.change(getSlider(), { target: { value: '5' } });

    expect(onEffortChange).toHaveBeenCalledWith('max');
  });

  it('marks the fill as max only at the top level', () => {
    // Drives both the gradient reveal and the bubble flow, so it must not fire
    // at any other level.
    const maxFill = () => document.querySelector('.effort-slider-fill');

    renderOpen({ effort: 'max' });
    expect(maxFill()?.getAttribute('data-max')).toBe('true');

    cleanup();
    renderOpen({ effort: 'low' });
    expect(maxFill()?.getAttribute('data-max')).toBe('false');
  });

  // The three tests below guard the cmdk boundary. cmdk's Command root handles
  // these keys in its own React onKeyDown, and it sits above the slider in the
  // tree, so anything the slider fails to swallow reaches it.
  it('does not let Enter on the slider select a model or close the popover', () => {
    const { onValueChange, onOpenChange } = renderOpen();

    fireEvent.keyDown(getSlider(), { key: 'Enter' });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(getSlider()).toBeTruthy();
  });

  it('does not let arrow keys move the cmdk list cursor', () => {
    renderOpen();

    const items = screen.getAllByRole('option');
    // ModelSelector.Content passes `defaultValue={value}`, so the current model
    // starts out as cmdk's selected item — the very item Enter would re-select.
    expect(items[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(getSlider(), { key: 'ArrowDown' });

    expect(items[0]?.getAttribute('aria-selected')).toBe('true');
    expect(items[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('leaves Escape alone so the popover can still be dismissed', () => {
    const { onOpenChange } = renderOpen();

    fireEvent.keyDown(getSlider(), { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('narrows the ladder to the levels it is given', () => {
    // A model offering only 关闭 / 低 / 高: 高 is the last of the three, so the
    // slider's range shrinks with it.
    renderOpen({
      effort: 'high',
      effortProps: { options: [LEVELS[0], LEVELS[1], LEVELS[3]] },
    });

    const slider = getSlider();
    expect(slider.getAttribute('max')).toBe('2');
    expect(slider.value).toBe('2');
    expect(slider.getAttribute('aria-valuetext')).toBe('高');
  });

  it('snaps a level the narrowed ladder does not offer', () => {
    // The session is on 高 but the model only offers up to 中; showing 高 would
    // advertise a level the runtime will clamp away.
    renderOpen({
      effort: 'high',
      effortProps: { options: LEVELS.slice(0, 3) },
    });

    expect(getSlider().getAttribute('aria-valuetext')).toBe('中');
  });

  it('resolves the current level against the ladder on the model itself', () => {
    // The path AgentModelSelector uses: the ladder arrives as the model's
    // `efforts`, not via the `options` prop. ModelSelector resolves the current
    // level against it, so the thumb lands on the session's level rather than
    // falling back to the bottom of the range.
    renderOpen({
      effort: 'high',
      selectorModels: [
        { id: 'a', name: 'Model A', efforts: [LEVELS[0], LEVELS[1], LEVELS[3]] },
      ],
    });

    const slider = getSlider();
    expect(slider.getAttribute('max')).toBe('2');
    expect(slider.value).toBe('2');
    expect(slider.getAttribute('aria-valuetext')).toBe('高');
  });

  it('reports the level instead of a slider when there is only one', () => {
    renderOpen({ effort: 'none', effortProps: { options: LEVELS.slice(0, 1) } });

    expect(screen.queryByRole('slider')).toBeNull();
    expect(getEffortRow().getByText('思考强度')).toBeTruthy();
    expect(getEffortRow().getByText('关闭')).toBeTruthy();
  });

  it('renders nothing when the model has no configurable levels', () => {
    renderOpen({ selectorModels: [{ id: 'a', name: 'Model A' }] });

    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByText('思考强度')).toBeNull();
  });
});

describe('hoveredStopAt', () => {
  const rect = { left: 0, width: 300 };
  // Thumb radius 14 at both ends, so with 3 stops the centres are 14 / 150 / 286.
  const centres = [14, 150, 286];

  it('resolves a stop when the pointer is on its centre', () => {
    centres.forEach((clientX, index) => {
      expect(hoveredStopAt(clientX, rect, centres.length)).toBe(index);
    });
  });

  it('returns null between stops, where no centre is within reach', () => {
    expect(hoveredStopAt(80, rect, 3)).toBeNull();
    expect(hoveredStopAt(220, rect, 3)).toBeNull();
  });

  it('returns null outside the track', () => {
    expect(hoveredStopAt(-100, rect, 3)).toBeNull();
    expect(hoveredStopAt(1000, rect, 3)).toBeNull();
  });

  it('returns null when there is nothing to hover', () => {
    expect(hoveredStopAt(14, rect, 1)).toBeNull();
    // Degenerate layout: the thumb fills the whole track, so there is no range.
    expect(hoveredStopAt(14, { left: 0, width: 28 }, 3)).toBeNull();
  });
});
