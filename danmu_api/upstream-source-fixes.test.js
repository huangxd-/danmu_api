import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Globals } from './configs/globals.js';
import HanjutvSource from './sources/hanjutv.js';
import { cleanSearchQuery, stripSeasonMarker } from './utils/tmdb-util.js';
import { md5, parseDanmakuBase64 } from './utils/codec-util.js';
import TencentSource from './sources/tencent.js';
import IqiyiSource from './sources/iqiyi.js';
import YoukuSource from './sources/youku.js';
import SohuSource from './sources/sohu.js';
import HongguoSource from './sources/hongguo.js';
import { normalizeCoverUrl, getUnavailableReason } from './sources/renren.js';
import { extractAnimeInfo } from './utils/common-util.js';
import { parseOffsetRules, resolveOffsetRule, offsetDuration } from './utils/offset-util.js';
import { findSecondaryMatches, applyMergeLogic } from './utils/merge-util.js';
import { getSourceByKey } from './sources/registry.js';
import { getComment, getCommentByUrl } from './apis/player-api.js';
import { convertToDanmakuJson, groupDanmusByMinute } from './utils/danmu-util.js';
import { isCommentCacheValid, setCommentCache } from './utils/cache-util.js';
import { runWithCommentTransform } from './utils/comment-context.js';

test('Japanese search preserves in-word punctuation and removes season markers', () => {
  for (const title of ['Re:ゼロから始める異世界生活', 'も～っと！おジャ魔女どれみ', '地獄先生ぬ～べ～']) {
    assert.equal(cleanSearchQuery(title), title);
  }
  assert.equal(cleanSearchQuery('ワンパンマン 2nd Season'), 'ワンパンマン');
  assert.equal(stripSeasonMarker('スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE'), 'スティール・ボール・ラン ジョジョの奇妙な冒険');
  assert.equal(stripSeasonMarker('飙马野郎 JOJO的奇妙冒险 第一赛段'), '飙马野郎 JOJO的奇妙冒险');
  assert.equal(stripSeasonMarker('第九部落'), '第九部落');
  assert.equal(cleanSearchQuery('作品名 〜副标题'), '作品名');
});

test('Hanjutv distinguishes an empty search list from invalid responses', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new HanjutvSource();
  assert.deepEqual(await source.extractFromPayload({ rescode: 0, seriesList: [] }, 'unused', 's5'), []);
  await assert.rejects(source.extractFromPayload({ rescode: 0 }, 'unused', 's5'), /缺少有效搜索列表/);
  await assert.rejects(source.extractFromPayload({ rescode: 1, seriesList: [] }, 'unused', 's5'), /接口返回错误/);
});

for (const method of ['buildMobileHeaders', 'buildTvHeaders']) {
  test(`Hanjutv ${method} rotates at 12 hours and shares concurrent identities`, async t => {
    let now = 1700000000000;
    t.mock.method(Date, 'now', () => now);
    const source = new HanjutvSource();
    const first = await Promise.all(Array.from({ length: 4 }, () => source[method]()));
    assert.ok(first.every(item => item.uid === first[0].uid));
    now += 12 * 60 * 60 * 1000 - 1;
    assert.equal((await source[method]()).uid, first[0].uid);
    now++;
    const refreshed = await Promise.all(Array.from({ length: 4 }, () => source[method]()));
    assert.notEqual(refreshed[0].uid, first[0].uid);
    assert.ok(refreshed.every(item => item.uid === refreshed[0].uid));
  });
}

test('Hanjutv concurrent searches wait for the refreshed mobile identity warmup', async t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const source = new HanjutvSource();
  let warmups = 0, finishRefresh;
  t.mock.method(source, 'warmupMobileIdentity', async () => {
    if (++warmups === 2) return new Promise(resolve => { finishRefresh = resolve; });
    return true;
  });
  assert.equal(await source.ensureMobileIdentityWarmed(), true);
  now += 12 * 60 * 60 * 1000 - 1;
  await source.ensureMobileIdentityWarmed();
  assert.equal(warmups, 1);
  now++;
  let completed = 0;
  const pending = Array.from({ length: 4 }, () => source.ensureMobileIdentityWarmed().then(value => { completed++; return value; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warmups, 2);
  assert.equal(completed, 0);
  finishRefresh(true);
  assert.deepEqual(await Promise.all(pending), [true, true, true, true]);
});

test('Hanjutv retries failed initialization once with cache bypass', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new HanjutvSource();
  source._mobileWarmedUid = 'old';
  const attempts = [];
  t.mock.method(source, 'ensureMobileIdentityWarmed', async bypassCache => {
    attempts.push({ bypassCache, warmedUid: source._mobileWarmedUid });
    return false;
  });
  await assert.rejects(source.searchWithS5Api('测试'), /手机身份初始化失败/);
  assert.deepEqual(attempts, [{ bypassCache: false, warmedUid: 'old' }, { bypassCache: true, warmedUid: null }]);
});

