import { resolveSegmentCacheKey } from './apis/comment-api.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { extractBaiduPersonMetadata, getBaiduPersonMetadata } from './utils/baidu-person-util.js';
import { getDomesticPersonMetadataForTitle, getBangumiSeriesCharacterNames } from './utils/tmdb-util.js';
import { cachedPersonSource, personCacheIdentity, readCachedPersonSources } from './utils/person-source-cache.js';
import { getComment, getCommentByUrl, getSegmentComment } from './apis/player-api.js';
import { setCommentCache } from './utils/cache-util.js';
import { filterDanmusByBlockedNames } from './utils/danmu-util.js';
import { getSourceByKey } from './sources/registry.js';

const castRow = (actor, role) => `<div class="actorItem_example"><dl><dt><a>${actor}</a>&nbsp;饰&nbsp;<span>${role}</span></dt></dl></div>`;

test('弹幕下载期间角色补齐后，普通、URL及分段入口使用最新名单', async t => {
  Globals.init({ BLOCK_DOMESTIC_CELEBRITIES: 'true', USE_BANGUMI_DATA: 'false',
    BILIBILI_UGC_ENABLED: 'false', BLOCKED_WORDS: '', GROUP_MINUTE: '0',
    COMMENT_CACHE_MIN_COUNT: '0', LOCAL_CACHE_ENABLED: 'false', LOG_LEVEL: 'warn' });
  Globals.commentCache = new Map();
  const title = '最新角色名单回归', animeTitle = `${title}(2026)【动漫】from tencent`;
  const key = await personCacheIdentity([title, '2026', '', '', false]);
  await cachedPersonSource(`${key}:identity`, async () => ({ id: 990871, media_type: 'tv', name: title,
    first_air_date: '2026-01-01', genre_ids: [16] }), () => true);
  await cachedPersonSource(`${key}:tv/990871:credits-v2`, async () => ({ actorNames: ['原演员'], characterNames: [] }), () => true);
  await cachedPersonSource(`${key}:wiki`, async () => ({ actorNames: [], characterNames: [] }), () => true);
  let release, finishRelations;
  const held = new Promise(resolve => { release = resolve; });
  const relationsHeld = new Promise(resolve => { finishRelations = resolve; });
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input);
    if (url.includes('/search/subject/')) return Response.json({ list: [{ id: 990872, type: 2, name: title, air_date: '2026-01-01' }] });
    if (url.endsWith('/characters')) { await held; return Response.json([{ name: '孟川' }, { name: '柳七月' }]); }
    if (url.endsWith('/subjects')) { await relationsHeld; return Response.json([]); }
    throw new Error('unexpected request');
  });
  const comments = ['孟川来了', '阿川来了', '柳七月来了', '剧情很好看'].map((m, i) => ({ p: `${i + 1},1,16777215,[tencent]`, m }));
  const download = async () => {
    await held;
    await new Promise(resolve => setImmediate(resolve));
    const metadata = await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true });
    assert.ok(metadata.characterNames.includes('孟川'));
    return structuredClone(comments);
  };
  const source = getSourceByKey('tencent');
  t.mock.method(source, 'getComments', download);
  t.mock.method(source, 'getSegmentComments', download);
  const url = 'https://v.qq.com/x/cover/latest-person/episode.html';
  Globals.animes = [{ animeTitle, links: [{ id: 990871, url, title: '第1集' }] }];
  const responses = [getComment('/api/v2/comment/990871', 'json', false), getCommentByUrl(url, 'json', false),
    getSegmentComment({ type: 'tencent', url: 'latest-person-segment', animeTitle, sourceUrl: url }, 'json')];
  const timer = setTimeout(release, 1650);
  try {
    for (const response of await Promise.all(responses)) {
      assert.deepEqual((await response.json()).comments.map(comment => comment.m), ['剧情很好看']);
    }
  } finally {
    clearTimeout(timer); release(); finishRelations();
    await Promise.allSettled(responses);
    await getDomesticPersonMetadataForTitle(animeTitle);
    Globals.animes = []; Globals.commentCache = new Map(); Globals.init({});
  }
});

