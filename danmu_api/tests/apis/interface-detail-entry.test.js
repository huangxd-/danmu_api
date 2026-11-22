// 接口详情入口：各部署平台的请求处理都建立追踪，且请求记录可关联到详情

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleRequestWithTrace } from '../../worker.js';
import { Globals, globals } from '../../configs/globals.js';
import { getInterfaceDetail, getTraceRecords, replaceTraceRecords } from '../../utils/pipeline-trace.js';
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

test('恢复历史 trace 后新请求不会复用旧 id 的详情', async () => {
  const previousTraces = getTraceRecords();
  const previousRecords = globals.reqRecords;
  replaceTraceRecords([{ id: '1', path: '/restored' }]);
  globals.reqRecords = [{ requestId: '1', interface: '/restored' }];
  try {
    const response = await handleRequestWithTrace(
      new Request('http://localhost/api/v2/comment/999'),
      { TOKEN: '87654321' },
      'vercel',
      '9.9.9.9',
    );
    assert.equal(response.status, 404);
    const record = globals.reqRecords.at(-1);
    assert.notEqual(record.requestId, '1');
    assert.equal(getInterfaceDetail('1').path, '/restored');
    assert.equal(getInterfaceDetail(record.requestId).path, '/api/v2/comment/999');
  } finally {
    replaceTraceRecords(previousTraces);
    globals.reqRecords = previousRecords;
  }
});

test('恢复的 requestId 不会让页面请求被错误留存', async () => {
  const previousRecords = globals.reqRecords;
  globals.reqRecords = [{ requestId: 'restored-request', interface: '/restored' }];
  try {
    const before = getTraceRecords().length;
    const response = await handleRequestWithTrace(
      new Request('http://localhost/'),
      { TOKEN: '87654321' },
      'vercel',
      '9.9.9.9',
    );
    assert.equal(response.status, 200);
    assert.equal(getTraceRecords().length, before, '页面请求不产生请求记录，也不应留存详情');
    assert.deepEqual(globals.reqRecords, [{ requestId: 'restored-request', interface: '/restored' }]);
  } finally {
    globals.reqRecords = previousRecords;
  }
});

test('handleRequestWithTrace 向边缘上下文注册同批持久化任务', async () => {
  const tasks = [];
  const request = new Request('http://localhost/api/v2/comment/999', { method: 'GET' });
  const response = await handleRequestWithTrace(
    request,
    { TOKEN: '87654321' },
    'cloudflare',
    '9.9.9.9',
    { waitUntil: task => tasks.push(task) },
  );

  assert.equal(response.status, 404);
  assert.equal(tasks.length, 1, '业务请求应注册持久化任务');
  assert.equal(typeof tasks[0]?.then, 'function');
  await tasks[0];
});

test('handleRequestWithTrace 异常时仍向边缘上下文注册持久化任务', async () => {
  const failure = new Error('cache read failed');
  const previousEpisodes = globals.episodeIds;
  globals.episodeIds = [Object.defineProperty({}, 'id', { get() { throw failure; } })];
  const tasks = [];
  try {
    await assert.rejects(
      handleRequestWithTrace(
        new Request('http://localhost/api/v2/comment/999'),
        { TOKEN: '87654321' },
        'cloudflare',
        '9.9.9.9',
        { waitUntil: task => tasks.push(task) },
      ),
      error => error === failure,
    );
  } finally {
    globals.episodeIds = previousEpisodes;
  }

  assert.equal(tasks.length, 1, '异常请求也应注册持久化任务');
  await tasks[0];
});

test('handleRequestWithTrace 无 waitUntil 时异常前完成持久化', async () => {
  const failure = new Error('cache read failed');
  const previousEpisodes = globals.episodeIds;
  const previousLocalCacheValid = globals.localCacheValid;
  const previousWritable = globals.queryCacheWritable;
  globals.episodeIds = [Object.defineProperty({}, 'id', { get() { throw failure; } })];
  globals.localCacheValid = true;
  globals.queryCacheWritable = { file: false };
  try {
    await assert.rejects(
      handleRequestWithTrace(
        new Request('http://localhost/api/v2/comment/999'),
        { TOKEN: '87654321' },
        'vercel',
        '9.9.9.9',
      ),
      error => error === failure,
    );
    const record = globals.reqRecords.at(-1);
    assert.ok(record?.requestId, '异常请求应留下请求记录');
    assert.ok(getInterfaceDetail(record.requestId), '持久化流程应可读取该异常详情');
  } finally {
    globals.episodeIds = previousEpisodes;
    globals.localCacheValid = previousLocalCacheValid;
    globals.queryCacheWritable = previousWritable;
  }
});

test('handleRequestWithTrace 只对查询串中的凭据参数做掩码', async () => {
  const nestedUrl = encodeURIComponent('https://nested.example/v?token=inner-secret&episode=4');
  const request = new Request(
    `http://localhost/api/v2/search/anime?keyword=x&token=secret&api_key=k&sign=sig&season=2&url=${nestedUrl}`,
    { method: 'GET' },
  );
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
  assert.ok(detail.query.includes('sign=***'), '签名参数替换为掩码');
  const decodedQuery = decodeURIComponent(detail.query);
  assert.ok(decodedQuery.includes('episode=4'), '嵌套 URL 的非凭据参数应保留');
  assert.equal(decodedQuery.includes('inner-secret'), false, '嵌套 URL 中的令牌不得出现');
});
