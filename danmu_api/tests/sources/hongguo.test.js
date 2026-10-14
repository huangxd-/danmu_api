// 红果源：搜索、详情缓存、请求调度与弹幕时间轴的离线回归。

import test from 'node:test';
import assert from 'node:assert';
import { getSourceByKey } from '../../sources/registry.js';
import HongguoSource from '../../sources/hongguo.js';
import {
  createHongguoEpisodeId, createHongguoSeriesId, isQualityDelivery,
} from '../../utils/hongguo-util.js';
import { globals } from '../../configs/globals.js';
import { withMockFetch, mockJsonResponse } from '../helpers/context.js';

const hongguoSource = getSourceByKey('hongguo');

function webSearchRow(id, name, episodeCount = 3) {
  return { keyword: id, name, video_data: { series_id: id, series_title: name, episode_cnt: episodeCount } };
}

function webSearchResponse(rows) {
  return new Response(`<script>{"searchList":${JSON.stringify(rows)}}</script>`);
}

test('hongguo 网页与联想并行，按完整 ID 合并，忽略无效剧目且不逐季补查', async () => {
  const source = new HongguoSource();
  const firstId = '7621200213801176126';
  const thirdId = '7633436713011907608';
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  source.request = async () => { assert.fail('网页或联想有效时不调用 App 搜索'); };
  await withMockFetch(async (url, options) => {
    const parsed = new URL(url);
    started.push(parsed.pathname);
    await gate;
    if (parsed.pathname.startsWith('/search/')) return webSearchResponse([webSearchRow(firstId, '万妖图录传第一季', 81)]);
    assert.equal(parsed.pathname, '/incent_resource/suggestion');
    assert.equal(parsed.searchParams.get('app_id'), '8662');
    assert.equal(parsed.searchParams.get('query'), '万妖图录传');
    assert.equal(parsed.searchParams.get('count'), '50');
    assert.equal(options.headers.referer, 'https://hongguoduanju.com/');
    const rows = [
      { ...webSearchRow(firstId, '重复第一季', 81), word_type: 'short_play_name' },
      { ...webSearchRow(thirdId, '万妖图录传第三季', 58), word_type: 'short_play_name' },
      { ...webSearchRow('1234', '演员联想'), word_type: 'actor_name' },
      { keyword: '万妖图录传第十四季', name: '万妖图录传第十四季', word_type: 'short_play_name' },
      { ...webSearchRow('2345', '缺少集数', 0), word_type: 'short_play_name' },
      { keyword: '无字符串 ID', name: '不安全数值 ID', word_type: 'short_play_name', video_data: { series_id: Number(thirdId), episode_cnt: 58 } },
    ];
    // 模拟接口把 series_id 写成大整数 JSON 数字，而 keyword 保留完整字符串。
    const json = JSON.stringify({ suggest_list: rows }).replaceAll(`"series_id":"${thirdId}"`, `"series_id":${thirdId}`);
    return new Response(json);
  }, async () => {
    const task = source.search('万妖图录传');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, 2, '两个请求都必须在任何结果返回前发出');
    release();
    const results = await task;
    assert.deepEqual(results.map(item => [item.seriesId, item.name, item.episodeCount]), [
      [firstId, '万妖图录传第一季', 81], [thirdId, '万妖图录传第三季', 58],
    ]);
    assert.equal(started.length, 2, '请求数量不随季数增加');
  });
});

test('hongguo 搜索任一路失败仍保留另一路结果，合并后最多20部', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    ...webSearchRow(String(1000 + index), `测试剧第${index + 1}季`), word_type: 'short_play_name',
  }));
  for (const failed of ['web', 'suggestion']) {
    const source = new HongguoSource();
    source.request = async () => { assert.fail('另一路有效时不调用 App 搜索'); };
    await withMockFetch(async url => {
      const web = new URL(url).pathname.startsWith('/search/');
      if ((failed === 'web') === web) return new Response('暂时不可用', { status: 503 });
      return web ? webSearchResponse([rows[0]]) : Response.json({ data: { suggest_list: rows } });
    }, async () => {
      const results = await source.search('测试剧');
      assert.equal(results.length, failed === 'web' ? 20 : 1);
      assert.equal(results[0].seriesId, '1000');
    });
  }
});

test('hongguo 联想正文卡住时两秒取消请求，保留网页结果且不重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new HongguoSource();
  let suggestionCalls = 0;
  let suggestionSignal;
  source.request = async () => { assert.fail('网页有效时不调用 App 搜索'); };
  await withMockFetch(async (url, options) => {
    if (new URL(url).pathname.startsWith('/search/')) return webSearchResponse([webSearchRow('1234', '测试剧第一季')]);
    suggestionCalls++;
    suggestionSignal = options.signal;
    // 响应头立即到达，正文挂起，验证超时覆盖正文读取。
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
    }) };
  }, async () => {
    let completed = false;
    const task = source.search('测试剧').then(results => { completed = true; return results; });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(suggestionSignal.aborted, false);
    t.mock.timers.tick(1);
    const results = await task;
    assert.equal(suggestionSignal.aborted, true);
    assert.equal(suggestionCalls, 1);
    assert.deepEqual(results.map(item => item.seriesId), ['1234']);
  });
});