test('MD5 matches standard UTF-8 for emoji and supplementary characters', () => {
  for (const input of ['plain', '中文', '标题😀', '𠮷野家']) {
    assert.equal(md5(input), createHash('md5').update(input, 'utf8').digest('hex'));
  }
});

test('codec parseDanmakuBase64 正确解析字段标签占多字节的弹幕', () => {
  // 真实数据：该条含 field 22，其标签占两个字节（0xb2 0x01）。标签按单字节读取会漏掉第二个字节，
  // 使后续字段整体错位，content 会被解析成 field 22 的 JSON 参数
  const elemHex = '0880fe8df4dcf794e61e10948a2d180520192880feff073207393434366161373a15e7bca9e59cb0e68890e5afb8e5a4aae5b885e4ba864095d9a6d606480a621332323139323430373931303635343630343830688080427803a2010130aa010130b2015f7b226964223a32303032352c22636964223a302c22616476616e6365645f626c6f636b223a302c22616e696d6174696f6e5f61747472223a302c226d696d65223a227a6970222c227265736f75726365223a22222c227363616c65223a307dc80101d001b18884e79e01d80101';
  const elem = Buffer.from(elemHex, 'hex');
  const payload = Buffer.concat([Buffer.from([0x0a, 0xd2, 0x01]), elem]);
  const parsed = parseDanmakuBase64(payload.toString('base64'));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].content, '缩地成寸太帅了');
  assert.strictEqual(parsed[0].progress, 738580);
  assert.strictEqual(parsed[0].mode, 5);
});

test('codec parseDanmakuBase64 跳过未知字段与定长字段', () => {
  const elem = new Uint8Array([0x10, 0x7b, 0x3a, 0x0c, ...Buffer.from('正常弹幕', 'utf8')]);
  const payload = new Uint8Array([0x12, 0x01, 0x00, 0x0a, elem.length, ...elem]);
  const parsed = parseDanmakuBase64(Buffer.from(payload).toString('base64'));
  assert.strictEqual(parsed.length, 1, '外层未知字段应被跳过而不是终止解析');
  assert.strictEqual(parsed[0].content, '正常弹幕');

  // 外层字段标签占多字节时同样应被跳过（0xb2 0x01 = field 22, length-delimited）
  const outerElem = new Uint8Array([0x10, 0x7b, 0x3a, 0x0f, ...Buffer.from('外层多字节', 'utf8')]);
  const outerPayload = new Uint8Array([0xb2, 0x01, 0x01, 0x00, 0x0a, outerElem.length, ...outerElem]);
  const parsed3 = parseDanmakuBase64(Buffer.from(outerPayload).toString('base64'));
  assert.strictEqual(parsed3.length, 1, '外层多字节标签的字段应被整体跳过');
  assert.strictEqual(parsed3[0].content, '外层多字节');

  const withFixed = new Uint8Array([0x10, 0x2a, 0xa1, 0x01, 1, 2, 3, 4, 5, 6, 7, 8, 0x3a, 0x0c, ...Buffer.from('定长跳过', 'utf8')]);
  const parsed2 = parseDanmakuBase64(Buffer.from([0x0a, withFixed.length, ...withFixed]).toString('base64'));
  assert.strictEqual(parsed2[0].content, '定长跳过', '内层 64 位定长字段应整体跳过');

  assert.doesNotThrow(() => parseDanmakuBase64(Buffer.from([0x0a, 0x64, 0x08, 0x01]).toString('base64')),
    '截断数据不应抛出');
  assert.doesNotThrow(() => parseDanmakuBase64(Buffer.from([0x0a, 0x05, 0x0b, 0x00, 0x00, 0x00, 0x00]).toString('base64')),
    '内层遇到不支持的 wire type 不应抛出');
});

const VID = 'c4102g9a01t';
const PLAYER_URL = `https://v.qq.com/x/cover/mzc00200803dr6b/${VID}.html`;
const BASE_URL = `https://dm.video.qq.com/barrage/base/${VID}`;
const SEGMENT_URL = `https://dm.video.qq.com/barrage/segment/${VID}/t/v1/0/30000`;

Globals.init({ LOG_LEVEL: "error" });

function mockResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

