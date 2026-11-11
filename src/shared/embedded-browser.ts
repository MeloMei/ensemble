import { localPreviewUrl } from './draft-evidence';

export function browserUrl(input: string): URL | undefined {
  const url = URL.parse(input);
  if (!url || url.username || url.password) return;
  if (url.protocol === 'https:' || localPreviewUrl(url.href)) return url;
}

export function browserFindShortcut(key: string, control: boolean, meta: boolean, alt: boolean, shift: boolean): boolean {
  return key.toLowerCase() === 'f' && (control || meta) && !alt && !shift;
}

export interface BrowserBounds { x: number; y: number; width: number; height: number }

export type BrowserCommand =
  | { action: 'navigate'; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'stop-find' }
  | { action: 'find'; text: string; forward: boolean }
  | { action: 'zoom'; change: 'in' | 'out' | 'reset' };

export interface BrowserState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  match?: { current: number; total: number };
  failed: boolean;
}