test('hongguo 网页和联想都无有效剧目时保留原 App 搜索回退', async () => {
  const source = new HongguoSource();
  let calls = 0;
  source.request = async (method, path) => {
    calls++;
    assert.equal(method, 'GET');
    assert.equal(path, '/reading/bookapi/search/tab/v');
    return { search_tabs: [{ has_more: false, data: [{
      book_id: '1234', video_detail: { series_title: '测试剧', episode_cnt: 3 },
    }] }] };
  };
  await withMockFetch(async url => new URL(url).pathname.startsWith('/search/')
    ? webSearchResponse([]) : Response.json({ suggest_list: [] }), async () => {
    assert.equal((await source.search('测试剧'))[0].seriesId, '1234');
    assert.equal(calls, 1);
  });
});

test('hongguo 详情最多并发3部，单部失败不丢其他结果，缓存写入顺序稳定', async () => {
  const values = { animes: [], episodeIds: [], episodeNum: 10001, MAX_ANIMES: 100, strictTitleMatch: false, hongguoMergeAllEpisodes: false };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, globals[key]]));
  Object.assign(globals, values);
  try {
    const source = new HongguoSource();
    const pending = new Map();
    const started = [];
    let active = 0;
    let maximum = 0;
    source.getEpisodes = async id => {
      started.push(id);
      maximum = Math.max(maximum, ++active);
      try {
        return await new Promise((resolve, reject) => pending.set(id, {
          resolve: () => resolve({ episodes: [{ index: 1, vid: `${id}1`, duration: 90 }] }), reject,
        }));
      } finally { active--; }
    };
    const items = ['101', '102', '103', '104', '105'].map((seriesId, index) => ({ seriesId, name: `测试剧第${index + 1}季` }));
    items.push({ seriesId: '999', name: '无关结果' });
    const curAnimes = [];
    const details = new Map();
    const task = source.handleAnimes(items, '测试剧', curAnimes, details);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['101', '102', '103']);
    pending.get('102').reject(new Error('模拟单季详情失败'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['101', '102', '103', '104']);
    pending.get('103').resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['101', '102', '103', '104', '105']);
    for (const id of ['105', '104', '101']) pending.get(id).resolve();
    const results = await task;
    assert.equal(maximum, 3);
    assert.equal(active, 0);
    assert.deepEqual(results.map(item => item.bangumiId), ['101', '103', '104', '105']);
    assert.deepEqual(globals.animes.map(item => item.bangumiId), ['101', '103', '104', '105']);
    assert.equal(curAnimes.length, 4);
    assert.equal(details.size, 4);
    assert.equal(globals.episodeIds.length, 4);
  } finally { Object.assign(globals, previous); }
});

test('GET hongguo danmu segments', async () => {
  const episodeId = 'hongguo:v1:series-1:vid-1:60';
  const res = await hongguoSource.getComments(episodeId, 'hongguo', true);
  assert.equal(res.type, 'hongguo');
  assert.equal(res.duration, 60);
  assert.equal(res.segmentList.length, 2);
  assert.notEqual(res.segmentList[0].url, res.segmentList[1].url);
});

const episodeInfo = { seriesId: 'series-1', vid: 'vid-1', duration: 120 };
const commentAt = offsetMs => ({ commentId: `comment-${offsetMs}`, offsetMs, text: `弹幕 ${offsetMs}`, diggCount: 0 });
const commentPage = (startMs, overrides = {}) => ({
  comments: [commentAt(startMs + 1000)],
  nextStart: startMs + 30000,
  cursor: `cursor-${startMs}`,
  hasMore: true,
  declaredWindows: null,
  declaredTotal: null,
  ...overrides,
});

test('hongguo 跨两个窗口的响应使用对应窗口计数之和，避免比例虚高', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ data: {
    extra: { next_query_danmaku_list_time: 60000 },
    common_list_info: { cursor: JSON.stringify({ danmaku_window_count: { '0': 9, '30000': 18, '60000': 24 } }) },
  } });
  const page = await source.fetchCommentWindow(episodeInfo, 0);
  assert.equal(page.declaredWindowComments, 27, '下发覆盖60秒，分母必须为9+18');
  source.request = async () => ({ data: {
    extra: { next_query_danmaku_list_time: 60000 },
    common_list_info: { cursor: JSON.stringify({ danmaku_window_count: { '0': 9 } }) },
  } });
  assert.equal((await source.fetchCommentWindow(episodeInfo, 0)).declaredWindowComments, 0,
    '部分窗口缺失时按未知声明量处理，避免拿局部计数作分母');
});

// 探测测试只使用内存，避免触碰开发目录中的真实身份缓存或 Redis。
async function withMemoryIdentity(run) {
  const values = { redisUrl: '', redisToken: '', localRedisUrl: '', localCacheEnabled: false, hongguoMergeAllEpisodes: false, upstashHashes: {} };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, globals[key]]));
  Object.assign(globals, values);
  try { return await run(); } finally { Object.assign(globals, previous); }
}