function buildTencentFetch({ getinfoResponse = null } = {}) {
  const calls = { page: 0, base: 0, getinfo: 0, segment: 0 };

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === PLAYER_URL) {
      calls.page++;
      return mockResponse('<html><title>测试剧集</title></html>');
    }
    if (url === BASE_URL) {
      calls.base++;
      return mockResponse({
        segment_index: {
          '0': { segment_start: '0', segment_name: 't/v1/0/30000' },
        },
      });
    }
    if (url.startsWith('https://vv.video.qq.com/getinfo')) {
      calls.getinfo++;
      return getinfoResponse || mockResponse('QZOutputJson={"vl":{"vi":[{"td":"2812.57"}]}};');
    }
    if (url === SEGMENT_URL) {
      calls.segment++;
      return mockResponse({ barrage_list: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  return { fetchImpl, calls };
}

test('tencent 标题字段规范化与兜底', () => {
  const source = new TencentSource();

  assert.equal(source.normalizeUnionTitle('兰香如故_001'), '兰香如故 第1集');
  assert.equal(source.normalizeUnionTitle(' 兰香如故_01 '), '兰香如故 第1集');
  assert.equal(source.normalizeUnionTitle('01'), '第1集');
  assert.equal(source.normalizeUnionTitle('兰香如故'), '兰香如故');

  assert.equal(
    source.buildEpisodeTitle({ playTitle: '兰香如故 第01集', videoSubtitle: '不争宠只争命' }),
    '兰香如故 第1集 不争宠只争命'
  );
  assert.equal(
    source.buildEpisodeTitle({ playTitle: '兰香如故 第1集', videoSubtitle: '第1集' }),
    '兰香如故 第1集'
  );
  assert.equal(
    source.buildEpisodeTitle({ unionTitle: '兰香如故_002', videoSubtitle: '标题' }),
    '兰香如故 第2集 标题'
  );
  assert.equal(source.buildEpisodeTitle({ cTitleOutput: '003' }), '第3集');
  assert.equal(source.buildEpisodeTitle({ title: '004' }), '第4集');
  assert.equal(
    source.buildEpisodeTitle({ playTitle: '优先标题', unionTitle: '兜底标题_09', cTitleOutput: '09' }),
    '优先标题'
  );
});

test('tencent getVideoDuration 支持 JSONP 字符串和已解析对象', async () => {
  const source = new TencentSource();

  const jsonpDuration = await withMockFetch(
    async () => mockResponse('QZOutputJson={"vl":{"vi":[{"td":"2751.55"}]}};'),
    () => source.getVideoDuration(VID)
  );
  assert.equal(jsonpDuration, 2751.55);

  const objectDuration = await withMockFetch(
    async () => mockResponse({ vl: { vi: [{ td: '2562.54' }] } }),
    () => source.getVideoDuration(VID)
  );
  assert.equal(objectDuration, 2562.54);
});

test('tencent getVideoDuration 缺失或非法 td 时返回 0', async () => {
  const source = new TencentSource();

  const missingTd = await withMockFetch(
    async () => mockResponse('QZOutputJson={"vl":{"vi":[{}]}};'),
    () => source.getVideoDuration(VID)
  );
  assert.equal(missingTd, 0);

  const malformedJson = await withMockFetch(
    async () => mockResponse('QZOutputJson={not-json};'),
    () => source.getVideoDuration(VID)
  );
  assert.equal(malformedJson, 0);

  const invalidTd = await withMockFetch(
    async () => mockResponse('QZOutputJson={"vl":{"vi":[{"td":"not-a-number"}]}};'),
    () => source.getVideoDuration(VID)
  );
  assert.equal(invalidTd, 0);

  let fetchCount = 0;
  const emptyVid = await withMockFetch(
    async () => {
      fetchCount++;
      throw new Error('empty vid should not fetch');
    },
    () => source.getVideoDuration('')
  );
  assert.equal(emptyVid, 0);
  assert.equal(fetchCount, 0);
});

test('tencent 普通弹幕流程不请求 getinfo', async () => {
  const source = new TencentSource();
  const { fetchImpl, calls } = buildTencentFetch();

  const comments = await withMockFetch(fetchImpl, () => source.getEpisodeDanmu(PLAYER_URL));

  assert.deepEqual(comments, []);
  assert.equal(calls.page, 1);
  assert.equal(calls.base, 1);
  assert.equal(calls.segment, 1);
  assert.equal(calls.getinfo, 0);
});

test('tencent 分片接口按需请求时长，includeDuration=false 时跳过', async () => {
  const source = new TencentSource();
  const withDuration = buildTencentFetch();

  const result = await withMockFetch(
    withDuration.fetchImpl,
    () => source.getEpisodeDanmuSegments(VID)
  );
  assert.equal(result.duration, 2812.57);
  assert.equal(result.segmentList.length, 1);
  assert.equal(result.segmentList[0].segment_end, 30);
  assert.equal(withDuration.calls.getinfo, 1);

  const withoutDuration = buildTencentFetch();
  const noDurationResult = await withMockFetch(
    withoutDuration.fetchImpl,
    () => source.getEpisodeDanmuSegments(VID, false)
  );
  assert.equal(noDurationResult.duration, 0);
  assert.equal(noDurationResult.segmentList.length, 1);
  assert.equal(withoutDuration.calls.getinfo, 0);
});

test('tencent getinfo 失败时保留分片列表并回退 duration=0', async () => {
  const source = new TencentSource();
  const { fetchImpl } = buildTencentFetch({ getinfoResponse: mockResponse('server error', 500) });

  const result = await withMockFetch(fetchImpl, () => source.getEpisodeDanmuSegments(VID));

  assert.equal(result.duration, 0);
  assert.equal(result.segmentList.length, 1);
});

const buildTitle = (epData) => IqiyiSource.prototype._buildEpisodeTitle.call({}, epData);
const ensureNumber = (title, animeTitle, order) =>
  IqiyiSource.prototype._ensureEpisodeNumber.call({}, title, animeTitle, order);

test('iqiyi episode title uses short_display_name and appends subtitle', () => {
  assert.strictEqual(buildTitle({ short_display_name: '太古神尊 天魔秘藏' }), '太古神尊 天魔秘藏');
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
  // 分集名已包含副标题时不重复拼接
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集 巨额悬赏', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
});

test('iqiyi episode title falls back when name fields are missing', () => {
  assert.strictEqual(buildTitle({ title: '太古神尊 外门考核' }), '太古神尊 外门考核');
  assert.strictEqual(buildTitle({}), '未知分集');
});

test('iqiyi episode number is inserted after the anime title when missing', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊', 10),
    '太古神尊 第10集 天魔秘藏'
  );
  // 不以作品名开头时集数置于标题前
  assert.strictEqual(ensureNumber('天魔秘藏', '太古神尊', 10), '第10集 天魔秘藏');
  // 作品名带年份与类型后缀时，剥去后缀再比对
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊(2026)【3D动漫】from iqiyi', 10),
    '太古神尊 第10集 天魔秘藏'
  );
});

