import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from './worker.js';
import { getCachedRemoteAutoMatchMappingRules, initializeRemoteAutoMatchMapping } from './utils/auto-match-mapping-url-util.js';
import { Globals } from './configs/globals.js';
import { applyRemoteTitleMappingText } from './utils/title-mapping-url-util.js';
import { httpGet } from './utils/http-util.js';

const endpoint = '/api/auto-match-mapping/refresh';
const remoteUrl = 'https://mapping-test.example/season.txt';
const env = {
  TOKEN: 'test-user',
  AUTO_MATCH_MAPPING_TABLE_URL: remoteUrl,
};
const request = (prefix = '') => new Request('http://localhost' + prefix + endpoint, { method: 'POST' });
const handle = (req, config) => handleRequest(req, config, 'cloudflare', '127.0.0.1');

test('info keeps changed mapping summaries and failures but hides routine requests', async () => {
  Globals.init({ LOG_LEVEL: 'info' }); Globals.logBuffer = [];
  const savedFetch = globalThis.fetch;
  try {
    const url = 'https://mapping-test.example/log-summary.txt';
    applyRemoteTitleMappingText(url, '旧名->新名');
    applyRemoteTitleMappingText(url, '旧名->新名');
    assert.equal(Globals.logBuffer.filter(row => row.message.includes('更新成功')).length, 1);
    globalThis.fetch = async () => new Response('ok');
    await httpGet('https://mapping-test.example/download', { retries: 0 });
    assert(!Globals.logBuffer.some(row => row.message.includes('HTTP GET:')));
    globalThis.fetch = async () => { throw Error('download failed'); };
    await assert.rejects(httpGet('https://mapping-test.example/failure', { retries: 0 }), /download failed/);
    assert(Globals.logBuffer.some(row => row.level === 'warn' && row.message.includes('请求失败')));
    assert(Globals.logBuffer.some(row => row.level === 'error' && row.message.includes('所有重试均失败')));
  } finally { globalThis.fetch = savedFetch; Globals.init({}); }
});

test('season refresh reaches its handler instead of being rewritten to /api/v2', async () => {
  const response = await handle(request(), { TOKEN_AUTH_DISABLED: 'true' });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.match(body.error, /AUTO_MATCH_MAPPING_TABLE_URL/);
});

test('season refresh rejects a retired administrator token', async () => {
  const response = await handle(request('/retired-admin'), env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});

test('authenticated refresh returns success and count after writing rules; failed refresh preserves cache', async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'season-refresh-test-'));
  try {
    process.chdir(temp);
    let fetchCount = 0;
    globalThis.fetch = async url => {
      assert.equal(String(url), remoteUrl);
      fetchCount++;
      return new Response('测试作品 S02E01 -> 测试作品 S01E13', {
        status: 200, headers: { 'content-type': 'text/plain' },
      });
    };
    const response = await handle(request('/test-user'), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, count: 1 });
    assert.equal(fetchCount, 1);
    assert.equal(getCachedRemoteAutoMatchMappingRules().length, 1);
    assert.match(await fs.readFile(path.join(temp, '.cache', 'auto-match-mapping-remote.txt'), 'utf8'), /S01E13/);

    globalThis.fetch = async () => { throw new Error('simulated network failure'); };
    const failed = await handle(request('/test-user'), env);
    assert.equal(failed.status, 502);
    const failure = await failed.json();
    assert.equal(failure.success, false);
    assert.equal(failure.count, 1);
    assert.match(failure.error, /simulated network failure/);
    assert.equal(getCachedRemoteAutoMatchMappingRules().length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('background season refresh honours PROXY_URL and never writes error diagnostics', async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const quietUrl = 'https://mapping-test.example/quiet-season.txt';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'season-quiet-test-'));
  try {
    process.chdir(temp);
    const urls = [];
    globalThis.fetch = async url => { urls.push(String(url)); throw new Error('simulated network failure'); };
    Globals.init({ AUTO_MATCH_MAPPING_TABLE_URL: quietUrl, PROXY_URL: '@https://mirror.example', LOG_LEVEL: 'info' });
    Globals.logBuffer = [];
    await initializeRemoteAutoMatchMapping();
    assert.equal(urls.length, 1);
    assert.equal(urls[0], `https://mirror.example/${quietUrl}`, 'reverse proxy is applied to the mapping fetch');
    assert.equal(Globals.logBuffer.filter(e => e.level === 'error' && e.message.includes('请求模拟')).length, 0,
      'background failures must not write error diagnostics');
    assert.equal(Globals.logBuffer.filter(e => e.level === 'warn' && e.message.includes('启动更新失败')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    await fs.rm(temp, { recursive: true, force: true });
    Globals.init({});
  }
});
