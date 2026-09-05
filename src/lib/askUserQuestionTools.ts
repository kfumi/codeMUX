export const ASK_USER_QUESTION_TOOL_NAMES = [
  'AskUserQuestion',
  'askUserQuestion',
  'ask_user_question',
  'request_user_input',
  'question',
] as const;

export type AskUserQuestionToolName = typeof ASK_USER_QUESTION_TOOL_NAMES[number];

const ASK_USER_QUESTION_TOOL_NAME_SET = new Set<string>(ASK_USER_QUESTION_TOOL_NAMES);

export function isAskUserQuestionToolName(toolName: string): boolean {
  return ASK_USER_QUESTION_TOOL_NAME_SET.has(toolName);
}

export function normalizeAskUserQuestionToolName(toolName: string): 'AskUserQuestion' | null {
  return isAskUserQuestionToolName(toolName) ? 'AskUserQuestion' : null;
}