test('hongguo 四组都未达标时停止探测并复用最佳结果，不增加候选或降低优质线', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    const counts = [12, 25, 10, 20];
    let calls = 0;
    source.fetchCommentWindow = async () => {
      assert.ok(calls < 4, '最多探测4组');
      const count = counts[calls++];
      return commentPage(0, {
        comments: Array.from({ length: count }, (_, index) => commentAt(index)),
        declaredWindowComments: 556,
      });
    };
    const task = source.ensureDeliveryIdentity(episodeInfo);
    for (let index = 0; index < 5; index++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await task;
    assert.equal(calls, 4);
    assert.equal(source.deliveryIdentityProbe.page.comments.length, 25);
    assert.equal(isQualityDelivery(25, 556), false, '本轮最佳仍不冒充优质档');
    await source.ensureDeliveryIdentity(episodeInfo);
    assert.equal(calls, 4, '选定本轮最佳后不继续探测');
  });
});

test('hongguo cursor 只接受明确的非负整数计数，未知值不会被当成零', async () => {
  const source = new HongguoSource();
  for (const total of [null, '', false, [], {}, -1, 1.5]) {
    source.request = async () => ({ data: { common_list_info: {
      cursor: JSON.stringify({ danmaku_count: total }),
    } } });
    assert.equal((await source.fetchCommentWindow(episodeInfo, 0)).declaredTotal, null, `未知计数 ${JSON.stringify(total)}`);
  }
  source.request = async () => ({ data: { common_list_info: { cursor: 'null' } } });
  assert.equal((await source.fetchCommentWindow(episodeInfo, 0)).declaredTotal, null);
  source.request = async () => ({ data: { common_list_info: {
    cursor: JSON.stringify({ danmaku_count: '0', danmaku_window_count: { '0': '5', '30000': null, '60000': '0' } }),
  } } });
  const page = await source.fetchCommentWindow(episodeInfo, 0);
  assert.equal(page.declaredTotal, 0);
  assert.equal(page.declaredWindowComments, 5);
  assert.equal(page.declaredWindows['30000'], undefined, '未知窗口必须继续请求');
  assert.equal(page.declaredWindows['60000'], 0);
});

test('hongguo 复用窗口零探测结果时也会终止空剧集并跳过已知空窗口', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  const requested = [];
  source.fetchCommentWindow = async (_info, startMs, cursor) => {
    requested.push([startMs, cursor]);
    return commentPage(startMs);
  };
  source.deliveryIdentityProbe = { vid: episodeInfo.vid, page: commentPage(0, { comments: [], declaredTotal: 0 }) };
  assert.deepEqual(await source.getDanmuForEpisode(episodeInfo), []);
  assert.deepEqual(requested, [], '总数为零时不应继续拉取');
  source.deliveryIdentityProbe = { vid: episodeInfo.vid, page: commentPage(0, {
    declaredWindows: { '0': 1, '30000': 0, '60000': 0, '90000': 1 },
  }) };
  assert.deepEqual((await source.getDanmuForEpisode(episodeInfo)).map(item => item.offsetMs), [1000, 91000]);
  assert.deepEqual(requested, [[90000, '']], '跳过窗口后清空旧 cursor');
});

test('hongguo 未知时长按三分钟兜底，局部窗口计数表不会截断兜底范围内弹幕', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  const requested = [];
  source.fetchCommentWindow = async (_info, startMs) => {
    requested.push(startMs);
    return commentPage(startMs, {
      declaredWindows: startMs === 0 ? { '0': 1 } : null,
      hasMore: startMs < 180000,
    });
  };
  const comments = await source.getDanmuForEpisode({ ...episodeInfo, duration: 0 });
  assert.equal(comments.length, 6);
  assert.deepEqual(requested, [0, 30000, 60000, 90000, 120000, 150000]);
});

test('hongguo 整集抓取失败返回空结果且不会返回另一集的历史弹幕', async () => {
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    source.deliveryIdentityReady = true;
    let finish;
    let requests = 0;
    source.fetchCommentWindow = async () => {
      requests++;
      await new Promise(resolve => { finish = resolve; });
      throw new Error('模拟网络失败');
    };
    source.lastDanmu = [commentAt(777)];
    const id = createHongguoEpisodeId(episodeInfo.seriesId, episodeInfo.vid, episodeInfo.duration);
    const tasks = [source.getEpisodeDanmu(id), source.getEpisodeDanmu(id)];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, '同一集同时请求应共享抓取任务');
    finish();
    assert.deepEqual(await Promise.all(tasks), [[], []]);
    assert.equal(source.pendingEpisodeDanmu.size, 0);
  });
});

test('hongguo 限流指令暂停同身份的并发请求，并在发送时生成签名', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(Math, 'random', () => 0);
  const source = new HongguoSource();
  const sent = [];
  await withMockFetch(async (url, options) => {
    sent.push({ time: Date.now(), timestamp: Number(options.headers['X-Khronos']) });
    return mockJsonResponse(sent.length === 1
      ? { code: 500, message: JSON.stringify({ min_ban_time: 3 }) }
      : { code: 0, data: {} }, String(url));
  }, async () => {
    const tasks = [source.request('POST', '/test', { comment: true }), source.request('POST', '/test', { comment: true })];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    t.mock.timers.tick(30);
    await new Promise(resolve => setImmediate(resolve));
    const sentDuringCooldown = sent.length;
    for (let index = 0; index < 8; index++) {
      t.mock.timers.tick(1000);
      await new Promise(resolve => setImmediate(resolve));
    }
    await Promise.all(tasks);
    assert.equal(sentDuringCooldown, 1, '已排队的并发请求也必须遵守冷却');
    for (const request of sent.slice(1)) {
      assert.ok(request.time >= 1700000003000);
      assert.equal(request.timestamp, Math.floor(request.time / 1000), '签名在等待结束后生成');
    }
    assert.equal(source.activeCommentRequests, 0);
  });
});

