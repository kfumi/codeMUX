// Normalizes an AskUserQuestion answer payload coming from AskUserQuestionCard.
//
// The card is optional clarification, not a required form: its "忽略"/"取消" button
// sends the `__cancelled__` marker instead of an answer. Runtimes that can express a
// real skip/deny (Codex, pi, and now Claude/OpenCode) must translate the marker into a
// native cancellation rather than leaking it to the model as an answer string.

/** Marker AskUserQuestionCard sends when the user ignores/dismisses the card. */
export const USER_CANCELLED_MARKER = '__cancelled__';

/**
 * What the model is told when the user ignores the card. Ignoring is not a stop:
 * the agent must keep working on the task with its own judgement. Claude receives
 * this as the deny message; OpenCode receives it as the question answer, because
 * OpenCode's native `question.reject` aborts the running turn (see PR #46056) —
 * only a normal reply lets the loop continue.
 */
export const ASK_USER_QUESTION_IGNORED_MESSAGE = '用户忽略了该提问，请按你的最佳判断继续，不必再次提问';

export interface NormalizedAskUserQuestionAnswers {
  /** True when every question resolved to no answer (the user dismissed the card). */
  cancelled: boolean;
  /** Per-question answers with the cancel marker stripped; multi-select joined by ", ". */
  answers: string[];
}

export function normalizeAskUserQuestionAnswers(
  questionCount: number,
  userAnswers: unknown,
): NormalizedAskUserQuestionAnswers {
  const list = Array.isArray(userAnswers) ? userAnswers : [];
  const answers = Array.from({ length: Math.max(0, questionCount) }, (_, index) => {
    const answer = list[index];
    const values = Array.isArray(answer)
      ? answer.map((entry) => String(entry))
      : answer == null
        ? []
        : [String(answer)];
    return values.filter((value) => value !== USER_CANCELLED_MARKER).join(', ');
  });

  return {
    cancelled: questionCount > 0 && answers.every((answer) => answer.length === 0),
    answers,
  };
}
