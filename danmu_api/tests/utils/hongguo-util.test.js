import test from 'node:test';
import assert from 'node:assert';
import {
  createArgus, createLadon, buildGorgonSeed, transformGorgonSeed, signHongguoRequest,
  createHongguoEpisodeId, parseHongguoEpisodeId, createHongguoSeriesId, parseHongguoSeriesId,
  isHongguoSeriesId, isHongguoPlayerUrl, parseHongguoPlayerUrl, isQualityDelivery,
  parseWebSearchResults, parseSearchSuggestions, parseHongguoResponse,
  parseApiEpisodeDetails, parseWebEpisodeDetails, parseCommentWindow, dedupeDanmus,
  createHongguoIdentity, parseHongguoIdentity, maskHongguoIdentity, getFragmentNumber,
} from '../../utils/hongguo-util.js';

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
  assert.deepStrictEqual(Array.from(out.slice(0, 6)), [0x84, 0x04, 0x21, 0xe3, 0x34, 0x12], '头部依次存储 parameter 的低字节和高字节');
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
  assert.strictEqual(isHongguoPlayerUrl(createHongguoSeriesId('series-1')), true,
    '全集（series）链接也应被识别为红果链接，避免分发时前缀被剥离');
  assert.throws(() => parseHongguoPlayerUrl('https://www.hongguoduanju.com/player/1234'), /无效的红果短剧播放链接/);
});

test('hongguo 优质线为18%，保留100条绝对线，并提高小样本要求', () => {
  const cases = [
    [92, 606, false, '实测一般档15.2%不应提前停止'],
    [88, 556, false, '15.8%的候选仍继续择优'],
    [20, 111, true, '刚过18%且至少20条可达标'],
    [20, 112, false, '低于18%继续探测'],
    [19, 80, false, '普通窗口至少20条，避免小样本比例偏高'],
    [119, 606, true, '实测19.6%并非不可达'],
    [100, 1471, true, '热门剧声明量大时保留100条绝对线'],
    [99, 1471, false, '不满足绝对线或比例线则继续探测'],
    [100, 0, true, '缺失声明量时按绝对线判定'],
    [99, 0, false, '缺失声明量时不降低门槛'],
    [6, 13, false, '实测一般身份6/13不应被判优质'],
    [7, 13, true, '小窗口至少5条且达到50%'],
    [4, 5, false, '小窗口只有4条仍不足以判优质'],
  ];
  for (const [delivered, declared, expected, message] of cases) {
    assert.strictEqual(isQualityDelivery(delivered, declared), expected, message);
  }
});

test('hongguo 网页JSON提取保留字符串中的括号、引号和转义，损坏数据返回空结果', () => {
  const id = '7633436713011907608';
  const title = '测试 ] } " \\ 第三季';
  const row = { keyword: id, name: title, video_data: {
    series_id: Number(id), episode_cnt: 58, create_time: 1767225600,
    series_cover: { url_list: ['//example.com/cover.jpg'] },
  } };
  const html = `<script>{"searchList":${JSON.stringify([row])},"next":[]}</script>`;
  assert.deepEqual(parseWebSearchResults(html), [{
    seriesId: id, name: title, episodeCount: 58, score: '', year: 2026, imageUrl: 'https://example.com/cover.jpg',
  }]);
  assert.deepEqual(parseSearchSuggestions({ data: { suggest_list: [{ ...row, word_type: 'short_play_name' }] } }), parseWebSearchResults(html));
  for (const invalid of ['', '"searchList":null', '"searchList":[{"name":"broken ]', '"searchList":{}']) {
    assert.deepEqual(parseWebSearchResults(invalid), []);
  }
  assert.throws(() => parseSearchSuggestions({ data: {} }), /有效剧目列表/);
});

test('hongguo 网页详情解析兼容字符串和对象选集，嵌套元数据不会提前截断', () => {
  const detail = { first_visible_time: 1767225600, series_cover: '//example.com/series.jpg',
    intro: '说明 } ] " \\ 不参与括号配对', vid_list: [
      '5678', { video_id: '5679', title: ' 标题 } " ', video_duration: 240, cover: { urls: ['//example.com/episode.jpg'] } }, null,
    ] };
  const parsed = parseWebEpisodeDetails(`<script>{"seriesDetail":${JSON.stringify(detail)},"other":{}}</script>`);
  assert.equal(parsed.year, 2026);
  assert.equal(parsed.imageUrl, 'https://example.com/series.jpg');
  assert.deepEqual(parsed.episodes.map(item => [item.vid, item.index, item.duration, item.title]), [
    ['5678', 1, 0, '第1集'], ['5679', 2, 240, '标题 } "'],
  ]);
  assert.equal(parsed.episodes[1].imageUrl, 'https://example.com/episode.jpg');
  assert.equal(parseWebEpisodeDetails('"seriesDetail":{"vid_list":[]}'), null);
  assert.equal(parseWebEpisodeDetails('"seriesDetail":{"vid_list":['), null);
});