test('hongguo 节流失败也会释放并发槽位', async () => {
  const source = new HongguoSource();
  source.throttle = async () => { throw new Error('模拟节流异常'); };
  await assert.rejects(source.request('POST', '/test', { comment: true }), /红果请求失败/);
  assert.equal(source.activeCommentRequests, 0);
});

test('hongguo 空探测页不固定身份，短暂退避后可重新探测且并发共享任务', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    let calls = 0;
    source.fetchCommentWindow = async () => {
      calls++;
      return commentPage(0, calls === 1
        ? { comments: [], declaredTotal: 0 }
        : { comments: Array.from({ length: 10 }, (_, i) => commentAt(i)), declaredWindowComments: 20 });
    };
    await Promise.all([source.ensureDeliveryIdentity(episodeInfo), source.ensureDeliveryIdentity(episodeInfo)]);
    assert.equal(calls, 1, '已知空窗口没有身份评估样本，只探测一次');
    assert.equal(source.deliveryIdentityReady, false);
    await source.ensureDeliveryIdentity(episodeInfo);
    assert.equal(calls, 1, '短暂退避期间不反复探测');
    t.mock.timers.tick(30001);
    await Promise.all([source.ensureDeliveryIdentity(episodeInfo), source.ensureDeliveryIdentity(episodeInfo)]);
    assert.equal(calls, 2);
    assert.equal(source.deliveryIdentityReady, true);
    assert.equal(source.deliveryIdentityTask, null);
  });
});

test('hongguo 探测连续失败的计数在成功后清零，并保留最佳候选', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    const otherSource = new HongguoSource();
    const originalOtherUrl = otherSource.buildUrl('/test');
    const candidates = [];
    source.fetchCommentWindow = async () => {
      candidates.push(new URL(source.buildUrl('/test')).searchParams.get('device_id'));
      if (candidates.length === 1 || candidates.length === 3) throw new Error('模拟间歇失败');
      return commentPage(0, {
        comments: Array.from({ length: candidates.length === 2 ? 10 : 40 }, (_, i) => commentAt(i)),
        declaredWindowComments: 200,
      });
    };
    const task = source.ensureDeliveryIdentity(episodeInfo);
    for (let index = 0; index < 5; index++) {
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await task;
    assert.equal(candidates.length, 4, '两次不连续的失败不应提前终止候选探测');
    assert.equal(new URL(source.buildUrl('/test')).searchParams.get('device_id'), candidates[3]);
    assert.equal(source.deliveryIdentityProbe.page.comments.length, 40);
    assert.equal(otherSource.buildUrl('/test').split('?')[1].replace(/&_rticket=\d+$/, ''),
      originalOtherUrl.split('?')[1].replace(/&_rticket=\d+$/, ''), '实例间的身份互不影响');
  });
});

test('hongguo 全部探测失败后仍能在后续请求重新探测', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    let calls = 0;
    source.fetchCommentWindow = async () => {
      calls++;
      if (calls <= 2) throw new Error('模拟启动时网络不可用');
      return commentPage(0, { comments: Array.from({ length: 10 }, (_, i) => commentAt(i)), declaredWindowComments: 20 });
    };
    const task = source.ensureDeliveryIdentity(episodeInfo);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
    await task;
    assert.equal(source.deliveryIdentityReady, false);
    assert.equal(calls, 2);
    t.mock.timers.tick(30001);
    await source.ensureDeliveryIdentity(episodeInfo);
    assert.equal(source.deliveryIdentityReady, true);
    assert.equal(calls, 3);
  });
});

test('hongguo Upstash 身份恢复与持久化支持数组和 result 响应', async () => {
  await withMemoryIdentity(async () => {
    globals.redisUrl = 'https://identity-cache.invalid';
    globals.redisToken = 'test-only';
    const saved = { iid: '1234567890123456', device_id: '2345678901234567', cdid: '12345678-1234-1234-1234-123456789012' };
    for (const raw of [[JSON.stringify(saved)], { result: JSON.stringify(saved) }]) {
      const source = new HongguoSource();
      const commands = [];
      globals.upstashHashes = {};
      await withMockFetch(async (url, options) => {
        commands.push(options.method);
        if (options.method === 'GET') return Response.json(raw);
        assert.deepEqual(JSON.parse(options.body), saved);
        return Response.json({ result: 'OK' });
      }, async () => {
        source.fetchCommentWindow = async () => {
          const params = new URL(source.buildUrl('/test')).searchParams;
          assert.equal(params.get('device_id'), saved.device_id);
          assert.equal(params.get('iid'), saved.iid);
          return commentPage(0, { comments: Array.from({ length: 10 }, (_, i) => commentAt(i)), declaredWindowComments: 20 });
        };
        await source.ensureDeliveryIdentity(episodeInfo);
        assert.deepEqual(commands, ['GET', 'POST']);
        assert.equal(source.deliveryIdentityReady, true);
      });
    }
  });
});

