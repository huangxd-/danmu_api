import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { parse } from 'parse5';
import { Globals } from './configs/globals.js';
import { handleRequest } from './worker.js';
import { getSourceByKey, getAllSourceMetas } from './sources/registry.js';
import { SUPPORTED_SOURCES } from './sources/policy.js';
import { addAnime, setSearchCache, getSearchCache, setCommentCache, getCommentCache, setPreferForTitle, getPreferAnimeId } from './utils/cache-util.js';

function reset(extra={}) {
  Globals.init({TOKEN:'87654321',SOURCE_ORDER:'tencent,bilibili',PLATFORM_ORDER:'tencent,bilibili',LOCAL_CACHE_ENABLED:'false',LOCAL_REDIS_URL:'',RATE_LIMIT_MAX_REQUESTS:'0',COMMENT_CACHE_MIN_COUNT:'0',MERGE_SOURCE_PAIRS:'',USE_BANGUMI_DATA:'false',LOG_LEVEL:'error',GROUP_MINUTE:'0',BLOCKED_WORDS:'',REMEMBER_LAST_SELECT:'false',...extra});
  for(const key of ['searchCache','commentCache','lastSelectMap','requestHistory']) Globals[key]=new Map();
  Globals.animes=[];Globals.episodeIds=[];Globals.episodeNum=10001;
  Globals.queryCacheInitialized=false;Globals.queryCacheWritable={};Globals.localCacheValid=false;Globals.localRedisValid=false;
}
const request=(route,method='GET',body)=>handleRequest(new Request('http://localhost'+route,{method,...(body!==undefined&&{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}),Globals.env,'node','127.0.0.1');
const comments=[{p:'1,1,16777215,[tencent]',m:'保留弹幕'}];
const anime=(source='tencent',title='测试作品',url='https://v.qq.com/x/cover/test.html')=>({animeId:11,bangumiId:source+'-11',animeTitle:title+'(2026)【动漫】from '+source,type:'动漫',typeDescription:'动漫',source,startDate:'2026-01-01',episodeCount:1,links:[{name:'第1集',title:'【'+source+'】 第1集',url,id:10002}]});

test('only supported sources survive old source configuration',()=>{
  reset({SOURCE_ORDER:'xigua,maiduidui,360,other,custom,local,renren,hanjutv,animeko,aiyifan,douban,tmdb,vod,tencent,bilibili'});
  assert.deepEqual(Globals.envs.sourceOrderArr,['renren','hanjutv','tencent','bilibili']);assert.deepEqual(getAllSourceMetas().map(m=>m.key),[...SUPPORTED_SOURCES]);
  for(const source of ['xigua','maiduidui','360','vod','tmdb','douban','animeko','aiyifan','custom','local','other'])assert.equal(getSourceByKey(source),null);
  reset({SOURCE_ORDER:'360,local'});assert.ok(Globals.envs.sourceOrderArr.length);assert.ok(Globals.envs.sourceOrderArr.every(s=>SUPPORTED_SOURCES.includes(s)));
});

test('dandan source and legacy configuration cannot be restored', async()=>{
  reset({SOURCE_ORDER:'dandan,tencent,bilibili',PLATFORM_ORDER:'dandan&tencent,dandan,bilibili',MERGE_SOURCE_PAIRS:'dandan&tencent;tencent&dandan&bilibili',DANDANPLAY_ACCOUNT:'obsolete',DANDANPLAY_PASSWORD:'obsolete'});
  assert.equal(getSourceByKey('dandan'),null);
  for(const retired of ['sources/dandan.js','utils/nipaplay-util.js','apis/dandan-api.js','models/dandan-model.js'])assert.equal(fs.existsSync(new URL(retired,import.meta.url)),false,retired);
  for(const current of ['apis/player-api.js','models/player-model.js'])assert.equal(fs.existsSync(new URL(current,import.meta.url)),true,current);
  assert.deepEqual(Globals.envs.sourceOrderArr,['tencent','bilibili']);
  assert.deepEqual(Globals.envs.platformOrderArr,['tencent','bilibili',null]);
  assert.deepEqual(Globals.envs.mergeSourcePairs,[{primary:'tencent',secondaries:['bilibili']}]);
  assert.equal(Globals.envs.dandanplayAccount,undefined);
  assert.equal(Globals.envs.dandanplayPassword,undefined);
  const config=await(await request('/api/config')).json();
  for(const key of ['DANDANPLAY_ACCOUNT','DANDANPLAY_PASSWORD']){
    assert.ok(!Object.hasOwn(config.envVarConfig,key));
    assert.ok(!Object.hasOwn(config.originalEnvVars,key));
    for(const action of ['set','add'])assert.equal((await request('/api/env/'+action,'POST',{key,value:'obsolete'})).status,400);
  }
  for(const key of ['SOURCE_ORDER','PLATFORM_ORDER','MERGE_SOURCE_PAIRS'])assert.ok(!config.envVarConfig[key].options.includes('dandan'));
  const html=await(await request('/')).text();
  for(const retired of ['DANDANPLAY_ACCOUNT','DANDANPLAY_PASSWORD','dandanplay-','nipaplay','NipaPlay'])assert.ok(!html.includes(retired),retired);
  reset({SOURCE_ORDER:'dandan',PLATFORM_ORDER:'dandan'});
  assert.ok(Globals.envs.sourceOrderArr.length);
  assert.ok(Globals.envs.sourceOrderArr.every(source=>SUPPORTED_SOURCES.includes(source)));
});

test('deleted routes return 404 through both token and short paths',async()=>{
  reset();
  for(const[route,method,body]of [['/api/reqrecords','GET'],['/api/v2/favorite/list','GET'],['/api/v2/favorite/add','POST',{}],['/api/favorite/refresh','POST',{}],['/api/v2/favorite/schedule','POST',{}],['/api/v2/local-danmu/upload','POST',{}],['/api/v2/local-danmu/list','GET'],['/api/v2/local-danmu/example','DELETE'],['/api/debug/forward-trace','POST',{}],['/api/ai/verify','POST',{}],['/api/nipaplay/verify','POST',{}],['/api/deploy','POST',{}]])
    for(const prefix of ['','/87654321'])assert.equal((await request(prefix+route,method,body)).status,404,route);
});

test('request records are removed while logging and rate limiting remain active',async()=>{
  reset({LOG_LEVEL:'info',RATE_LIMIT_MAX_REQUESTS:'1'});
  Globals.logBuffer=[];
  Globals.requestHistory.set('127.0.0.1',[Date.now()]);
  assert.equal((await request('/api/v2/comment/123')).status,429);
  assert.ok(Globals.logBuffer.length>0);
  assert.equal((await request('/api/logs')).status,200);
  assert.equal(Globals.reqRecords,undefined);
  assert.equal(Globals.todayReqNum,undefined);
});

test('custom token protects player APIs; deleted settings cannot be revived',async()=>{
  reset({TOKEN:'user-token',ADMIN_TOKEN:'admin-token',TOKEN_AUTH_DISABLED:'false'});
  assert.equal((await request('/api/v2/search/anime?keyword=')).status,401);
  assert.equal((await request('/wrong/api/v2/search/anime?keyword=')).status,401);
  assert.equal((await request('/user-token/api/v2/search/anime?keyword=')).status,200);
  assert.equal((await request('/user-token/api/env/set','POST',{key:'UPSTASH_REDIS_REST_URL',value:'obsolete'})).status,400);
  assert.equal((await request('/admin-token/api/env/set','POST',{key:'UPSTASH_REDIS_REST_URL',value:'obsolete'})).status,401);
  reset({AI_API_KEY:'obsolete',UPSTASH_REDIS_REST_URL:'https://never-request.test',IP_BLACKLIST:'127.0.0.1'});
  const config=await(await request('/api/config')).json();
  for(const key of ['TMDB_MATCH_ASSIST','TITLE_TO_CHINESE','AI_MATCH_PROMPT','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','IP_BLACKLIST','NODE_TLS_REJECT_UNAUTHORIZED','DEPLOY_PLATFROM_ACCOUNT','DEPLOY_PLATFROM_PROJECT','DEPLOY_PLATFROM_TOKEN','FAVORITE_REQUIRE_ADMIN','OTHER_SERVER','VOD_SERVERS']){
    assert.ok(!Object.hasOwn(config.envVarConfig,key),key);assert.ok(!Object.hasOwn(config.originalEnvVars,key),key);
    assert.equal((await request('/api/env/add','POST',{key,value:'obsolete'})).status,400,key);
  }
});

test('TOKEN auth is off unless explicitly enabled',async()=>{
  reset({TOKEN:'user-token'});
  assert.equal(Globals.envs.tokenAuthDisabled,true);
  assert.equal((await request('/api/v2/search/anime?keyword=')).status,200);
  assert.equal((await request('/wrong/api/v2/search/anime?keyword=')).status,404);
  assert.equal((await request('/user-token/api/v2/search/anime?keyword=')).status,200);
  reset({TOKEN:'user-token',TOKEN_AUTH_DISABLED:'false'});
  assert.equal(Globals.envs.tokenAuthDisabled,false);
  assert.equal((await request('/api/v2/search/anime?keyword=')).status,401);
});

test('official empty comments never contact a third-party fallback',async()=>{
  reset();const source=getSourceByKey('tencent'),original=source.getComments,originalFetch=globalThis.fetch;let calls=0;
  source.getComments=async()=>{calls++;return [];};globalThis.fetch=async()=>{throw Error('unexpected third-party fallback');};
  try{const response=await request('/api/v2/comment?url='+encodeURIComponent('https://v.qq.com/x/cover/test.html'));assert.equal(response.status,200);assert.deepEqual((await response.json()).comments,[]);assert.equal(calls,1);}
  finally{source.getComments=original;globalThis.fetch=originalFetch;}
});

test('removed URLs, stale IDs and segment types are rejected before cache hits',async()=>{
  reset();for(const url of ['dandan:123','https://api.dandanplay.net/api/v2/comment/123','https://m.ixigua.com/video/123','https://www.mddcloud.com.cn/test','https://www.yfsp.tv/play/test','https://bgm.tv/ep/123','local:old','https://example.test/?url=https://v.qq.com/test','https://v.qq.com.example.test/play']){
    setCommentCache(url,comments);assert.equal((await request('/api/v2/comment?url='+encodeURIComponent(url))).status,400,url);
    if(url.startsWith('http'))assert.equal((await request('/api/v2/search/anime?keyword='+encodeURIComponent(url))).status,400,url);
  }
  for(const url of ['dandan:123','https://api.dandanplay.net/api/v2/comment/123','https://www.yfsp.tv/play/test']){Globals.episodeIds=[{id:10099,url,title:'第1集'}];setCommentCache(url,comments);assert.equal((await request('/api/v2/comment/10099')).status,400);}
  for(const type of ['dandan','xigua','maiduidui','other_server','animeko','custom','local','aiyifan'])assert.equal((await request('/api/v2/segmentcomment','POST',{type,url:'cached-segment',segment_start:0,segment_end:60})).status,400,type);
});

test('supported source search/detail/comments/segments remain connected',async()=>{
  for(const platform of ['tencent','bilibili','hanjutv','renren']){
    reset({SOURCE_ORDER:platform,PLATFORM_ORDER:platform});const source=getSourceByKey(platform),originals={search:source.search,handleAnimes:source.handleAnimes,getComments:source.getComments,getSegmentComments:source.getSegmentComments};let searches=0,downloads=0;
    source.search=async()=>{searches++;return [];};source.handleAnimes=async(_,title,results,details)=>{const entry=anime(platform,title,platform==='bilibili'?'bilibili:123':platform==='hanjutv'?'tv:123':platform==='renren'?'series-123':'https://v.qq.com/x/cover/test.html');addAnime(entry,details);results.push(entry);};
    source.getComments=async()=>{downloads++;return structuredClone(comments);};source.getSegmentComments=async()=>structuredClone(comments);
    try{
      const result=await(await request('/api/v2/search/anime?keyword=测试作品')).json();assert.equal(result.success,true);assert.equal(result.animes.length,1);
      await request('/api/v2/search/anime?keyword=测试作品');assert.equal(searches,1);
      const detail=await(await request('/api/v2/bangumi/'+result.animes[0].animeId)).json();assert.ok(detail.bangumi);const id=detail.bangumi.episodes[0].episodeId;
      assert.equal((await(await request('/api/v2/comment/'+id)).json()).count,1);assert.equal((await(await request('/api/v2/comment/'+id)).json()).count,1);assert.equal(downloads,1);
      assert.match(await(await request('/api/v2/comment/'+id+'?format=xml')).text(),/<d p=/);
      assert.equal((await(await request('/api/v2/segmentcomment','POST',{type:platform,url:'sample-segment',segment_start:0,segment_end:60})).json()).count,1);
    }finally{Object.assign(source,originals);}
  }
});

test('cache TTL, capacity, disabled cache and manual preference semantics',()=>{
  reset();setSearchCache('作品',[anime()]);assert.equal(getSearchCache('作品').length,1);Globals.searchCache.get('作品').timestamp=Date.now()-600000;assert.equal(getSearchCache('作品'),null);
  setCommentCache('url',comments);assert.equal(getCommentCache('url').length,1);Globals.commentCache.get('url').timestamp=Date.now()-600000;assert.equal(getCommentCache('url'),null);
  for(let i=0;i<510;i++){setSearchCache('key'+i,[]);setCommentCache('url'+i,comments);}assert.equal(Globals.searchCache.size,500);assert.equal(Globals.commentCache.size,500);
  setPreferForTitle('作品',11,'tencent',2,3);assert.deepEqual(getPreferAnimeId('作品',2).slice(0,2),[11,'tencent']);
  reset({SEARCH_CACHE_MINUTES:'0',COMMENT_CACHE_MINUTES:'0'});setSearchCache('off',[]);setCommentCache('off',comments);assert.equal(getSearchCache('off'),null);assert.equal(getCommentCache('off'),null);
});

test('management scripts parse and only retained navigation is rendered',async()=>{
  reset();const html=await(await request('/')).text();
  for(const text of ['请求记录','reqrecords','total-requests-today','接口调试','推送弹幕','本地弹幕','UPSTASH_REDIS_REST_URL','DEPLOY_PLATFROM_ACCOUNT'])assert.ok(!html.includes(text),text);
  let scripts=0;function visit(n){if(n.tagName==='script'){new vm.Script((n.childNodes||[]).map(c=>c.value||'').join(''));scripts++;}(n.childNodes||[]).forEach(visit);}visit(parse(html));assert.ok(scripts);
  for(const id of ['preview-section','logs-section','env-section'])assert.ok(html.includes('id="'+id+'"'));
});

test('header shows the injected self version and hides the update badge until a newer release exists', async () => {
  reset({ XDANMU_VERSION: 'xdanmu-v0.99' });
  const html = await (await request('/')).text();
  assert.match(html, /<title>Xdanmu<\/title>/);
  assert.match(html, /<h1>Xdanmu<\/h1>/);
  assert.match(html, /当前版本: <span id="current-version">v0\.99<\/span>/);
  assert.match(html, /<a class="update-badge"[^>]*style="display: none;"/);
  assert.ok(!html.includes('LogVar弹幕API'), 'old brand must be gone');
  // 品牌标记与页签图标改为内联 SVG，不再引用第三方图片
  assert.match(html, /<div class="logo"[^>]*><svg class="logo-mark"/);
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.ok(!html.includes('i.mji.rip'), 'third-party brand image must be gone');

  reset();
  const fallback = await (await request('/')).text();
  assert.match(fallback, /当前版本: <span id="current-version">v1\.21\.3<\/span>/, 'no injected version falls back to the upstream version');
});

test('self version comparison and release badge parsing drive the update badge', async () => {
  reset();
  const html = await (await request('/')).text();
  const start = html.indexOf('const SELF_RELEASE_BADGE_URL');
  const end = html.indexOf('function switchSection');
  assert.ok(start > 0 && end > start, 'self version helpers are emitted to the browser');
  const slice = html.slice(start, end);

  // 用真实发出的浏览器脚本 + 桩 document/fetch 验证徽标显示逻辑
  const build = (currentText, svg) => {
    const badge = { href: '', style: { display: 'none' } };
    const latest = { textContent: '' };
    const nodes = { 'current-version': { textContent: currentText }, 'update-badge': badge, 'latest-version': latest };
    const factory = new Function('document', 'fetch', slice + '; return { isNewerVersion, checkLatestVersion };');
    const api = factory({ getElementById: id => nodes[id] || null }, () => Promise.resolve({ text: () => Promise.resolve(svg) }));
    return { ...api, badge, latest };
  };

  const newer = build('v0.60', '<title>release: xdanmu-v0.61</title>');
  assert.equal(newer.isNewerVersion('v0.61', 'v0.60'), true);
  assert.equal(newer.isNewerVersion('v0.60', 'v0.60'), false);
  assert.equal(newer.isNewerVersion('v0.9', 'v0.10'), false, 'v0.9 is older than v0.10');
  assert.equal(newer.isNewerVersion('v0.10', 'v0.9'), true);
  assert.equal(newer.isNewerVersion('v1.21.3', 'v0.60'), true);
  assert.equal(newer.isNewerVersion('', 'v0.60'), false);

  // 有新版本：显示「最新版本」并链接到对应 Release
  await newer.checkLatestVersion();
  assert.equal(newer.latest.textContent, 'v0.61');
  assert.equal(newer.badge.style.display, '');
  assert.equal(newer.badge.href, 'https://github.com/xlmc/danmu_api/releases/tag/xdanmu-v0.61');

  // 没有新版本：只保留「当前版本」，徽标保持隐藏
  const same = build('v0.61', '<title>release: xdanmu-v0.61</title>');
  await same.checkLatestVersion();
  assert.equal(same.latest.textContent, '');
  assert.equal(same.badge.style.display, 'none');

  // shields.io 的 tag 徽标同样以 <title> 携带版本
  const tagFormat = build('v0.60', '<title>tag: xdanmu-v0.61</title>');
  await tagFormat.checkLatestVersion();
  assert.equal(tagFormat.latest.textContent, 'v0.61');
});

test('file cache restores IDs/preferences and prunes removed sources across actual restarts',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'danmu-nas-test-')),checkout=fileURLToPath(new URL('../',import.meta.url));
  try{
    fs.cpSync(new URL('./',import.meta.url),path.join(temporary,'danmu_api'),{recursive:true});fs.writeFileSync(path.join(temporary,'package.json'),'{"type":"module"}');fs.symlinkSync(path.join(checkout,'node_modules'),path.join(temporary,'node_modules'),'junction');fs.mkdirSync(path.join(temporary,'.cache'));
    const kept=anime(),removed={...anime('dandan','旧作品','dandan:old'),animeId:12,links:[{id:10003,url:'dandan:old',title:'第1集'}]};
    const hj={...anime('hanjutv','韩剧测试','tv:123'),animeId:13,links:[{id:10004,url:'tv:123',title:'【hanjutv】 第1集'}]};
    const rr={...anime('renren','人人测试','100-123'),animeId:14,links:[{id:10005,url:'100-123',title:'【renren】 第1集'}]};
    for(const[key,value]of Object.entries({animes:[kept,removed,hj,rr],episodeIds:[{id:10002,url:kept.links[0].url},{id:10003,url:'dandan:old'},{id:10004,url:'tv:123',title:'【hanjutv】 第1集'},{id:10005,url:'100-123',title:'【renren】 第1集'}],episodeNum:10005,lastSelectMap:{作品:{animeIds:[11],preferBySeason:{1:12,2:11,3:12},sourceBySeason:{1:'dandan',2:'tencent',3:'tencent&dandan'},offsets:{1:5,2:3,3:8},explicitBySeason:{1:true,2:true,3:true}}},reqRecords:[{interface:'legacy-record'}],todayReqNum:99}))fs.writeFileSync(path.join(temporary,'.cache',key),JSON.stringify(value));
    const code=`import assert from 'node:assert/strict';import {Globals} from './danmu_api/configs/globals.js';import {initializePersistentCaches} from './danmu_api/utils/persistent-cache-util.js';import {getPreferAnimeId,updateLocalCaches} from './danmu_api/utils/cache-util.js';Globals.init({LOCAL_CACHE_ENABLED:'true',LOCAL_REDIS_URL:'',LOG_LEVEL:'error'});Globals.deployPlatform='node';await initializePersistentCaches();assert.equal(Globals.reqRecords,undefined);assert.equal(Globals.todayReqNum,undefined);assert.equal(Globals.animes.length,3);assert.equal(Globals.episodeIds.length,3);assert.equal(Globals.episodeNum,10005);assert.ok(Globals.animes.some(a=>a.source==='hanjutv'));assert.ok(Globals.animes.some(a=>a.source==='renren'));assert.equal(getPreferAnimeId('作品',2)[0],11);assert.deepEqual(Globals.lastSelectMap.get('作品').sourceBySeason,{'2':'tencent'});assert.deepEqual(Globals.lastSelectMap.get('作品').offsets,{'2':3});assert.deepEqual(Globals.lastSelectMap.get('作品').preferBySeason,{'2':11});assert.equal(await updateLocalCaches(),true);`;
    for(let i=0;i<2;i++){const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:temporary,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);}
    fs.writeFileSync(path.join(temporary,'.cache','animes'),'{broken');const r=spawnSync(process.execPath,['--input-type=module','-e',code.replace('assert.equal(Globals.animes.length,3);','assert.equal(Globals.animes.length,0);').replace('assert.equal(Globals.episodeIds.length,3);','assert.equal(Globals.episodeIds.length,1);').replace("assert.ok(Globals.animes.some(a=>a.source==='hanjutv'));assert.ok(Globals.animes.some(a=>a.source==='renren'));",'')],{cwd:temporary,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);assert.ok(fs.readdirSync(path.join(temporary,'.cache')).some(n=>n.startsWith('animes.bak-')));
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