test('hongguo API详情按完整剧集键提取，排序并保留未知时长和有效封面', () => {
  const id = '7633436713011907608';
  const parsed = parseApiEpisodeDetails({ data: { [id]: { video_data: { first_visible_time: 1767225600, video_list: [
    { vid: 'B', vid_index: 2, duration: -1 },
    { vid: 'A', vid_index: 1, duration: '240', episode_title: ' 标题 ', episode_cover: { url: '//example.com/a.jpg' } },
    { vid: '', vid_index: 3, duration: 60 },
  ] } } } }, id);
  assert.deepEqual(parsed.episodes.map(item => [item.vid, item.index, item.duration, item.title]), [
    ['A', 1, 240, '标题'], ['B', 2, 0, ''],
  ]);
  assert.equal(parsed.year, 2026);
  assert.equal(parsed.imageUrl, 'https://example.com/a.jpg');
  assert.equal(parseApiEpisodeDetails({ data: {} }, id), null);
});

test('hongguo 响应解析统一拒绝HTTP错误、无效JSON、鉴权错误并保留冷却时长', () => {
  assert.deepEqual(parseHongguoResponse({ status: 200, data: '{"code":0,"data":{}}' }), { code: 0, data: {} });
  for (const invalid of [null, {}, { status: 200, data: null }, { status: 200, data: '' }, { status: 200, data: 'null' }, { status: 200, data: 'not-json' }]) {
    assert.throws(() => parseHongguoResponse(invalid), /无效|空响应/);
  }
  assert.throws(() => parseHongguoResponse({ status: 429, data: { code: 0 } }), /HTTP 429/);
  assert.throws(() => parseHongguoResponse({ status: 200, data: { code: 401, message: 'expired' } }), /鉴权失败/);
  assert.throws(() => parseHongguoResponse({ status: 200, data: { code: 500, message: 'unknown' } }), /风控或平台异常/);
  assert.throws(() => parseHongguoResponse({ status: 200, data: { code: 500, message: '{"min_ban_time":3}' } }), error => error.coolDownMs === 3000);
  assert.throws(() => parseHongguoResponse({ status: 200, data: { code: 500, message: '{"max_ban_time":5}' } }), error => error.coolDownMs === 5000);
});

test('hongguo 窗口解析规范化评论，缺失计数保持未知而不误判为空窗口', () => {
  const comment = (id, text, offset) => ({ comment: { comment_id: id, common: { content: { text } }, expand: { offset_time: offset } } });
  const page = parseCommentWindow({ data: { extra: { next_query_danmaku_list_time: 60000 }, common_list_info: {
    has_more: true, cursor: JSON.stringify({ danmaku_count: null, danmaku_window_count: { '0': 9, '30000': 18, '60000': null } }),
  }, data_list: [comment('A', ' 文本 ', 1500.9), comment('B', ' ', 1000), comment('C', '坏时间', 'bad')] } }, 0);
  assert.deepEqual(page.comments, [{ commentId: 'A', offsetMs: 1500, text: '文本', diggCount: 0 }]);
  assert.equal(page.declaredWindowComments, 27);
  assert.equal(page.declaredTotal, null);
  assert.equal(page.declaredWindows['60000'], undefined);
  assert.equal(parseCommentWindow({ data: { extra: { next_query_danmaku_list_time: -1 } } }, 30000).nextStart, 60000);
  const duplicate = { commentId: 'A', offsetMs: 1000, text: '新文本', diggCount: 1 };
  assert.deepEqual(dedupeDanmus([...page.comments, duplicate]), [duplicate]);
});

test('hongguo 身份解析兼容三个后端的包装，非法值拒绝且日志只显示掩码', () => {
  const identity = createHongguoIdentity();
  for (const wrapped of [identity, JSON.stringify(identity), [JSON.stringify(identity)], { result: JSON.stringify(identity) }]) {
    assert.deepEqual(parseHongguoIdentity(wrapped), identity);
  }
  for (const invalid of [null, 'not-json', { ...identity, iid: '0' }, { ...identity, device_id: 'invalid' }, { ...identity, cdid: 'invalid' }]) {
    assert.equal(parseHongguoIdentity(invalid), null);
  }
  assert.match(maskHongguoIdentity(identity), /^iid=\d{3}\*{3}\d{3} device_id=\d{3}\*{3}\d{3}$/);
  assert.equal(maskHongguoIdentity(identity).includes(identity.device_id), false);
});

test('hongguo 分段参数保留编码与零值，缺失和非有限数字返回未知', () => {
  assert.equal(getFragmentNumber('hongguo:v1:a:b:180#%73egment=0&offset=180.5', 'segment'), 0);
  assert.equal(getFragmentNumber('hongguo:v1:a:b:180#segment=30&offset=180.5', 'offset'), 180.5);
  assert.equal(getFragmentNumber('hongguo:v1:a:b:180#offset=10&offset=20', 'offset'), 10);
  assert.equal(getFragmentNumber('hongguo:v1:a:b:180#offset=Infinity', 'offset'), null);
  assert.equal(getFragmentNumber('hongguo:v1:a:b:180#segment=30', 'offset'), null);
});
