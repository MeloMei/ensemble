import { discoveryHealth } from '../provider-health';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BUILTIN_PROVIDER_IDS } from '../../shared/types';
import type { ProviderAdapter, TurnContext } from './types';
import { createNdjsonDecoder } from './ndjson';
import { signalProcessTree } from './process-tree';
import { providerCapabilitiesSchema, type ProviderCapabilities } from '../../shared/provider-capabilities';
import { validQuestionAnswers } from '../../shared/question-answers';

const nonempty = z.string().min(1);
const argument = z.string().max(8192).refine((value) => !value.includes('\0'), 'NUL is not allowed');
const manifestFields = {
  id: z.string().max(64).regex(/^[a-z][a-z0-9-]*$/),
  name: nonempty.max(80),
  command: argument.refine((value) => value.trim().length > 0, 'Command is required'),
  args: z.array(argument).max(128),
};
const manifestSchema = z.discriminatedUnion('apiVersion', [
  z.object({ ...manifestFields, apiVersion: z.literal(1), capabilities: providerCapabilitiesSchema.pick({ resume: true, approvals: true }) }).strict(),
  z.object({ ...manifestFields, apiVersion: z.literal(2), capabilities: providerCapabilitiesSchema }).strict(),
]).refine(value => value.apiVersion === 1 || (!value.capabilities.rewind && !value.capabilities.steer),
  'Plugin protocol 2 does not implement native rewind or steer operations');

const approvalSchema = z.object({
  type: z.literal('approval'),
  id: nonempty.max(256),
  title: nonempty,
  detail: z.string(),
  choices: z.array(z.object({ id: nonempty.max(256), label: nonempty }).strict()).min(1).max(20),
}).strict().refine((value) => new Set(value.choices.map((choice) => choice.id)).size === value.choices.length,
  'Approval choices must have unique IDs');

const frameSchema = z.union([
  z.object({ type: z.literal('text'), itemId: nonempty.max(256), text: z.string(), replace: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('activity'), text: z.string() }).strict(),
  z.object({ type: z.literal('external-id'), id: nonempty.max(1024) }).strict(),
  approvalSchema,
  z.object({ type: z.literal('result'), status: z.enum(['completed', 'failed', 'cancelled']), error: z.string().optional() }).strict(),
]);

const questionSchema = z.object({ id: nonempty.max(256), question: nonempty.max(10000), header: z.string().max(200),
  options: z.array(z.object({ label: nonempty.max(1000), description: z.string().max(4000).optional() }).strict()).max(50),
  multiSelect: z.boolean(), allowCustomAnswer: z.boolean().optional() }).strict();
const richApprovalSchema = z.object({ type: z.literal('approval'), id: nonempty.max(256), title: nonempty.max(1000), detail: z.string().max(64000),
  choices: z.array(z.object({ id: nonempty.max(256), label: nonempty.max(1000) }).strict()).max(20),
  questions: z.array(questionSchema).min(1).max(20).optional(),
}).strict().refine(value => (value.choices.length > 0 || Boolean(value.questions?.length))
  && new Set(value.choices.map(choice => choice.id)).size === value.choices.length
  && new Set(value.questions?.map(question => question.id)).size === (value.questions?.length ?? 0), 'Approval IDs must be unique and a response is required');
const structuredSchema = z.object({ type: z.literal('structured'), event: z.object({
  id: nonempty.max(256), kind: z.enum(['tool', 'plan', 'task', 'subagent']), title: nonempty.max(1000),
  status: z.enum(['pending', 'running', 'completed', 'failed']), nativeId: z.string().max(1024).optional(),
  parentId: z.string().max(1024).optional(), input: z.string().max(64000).optional(), output: z.string().max(64000).optional(),
  entries: z.array(z.object({ text: z.string().max(4000), status: z.enum(['pending', 'running', 'completed']) }).strict()).max(200).optional(),
}).strict() }).strict();
const counter = z.number().finite().nonnegative().optional();
const usageSchema = z.object({ type: z.literal('usage'), usage: z.object({ id: nonempty.max(256), source: nonempty.max(100),
  scope: z.enum(['turn', 'cumulative', 'context']), inputTokens: counter, outputTokens: counter, cachedTokens: counter,
  contextUsed: counter, contextSize: counter, cost: counter, currency: z.string().max(20).optional(), createdAt: z.string().datetime(),
}).strict() }).strict();
const richFrameSchema = z.union([frameSchema, richApprovalSchema, structuredSchema, usageSchema,
  z.object({ type: z.literal('ready'), apiVersion: z.literal(2), capabilities: providerCapabilitiesSchema }).strict(),
  z.object({ type: z.literal('native-turn'), turnId: nonempty.max(1024) }).strict(),
]);

