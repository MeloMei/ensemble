import type { ApprovalInput } from './types';

export function validQuestionAnswers(questions: NonNullable<ApprovalInput['questions']>, answers: Record<string, string[]>): boolean {
  return questions.every(question => {
    const values = answers[question.id];
    return Boolean(values?.length && values.every(value => value.trim())
      && (question.multiSelect || values.length === 1)
      && (question.allowCustomAnswer !== false || values.every(value => question.options.some(option => option.label === value))));
  });
}
