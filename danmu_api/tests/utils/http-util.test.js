// HTTP 工具：httpPatch 与 GET/POST 行为一致
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import {
  httpPatch, httpPut, httpDelete, jsonResponse, xmlResponse, binResponse, buildQueryString,
  sortedQueryString, updateQueryString, getPathname, toLogSourceName, runWithHttpCache,
  getPageTitle, httpGetWithStreamCheck, sourceLogContext, httpCacheContext,
} from '../../utils/http-util.js';
import { mockJsonResponse, withMockFetch } from '../helpers/context.js';

test('httpPatch 的 allow_redirects 与 GET/POST 行为一致', async () => {
  let seenOptions = null;
  const capture = async (url, options) => { seenOptions = options; return mockJsonResponse({}, url); };

  await withMockFetch(capture, () => httpPatch('http://example.com/a', 'body', { allow_redirects: false }));
  assert.strictEqual(seenOptions.redirect, 'manual', '禁止重定向时使用 manual');

  await withMockFetch(capture, () => httpPatch('http://example.com/b', 'body', {}));
  assert.strictEqual(seenOptions.redirect, 'follow', '默认跟随重定向');
});

// ============================================================================
// http-util 纯 helper 与流式请求：全部离线（出网一律用 mock fetch / 内存 Response）
// ============================================================================

test('http-util buildQueryString 保持插入顺序并对键值编码', () => {
  assert.strictEqual(buildQueryString({ a: 1, b: '中文 值' }), 'a=1&b=%E4%B8%AD%E6%96%87%20%E5%80%BC');
  assert.strictEqual(buildQueryString({ a: 1, b: '中文 值' }, false), 'a=1&b=中文 值', 'encode=false 时原样拼接');
  assert.strictEqual(buildQueryString({ 'k e y': 'v&=x' }), 'k%20e%20y=v%26%3Dx', '键同样编码');
  assert.strictEqual(buildQueryString({ z: 1, a: 2 }), 'z=1&a=2', '不做 key 排序（顺序由调用方决定）');
  assert.strictEqual(buildQueryString({}), '');
});

test('http-util sortedQueryString 键排序并归一化布尔与空值', () => {
  assert.strictEqual(sortedQueryString({ b: 2, a: 1 }), 'a=1&b=2');
  assert.strictEqual(sortedQueryString({ flag: true, off: false }), 'flag=true&off=false', '布尔转字符串');
  assert.strictEqual(sortedQueryString({ a: null, b: undefined, c: 0 }), 'a=&b=&c=0', 'null/undefined 归一为空串');
  assert.strictEqual(sortedQueryString({ 'a key': '中 文' }), 'a%20key=%E4%B8%AD%20%E6%96%87', '键值都编码');
  assert.strictEqual(sortedQueryString(), '');
});

test('http-util updateQueryString 合并参数、覆盖同名键并保留 hash', () => {
  assert.strictEqual(updateQueryString('https://a.com/p?x=1&y=2', { y: 3, z: 4 }), 'https://a.com/p?x=1&y=3&z=4');
  assert.strictEqual(updateQueryString('https://a.com/p', { a: '中 文' }), 'https://a.com/p?a=%E4%B8%AD%20%E6%96%87');
  assert.strictEqual(updateQueryString('https://a.com/p?x=1#frag', { y: 2 }), 'https://a.com/p?x=1&y=2#frag',
    'hash 保留在末尾');
  assert.strictEqual(updateQueryString('https://a.com/p?x=1', {}), 'https://a.com/p?x=1', '未传入参数时保持原查询串');
});

test('http-util getPathname 支持带协议、无协议、无路径与带查询/片段', () => {
  assert.strictEqual(getPathname('https://a.com/b/c?x=1#h'), '/b/c');
  assert.strictEqual(getPathname('https://a.com'), '/', '无路径时返回根路径');
  assert.strictEqual(getPathname('https://a.com/'), '/');
  assert.strictEqual(getPathname('//cdn.a.com/x/y'), '/x/y', '协议相对地址');
  assert.strictEqual(getPathname('/only/path?q=1'), '/only/path');
  assert.strictEqual(getPathname('https://a.com/p#frag'), '/p');
});

test('http-util jsonResponse / xmlResponse / binResponse 的响应头与状态码', async () => {
  const json = jsonResponse({ ok: true, text: '中文' }, 201);
  assert.strictEqual(json.status, 201);
  assert.strictEqual(json.headers.get('content-type'), 'application/json');
  assert.strictEqual(json.headers.get('access-control-allow-origin'), '*');
  assert.deepStrictEqual(await json.json(), { ok: true, text: '中文' });

  const xml = xmlResponse('<?xml version="1.0"?><i><d p="1"/></i>', 200);
  assert.strictEqual(xml.headers.get('content-type'), 'application/xml');
  assert.strictEqual(await xml.text(), '<?xml version="1.0"?><i><d p="1"/></i>');
  assert.throws(() => xmlResponse('<i/>'), /Expected data to be an XML string/, '非 XML 前缀直接报错');
  assert.throws(() => xmlResponse(123), /Expected data to be an XML string/, '非字符串直接报错');

  const bin = binResponse(new Uint8Array([1, 2, 3]));
  assert.strictEqual(bin.headers.get('content-type'), 'application/octet-stream');
  assert.strictEqual(bin.headers.get('content-disposition'), 'attachment; filename="data.bin"', '默认文件名');
  const named = binResponse(new Uint8Array([0]), 'danmu.xml', 206);
  assert.strictEqual(named.status, 206);
  assert.strictEqual(named.headers.get('content-disposition'), 'attachment; filename="danmu.xml"');
});

