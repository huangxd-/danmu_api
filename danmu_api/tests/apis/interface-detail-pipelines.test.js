// 接口详情的分接口流水线：详情、分集与弹幕链路的步骤与配置生效记录
// 断言落到步骤名、状态与具体字段，验证各接口都能给出可排查的处理过程

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Globals } from '../../configs/globals.js';
import { getBangumi, getCommentByUrl, matchAnime, searchEpisodes } from '../../apis/dandan-api.js';
import { handleFavoriteRefresh, handleFavoriteRemove, handleFavoriteSchedule } from '../../apis/favorite-api.js';
import { getSourceByKey } from '../../sources/registry.js';
import { setSearchCache } from '../../utils/cache-util.js';
import { convertToDanmakuJson } from '../../utils/danmu-util.js';
import { createTrace, runWithTrace, useAsyncLocalStorage } from '../../utils/pipeline-trace.js';

function initGlobals(overrides = {}) {
  Globals.init(overrides);
  useAsyncLocalStorage(AsyncLocalStorage);
  Globals.animes = [];
  Globals.commentCache = new Map();
}

function seedAnime(overrides = {}) {
  const anime = {
    animeId: 501,
    bangumiId: 'B501',
    animeTitle: '测试剧集',
    source: 'bilibili',
    startDate: '2026-01-01',
    episodeCount: 3,
    links: [
      { id: 1, title: '第1集' },
      { id: 2, title: '第2集' },
      { id: 3, title: '预告' },
    ],
    ...overrides,
  };
  Globals.animes = [anime];
  return anime;
}

test('getBangumi 记录剧集定位、集标题过滤与响应组装', async () => {
  initGlobals({ EPISODE_TITLE_FILTER: '预告', ENABLE_ANIME_EPISODE_FILTER: 'true' });
  seedAnime();
  const trace = createTrace('GET', '/api/v2/bangumi/B501');
  const response = await runWithTrace(trace, () => getBangumi('/api/v2/bangumi/B501'));
  const body = await response.json();

  assert.equal(body.success, true);
  assert.equal(body.bangumi.episodes.length, 2);

  const locate = trace.steps.find(step => step.name === '详情·剧集定位');
  assert.ok(locate, '缺少剧集定位步骤');
  assert.equal(locate.status, 'ok');
  assert.equal(locate.outputs.animeTitle, '测试剧集');
  assert.equal(locate.outputs.sourceKey, 'bilibili');
  assert.equal(locate.outputs.linkCount, 3);

  const assemble = trace.steps.find(step => step.name === '详情·响应组装');
  assert.ok(assemble, '缺少响应组装步骤');
  assert.equal(assemble.outputs.count, 2);

  const filter = (assemble.changes || []).find(change => change.config === 'EPISODE_TITLE_FILTER');
  assert.ok(filter, '缺少集标题过滤记录');
  assert.equal(filter.hit, true);
  assert.equal(filter.removedCount, 1);
  assert.equal(filter.removed[0].value, '预告');
  assert.equal(filter.after.episodeCount, 2);
  // 配置覆盖面板据此展示「已读取 + 已命中」
  assert.equal(trace.configs.episodeTitleFilter.used, true);
  assert.equal(trace.configs.episodeTitleFilter.hit, true);
});

test('getBangumi 未找到剧集时记录 empty 步骤与原因', async () => {
  initGlobals({});
  const trace = createTrace('GET', '/api/v2/bangumi/missing');
  const response = await runWithTrace(trace, () => getBangumi('/api/v2/bangumi/missing'));

  assert.equal(response.status, 404);
  const locate = trace.steps.find(step => step.name === '详情·剧集定位');
  assert.ok(locate);
  assert.equal(locate.status, 'empty');
  assert.match(locate.reason, /缓存中不存在该剧集/);
  assert.equal(trace.steps.some(step => step.name === '详情·响应组装'), false,
    '未找到剧集时不应继续组装响应');
});

