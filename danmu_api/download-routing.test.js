import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { addAnime } from './utils/cache-util.js';
import { getSourceByKey } from './sources/registry.js';
import { handleRequest } from './worker.js';
import { mergeLinkEntry, normalizeMergedSourceUrl } from './utils/merge-util.js';
import HongguoSource, { createHongguoSeriesId } from './sources/hongguo.js';

const tx = 'https://v.qq.com/x/cover/mzc00200ulip93g/x0039pk6sz1.html';
test('补全链接再次合并使用真实来源，保留原生全集 ID', () => {
  const result = mergeLinkEntry({ title: '【tencent】 侦探已死 第1话', url: tx },
    { title: '【iqiyi】 第1集', url: 'https://www.iqiyi.com/v_1cci3jdxfd4.html' }, 'iqiyi', 'bilibili');
  assert.equal(result.url, `tencent:${tx}$$$iqiyi:https://www.iqiyi.com/v_1cci3jdxfd4.html`);
  assert.equal(normalizeMergedSourceUrl(`bilibili:${tx}$$$bahamut:23369`), `tencent:${tx}$$$bahamut:23369`);
  assert.equal(normalizeMergedSourceUrl(createHongguoSeriesId('123'), 'hongguo'), 'hongguo:series:v1:123');
});

function setup(url) {
  Globals.init({ TOKEN: '87654321', SOURCE_ORDER: 'tencent,iqiyi,bahamut,hongguo', LOCAL_CACHE_ENABLED: 'false',
    LOCAL_REDIS_URL: '', BILIBILI_UGC_ENABLED: 'false', BLOCK_DOMESTIC_CELEBRITIES: 'false', BLOCKED_WORDS: '',
    USE_BANGUMI_DATA: 'false', LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0', GROUP_MINUTE: '0' });
  Globals.animes = []; Globals.episodeIds = []; Globals.episodeNum = 10001;
  Globals.commentCache = new Map(); Globals.lastSelectMap = new Map();
  addAnime({ animeId: 51, bangumiId: 'download', animeTitle: '下载测试(2021)【动漫】', source: 'tencent',
    links: [{ title: '【tencent&bahamut】 第1集', url }] });
  return Globals.animes[0].links[0].id;
}
const download = id => handleRequest(new Request(`http://localhost/87654321/api/v2/comment/${id}?format=json`), Globals.env);
test('旧缓存的错误来源前缀可按真实域名下载，未知域名继续拒绝', async t => {
  const called = [];
  for (const key of ['tencent', 'bahamut']) {
    t.mock.method(getSourceByKey(key), 'getEpisodeDanmu', async id => {
      called.push([key, id]); return [{ p: '5,1,16777215', m: key }];
    });
    t.mock.method(getSourceByKey(key), 'formatComments', raw => raw);
  }
  const id = setup(`bilibili:${tx}$$$bahamut:23369`);
  const response = await download(id);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).comments.map(c => c.m).sort(), ['bahamut', 'tencent']);
  assert.deepEqual(called, [['tencent', tx], ['bahamut', '23369']]);
  const invalid = setup('bilibili:https://unknown.invalid/watch$$$bahamut:23369');
  assert.equal((await download(invalid)).status, 400);
});

test('红果全集下载与合并分发保留完整 series ID', async t => {
  const series = createHongguoSeriesId('123');
  const received = [];
  t.mock.method(getSourceByKey('hongguo'), 'getEpisodeDanmu', async id => { received.push(id); return [{ p: '5,1,16777215', m: '全集弹幕' }]; });
  t.mock.method(getSourceByKey('hongguo'), 'formatComments', raw => raw);
  for (const url of [series, `${series}$$$hongguo:series:v1:456`]) {
    const response = await download(setup(url));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).comments.length > 0);
  }
  assert.ok(received.includes(series));
  assert.ok(received.includes('hongguo:series:v1:456'));
});

test('红果全集部分分集失败时保留成功结果并跳过明确无弹幕分集', async () => {
  setup('https://v.qq.com');
  const source = new HongguoSource();
  source.getEpisodes = async () => ({ episodes: [{ vid: '1', duration: 60 }, { vid: '2', duration: 60, commentCount: 0 }, { vid: '3', duration: 60 }] });
  let attempts = 0;
  source.getDanmuForEpisode = async info => {
    attempts++;
    if (info.vid === '3') throw new Error('temporary error');
    return [{ offsetMs: 1000, content: '弹幕' }];
  };
  assert.equal((await source.getSeriesDanmu('123')).length, 1);
  assert.equal((await source.getSeriesDanmu('123')).length, 1);
  assert.equal(attempts, 2);
});
