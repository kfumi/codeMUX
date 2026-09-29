import { Brain } from 'lucide-react';

import {
  REASONING_EFFORT_OPTIONS,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortLabel,
  type ReasoningEffortOption,
} from '../../lib/reasoningEffort';
import { cn } from '../../lib/utils';
import type { ReasoningEffort } from '../../types/session';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

export interface ReasoningEffortSelectorProps {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  compact?: boolean;
  /**
   * Levels this model offers, narrowed to the currently selected model.
   * Omit to show the full vocabulary.
   *
   * When `value` is not among these, the selector shows the nearest supported
   * level instead of a value the model cannot honour — otherwise the trigger
   * would advertise a level the session will silently clamp away.
   */
  options?: readonly ReasoningEffortOption[];
}

export function ReasoningEffortSelector({
  value,
  onChange,
  disabled,
  compact,
  options,
}: ReasoningEffortSelectorProps) {
  const available = options?.length ? options : REASONING_EFFORT_OPTIONS;
  const selected = coerceToOptions(normalizeReasoningEffort(value), available);
  const selectedLabel = reasoningEffortLabel(selected);

  return (
    <Select
      value={selected}
      onValueChange={(next) => {
        if (isReasoningEffort(next)) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="思考强度"
        className={cn(
          'w-auto shrink-0 cursor-pointer gap-1.5 border-0 bg-transparent px-2.5 shadow-none outline-none ring-0 ring-offset-0',
          'focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
          'data-[state=open]:border-0 data-[state=open]:ring-0',
          'hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
          compact ? 'h-8' : 'h-9',
        )}
      >
        <SelectValue>
          <span className="flex items-center gap-2">
            <Brain className="h-4 w-4 shrink-0" />
            {!compact && (
              <span className="@max-[480px]/composer-bar:hidden">{selectedLabel}</span>
            )}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        side="top"
        align="end"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {available.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Snap a stored level onto the nearest level the model actually offers,
 * searching downward first then upward — the same rule pi applies in
 * `clampThinkingLevel`, so the label matches what the runtime will do.
 */
function coerceToOptions(
  value: ReasoningEffort,
  options: readonly ReasoningEffortOption[],
): ReasoningEffort {
  if (options.some((option) => option.id === value)) return value;
  const index = REASONING_EFFORT_OPTIONS.findIndex((option) => option.id === value);
  for (let i = index; i < REASONING_EFFORT_OPTIONS.length; i += 1) {
    const candidate = REASONING_EFFORT_OPTIONS[i];
    if (options.some((option) => option.id === candidate.id)) return candidate.id;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = REASONING_EFFORT_OPTIONS[i];
    if (options.some((option) => option.id === candidate.id)) return candidate.id;
  }
  return options[0].id;
}
