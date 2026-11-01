import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals, globals } from '../../configs/globals.js';
import TencentSource from '../../sources/tencent.js';
import { withMockFetch } from '../helpers/context.js';

const VID = 'c4102g9a01t';
const PLAYER_URL = `https://v.qq.com/x/cover/mzc00200803dr6b/${VID}.html`;
const BASE_URL = `https://dm.video.qq.com/barrage/base/${VID}`;
const SEGMENT_URL = `https://dm.video.qq.com/barrage/segment/${VID}/t/v1/0/30000`;

Globals.init({});

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

// 并发与失败统计：用可控的 mock fetch 记录在飞请求数，验证分批逻辑
async function runConcurrencyTest({ batchSize, concurrency, failIndex = -1, badShapeIndex = -1 }) {
  Globals.init({ TENCENT_CONCURRENCY: String(concurrency) });
  const source = new TencentSource();
  let maxInFlight = 0;
  let inFlight = 0;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === PLAYER_URL) {
      return mockResponse('<html><title>测试剧集</title></html>');
    }
    if (url === BASE_URL) {
      const segmentIndex = {};
      for (let i = 0; i < batchSize; i++) {
        segmentIndex[String(i * 30000)] = { segment_start: String(i * 30000), segment_name: `t/v1/${i * 30000}/30000` };
      }
      return mockResponse({ segment_index: segmentIndex });
    }
    const segmentMatch = url.match(/barrage\/segment\/[^/]+\/t\/v1\/(\d+)\/30000$/);
    if (segmentMatch) {
      const index = Number(segmentMatch[1]) / 30000;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (index === failIndex) {
          throw new Error('HTTP error! status: 500');
        }
        if (index === badShapeIndex) {
          return mockResponse({});
        }
        return mockResponse({ barrage_list: [{ content: `第${index}段` }] });
      } finally {
        await new Promise((resolve) => {
          setTimeout(resolve, batchSize > 3 && index < 2 ? 5 : 1);
        });
        inFlight--;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const comments = await withMockFetch(fetchImpl, () => source.getEpisodeDanmu(PLAYER_URL));
  Globals.init({});
  return { comments, maxInFlight };
}

test('tencent 整集弹幕按 TENCENT_CONCURRENCY 分批且保留分片顺序', async () => {
  const { comments, maxInFlight } = await runConcurrencyTest({ batchSize: 12, concurrency: 3 });
  assert.equal(maxInFlight <= 3, true, `峰值并发 ${maxInFlight} 应不超过 3`);
  assert.equal(comments.length, 12);
  for (let i = 0; i < 12; i++) {
    assert.equal(comments[i].content, `第${i}段`);
  }
});

test('tencent 单个分片失败不影响其余分片并输出统计', async () => {
  globals.logBuffer.length = 0;
  const { comments, maxInFlight } = await runConcurrencyTest({ batchSize: 6, concurrency: 3, failIndex: 2 });
  assert.equal(maxInFlight <= 3, true);
  assert.equal(comments.length, 5);
  const summary = globals.logBuffer.find((entry) => entry.message.includes('分段下载完成: 5/6'));
  const failure = globals.logBuffer.find((entry) => entry.message.includes('第 3 个分片请求失败'));
  assert.ok(summary, '应输出分段完成统计');
  assert.ok(failure, '应输出失败分片信息');
});

test('tencent 某段返回空对象不再导致整集返回空数组', async () => {
  const { comments, maxInFlight } = await runConcurrencyTest({ batchSize: 4, concurrency: 2, badShapeIndex: 1 });
  assert.equal(maxInFlight <= 2, true);
  assert.equal(comments.length, 3);
  assert.equal(comments.every((item) => item.content !== undefined), true);
});

test('tencent 相关分区识别与条目筛选', () => {
  const source = new TencentSource();
  assert.equal(source.isRelatedBoxTitle('与 <em>一念永恒</em> 完结季 相关', '一念永恒'), true);
  assert.equal(source.isRelatedBoxTitle('相关影视', '兰香如故'), true);
  assert.equal(source.isRelatedBoxTitle('斗罗大陆', '斗罗大陆'), true);
  assert.equal(source.isRelatedBoxTitle('相关短视频', '毛雪汪'), false);
  assert.equal(source.isRelatedBoxTitle('IP话题搜索', '毛雪汪'), false);
  assert.equal(source.isRelatedBoxTitle('', '毛雪汪'), false);
  // 关键词为空时仅识别「相关影视」与「与 X 相关」，同名分支不生效
  assert.equal(source.isRelatedBoxTitle('斗罗大陆', ''), false);

  const box = {
    itemList: [
      { doc: { id: 'a' }, videoInfo: { title: '<em>一念永恒</em> 第1季' } },
      { doc: { id: 'b' }, videoInfo: { title: '无关内容' } },
      { doc: { id: 'c' } },
    ],
  };
  assert.deepEqual(source.filterRelatedItems(box, '一念永恒').map(item => item.doc.id), ['a']);
});