test('hongguo 全集在缺少单集时长时与分段列表采用相同时间轴', async () => {
  const source = new HongguoSource();
  source.getEpisodes = async () => ({ episodes: [
    { vid: 'vid-1', duration: 60 }, { vid: 'vid-2', duration: 0 }, { vid: 'vid-3', duration: 45 },
  ] });
  source.getDanmuForEpisode = async info => info.vid === 'vid-2' ? [] : [{ ...commentAt(1500), commentId: info.vid }];
  await withMockFetch(async () => new Response('<html>没有时长</html>'), async () => {
    const comments = await source.getSeriesDanmu('series-1');
    const segments = await source.getSeriesDanmuSegments('series-1');
    assert.deepEqual(comments.map(item => item.offsetMs), [1500, 241500], '空弹幕集仍占三分钟');
    assert.equal(segments.duration, 285);
    const lastEpisodeSegment = segments.segmentList.find(item => item.url.includes(':vid-3:'));
    assert.equal(lastEpisodeSegment.segment_start, 240);
    const unknownSegments = segments.segmentList.filter(item => item.url.includes(':vid-2:'));
    assert.equal(unknownSegments.length, 6);
    assert.ok(unknownSegments.every(item => item.url.includes(':vid-2:0#')), '兜底值不能冒充真实时长写进 ID');
    assert.equal(source.durationCache.has('series-1:vid-2'), false);
  });
});

test('hongguo 详情返回的真实片长可以复用且不会被三分钟兜底截短', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ data: { video_data: { video_list: [
    { vid: '5678', vid_index: 1, duration: 240 },
  ] } } });
  const details = await source.getEpisodes('1234');
  assert.equal(details.episodes[0].duration, 240);
  assert.equal(source.durationCache.get('1234:5678'), 240);
  source.getEpisodes = async () => assert.fail('已有真实时长缓存，不应补查详情');
  await withMockFetch(async () => assert.fail('已有真实时长缓存，不应请求网页'), async () => {
    const info = await source.resolveEpisodeInfo(createHongguoEpisodeId('1234', '5678', 0));
    assert.equal(info.duration, 240);
    assert.equal(source.getSeriesEpisodeDuration('1234', info), 240);
    const segments = await source.getEpisodeDanmuSegments(createHongguoEpisodeId('1234', '5678', 0));
    assert.equal(segments.duration, 240);
    assert.equal(segments.segmentList.length, 8);
  });
});