test('getBangumi 集标题过滤未剔除任何条目时记录未命中', async () => {
  initGlobals({ EPISODE_TITLE_FILTER: '预告', ENABLE_ANIME_EPISODE_FILTER: 'true' });
  seedAnime({ links: [{ id: 1, title: '第1集' }, { id: 2, title: '第2集' }], episodeCount: 2 });
  const trace = createTrace('GET', '/api/v2/bangumi/B501');
  await runWithTrace(trace, () => getBangumi('/api/v2/bangumi/B501'));

  const filter = (trace.steps.find(step => step.name === '详情·响应组装').changes || [])
    .find(change => change.config === 'EPISODE_TITLE_FILTER');
  assert.ok(filter);
  assert.equal(filter.hit, false);
  assert.equal(trace.configs.episodeTitleFilter.hit, false);
});

test('getCommentByUrl 地址解析记录合并链接数', async () => {
  initGlobals({ SOURCE_ORDER: 'tencent', COMMENT_CACHE_MIN_COUNT: '0', DANMU_LIMIT: '0', GROUP_MINUTE: '0' });
  const instance = getSourceByKey('tencent');
  const originalGetComments = instance.getComments;
  instance.getComments = async () => convertToDanmakuJson([{ p: '1.0,1,16777215', m: 'x' }], 'tencent');
  try {
    const single = createTrace('GET', '/api/v2/comment');
    await runWithTrace(single, () => getCommentByUrl('https://v.qq.com/x/cover/abc.html', 'json', false));
    assert.equal(single.steps[0].outputs.链接数, 1, '单链接应记 1');

    const merged = createTrace('GET', '/api/v2/comment');
    await runWithTrace(merged, () => getCommentByUrl('https://v.qq.com/x/cover/a.html$$$https://v.qq.com/x/cover/b.html', 'json', false));
    assert.equal(merged.steps[0].outputs.链接数, 2, '合并链接应记 2');
  } finally {
    instance.getComments = originalGetComments;
  }
});

test('getCommentByUrl 对 @30% 这类非法偏移格式给出提示', async () => {
  initGlobals({ SOURCE_ORDER: 'tencent', COMMENT_CACHE_MIN_COUNT: '0', DANMU_LIMIT: '0', GROUP_MINUTE: '0' });
  const instance = getSourceByKey('tencent');
  const originalGetComments = instance.getComments;
  instance.getComments = async () => convertToDanmakuJson([{ p: '1.0,1,16777215', m: 'x' }], 'tencent');
  try {
    const trace = createTrace('GET', '/api/v2/comment');
    await runWithTrace(trace, () => getCommentByUrl('https://v.qq.com/x/cover/abc.html@30%', 'json', false));
    const resolveStep = trace.steps.find(step => step.name === '弹幕·地址解析');
    assert.equal(resolveStep.status, 'ok', '格式提示不改变流程状态');
    assert.match(resolveStep.reason, /@%30/, '应提示正确写法');
  } finally {
    instance.getComments = originalGetComments;
  }
});

