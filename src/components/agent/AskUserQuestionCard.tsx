import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Info } from 'lucide-react';
import { agentApi } from '../../lib/tauri';
import { createLogger, serializeError } from '../../lib/logger';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { cn } from '../../lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import type { AgentPermissionConfig, AgentPlanMode } from '../../lib/agentPermissions';

const logger = createLogger('AskUserQuestionCard');

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; value?: unknown }>;
  multiSelect?: boolean;
  multiple?: boolean;
  allowOther?: boolean;
  presentation?: 'plan-approval';
  inputPlaceholder?: string;
}

interface AskUserQuestionCardProps {
  sessionId: string;
  toolUseId: string;
  questions: AskUserQuestion[];
  submitted?: boolean;
  expired?: boolean;
  resultContent?: string;
  variant?: 'message' | 'composer';
  compact?: boolean;
  onSubmitted?: () => void;
}

const OTHER_IDX = -1;

export function isMultiSelectQuestion(question: Pick<AskUserQuestion, 'question' | 'header' | 'multiSelect' | 'multiple'>): boolean {
  return question.multiSelect === true || question.multiple === true;
}

function normalizeAnswerValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeAnswerValues(item));
  }
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

/** Try to extract answers from tool_result content */
function parseResultAnswers(resultContent: string, questions: AskUserQuestion[]): string[][] {
  if (resultContent.trim() === '__cancelled__') {
    return questions.map(() => ['已取消']);
  }

  const normalizeByQuestion = (values: unknown[]): string[][] => {
    if (
      questions.length === 1
      && isMultiSelectQuestion(questions[0])
      && values.length > 0
      && values.every((value) => !Array.isArray(value))
    ) {
      return [normalizeAnswerValues(values)];
    }
    return questions.map((_, index) => normalizeAnswerValues(values[index]));
  };

  try {
    const parsed = JSON.parse(resultContent);
    if (Array.isArray(parsed)) return normalizeByQuestion(parsed);
    if (Array.isArray(parsed?.answers)) return normalizeByQuestion(parsed.answers);
    if (parsed?.answers && typeof parsed.answers === 'object') {
      return normalizeByQuestion(Object.values(parsed.answers));
    }
  } catch {
    // not JSON
  }

  const answers: string[][] = [];
  for (const q of questions) {
    const re = new RegExp(`"${q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*=\\s*"([^"]*)"`, 'i');
    const match = resultContent.match(re);
    answers.push(match?.[1] ? [match[1]] : []);
  }

  return answers.some((answer) => answer.length > 0) ? answers : [];
}

function getDisplayAnswerValues(question: AskUserQuestion, answers: string[]): string[] {
  if (isMultiSelectQuestion(question) && answers.length === 1 && /^\d+(?:\+\d+)+$/.test(answers[0])) {
    const labels = answers[0].split('+').map((value) => question.options[Number(value) - 1]?.label);
    if (labels.every((label): label is string => Boolean(label))) return labels;
  }
  return answers;
}

function getSelectedOptionValue(question: AskUserQuestion, optionIndex: number): unknown {
  const option = question.options[optionIndex];
  return option.value ?? option.label;
}

function getSelectedOptionLabel(question: AskUserQuestion, optionIndex: number): string {
  return question.options[optionIndex].label;
}

function findPermissionElevationAnswer(answers: unknown[]): {
  permissionConfig: AgentPermissionConfig;
  planMode: AgentPlanMode;
} | null {
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') continue;
    const raw = answer as Record<string, unknown>;
    if (raw.action !== 'allow_and_elevate_permissions') continue;
    if (!raw.permissionConfig || typeof raw.permissionConfig !== 'object') continue;
    const planMode = raw.planMode === 'on' ? 'on' : 'off';
    return {
      permissionConfig: raw.permissionConfig as AgentPermissionConfig,
      planMode,
    };
  }

  return null;
}

