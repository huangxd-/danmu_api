// 转发链路追踪接口：handleForwardTrace 报文限长 / JSON 解析 / handler 校验 / 日志落 buffer 与截断
// 全部离线：req 用桩对象替代，只读写 globals.logBuffer，console 各档位在用例内被 mock 静音。

import test from 'node:test';
import assert from 'node:assert';
import { handleForwardTrace, FORWARD_TRACE_LIMITS } from '../../apis/forward-trace-api.js';
import { globals } from '../../configs/globals.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 桩 request：记录 text() 被调用次数，便于断言「限长检查在读取后立刻短路」
function makeRequest(body) {
  const req = {
    textCalls: 0,
    async text() {
      req.textCalls += 1;
      return body;
    },
  };
  return req;
}

function makeJsonRequest(value) {
  return makeRequest(JSON.stringify(value));
}

// 静音并捕获 console 的 info/warn/error（t.mock 在用例结束后自动还原）
function captureConsole(t) {
  const captured = { info: [], warn: [], error: [] };
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => { captured[level].push(args); });
  }
  return captured;
}

function resetLogBuffer() {
  globals.logBuffer.length = 0;
}

// 构造字节长度精确可控的请求体（padChar 为 ASCII 时字符数等于字节数）
function bodyWithExactByteLength(totalBytes, padChar = 'x') {
  const prefix = '{"handler":"h","eventType":"handlerStart","pad":"';
  const suffix = '"}';
  const padLength = totalBytes - prefix.length - suffix.length;
  if (padLength < 0) throw new Error(`目标长度 ${totalBytes} 容不下 JSON 骨架`);
  return prefix + padChar.repeat(padLength) + suffix;
}

// 构造「含 chineseCount 个汉字、其余用 ASCII 补齐」的请求体：字节数 = 64KB + adjustBytes
function multibyteBody(chineseCount, adjustBytes = 0) {
  const prefix = '{"handler":"h","eventType":"handlerStart","pad":"';
  const suffix = '"}';
  const asciiLength = FORWARD_TRACE_LIMITS.maxPayloadBytes + adjustBytes
    - prefix.length - suffix.length - chineseCount * 3;
  if (asciiLength < 0) throw new Error(`ASCII 补齐段长度为负（${asciiLength}）`);
  return prefix + 'x'.repeat(asciiLength) + '中'.repeat(chineseCount) + suffix;
}

test('handleForwardTrace 64KB 边界：等于上限放行、超 1 字节即 413（按字节而非字符计数）', async (t) => {
  captureConsole(t);
  resetLogBuffer();
  const boundary = FORWARD_TRACE_LIMITS.maxPayloadBytes;
  assert.strictEqual(boundary, 64 * 1024, 'FORWARD_TRACE_LIMITS.maxPayloadBytes 应为 64KB');
  assert.strictEqual(Object.isFrozen(FORWARD_TRACE_LIMITS), true);

  // 恰好等于上限（字节数与字符数一致）
  const exactBody = bodyWithExactByteLength(boundary);
  assert.strictEqual(new TextEncoder().encode(exactBody).byteLength, boundary);
  const exactRes = await handleForwardTrace(makeRequest(exactBody));
  assert.strictEqual(exactRes.status, 202);
  assert.deepStrictEqual(await exactRes.json(), { success: true, logCount: 1 });
  assert.strictEqual(globals.logBuffer.length, 1);

  // 上限 + 1 字节
  resetLogBuffer();
  const oversizedRes = await handleForwardTrace(makeRequest(bodyWithExactByteLength(boundary + 1)));
  assert.strictEqual(oversizedRes.status, 413);
  assert.strictEqual(oversizedRes.headers.get('content-type'), 'application/json');
  assert.deepStrictEqual(await oversizedRes.json(), {
    success: false,
    errorMessage: 'Forward trace payload is too large',
  });
  assert.strictEqual(globals.logBuffer.length, 0, '超限报文不应写入任何日志');

  // 超限但根本不是 JSON：说明长度检查先于 JSON 解析（否则会得到 400）
  const blankRes = await handleForwardTrace(makeRequest(' '.repeat(boundary + 1)));
  assert.strictEqual(blankRes.status, 413);
  assert.deepStrictEqual(await blankRes.json(), {
    success: false,
    errorMessage: 'Forward trace payload is too large',
  });

  // 多字节场景：字符数比上限少，但字节数正好等于上限 → 放行
  const multibyteExact = multibyteBody(1000);
  assert.ok(multibyteExact.length < boundary, '多字节报文的 UTF-16 长度应小于上限');
  assert.strictEqual(new TextEncoder().encode(multibyteExact).byteLength, boundary);
  resetLogBuffer();
  assert.strictEqual((await handleForwardTrace(makeRequest(multibyteExact))).status, 202);
  assert.strictEqual(globals.logBuffer.length, 1);

  // 同一多字节报文再加 1 个汉字（字符数仍小于上限）→ 因字节数超限被拒
  resetLogBuffer();
  const multibyteOver = multibyteBody(1000, 3);
  assert.ok(multibyteOver.length < boundary, '超限报文的 UTF-16 长度仍小于上限');
  assert.strictEqual(new TextEncoder().encode(multibyteOver).byteLength, boundary + 3);
  const multibyteRes = await handleForwardTrace(makeRequest(multibyteOver));
  assert.strictEqual(multibyteRes.status, 413);
  assert.strictEqual(globals.logBuffer.length, 0);
});

