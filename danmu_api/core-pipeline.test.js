import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { handleRequest } from './worker.js';
import { getSourceByKey } from './sources/registry.js';
import { addAnime, setCommentCache, setLastSearch, storeAnimeIdsToMap, getPreferAnimeId } from './utils/cache-util.js';
import { convertToDanmakuJson } from './utils/danmu-util.js';
import HongguoSource from './sources/hongguo.js';

function reset(extra = {}) {
  Globals.init({ TOKEN: '87654321', LOCAL_CACHE_ENABLED: 'false', LOCAL_REDIS_URL: '',
    BILIBILI_UGC_ENABLED: 'false', BLOCK_DOMESTIC_CELEBRITIES: 'false', BLOCKED_WORDS: '',
    USE_BANGUMI_DATA: 'false', LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0',
    GROUP_MINUTE: '0', COMMENT_CACHE_MIN_COUNT: '0', COMMENT_CACHE_MINUTES: '30',
    DANMU_OFFSET: '', REMEMBER_LAST_SELECT: 'false', ...extra });
  Globals.animes = []; Globals.episodeIds = []; Globals.episodeNum = 10001;
  Globals.commentCache = new Map(); Globals.lastSelectMap = new Map(); Globals.requestHistory = new Map();
}
const request = (route, body) => handleRequest(new Request(`http://localhost${route}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), Globals.env, 'node', '127.0.0.1');
const byUrl = url => request('/api/v2/comment?url=' + encodeURIComponent(url));
const comment = (m, time = 5) => ({ p: `${time},1,16777215`, m });
function episode(url, title = '测试作品', source = 'tencent') {
  addAnime({ animeId: Globals.animes.length + 1, bangumiId: title, animeTitle: `${title}(2021)【动漫】`, source,
    links: [{ title: `【${source}】 第1集`, url }] });
  return Globals.animes.at(-1).links[0].id;
}

test('统一 TOKEN 读取完整配置，旧管理员令牌与匿名请求不能访问配置', async () => {
  reset({ TOKEN: 'viewer-token', TOKEN_AUTH_DISABLED: 'false', ADMIN_TOKEN: 'retired-admin', TMDB_API_KEY: 'private-api-key' });
  const config = await (await request('/viewer-token/api/config')).json();
  assert.equal(config.originalEnvVars.TMDB_API_KEY, 'private-api-key');
  assert.ok(!Object.hasOwn(config.envVarConfig, 'ADMIN_TOKEN'));
  assert.ok(!Object.hasOwn(config.originalEnvVars, 'ADMIN_TOKEN'));
  assert.equal((await request('/retired-admin/api/config')).status, 401);
  assert.equal((await request('/api/config')).status, 401);
  assert.equal((await request('/viewer-token/api/env/set', { key: 'ADMIN_TOKEN', value: 'retired' })).status, 400);
});

test('并发页面请求独立保存 TOKEN，不污染公开页面', async () => {
  reset({ TOKEN: 'viewer-token' });
  const [privatePage, publicPage] = await Promise.all([request('/viewer-token/'), request('/')]);
  assert.match(await privatePage.text(), /let currentToken = "viewer-token"/);
  assert.match(await publicPage.text(), /let currentToken = ""/);
});

test('URL 分发只使用域名，查询参数不能改变来源；巴哈直链可下载', async t => {
  reset();
  const calls = [];
  for (const source of ['tencent', 'iqiyi', 'bahamut']) {
    t.mock.method(getSourceByKey(source), 'getComments', async id => {
      calls.push([source, id]); return [comment(source)];
    });
  }
  const iqiyi = 'https://www.iqiyi.com/v_test.html?refer=https://v.qq.com/test';
  assert.equal((await (await byUrl(iqiyi)).json()).comments[0]?.m, 'iqiyi');
  assert.equal((await (await byUrl('https://ani.gamer.com.tw/animeVideo.php?foo=1&sn=23369')).json()).comments[0]?.m, 'bahamut');
  assert.deepEqual(calls, [['iqiyi', iqiyi], ['bahamut', '23369']]);
});

test('带来源前缀的单链接只抓取一次且不向源传递调度前缀', async t => {
  reset();
  const calls = [];
  const url = 'https://v.qq.com/x/cover/test.html';
  t.mock.method(getSourceByKey('tencent'), 'getComments', async id => {
    calls.push(id); return [comment('弹幕')];
  });
  const id = episode('tencent:' + url);
  assert.equal((await request(`/api/v2/comment/${id}`)).status, 200);
  assert.deepEqual(calls, [url]);
});

test('合并并发只共享未偏移数据，各自应用链接偏移', async t => {
  reset();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(getSourceByKey('tencent'), 'getEpisodeDanmu', async () => {
    calls++; await gate; return [comment('共享原始弹幕')];
  });
  t.mock.method(getSourceByKey('tencent'), 'formatComments', raw => raw);
  t.mock.method(getSourceByKey('bahamut'), 'getEpisodeDanmu', async () => []);
  t.mock.method(getSourceByKey('bahamut'), 'formatComments', raw => raw);
  const one = episode('tencent:https://v.qq.com/test@10$$$bahamut:1', '甲');
  const two = episode('tencent:https://v.qq.com/test@20$$$bahamut:1', '乙');
  const first = request(`/api/v2/comment/${one}`);
  const second = request(`/api/v2/comment/${two}`);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  const times = await Promise.all(results.map(async r => Number((await r.json()).comments[0].p.split(',')[0])));
  assert.equal(calls, 1);
  assert.deepEqual(times, [15, 25]);
});

test('分段缓存区分来源和区间，不与整集缓存串用', async t => {
  reset();
  for (const source of ['tencent', 'iqiyi']) {
    t.mock.method(getSourceByKey(source), 'getSegmentComments', async segment => [comment(`${source}-${segment.segment_start}`)]);
  }
  for (const [type, start] of [['tencent', 0], ['iqiyi', 0], ['tencent', 60]]) {
    const response = await request('/api/v2/segmentcomment', { type, url: 'same-id', segment_start: start, segment_end: start + 60 });
    assert.equal((await response.json()).comments[0].m, `${type}-${start}`);
  }
});

test('作品偏移缓存不影响直接URL，热更新偏移立即生效', async t => {
  reset({ DANMU_OFFSET: '测试作品@tencent:10' });
  const url = 'https://v.qq.com/test';
  t.mock.method(getSourceByKey('tencent'), 'getComments', async () => [comment('弹幕')]);
  const id = episode(url);
  const time = async response => Number((await response.json()).comments[0].p.split(',')[0]);
  assert.equal(await time(await request(`/api/v2/comment/${id}`)), 15);
  assert.equal(await time(await byUrl(url)), 5);
  Globals.env.DANMU_OFFSET = '测试作品@tencent:20';
  assert.equal(await time(await request(`/api/v2/comment/${id}`)), 25);
});

test('删除屏蔽词后不再复用已删减弹幕的缓存', async t => {
  reset({ BLOCKED_WORDS: '被屏蔽内容' });
  let downloads = 0;
  t.mock.method(getSourceByKey('tencent'), 'getEpisodeDanmu', async () => {
    downloads++; return [comment('保留内容'), comment('被屏蔽内容')];
  });
  t.mock.method(getSourceByKey('tencent'), 'formatComments', raw => raw);
  assert.equal((await (await byUrl('https://v.qq.com/hot-config')).json()).comments.length, 1);
  Globals.env.BLOCKED_WORDS = '';
  assert.equal((await (await byUrl('https://v.qq.com/hot-config')).json()).comments.length, 2);
  assert.equal(downloads, 1, '删改屏蔽词无需重新下载');
});

test('纯数字正则在合并计数和点赞装饰之前过滤', async t => {
  reset({ BLOCKED_WORDS: '/^\\d+$/u', GROUP_MINUTE: '1', LIKE_SWITCH: 'true' });
  t.mock.method(getSourceByKey('tencent'), 'getEpisodeDanmu', async () => [
    { ...comment('123'), like: 100 }, comment('123', 6), comment('剧情很好'),
  ]);
  t.mock.method(getSourceByKey('tencent'), 'formatComments', raw => raw);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await (await byUrl('https://v.qq.com/numeric')).json()).comments.map(c => c.m), ['剧情很好']);
  }
});

test('点赞与合并计数不被日志误报为 UGC 新增弹幕', async t => {
  reset({ LOG_LEVEL: 'info', GROUP_MINUTE: '1', LIKE_SWITCH: 'true' });
  Globals.logBuffer = [];
  t.mock.method(getSourceByKey('tencent'), 'getEpisodeDanmu', async () => [
    { ...comment('原始弹幕'), like: 100 }, comment('原始弹幕', 6),
  ]);
  t.mock.method(getSourceByKey('tencent'), 'formatComments', raw => raw);
  const id = episode('https://v.qq.com/ugc-count');
  const response = await request(`/api/v2/comment/${id}`);
  assert.equal((await response.json()).count, 1);
  const entry = Globals.logBuffer.find(entry => entry.message.includes('UGC新增保留'));
  assert.ok(entry);
  assert.match(entry.message, /UGC新增保留 0 条/);
});

test('命中弹幕缓存的手选结果仍能保存来源偏好', async () => {
  reset({ REMEMBER_LAST_SELECT: 'true' });
  const automatic = episode('https://v.qq.com/automatic');
  const selected = episode('https://www.iqiyi.com/selected', '测试作品', 'iqiyi');
  storeAnimeIdsToMap(Globals.animes, '测试作品');
  setLastSearch('127.0.0.1', { title: '测试作品', season: 1, episode: 1, episodeId: automatic });
  setCommentCache('https://www.iqiyi.com/selected', [comment('已缓存弹幕')]);
  assert.equal((await request(`/api/v2/comment/${selected}`)).status, 200);
  assert.equal(getPreferAnimeId('测试作品', 1)[0], 2);
});

test('整集缓存不能为仍需抓取的分段目录请求豁免限流', async () => {
  reset({ RATE_LIMIT_MAX_REQUESTS: '1' });
  const url = 'https://v.qq.com/segment-rate';
  const id = episode(url);
  setCommentCache(url, [comment('整集缓存')]);
  Globals.requestHistory.set('127.0.0.1', [Date.now()]);
  assert.equal((await request(`/api/v2/comment/${id}?segmentflag=true`)).status, 429);
  assert.equal((await request(`/api/v2/comment/${id}`)).status, 200);
});

test('弹幕正文为对象原型属性名时仍正常合并', () => {
  reset({ GROUP_MINUTE: '1' });
  const contents = ['__proto__', 'constructor', 'toString'];
  const result = convertToDanmakuJson(contents.map(m => comment(m)), 'tencent');
  assert.deepEqual(result.map(c => c.m).sort(), [...contents].sort());
});

test('红果某集请求失败时不得返回上一集弹幕', async () => {
  reset();
  const source = new HongguoSource();
  source.shouldMergeAllEpisodes = () => false;
  source.resolveEpisodeInfo = async vid => ({ seriesId: 'series', vid, duration: 60 });
  source.getDanmuForEpisode = async info => {
    if (info.vid === 'one') return [{ offsetMs: 1000, content: '第一集弹幕' }];
    throw new Error('source unavailable');
  };
  assert.equal((await source.getEpisodeDanmu('one')).length, 1);
  assert.deepEqual(await source.getEpisodeDanmu('two'), []);
});

test('红果合并全集时长使用完整原生ID，时长失败不阻止弹幕返回', async t => {
  reset();
  t.mock.method(getSourceByKey('hongguo'), 'getEpisodeDanmu', async () => [comment('全集弹幕')]);
  t.mock.method(getSourceByKey('hongguo'), 'formatComments', raw => raw);
  t.mock.method(getSourceByKey('hongguo'), 'getEpisodeDanmuSegments', async id => {
    assert.match(id, /^hongguo:series:v1:/);
    return { duration: id.endsWith('1') ? 120 : 180, segmentList: [] };
  });
  const id = episode('hongguo:series:v1:1$$$hongguo:series:v1:2', '红果全集', 'hongguo');
  assert.equal((await (await request(`/api/v2/comment/${id}?duration=true`)).json()).videoDuration, 180);
  t.mock.method(getSourceByKey('hongguo'), 'getEpisodeDanmuSegments', async () => { throw Error('duration unavailable'); });
  const response = await request(`/api/v2/comment/${id}?duration=true`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).videoDuration, 0);
});
