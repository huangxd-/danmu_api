// 爱壹帆源：App 链路与年份补齐
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import AiyifanSource from '../../sources/aiyifan.js';
import { AiyifanAppSigningProvider, AIYIFAN_WEB_YEAR_MAX_WAIT_MS, computeAiyifanWebSign } from '../../utils/aiyifan-util.js';
import { Globals } from '../../configs/globals.js';
import { mockJsonResponse, resetSearchState, withMockFetch } from '../helpers/context.js';

test('aiyifan App chain keeps years and accepts legacy segment links', async t => {
  const makeSource = () => {
    const source = new AiyifanSource();
    source.searchDrama = async () => ({ data: { list: [{
      mediaKey: 'media', title: '年份测试', mediaType: '电视剧',
      postTime: '2020-01-01T00:00:00Z', coverImgUrl: 'https://example.com/cover.jpg'
    }] } });
    return source;
  };

  await t.test('a slow App search retains an already resolved year', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const source = makeSource();
    source.signingProvider.lookupYears = async () => new Map([['media', 2003]]);
    const searchDrama = source.searchDrama;
    source.searchDrama = async () => {
      await Promise.resolve();
      t.mock.timers.tick(AIYIFAN_WEB_YEAR_MAX_WAIT_MS + 1000);
      return searchDrama();
    };
    assert.equal((await source.search('年份测试'))[0].year, 2003);
  });

  await t.test('missing and timed-out years remain unknown through detail creation', async t => {
    resetSearchState();
    const source = makeSource();
    source.signingProvider.lookupYears = async () => new Map();
    const results = await source.search('年份测试');
    assert.equal(results[0].year, null);
    source.getEpisodes = async () => [{ title: '01', link: 'https://www.yfsp.tv/play/media?id=episode' }];
    const details = new Map();
    const [anime] = await source.handleAnimes(results, '年份测试', [], details);
    assert.ok(anime.animeTitle.includes('(N/A)'));
    assert.equal(anime.startDate, '');
    assert.equal([...details.values()][0].startDate, '');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    source.signingProvider.lookupYears = () => new Promise(() => {});
    const pending = source.search('年份测试');
    t.mock.timers.tick(AIYIFAN_WEB_YEAR_MAX_WAIT_MS);
    assert.equal((await pending)[0].year, null);
  });

  await t.test('web keywords survive URL encoding without changing the signature input', () => {
    const provider = new AiyifanAppSigningProvider();
    const config = { publicKey: 'test-public', privateKey: 'test-private' };
    for (const keyword of ['Love & Death', 'Re:从零开始#第二季', 'A+B']) {
      const url = new URL('https://example.com/?' + provider.buildWebSignedQuery({ tags: keyword, page: 1 }, config));
      assert.equal(url.searchParams.get('tags'), keyword);
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('vv'), computeAiyifanWebSign(`tags=${keyword}&page=1`, config));
      assert.equal(url.hash, '');
    }
  });

  await t.test('direct links and both legacy wrappers reach the same episode', async () => {
    const source = makeSource();
    const link = 'https://www.yfsp.tv/play/media?id=episode';
    const seen = [];
    source.getEpisodeDanmu = async id => { seen.push(id); return [{ second: 1, contxt: 'test' }]; };
    for (const url of [link,
      'https://m10.yfsp.tv/api/video/getBarrage?uniqueKey=' + link,
      'https://api.tripdata.app/api/Video/GetBarrages?link=' + encodeURIComponent(link)]) {
      assert.equal((await source.getEpisodeSegmentDanmu({ url })).length, 1);
    }
    assert.deepEqual(seen, [link, link, link]);
    assert.equal(source.resolveSegmentLink({ url: 'https://example.com/?site=yfsp.tv' }), null);
    assert.equal(source.resolveSegmentLink({ url: 'not a URL' }), null);
  });
});

