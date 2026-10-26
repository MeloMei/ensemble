export interface AppUpdateRelease {
  version: string;
  title: string;
  notes: string;
  publishedAt: string;
  url: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

export interface AppUpdateState {
  currentVersion: string;
  supported: boolean;
  autoCheck: boolean;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  checkedAt?: string;
  release?: AppUpdateRelease;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}