test('handleForwardTrace 非法 JSON 返回 400，不写日志，只读取一次报文', async (t) => {
  captureConsole(t);
  resetLogBuffer();

  for (const body of ['not json', '{', '', '{"handler":}', '{"handler":"h",}']) {
    const req = makeRequest(body);
    const res = await handleForwardTrace(req);
    assert.strictEqual(res.status, 400, `非法 JSON ${JSON.stringify(body)} 应返回 400`);
    assert.strictEqual(res.headers.get('content-type'), 'application/json');
    assert.deepStrictEqual(await res.json(), { success: false, errorMessage: 'Invalid JSON payload' });
    assert.strictEqual(req.textCalls, 1, 'req.text() 只应被调用一次');
  }

  assert.strictEqual(globals.logBuffer.length, 0);
});

test('handleForwardTrace handler 校验：缺失/空白/超 64 字符均 400，恰好 64 字符放行', async (t) => {
  captureConsole(t);
  resetLogBuffer();

  const invalidPayloads = [
    {},
    { eventType: 'handlerStart' },
    { handler: '' },
    { handler: '   ' },
    { handler: null },
    { handler: 0 },
    { handler: 'h'.repeat(65) },
  ];
  for (const payload of invalidPayloads) {
    const res = await handleForwardTrace(makeJsonRequest(payload));
    assert.strictEqual(res.status, 400, `handler=${JSON.stringify(payload.handler)} 应返回 400`);
    assert.deepStrictEqual(await res.json(), { success: false, errorMessage: 'handler is required' });
  }

  // 合法 JSON 但不是对象
  for (const body of ['null', '[]', '42', '"str"', 'true']) {
    const res = await handleForwardTrace(makeRequest(body));
    assert.strictEqual(res.status, 400, `非对象报文 ${body} 应返回 400`);
    assert.deepStrictEqual(await res.json(), { success: false, errorMessage: 'handler is required' });
  }

  // 边界：恰好 64 字符通过，且 handler 两侧空白被裁剪
  const maxHandler = 'h'.repeat(64);
  const res = await handleForwardTrace(makeJsonRequest({ handler: maxHandler, eventType: 'handlerStart' }));
  assert.strictEqual(res.status, 202);
  assert.strictEqual(globals.logBuffer.length, 1);
  assert.ok(globals.logBuffer[0].message.startsWith(`[ForwardRemote][${maxHandler}] `));

  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: '  trimmed  ', eventType: 'handlerStart' }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][trimmed] START params={}');
});