test('aiyifan 年份补全与网页搜索日志使用源标签', async t => {
  const captured = [];
  const original = { info: console.info, warn: console.warn };
  const originalLevel = Globals.envs.logLevel;
  for (const level of ['info', 'warn']) console[level] = (...args) => { captured.push(args.join(' ')); };
  Globals.envs.logLevel = 'info';
  t.after(() => {
    for (const level of ['info', 'warn']) console[level] = original[level];
    Globals.envs.logLevel = originalLevel;
  });

  const provider = new AiyifanAppSigningProvider();
  provider.signedWebGetJson = async () => ({ data: { data: { info: [] } } });
  await provider.lookupYears('标签测试');
  assert.deepEqual(captured, ['[Aiyifan] 年份查询命中 0 条: 标签测试']);

  // 省略 logPrefix 的网页搜索调用同样落到源标签
  captured.length = 0;
  const bare = new AiyifanAppSigningProvider();
  bare.getSigningConfig = async () => ({ publicKey: 'test-public', privateKey: 'test-private' });
  await withMockFetch(
    async (url) => mockJsonResponse({ ret: 500, msg: '签名错误' }, url),
    async () => { await assert.rejects(() => bare.signedWebGetJson(bare.webSearchApi, { tags: 'x' })); }
  );
  const webFailureTags = captured.filter(line => line.includes('网页搜索失败')).map(line => line.split(' ')[0]);
  assert.deepEqual(webFailureTags, ['[Aiyifan]']);
});

test('aiyifan 配置、搜索、选集、详情、弹幕及年份请求复用统一代理入口', async t => {
  const original = Globals.envs;
  Globals.envs = { proxyUrl: 'http://127.0.0.1:7890,@https://universal.example,aiyifan@https://proxy.example/aiyifan' };
  t.after(() => { Globals.envs = original; });
  const source = new AiyifanSource();
  const seen = [];
  await withMockFetch(async (url, options) => {
    const parsed = new URL(url);
    seen.push({ url: parsed, options });
    assert.equal(parsed.origin, 'https://proxy.example');
    const data = parsed.pathname.endsWith('/api/home/config')
      ? { list: { pConfig: { publicKey: 'test-public', privateKey: ['test-private'] } } }
      : { list: [] };
    return mockJsonResponse({ ret: 200, data }, url);
  }, async () => {
    await source.searchDrama('代理测试');
    await source.getEpisodes('media');
    await source.signingProvider.signedGetJson(source.DETAILS_API, { mediaKey: 'media', episodeKey: 'episode' });
    await source.signingProvider.signedGetJson(source.DANMU_API, { mediaKey: 'media', videoId: 'video' });
    await source.signingProvider.signedWebGetJson(source.signingProvider.webSearchApi, { tags: 'A&B', page: 1 });
  });
  assert.deepEqual(seen.map(({ url, options }) => [options.method, url.pathname]), [
    ['GET', '/aiyifan/api/home/config'],
    ['POST', '/aiyifan/api/List/GetTitleGetData'],
    ['POST', '/aiyifan/api/Video/VideoChooseGather'],
    ['GET', '/aiyifan/api/Video/VideoDetails'],
    ['GET', '/aiyifan/api/Video/GetBarrages'],
    ['GET', '/aiyifan/v3/list/briefsearch'],
  ]);
  assert.deepEqual(JSON.parse(seen[1].options.body), { SearchCriteria: '代理测试' });
  assert.deepEqual(JSON.parse(seen[2].options.body), { mediaKey: 'media' });
  assert.equal(seen[1].options.headers['x-pub'], 'test-public');
  assert.match(seen[1].options.headers['x-sign'], /^[0-9a-f]{32}$/);
  assert.ok(seen[1].url.searchParams.has('_t'));
  assert.equal(seen[3].url.searchParams.get('episodeKey'), 'episode');
  assert.equal(seen[4].url.searchParams.get('videoId'), 'video');
  assert.equal(seen[5].url.searchParams.get('tags'), 'A&B');
});

test('aiyifan 带用户名密码的 HTTP/HTTPS 代理仍走本地中转', t => {
  const original = Globals.envs;
  t.after(() => { Globals.envs = original; });
  const source = new AiyifanSource();
  for (const proxyUrl of [
    'http://test-user:p%40ss%3Aword%2C%23@proxy.example:2080',
    'https://test-user:p%40ss%3Aword%2C%23@proxy.example:2080',
  ]) {
    Globals.envs = { proxyUrl };
    for (const target of [source.SEARCH_API, source.EPISODES_API, source.DANMU_API, source.signingProvider.webSearchApi]) {
      assert.equal(source.signingProvider.proxyUrlBuilder(target),
        `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(target)}`);
    }
  }
});
