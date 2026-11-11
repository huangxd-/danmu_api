import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { handleRequest } from './worker.js';
import { getSourceByKey } from './sources/registry.js';
import { addAnime } from './utils/cache-util.js';

const base={TOKEN:'87654321',SOURCE_ORDER:'tencent',PLATFORM_ORDER:'tencent',MERGE_SOURCE_PAIRS:'',TITLE_MAPPING_TABLE:'',
  TITLE_MAPPING_TABLE_URL:'',AUTO_MATCH_MAPPING_TABLE:'',AUTO_MATCH_MAPPING_TABLE_URL:'',TMDB_API_KEY:'',PROXY_URL:'',
  BILIBILI_UGC_ENABLED:'false',BLOCK_DOMESTIC_CELEBRITIES:'false',BLOCKED_WORDS:'',LOCAL_CACHE_ENABLED:'false',
  LOCAL_REDIS_URL:'',USE_BANGUMI_DATA:'false',RATE_LIMIT_MAX_REQUESTS:'0',LOG_LEVEL:'error',GROUP_MINUTE:'0'};

function reset(extra={}){
  Globals.init({...base,...extra});
  for(const key of ['searchCache','commentCache','favoriteCache','lastSelectMap','requestHistory'])Globals[key]=new Map();
  Globals.animes=[];Globals.episodeIds=[];Globals.episodeNum=10001;
  Globals.localCacheValid=false;Globals.localRedisValid=false;
}

const candidate={animeId:81001,bangumiId:'b81001',source:'tencent',type:'动漫',typeDescription:'动漫',
  animeTitle:'异界漂泊记(2026)【动漫】from tencent',startDate:'2026-01-01',episodeCount:3,
  links:[{name:'第1集',title:'【tencent】 第1集 相遇',url:'https://v.qq.com/x/cover/a/e1.html'},
    {name:'第2集',title:'【tencent】 第2集 离别',url:'https://v.qq.com/x/cover/a/e2.html'},
    {name:'第3集',title:'【tencent】 第3集 重逢',url:'https://v.qq.com/x/cover/a/e3.html'}]};

const match=(fileName)=>handleRequest(new Request('http://localhost/87654321/api/v2/match',{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({fileName})}),Globals.env,'node','127.0.0.1').then(r=>r.json());

// 源只返回一个与请求标题无关的候选，保证常规标题匹配必然失败，只剩 AI 兜底
async function withStubs(run){
  const source=getSourceByKey('tencent');
  const saved={...source};
  source.search=async()=>[{title:candidate.animeTitle}];
  source.handleAnimes=async(_raw,_title,results,details)=>{addAnime(candidate,details);const{links,...dto}=candidate;results.push(dto);};
  source.getEpisodeDanmu=async()=>[];
  source.formatComments=raw=>raw;
  const originalFetch=globalThis.fetch;
  const calls=[];
  try{await run({calls,answer:(content)=>{globalThis.fetch=async(input,options)=>{const url=String(input);
    assert.match(url,/^https:\/\/ai\.test\/v1\/chat\/completions$/);
    calls.push({url,body:JSON.parse(options.body),auth:options.headers.authorization||options.headers.Authorization});
    return Response.json({choices:[{message:{content}}]});};}});}
  finally{Object.assign(source,saved);globalThis.fetch=originalFetch;}
}

test('AI 兜底在未配置密钥时不触发任何请求',async()=>{
  reset();
  await withStubs(async({calls})=>{
    globalThis.fetch=async()=>{throw new Error('未配置 AI 时不应发起请求');};
    const result=await match('流浪国度 S01E02');
    assert.equal(result.isMatched,false);
    assert.equal(calls.length,0);
  });
});

test('常规匹配失败后由 AI 选定作品并取对应分集',async()=>{
  reset({AI_API_KEY:'test-key',AI_BASE_URL:'https://ai.test/v1',AI_MODEL:'test-model'});
  await withStubs(async({calls,answer})=>{
    answer('{"anime":1,"episode":2,"reason":"别名对应同一部作品"}');
    const result=await match('流浪国度 S01E02');
    assert.equal(result.isMatched,true);
    assert.match(result.matches[0].url,/e2\.html/);
    assert.match(result.matches[0].episodeTitle,/第2集/);
    assert.equal(calls.length,1,'每个请求只调用一次 AI');
    assert.equal(calls[0].auth,'Bearer test-key');
    assert.equal(calls[0].body.model,'test-model');
    const prompt=calls[0].body.messages.at(-1).content;
    assert.match(prompt,/异界漂泊记/,'候选目录应进入提示词');
    assert.match(prompt,/第2集 离别/,'分集标题应进入提示词');
  });
});

test('AI 判定不是同一部作品或接口报错时保持未匹配',async()=>{
  reset({AI_API_KEY:'test-key',AI_BASE_URL:'https://ai.test/v1'});
  await withStubs(async({calls,answer})=>{
    answer('{"anime":0,"episode":0,"reason":"不是同一部作品"}');
    assert.equal((await match('流浪国度 S01E02')).isMatched,false);
    assert.equal(calls.length,1);
    globalThis.fetch=async()=>new Response('boom',{status:502});
    assert.equal((await match('流浪国度 S01E02')).isMatched,false);
  });
});

test('常规匹配成功时优先返回且不调用 AI',async()=>{
  reset({AI_API_KEY:'test-key',AI_BASE_URL:'https://ai.test/v1'});
  await withStubs(async({calls})=>{
    globalThis.fetch=async()=>{throw new Error('常规匹配成功时不应调用 AI');};
    const result=await match('异界漂泊记 S01E02');
    assert.equal(result.isMatched,true);
    assert.match(result.matches[0].url,/e2\.html/);
    assert.equal(calls.length,0);
  });
});

test('AI 只给出作品时按集号取集',async()=>{
  reset({AI_API_KEY:'test-key',AI_BASE_URL:'https://ai.test/v1'});
  await withStubs(async({answer})=>{
    answer('{"anime":1,"episode":0,"reason":"同一部作品但分集不确定"}');
    const result=await match('流浪国度 S01E03');
    assert.equal(result.isMatched,true);
    assert.match(result.matches[0].url,/e3\.html/);
  });
});