test('handleForwardTrace handlerStart：写入 globals.logBuffer 并同步输出 info 日志', async (t) => {
  const console_ = captureConsole(t);
  resetLogBuffer();

  const res = await handleForwardTrace(makeJsonRequest({
    handler: 'migu',
    eventType: 'handlerStart',
    params: { a: 1, b: '中' },
    timestamp: '2024-01-01T00:00:00.000Z',
  }));

  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(await res.json(), { success: true, logCount: 1 });
  assert.deepStrictEqual(globals.logBuffer, [{
    timestamp: '2024-01-01T00:00:00.000Z',
    level: 'info',
    message: '[ForwardRemote][migu] START params={"a":1,"b":"中"}',
  }]);
  assert.deepStrictEqual(console_.info, [['[ForwardRemote][migu] START params={"a":1,"b":"中"}']]);
  assert.deepStrictEqual(console_.warn, []);
  assert.deepStrictEqual(console_.error, []);

  // params 缺省 → {}；params 为字符串/数字时按 JSON 值展开
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', eventType: 'handlerStart' }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] START params={}');
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', eventType: 'handlerStart', params: 'raw' }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] START params="raw"');
  // timestamp 缺省时落库为 ISO 字符串
  assert.match(globals.logBuffer[0].timestamp, ISO_TIMESTAMP);
});

test('handleForwardTrace handlerComplete：status/duration/result/error 格式化与 level 归一化', async (t) => {
  const console_ = captureConsole(t);
  resetLogBuffer();

  // 缺省 eventType 走 complete 分支；status 缺省 → unknown；durationMs 缺省 → 0
  await handleForwardTrace(makeJsonRequest({ handler: 'h', result: null }));
  assert.deepStrictEqual(globals.logBuffer[0], {
    timestamp: globals.logBuffer[0].timestamp,
    level: 'info',
    message: '[ForwardRemote][h] COMPLETE status=unknown duration=0ms result=null',
  });
  assert.match(globals.logBuffer[0].timestamp, ISO_TIMESTAMP);

  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({
    handler: 'h', eventType: 'handlerComplete', status: 'success', durationMs: 12, result: { ok: true },
  }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=success duration=12ms result={"ok":true}');

  // 结果缺省（undefined）与显式 null 一样序列化为 null
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', status: 'success' }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=success duration=0ms result=null');

  // 非法 durationMs 归一为 0，可解析的小数则保留
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', status: 'success', durationMs: 'abc', result: 1 }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=success duration=0ms result=1');
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', status: 'success', durationMs: '12.5', result: 1 }));
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=success duration=12.5ms result=1');

  // status=error → level=error 且错误对象取代 result
  resetLogBuffer();
  await handleForwardTrace(makeJsonRequest({ handler: 'h', status: 'error', error: { code: 'E1' }, result: 'ignored' }));
  assert.deepStrictEqual(globals.logBuffer[0].level, 'error');
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=error duration=0ms error={"code":"E1"}');
  assert.deepStrictEqual(console_.error.at(-1), ['[ForwardRemote][h] COMPLETE status=error duration=0ms error={"code":"E1"}']);

  // 未知 eventType 同样走 complete 分支
  resetLogBuffer();
  const weird = await handleForwardTrace(makeJsonRequest({ handler: 'h', eventType: 'weird', status: 'success', result: 2 }));
  assert.deepStrictEqual(await weird.json(), { success: true, logCount: 1 });
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] COMPLETE status=success duration=0ms result=2');
});

