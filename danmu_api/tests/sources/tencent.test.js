import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
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