test('tencent 搜索从相关分区补充作品并去重', async () => {
  Globals.init({});
  globals.logBuffer.length = 0;
  const source = new TencentSource();
  const item = (id, title, year = '2024', typeName = '动漫') => ({
    doc: { id },
    videoInfo: { title, year, typeName, coverDoc: { richTags: [], tags: [] } },
  });
  const payload = {
    ret: 0,
    data: {
      normalList: { itemList: [item('cid-main', '一念永恒 完结季', '2026')] },
      areaBoxList: [
        {
          boxTitle: { boxTitles: ['与 <em>一念永恒</em> 完结季 相关'] },
          itemList: [
            item('cid-s1', '一念永恒 第1季', '2020'),
            item('cid-s2', '一念永恒 第2季', '2022'),
            item('cid-main', '一念永恒 完结季', '2026'),
            item('cid-other', '无关电影', '2020', '电影'),
          ],
        },
        { boxTitle: { boxTitles: ['相关短视频'] }, itemList: [item('cid-short', '一念永恒片段', '0')] },
        { boxTitle: { boxTitles: ['相关影视'] }, itemList: [item('cid-other2', '其它剧', '2023', '电视剧')] },
        { boxTitle: { boxTitles: ['与 一念永恒 相关'] }, itemList: [item('cid-main', '一念永恒 完结季', '2026')] },
      ],
    },
  };

  let titles = [];
  await withMockFetch(async () => mockResponse(payload), async () => {
    const list = await source.search('一念永恒');
    titles = list.map(entry => entry.title);
  });

  assert.deepEqual(titles, ['一念永恒 完结季', '一念永恒 第1季', '一念永恒 第2季']);
  const messages = globals.logBuffer.map(entry => entry.message);
  assert.ok(messages.some(message => message.includes('追加「与 一念永恒 完结季 相关」分区中匹配 "一念永恒" 的 2 个项目')));
  assert.ok(!messages.some(message => message.includes('相关短视频')), '相关短视频分区不参与补充');
  assert.ok(messages.some(message => message.includes('「相关影视」分区中无匹配 "一念永恒" 的项目')));
  assert.ok(messages.some(message => message.includes('「与 一念永恒 相关」分区中匹配 "一念永恒" 的项目均已存在于搜索结果')));
});
test('tencent 相关分区条目筛选的边缘情况', () => {
  const source = new TencentSource();

  // 空列表或缺失 itemList 时返回空
  assert.deepEqual(source.filterRelatedItems({ itemList: [] }, '一念永恒'), []);
  assert.deepEqual(source.filterRelatedItems({}, '一念永恒'), []);

  // 关键词为空时不匹配任何条目
  const emptyKeywordBox = { itemList: [{ doc: { id: 'a' }, videoInfo: { title: '<em>一念永恒</em> 第1季' } }] };
  assert.deepEqual(source.filterRelatedItems(emptyKeywordBox, ''), []);

  // 缺失 videoInfo 或 title 的条目被排除，仅保留标题包含关键词的条目
  const partialBox = {
    itemList: [
      { doc: { id: 'a' }, videoInfo: { title: '一念永恒 第1季' } },
      { doc: { id: 'b' } },
      { doc: { id: 'c' }, videoInfo: {} },
    ],
  };
  assert.deepEqual(source.filterRelatedItems(partialBox, '一念永恒').map(item => item.doc.id), ['a']);
});

test('tencent 搜索在相关分区缺失或非数组时仅返回主列表', async () => {
  Globals.init({});
  const source = new TencentSource();
  const item = (id, title) => ({
    doc: { id },
    videoInfo: { title, year: '2026', typeName: '动漫', coverDoc: { richTags: [], tags: [] } },
  });
  const makePayload = (areaBoxList) => ({
    ret: 0,
    data: { normalList: { itemList: [item('cid-1', '一念永恒 完结季')] }, areaBoxList },
  });

  for (const areaBoxList of [undefined, null, []]) {
    globals.logBuffer.length = 0;
    let titles = [];
    await withMockFetch(async () => mockResponse(makePayload(areaBoxList)), async () => {
      const list = await source.search('一念永恒');
      titles = list.map(entry => entry.title);
    });
    assert.deepEqual(titles, ['一念永恒 完结季']);
    assert.ok(!globals.logBuffer.some(entry => entry.message.includes('追加')), '相关分区缺失时不输出追加日志');
  }
});

