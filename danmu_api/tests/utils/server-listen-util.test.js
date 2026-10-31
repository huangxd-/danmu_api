// 监听工具：formatHostForUrl 纯函数 + listenOnAllInterfaces 双栈监听与 IPv6 不可用回退
// 全部离线：成功路径只监听端口 0 并从 127.0.0.1 回环自测，回退/报错分支用脚本化假 server 模拟。

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { listenOnAllInterfaces, formatHostForUrl } from '../../utils/server-listen-util.js';

function bindError(code, message = 'bind failed') {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  return error;
}

// 脚本化假 server：按步骤决定 listen() 是抛错、emit('error') 还是成功回调
class ScriptedServer extends EventEmitter {
  constructor(steps) {
    super();
    this.steps = [...steps];
    this.listenCalls = [];
    this.addressValue = null;
  }

  listen(options, callback) {
    this.listenCalls.push(options);
    const step = this.steps.shift();
    assert.ok(step, `listen 调用次数超出脚本预期（options=${JSON.stringify(options)}）`);
    if (step.syncError) throw step.syncError;
    if (step.error) {
      this.emit('error', step.error);
      return;
    }
    this.addressValue = step.address;
    if (typeof callback === 'function') callback();
  }

  address() {
    return this.addressValue;
  }
}