type Manifest = z.infer<typeof manifestSchema>;
type Result = { status: 'completed' | 'failed' | 'cancelled'; error?: string };
const RESERVED_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);
const STDERR_TAIL_BYTES = 8192;
const MANIFEST_MAX_BYTES = 64 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(): Error {
  const error = new Error('Plugin turn cancelled');
  error.name = 'AbortError';
  return error;
}

function runPlugin(manifest: Manifest, executable: string, context: TurnContext, negotiated: (capabilities: ProviderCapabilities) => void): Promise<void> {
  if (context.signal.aborted) return Promise.reject(cancelled());
  if (manifest.apiVersion === 1 && context.attachments?.length) {
    return Promise.reject(new Error(`${manifest.name}: plugin protocol apiVersion 1 does not support attachments`));
  }
  if (context.session.externalId && !manifest.capabilities.resume) {
    return Promise.reject(new Error(`${manifest.name} does not support resuming sessions`));
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, manifest.args, {
      cwd: context.session.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let result: Result | undefined;
    let failure: Error | undefined;
    let settled = false;
    let stopping = false;
    let stderrTail = Buffer.alloc(0);
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let ready = manifest.apiVersion === 1;
    const declaredCapabilities: ProviderCapabilities = manifest.capabilities;
    let capabilities: ProviderCapabilities = manifest.capabilities;
    const pendingApprovals = new Set<string>();
    const seenApprovals = new Set<string>();

    function finish(error?: Error): void {
      if (settled) return;
      try { signalProcessTree(child, 'SIGKILL'); } catch (cause) {
        error ??= new Error(`Could not clean up plugin processes: ${errorMessage(cause)}`);
      }
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(stopTimer);
      clearTimeout(resultTimer);
      clearTimeout(exitTimer);
      clearTimeout(handshakeTimer);
      context.signal.removeEventListener('abort', onAbort);
      child.removeListener('error', onProcessError);
      child.removeListener('close', onClose);
      child.removeListener('exit', onExit);
      child.stdin.removeListener('error', onInputError);
      child.stdout.removeListener('data', onOutput);
      child.stderr.removeListener('data', onStderr);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      pendingApprovals.clear();
      seenApprovals.clear();
      error ? reject(error) : resolve();
    }

    function stop(error: Error): void {
      failure ??= error;
      if (stopping || settled) return;
      stopping = true;
      try { signalProcessTree(child, 'SIGTERM'); } catch (cause) {
        failure = new Error(`${failure.message}; could not stop plugin: ${errorMessage(cause)}`);
      }
      forceTimer = setTimeout(() => {
        try { signalProcessTree(child, 'SIGKILL'); } catch (cause) {
          failure = new Error(`${failure?.message}; could not kill plugin: ${errorMessage(cause)}`);
        }
      }, 500);
      stopTimer = setTimeout(() => finish(failure ?? error), 1500);
    }

    function write(payload: unknown): void {
      if (settled || stopping || result) return;
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error && !result && !settled) stop(error);
      });
    }

    function sendTurn(): void {
      if (context.session.externalId && !capabilities.resume) throw new Error('Plugin did not negotiate resume support');
      if (context.attachments?.some(attachment => attachment.kind === 'image') && !capabilities.images) throw new Error('Plugin did not negotiate images');
      if (context.attachments?.some(attachment => attachment.kind === 'text') && !capabilities.textAttachments) throw new Error('Plugin did not negotiate text attachments');
      if (context.session.settings?.effort && !capabilities.effort) throw new Error('Plugin did not negotiate effort settings');
      if (context.session.settings?.permission && !capabilities.permissions) throw new Error('Plugin did not negotiate permission settings');
      write({ type: 'turn', sessionId: context.session.id,
        ...(context.session.externalId ? { externalId: context.session.externalId } : {}), cwd: context.session.cwd, prompt: context.prompt,
        ...(manifest.apiVersion === 2 ? { apiVersion: 2, clientUserMessageId: context.userMessageId,
          ...(context.session.modelId ? { modelId: context.session.modelId } : {}),
          settings: context.session.settings ?? {}, attachments: (context.attachments ?? []).map(({ id, name, kind, mimeType, size, sha256, data }) =>
            ({ id, name, kind, mimeType, size, sha256, encoding: 'base64', data: data.toString('base64') })) } : {}),
      });
    }

    const decoder = createNdjsonDecoder((record) => {
      if (stopping || settled) return;
      if (result) throw new Error('Plugin emitted a frame after its result');
      const frame = manifest.apiVersion === 1 ? frameSchema.parse(record) : richFrameSchema.parse(record);
      if (frame.type === 'ready') {
        if (ready) throw new Error('Plugin emitted a duplicate ready frame');
        for (const [key, value] of Object.entries(frame.capabilities)) {
          if (value && !declaredCapabilities[key as keyof ProviderCapabilities]) throw new Error(`Plugin negotiated undeclared capability ${key}`);
        }
        capabilities = frame.capabilities;
        ready = true; clearTimeout(handshakeTimer); negotiated(capabilities); sendTurn(); return;
      }
      if (!ready) throw new Error('Plugin emitted output before protocol negotiation');
      if (frame.type === 'approval') {
        if (!capabilities.approvals) throw new Error('Plugin requested an undeclared approval capability');
        if (seenApprovals.has(frame.id)) throw new Error(`Duplicate plugin approval ID: ${frame.id}`);
        seenApprovals.add(frame.id);
        pendingApprovals.add(frame.id);
        const { title, detail, choices } = frame;
        const questions = manifest.apiVersion === 2 ? (frame as z.infer<typeof richApprovalSchema>).questions : undefined;
        if (questions?.length && !capabilities.questions) throw new Error('Plugin requested undeclared questions');
        void Promise.resolve().then(() => {
          if (settled || stopping || result) return undefined;
          return context.approve({ title, detail, choices, ...(questions ? { questions } : {}) });
        }).then((choiceId) => {
          if (settled || stopping || result || choiceId === undefined) return;
          if (questions) {
            const answers = z.record(z.array(z.string().min(1).max(10000)).min(1).max(50)).parse(JSON.parse(choiceId));
            if (!validQuestionAnswers(questions, answers)) throw new Error('Invalid plugin question answers');
            pendingApprovals.delete(frame.id); write({ type: 'approval-result', id: frame.id, answers }); return;
          }
          if (!choices.some((choice) => choice.id === choiceId)) throw new Error('Invalid plugin approval choice');
          pendingApprovals.delete(frame.id);
          write({ type: 'approval-result', id: frame.id, choiceId });
        }).catch((error: unknown) => {
          if (!settled && !stopping && !result) stop(new Error(errorMessage(error)));
        });
      } else if (frame.type === 'result') {
        if (frame.status === 'completed' && pendingApprovals.size) throw new Error('Plugin completed with unanswered approvals');
        result = frame;
        child.stdin.end();
        resultTimer = setTimeout(() => stop(new Error('Plugin did not exit after its result')), 3000);
      } else {
        if (frame.type === 'external-id' && !capabilities.resume) {
          throw new Error('Plugin emitted an external ID without declaring resume support');
        }
        if (frame.type === 'structured' && !capabilities.structured) throw new Error('Plugin emitted undeclared structured events');
        if (frame.type === 'usage' && !capabilities.usage) throw new Error('Plugin emitted undeclared usage');
        context.emit(frame);
      }
    });

    function onAbort(): void { stop(cancelled()); }
    function onProcessError(error: Error): void { stop(error); }
    function onExit(): void {
      exitTimer = setTimeout(() => stop(new Error('Plugin left output open after its process exited')), 1000);
    }
    function onInputError(error: Error): void { if (!result) stop(error); }
    function onOutput(chunk: Buffer): void {
      try { decoder.feed(chunk); } catch (error) { stop(new Error(`Invalid plugin output: ${errorMessage(error)}`)); }
    }
    function onStderr(chunk: Buffer): void {
      stderrTail = Buffer.concat([stderrTail, chunk.subarray(-STDERR_TAIL_BYTES)]).subarray(-STDERR_TAIL_BYTES);
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (!failure) {
        try { decoder.end(); } catch (error) { failure = new Error(`Invalid plugin output: ${errorMessage(error)}`); }
      }
      if (failure) { finish(failure); return; }
      if (context.signal.aborted || result?.status === 'cancelled') { finish(cancelled()); return; }
      if (code === 0 && result?.status === 'completed') { finish(); return; }
      const detail = result?.error || stderrTail.toString('utf8').trim();
      finish(new Error(`${manifest.name}: ${result?.status === 'failed' ? 'turn failed' : 'no successful completion'} (exit ${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`));
    }

    child.on('error', onProcessError);
    child.on('close', onClose);
    child.on('exit', onExit);
    child.stdin.on('error', onInputError);
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onStderr);
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) { onAbort(); return; }
    if (manifest.apiVersion === 2) {
      handshakeTimer = setTimeout(() => stop(new Error('Plugin protocol negotiation timed out')), 5000);
      write({ type: 'initialize', apiVersion: 2, host: 'Ensemble', capabilities: manifest.capabilities });
    } else {
      try { sendTurn(); } catch (error) { stop(new Error(errorMessage(error))); }
    }
  });
}

