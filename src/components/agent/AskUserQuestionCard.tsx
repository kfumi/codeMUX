import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { agentApi } from '../../lib/tauri';
import { createLogger, serializeError } from '../../lib/logger';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

const logger = createLogger('AskUserQuestionCard');

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

interface AskUserQuestionCardProps {
  sessionId: string;
  toolUseId: string;
  questions: AskUserQuestion[];
  submitted?: boolean;
  resultContent?: string;
  variant?: 'message' | 'composer';
  onSubmitted?: () => void;
}

const OTHER_IDX = -1;

/** Try to extract answers from tool_result content */
function parseResultAnswers(resultContent: string, questions: AskUserQuestion[]): string[] {
  try {
    const parsed = JSON.parse(resultContent);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed?.answers) return Object.values(parsed.answers).map(String);
  } catch {
    // not JSON
  }

  const answers: string[] = [];
  for (const q of questions) {
    const re = new RegExp(`"${q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*=\\s*"([^"]*)"`, 'i');
    const match = resultContent.match(re);
    answers.push(match?.[1] || '');
  }

  return answers.some((answer) => answer) ? answers : [];
}

export function AskUserQuestionCard({
  sessionId,
  toolUseId,
  questions,
  submitted: propSubmitted,
  resultContent,
  variant = 'message',
  onSubmitted,
}: AskUserQuestionCardProps) {
  const parsedAnswers = propSubmitted && resultContent ? parseResultAnswers(resultContent, questions) : [];

  const [isExpanded, setIsExpanded] = useState(!propSubmitted);
  const [activeTab, setActiveTab] = useState('0');
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
  const [submittedAnswers, setSubmittedAnswers] = useState<string[]>(parsedAnswers);

  // Subscribe to forceStopped so interrupted sessions render as non-interactive cancelled cards.
  const forceStopped = useAgentStore((s) => s.forceStopped[sessionId] ?? false);
  useEffect(() => {
    if (forceStopped && !submitted && !propSubmitted) {
      setSubmittedAnswers(questions.map(() => '已取消'));
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
    if (submitted) return;

    setSelections((prev) => {
      const next = { ...prev };
      const question = questions[qIdx];

      if (question.multiSelect) {
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

    if (!questions[qIdx].multiSelect && hasMultipleQuestions && qIdx < questions.length - 1 && oIdx !== OTHER_IDX) {
      setTimeout(() => setActiveTab(String(qIdx + 1)), 200);
    }
  };

  const isOtherSelected = (qIdx: number) => selections[qIdx]?.has(OTHER_IDX);

  const handleSubmit = async () => {
    if (!allAnswered || submitting) return;

    setSubmitting(true);

    const answers = questions.map((q, i) => {
      const selected = Array.from(selections[i]).map((idx) => {
        if (idx === OTHER_IDX) return otherTexts[i]?.trim() || '其他';
        return q.options[idx].label;
      });

      return q.multiSelect ? selected : selected[0];
    });

    try {
      await agentApi.sendToolResponse(sessionId, toolUseId, answers);
      setSubmittedAnswers(answers.map((answer) => Array.isArray(answer) ? answer.join(', ') : answer));
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      logger.error('Failed to send tool response', { sessionId, toolUseId }, serializeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (submitting) return;

    setSubmitting(true);

    try {
      await agentApi.sendToolResponse(sessionId, toolUseId, questions.map(() => '__cancelled__'));
      setSubmittedAnswers(questions.map(() => '已取消'));
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      logger.error('Failed to cancel question', { sessionId, toolUseId }, serializeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isComposer = variant === 'composer';

  const renderQuestion = (q: AskUserQuestion, qIdx: number) => (
    <div>
      <p className={cn('mb-2 text-sm', isComposer && 'px-1 text-[13px] font-semibold text-foreground')}>
        {q.question}
      </p>
      <div className={cn('space-y-1.5', isComposer && 'space-y-0 overflow-hidden rounded-lg border border-border/18 bg-[hsl(var(--surface-3))]/22')}>
        {q.options.map((opt, oIdx) => {
          const selected = selections[qIdx]?.has(oIdx);

          return (
            <button
              key={oIdx}
              onClick={() => toggleOption(qIdx, oIdx)}
              className={cn(
                'w-full cursor-pointer border px-3 py-2 text-left text-sm transition-colors',
                isComposer ? 'rounded-none border-x-0 border-b-0 border-t border-border/12 first:border-t-0' : 'rounded-md',
                selected
                  ? isComposer
                    ? 'bg-muted/62 text-foreground'
                    : 'border-primary/40 bg-primary/10 text-foreground'
                  : isComposer
                    ? 'border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground'
                    : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex shrink-0 items-center justify-center border text-[11px] font-semibold',
                    isComposer ? 'h-5 w-5 rounded-full' : q.multiSelect ? 'h-4 w-4 rounded-sm' : 'h-4 w-4 rounded-full',
                    selected
                      ? isComposer ? 'border-foreground bg-foreground text-background' : 'border-primary bg-primary'
                      : 'border-muted-foreground/30 text-muted-foreground',
                  )}
                >
                  {isComposer ? oIdx + 1 : selected && <Check className="h-3 w-3 text-primary-foreground" />}
                </span>
                <span className="font-medium">{opt.label}</span>
              </div>
              {opt.description && (
                <p className="ml-6 mt-0.5 text-xs text-muted-foreground">{opt.description}</p>
              )}
            </button>
          );
        })}

        <button
          onClick={() => toggleOption(qIdx, OTHER_IDX)}
          className={cn(
            'w-full cursor-pointer border px-3 py-2 text-left text-sm transition-colors',
            isComposer ? 'rounded-none border-x-0 border-b-0 border-t border-border/12' : 'rounded-md',
            isOtherSelected(qIdx)
              ? isComposer ? 'bg-muted/62 text-foreground' : 'border-primary/40 bg-primary/10 text-foreground'
              : isComposer ? 'border-transparent text-muted-foreground hover:bg-muted/42 hover:text-foreground' : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                q.multiSelect ? 'rounded-sm' : 'rounded-full'
              } ${
                isOtherSelected(qIdx) ? 'border-primary bg-primary' : 'border-muted-foreground/30'
              }`}
            >
              {isOtherSelected(qIdx) && <Check className="h-3 w-3 text-primary-foreground" />}
            </span>
            <span className="font-medium">其他</span>
          </div>
        </button>

        {isOtherSelected(qIdx) && (
          <div className="pl-3">
            <input
              type="text"
              value={otherTexts[qIdx] || ''}
              onChange={(e) => setOtherTexts((prev) => ({ ...prev, [qIdx]: e.target.value }))}
              placeholder="请输入..."
              autoFocus
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}
      </div>
    </div>
  );

  const headerText = questions[0]?.header || '需要你的输入';
  const progressText = hasMultipleQuestions && !submitted ? ` (${answeredCount}/${questions.length})` : '';

  if (isComposer && !submitted) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-[hsl(var(--surface-2))]/66 p-2">
          {hasMultipleQuestions ? (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="mb-2 w-full justify-start overflow-x-auto">
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
            </Tabs>
          ) : (
            questions.map((q, qIdx) => <div key={qIdx}>{renderQuestion(q, qIdx)}</div>)
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-1">
          <button
            onClick={handleCancel}
            disabled={submitting}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/46 hover:text-foreground disabled:opacity-60"
          >
            跳过
          </button>
          <button
            onClick={handleSubmit}
            disabled={!allAnswered || submitting}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
              allAnswered && !submitting
                ? 'bg-foreground text-background hover:bg-foreground/90'
                : 'cursor-not-allowed bg-muted/40 text-muted-foreground',
            )}
          >
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-md border border-primary/20 bg-primary/5">
      <div
        role="button"
        tabIndex={0}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded);
        }}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">{headerText}{progressText}</span>
        {submitted && <Check className="ml-auto h-4 w-4 text-[hsl(var(--success))]" />}
      </div>

      {isExpanded && (
        <div className="space-y-3 border-t px-3 py-3">
          {submitted ? (
            questions.map((q, qIdx) => (
              <div key={qIdx}>
                <p className="mb-0.5 text-xs text-muted-foreground">{q.question}</p>
                <p className="text-sm font-medium">{submittedAnswers[qIdx] || '已回答'}</p>
              </div>
            ))
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
                  onClick={handleCancel}
                  disabled={submitting}
                  className="flex-1 cursor-pointer rounded-md bg-muted/40 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60"
                >
                  取消
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!allAnswered || submitting}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    allAnswered && !submitting
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
                  onClick={handleCancel}
                  disabled={submitting}
                  className="flex-1 cursor-pointer rounded-md bg-muted/40 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60"
                >
                  取消
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!allAnswered || submitting}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    allAnswered && !submitting
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
