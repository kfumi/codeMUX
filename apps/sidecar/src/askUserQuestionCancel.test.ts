import { describe, expect, it } from 'vitest';
import { normalizeAskUserQuestionAnswers, USER_CANCELLED_MARKER } from './askUserQuestionCancel.js';

describe('normalizeAskUserQuestionAnswers', () => {
  it('keeps plain single-select answers', () => {
    const result = normalizeAskUserQuestionAnswers(1, ['继续']);
    expect(result).toEqual({ cancelled: false, answers: ['继续'] });
  });

  it('joins multi-select answers with a comma', () => {
    const result = normalizeAskUserQuestionAnswers(2, [['甲', '乙'], ['丙']]);
    expect(result).toEqual({ cancelled: false, answers: ['甲, 乙', '丙'] });
  });

  it('treats an all-marker payload as a cancellation', () => {
    const result = normalizeAskUserQuestionAnswers(2, [[USER_CANCELLED_MARKER], [USER_CANCELLED_MARKER]]);
    expect(result).toEqual({ cancelled: true, answers: ['', ''] });
  });

  it('does not treat a partial marker payload as a cancellation', () => {
    const result = normalizeAskUserQuestionAnswers(2, [[USER_CANCELLED_MARKER], ['继续']]);
    expect(result).toEqual({ cancelled: false, answers: ['', '继续'] });
  });

  it('strips the marker from a mixed multi-select answer', () => {
    const result = normalizeAskUserQuestionAnswers(1, [['甲', USER_CANCELLED_MARKER]]);
    expect(result).toEqual({ cancelled: false, answers: ['甲'] });
  });

  it('never reports cancellation for an empty question set', () => {
    const result = normalizeAskUserQuestionAnswers(0, []);
    expect(result).toEqual({ cancelled: false, answers: [] });
  });

  it('normalizes null/undefined answers to empty strings', () => {
    const result = normalizeAskUserQuestionAnswers(2, [null, undefined]);
    expect(result).toEqual({ cancelled: true, answers: ['', ''] });
  });
});
