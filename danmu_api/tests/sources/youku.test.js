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