export function AskUserQuestionCard({
  sessionId,
  toolUseId,
  questions,
  submitted: propSubmitted,
  expired = false,
  resultContent,
  variant = 'message',
  compact = false,
  onSubmitted,
}: AskUserQuestionCardProps) {
  const parsedAnswers = propSubmitted && resultContent ? parseResultAnswers(resultContent, questions) : [];

  const [isExpanded, setIsExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState('0');
  const [submittedIndex, setSubmittedIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, Set<number>>>(() => {
    const init: Record<number, Set<number>> = {};
    questions.forEach((_, i) => {
      init[i] = new Set();
    });
    return init;
  });
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(propSubmitted || false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<string[][]>(
    expired ? questions.map(() => ['已超时']) : parsedAnswers,
  );
  const isComposer = variant === 'composer';
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const otherInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const showsComposerOtherInput = (question: AskUserQuestion) =>
    question.presentation === 'plan-approval' || question.allowOther !== false;

  // Subscribe to forceStopped so interrupted sessions render as non-interactive cancelled cards.
  const forceStopped = useAgentStore((s) => s.forceStopped[sessionId] ?? false);
  const updateSessionPermissions = useSessionStore((s) => s.updateSessionPermissions);
  useEffect(() => {
    if (forceStopped && !submitted && !propSubmitted) {
      setSubmittedAnswers(questions.map(() => ['已取消']));
      setSubmitted(true);
    }
  }, [forceStopped, propSubmitted, questions, submitted]);

  const hasMultipleQuestions = questions.length > 1;

  const isQuestionAnswered = (i: number) => {
    const selection = selections[i];
    if (selection.size === 0) return false;
    if (selection.has(OTHER_IDX) && !otherTexts[i]?.trim()) return false;
    return true;
  };

  const answeredCount = questions.filter((_, i) => isQuestionAnswered(i)).length;
  const allAnswered = questions.every((_, i) => isQuestionAnswered(i));

  const toggleOption = (qIdx: number, oIdx: number) => {
    if (submitted || expired) return;

    setSelections((prev) => {
      const next = { ...prev };
      const question = questions[qIdx];

      if (isMultiSelectQuestion(question)) {
        const set = new Set(prev[qIdx]);
        if (set.has(oIdx)) {
          set.delete(oIdx);
        } else {
          set.add(oIdx);
        }
        next[qIdx] = set;
      } else {
        next[qIdx] = new Set([oIdx]);
      }

      return next;
    });

    if (!isMultiSelectQuestion(questions[qIdx]) && hasMultipleQuestions && qIdx < questions.length - 1 && oIdx !== OTHER_IDX) {
      setTimeout(() => setActiveTab(String(qIdx + 1)), 200);
    }
  };

  const focusOption = (qIdx: number, optionIndex: number) => {
    const optionCount = questions[qIdx]?.options.length ?? 0;
    if (optionCount === 0) return;
    const nextIndex = (optionIndex + optionCount) % optionCount;
    window.requestAnimationFrame(() => optionRefs.current[`${qIdx}:${nextIndex}`]?.focus());
  };

  const focusOtherInputElement = (qIdx: number) => {
    focusOtherInput(qIdx);
    window.requestAnimationFrame(() => otherInputRefs.current[`${qIdx}`]?.focus());
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, qIdx: number, oIdx: number) => {
    const question = questions[qIdx];
    const optionCount = question?.options.length ?? 0;
    if (optionCount === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (isComposer && showsComposerOtherInput(question) && oIdx === optionCount - 1) {
        focusOtherInputElement(qIdx);
      } else {
        focusOption(qIdx, oIdx + 1);
      }
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusOption(qIdx, oIdx - 1);
      return;
    }
    if (event.key === 'Tab') {
      const nextIndex = event.shiftKey ? oIdx - 1 : oIdx + 1;
      if (nextIndex >= 0 && nextIndex < optionCount) {
        event.preventDefault();
        focusOption(qIdx, nextIndex);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleOption(qIdx, oIdx);
    }
  };

  const isOtherSelected = (qIdx: number) => selections[qIdx]?.has(OTHER_IDX);

  const focusOtherInput = (qIdx: number) => {
    if (submitted || expired) return;

    setSelections((prev) => {
      const next = { ...prev };
      const question = questions[qIdx];
      const selection = new Set(prev[qIdx]);
      if (isMultiSelectQuestion(question)) {
        selection.add(OTHER_IDX);
        next[qIdx] = selection;
      } else {
        next[qIdx] = new Set([OTHER_IDX]);
      }
      return next;
    });
  };

  const advanceToNextQuestion = (qIdx: number) => {
    if (!hasMultipleQuestions || qIdx >= questions.length - 1) return;
    setTimeout(() => setActiveTab(String(qIdx + 1)), 200);
  };

  const handleOtherInputKeyDown = (event: KeyboardEvent<HTMLInputElement>, qIdx: number) => {
    if (submitted || expired) return;

    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const lastOptionIndex = questions[qIdx]?.options.length ?? 0;
      if (lastOptionIndex > 0) {
        focusOption(qIdx, lastOptionIndex - 1);
      }
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    event.stopPropagation();

    focusOtherInput(qIdx);

    const question = questions[qIdx];
    if (!isMultiSelectQuestion(question) && otherTexts[qIdx]?.trim()) {
      advanceToNextQuestion(qIdx);
    }
  };

  const handleSubmit = async () => {
    if (expired || !allAnswered || submitting) return;

    setSubmitting(true);

    const answers = questions.map((q, i) => {
      if ((isComposer || q.presentation === 'plan-approval') && selections[i]?.has(OTHER_IDX) && otherTexts[i]?.trim()) {
        return otherTexts[i].trim();
      }
      const selected = Array.from(selections[i]).map((idx) => {
        if (idx === OTHER_IDX) return otherTexts[i]?.trim() || '其他';
        return getSelectedOptionValue(q, idx);
      });

      return isMultiSelectQuestion(q) ? selected : selected[0];
    });

    const displayAnswers = questions.map((q, i) => {
      if ((isComposer || q.presentation === 'plan-approval') && selections[i]?.has(OTHER_IDX) && otherTexts[i]?.trim()) {
        return [otherTexts[i].trim()];
      }
      const selected = Array.from(selections[i]).map((idx) => {
        if (idx === OTHER_IDX) return otherTexts[i]?.trim() || '其他';
        return getSelectedOptionLabel(q, idx);
      });

      return selected;
    });

    try {
      const permissionElevation = findPermissionElevationAnswer(answers);
      if (permissionElevation) {
        await Promise.resolve(
          updateSessionPermissions(
            sessionId,
            permissionElevation.permissionConfig,
            permissionElevation.planMode,
          ),
        ).catch((err) => {
          logger.warn('Failed to persist elevated permissions before tool response', { sessionId }, serializeError(err));
        });
      }
      await agentApi.sendToolResponse(sessionId, toolUseId, answers);
      setSubmittedAnswers(displayAnswers);
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      logger.error('Failed to send tool response', { sessionId, toolUseId }, serializeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (expired || submitting) return;

    setSubmitting(true);

    try {
      await agentApi.sendToolResponse(sessionId, toolUseId, questions.map(() => '__cancelled__'));
      setSubmittedAnswers(questions.map(() => ['已取消']));
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      logger.error('Failed to cancel question', { sessionId, toolUseId }, serializeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderQuestion = (q: AskUserQuestion, qIdx: number, showQuestion = true) => (
    <div>
      {q.presentation === 'plan-approval' && q.header && showQuestion ? (
        <p className="mb-2 inline-flex rounded-md border border-border/35 px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {q.header}
        </p>
      ) : null}
      {showQuestion ? (
        <p className={cn('mb-2 text-sm', isComposer && 'px-1 text-ui-compact font-semibold text-foreground')}>
          {q.question}
        </p>
      ) : null}
      <div className={cn('space-y-1.5', isComposer && 'space-y-0 overflow-hidden rounded-lg border border-border/18 bg-[hsl(var(--surface-3))]/22')}>
        {q.options.map((opt, oIdx) => {
          const selected = selections[qIdx]?.has(oIdx);

          return (
            <button
              key={oIdx}
              type="button"
              ref={(element) => { optionRefs.current[`${qIdx}:${oIdx}`] = element; }}
              onClick={() => toggleOption(qIdx, oIdx)}
              onKeyDown={(event) => handleOptionKeyDown(event, qIdx, oIdx)}
              autoFocus={isComposer && qIdx === 0 && oIdx === 0}
              aria-pressed={selected}
              disabled={expired}
              className={cn(
                'w-full cursor-pointer px-3 py-2 text-left text-sm transition-colors',
                expired && 'cursor-not-allowed opacity-65',
                isComposer ? 'rounded-none border-0' : 'rounded-md border',
                selected
                  ? isComposer
                    ? 'bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                    : 'border-border/55 bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                  : isComposer
                    ? 'border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground'
                    : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'flex shrink-0 items-center justify-center border text-ui-caption font-semibold',
                    isComposer
                    ? cn('h-5 w-5', isMultiSelectQuestion(q) ? 'rounded-none' : 'rounded-full')
                      : isMultiSelectQuestion(q) ? 'h-4 w-4 rounded-none' : 'h-4 w-4 rounded-full',
                    selected
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-muted-foreground/30 text-muted-foreground',
                  )}
                >
                  {isComposer ? oIdx + 1 : selected && <Check className="h-3 w-3 text-background" />}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="min-w-0 max-w-[58%] truncate whitespace-nowrap font-medium" title={opt.label}>{opt.label}</span>
                  {opt.description ? (
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs text-muted-foreground" title={opt.description}>
                      {opt.description}
                    </span>
                  ) : null}
                </span>
              </div>
            </button>
          );
        })}

        {!isComposer && q.presentation !== 'plan-approval' && q.allowOther !== false && (
          <button
            type="button"
            onClick={() => toggleOption(qIdx, OTHER_IDX)}
            disabled={expired}
            className={cn(
              'w-full cursor-pointer border px-3 py-2 text-left text-sm transition-colors',
              expired && 'cursor-not-allowed opacity-65',
              isComposer ? 'rounded-none border-x-0 border-b-0 border-t border-border/12' : 'rounded-md',
                isOtherSelected(qIdx)
                  ? isComposer
                  ? 'border-border/55 bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                  : 'border-border/55 bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                : isComposer ? 'border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground' : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/35',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                  isMultiSelectQuestion(q) ? 'rounded-none' : 'rounded-full'
                } ${
                  isOtherSelected(qIdx) ? 'border-foreground bg-foreground' : 'border-muted-foreground/30'
                }`}
              >
                {isOtherSelected(qIdx) && <Check className="h-3 w-3 text-background" />}
              </span>
              <span className="font-medium">其他</span>
            </div>
          </button>
        )}

        {isComposer && showsComposerOtherInput(q) ? (
          <div
            data-other-input-row
            className={cn(
              'flex min-w-0 items-center gap-2 px-3 py-2 text-sm transition-colors',
              isOtherSelected(qIdx)
                ? 'bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28] text-foreground'
                : 'text-muted-foreground hover:bg-muted/42 hover:text-foreground',
            )}
          >
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center border text-ui-caption font-semibold',
                isMultiSelectQuestion(q) ? 'rounded-none' : 'rounded-full',
                isOtherSelected(qIdx)
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground/30 text-muted-foreground',
              )}
            >
              {q.options.length + 1}
            </span>
            <input
              ref={(element) => { otherInputRefs.current[`${qIdx}`] = element; }}
              type="text"
              value={otherTexts[qIdx] || ''}
              onChange={(event) => setOtherTexts((prev) => ({ ...prev, [qIdx]: event.target.value }))}
              onFocus={() => focusOtherInput(qIdx)}
              onKeyDown={(event) => handleOtherInputKeyDown(event, qIdx)}
              placeholder={q.inputPlaceholder || '输入你的回答...'}
              disabled={expired}
              className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0"
            />
          </div>
        ) : q.presentation === 'plan-approval' ? (
          <div className="border-t border-border/12 p-2">
            <input
              ref={(element) => { otherInputRefs.current[`${qIdx}`] = element; }}
              type="text"
              value={otherTexts[qIdx] || ''}
              onChange={(event) => setOtherTexts((prev) => ({ ...prev, [qIdx]: event.target.value }))}
              onFocus={() => focusOtherInput(qIdx)}
              onKeyDown={(event) => handleOtherInputKeyDown(event, qIdx)}
              placeholder={q.inputPlaceholder || '输入你的回答...'}
              disabled={expired}
              className={cn(
                'w-full rounded-md bg-background/45 px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0',
                isOtherSelected(qIdx) ? 'bg-muted/92 dark:bg-[hsl(var(--muted-foreground))/0.28]' : '',
              )}
            />
          </div>
        ) : !isComposer && isOtherSelected(qIdx) && (
          <div className="pl-3">
            <input
              type="text"
              value={otherTexts[qIdx] || ''}
              onChange={(e) => setOtherTexts((prev) => ({ ...prev, [qIdx]: e.target.value }))}
              onFocus={() => focusOtherInput(qIdx)}
              onKeyDown={(event) => handleOtherInputKeyDown(event, qIdx)}
              placeholder="请输入..."
              autoFocus
              className="w-full rounded-md bg-background/45 px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-0"
            />
          </div>
        )}
      </div>
    </div>
  );

  const headerText = questions[0]?.header || '需要你的输入';
  const progressText = hasMultipleQuestions && !submitted ? ` (${answeredCount}/${questions.length})` : '';

  if (isComposer && submitted) {
    return null;
  }

  if (compact && submitted) {
    const submittedQuestion = questions[submittedIndex] ?? questions[0];
    const submittedQuestionAnswers = submittedQuestion
      ? getDisplayAnswerValues(submittedQuestion, submittedAnswers[submittedIndex] ?? [])
      : [];
    const hasPreviousSubmittedQuestion = submittedIndex > 0;
    const hasNextSubmittedQuestion = submittedIndex < questions.length - 1;

    return (
      <div data-compact="true" className="my-1.5">
        {submittedQuestion ? (
          <div className="rounded-xl bg-muted/45 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-ui-meta font-medium text-primary">
                {submittedQuestion.header || `问题 ${submittedIndex + 1}`}
              </span>
              <span className="shrink-0 rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-ui-caption text-primary/80">
                {isMultiSelectQuestion(submittedQuestion) ? '多选' : '单选'}
              </span>
              <span className="min-w-0 truncate text-ui-meta text-muted-foreground" title={submittedQuestion.question}>
                {submittedQuestion.question}
              </span>
            </div>
            <div className="mt-2 flex min-w-0 items-start gap-2 rounded-lg border border-success/35 bg-success/10 px-2.5 py-2 text-ui-meta text-success">
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex flex-wrap gap-x-2 gap-y-1 font-medium">
                {submittedQuestionAnswers.length > 0
                  ? submittedQuestionAnswers.map((answer, answerIndex) => (
                    <span key={`${answer}-${answerIndex}`} title={answer}>{answer}</span>
                  ))
                  : <span>未作答</span>}
              </div>
            </div>
            {questions.length > 1 ? (
              <div className="mt-3 flex items-center justify-between border-t border-border/35 pt-2">
                <button
                  type="button"
                  onClick={() => setSubmittedIndex((index) => Math.max(0, index - 1))}
                  disabled={!hasPreviousSubmittedQuestion}
                  className="inline-flex items-center gap-1 rounded-md border border-border/45 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  上一个
                </button>
                <span className="text-ui-caption tabular-nums text-muted-foreground/65">
                  {submittedIndex + 1} / {questions.length}
                </span>
                <button
                  type="button"
                  onClick={() => setSubmittedIndex((index) => Math.min(questions.length - 1, index + 1))}
                  disabled={!hasNextSubmittedQuestion}
                  className="inline-flex items-center gap-1 rounded-md border border-border/45 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                >
                  下一个
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (isComposer && !submitted) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-[hsl(var(--surface-2))]/66 p-2">
          {hasMultipleQuestions ? (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="mb-2 w-full min-w-0 max-w-full flex-nowrap justify-start overflow-x-auto overflow-y-hidden overscroll-x-contain">
                {questions.map((q, i) => (
                  <TabsTrigger key={i} value={String(i)} className="relative">
                    {q.header || `问题 ${i + 1}`}
                    {isQuestionAnswered(i) && (
                      <Check className="ml-1 inline h-3 w-3 text-[hsl(var(--success))]" />
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
              {questions.map((q, qIdx) => (
                <TabsContent key={qIdx} value={String(qIdx)}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    {q.header ? <span className="shrink-0 rounded-md border border-border/35 px-2 py-0.5 text-xs font-medium text-muted-foreground">{q.header}</span> : null}
                    <span className="min-w-0 text-ui-compact font-semibold text-foreground">{q.question}</span>
                  </div>
                  {renderQuestion(q, qIdx, false)}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            questions.map((q, qIdx) => (
              <div key={qIdx}>
                <div className="mb-2 flex items-center gap-2 px-1">
                  {q.header ? <span className="shrink-0 rounded-md border border-border/35 px-2 py-0.5 text-xs font-medium text-muted-foreground">{q.header}</span> : null}
                  <span className="min-w-0 text-ui-compact font-semibold text-foreground">{q.question}</span>
                </div>
                {renderQuestion(q, qIdx, false)}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/72">
            <Info className="h-3.5 w-3.5" />
            使用 Tab / 上下键选择，回车或空格选中
          </span>
          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting || expired}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/46 hover:text-foreground disabled:opacity-60"
          >
            {questions[0]?.presentation === 'plan-approval' ? '忽略' : '跳过'}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allAnswered || submitting || expired}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
              allAnswered && !submitting && !expired
                ? 'bg-foreground text-background hover:bg-foreground/90'
                : 'cursor-not-allowed bg-muted/40 text-muted-foreground',
            )}
          >
            {submitting ? '提交中...' : '提交'}
          </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-compact={compact ? 'true' : undefined}
      className={cn(
        compact ? 'my-0 rounded-md border border-border/35 bg-muted/10' : 'my-2 rounded-md border border-primary/20 bg-primary/5',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/40',
          compact && 'gap-1.5 px-2 py-1.5 text-xs',
        )}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded);
        }}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{submitted ? '已回答' : headerText}{progressText}</div>
          {submitted && headerText !== '需要你的输入' ? (
            <div className="truncate text-xs text-muted-foreground/70">{headerText}</div>
          ) : null}
        </div>
        {submitted && <Check className="ml-auto h-4 w-4 text-[hsl(var(--success))]" />}
      </div>

      {isExpanded && (
        <div className={cn('space-y-3 border-t px-3 py-3', compact && 'space-y-1 border-border/25 px-2 py-1.5')}>
          {expired ? (
            <div className="rounded-md border border-[hsl(var(--warning)/0.22)] bg-[hsl(var(--warning)/0.08)] px-3 py-2 text-xs font-medium text-[hsl(var(--warning))]">
              等待用户回复超时，请重新发送消息继续
            </div>
          ) : null}
          {submitted ? (
            <div className={cn('space-y-2', compact && 'space-y-0.5')}>
              {questions.map((q, qIdx) => {
                const answers = getDisplayAnswerValues(q, submittedAnswers[qIdx] ?? []);
                return (
                  <div
                    key={qIdx}
                    className={cn(
                      'rounded-lg border border-border/45 bg-muted/18 px-3 py-2.5',
                      compact && 'rounded-md border-transparent bg-muted/18 px-2 py-1.5',
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <span className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/65 text-ui-meta font-semibold text-muted-foreground',
                        compact && 'h-4 w-4 rounded-sm text-ui-caption',
                      )}>
                        {qIdx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={cn(
                            'text-ui-meta font-semibold text-foreground',
                            compact && 'min-w-0 truncate text-ui-meta',
                          )} title={q.header || q.question}>
                            {q.header || q.question}
                          </span>
                          {isMultiSelectQuestion(q) ? (
                            <span className="rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-ui-caption font-medium text-primary/80">
                              多选
                            </span>
                          ) : null}
                        </div>
                        {!compact ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{q.question}</p> : null}
                      </div>
                    </div>
                    <div className={cn('mt-2 flex flex-wrap gap-1.5 pl-7', compact && 'mt-1 gap-1 pl-6')}>
                      {answers.length > 0 ? answers.map((answer, answerIndex) => (
                        <span
                          key={`${answer}-${answerIndex}`}
                          className={cn(
                            'max-w-full rounded-md border border-success/25 bg-success/8 px-2 py-1 text-ui-meta font-medium text-foreground',
                            compact && 'rounded px-1.5 py-0.5 text-ui-caption',
                          )}
                          title={answer}
                        >
                          {answer}
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground/65">未作答</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : hasMultipleQuestions ? (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full justify-start overflow-x-auto">
                {questions.map((q, i) => (
                  <TabsTrigger key={i} value={String(i)} className="relative">
                    {q.header || `问题 ${i + 1}`}
                    {isQuestionAnswered(i) && (
                      <Check className="ml-1 inline h-3 w-3 text-[hsl(var(--success))]" />
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>

              {questions.map((q, qIdx) => (
                <TabsContent key={qIdx} value={String(qIdx)}>
                  {renderQuestion(q, qIdx)}
                </TabsContent>
              ))}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={submitting || expired}
                  className="flex-1 cursor-pointer rounded-md bg-muted/40 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!allAnswered || submitting || expired}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    allAnswered && !submitting && !expired
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'cursor-not-allowed bg-muted/40 text-muted-foreground'
                  }`}
                >
                  {submitting ? '提交中...' : '提交'}
                </button>
              </div>
            </Tabs>
          ) : (
            <>
              {questions.map((q, qIdx) => renderQuestion(q, qIdx))}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={submitting || expired}
                  className="flex-1 cursor-pointer rounded-md bg-muted/40 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!allAnswered || submitting || expired}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    allAnswered && !submitting && !expired
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'cursor-not-allowed bg-muted/40 text-muted-foreground'
                  }`}
                >
                  {submitting ? '提交中...' : '提交'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