test('iqiyi episode number keeps titles that already carry an episode number', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 第11集 巨额悬赏', '太古神尊', 11),
    '太古神尊 第11集 巨额悬赏'
  );
  // 接口的其它集数写法同样视为已含集数
  assert.strictEqual(ensureNumber('太古神尊 EP11', '太古神尊', 11), '太古神尊 EP11');
});

test('iqiyi episode number is not added without a valid order', () => {
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', undefined), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', null), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', ''), '太古神尊 天魔秘藏');
});

test('iqiyi episode titles share one format across all episodes', () => {
  const animeTitle = '太古神尊';
  const withoutNumber = ['太子转生', '天魔秘藏'].map((name, index) =>
    ensureNumber(buildTitle({ short_display_name: `${animeTitle} ${name}` }), animeTitle, index + 1)
  );
  const withNumber = ensureNumber(buildTitle({ short_display_name: `${animeTitle} 第11集`, subtitle: '巨额悬赏' }), animeTitle, 11);
  for (const title of [...withoutNumber, withNumber]) {
    assert.match(title, new RegExp(`^${animeTitle} 第\\d+集 `));
  }
});

async function withMockFetch(fetchImpl, action) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('ungrouped single-source comments are sorted without mutating input', () => {
  const comments = [{ p: '30,1,16777215,0', m: 'late' }, { p: '1,1,16777215,0', m: 'early' }];
  const sorted = groupDanmusByMinute(comments, 0);
  assert.deepEqual(sorted.map(item => item.m), ['early', 'late']);
  assert.deepEqual(comments.map(item => item.m), ['late', 'early']);
});

test('Youku normalizes nested text and properties without using nicknames', () => {
  const comments = new YoukuSource().formatComments([
    { playat: 1000, content: '正文', propertis: '{"pos":"1","color":"#ff0000"}' },
    { timepoint: 2, progress: 2000, content: { text: '嵌套正文' }, properties: { pos: 2, color: '#123456' } },
    { progress: 3000, text: [' ', { value: '数组正文' }] },
    { time: 4, extFields: { text: '备用正文' } },
    { playat: 5000, content: '', name: '仅有昵称' },
  ]);
  assert.deepEqual(comments.map(item => item.m), ['正文', '嵌套正文', '数组正文', '备用正文']);
  assert.deepEqual(comments.map(item => item.timepoint), [1, 2, 3, 4]);
  assert.equal(comments[0].ct, 5);
  assert.equal(comments[0].color, 16711680);
  assert.equal(comments[1].ct, 4);
  assert.equal(comments[1].color, 0x123456);
});