test('handleForwardTrace logBatch：逐条落库、level 白名单归一化、最多取前 50 条但 logCount 返回全量', async (t) => {
  const console_ = captureConsole(t);
  resetLogBuffer();

  const res = await handleForwardTrace(makeJsonRequest({
    handler: 'h',
    eventType: 'logBatch',
    logs: [
      { level: 'warn', message: 'a', timestamp: 'T1' },
      { level: 'debug', message: 'b' },
      { message: 'c' },
    ],
  }));
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(await res.json(), { success: true, logCount: 3 });
  assert.strictEqual(globals.logBuffer.length, 3);
  assert.deepStrictEqual(globals.logBuffer[0], { timestamp: 'T1', level: 'warn', message: '[ForwardRemote][h] a' });
  assert.strictEqual(globals.logBuffer[1].level, 'info', '非白名单 level 归一化为 info');
  assert.match(globals.logBuffer[1].timestamp, ISO_TIMESTAMP);
  assert.deepStrictEqual(globals.logBuffer[2], {
    timestamp: globals.logBuffer[2].timestamp,
    level: 'info',
    message: '[ForwardRemote][h] c',
  });
  assert.strictEqual(console_.info.length, 2);
  assert.strictEqual(console_.warn.length, 1);

  // logs 非数组 / 缺失 → logCount 0 且不写日志
  resetLogBuffer();
  for (const payload of [{ handler: 'h', eventType: 'logBatch' }, { handler: 'h', eventType: 'logBatch', logs: 'x' }, { handler: 'h', eventType: 'logBatch', logs: null }]) {
    const empty = await handleForwardTrace(makeJsonRequest(payload));
    assert.deepStrictEqual(await empty.json(), { success: true, logCount: 0 });
  }
  assert.strictEqual(globals.logBuffer.length, 0);

  // 非对象条目：level/message 取不到值也不应抛错
  resetLogBuffer();
  const loose = await handleForwardTrace(makeJsonRequest({ handler: 'h', eventType: 'logBatch', logs: [null, 'str', 7] }));
  assert.deepStrictEqual(await loose.json(), { success: true, logCount: 3 });
  assert.deepStrictEqual(globals.logBuffer.map((entry) => entry.message), [
    '[ForwardRemote][h] ', '[ForwardRemote][h] ', '[ForwardRemote][h] ',
  ]);

  // 60 条只落前 50 条，但 logCount 仍报 60
  resetLogBuffer();
  const many = await handleForwardTrace(makeJsonRequest({
    handler: 'h',
    eventType: 'logBatch',
    logs: Array.from({ length: 60 }, (_, index) => ({ level: 'info', message: `item-${index}` })),
  }));
  assert.deepStrictEqual(await many.json(), { success: true, logCount: 60 });
  assert.strictEqual(globals.logBuffer.length, 50);
  assert.strictEqual(globals.logBuffer[0].message, '[ForwardRemote][h] item-0');
  assert.strictEqual(globals.logBuffer[49].message, '[ForwardRemote][h] item-49');
  assert.ok(!globals.logBuffer.some((entry) => entry.message.includes('item-50')));
});

test('handleForwardTrace 落库时按 globals.MAX_LOGS 截断，保留最新日志', async (t) => {
  captureConsole(t);
  const originalMaxLogs = globals.MAX_LOGS;
  assert.strictEqual(originalMaxLogs, 1000, '默认 MAX_LOGS 应为 1000');

  try {
    globals.MAX_LOGS = 2;
    assert.strictEqual(globals.MAX_LOGS, 2);
    resetLogBuffer();

    // 一批 3 条：最旧的一条被 shift 掉
    await handleForwardTrace(makeJsonRequest({
      handler: 'h',
      eventType: 'logBatch',
      logs: [{ message: 'A' }, { message: 'B' }, { message: 'C' }],
    }));
    assert.deepStrictEqual(globals.logBuffer.map((entry) => entry.message), [
      '[ForwardRemote][h] B',
      '[ForwardRemote][h] C',
    ]);

    // 逐条事件同样触发截断
    resetLogBuffer();
    for (const tag of ['X', 'Y', 'Z']) {
      await handleForwardTrace(makeJsonRequest({ handler: 'h', eventType: 'handlerStart', params: { tag } }));
      assert.ok(globals.logBuffer.length <= 2);
    }
    assert.deepStrictEqual(globals.logBuffer.map((entry) => entry.message), [
      '[ForwardRemote][h] START params={"tag":"Y"}',
      '[ForwardRemote][h] START params={"tag":"Z"}',
    ]);
  } finally {
    globals.MAX_LOGS = originalMaxLogs;
    resetLogBuffer();
  }

  assert.strictEqual(globals.MAX_LOGS, 1000);
});

test('handleForwardTrace 不兜底 req.text() 的异常与非字符串返回值', async (t) => {
  captureConsole(t);
  resetLogBuffer();

  const brokenReq = { async text() { throw new Error('stream failed'); } };
  await assert.rejects(handleForwardTrace(brokenReq), { name: 'Error', message: 'stream failed' });
  assert.strictEqual(globals.logBuffer.length, 0);

  // text() 返回 undefined：被 TextEncoder 转成 "undefined"，JSON.parse 失败 → 400
  const res = await handleForwardTrace(makeRequest(undefined));
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { success: false, errorMessage: 'Invalid JSON payload' });
  assert.strictEqual(globals.logBuffer.length, 0);
});