export async function loadPluginProviders(pluginPath: string): Promise<{ adapters: ProviderAdapter[]; errors: string[] }> {
  const errors: string[] = [];
  let entries;
  try { entries = await readdir(pluginPath, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { adapters: [], errors };
    return { adapters: [], errors: [`Cannot read plugin directory: ${errorMessage(error)}`] };
  }
  const candidates: { manifest: Manifest; directory: string; executable: string }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(pluginPath, entry.name);
    try {
      const file = path.join(directory, 'manifest.json');
      if ((await stat(file)).size > MANIFEST_MAX_BYTES) throw new Error('Manifest exceeds 64 KiB');
      const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (RESERVED_IDS.has(manifest.id)) throw new Error(`Provider ID ${manifest.id} is reserved`);
      const executable = path.isAbsolute(manifest.command) ? manifest.command : path.resolve(directory, manifest.command);
      candidates.push({ manifest, directory, executable });
    } catch (error) { errors.push(`${entry.name}: ${errorMessage(error)}`); }
  }
  const counts = new Map<string, number>();
  for (const { manifest } of candidates) counts.set(manifest.id, (counts.get(manifest.id) ?? 0) + 1);
  const adapters: ProviderAdapter[] = [];
  for (const { manifest, directory, executable } of candidates) {
    if (counts.get(manifest.id)! > 1) { errors.push(`${path.basename(directory)}: Duplicate provider ID ${manifest.id}`); continue; }
    let diagnostic: string | undefined;
    try {
      if (!(await stat(executable)).isFile()) throw new Error('Command is not a file');
      await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    } catch (error) { diagnostic = `Executable unavailable: ${executable} (${errorMessage(error)})`; }
    const adapter: ProviderAdapter = {
      info: {
        id: manifest.id, name: manifest.name, source: 'plugin', available: !diagnostic,
        detail: diagnostic ?? `Local plugin · ${directory}`, capabilities: manifest.capabilities,
        protocolVersion: manifest.apiVersion, declaredCapabilities: manifest.capabilities,
        health: discoveryHealth({ binary: !diagnostic, source: 'plugin-manifest' }),
      },
      run: (context) => diagnostic ? Promise.reject(new Error(diagnostic)) : runPlugin(manifest, executable, context, capabilities => {
        adapter.info.capabilities = capabilities;
        const at = new Date().toISOString();
        if (adapter.info.health) adapter.info.health.checks.protocol = { status: 'ready', source: 'plugin-ready', observedAt: at };
      }),
    };
    adapters.push(adapter);
  }
  return { adapters, errors };
}
