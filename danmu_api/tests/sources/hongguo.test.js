// 红果源：由剧集 ID 计算分段（无需联网）
// 由 danmu_api/tests/manual/live-source-checks.js 中无需联网的用例提取而来，用例名与断言未改。

import test from 'node:test';
import assert from 'node:assert';
import { getSourceByKey } from '../../sources/registry.js';
import {
  createArgus, createLadon, buildGorgonSeed, transformGorgonSeed, signHongguoRequest,
  createHongguoEpisodeId, parseHongguoEpisodeId, createHongguoSeriesId, parseHongguoSeriesId,
  isHongguoSeriesId, isHongguoPlayerUrl, parseHongguoPlayerUrl,
} from '../../sources/hongguo.js';

const hongguoSource = getSourceByKey('hongguo');

test('GET hongguo danmu segments', async () => {
  const episodeId = 'hongguo:v1:series-1:vid-1:60';
  const res = await hongguoSource.getComments(episodeId, 'hongguo', true);
  assert.equal(res.type, 'hongguo');
  assert.equal(res.duration, 60);
  assert.equal(res.segmentList.length, 2);
  assert.notEqual(res.segmentList[0].url, res.segmentList[1].url);
});

// 以下为红果源的纯函数用例：签名算法、gorgon 种子与剧集/全集 ID 编解码，全部离线。

test('hongguo createArgus 注入随机数后稳定，随 query/stub/时间戳变化', () => {
  // argusProtobuf 内部有随机字段（可签次数与随机值），注入 argusRandom/argusSignCount 后整体可复现
  const fixed = { argusRandom: 0x11223344, argusSignCount: 4 };
  const query = '/api/v1/episode';
  const stub = 'a'.repeat(32);
  const first = createArgus(query, stub, 1700000000, fixed);
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/, '输出为 base64');
  assert.strictEqual(createArgus(query, stub, 1700000000, fixed), first, '同入参同注入随机数必须得到同一签名');
  assert.notStrictEqual(createArgus('/api/v1/other', stub, 1700000000, fixed), first, 'query 参与签名');
  assert.notStrictEqual(createArgus(query, 'b'.repeat(32), 1700000000, fixed), first, 'stub 参与签名');
  assert.notStrictEqual(createArgus(query, stub, 1700000001, fixed), first, '时间戳参与签名');
  assert.notStrictEqual(createArgus(query, stub, 1700000000, { ...fixed, argusRandom: 0x55667788 }), first,
    '注入的随机值参与签名');
});

test('hongguo createLadon 注入随机前缀后确定，且校验前缀长度', () => {
  const options = { ladonRandom: [1, 2, 3, 4] };
  const first = createLadon(1700000000, 12345, options);
  assert.strictEqual(createLadon(1700000000, 12345, options), first, '同入参同随机前缀必须稳定');
  assert.notStrictEqual(createLadon(1700000000, 54321, options), first, 'aid 参与加密');
  assert.notStrictEqual(createLadon(1700000001, 12345, options), first, '时间戳参与加密');
  assert.notStrictEqual(createLadon(1700000000, 12345, { ladonRandom: [1, 2, 3, 5] }), first, '随机前缀参与加密');
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/, '输出为 base64');
  assert.throws(() => createLadon(1700000000, 12345, { ladonRandom: [1, 2, 3] }), RangeError,
    '随机前缀必须是 4 字节');
});

test('hongguo buildGorgonSeed 生成 20 字节种子并校验 khronos', () => {
  const url = 'https://api.hongguoduanju.com/api/v1/episode?aid=123&vid=456';
  const seed = buildGorgonSeed(url, { headers: {}, body: null, khronos: 1700000000 });
  assert.ok(seed instanceof Uint8Array);
  assert.strictEqual(seed.length, 20, 'query(4) + body(4) + cookie(4) + 固定 4 + 时间戳(4)');
  assert.strictEqual(Buffer.from(seed.slice(16)).toString('hex'), (1700000000 >>> 0).toString(16).padStart(8, '0'),
    '末尾 4 字节为大端 khronos');
  assert.strictEqual(Buffer.from(buildGorgonSeed(url, { headers: {}, body: null, khronos: 1700000000 })).toString('hex'),
    Buffer.from(seed).toString('hex'), '同入参稳定');

  const withStub = buildGorgonSeed(url, { headers: { 'x-ss-stub': 'c'.repeat(32) }, body: null, khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withStub).toString('hex'), Buffer.from(seed).toString('hex'), 'stub 参与种子');
  const withBody = buildGorgonSeed(url, { headers: {}, body: '{"a":1}', khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withBody).toString('hex'), Buffer.from(seed).toString('hex'), 'body 摘要参与种子');
  const withCookie = buildGorgonSeed(url, { headers: { cookie: 'sid=abc' }, body: null, khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withCookie).toString('hex'), Buffer.from(seed).toString('hex'), 'cookie 摘要参与种子');

  for (const khronos of [-1, 1.5, 0x1_0000_0000, '1700000000', null, undefined]) {
    assert.throws(() => buildGorgonSeed(url, { khronos }), RangeError, `khronos=${String(khronos)} 非法`);
  }
});