test('Youku segment extraction accepts legacy and updated result envelopes', async () => {
  const source = new YoukuSource();
  const rows = [{ playat: 1000, content: '正文' }];
  for (const data of [
    { data: { result: JSON.stringify({ data: { result: rows } }) } },
    { data: { result: { data: { items: rows } } } },
    { result: { comments: rows } },
  ]) {
    const result = await withMockFetch(async () => mockResponse(data), () => source.getEpisodeSegmentDanmu({ url: 'https://example.com/danmu', data: '{}' }));
    assert.deepEqual(result, rows);
  }
});

test('comment cache refreshes malformed text while preserving valid entries', () => {
  Globals.init({ LOG_LEVEL: 'error', COMMENT_CACHE_MINUTES: '60', COMMENT_CACHE_MIN_COUNT: '0' });
  const url = 'https://example.com/cache-test';
  for (const comments of [[{ content: '旧正文' }], [{ m: ' ' }]]) {
    setCommentCache(url, comments);
    assert.equal(isCommentCacheValid(url), false);
    assert.equal(Globals.commentCache.has(url), false);
  }
  setCommentCache(url, [{ m: '有效正文', p: '1,1,16777215,0' }]);
  assert.equal(isCommentCacheValid(url), true);
});

test('ungrouped mixed source labels deduplicate only identical time and text', () => {
  Globals.init({ LOG_LEVEL: 'error', GROUP_MINUTE: '0', BLOCKED_WORDS: '', LIKE_SWITCH: 'false', CONVERT_COLOR: 'default', GRADIENT_ENABLED: 'false' });
  const row = (time, source) => ({ p: `${time},1,16777215,[${source}]`, m: '同一句话', _sourceLabel: source });
  const mixed = convertToDanmakuJson([row(10, 'bilibili'), row(10, 'tencent'), row(10.5, 'tencent')], 'bilibili＆tencent');
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed.map(item => item.t), [10, 10.5]);
  assert.match(mixed[0].p, /bilibili＆tencent/);
  assert.equal(convertToDanmakuJson([row(10, 'bilibili'), row(10, 'bilibili')], 'bilibili').length, 2);
  assert.equal(convertToDanmakuJson([row(10, 'bilibili＆tencent'), row(10, 'bilibili＆tencent')], 'bilibili＆tencent').length, 1);
});

test('Sohu accepts decimal and hex colors and uses the shared configured color pool', () => {
  const source = new SohuSource();
  const rows = ['16711680', '#00ff00', 'AABBCC', 255].map((color, index) => ({ t: { c: color }, c: `颜色${index}`, v: index + 1 }));
  Globals.init({ LOG_LEVEL: 'error', CONVERT_COLOR: 'default' });
  assert.deepEqual(source.formatComments(rows).map(item => Number(item.p.split(',')[3])), [16711680, 65280, 0xAABBCC, 255]);
  Globals.init({ LOG_LEVEL: 'error', CONVERT_COLOR: 'color', COLOR_POOL: '1193046', GROUP_MINUTE: '0', BLOCKED_WORDS: '', LIKE_SWITCH: 'false', GRADIENT_ENABLED: 'false' });
  const colored = convertToDanmakuJson(source.formatComments(rows), 'sohu');
  assert.ok(colored.every(item => Number(item.p.split(',')[2]) === 1193046));
  runWithCommentTransform(() => {
    Globals.init({ LOG_LEVEL: 'error', CONVERT_COLOR: 'default' });
    assert.ok(source.formatComments(rows).every(item => Number(item.p.split(',')[3]) === 16777215), '已开始请求使用原有颜色配置');
  });
});

test('Tencent and Iqiyi concurrency settings have defaults and integer limits', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  assert.equal(Globals.envs.tencentConcurrency, 100);
  assert.equal(Globals.envs.iqiyiConcurrency, 100);
  Globals.init({ LOG_LEVEL: 'error', TENCENT_CONCURRENCY: '999', IQIYI_CONCURRENCY: '-1' });
  assert.equal(Globals.envs.tencentConcurrency, 200);
  assert.equal(Globals.envs.iqiyiConcurrency, 1);
  Globals.init({ LOG_LEVEL: 'error', TENCENT_CONCURRENCY: '2.9', IQIYI_CONCURRENCY: '3.8' });
  assert.equal(Globals.envs.tencentConcurrency, 2);
  assert.equal(Globals.envs.iqiyiConcurrency, 3);
});

