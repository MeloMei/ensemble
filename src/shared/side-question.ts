import { SIDE_QUESTION_REFERENCE_LIMIT } from './types';

export function questionExcerpt(text: string): string {
  const value = text.trim();
  if (value.length <= SIDE_QUESTION_REFERENCE_LIMIT) return value;
  return `${value.slice(0, SIDE_QUESTION_REFERENCE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()}…`;
}
