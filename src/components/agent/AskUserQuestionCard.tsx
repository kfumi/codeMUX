import { useState } from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import { agentApi } from '../../lib/tauri';

interface Question {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

interface AskUserQuestionCardProps {
  toolUseId: string;
  questions: Question[];
  submitted?: boolean;
  resultContent?: string;
}

const OTHER_IDX = -1;

/** Try to extract answers from tool_result content */
function parseResultAnswers(resultContent: string, questions: Question[]): string[] {
  // Try JSON parse first
  try {
    const parsed = JSON.parse(resultContent);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed?.answers) return Object.values(parsed.answers).map(String);
  } catch { /* not JSON */ }
  // Try to extract from "question"="answer" pattern
  const answers: string[] = [];
  for (const q of questions) {
    const re = new RegExp(`"${q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*=\\s*"([^"]*)"`, 'i');
    const match = resultContent.match(re);
    answers.push(match?.[1] || '');
  }
  return answers.some(a => a) ? answers : [];
}

export function AskUserQuestionCard({ toolUseId, questions, submitted: propSubmitted, resultContent }: AskUserQuestionCardProps) {
  // Parse answers from result content if available
  const parsedAnswers = propSubmitted && resultContent ? parseResultAnswers(resultContent, questions) : [];

  const [isExpanded, setIsExpanded] = useState(!propSubmitted);
  const [selections, setSelections] = useState<Record<number, Set<number>>>(() => {
    const init: Record<number, Set<number>> = {};
    questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(propSubmitted || false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAnswers, setSubmittedAnswers] = useState<string[]>(parsedAnswers);

  const toggleOption = (qIdx: number, oIdx: number) => {
    if (submitted) return;
    setSelections((prev) => {
      const next = { ...prev };
      const question = questions[qIdx];
      if (question.multiSelect) {
        const set = new Set(prev[qIdx]);
        if (set.has(oIdx)) set.delete(oIdx); else set.add(oIdx);
        next[qIdx] = set;
      } else {
        next[qIdx] = new Set([oIdx]);
      }
      return next;
    });
  };

  const isOtherSelected = (qIdx: number) => selections[qIdx]?.has(OTHER_IDX);

  const allAnswered = questions.every((_, i) => {
    const sel = selections[i];
    if (sel.size === 0) return false;
    if (sel.has(OTHER_IDX) && !otherTexts[i]?.trim()) return false;
    return true;
  });

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
      await agentApi.sendToolResponse(toolUseId, answers);
      setSubmittedAnswers(answers.map((a) => Array.isArray(a) ? a.join(', ') : a));
      setSubmitted(true);
    } catch (err) {
      console.error('Failed to send tool response:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border rounded-md my-2 bg-primary/5 border-primary/20">
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded); }}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">{questions[0]?.header || '需要你的输入'}</span>
        {submitted && <Check className="h-4 w-4 text-green-500 ml-auto" />}
      </div>
      {isExpanded && (
        <div className="border-t px-3 py-3 space-y-3">
          {/* After submit: show summary only */}
          {submitted ? (
            questions.map((q, qIdx) => (
              <div key={qIdx}>
                <p className="text-xs text-muted-foreground mb-0.5">{q.question}</p>
                <p className="text-sm font-medium">{submittedAnswers[qIdx] || '已回答'}</p>
              </div>
            ))
          ) : (
            <>
              {questions.map((q, qIdx) => (
                <div key={qIdx}>
                  <p className="text-sm mb-2">{q.question}</p>
                  <div className="space-y-1.5">
                    {q.options.map((opt, oIdx) => {
                      const selected = selections[qIdx]?.has(oIdx);
                      return (
                        <button
                          key={oIdx}
                          onClick={() => toggleOption(qIdx, oIdx)}
                          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors border ${
                            selected
                              ? 'bg-primary/10 border-primary/40 text-foreground'
                              : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/50'
                          } cursor-pointer`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`h-4 w-4 rounded-${q.multiSelect ? 'sm' : 'full'} border flex items-center justify-center shrink-0 ${
                              selected ? 'bg-primary border-primary' : 'border-muted-foreground/30'
                            }`}>
                              {selected && <Check className="h-3 w-3 text-primary-foreground" />}
                            </span>
                            <span className="font-medium">{opt.label}</span>
                          </div>
                          {opt.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 ml-6">{opt.description}</p>
                          )}
                        </button>
                      );
                    })}
                    {/* "Other" option */}
                    <button
                      onClick={() => toggleOption(qIdx, OTHER_IDX)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors border ${
                        isOtherSelected(qIdx)
                          ? 'bg-primary/10 border-primary/40 text-foreground'
                          : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/50'
                      } cursor-pointer`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-4 w-4 rounded-${q.multiSelect ? 'sm' : 'full'} border flex items-center justify-center shrink-0 ${
                          isOtherSelected(qIdx) ? 'bg-primary border-primary' : 'border-muted-foreground/30'
                        }`}>
                          {isOtherSelected(qIdx) && <Check className="h-3 w-3 text-primary-foreground" />}
                        </span>
                        <span className="font-medium">其他</span>
                      </div>
                    </button>
                    {/* Text input for "Other" */}
                    {isOtherSelected(qIdx) && (
                      <div className="pl-3">
                        <input
                          type="text"
                          value={otherTexts[qIdx] || ''}
                          onChange={(e) => setOtherTexts((prev) => ({ ...prev, [qIdx]: e.target.value }))}
                          placeholder="请输入..."
                          autoFocus
                          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button
                onClick={handleSubmit}
                disabled={!allAnswered || submitting}
                className={`w-full py-2 rounded-md text-sm font-medium transition-colors ${
                  allAnswered && !submitting
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted/40 text-muted-foreground cursor-not-allowed'
                }`}
              >
                {submitting ? '提交中...' : '提交'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