for (const [name, Source, setting] of [['Tencent', TencentSource, 'TENCENT_CONCURRENCY'], ['Iqiyi', IqiyiSource, 'IQIYI_CONCURRENCY']]) {
  test(`${name} bounds active segments, continues past a slow segment and retains other results on failure`, async t => {
    Globals.init({ LOG_LEVEL: 'error', [setting]: '2' });
    const source = new Source();
    const segments = Array.from({ length: 4 }, (_, index) => ({ url: `https://example.com/segment/${index}`, segment_start: index, segment_end: index + 1 }));
    t.mock.method(source, 'getEpisodeDanmuSegments', async () => ({ segmentList: segments }));
    let active = 0, peak = 0, releaseFirst;
    const started = [];
    const download = async index => {
      started.push(index);
      peak = Math.max(peak, ++active);
      try {
        if (index === 0) await new Promise(resolve => { releaseFirst = resolve; });
        if (index === 2) throw new Error('坏分片');
        return [{ content: `分片${index}` }];
      } finally { active--; }
    };
    if (name === 'Iqiyi') t.mock.method(source, 'getEpisodeSegmentDanmu', segment => download(segment.segment_start));
    t.mock.method(globalThis, 'fetch', async input => {
      const url = String(input);
      if (!url.includes('/segment/')) return mockResponse('<title>测试</title>');
      const index = Number(url.split('/').at(-1));
      // 腾讯的 JSON 错误发生在单片解析阶段，无需触发 HTTP 重试。
      if (index === 2) {
        started.push(index);
        return mockResponse('{bad-json');
      }
      return mockResponse({ barrage_list: await download(index) });
    });
    const pending = source.getEpisodeDanmu('https://example.com/video');
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(started, [0, 1, 2, 3], '第一个分片未完成时其余空闲名额继续下载');
      assert.equal(peak, 2);
    } finally { releaseFirst?.(); }
    assert.deepEqual((await pending).map(item => item.content), ['分片0', '分片1', '分片3']);
  });
}

const webSeries = (id, name = '测试短剧') => ({ video_data: { series_id: id, series_name: name, episode_cnt: 30 } });

test('Hongguo searches the web API, deduplicates pages and retains results if a later page fails', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new HongguoSource();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    calls.push(url.pathname);
    assert.equal(url.searchParams.get('query'), '测试 短剧');
    const page = Number(url.searchParams.get('page'));
    if (page === 3) throw new Error('第三页失败');
    return mockResponse({ searchList: page === 1 ? [webSeries('1')] : [webSeries('1'), webSeries('2')] });
  });
  assert.deepEqual((await source.search('测试 短剧')).map(item => item.seriesId), ['1', '2']);
  assert.deepEqual(calls, Array(3).fill('/api/search/result/'));
});

test('Hongguo keeps SSR fallback and shares one deadline across App fallback pages', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new HongguoSource();
  t.mock.method(globalThis, 'fetch', async input => mockResponse(String(input).includes('/api/search/result/') ? { searchList: [] } : `<script>{"searchList":${JSON.stringify([webSeries('ssr')])}}</script>`));
  assert.equal((await source.search('测试'))[0].seriesId, 'ssr');
  t.mock.method(globalThis, 'fetch', async input => mockResponse(String(input).includes('/api/search/result/') ? [] : '无SSR'));
  let now = 1700000000000, appCalls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(source, 'request', async (_method, _path, options) => {
    appCalls++;
    assert.equal(options.deadline, 1700000010000);
    now = options.deadline;
    return { search_tabs: [] };
  });
  assert.deepEqual(await source.search('测试'), []);
  assert.equal(appCalls, 1);
});

test('Hongguo stops at the shared search deadline without starting fallback traffic', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  let now = 1700000000000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    now += 10000;
    return mockResponse({ searchList: [] });
  });
  assert.deepEqual(await new HongguoSource().search('测试'), []);
  assert.equal(calls, 1);
});

test('Hongguo App host fallback stops when its search deadline expires', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  let now = 1700000000000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const source = new HongguoSource();
  t.mock.method(source, 'throttle', async () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    now += 10000;
    throw new Error('超时');
  });
  await assert.rejects(source.request('GET', '/reading/bookapi/search/tab/v', { deadline: now + 10000 }), /红果搜索超时/);
  assert.equal(calls, 1);
});