// 用 connection: close + agent:false 保证回环请求结束后不留 keep-alive 连接，server.close() 不会挂住
function localRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}/`,
      { agent: false, headers: { connection: 'close' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (message) => { warnings.push(message); } };
}

test('formatHostForUrl 只对含冒号的主机加方括号（IPv4 / IPv6 / 带端口 / 空值 / 非字符串）', () => {
  assert.strictEqual(formatHostForUrl('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(formatHostForUrl('0.0.0.0'), '0.0.0.0');
  assert.strictEqual(formatHostForUrl('localhost'), 'localhost');
  assert.strictEqual(formatHostForUrl('::'), '[::]');
  assert.strictEqual(formatHostForUrl('::1'), '[::1]');
  assert.strictEqual(formatHostForUrl('2001:db8::1'), '[2001:db8::1]');
  assert.strictEqual(formatHostForUrl('fe80::1%en0'), '[fe80::1%en0]');

  // 含冒号的「主机:端口」整体也被括起来（该函数只按冒号判断，不做拆分）
  assert.strictEqual(formatHostForUrl('localhost:3000'), '[localhost:3000]');
  assert.strictEqual(formatHostForUrl('[::1]'), '[[::1]]', '已是括号形式时并非幂等');

  // 一律先 String() 化
  assert.strictEqual(formatHostForUrl(''), '');
  assert.strictEqual(formatHostForUrl(null), 'null');
  assert.strictEqual(formatHostForUrl(undefined), 'undefined');
  assert.strictEqual(formatHostForUrl(8080), '8080');
  assert.strictEqual(formatHostForUrl(true), 'true');
  assert.strictEqual(formatHostForUrl(['::1']), '[::1]');
});

test('listenOnAllInterfaces 双栈监听成功：返回真实分配的端口、不回退，且清理 error 监听', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const logger = recordingLogger();

  try {
    const binding = await listenOnAllInterfaces(server, 0, { serviceName: 'unit-test', logger });

    assert.ok(binding.port > 0, '端口 0 应由操作系统分配出真实端口');
    assert.deepStrictEqual(binding, {
      address: '::',
      family: 'IPv6',
      port: server.address().port,
      fallback: false,
    });
    assert.strictEqual(server.listening, true);
    assert.deepStrictEqual(logger.warnings, [], '成功路径不应产生回退告警');
    assert.strictEqual(server.listenerCount('error'), 0, 'listenOnce 应解绑临时 error 监听');

    // 双栈套接字应同时接受 IPv4 回环连接
    assert.deepStrictEqual(await localRequest(binding.port), { status: 200, body: 'ok' });
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.strictEqual(server.listening, false);
});

test('listenOnAllInterfaces IPv6 不可用（EAFNOSUPPORT）时告警并回退到 0.0.0.0', async () => {
  const server = new ScriptedServer([
    { error: bindError('EAFNOSUPPORT') },
    { address: { address: '0.0.0.0', family: 'IPv4', port: 43210 } },
  ]);
  const logger = recordingLogger();

  const binding = await listenOnAllInterfaces(server, 0, { serviceName: 'migu', logger });

  assert.deepStrictEqual(binding, { address: '0.0.0.0', family: 'IPv4', port: 43210, fallback: true });
  assert.deepStrictEqual(server.listenCalls, [
    { port: 0, host: '::', ipv6Only: false },
    { port: 0, host: '0.0.0.0' },
  ]);
  assert.deepStrictEqual(logger.warnings, ['[server] migu cannot bind to IPv6 (EAFNOSUPPORT); falling back to IPv4']);
  assert.strictEqual(server.listenerCount('error'), 0);

  // 指定端口时两次尝试都用同一端口
  const ported = new ScriptedServer([
    { error: bindError('EAFNOSUPPORT') },
    { address: { address: '0.0.0.0', family: 'IPv4', port: 8080 } },
  ]);
  const portedLogger = recordingLogger();
  const portedBinding = await listenOnAllInterfaces(ported, 8080, { logger: portedLogger });
  assert.strictEqual(portedBinding.port, 8080);
  assert.deepStrictEqual(ported.listenCalls.map((call) => call.port), [8080, 8080]);
});

test('listenOnAllInterfaces EADDRNOTAVAIL 同样回退；serviceName 缺省为 server 并走 console.warn', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args); });
  const server = new ScriptedServer([
    { error: bindError('EADDRNOTAVAIL') },
    { address: { address: '0.0.0.0', family: 'IPv4', port: 3000 } },
  ]);

  const binding = await listenOnAllInterfaces(server, 0);

  assert.strictEqual(binding.fallback, true);
  assert.deepStrictEqual(warnings, [['[server] server cannot bind to IPv6 (EADDRNOTAVAIL); falling back to IPv4']]);
});

test('listenOnAllInterfaces 非 IPv6 相关错误原样抛出且不尝试回退', async () => {
  for (const code of ['EADDRINUSE', 'EACCES', undefined]) {
    const boom = bindError(code);
    const server = new ScriptedServer([{ error: boom }]);
    const logger = recordingLogger();

    await assert.rejects(listenOnAllInterfaces(server, 0, { logger }), (error) => {
      assert.strictEqual(error, boom, `code=${code} 应原样抛出同一个错误对象`);
      return true;
    });
    assert.strictEqual(server.listenCalls.length, 1, '不应发起第二次 listen');
    assert.deepStrictEqual(logger.warnings, []);
    assert.strictEqual(server.listenerCount('error'), 0);
  }
});

test('listenOnAllInterfaces listen() 同步抛错时：可回退的错误码回退，其它错误原样抛出', async () => {
  // 同步抛 EAFNOSUPPORT → 回退
  const fallbackServer = new ScriptedServer([
    { syncError: bindError('EAFNOSUPPORT', 'sync bind failure') },
    { address: { address: '0.0.0.0', family: 'IPv4', port: 5555 } },
  ]);
  const logger = recordingLogger();
  const binding = await listenOnAllInterfaces(fallbackServer, 0, { logger });
  assert.deepStrictEqual(binding, { address: '0.0.0.0', family: 'IPv4', port: 5555, fallback: true });
  assert.strictEqual(fallbackServer.listenCalls.length, 2);
  assert.strictEqual(fallbackServer.listenerCount('error'), 0);

  // 同步抛普通错误 → 直接失败，且不留 error 监听
  const boom = new RangeError('bad options');
  const failingServer = new ScriptedServer([{ syncError: boom }]);
  await assert.rejects(listenOnAllInterfaces(failingServer, 0, { logger }), (error) => {
    assert.strictEqual(error, boom);
    return true;
  });
  assert.strictEqual(failingServer.listenCalls.length, 1);
  assert.strictEqual(failingServer.listenerCount('error'), 0);
  assert.deepStrictEqual(logger.warnings, ['[server] server cannot bind to IPv6 (EAFNOSUPPORT); falling back to IPv4']);
});

test('listenOnAllInterfaces 在 server.address() 非对象时回落到请求的主机与端口', async () => {
  // 成功路径但 address() 返回 null：用请求参数兜底，family 按请求的 '::' 推断
  const directServer = new ScriptedServer([{ address: null }]);
  const directBinding = await listenOnAllInterfaces(directServer, 0, { logger: recordingLogger() });
  assert.deepStrictEqual(directBinding, { address: '::', family: 'IPv6', port: 0, fallback: false });

  const portedServer = new ScriptedServer([{ address: 'not-an-object' }]);
  const portedBinding = await listenOnAllInterfaces(portedServer, 8080, { logger: recordingLogger() });
  assert.deepStrictEqual(portedBinding, { address: '::', family: 'IPv6', port: 8080, fallback: false });

  // 回退路径同样兜底，此时主机是 0.0.0.0（判定为 IPv4）
  const fallbackServer = new ScriptedServer([
    { error: bindError('EAFNOSUPPORT') },
    { address: undefined },
  ]);
  const fallbackBinding = await listenOnAllInterfaces(fallbackServer, 8080, { logger: recordingLogger() });
  assert.deepStrictEqual(fallbackBinding, { address: '0.0.0.0', family: 'IPv4', port: 8080, fallback: true });
});
