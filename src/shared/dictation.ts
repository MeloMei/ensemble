export const dictationLanguages = ['system', 'en-US', 'zh-CN'] as const;
export type DictationLanguage = (typeof dictationLanguages)[number];

export const dictationHelperErrors = [
  'language', 'recognizerUnavailable', 'speechPermission', 'microphonePermission', 'microphoneUnavailable', 'noSpeech',
] as const;
export type DictationUnavailable = 'platform' | 'helperMissing';
export type DictationError = (typeof dictationHelperErrors)[number] | DictationUnavailable | 'busy' | 'timeout' | 'failed';

export interface DictationStatus {
  language: DictationLanguage;
  unavailable?: DictationUnavailable;
}

export type DictationEvent = { id: string } & (
  | { type: 'recording' | 'awaitingInsert' | 'cancelled' }
  | { type: 'final'; text: string }
  | { type: 'error'; reason: DictationError }
);