test('身份查询慢或失败时立即复用已有角色缓存，最新快照不发请求且隔离作品和配置', async t => {
  Globals.init({ LOG_LEVEL: 'error', USE_BANGUMI_DATA: 'false' });
  const title = '旧角色缓存回归', animeTitle = `${title}(2026)【动漫】from tencent`;
  const key = await personCacheIdentity([title, '2026', '', '', false]);
  await cachedPersonSource(`${key}:bangumi`, async () => ({ names: ['孟川'], subjectIds: [990881] }), () => true);
  await cachedPersonSource(`${key}:wiki`, async () => ({ actorNames: [], characterNames: [] }), () => true);
  let release, requests = 0;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { requests++; await held; throw new Error('身份查询失败'); });
  let complete;
  try {
    const cached = await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true });
    assert.deepEqual(cached.characterNames, ['孟川']);
    assert.equal(requests, 0, '只读快照不得启动网络查询');
    cached.characterNames.length = 0;
    assert.deepEqual((await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true })).characterNames, ['孟川']);
    complete = getDomesticPersonMetadataForTitle(animeTitle);
    const partial = await getDomesticPersonMetadataForTitle(animeTitle, { budgetMs: 25 });
    assert.deepEqual(partial.characterNames, ['孟川']);
    const beforePeek = requests;
    assert.deepEqual((await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true })).characterNames, ['孟川']);
    assert.equal(requests, beforePeek);
    assert.deepEqual((await getDomesticPersonMetadataForTitle('其他作品(2026)', { cachedOnly: true })).names, []);
    assert.deepEqual((await getDomesticPersonMetadataForTitle(`${title}(2025)`, { cachedOnly: true })).names, []);
    Globals.init({ LOG_LEVEL: 'error', TMDB_API_KEY: 'other-config' });
    assert.deepEqual((await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true })).names, []);
    Globals.init({ LOG_LEVEL: 'error' });
    release();
    assert.deepEqual((await complete).characterNames, ['孟川'], '刷新失败仍保留旧角色');
  } finally {
    release(); await complete; Globals.init({});
  }
});

test('分来源缓存部分刷新和失败均不丢弃已确认角色', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  for (const [name, previous, updated] of [
    ['cast', { actorNames: ['旧演员'], characterNames: ['孟川'], incomplete: false },
      { actorNames: ['新演员'], characterNames: ['柳七月'], incomplete: true }],
    ['bangumi', { names: ['孟川'], incomplete: false }, { names: ['柳七月'], incomplete: true }]
  ]) {
    const key = `partial-refresh-regression:${name}`, usable = value => Boolean(value);
    const complete = value => !value.incomplete;
    await cachedPersonSource(key, async () => previous, usable, complete);
    now += 86400001;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const stale = await cachedPersonSource(key, async () => { await held; return updated; }, usable, complete);
    assert.deepEqual(stale.value, previous);
    release(); await new Promise(resolve => setImmediate(resolve));
    const refreshed = (await readCachedPersonSources('partial-refresh-regression:')).get(name);
    const names = name === 'cast' ? refreshed.value.characterNames : refreshed.value.names;
    assert.deepEqual(names, ['孟川', '柳七月']);
    assert.equal(refreshed.stale, true);
    now += 300001;
    await cachedPersonSource(key, async () => { throw new Error('刷新失败'); }, usable, complete);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await readCachedPersonSources('partial-refresh-regression:')).get(name).value, refreshed.value);
  }
  Globals.init({});
});
const html = (title, rows = castRow('方逸伦', '宁长樾'), {year = '2026', region = '中国大陆', type = '电视剧'} = {}) =>
  `<title>${title}（${year}年导演执导的${type}）_百度百科</title>
   <div><dt class="basicInfoItem_test">制片地区</dt><dd>${region}</dd></div>
   <div><dt class="basicInfoItem_test">首播时间</dt><dd>${year}年9月24日<sup>[1]</sup></dd></div>
   <p>剧情提到无关人物，导演也不能当作演员。</p>${rows}`;

