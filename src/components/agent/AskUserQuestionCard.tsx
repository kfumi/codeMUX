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
}

export function AskUserQuestionCard({ toolUseId, questions }: AskUserQuestionCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  // Track selected indices per question
  const [selections, setSelections] = useState<Record<number, Set<number>>>(() => {
    const init: Record<number, Set<number>> = {};
    questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const toggleOption = (qIdx: number, oIdx: number) => {
    if (submitted) return;
    setSelections((prev) => {
      const next = { ...prev };
      const question = questions[qIdx];
      if (question.multiSelect) {
        const set = new Set(prev[qIdx]);
        if (set.has(oIdx)) set.delete(oIdx);
        else set.add(oIdx);
        next[qIdx] = set;
      } else {
        // Single select: replace
        next[qIdx] = new Set([oIdx]);
      }
      return next;
    });
  };

  const allAnswered = questions.every((_, i) => selections[i].size > 0);

  const handleSubmit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    const answers = questions.map((q, i) => {
      const selected = Array.from(selections[i]).map((idx) => q.options[idx].label);
      return q.multiSelect ? selected : selected[0];
    });
    try {
      await agentApi.sendToolResponse(toolUseId, answers);
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
        <div className="border-t px-3 py-3 space-y-4">
          {questions.map((q, qIdx) => (
            <div key={qIdx}>
              <p className="text-sm mb-2">{q.question}</p>
              <div className="space-y-1.5">
                {q.options.map((opt, oIdx) => {
                  const selected = selections[qIdx]?.has(oIdx);
                  return (
                    <button
                      key={oIdx}
                      disabled={submitted}
                      onClick={() => toggleOption(qIdx, oIdx)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors border ${
                        selected
                          ? 'bg-primary/10 border-primary/40 text-foreground'
                          : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/50'
                      } ${submitted ? 'cursor-default' : 'cursor-pointer'}`}
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
              </div>
            </div>
          ))}
          {!submitted && (
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
          )}
        </div>
      )}
    </div>
  );
}