test('hongguo transformGorgonSeed 产出 26 字节并回填 header 字段', () => {
  const seed = new Uint8Array(20).map((_, i) => i + 1);
  const out = transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe3, parameter: 0x1234 });
  assert.strictEqual(out.length, 26, '6 字节头 + 20 字节载荷');
  assert.deepStrictEqual(Array.from(out.slice(0, 6)), [0x84, 0x04, 0x21, 0xe3, 0x34, 0x12], '头部为大端 parameter');
  assert.strictEqual(Buffer.from(out).toString('hex'),
    Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe3, parameter: 0x1234 })).toString('hex'),
    '同入参稳定');
  assert.notStrictEqual(Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x22, headerByte3: 0xe3 })).toString('hex'),
    Buffer.from(out).toString('hex'), 'headerByte2 参与变换');
  assert.notStrictEqual(Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe4 })).toString('hex'),
    Buffer.from(out).toString('hex'), 'headerByte3 参与变换');
  assert.throws(() => transformGorgonSeed(new Uint8Array(19), {}), TypeError, '种子必须是 20 字节');
});

test('hongguo signHongguoRequest 生成四个签名头且参数可复现', () => {
  const url = 'https://api.hongguoduanju.com/api/v1/episode?aid=123456&vid=789';
  // X-Argus / X-Ladon 内部含随机字段，注入后整个签名集合可完整复现
  const options = {
    timestamp: 1700000000, headerByte2: 0x21, headerByte3: 0xe3,
    ladonRandom: [9, 8, 7, 6], argusRandom: 0x11223344, argusSignCount: 4,
  };
  const headers = signHongguoRequest(url, options);
  assert.deepStrictEqual(Object.keys(headers).sort(),
    ['X-Argus', 'X-Gorgon', 'X-Khronos', 'X-Ladon'], '四个签名头缺一不可');
  assert.strictEqual(headers['X-Khronos'], '1700000000');
  assert.match(headers['X-Gorgon'], /^[0-9a-f]{52}$/, 'X-Gorgon 为 26 字节十六进制');
  assert.match(headers['X-Argus'], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepStrictEqual(signHongguoRequest(url, options), headers, '同入参同注入随机数必须完全复现');

  assert.notStrictEqual(signHongguoRequest(url, { ...options, parameter: 7 })['X-Gorgon'], headers['X-Gorgon'],
    'parameter 影响 X-Gorgon');
  assert.throws(() => signHongguoRequest('https://api.hongguoduanju.com/api/v1/episode?vid=789', options),
    TypeError, '缺少数值 aid 时必须报错');
  assert.throws(() => signHongguoRequest(url, { timestamp: -1 }), RangeError, '时间戳必须是无符号 32 位');
});

test('hongguo 剧集/全集 ID 编解码往返（含特殊字符与偏移后缀）', () => {
  const episodeId = createHongguoEpisodeId('series-1', 'vid-1', 60.9);
  assert.strictEqual(episodeId, 'hongguo:v1:series-1:vid-1:60', '时长向下取整');
  assert.deepStrictEqual(parseHongguoEpisodeId(episodeId), { seriesId: 'series-1', vid: 'vid-1', duration: 60 });
  assert.deepStrictEqual(parseHongguoEpisodeId(`${episodeId}#seg-2`), { seriesId: 'series-1', vid: 'vid-1', duration: 60 },
    '解析时忽略 # 之后的定位信息');
  assert.deepStrictEqual(parseHongguoEpisodeId(createHongguoEpisodeId('剧名:特别篇', 'vid:1', -5)),
    { seriesId: '剧名:特别篇', vid: 'vid:1', duration: 0 }, '特殊字符需转义，负时长归零');

  const seriesId = createHongguoSeriesId('series:1');
  assert.strictEqual(seriesId, 'hongguo:series:v1:series%3A1');
  assert.deepStrictEqual(parseHongguoSeriesId(seriesId), { seriesId: 'series:1' });
  assert.strictEqual(isHongguoSeriesId(seriesId), true);
  assert.strictEqual(isHongguoSeriesId(episodeId), false, '剧集 ID 不是全集 ID');
  assert.strictEqual(isHongguoSeriesId('random'), false);

  assert.throws(() => parseHongguoEpisodeId('hongguo:v1:a:b'), /无效的红果剧集 ID/);
  assert.throws(() => parseHongguoEpisodeId(''), /无效的红果剧集 ID/);
  assert.throws(() => parseHongguoSeriesId('hongguo:v1:a:b:1'), /无效的红果全集 ID/);
});

test('hongguo parseHongguoPlayerUrl 支持播放页、剧集 ID 与偏移后缀', () => {
  const playerUrl = 'https://www.hongguoduanju.com/player/1234/5678/?foo=bar#hash';
  assert.deepStrictEqual(parseHongguoPlayerUrl(playerUrl), { seriesId: '1234', vid: '5678' });
  assert.deepStrictEqual(parseHongguoPlayerUrl('http://hongguoduanju.com:8080/player/1234/5678'),
    { seriesId: '1234', vid: '5678' }, '支持 http、自定义端口与省略 www');

  const episodeId = createHongguoEpisodeId('series-1', 'vid-1', 60);
  assert.deepStrictEqual(parseHongguoPlayerUrl(episodeId), { seriesId: 'series-1', vid: 'vid-1' });
  for (const suffix of ['@90', '@%50', '@-30', '@% -30'.replace(' ', '')]) {
    assert.deepStrictEqual(parseHongguoPlayerUrl(`${playerUrl}${suffix}`), { seriesId: '1234', vid: '5678' },
      `偏移后缀 ${suffix} 不参与解析`);
  }

  assert.strictEqual(isHongguoPlayerUrl(playerUrl), true);
  assert.strictEqual(isHongguoPlayerUrl('https://example.com/player/1/2'), false);
  assert.strictEqual(isHongguoPlayerUrl(''), false);
  assert.throws(() => parseHongguoPlayerUrl('https://www.hongguoduanju.com/player/1234'), /无效的红果短剧播放链接/);
});