test('人物本名和别名从 TMDB 详情及百科演员链接补全，缓存复用且不采集简介人名', async () => {
  Globals.init({LOG_LEVEL:'error'});
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const path = decodeURIComponent(new URL(url).pathname);
    calls.push(path);
    if (path.endsWith('/aggregate_credits')) return Response.json({cast:[
      {id:990801,name:'演员甲',original_name:'演员甲',roles:[{character:'角色甲'}]},
      {id:990802,name:'演员乙',roles:[{character:'角色乙'}]},
    ]});
    if (path === '/3/person/990801') return Response.json({id:990801,name:'演员甲',also_known_as:['本名甲','演员甲','Former Name']});
    if (path === '/3/person/990802') return new Response('Forbidden',{status:403});
    if (path === '/item/演员丙/990803') return new Response('<title>演员丙（中国内地演员）_百度百科</title>'
      + '<div><dt class="basicInfoItem_test">艺名</dt><dd>演员丙</dd></div>'
      + '<div><dt class="basicInfoItem_test">本名</dt><dd>本名丙</dd></div>'
      + '<div><dt class="basicInfoItem_test">别名</dt><dd>别名丙、昵称丙</dd></div>'
      + '<p>合作演员无关人物，亲属另一人物。</p>');
    if (path === '/item/演员丁/990804') return new Response('Forbidden',{status:403});
    return new Response(html('百科别名回归', castRow('<a href="/item/演员丙/990803">演员丙</a>','角色丙')
      + castRow('<a href="/item/演员丁/990804">演员丁</a>','角色丁')));
  };
  try {
    const key = await personCacheIdentity(['别名回归','2026','','',Boolean(Globals.envs.useBangumiData)]);
    await cachedPersonSource(`${key}:identity`,async()=>({id:990801,media_type:'tv',name:'别名回归',first_air_date:'2026-01-01'}),()=>true);
    await cachedPersonSource(`${key}:wiki`,async()=>({actorNames:[],characterNames:[]}),()=>true);
    const metadata = await getDomesticPersonMetadataForTitle('别名回归(2026)');
    assert.deepEqual(metadata.actorNames,['演员甲','演员乙','本名甲']);
    assert.equal(metadata.status,'partial', 'one failed person detail preserves the cast and reports partial data');
    const again = await getDomesticPersonMetadataForTitle('别名回归(2026)');
    assert.deepEqual(again.actorNames,metadata.actorNames);
    assert.equal(calls.filter(path=>path.startsWith('/3/person/')).length,2);
    const baidu = await getBaiduPersonMetadata('百科别名回归','2026','tv');
    assert.deepEqual(baidu.actorNames,['演员丙','演员丁','本名丙','别名丙','昵称丙']);
    assert.equal(baidu.aliasesIncomplete,true);
    await getBaiduPersonMetadata('百科别名回归','2026','tv');
    assert.equal(calls.filter(path=>path==='/item/演员丙/990803').length,1);
    assert.equal(calls.filter(path=>path==='/item/演员丁/990804').length,1);
    const actors = [...metadata.actorNames,...baidu.actorNames];
    const comments = ['本名甲来了','本名丙来了','别名丙来了','昵称丙来了','无关人物来了','剧情很好看'].map(m=>({m}));
    assert.deepEqual(filterDanmusByBlockedNames(comments,[],{actorNames:actors}).danmus.map(c=>c.m),['无关人物来了','剧情很好看']);
  } finally { globalThis.fetch=original; Globals.init({}); }
});

