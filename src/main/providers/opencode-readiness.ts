export const OPENCODE_MCP_READY_TIMEOUT_MS = 30_000;

export function openCodeReadinessPlugin(toolIds: string[]): string {
  return `export default {id:'workbench.mcp-ready',async setup(context){
  const expected=${JSON.stringify(toolIds)};
  let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
  void ready.catch(()=>{});
  await context.tool.transform(editor=>{
    const ids=new Set(editor.list().map(tool=>tool.id));
    if(expected.every(id=>ids.has(id)))resolveReady();
  });
  await context.session.hook('prompt',async()=>{
    let timer;
    try{
      await Promise.race([ready,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Ensemble MCP 工具未在30秒内完成原生注册，任务未发送。')),${OPENCODE_MCP_READY_TIMEOUT_MS});
      })]);
    }finally{clearTimeout(timer)}
  });
  return()=>rejectReady(new Error('Ensemble MCP 连接已关闭，任务未发送。'));
}};\n`;
}
