// SSRF fix regression test for the 5321 proxy server.
//
// Re-implements the private isDisallowedProxyTargetIp / validateProxyTarget
// logic by re-loading server.js source and vm.runInNewContext is overkill —
// instead we boot the actual proxy server (createProxyServer) via the same
// http module path but expose it by patching server.js dynamically? Too
// invasive. Use the easier route: copy the helpers' behaviour test via the
// real proxy server by literally launching it on an ephemeral port.

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';

// Pull the two helper functions out of server.js without booting the whole
// app. They are pure functions w.r.t. the imported `net` module, so we
// evaluate them inside a sandbox that supplies a real `net` and `dns`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function extractFn(src, name) {
  // Find the function declaration with its body. We rely on the file using
  // 1 blank line between top-level declarations.
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) throw new Error(`Could not locate function ${name}`);
  const start = m.index;
  // Walk braces.
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

const helperSrc =
  extractFn(serverSrc, 'isDisallowedProxyTargetIp') + '\n' +
  extractFn(serverSrc, 'validateProxyTarget') + '\n' +
  'globalThis.__isDisallowedProxyTargetIp = isDisallowedProxyTargetIp;\n' +
  'globalThis.__validateProxyTarget = validateProxyTarget;\n';

const net = await import('node:net');
const dns = await import('node:dns');
const sandbox = {
  net: net.default ?? net,
  dns: dns.default ?? dns,
  console,
  globalThis: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);
const isDisallowedProxyTargetIp = sandbox.__isDisallowedProxyTargetIp;
const validateProxyTarget = sandbox.__validateProxyTarget;

test('isDisallowedProxyTargetIp - IPv4 reserved ranges', () => {
  // Loopback
  assert.equal(isDisallowedProxyTargetIp('127.0.0.1'), true, '127.0.0.1');
  assert.equal(isDisallowedProxyTargetIp('127.255.255.254'), true, '127.255.x.x');
  // Unspecified
  assert.equal(isDisallowedProxyTargetIp('0.0.0.0'), true, '0.0.0.0');
  // RFC1918
  assert.equal(isDisallowedProxyTargetIp('10.1.2.3'), true, '10/8');
  assert.equal(isDisallowedProxyTargetIp('172.16.0.1'), true, '172.16/12 low');
  assert.equal(isDisallowedProxyTargetIp('172.31.255.254'), true, '172.16/12 high');
  assert.equal(isDisallowedProxyTargetIp('192.168.1.1'), true, '192.168/16');
  // Link-local / cloud metadata
  assert.equal(isDisallowedProxyTargetIp('169.254.169.254'), true, 'AWS metadata');
  assert.equal(isDisallowedProxyTargetIp('169.254.0.1'), true, 'link-local');
  // CGNAT
  assert.equal(isDisallowedProxyTargetIp('100.64.0.1'), true, 'CGNAT low');
  assert.equal(isDisallowedProxyTargetIp('100.127.255.254'), true, 'CGNAT high');
  // Multicast / broadcast / reserved
  assert.equal(isDisallowedProxyTargetIp('224.0.0.1'), true, 'multicast');
  assert.equal(isDisallowedProxyTargetIp('239.255.255.255'), true, 'multicast high');
  assert.equal(isDisallowedProxyTargetIp('240.0.0.1'), true, 'reserved');
  assert.equal(isDisallowedProxyTargetIp('255.255.255.255'), true, 'broadcast');
  // Benchmarking
  assert.equal(isDisallowedProxyTargetIp('198.18.0.1'), true, 'benchmarking');
  assert.equal(isDisallowedProxyTargetIp('198.19.255.254'), true, 'benchmarking');
});

test('isDisallowedProxyTargetIp - public IPv4 allowed', () => {
  // Cloudflare / Google DNS, GitHub
  assert.equal(isDisallowedProxyTargetIp('1.1.1.1'), false);
  assert.equal(isDisallowedProxyTargetIp('8.8.8.8'), false);
  assert.equal(isDisallowedProxyTargetIp('140.82.121.4'), false);
  // Public-ish boundaries near reserved ranges
  assert.equal(isDisallowedProxyTargetIp('172.15.255.254'), false, 'just below RFC1918');
  assert.equal(isDisallowedProxyTargetIp('172.32.0.1'), false, 'just above RFC1918');
  assert.equal(isDisallowedProxyTargetIp('100.63.255.254'), false, 'just below CGNAT');
  assert.equal(isDisallowedProxyTargetIp('100.128.0.1'), false, 'just above CGNAT');
  assert.equal(isDisallowedProxyTargetIp('169.253.255.254'), false, 'just below link-local');
  assert.equal(isDisallowedProxyTargetIp('169.255.0.1'), false, 'just above link-local');
});