test('红果搜索和 SSR 兜底均发送浏览器头，仍遵守共享搜索预算', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new HongguoSource();
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input); const h = new Headers(options.headers);
    seen.push({ path: url.pathname, ua: h.get('user-agent'), referer: h.get('referer'), accept: h.get('accept') });
    return mockResponse(url.pathname.includes('/api/search/') ? { searchList: [] } : `<script>{"searchList":${JSON.stringify([webSeries('ssr')])}}</script>`);
  });
  assert.equal((await source.search('测试'))[0].seriesId, 'ssr');
  assert.equal(seen.length, 2);
  assert.ok(seen.every(row => row.ua.includes('Mozilla') && row.referer === 'https://hongguoduanju.com/'));
  assert.match(seen[0].accept, /application\/json/); assert.match(seen[1].accept, /text\/html/);
});

test('腾讯搜索补全相关分区的多季并排除无关和重复候选', async t => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new TencentSource();
  const item = (id, title) => ({ doc: { id }, videoInfo: { title } });
  const box = (name, items) => ({ boxTitle: { boxTitles: [name] }, itemList: items });
  t.mock.method(source, 'filterTencentSearchItem', x => ({ mediaId: x.doc.id, title: x.videoInfo.title }));
  t.mock.method(source, 'extractChapterContexts', () => []);
  t.mock.method(globalThis, 'fetch', async () => mockResponse({ ret: 0, data: { normalList: { itemList: [item('3', '一念永恒 完结季')] }, areaBoxList: [
    box('与一念永恒相关', [item('1', '一念永恒 第一季'), item('3', '一念永恒 完结季')]),
    box('一念永恒', [item('2', '一念永恒 第二季'), item('z', '无关作品')]),
    box('相关短视频', [item('bad', '一念永恒 片段')])
  ] } }));
  assert.deepEqual((await source.search('一念永恒')).map(row => row.mediaId), ['3','1','2']);
});

test('人人视频封面直连与无分集原因', () => {
  assert.equal(normalizeCoverUrl('https://img.bwcgee.cn/a.webp'), 'https://img.duoduoshipin.vip/a.webp');
  assert.equal(normalizeCoverUrl('https://example.com/a.webp'), 'https://example.com/a.webp');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: 'NOT_BROADCAST' } }), '尚未开播');
  assert.equal(getUnavailableReason({ dramaInfo: {} }), '尚未上线');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: 'FINISH' } }), '无播放资源');
});

test('完整标题偏移规则匹配及不同时间轴端点', () => {
  const context = extractAnimeInfo('钢铁侠2(2010)【电影】from tencent', '【tencent】 正片');
  const rules = parseOffsetRules('钢铁侠2:10');
  assert.equal(resolveOffsetRule(rules, { anime: context.baseTitle, fullTitle: context.fullTitle, source: 'tencent' })?.offset, 10);
  assert.equal(offsetDuration(100, 10, false), 110);
  assert.equal(offsetDuration(120, 10, true, 100), 132);
  assert.equal(offsetDuration(100, -150, false), 0);
  assert.equal(offsetDuration(0, 20, false, 100), 20);
});

test('合并拒绝电影和共享别名的动画季，并更新合并目录集数', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&youku' });
  const make = (id, title, source, type, n, aliases = []) => ({ animeId: id, bangumiId: String(id),
    animeTitle: `${title}(2026)【${type}】from ${source}`, aliases, source, type, typeDescription: type,
    startDate: '2026-01-01', episodeCount: n, links: Array.from({ length:n }, (_,i) => ({ title:`【${source}】 第${i+1}集`, url:`${source}:${id}:${i}` })) });
  const movie = make(1, '银河护卫队', 'tencent', '电影', 1);
  const series = make(2, '银河守护者 第一季', 'youku', 'TV动画', 12, ['银河护卫队']);
  assert.deepEqual(findSecondaryMatches(movie, [series], new Set(), ['youku']), []);
  const primary = make(3, '目录测试作品', 'tencent', '动漫', 2);
  const secondary = make(4, '目录测试作品', 'youku', '动漫', 5);
  Globals.animes = [primary, secondary];
  const details = new Map();
  await applyMergeLogic([primary, secondary], details);
  const all = [...Globals.animes, ...details.values()];
  const merged = all.find(x => x.animeTitle?.includes('from tencent&youku'));
  assert.ok(merged); assert.ok(merged.links.length > 2); assert.equal(merged.episodeCount, merged.links.length);
});