test('hongguo 播放器补查只接受当前集的真实片长，并发共享且缓存成功结果', async () => {
  const source = new HongguoSource();
  source.getEpisodes = async () => ({ episodes: [{ vid: '5678', duration: 0 }] });
  const playerUrl = 'https://hongguoduanju.com/player/1234/5678';
  const html = `<script type="application/ld+json">not-json</script>
    <script type='application/ld+json'>${JSON.stringify({ '@graph': [
      { '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1234/9999', duration: 'PT5M' },
      { '@type': ['VideoObject'], '@id': `${playerUrl}#video`, duration: 'PT1M59S' },
    ] })}</script>`;
  let calls = 0;
  await withMockFetch(async url => {
    calls++;
    assert.equal(String(url), playerUrl);
    return new Response(html);
  }, async () => {
    const id = createHongguoEpisodeId('1234', '5678', 0);
    const infos = await Promise.all([source.resolveEpisodeInfo(id), source.resolveEpisodeInfo(id)]);
    assert.deepEqual(infos.map(info => info.duration), [119, 119]);
    assert.equal(calls, 1);
    assert.equal(source.durationCache.get('1234:5678'), 119);
    assert.equal((await source.resolveEpisodeInfo(id)).duration, 119);
    assert.equal(calls, 1, '后续请求复用真实片长');
  });
});

test('hongguo 两处都无时长时单集分段保留三分钟，弹幕位置和兜底值都不写入时长缓存', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  source.getEpisodes = async () => ({ episodes: [{ vid: '5678', duration: 0 }] });
  source.fetchCommentWindow = async () => commentPage(0, { hasMore: false });
  await withMockFetch(async () => new Response('<html>没有时长</html>'), async () => {
    const id = createHongguoEpisodeId('1234', '5678', 0);
    const comments = await source.getEpisodeDanmu(id);
    assert.equal(comments.length, 1);
    assert.equal(source.durationCache.has('1234:5678'), false, '最后弹幕位置不能用于估算真实片长');
    const segments = await source.getEpisodeDanmuSegments(id);
    assert.equal(segments.duration, 180);
    assert.equal(segments.segmentList.length, 6);
    assert.equal(source.durationCache.has('1234:5678'), false, '三分钟只用于保留位置');
  });
});

test('hongguo 时长补查失败短暂复用，三十秒后仍可获得真实时长', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const source = new HongguoSource();
  source.getEpisodes = async () => ({ episodes: [{ vid: '5678', duration: 0 }] });
  let calls = 0;
  await withMockFetch(async () => {
    calls++;
    if (calls === 1) return new Response('暂时不可用', { status: 503 });
    return new Response(`<script type="application/ld+json">${JSON.stringify({
      '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1234/5678', duration: 'PT2M20S',
    })}</script>`);
  }, async () => {
    const id = createHongguoEpisodeId('1234', '5678', 0);
    assert.equal((await source.getEpisodeDanmuSegments(id)).duration, 180);
    assert.equal(source.durationCache.has('1234:5678'), false);
    assert.equal((await source.getEpisodeDanmuSegments(id)).duration, 180);
    assert.equal(calls, 1, '失败负缓存期间不再次请求播放页');
    t.mock.timers.tick(30001);
    assert.equal((await source.getEpisodeDanmuSegments(id)).duration, 140);
    assert.equal(source.durationCache.get('1234:5678'), 140);
    assert.equal(source.pendingDurationLookups.size, 0);
  });
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const apiDetails = (vid = '5678', duration = 90) => ({ data: { video_data: {
  video_list: [{ vid, vid_index: 1, duration }],
} } });

async function withEmptyAnimeCache(run) {
  const values = { animes: [], episodeIds: [], episodeNum: 10001, MAX_ANIMES: 100, strictTitleMatch: false, hongguoMergeAllEpisodes: false };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, globals[key]]));
  Object.assign(globals, values);
  try { return await run(); } finally { Object.assign(globals, previous); }
}

test('hongguo 未知时长集有后半段弹幕时，全集仍不会越界到下一集', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  source.getSeriesEpisodeInfos = async () => [{ vid: 'A', duration: 0 }, { vid: 'B', duration: 120 }];
  const requested = [];
  source.fetchCommentWindow = async (info, start) => {
    requested.push([info.vid, start]);
    return commentPage(start, { comments: [
      { ...commentAt(start + 1000), commentId: `${info.vid}-${start}`, text: info.vid },
      { ...commentAt(271000), commentId: `${info.vid}-out-of-range`, text: info.vid },
    ] });
  };
  const comments = await source.getSeriesDanmu('series');
  const a = comments.filter(item => item.text === 'A').map(item => item.offsetMs);
  const b = comments.filter(item => item.text === 'B').map(item => item.offsetMs);
  assert.deepEqual(a, [1000, 31000, 61000, 91000, 121000, 151000]);
  assert.deepEqual(b, [181000, 211000, 241000, 271000]);
  assert.equal(a.some(time => b.includes(time)), false);
  assert.equal(requested.some(([vid, start]) => vid === 'A' && start >= 180000), false);
  const segments = await source.getSeriesDanmuSegments('series');
  assert.equal(segments.segmentList.find(item => item.url.includes(':B:')).segment_start, 180);
  assert.equal(source.durationCache.has('series:A'), false);
});

test('hongguo 整集与分段都排除片长之外及窗口之外的弹幕', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  source.fetchCommentWindow = async (_info, start) => commentPage(start, {
    comments: [commentAt(-1), commentAt(173999), commentAt(174000), commentAt(174376)],
  });
  const id = createHongguoEpisodeId('1234', '5678', 174);
  const full = await source.getEpisodeDanmu(id);
  const segment = await source.getEpisodeSegmentDanmu({ url: `${id}#segment=150`, segment_start: 150, segment_end: 174 });
  assert.deepEqual(full.map(item => item.offsetMs), [173999]);
  assert.deepEqual(segment, full);
});

test('hongguo 网页正文挂起时两秒取消，联想独有结果正常返回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new HongguoSource();
  let signal;
  let webCalls = 0;
  await withMockFetch(async (url, options) => {
    if (!new URL(url).pathname.startsWith('/search/')) return Response.json({ suggest_list: [
      { ...webSearchRow('1234', '测试剧第三季'), word_type: 'short_play_name' },
    ] });
    webCalls++;
    signal = options.signal;
    // 故意让桩忽略中断：调用方仍必须按预算结束等待。
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
  }, async () => {
    let completed = false;
    const task = source.search('测试剧').then(result => { completed = true; return result; });
    await nextTurn();
    t.mock.timers.tick(1999); await nextTurn();
    assert.equal(completed, false);
    t.mock.timers.tick(1);
    assert.deepEqual((await task).map(item => item.seriesId), ['1234']);
    assert.equal(signal.aborted, true);
    assert.equal(webCalls, 1);
  });
});

test('hongguo 两个网页入口均失效时，App 搜索回退也有两秒预算', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new HongguoSource();
  source.fetchWebSearch = async () => [];
  source.fetchSearchSuggestions = async () => [];
  let signal;
  source.request = async (_method, _path, options) => { signal = options.signal; return new Promise(() => {}); };
  const task = source.search('测试剧');
  await nextTurn();
  t.mock.timers.tick(2000);
  assert.deepEqual(await task, []);
  assert.equal(signal.aborted, true);
});

test('hongguo 网页满二十条时仍给联想独有季预留名额，重复项保留网页资料', async () => {
  const source = new HongguoSource();
  const web = Array.from({ length: 20 }, (_, index) => ({ seriesId: String(1000 + index), name: `网页剧${index}` }));
  source.fetchWebSearch = async () => web;
  source.fetchSearchSuggestions = async () => web.map(item => ({ ...item, name: '联想重复项' })).concat({ seriesId: '9999', name: '补出的第三季' });
  const results = await source.search('测试剧');
  assert.equal(results.length, 20);
  assert.equal(new Set(results.map(item => item.seriesId)).size, 20);
  assert.equal(results.find(item => item.seriesId === '9999').name, '补出的第三季');
  assert.equal(results[0].name, '网页剧0');
  source.fetchSearchSuggestions = async () => Array.from({ length: 20 }, (_, index) => ({ seriesId: String(2000 + index), name: `独有季${index}` }));
  const balanced = await source.search('测试剧');
  assert.equal(balanced.filter(item => Number(item.seriesId) < 2000).length, 10);
  assert.equal(balanced.filter(item => Number(item.seriesId) >= 2000).length, 10);
});