test('百度演员表只提取姓名，排除注释、简介和空角色', () => {
  const result = extractBaiduPersonMetadata(html('长生契', castRow('方逸伦<sup>[2]</sup>', '宁长樾')
    + castRow('栾竣淏', '-') + castRow('林小宅', '喻涂（青年）')
    + '<dt>导演 饰 无关人物</dt>'), {title:'长生契', year:'2026', mediaType:'tv'});
  assert.deepEqual(result.actorNames, ['方逸伦','栾竣淏','林小宅']);
  assert.deepEqual(result.characterNames, ['宁长樾','喻涂']);
});

test('拒绝错误名称、年份、小说、电影/剧集冲突、海外作品和验证页', () => {
  const context = {title:'长生契',year:'2026',mediaType:'tv'};
  for (const body of [html('另一部'), html('长生契','',{year:'2020'}),
    html('长生契','',{type:'网络小说'}), html('长生契','',{type:'电影'}),
    html('长生契','',{region:'日本'}), '<title>百度安全验证</title>']) {
    assert.throws(() => extractBaiduPersonMetadata(body, context));
  }
  assert.throws(() => extractBaiduPersonMetadata(html('长生契'),{...context,title:'长生契第二季'}));
  assert.deepEqual(extractBaiduPersonMetadata(html('流浪地球',castRow('吴京','刘培强'),{year:'2019',type:'科幻片'}),
    {title:'流浪地球',year:'2019',mediaType:'movie'}).characterNames,['刘培强']);
});

// 综艺/真人秀条目的字段名和名单结构都不同（《短剧X家族》就是这种）：
// 活动类型/地点/时间 + 一张没有表头的嘉宾名单表，此前会被判成「未找到匹配条目」。
test('综艺式字段与无表头嘉宾表也能取到名单', () => {
  const variety = ({ region = '福建平潭、吉林长白山',
    date = '<div><dt class="basicInfoItem_test">时&nbsp;&nbsp;&nbsp;&nbsp;间</dt><dd>2026年5月29日</dd></div>',
    schedule = '' } = {}) => `<title>短剧X家族_百度百科</title>
   <div><dt class="basicInfoItem_test">活动类型</dt><dd>户外真人秀</dd></div>
   <div><dt class="basicInfoItem_test">地&nbsp;&nbsp;&nbsp;&nbsp;点</dt><dd>${region}</dd></div>${date}
   <table><tr><td>陈添祥</td><td>贾翼瑄</td><td>刘萧旭</td><td>林墨</td></tr>
          <tr><td>申浩男</td><td>王小亿</td><td>沉思</td><td>侯呈玥</td></tr></table>${schedule}`;
  const context = { title: '短剧X家族', year: '2026', mediaType: 'tv' };
  const result = extractBaiduPersonMetadata(variety(), context);
  assert.deepEqual(result.actorNames, ['陈添祥', '贾翼瑄', '刘萧旭', '林墨', '申浩男', '王小亿', '沉思', '侯呈玥']);
  assert.deepEqual(result.characterNames, []);
  // 播出信息表（日期 + 长标题）不满足名单形状，不会被当成演员
  const schedule = '<table><tr><td>2026年5月29日</td><td>第1期：X家族全员“白手起家”</td></tr>'
    + '<tr><td>2026年6月5日</td><td>第2期：爆笑高能预警！闽南语加更</td></tr></table>';
  assert.equal(extractBaiduPersonMetadata(variety({ schedule }), context).actorNames.length, 8);
  // 拍摄地在海外时仍然拒绝
  assert.throws(() => extractBaiduPersonMetadata(variety({ region: '首尔' }), context), /未确认国产/);
  // 页面没有日期字段时不再因为取不到年份就否掉整条
  assert.equal(extractBaiduPersonMetadata(variety({ date: '' }), context).actorNames.length, 8);
  // 年份真的不一致时仍然拒绝
  assert.throws(() => extractBaiduPersonMetadata(variety({ date: '<div><dt class="basicInfoItem_test">时&nbsp;&nbsp;&nbsp;&nbsp;间</dt><dd>2025年5月29日</dd></div>' }), context), /年份不一致/);
});

