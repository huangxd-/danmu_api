// 接口详情入口：各部署平台的请求处理都建立追踪，且请求记录可关联到详情

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleRequestWithTrace } from '../../worker.js';
import { Globals, globals } from '../../configs/globals.js';
import { getInterfaceDetail, getTraceRecords } from '../../utils/pipeline-trace.js';
import { withMockFetch } from '../helpers/context.js';

test('worker 各部署入口统一调用 handleRequestWithTrace', () => {
  const worker = fs.readFileSync(new URL('../../worker.js', import.meta.url), 'utf8');
  assert.equal((worker.match(/handleRequestWithTrace\(/g) || []).length, 4,
    '包装函数定义与三个 worker 入口应各出现一次');

  const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  assert.match(server, /import \{ handleRequestWithTrace \} from '\.\/worker\.js'/);
  assert.match(server, /await handleRequestWithTrace\(/);
  assert.doesNotMatch(server, /await handleRequest\(/);

  const edgeOne = fs.readFileSync(new URL('../../../node-functions/index.js', import.meta.url), 'utf8');
  assert.match(edgeOne, /import \{ handleRequestWithTrace \} from '\.\.\/danmu_api\/worker\.js'/);
  assert.match(edgeOne, /await handleRequestWithTrace\(/);
  assert.doesNotMatch(edgeOne, /await handleRequest\(/);

  // Netlify 入口导出 worker.js 的 netlifyHandler，追踪在该 handler 内建立
  const netlify = fs.readFileSync(new URL('../../../netlify/functions/api.js', import.meta.url), 'utf8');
  assert.match(netlify, /export const handler = netlifyHandler/);
});

test('handleRequestWithTrace 记录不含凭据的路径并关联请求记录', async () => {
  const env = { TOKEN: 'secret-tok' };
  const request = new Request('http://localhost/secret-tok/api/v2/search/anime?keyword=%E5%89%A7%E5%90%8D', {
    method: 'GET',
  });

  const response = await withMockFetch(
    async () => new Response(JSON.stringify({ animes: [] }), { status: 200 }),
    () => handleRequestWithTrace(request, env, 'cloudflare', '9.9.9.9'),
  );
  assert.ok(response instanceof Response);

  const records = globals.reqRecords;
  assert.ok(records.length > 0, '业务接口应写入请求记录');
  const record = records[records.length - 1];
  assert.ok(record.requestId, '请求记录应带 requestId');
  const detail = getInterfaceDetail(record.requestId);
  assert.ok(detail, 'requestId 应能查到追踪记录');
  assert.equal(detail.method, 'GET');
  assert.equal(detail.clientIp, '9.9.9.9');
  assert.equal(detail.path, '/api/v2/search/anime');
  assert.equal(detail.path.includes('secret-tok'), false, '路径不得包含凭据');
  assert.equal(detail.query, '?keyword=%E5%89%A7%E5%90%8D', '查询串应保留以便还原完整请求');
  assert.equal(detail.totalMs >= 0, true);
  assert.equal(detail.handlerMs, detail.totalMs - detail.prepareMs);
  assert.equal(detail.statusCode, 200, '追踪记录应保留响应状态码');
});

test('handleRequestWithTrace 只留存写入请求记录的请求', async () => {
  const before = getTraceRecords().length;
  const detailRequest = new Request('http://localhost/secret-tok/api/interface-detail/not-exist', { method: 'GET' });
  const response = await handleRequestWithTrace(detailRequest, { TOKEN: 'secret-tok' }, 'cloudflare', '9.9.9.9');
  assert.equal(response.status, 404);
  assert.equal(getTraceRecords().length, before, '详情查询自身不产生请求记录，不应留存追踪');

  const businessRequest = new Request('http://localhost/secret-tok/api/v2/search/episodes?anime=x', { method: 'GET' });
  await handleRequestWithTrace(businessRequest, { TOKEN: 'secret-tok' }, 'cloudflare', '9.9.9.9');
  assert.equal(getTraceRecords().length, before + 1, '业务接口应留存追踪');
});

test('handleRequestWithTrace 只对查询串中的凭据参数做掩码', async () => {
  const request = new Request('http://localhost/api/v2/search/anime?keyword=x&token=secret&api_key=k&season=2', { method: 'GET' });
  const response = await withMockFetch(
    async () => new Response(JSON.stringify({ animes: [] }), { status: 200 }),
    () => handleRequestWithTrace(request, { TOKEN: '87654321' }, 'cloudflare', '9.9.9.9'),
  );
  assert.equal(response.status, 200);
  const record = globals.reqRecords[globals.reqRecords.length - 1];
  const detail = getInterfaceDetail(record.requestId);
  assert.ok(detail.query.includes('keyword=x'), 'keyword 不应被当作凭据参数');
  assert.ok(detail.query.includes('season=2'), '普通参数应保留');
  assert.equal(detail.query.includes('secret'), false, 'token 取值不得出现');
  assert.ok(detail.query.includes('token=***'), '凭据参数替换为掩码');
  assert.ok(detail.query.includes('api_key=***'), '含 key 的参数替换为掩码');
});