test('hongguo 同剧详情并发共享，两分钟缓存到期刷新且返回值相互隔离', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const source = new HongguoSource();
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  source.request = async () => { calls++; await gate; return apiDetails('5678', calls === 1 ? 90 : 120); };
  const tasks = [source.getEpisodes('1234'), source.getEpisodes('1234')];
  assert.equal(calls, 1);
  release();
  const [first, second] = await Promise.all(tasks);
  first.episodes[0].duration = 999;
  assert.equal(second.episodes[0].duration, 90);
  assert.equal((await source.getEpisodes('1234')).episodes[0].duration, 90);
  assert.equal(calls, 1);
  t.mock.timers.tick(120001);
  assert.equal((await source.getEpisodes('1234')).episodes[0].duration, 120);
  assert.equal(calls, 2);
  assert.equal(source.pendingEpisodeDetails.size, 0);
});

test('hongguo 取消一个详情等待者不影响其他等待者，也不污染共享缓存', async () => {
  const source = new HongguoSource();
  const controller = new AbortController();
  let release;
  let calls = 0;
  source.request = async () => { calls++; return new Promise(resolve => { release = () => resolve(apiDetails()); }); };
  const cancelled = source.getEpisodes('1234', { signal: controller.signal });
  const surviving = source.getEpisodes('1234');
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  release();
  assert.equal((await surviving).episodes.length, 1);
  assert.equal((await source.getEpisodes('1234')).episodes.length, 1);
  assert.equal(calls, 1);
});

test('hongguo 空详情只负缓存三十秒，到期可恢复且缓存容量有上限', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const source = new HongguoSource();
  let calls = 0;
  source.request = async () => { calls++; return calls === 1 ? { data: {} } : apiDetails(); };
  await withMockFetch(async () => new Response('<html>没有详情</html>'), async () => {
    assert.equal((await source.getEpisodes('1234')).episodes.length, 0);
    assert.equal((await source.getEpisodes('1234')).episodes.length, 0);
    assert.equal(calls, 1);
    t.mock.timers.tick(30001);
    assert.equal((await source.getEpisodes('1234')).episodes.length, 1);
    for (let index = 0; index < 105; index++) await source.getEpisodes(String(2000 + index));
    assert.equal(source.episodeDetailsCache.size, 100);
    assert.equal(source.episodeDetailsCache.has('1234'), false);
  });
});

test('hongguo 六个未知时长分段复用详情和时长失败记录，后来拿到真实片长立即生效', async () => {
  const source = new HongguoSource();
  source.deliveryIdentityReady = true;
  let details = 0;
  let players = 0;
  source.request = async () => { details++; return apiDetails('5678', 0); };
  source.fetchCommentWindow = async (_info, start) => commentPage(start);
  await withMockFetch(async () => { players++; return new Response('<html>没有时长</html>'); }, async () => {
    const id = createHongguoEpisodeId('1234', '5678', 0);
    const segments = await source.getEpisodeDanmuSegments(id);
    for (const segment of segments.segmentList) await source.getEpisodeSegmentDanmu(segment);
    assert.equal(details, 1);
    assert.equal(players, 1);
    assert.equal(source.durationCache.has('1234:5678'), false);
    source.cacheEpisodeDurations('1234', [{ vid: '5678', duration: 240 }]);
    assert.equal((await source.getEpisodeDanmuSegments(id)).duration, 240);
    assert.equal(players, 1, '真实时长缓存优先于此前的失败记录');
  });
});

test('hongguo 详情发送间隔降为100ms，十五部即时详情不再等待八秒以上', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(Math, 'random', () => 0);
  const source = new HongguoSource();
  const sent = [];
  await withMockFetch(async url => { sent.push(Date.now()); return mockJsonResponse(apiDetails(), url); }, async () => {
    const task = Promise.all(Array.from({ length: 15 }, (_, index) => source.getEpisodes(String(1000 + index))));
    await nextTurn();
    assert.equal(sent.length, 1);
    for (let index = 0; index < 14; index++) { t.mock.timers.tick(100); await nextTurn(); }
    assert.equal((await task).filter(result => result.episodes.length).length, 15);
    assert.equal(sent.at(-1) - sent[0], 1400);
    assert.equal(source.activeMetadataRequests, 0);
    assert.equal(source.metadataRequestWaiters.length, 0);
  });
});

test('hongguo 元数据最多并发三笔，排队请求取消会释放队列和槽位', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(Math, 'random', () => 0);
  const source = new HongguoSource();
  const controller = new AbortController();
  const releases = [];
  let active = 0;
  let maximum = 0;
  await withMockFetch(async url => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    return mockJsonResponse({ code: 0, data: {} }, url);
  }, async () => {
    const tasks = Array.from({ length: 3 }, () => source.request('POST', '/details'));
    const cancelled = source.request('POST', '/details', { signal: controller.signal });
    await nextTurn();
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    t.mock.timers.tick(200); await nextTurn();
    assert.equal(maximum, 3);
    for (const release of releases) release();
    await Promise.all(tasks);
    assert.equal(source.activeMetadataRequests, 0);
    assert.equal(source.metadataRequestWaiters.length, 0);
  });
});