test('同名义项按年份和类型唯一选择，冲突时不请求详情', async () => {
  Globals.init({LOG_LEVEL:'error'});
  const original = globalThis.fetch;
  const calls = [];
  const link = (id, desc) => `<a href="/item/长生契/${id}?fromModule=disambiguation">${desc}</a>`;
  let ambiguous = false;
  globalThis.fetch = async url => {
    calls.push(String(url));
    return new Response(String(url).includes('/67411207?') ? html('长生契') :
      `<title>长生契_百度百科</title>${link(1,'网络小说')}${link(67411207,'2026年奇幻情感剧')}
       ${ambiguous ? link(2,'2026年电视剧') : link(3,'2020年电视剧')}`);
  };
  try {
    const result = await getBaiduPersonMetadata('长生契','2026','tv');
    assert.deepEqual(result.characterNames,['宁长樾']);
    assert.equal(calls.length,2);
    ambiguous=true; calls.length=0;
    await assert.rejects(getBaiduPersonMetadata('长生契','2026','tv'),/唯一匹配/);
    assert.equal(calls.length,1);
  } finally { globalThis.fetch=original; Globals.init({}); }
});

async function seed(title, actors, roles, {candidate=true, wikiRoles=[]} = {}) {
  const key = await personCacheIdentity([title,'2026','','',Boolean(Globals.envs.useBangumiData)]);
  await cachedPersonSource(`${key}:identity`, async () => candidate ? {id:990701,media_type:'tv',name:title,
    original_language:'zh',origin_country:['CN'],first_air_date:'2026-09-24',genre_ids:[]} : null, value=>Boolean(value));
  if (candidate) await cachedPersonSource(`${key}:tv/990701:credits-v2`,async()=>({actorNames:actors,characterNames:roles}),()=>true);
  await cachedPersonSource(`${key}:wiki`,async()=>({actorNames:[],characterNames:wikiRoles}),()=>true);
}

test('人物别名慢请求不阻塞已取得名单，后续请求复用补齐缓存', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const title = '人物慢查询回归';
  const key = await personCacheIdentity([title, '2026', '', '', false]);
  await cachedPersonSource(`${key}:identity`, async () => ({ id: 990811, media_type: 'tv', name: title,
    first_air_date: '2026-01-01', genre_ids: [] }), () => true);
  await cachedPersonSource(`${key}:wiki`, async () => ({ actorNames: [], characterNames: [] }), () => true);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const original = globalThis.fetch;
  let aliasRequests = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('/aggregate_credits')) return Response.json({ cast: [
      { id: 990812, name: '演员甲', roles: [{ character: '角色甲' }] }
    ] });
    assert(String(url).includes('/person/990812'));
    aliasRequests++;
    await held;
    return Response.json({ id: 990812, name: '演员甲', also_known_as: ['别名甲'] });
  };
  try {
    const partial = await getDomesticPersonMetadataForTitle(`${title}(2026)`, { budgetMs: 25 });
    assert.equal(partial.status, 'partial');
    assert(partial.actorNames.includes('演员甲'));
    assert(partial.characterNames.includes('角色甲'));
    assert(!partial.names.includes('别名甲'));
    assert.deepEqual(filterDanmusByBlockedNames([{ m: '演员甲出场' }, { m: '角色甲出场' }, { m: '剧情很好看' }], partial.names).danmus.map(c => c.m), ['剧情很好看']);
    release();
    const complete = await getDomesticPersonMetadataForTitle(`${title}(2026)`);
    assert(complete.actorNames.includes('别名甲'));
    await getDomesticPersonMetadataForTitle(`${title}(2026)`);
    assert.equal(aliasRequests, 1);
    assert(!partial.names.includes('别名甲'), '已返回的快照不会被后台查询修改');
  } finally { release(); globalThis.fetch = original; Globals.init({}); }
});