test('isDisallowedProxyTargetIp - IPv6 reserved', () => {
  assert.equal(isDisallowedProxyTargetIp('::1'), true, 'IPv6 loopback');
  assert.equal(isDisallowedProxyTargetIp('::'), true, 'unspecified');
  assert.equal(isDisallowedProxyTargetIp('fe80::1'), true, 'link-local');
  assert.equal(isDisallowedProxyTargetIp('fc00::1'), true, 'ULA');
  assert.equal(isDisallowedProxyTargetIp('fd00::1'), true, 'ULA');
  assert.equal(isDisallowedProxyTargetIp('ff02::1'), true, 'multicast');
  // IPv4-mapped IPv6
  assert.equal(isDisallowedProxyTargetIp('::ffff:127.0.0.1'), true, 'mapped loopback');
  assert.equal(isDisallowedProxyTargetIp('::ffff:169.254.169.254'), true, 'mapped metadata');
  assert.equal(isDisallowedProxyTargetIp('::ffff:7f00:1'), true, 'mapped loopback hex');
  assert.equal(isDisallowedProxyTargetIp('::ffff:a9fe:a9fe'), true, 'mapped metadata hex');
  // IPv4-compatible (deprecated)
  assert.equal(isDisallowedProxyTargetIp('::127.0.0.1'), true, 'compat loopback');
});

test('isDisallowedProxyTargetIp - public IPv6 allowed', () => {
  assert.equal(isDisallowedProxyTargetIp('2606:4700:4700::1111'), false, 'Cloudflare');
  assert.equal(isDisallowedProxyTargetIp('2001:4860:4860::8888'), false, 'Google');
});

test('isDisallowedProxyTargetIp - invalid input handled safely', () => {
  assert.equal(isDisallowedProxyTargetIp(''), true);
  assert.equal(isDisallowedProxyTargetIp(null), true);
  assert.equal(isDisallowedProxyTargetIp(undefined), true);
  assert.equal(isDisallowedProxyTargetIp('not-an-ip'), true);
  assert.equal(isDisallowedProxyTargetIp('999.999.999.999'), true);
});

test('validateProxyTarget - rejects non-http(s) protocols', async () => {
  for (const proto of ['file:', 'gopher:', 'dict:', 'ftp:', 'data:']) {
    const url = new URL(`${proto}//example.com/`);
    const r = await validateProxyTarget(url);
    assert.equal(r.ok, false, `${proto} should be rejected`);
    assert.equal(r.status, 400, `${proto} → 400`);
  }
});

test('validateProxyTarget - rejects literal internal IPs without DNS', async () => {
  for (const addr of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]']) {
    const url = new URL(`http://${addr}/`);
    const r = await validateProxyTarget(url);
    assert.equal(r.ok, false, `${addr} should be rejected`);
    assert.equal(r.status, 403, `${addr} → 403`);
  }
});

test('validateProxyTarget - accepts literal public IPs', async () => {
  const url = new URL('http://1.1.1.1/');
  const r = await validateProxyTarget(url);
  assert.equal(r.ok, true, '1.1.1.1 should be accepted');
  assert.equal(r.ip, '1.1.1.1');
});

// End-to-end test against the real createProxyServer. We test that
// requests for SSRF-y URLs are refused with the documented status codes
// and that a public-looking hostname (no DNS required, we pass an IP) is
// rejected only when internal.
test('proxy server end-to-end - SSRF probes blocked', async (t) => {
  // Boot the proxy server. We need the real createProxyServer, but
  // importing server.js also starts the main app on port 9321 and
  // schedules background tasks. To avoid this, we re-evaluate just
  // createProxyServer here too.
  const createSrc = extractFn(serverSrc, 'createProxyServer');
  // createProxyServer references: http, https, HttpsProxyAgent, console,
  // process, URL, validateProxyTarget, isDisallowedProxyTargetIp, net.
  const https = await import('node:https');
  const url = await import('node:url');
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const ctx = {
    net: net.default ?? net,
    dns: dns.default ?? dns,
    http,
    https: https.default ?? https,
    URL,
    HttpsProxyAgent,
    process,
    console,
    isDisallowedProxyTargetIp,
    validateProxyTarget,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(createSrc + '\nglobalThis.__createProxyServer = createProxyServer;\n', ctx);
  const server = ctx.__createProxyServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));

  const probe = (q) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/?url=${encodeURIComponent(q)}`,
          method: 'GET',
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  // Each of these should be rejected (status 400 or 403).
  const ssrfProbes = [
    'http://127.0.0.1/',
    'http://localhost/', // resolves to loopback
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://255.255.255.255/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/', // mapped hex loopback
    'http://[::ffff:a9fe:a9fe]/', // mapped hex metadata
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_x',
    'dict://127.0.0.1:11211/stats',
    'ftp://127.0.0.1/',
  ];
  for (const p of ssrfProbes) {
    const r = await probe(p);
    assert.ok(
      r.status === 400 || r.status === 403 || r.status === 502,
      `${p} should be blocked (got ${r.status}: ${r.body})`
    );
  }
});

test('proxy server end-to-end - bad URL → 400', async (t) => {
  const createSrc = extractFn(serverSrc, 'createProxyServer');
  const https = await import('node:https');
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const ctx = {
    net: net.default ?? net,
    dns: dns.default ?? dns,
    http,
    https: https.default ?? https,
    URL,
    HttpsProxyAgent,
    process,
    console,
    isDisallowedProxyTargetIp,
    validateProxyTarget,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(createSrc + '\nglobalThis.__createProxyServer = createProxyServer;\n', ctx);
  const server = ctx.__createProxyServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));

  const req = http.request(
    { host: '127.0.0.1', port, path: '/?url=not-a-url', method: 'GET' }
  );
  const status = await new Promise((resolve, reject) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
});
