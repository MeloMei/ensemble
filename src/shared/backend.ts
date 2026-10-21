export interface BackendEndpoint {
  version: 1;
  url: string;
  token: string;
  pid: number;
  instanceId: string;
  startedAt: string;
  stoppedAt?: string;
}

export interface BackendReply<T = unknown> { result?: T; error?: string }