test('tencent 搜索补充与关键词同名的分区', async () => {
  Globals.init({});
  globals.logBuffer.length = 0;
  const source = new TencentSource();
  const item = (id, title) => ({
    doc: { id },
    videoInfo: { title, year: '2024', typeName: '动漫', coverDoc: { richTags: [], tags: [] } },
  });
  const payload = {
    ret: 0,
    data: {
      normalList: { itemList: [item('cid-main', '一念永恒 完结季', '2026')] },
      areaBoxList: [
        {
          boxTitle: { boxTitles: ['一念永恒'] },
          itemList: [
            item('cid-s1', '一念永恒 第1季', '2020'),
            item('cid-s2', '一念永恒 第2季', '2022'),
          ],
        },
      ],
    },
  };

  let titles = [];
  await withMockFetch(async () => mockResponse(payload), async () => {
    const list = await source.search('一念永恒');
    titles = list.map(entry => entry.title);
  });

  assert.deepEqual(titles, ['一念永恒 完结季', '一念永恒 第1季', '一念永恒 第2季']);
  assert.ok(globals.logBuffer.some(entry => entry.message.includes('追加「一念永恒」分区中匹配 "一念永恒" 的 2 个项目')));
});
test('tencent 搜索跳过非相关分区（相关短视频/IP话题搜索/衍生节目）', async () => {
  Globals.init({});
  globals.logBuffer.length = 0;
  const source = new TencentSource();
  const item = (id, title) => ({
    doc: { id },
    videoInfo: { title, year: '2024', typeName: '动漫', coverDoc: { richTags: [], tags: [] } },
  });
  const payload = {
    ret: 0,
    data: {
      normalList: { itemList: [item('cid-main', '一念永恒 完结季', '2026')] },
      areaBoxList: [
        { boxTitle: { boxTitles: ['相关短视频'] }, itemList: [item('cid-short', '一念永恒片段')] },
        { boxTitle: { boxTitles: ['IP话题搜索'] }, itemList: [item('cid-ip', '一念永恒相关讨论')] },
        { boxTitle: { boxTitles: ['衍生节目'] }, itemList: [item('cid-deriv', '一念永恒衍生综艺')] },
        { boxTitle: { boxTitles: ['相关影视'] }, itemList: [item('cid-s1', '一念永恒 第1季', '2020')] },
      ],
    },
  };

  let titles = [];
  await withMockFetch(async () => mockResponse(payload), async () => {
    const list = await source.search('一念永恒');
    titles = list.map(entry => entry.title);
  });

  assert.deepEqual(titles, ['一念永恒 完结季', '一念永恒 第1季']);
  const messages = globals.logBuffer.map(entry => entry.message);
  assert.ok(!messages.some(message => message.includes('相关短视频') || message.includes('IP话题搜索') || message.includes('衍生节目')), '非相关分区不参与补充');
  assert.ok(messages.some(message => message.includes('追加「相关影视」分区中匹配 "一念永恒" 的 1 个项目')));
});

test('tencent 搜索在 boxTitles 含非相关标题时仍按匹配标题识别', async () => {
  Globals.init({});
  globals.logBuffer.length = 0;
  const source = new TencentSource();
  const item = (id, title) => ({
    doc: { id },
    videoInfo: { title, year: '2024', typeName: '动漫', coverDoc: { richTags: [], tags: [] } },
  });
  // 同一 box 的 boxTitles 同时含非相关标题与相关影视，find 应逐条判定并命中相关影视
  const payload = {
    ret: 0,
    data: {
      normalList: { itemList: [item('cid-main', '一念永恒 完结季', '2026')] },
      areaBoxList: [
        {
          boxTitle: { boxTitles: ['IP话题搜索', '相关影视'] },
          itemList: [item('cid-s1', '一念永恒 第1季', '2020')],
        },
      ],
    },
  };

  let titles = [];
  await withMockFetch(async () => mockResponse(payload), async () => {
    const list = await source.search('一念永恒');
    titles = list.map(entry => entry.title);
  });

  assert.deepEqual(titles, ['一念永恒 完结季', '一念永恒 第1季']);
  assert.ok(globals.logBuffer.some(entry => entry.message.includes('追加「相关影视」分区中匹配 "一念永恒" 的 1 个项目')));
});
