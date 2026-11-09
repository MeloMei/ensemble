import { execFile } from 'node:child_process';
import type { TerminalService } from '../shared/types';

const maxTerminalProcesses = 64;
const maxServices = 16;

interface ProcessIdentity { parent: number; started: string }

function readTool(file: string, args: string[], signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => execFile(file, args, {
    encoding: 'utf8', shell: false, timeout: 750, killSignal: 'SIGKILL', maxBuffer: 512 * 1024, signal,
    env: { LC_ALL: 'C' },
  }, (error, stdout) => resolve(error ? undefined : stdout)));
}

function readProcessTable(output: string): Map<number, ProcessIdentity> {
  const processes = new Map<number, ProcessIdentity>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), started: match[3].trim() });
  }
  return processes;
}

function descendants(processes: ReadonlyMap<number, ProcessIdentity>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, info] of processes) {
    const siblings = children.get(info.parent);
    if (siblings) siblings.push(pid); else children.set(info.parent, [pid]);
  }
  const owned = [root];
  const visited = new Set(owned);
  for (let index = 0; index < owned.length && owned.length < maxTerminalProcesses; index++) {
    for (const child of children.get(owned[index]) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      owned.push(child);
      if (owned.length === maxTerminalProcesses) break;
    }
  }
  return owned;
}

export function parseTerminalListeners(output: string, owners: ReadonlySet<number>): TerminalService[] {
  let pid = 0;
  let family = '';
  const services = new Map<string, TerminalService>();
  for (const record of output.split('\0')) {
    const field = record.replace(/^\n+/, '');
    const value = field.slice(1);
    switch (field[0]) {
      case 'p': pid = Number(value); family = ''; break;
      case 'f': family = ''; break;
      case 't': family = value; break;
      case 'n': {
        if (!owners.has(pid) || (family !== 'IPv4' && family !== 'IPv6')) break;
        const address = /^(\*|0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]):(\d+)$/.exec(value);
        if (!address) break;
        const port = Number(address[2]);
        if (port < 1 || port > 65535) break;
        const bind = address[1];
        const host = bind.startsWith('[') || (bind === '*' && family === 'IPv6') ? '::1' : '127.0.0.1';
        services.set(`${host}:${port}`, { host, port });
        break;
      }
    }
  }
  return [...services.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host)).slice(0, maxServices);
}

export async function discoverTerminalServices(root: number, parent: number, signal: AbortSignal): Promise<TerminalService[]> {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(root) || root <= 0 || root === parent) return [];
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(2300)]);
  const snapshot = async () => {
    const output = await readTool('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], bounded);
    return output === undefined ? undefined : readProcessTable(output);
  };
  const before = await snapshot();
  const identity = before?.get(root);
  if (!before || !identity || identity.parent !== parent || bounded.aborted) return [];
  const queried = descendants(before, root);
  const listeners = await readTool('/usr/sbin/lsof', ['-nP', '-a', '-p', queried.join(','), '-iTCP', '-sTCP:LISTEN', '-F0pftn'], bounded);
  if (!listeners || bounded.aborted) return [];
  const after = await snapshot();
  const currentRoot = after?.get(root);
  if (!after || !currentRoot || currentRoot.parent !== parent || currentRoot.started !== identity.started || bounded.aborted) return [];
  const current = new Set(descendants(after, root));
  const owners = new Set(queried.filter(pid => current.has(pid) && before.get(pid)?.started === after.get(pid)?.started));
  return parseTerminalListeners(listeners, owners);
}
