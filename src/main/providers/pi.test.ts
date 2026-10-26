import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session } from '../../shared/types';
import { createPiProvider } from './pi';
import type { ProviderEvent, TurnContext } from './types';

const fixture = String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv.includes('--version')) {console.log('1.4.0 fixture');process.exit(0);}
const root=dirname(dirname(new URL(import.meta.url).pathname));
const mode=readFileSync(join(root,'mode'),'utf8');
const log=value=>appendFileSync(join(root,'trace'),JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const args=process.argv.slice(2);log({argv:args});
const sessionFile=args.includes('--session')?args[args.indexOf('--session')+1]:undefined;
const handlers=new Map(),commands=new Map(),confirmations=new Map();
const ctx={ui:{notify(message,notifyType){send({type:'extension_ui_request',id:'notify',method:'notify',message,notifyType});},
 confirm(title,message){send({type:'extension_ui_request',id:'approve',method:'confirm',title,message});return new Promise(resolve=>confirmations.set('approve',resolve));}}};
const pi={on(name,handler){handlers.set(name,handler);},registerCommand(name,value){commands.set(name,value);},registerMcpServer(){},getAllTools(){return ['read','write','bash'].map(name=>({name}));},getActiveTools(){return ['read','write','bash'];}};
if(args.includes('--extension')) await (await import(pathToFileURL(args[args.indexOf('--extension')+1]).href)).default(pi);
let level='off';
let model={provider:'fixture',id:'model',input:mode==='text-only'?['text']:['text','image'],reasoning:true};
const respond=(q,data)=>send({type:'response',id:q.id,command:q.type,success:true,data});
const fail=q=>send({type:'response',id:q.id,command:q.type,success:false,error:'No API key fixture'});
const answer=()=>{
 send({type:'message_start',message:{role:'assistant',content:[]}});
 send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Hello\u2028'}});
 send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'world'}});
 send({type:'tool_execution_start',toolCallId:'tool-1',toolName:'read',args:{path:'file'}});
 send({type:'tool_execution_end',toolCallId:'tool-1',isError:false,result:{content:[{type:'text',text:'file contents'}]}});
 send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Hello world!'}],stopReason:mode==='model-error'?'error':'stop',errorMessage:'Model failed fixture',usage:{input:10,output:3,cacheRead:2,cost:{total:0.01}}}});
 send({type:'agent_end',messages:[]});
 if(mode==='early-exit') process.exit(0);
 if(mode==='hang') return;
 setTimeout(()=>send({type:'agent_settled',aborted:false}),20);
};
createInterface({input:process.stdin}).on('line',async line=>{
 const q=JSON.parse(line);log(q);
 if(q.type==='extension_ui_response'){confirmations.get(q.id)?.(q.confirmed);return;}
 if(q.type==='get_available_models'){respond(q,{models:[model]});return;}
 if(q.type==='get_state'){respond(q,{sessionFile,sessionId:'native-id',model,thinkingLevel:level});return;}
 if(q.type==='get_available_thinking_levels'){respond(q,{levels:['off','high']});return;}
 if(q.type==='set_thinking_level'){level=q.level;respond(q);return;}
 if(q.type==='set_model'){model={...model,provider:q.provider,id:q.modelId};respond(q,model);return;}
 if(q.type==='prompt'){
  if(q.message.startsWith('/')){const name=q.message.slice(1);if(commands.has(name))await commands.get(name).handler('',ctx);respond(q,{disposition:'handled'});return;}
  if(mode==='rejected'){fail(q);return;}
  if(mode==='lost-acceptance'){process.exit(1);}
  const input=await handlers.get('input')?.({text:q.message},ctx);
  if(input?.action==='handled'){respond(q,{disposition:'handled'});return;}
  writeFileSync(sessionFile,'native session fixture');
  respond(q,{disposition:'started'});
  if(mode==='approval'){
   const result=await handlers.get('tool_call')({toolName:'write',input:{path:'file',content:'fixture'}},ctx);log({guard:result??'allowed'});
  }
  answer();return;
 }
 respond(q,{});
});
process.stdin.on('end',()=>process.exit(0));
`;

async function withFixture(run: (scope: {
  provider: Awaited<ReturnType<typeof createPiProvider>>; session: Session;
  turn(extra?: Partial<TurnContext>): TurnContext & { events: ProviderEvent[] };
  mode(value: string): Promise<void>; records(): Promise<any[]>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ensemble-pi-test-'));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', type: 'module' }));
  await writeFile(join(directory, 'dist', 'index.js'), `export const createMcpExtension = () => pi => pi.registerCommand('mcp',{handler:async()=>{}});`);
  const binary = join(directory, 'dist', 'cli.js');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  await writeFile(join(directory, 'mode'), 'normal');
  const provider = await createPiProvider({ dataPath: directory, binary });
  const session: Session = { id: 'local-session', title: 'Pi test', providerId: 'pi', cwd: directory, status: 'running',
    messages: [], approvals: [], createdAt: '', updatedAt: '', modelId: 'fixture/model' };
  const turn = (extra: Partial<TurnContext> = {}) => {
    const events: ProviderEvent[] = [];
    return { session, prompt: 'fixture task', signal: new AbortController().signal, emit: (event: ProviderEvent) => events.push(event),
      approve: async () => { throw new Error('Unexpected approval'); }, ...extra, events };
  };
  try { await run({ provider, session, turn, mode: value => writeFile(join(directory, 'mode'), value),
    records: async () => (await readFile(join(directory, 'trace'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('Pi discovery is model-free; turns reconcile streamed text, tools, usage, attachments and native resume', async () => withFixture(async ({ provider, session, turn, records }) => {
  assert.equal(provider.info.available, true);
  assert.equal(provider.tracksDelivery, true);
  assert.deepEqual(provider.info.models?.[0].efforts, ['off', 'minimal', 'low', 'medium', 'high']);
  assert.equal(provider.info.health?.checks.authentication.status, 'unknown');
  assert.equal((await records()).some(record => record.type === 'prompt'), false);
  session.settings = { effort: 'high' };
  const context = turn({ attachments: [{ id: 'file', name: 'input.txt', kind: 'text', mimeType: 'text/plain', size: 4, sha256: '', ownedPath: '', data: Buffer.from('data') },
    { id: 'image', name: 'image.png', kind: 'image', mimeType: 'image/png', size: 1, sha256: '', ownedPath: '', data: Buffer.from([1]) }] });
  await provider.run(context);
  const texts = context.events.filter(event => event.type === 'text');
  assert.equal(texts.at(-1)?.text, 'Hello world!');
  assert.equal(new Set(texts.map(event => event.itemId)).size, 1);
  const tool = context.events.filter(event => event.type === 'structured').at(-1)!;
  assert.equal(tool.event.title, 'read'); assert.equal(tool.event.status, 'completed');
  assert.equal(context.events.find(event => event.type === 'usage')?.usage.inputTokens, 10);
  const external = context.events.find(event => event.type === 'external-id')!;
  session.externalId = external.id;
  await provider.run(turn());
  const trace = await records();
  const prompts = trace.filter(record => record.type === 'prompt' && !record.message.startsWith('/'));
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].message, /input.txt/); assert.match(prompts[0].message, /data/);
  assert.equal(prompts[0].images[0].data, 'AQ==');
  const runs = trace.filter(record => record.argv?.includes('--session'));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.equal(run.argv[run.argv.indexOf('--session') + 1], session.externalId);
}));

test('Pi preflight failures stay rejected and do not persist an absent native session', async () => withFixture(async ({ provider, session, turn, mode, records }) => {
  const context = turn(); session.modelId = 'missing/model';
  await assert.rejects(provider.run(context), /未提供所选模型/);
  assert.equal(context.events.some(event => event.type === 'external-id'), false);
  assert.equal(context.events.find(event => event.type === 'delivery')?.status, 'rejected');
  session.modelId = 'fixture/model';
  await mode('rejected'); const rejected = turn();
  await assert.rejects(provider.run(rejected), /No API key fixture/);
  assert.equal(rejected.events.find(event => event.type === 'delivery')?.status, 'rejected');
  assert.equal(rejected.events.some(event => event.type === 'external-id'), false);
  const command = turn({ prompt: '/mcp' });
  await assert.rejects(provider.run(command), /未开始模型任务/);
  assert.equal(command.events.find(event => event.type === 'delivery')?.status, 'rejected');
  await mode('normal'); await provider.run(turn());
  session.externalId = join(session.cwd, 'missing.jsonl');
  await assert.rejects(provider.run(turn()), /无法续接/);
  assert.equal((await records()).filter(record => record.type === 'prompt' && !record.message.startsWith('/')).length, 2);
}));

test('Pi rejects unsupported model settings and images before dispatch', async () => withFixture(async ({ provider, session, turn, mode, records }) => {
  session.settings = { effort: 'max' };
  await assert.rejects(provider.run(turn()), /不支持所选思考档/);
  session.settings = {};
  await mode('text-only');
  await assert.rejects(provider.run(turn({ attachments: [{ id: 'image', name: 'a.png', kind: 'image', mimeType: 'image/png', data: Buffer.from([0]), size: 1, sha256: '', ownedPath: '' }] })), /不支持图片/);
  assert.equal((await records()).some(record => record.type === 'prompt' && !record.message.startsWith('/')), false);
}));

test('Pi requires settled completion, preserves unknown dispatch and surfaces model errors', async () => withFixture(async ({ provider, turn, mode }) => {
  await mode('early-exit'); await assert.rejects(provider.run(turn()), /提前关闭/);
  await mode('model-error'); await assert.rejects(provider.run(turn()), /Model failed fixture/);
  await mode('lost-acceptance'); const lost = turn();
  await assert.rejects(provider.run(lost), /提前关闭/);
  assert.equal(lost.events.some(event => event.type === 'delivery'), false);
}));

test('Pi forwards one-call approval and cancels a running process', async () => withFixture(async ({ provider, turn, mode, records }) => {
  await mode('approval'); let count = 0;
  await provider.run(turn({ approve: async input => { count++; assert.match(input.detail, /write/); return 'allow'; } }));
  assert.equal(count, 1); assert.equal((await records()).find(record => record.guard)?.guard, 'allowed');
  await mode('hang'); const controller = new AbortController();
  const context = turn({ signal: controller.signal, emit(event) { context.events.push(event); if (event.type === 'delivery' && event.status === 'accepted') controller.abort(); } });
  await assert.rejects(provider.run(context), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(context.events.some(event => event.type === 'external-id'), true);
}));