test('getCommentByUrl 记录地址解析、缓存查询、抓取与过滤、响应组装', async () => {
  // COMMENT_CACHE_MIN_COUNT 默认 100，低于该条数会主动丢弃缓存，这里关闭下限以便验证命中路径
  initGlobals({ BLOCKED_WORDS: '广告', DANMU_LIMIT: '0', GROUP_MINUTE: '0', SOURCE_ORDER: 'tencent', COMMENT_CACHE_MIN_COUNT: '0' });
  const instance = getSourceByKey('tencent');
  const originalGetComments = instance.getComments;
  instance.getComments = async () => convertToDanmakuJson([
    { p: '1.0,1,16777215', m: '正常弹幕' },
    { p: '2.0,1,16777215', m: '这是广告' },
  ], 'tencent');
  try {
    const url = 'https://v.qq.com/x/cover/abc.html';
    const trace = createTrace('GET', '/api/v2/comment');
    const first = await runWithTrace(trace, () => getCommentByUrl(url, 'json', false));
    const firstBody = await first.json();

    assert.equal(firstBody.count, 1);
    assert.deepEqual(trace.steps.map(step => step.name),
      ['弹幕·地址解析', '弹幕·缓存查询', '弹幕·抓取与过滤', '弹幕·响应组装']);
    const statuses = new Set(['ok', 'empty', 'hit', 'miss', 'fail', 'skip']);
    for (const step of trace.steps) {
      assert.ok(statuses.has(step.status), `步骤「${step.name}」缺少有效状态`);
    }

    const cacheStep = trace.steps[1];
    assert.equal(cacheStep.status, 'miss');
    assert.equal(trace.configs.commentCacheMinutes.hit, false, '缓存未命中应登记为未命中');
    assert.equal(trace.configs.commentCacheMinutes.step, '弹幕·缓存查询', '配置读取应归属到缓存查询步骤');

    const fetchStep = trace.steps[2];
    assert.equal(fetchStep.status, 'ok');
    assert.equal(fetchStep.outputs.count, 1);
    const blocked = (fetchStep.changes || []).find(change => change.config === 'BLOCKED_WORDS');
    assert.ok(blocked, '缺少屏蔽词过滤记录');
    assert.equal(blocked.hit, true);
    assert.equal(blocked.removedCount, 1);
    assert.deepEqual(blocked.before, { 弹幕条数: 2, 生效规则数: 1 });
    assert.deepEqual(blocked.after, { 弹幕条数: 1 });
    assert.equal(trace.configs.blockedWords.hit, true);
    assert.equal(trace.configs.blockedWords.step, '弹幕·抓取与过滤', '屏蔽词读取应归属到抓取与过滤步骤');
    assert.equal(trace.steps[3].outputs.count, 1);

    // 第二次请求命中弹幕缓存，步骤与配置状态随路径变化
    const secondTrace = createTrace('GET', '/api/v2/comment');
    const second = await runWithTrace(secondTrace, () => getCommentByUrl(url, 'json', false));
    assert.equal((await second.json()).count, 1);
    assert.deepEqual(secondTrace.steps.map(step => step.name), ['弹幕·地址解析', '弹幕·缓存查询']);
    assert.equal(secondTrace.steps[1].status, 'hit');
    assert.equal(secondTrace.configs.commentCacheMinutes.hit, true);
  } finally {
    instance.getComments = originalGetComments;
  }
});