test('hongguo 弹幕和元数据冷却相互隔离，各自仍遵守服务端冷却', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(Math, 'random', () => 0);
  for (const cooledComment of [true, false]) {
    const source = new HongguoSource();
    const sent = [];
    let attempts = 0;
    await withMockFetch(async (url, options) => {
      const comment = Boolean(options.headers['comment-source']);
      sent.push({ comment, time: Date.now() });
      const payload = comment === cooledComment && ++attempts === 1
        ? { code: 500, message: JSON.stringify({ min_ban_time: 3 }) } : { code: 0, data: {} };
      return mockJsonResponse(payload, url);
    }, async () => {
      const startedAt = Date.now();
      const cooled = source.request('POST', '/test', { comment: cooledComment });
      await nextTurn();
      await source.request('POST', '/test', { comment: !cooledComment });
      assert.equal(sent.length, 2);
      assert.equal(sent[1].time, startedAt, '另一类请求无需等待此次冷却');
      t.mock.timers.tick(2999); await nextTurn();
      assert.equal(sent.length, 2, '触发冷却的接口仍暂停发送');
      for (let index = 0; index < 5; index++) { t.mock.timers.tick(1000); await nextTurn(); }
      await cooled;
      assert.ok(sent[2].time >= startedAt + 3000);
      assert.equal(source.activeMetadataRequests + source.activeCommentRequests, 0);
    });
  }
});

test('hongguo 详情正文挂起时六秒结束共享加载，不再拖住后续搜索', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const source = new HongguoSource();
  let signal;
  await withMockFetch(async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
  }, async () => {
    const task = source.getEpisodes('1234');
    await nextTurn();
    t.mock.timers.tick(6000);
    assert.equal((await task).episodes.length, 0);
    assert.equal(signal.aborted, true);
    assert.equal(source.pendingEpisodeDetails.size, 0);
    assert.equal(source.activeMetadataRequests, 0);
  });
});

test('hongguo 搜索详情八秒预算保留成功季，停止启动后续任务，迟到响应不再写剧目缓存', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withEmptyAnimeCache(async () => {
    const source = new HongguoSource();
    const started = [];
    const releases = [];
    source.getEpisodes = async id => {
      started.push(id);
      if (id === '1000') return { episodes: [{ vid: '5678', index: 1, duration: 90 }] };
      return new Promise(resolve => releases.push(() => resolve({ episodes: [{ vid: `${id}1`, index: 1, duration: 90 }] })));
    };
    const items = Array.from({ length: 6 }, (_, index) => ({ seriesId: String(1000 + index), name: `测试剧第${index + 1}季` }));
    const current = [];
    const task = source.handleAnimes(items, '测试剧', current, new Map());
    await nextTurn();
    assert.equal(started.length, 4);
    t.mock.timers.tick(8000);
    assert.deepEqual((await task).map(item => item.bangumiId), ['1000']);
    assert.equal(started.length, 4);
    for (const release of releases) release();
    await nextTurn();
    assert.deepEqual(globals.animes.map(item => item.bangumiId), ['1000']);
    assert.equal(current.length, 1);
  });
});

test('hongguo 稀疏窗口不换四组身份，重探指数退避到五分钟且不降低优质线', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  await withMemoryIdentity(async () => {
    const source = new HongguoSource();
    let calls = 0;
    source.fetchCommentWindow = async () => {
      calls++;
      return commentPage(0, { comments: Array.from({ length: 3 }, (_, index) => commentAt(index)), declaredWindowComments: 3 });
    };
    for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
      await source.ensureDeliveryIdentity(episodeInfo);
      assert.equal(source.deliveryIdentityRetryAt - Date.now(), delay);
      assert.equal(source.deliveryIdentityReady, false);
      const previousCalls = calls;
      t.mock.timers.tick(delay - 1);
      await source.ensureDeliveryIdentity(episodeInfo);
      assert.equal(calls, previousCalls);
      t.mock.timers.tick(1);
    }
    assert.equal(calls, 6, '每轮稀疏探测只发一笔请求');
    assert.equal(isQualityDelivery(3, 3), false);
  });
});

test('hongguo 网页详情用first_visible_time补年份，播放页正文挂起也按预算回退', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const source = new HongguoSource();
  source.request = async () => { throw new Error('App不可用'); };
  let playerSignal;
  await withMockFetch(async (url, options) => {
    if (new URL(url).pathname === '/detail') return new Response(`<script>{"seriesDetail":${JSON.stringify({
      first_visible_time: 1767225600, vid_list: ['5678'],
    })}}</script>`);
    playerSignal = options.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
  }, async () => {
    const details = await source.getEpisodes('1234');
    assert.equal(details.year, 2026);
    const task = source.resolveEpisodeDuration({ seriesId: '1234', vid: '5678', duration: 0 }, true);
    await nextTurn();
    t.mock.timers.tick(2000);
    assert.equal(await task, 0);
    assert.equal(playerSignal.aborted, true);
    assert.equal(source.durationCache.has('1234:5678'), false);
  });
});