test('http-util toLogSourceName 映射调度键到日志名', () => {
  assert.strictEqual(toLogSourceName('360'), '360kan');
  assert.strictEqual(toLogSourceName('imgo'), 'mango');
  assert.strictEqual(toLogSourceName('bilibili'), 'bilibili', '无映射时原样返回');
  assert.strictEqual(toLogSourceName(''), '');
});

test('http-util runWithHttpCache / sourceLogContext 提供请求级隔离的上下文', async () => {
  const seen = [];
  await Promise.all([
    runWithHttpCache(async () => {
      const store = httpCacheContext.getStore();
      store.set('k', 'first');
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(['first', store.get('k'), store.size]);
    }),
    runWithHttpCache(async () => {
      const store = httpCacheContext.getStore();
      seen.push(['second', store.get('k'), store.size]);
      store.set('k', 'second');
    }),
  ]);
  const byName = Object.fromEntries(seen.map(([name, value, size]) => [name, [value, size]]));
  assert.deepStrictEqual(byName.first, ['first', 1], '并发请求各持一个缓存 Map，互不串味');
  assert.deepStrictEqual(byName.second, [undefined, 0], '第二个请求看不到第一个请求写入的键');

  const returned = await runWithHttpCache(() => 'result');
  assert.strictEqual(returned, 'result', '透传回调返回值');

  assert.strictEqual(sourceLogContext.getStore(), undefined, '未进入上下文时无 store');
  await sourceLogContext.run('bili', async () => {
    assert.strictEqual(sourceLogContext.getStore(), 'bili');
  });
});

test('http-util getPageTitle 解析标题实体，异常时回退 URL', async () => {
  const html = '<html><head><title> 无职转生 &amp; 到了异世界 &quot;S2&quot; </title></head></html>';
  const ok = await withMockFetch(
    async (url) => new Response(html, { status: 200 }),
    () => getPageTitle('https://v.qq.com/x/cover/a.html'),
  );
  assert.strictEqual(ok, '无职转生 & 到了异世界 "S2"', '去除首尾空白并解码常用实体');

  const noTitle = await withMockFetch(
    async () => new Response('<html><body>no title</body></html>', { status: 200 }),
    () => getPageTitle('https://v.qq.com/x/cover/b.html'),
  );
  assert.strictEqual(noTitle, 'https://v.qq.com/x/cover/b.html', '无 title 时回退原始 URL');

  const failed = await withMockFetch(
    async () => { throw new Error('mock network down'); },
    () => getPageTitle('https://v.qq.com/x/cover/c.html'),
  );
  assert.strictEqual(failed, 'https://v.qq.com/x/cover/c.html', '请求失败时同样回退 URL');
});

test('http-util httpPut / httpDelete 的方法与 body 传递', async () => {
  const calls = [];
  const capture = async (url, options) => { calls.push({ url, method: options.method, body: options.body }); return mockJsonResponse({}, url); };

  await withMockFetch(capture, () => httpPut('http://example.com/p', 'payload'));
  await withMockFetch(capture, () => httpDelete('http://example.com/d'));
  assert.deepStrictEqual(calls.map((call) => call.method), ['PUT', 'DELETE']);
  assert.strictEqual(calls[0].body, 'payload', 'PUT 需要传 body');
  assert.strictEqual(calls[1].body, undefined, 'DELETE 不传 body');
});

test('http-util httpGetWithStreamCheck 流式读取、嗅探回调与错误处理', async () => {
  const jsonBody = { list: [1, 2, 3] };
  const parsed = await withMockFetch(
    async () => new Response(JSON.stringify(jsonBody), { status: 200 }),
    () => httpGetWithStreamCheck('http://example.com/j'),
  );
  assert.deepStrictEqual(parsed, jsonBody, 'JSON 响应解析为对象');

  const text = await withMockFetch(
    async () => new Response('plain body', { status: 200 }),
    () => httpGetWithStreamCheck('http://example.com/t'),
  );
  assert.strictEqual(text, 'plain body', '非 JSON 响应返回文本');

  let sniffed = null;
  const rejected = await withMockFetch(
    async () => new Response('<!DOCTYPE html><html>验证页</html>', { status: 200 }),
    () => httpGetWithStreamCheck('http://example.com/h', {}, (prefix) => { sniffed = prefix; return false; }),
  );
  assert.strictEqual(rejected, null, '嗅探回调否定时丢弃结果');
  assert.match(sniffed, /^<!DOCTYPE html>/, '回调拿到响应前缀用于判定');

  const serverError = await withMockFetch(
    async () => new Response('nope', { status: 500 }),
    () => httpGetWithStreamCheck('http://example.com/e'),
  );
  assert.strictEqual(serverError, null, '非 2xx 由内部捕获并返回 null（调用方以 null 表示本次无数据）');
});
