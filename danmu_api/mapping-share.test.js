import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {handleRequest} from './worker.js';
import {systemSettingsJsContent} from './ui/js/systemsettings.js';
import {Globals} from './configs/globals.js';
const config={TOKEN:'fixture-user',TOKEN_AUTH_DISABLED:'false',TITLE_MAPPING_TABLE:'Local -> Target;Another -> Other',AUTO_MATCH_MAPPING_TABLE:'Show S2E1~E2 -> Show S1E11~E12'};
const req=(token='fixture-user',body={kind:'title',indices:[0],lines:['Local -> Target']})=>new Request('http://localhost/'+token+'/api/title-mapping/share',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const handle=(request,env=config)=>handleRequest(request,env,'cloudflare','127.0.0.1');
test('real route requires TOKEN, validates current local selection, forwards only selected rules',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({success:true,id:'id',status:'pending_review',stored:1,duplicate:0,conflict:[],invalid:[]});};
  try{
    assert.equal((await handle(req('retired-token'))).status,401);
    assert.equal((await handle(req('bad'))).status,401);
    const stale=await handle(req('fixture-user',{kind:'title',indices:[0],lines:['Changed -> Target']}));assert.equal(stale.status,400);
    assert.equal(calls.length,0);
    const good=await handle(req());assert.equal(good.status,200);assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://danmu-rules-upload.cbzj.workers.dev/api/rules/submit');
    assert.deepEqual(JSON.parse(calls[0].options.body),{version:1,rules:[{kind:'title',line:'Local -> Target'}]});
    assert.ok(!JSON.stringify(calls).includes('fixture-user'));
    const tooLarge=await handle(new Request('http://localhost/fixture-user/api/title-mapping/share',{method:'POST',body:'x'.repeat(131073)}));assert.equal(tooLarge.status,413);
    globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await handle(req())).status,502);assert.equal(config.TITLE_MAPPING_TABLE,'Local -> Target;Another -> Other');
  }finally{globalThis.fetch=old;}
});
test('real route works with auth disabled and a single TOKEN',async()=>{
  const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({success:true,status:'pending_review',stored:1,duplicate:0,conflict:[],invalid:[]});
  try{
    assert.equal((await handle(req(''),{...config,TOKEN_AUTH_DISABLED:'true'})).status,200);
    assert.equal((await handle(req('fixture-user'),config)).status,200);
  }finally{globalThis.fetch=old;}
});
test('generated UI parses, escapes untrusted rules and splits marker semicolons',()=>{
  new vm.Script(systemSettingsJsContent);
  const extract=name=>{const start=systemSettingsJsContent.indexOf('function '+name+'(');let pos=systemSettingsJsContent.indexOf('{',start),depth=1;while(depth){pos++;if(systemSettingsJsContent[pos]==='{')depth++;if(systemSettingsJsContent[pos]==='}')depth--;}return systemSettingsJsContent.slice(start,pos+1);};
  const ctx=vm.createContext({uiIcon:()=>'',escapeHtml:s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')});
  vm.runInContext(extract('mappingShareLines')+';'+extract('renderMappingShareItem'),ctx);
  assert.equal(vm.runInContext("mappingShareLines('A -> B;C -> D').length",ctx),2);
  const html=vm.runInContext("renderMappingShareItem({key:'TITLE_MAPPING_TABLE',value:'<img src=x> -> Target'})",ctx);
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes(' checked'));assert.match(html,/上传/);
});
test('Node deployment request streams are supported without request.text buffering',async()=>{
  const {Request:NodeRequest}=await import('node-fetch');
  const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({success:true,status:'pending_review',stored:1,duplicate:0,conflict:[],invalid:[]});
  try{const r=await handle(new NodeRequest('http://localhost/fixture-user/api/title-mapping/share',{method:'POST',body:JSON.stringify({kind:'title',indices:[0],lines:['Local -> Target']})}));assert.equal(r.status,200);}finally{globalThis.fetch=old;}
});

test('upload outcomes include actionable diagnostics in the mapping log category without local rules or credentials',async()=>{
  const old=globalThis.fetch;
  const scenarios=[
    {response:()=>Response.json({success:false,error:'共享上传暂未启用'},{status:503}),status:502,match:/HTTP 503.*共享上传暂未启用/},
    {response:()=>new Response('<html>Gateway error</html>',{status:502}),status:502,match:/HTTP 502.*有效 JSON/},
    {response:()=>Response.json({success:false,error:'共享服务暂不可用',error_code:'github_read_baseline',failure_stage:'read_baseline',github_status:403},{status:502}),status:502,match:/failure_stage=read_baseline.*github_status=403/},
    {response:()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});},status:502,match:/无法解析共享服务域名.*ENOTFOUND/},
    {response:()=>{throw new DOMException('timeout','TimeoutError');},status:502,match:/请求超时/},
    {response:()=>Response.json({success:true,status:'pending_review',stored:1,duplicate:0,conflict:[],invalid:[]}),status:200,match:/上传完成.*新增 1 条/},
  ];
  try{
    for(const scenario of scenarios){
      Globals.logBuffer=[];
      globalThis.fetch=scenario.response;
      const response=await handle(req(),{...config,LOG_LEVEL:'info'});
      assert.equal(response.status,scenario.status);
      const logs=Globals.logBuffer.filter(entry=>entry.tags.includes('upload'));
      assert.ok(logs.length>=2);
      assert.ok(logs.every(entry=>entry.categories.includes('mapping')));
      assert.match(logs.map(entry=>entry.message).join('\n'),scenario.match);
      assert.ok(!JSON.stringify(logs).includes('fixture-user'));
      assert.ok(!JSON.stringify(logs).includes('Local -> Target'));
      if(scenario.match.source.includes('HTTP 503')) assert.equal((await response.json()).upstreamStatus,503);
    }
    assert.equal(config.TITLE_MAPPING_TABLE,'Local -> Target;Another -> Other');
  }finally{globalThis.fetch=old;Globals.logBuffer=[];}
});