test('偏移后的单源与多源时长在冷缓存和热缓存均与弹幕时间一致', async t => {
  Globals.init({ LOG_LEVEL:'error', SOURCE_ORDER:'tencent,youku', MERGE_SOURCE_PAIRS:'tencent&youku',
    LOCAL_CACHE_ENABLED:'false', LOCAL_REDIS_URL:'', BILIBILI_UGC_ENABLED:'false', BLOCK_DOMESTIC_CELEBRITIES:'false',
    GROUP_MINUTE:'0', COMMENT_CACHE_MINUTES:'30', COMMENT_CACHE_MIN_COUNT:'0', DANMU_OFFSET:'钢铁侠2@tencent:10,钢铁侠2@youku:-20' });
  Globals.animes=[]; Globals.episodeIds=[]; Globals.episodeNum=10001; Globals.commentCache=new Map(); Globals.searchCache=new Map();
  const tx=getSourceByKey('tencent'), yk=getSourceByKey('youku');
  for (const [src,duration] of [[tx,100],[yk,120]]) {
    t.mock.method(src,'getComments', async (_url,_label,segment) => segment ? {duration,segmentList:[]} : [{p:'90,1,16777215,[tencent]',m:'弹幕'}]);
    t.mock.method(src,'getEpisodeDanmu', async () => [{p:'90,1,25,16777215,0,0,0,1',m:'弹幕'}]);
    t.mock.method(src,'formatComments', rows => rows);
  }
  const single='https://v.qq.com/x/cover/a/b.html@5';
  const merged='tencent:https://v.qq.com/x/cover/a/b.html@5$$$youku:https://v.youku.com/v_show/id_c.html@10';
  Globals.animes=[{animeId:101,bangumiId:'a',animeTitle:'钢铁侠2(2010)【电影】from tencent',source:'tencent',type:'电影',links:[
    {id:10001,url:single,title:'【tencent】 正片'}, {id:10002,url:merged,title:'【tencent＆youku】 正片'}]}];
  for(const [id,expected] of [[10001,115],[10002,115]]) {
    for(let i=0;i<2;i++) {
      const reply=await (await getComment(`/api/v2/comment/${id}`,'json',false,'',true)).json();
      assert.equal(reply.videoDuration,expected,`id ${id} request ${i}`);
      const times=reply.comments.map(row => Number(row.p.split(',')[0]));
      assert.ok(times.includes(id === 10001 ? 105 : 80), `id ${id}: ${times}`);
    }
  }
  const byUrl=await (await getCommentByUrl(single,'json',false,true)).json();
  assert.equal(byUrl.videoDuration,105);
  const byUrlPercent=await (await getCommentByUrl('https://v.qq.com/x/cover/a/b.html@%10','json',false,true)).json();
  assert.equal(byUrlPercent.videoDuration,110);
  assert.equal(Number(byUrlPercent.comments[0].p.split(',')[0]),99);
});


test('百分比链接和规则连续偏移复用时长，冷暖缓存端点一致', async t => {
  Globals.init({ LOG_LEVEL:'error', SOURCE_ORDER:'tencent', MERGE_SOURCE_PAIRS:'',
    LOCAL_CACHE_ENABLED:'false', LOCAL_REDIS_URL:'', BILIBILI_UGC_ENABLED:'false', BLOCK_DOMESTIC_CELEBRITIES:'false',
    GROUP_MINUTE:'0', COMMENT_CACHE_MINUTES:'30', COMMENT_CACHE_MIN_COUNT:'0', DANMU_OFFSET:'钢铁侠2@tencent%:10' });
  Globals.animes=[]; Globals.episodeIds=[]; Globals.commentCache=new Map(); Globals.searchCache=new Map();
  const tx=getSourceByKey('tencent'); let durationCalls=0;
  t.mock.method(tx,'getComments',async (_url,_label,segment) => {
    if (segment) { durationCalls++; return {duration:100,segmentList:[]}; }
    return [{p:'90,1,16777215,[tencent]',m:'弹幕'}];
  });
  Globals.animes=[{animeId:111,bangumiId:'a',animeTitle:'钢铁侠2(2010)【电影】from tencent',source:'tencent',type:'电影',links:[
    {id:10005,url:'https://v.qq.com/x/cover/a/b.html@%10',title:'【tencent】 正片'}]}];
  for(let i=1;i<=2;i++) {
    const reply=await (await getComment('/api/v2/comment/10005','json',false,'',true)).json();
    assert.equal(reply.videoDuration,121); assert.equal(Number(reply.comments[0].p.split(',')[0]),108.9);
    assert.equal(durationCalls,i,'单次请求只读取一次时长');
  }
});