test('matchAnime 参数校验失败时记录 fail 步骤', async () => {
  initGlobals({});
  for (const { body, reason } of [
    { body: {}, reason: '缺少 fileName 参数' },
    { body: null, reason: '请求体为空' },
  ]) {
    const trace = createTrace('POST', '/api/v2/match');
    const request = new Request('http://localhost/api/v2/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await runWithTrace(trace, () => matchAnime(new URL(request.url), request, '1.1.1.1'));
    assert.equal(response.status, 400);
    const step = trace.steps.find(item => item.name === '匹配·参数校验');
    assert.ok(step, '缺少参数校验步骤');
    assert.equal(step.status, 'fail');
    assert.equal(step.reason, reason);
  }
});

test('handleFavoriteRemove 未找到收藏时记录 miss 步骤', async () => {
  initGlobals({});
  const trace = createTrace('POST', '/api/v2/favorite/remove');
  const req = new Request('http://localhost/api/v2/favorite/remove', {
    method: 'POST', body: JSON.stringify({ keyword: '不存在的剧' }),
  });
  const response = await runWithTrace(trace, () => handleFavoriteRemove(req));
  assert.equal(response.status, 404);
  const step = trace.steps.find(item => item.name === '收藏·删除');
  assert.ok(step, '缺少删除步骤');
  assert.equal(step.status, 'miss');
  assert.equal(step.reason, '未找到该收藏');
  assert.equal(step.inputs.keyword, '不存在的剧');
});

test('handleFavoriteRefresh 未找到收藏时记录 miss 步骤', async () => {
  initGlobals({});
  const trace = createTrace('POST', '/api/v2/favorite/refresh');
  const req = new Request('http://localhost/api/v2/favorite/refresh', {
    method: 'POST', body: JSON.stringify({ keyword: '不存在的剧' }),
  });
  const response = await runWithTrace(trace, () => handleFavoriteRefresh(req));
  assert.equal(response.status, 404);
  const step = trace.steps.find(item => item.name === '收藏·刷新');
  assert.ok(step, '缺少刷新步骤');
  assert.equal(step.status, 'miss');
  assert.equal(step.reason, '未找到该收藏');
});

test('handleFavoriteSchedule 缺参数与非 Node 部署分别记录 fail 与 skip', async () => {
  initGlobals({});
  Globals.deployPlatform = 'node';
  const missing = createTrace('POST', '/api/v2/favorite/schedule');
  const missingRes = await runWithTrace(missing, () => handleFavoriteSchedule(
    new Request('http://localhost/api/v2/favorite/schedule', { method: 'POST', body: JSON.stringify({}) }),
  ));
  assert.equal(missingRes.status, 400);
  const failStep = missing.steps.find(item => item.name === '收藏·定时刷新');
  assert.equal(failStep.status, 'fail');
  assert.equal(failStep.reason, '缺少 keyword 参数');

  Globals.deployPlatform = 'vercel';
  const skipTrace = createTrace('POST', '/api/v2/favorite/schedule');
  const skipRes = await runWithTrace(skipTrace, () => handleFavoriteSchedule(
    new Request('http://localhost/api/v2/favorite/schedule', { method: 'POST', body: JSON.stringify({ keyword: 'x' }) }),
  ));
  assert.equal(skipRes.status, 501);
  const skipStep = skipTrace.steps.find(item => item.name === '收藏·定时刷新');
  assert.equal(skipStep.status, 'skip');
  assert.match(skipStep.reason, /仅支持 Node\/Docker/);
});

test('searchEpisodes 记录集数筛选与详情组装', async () => {
  initGlobals({ SOURCE_ORDER: 'local' });
  const anime = {
    animeId: 601,
    bangumiId: 'B601',
    animeTitle: '分集测试剧',
    source: 'bilibili',
    startDate: '2026-01-01',
    episodeCount: 3,
    links: [{ id: 1, title: '第1集' }, { id: 2, title: '第2集' }, { id: 3, title: '第3集' }],
  };
  Globals.animes = [anime];
  setSearchCache('分集测试剧', [anime]);

  const url = new URL('http://localhost/api/v2/search/episodes?anime=' + encodeURIComponent('分集测试剧') + '&episode=2');
  const trace = createTrace('GET', '/api/v2/search/episodes');
  const response = await runWithTrace(trace, () => searchEpisodes(url));
  const body = await response.json();

  assert.equal(body.animes.length, 1);
  assert.equal(body.animes[0].episodes.length, 1);
  assert.equal(body.animes[0].episodes[0].episodeTitle, '第2集');

  const step = trace.steps.find(item => item.name === '分集·详情组装');
  assert.ok(step, '缺少分集详情组装步骤');
  assert.equal(step.status, 'ok');
  assert.equal(step.inputs.requestedEpisode, '2');
  assert.equal(step.inputs.searchedAnime, 1);
  assert.equal(step.outputs.episodeCount, 1);
  // 命中集标题让用户直接看到请求的集对应哪一集，无需再展开响应
  assert.deepEqual(step.outputs.matchedEpisodeTitles, ['第2集']);
});

test('searchEpisodes 未命中请求的集数时给出 empty 与原因', async () => {
  initGlobals({ SOURCE_ORDER: 'local' });
  const anime = {
    animeId: 602,
    bangumiId: 'B602',
    animeTitle: '分集空结果剧',
    source: 'bilibili',
    startDate: '2026-01-01',
    episodeCount: 2,
    links: [{ id: 1, title: '第1集' }, { id: 2, title: '第2集' }],
  };
  Globals.animes = [anime];
  setSearchCache('分集空结果剧', [anime]);

  const url = new URL('http://localhost/api/v2/search/episodes?anime=' + encodeURIComponent('分集空结果剧') + '&episode=9');
  const trace = createTrace('GET', '/api/v2/search/episodes');
  const body = await (await runWithTrace(trace, () => searchEpisodes(url))).json();

  assert.equal(body.animes.length, 0);
  const step = trace.steps.find(item => item.name === '分集·详情组装');
  assert.equal(step.status, 'empty');
  assert.match(step.reason, /第 9 集/);
});
