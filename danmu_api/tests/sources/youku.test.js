// 优酷源：cna 兜底
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import { SegmentListResponse } from '../../models/dandan-model.js';
import YoukuSource from '../../sources/youku.js';
import { handleRequest } from '../../worker.js';
import { MockRequest, parseResponse, token, urlPrefix, withMockFetch } from '../helpers/context.js';

test('youku 分集标题使用平台集号，跳过集数时与数组索引不同', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const source = new YoukuSource();
  // 平台跳过第 17 集：第 17 项的 seq 为 18
  const raw = [
    { id: 'A', title: '养小蝌蚪记', seq: '16', stage: '16' },
    { id: 'B', title: '避难训练记', seq: '18', stage: '18' },
    { id: 'C', title: '拣狗记', seq: '19', stage: '19' },
  ];
  const formatted = source._processAndFormatEpisodes(raw, 'anime');
  assert.equal(formatted[0].title, '第16集 养小蝌蚪记');
  assert.equal(formatted[1].title, '第18集 避难训练记', '跳集后应使用平台集号而非数组序号');
  assert.equal(formatted[1].episodeIndex, 2, '数组索引保持原义供排序使用');
  assert.equal(formatted[1].displayNumber, 18);
});

test('youku 分集标题在平台集号缺失或为 0 时回退数组序号', () => {
  const source = new YoukuSource();
  const formatted = source._processAndFormatEpisodes([
    { id: 'A', title: '第一集内容', seq: '0', stage: '0' },
    { id: 'B', title: '第二集内容', seq: undefined, stage: undefined },
    { id: 'C', title: '第三集内容', seq: '5', stage: '5' },
  ], 'anime');
  assert.strictEqual(formatted[0].displayNumber, null, 'seq 为 0 视为未提供平台集号');
  assert.strictEqual(formatted[1].displayNumber, null, 'seq 缺失视为未提供平台集号');
  assert.strictEqual(formatted[2].displayNumber, 5, '有效 seq 作为平台集号');
  assert.match(formatted[0].title, /^第1集/, '平台集号缺失时回退数组序号');
  assert.match(formatted[1].title, /^第2集/, 'seq 缺失时回退数组序号');
  assert.match(formatted[2].title, /^第5集/, '平台集号有效时优先使用');
});

test('youku source falls back to a locally generated cna', async (t) => {
  const youkuUrl = 'https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html';

  // 生产路径由 handleRequest/server 初始化 globals（danmuLimit 等），源单测需自行初始化
  Globals.init({});

  // httpGet/httpPost 依赖真实 Response 形状：ok/status/headers.entries()/text()
  const mockResponse = (data, headers) => ({
    ok: true,
    status: 200,
    url: '',
    headers: new Headers(headers),
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data))
  });

  const mockDanmakuResponse = () => mockResponse({
    data: {
      result: JSON.stringify({
        code: '0',
        data: {
          result: [
            { playat: 1000, content: '测试弹幕', propertis: '{"color":"16711680","pos":1}', extFields: { voteUp: 3 } }
          ]
        }
      })
    }
  }, { 'content-type': 'application/json' });

  const buildYoukuFetch = ({ mmstatFails = false, mmstatMissingEtag = false, tokenFails = false } = {}) => {
    const calls = { mmstat: 0, token: 0, danmaku: 0 };
    const fetchImpl = async (url) => {
      const target = String(url);
      if (target.includes('log.mmstat.com')) {
        calls.mmstat++;
        if (mmstatFails) throw new Error('simulated mmstat block');
        if (mmstatMissingEtag) return mockResponse('', {});
        return mockResponse('', { etag: '"maQrIwQESUACASdE0z2p2AgV"' });
      }
      if (target.includes('mtop.com.youku.aplatform.weakget')) {
        calls.token++;
        if (tokenFails) throw new Error('simulated token block');
        return mockResponse({}, { 'set-cookie': '_m_h5_tk=token123_456;Path=/;_m_h5_tk_enc=enc123;Path=/' });
      }
      if (target.includes('openapi.youku.com/v2/videos/show.json')) {
        return mockResponse({ title: '测试剧集', duration: 120 }, { 'content-type': 'application/json' });
      }
      if (target.includes('mopen.youku.danmu.list')) {
        calls.danmaku++;
        return mockDanmakuResponse();
      }
      throw new Error(`unexpected fetch: ${target}`);
    };
    return { fetchImpl, calls };
  };

  await t.test('mmstat 被拦截时改用本地 cna 继续取弹幕，且后续不再请求该域名', async () => {
    const source = new YoukuSource();
    const { fetchImpl, calls } = buildYoukuFetch({ mmstatFails: true });

    const first = await withMockFetch(fetchImpl, () => source.getComments(youkuUrl, 'youku', false));
    assert.ok(first.length > 0, 'mmstat 失败后仍应取到弹幕');
    assert.equal(calls.mmstat, 1);

    const second = await withMockFetch(fetchImpl, () => source.getComments(youkuUrl, 'youku', false));
    assert.ok(second.length > 0);
    assert.equal(calls.mmstat, 1, '已切换兜底 cna 时不应重复请求 mmstat');
  });

  await t.test('mmstat 响应缺少 etag 时同样走本地 cna 兜底', async () => {
    const source = new YoukuSource();
    const { fetchImpl, calls } = buildYoukuFetch({ mmstatMissingEtag: true });

    const comments = await withMockFetch(fetchImpl, () => source.getComments(youkuUrl, 'youku', false));
    assert.ok(comments.length > 0);
    assert.equal(calls.mmstat, 1);
  });

  await t.test('mtop token 获取失败时返回空结果而不是抛错', async () => {
    const source = new YoukuSource();
    const { fetchImpl } = buildYoukuFetch({ mmstatFails: true, tokenFails: true });

    const segments = await withMockFetch(fetchImpl, () => source.getComments(youkuUrl, 'youku', true));
    assert.ok(segments instanceof SegmentListResponse);
    assert.deepEqual(segments.segmentList, []);

    const comments = await withMockFetch(fetchImpl, () => source.getComments(youkuUrl, 'youku', false));
    assert.deepEqual(comments, []);
  });

  await t.test('无法解析的链接返回空分片列表而不是抛错', async () => {
    const segments = await new YoukuSource().getEpisodeDanmuSegments('not-a-youku-url');
    assert.ok(segments instanceof SegmentListResponse);
    assert.deepEqual(segments.segmentList, []);
  });

  await t.test('mmstat 被拦截时 /api/v2/comment 返回 200 而不是 500', async () => {
    const { fetchImpl } = buildYoukuFetch({ mmstatFails: true });
    const req = new MockRequest(
      `${urlPrefix}/api/v2/comment?url=${encodeURIComponent(youkuUrl)}&format=json`,
      { method: 'GET' }
    );
    const res = await withMockFetch(fetchImpl, () => handleRequest(req));
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(body.count > 0);
  });
});