test('Bangumi角色查询完成后立即提供名单，不等待慢季度关系', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const original = globalThis.fetch;
  let release, progress;
  const held = new Promise(resolve => { release = resolve; });
  const progressed = new Promise(resolve => { progress = resolve; });
  globalThis.fetch = async url => {
    if (String(url).endsWith('/characters')) return Response.json([{ name: '藤原拓海' }]);
    await held;
    return Response.json([]);
  };
  const task = getBangumiSeriesCharacterNames(990813, progress);
  let timer;
  try {
    const names = await Promise.race([progressed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
    assert.deepEqual(names, ['藤原拓海']);
    release();
    assert.deepEqual((await task).names, ['藤原拓海']);
  } finally { clearTimeout(timer); release(); await task; globalThis.fetch = original; Globals.init({}); }
});

test('真实人物加载入口按缺项补查，演员表取并集，失败不丢弃已有资料', async () => {
  Globals.init({LOG_LEVEL:'error'});
  const original = globalThis.fetch;
  const calls=[];
  globalThis.fetch=async url=>{
    calls.push(String(url));
    const title=decodeURIComponent(new URL(url).pathname.split('/')[2]);
    if(title==='补查失败') return new Response('Forbidden',{status:403});
    return new Response(html(title));
  };
  try {
    for (const [title,actors,roles,options,expectedActors,expectedRoles,requests] of [
      ['名单齐全',['原演员'],['原角色'],{},['原演员'],['原角色'],0],
      ['仅缺角色',['原演员'],[],{},['原演员','方逸伦'],['宁长樾'],1],
      // 真实场景（《短剧X家族》）：TMDB 有演员但比百度少，两边要取并集，否则百度独有的演员永远拦不住
      ['演员不全',['原演员','甲'],[],{},['原演员','甲','方逸伦'],['宁长樾'],1],
      ['全部缺失',[],[],{candidate:false},['方逸伦'],['宁长樾'],1],
      ['维基已有',['原演员'],[],{wikiRoles:['维基角色']},['原演员'],['维基角色'],0],
      ['补查失败',['原演员'],[],{},['原演员'],[],1],
    ]) {
      await seed(title,actors,roles,options); calls.length=0;
      const result=await getDomesticPersonMetadataForTitle(`${title}(2026)`);
      assert.deepEqual(result.actorNames,expectedActors,title);
      assert.deepEqual(result.characterNames,expectedRoles,title);
      assert.equal(calls.length,requests,title);
      await getDomesticPersonMetadataForTitle(`${title}(2026)`);
      assert.equal(calls.length,requests,`${title} 使用缓存或失败退避`);
    }
  } finally { globalThis.fetch=original; Globals.init({}); }
});

test('百度补充的角色经普通、URL和分段弹幕入口实际过滤，缓存不重复查询', async () => {
  const title='百科入口回归';
  Globals.init({BLOCK_DOMESTIC_CELEBRITIES:'true',COMMENT_CACHE_MIN_COUNT:'0',LOG_LEVEL:'error'});
  await seed(title,['原演员'],[]);
  const url='https://v.qq.com/x/cover/baidu-person-test/episode.html';
  Globals.animes=[{animeTitle:`${title}(2026)`,links:[{id:990701,url}]}];
  const comments=['宁长樾出场','原演员来了','剧情很好看'].map((m,i)=>({p:`${i+1},1,16777215,[test]`,m}));
  setCommentCache(url,comments);
  const segment={type:'tencent',url:'baidu-test-segment',animeTitle:`${title}(2026)`,sourceUrl:url};
  setCommentCache(resolveSegmentCacheKey(segment),comments);
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async request=>{
    assert.equal(new URL(request).hostname,'bkso.baidu.com'); calls++;
    return new Response(html(title));
  };
  try {
    const responses=[await getCommentByUrl(url,'json',false),await getComment('/api/v2/comment/990701','json',false),await getSegmentComment(segment,'json')];
    for (const response of responses) assert.deepEqual((await response.json()).comments.map(c=>c.m),['剧情很好看']);
    assert.equal(calls,1);
  } finally { globalThis.fetch=original; Globals.init({}); Globals.animes=[]; Globals.commentCache=new Map(); }
});
