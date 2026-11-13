import test from 'node:test';
import assert from 'node:assert/strict';
import { getLogMetadata } from './utils/log-metadata-util.js';
import { log, logEvent } from './utils/log-util.js';
import { runWithMatchTrace, traceMatchStep } from './utils/match-trace-util.js';
import { Globals } from './configs/globals.js';
import { handleRequest } from './worker.js';
import vm from 'node:vm';
import { logviewJsContent } from './ui/js/logview.js';
import { createUgcLogger } from './utils/bilibili-ugc-util.js';

test('数字令牌脱敏不会破坏投稿 ID，嵌套字符串仍脱敏且不修改原数据', () => {
  Globals.init({ TOKEN: '5432', LOG_LEVEL: 'info' }); Globals.logBuffer = [];
  const data = { cid: 987654321, nested: [{ url: 'http://example.test/5432/api', count: 5432 }] };
  const before = structuredClone(data);
  try {
    const logger = createUgcLogger({ title: '测试作品', episode: 1 });
    assert.doesNotThrow(() => logger('candidate.select', '投稿身份已匹配', data));
    const entry = Globals.logBuffer.at(-1);
    assert.equal(entry.data.cid, 987654321);
    assert.deepEqual(entry.data.nested, [{ url: 'http://example.test/****/api', count: 5432 }]);
    assert.deepEqual(data, before);
  } finally { Globals.init({}); }
});

test('投稿筛选细节不会挤掉默认级别的播放器请求，debug仍可查看细节', () => {
  Globals.init({ LOG_LEVEL: 'info' }); Globals.logBuffer = [];
  try {
    logEvent('info', 'match.request', '[system] 播放器请求', { fileName: '猫和老鼠 S01E01' });
    const logger = createUgcLogger({ title: '猫和老鼠', episode: 1 });
    for (let i = 0; i < Globals.MAX_LOGS + 1; i++) logger('candidate.reject', '投稿初筛拒绝', { reason: 'non-content' });
    logger('search.end', '检索结束', { discovered: 500, eligible: 8 });
    logger('candidate.failure', '投稿详情获取失败', {}, 'warn');
    assert.deepEqual(Globals.logBuffer.map(e => e.event), ['match.request', 'ugc.search.end', 'ugc.candidate.failure']);
    assert.equal(Globals.logBuffer.at(-1).level, 'warn');
    Globals.init({ LOG_LEVEL: 'debug' });
    for (const event of ['search.query', 'search.result', 'candidate.reject', 'candidate.detail', 'candidate.fetch']) {
      logger(event, '调试细节');
      assert.equal(Globals.logBuffer.at(-1).level, 'debug');
      assert.equal(Globals.logBuffer.at(-1).event, 'ugc.' + event);
    }
  } finally { Globals.init({}); }
});

test('前端保留未知来源，拒绝将不安全请求编号插入追踪界面', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(logviewJsContent, context);
  const normalized = context.normalizeLogEntry({ source: null, categories: ['system'], message: '[favorite] 收藏刷新', requestId: 'bad"onclick="attack' }, 0);
  assert.equal(normalized.source, null);
  assert.equal(normalized.requestId, null);
});

test('分类与来源是独立维度，旧标签不猜测未声明来源', () => {
  const meta = getLogMetadata('[match-id=1234abcd] [tencent] [blocked-words] 命中');
  assert.deepEqual(meta.categories, ['match', 'filter', 'source']);
  assert.equal(meta.source, 'tencent');
  assert.equal(meta.requestId, '1234abcd');
  assert.equal(getLogMetadata('[system] [blocked-words] 聚合后过滤').source, null);
  assert.ok(getLogMetadata('[system] [remote-mapping] 刷新').categories.includes('mapping'));
  assert.equal(getLogMetadata('[imgo] 搜索').source, 'mango');
});

test('UGC JSON and legacy text logs appear in matching filter without a fake source', () => {
  const message = '[ugc] [ugc-id=test-1] 「作品」第5集 UGC结束';
  const metadata = getLogMetadata(message);
  assert.deepEqual(metadata.categories, ['match']);
  assert.equal(metadata.source, null);
  const context = vm.createContext({ window: {} });
  vm.runInContext(logviewJsContent, context);
  context.entries = [{ message, ...metadata }, { message }];
  vm.runInContext("let logs = entries.map(normalizeLogEntry); logViewState.category = 'match';", context);
  assert.equal(vm.runInContext('filterLogEntries().length', context), 2);
  assert.equal(vm.runInContext('logs[1].source', context), null);
  vm.runInContext("logViewState.category = 'system';", context);
  assert.equal(vm.runInContext('filterLogEntries().length', context), 0);
});

test('真实日志接口兼容文本，JSON保留结构与脱敏，未授权请求被拒绝', async () => {
  const env = { TOKEN: 'test-log-user', TOKEN_AUTH_DISABLED: 'false', USE_BANGUMI_DATA: 'false', LOG_LEVEL: 'debug' };
  Globals.init(env); Globals.logBuffer = [];
  Globals.originalEnvVars = { API_KEY: 'sensitive-test-key' };
  Globals.accessedEnvVars = { API_KEY: '******************' };
  await runWithMatchTrace(async () => {
    logEvent('debug', 'match.identity', '[system] [match-trace] 解析身份', { title: 'sensitive-test-key', season: 4, episode: 9 });
    await traceMatchStep(log, '来源 tencent 搜索', async () => []);
    log('warn', '[iqiyi] client ip: 192.168.1.9');
  });
  const request = path => handleRequest(new Request('http://localhost/' + path), env);
  const json = await request('test-log-user/api/logs?format=json');
  assert.equal(json.status, 200);
  const text = await json.text();
  assert.ok(!text.includes('sensitive-test-key'));
  assert.ok(text.includes('192.168.1.9'));
  const payload = JSON.parse(text);
  const event = payload.entries.find(e => e.event === 'match.identity');
  assert.equal(event.data.title, '******************');
  assert.equal(event.data.episode, 9);
  assert.equal(event.level, 'debug');
  assert.ok(payload.entries.some(entry => entry.level === 'info' && entry.event === 'step.end'));
  assert.ok(event.requestId);
  assert.equal(new Set(payload.entries.map(e => e.id)).size, payload.entries.length);
  const timing = payload.entries.find(e => e.event === 'step.end');
  assert.equal(timing.source, 'tencent');
  assert.equal(timing.data.status, 'completed');
  const retained = Globals.logBuffer.length;
  await request('test-log-user/api/logs?format=json');
  assert.equal(Globals.logBuffer.length, retained, '读取日志不应产生自我轮询日志');
  const plain = await request('test-log-user/api/logs');
  assert.match(plain.headers.get('content-type'), /text\/plain/);
  assert.ok((await plain.text()).includes('[match-id='));
  const denied = await request('wrong-token/api/logs?format=json');
  assert.ok([401,403].includes(denied.status));
});

test('configured log levels filter buffer and console consistently', () => {
  const levels = ['error', 'warn', 'info', 'debug'];
  const original = Object.fromEntries(levels.map(level => [level, console[level]]));
  try {
    for (let threshold = 0; threshold < levels.length; threshold++) {
      Globals.init({ LOG_LEVEL: levels[threshold] }); Globals.logBuffer = [];
      const emitted = [];
      for (const level of levels) console[level] = () => emitted.push(level);
      for (const level of levels) log(level, '[system] matrix ' + level);
      assert.deepEqual(Globals.logBuffer.map(entry => entry.level), levels.slice(0, threshold + 1));
      assert.deepEqual(emitted, levels.slice(0, threshold + 1));
    }
  } finally {
    for (const level of levels) console[level] = original[level];
  }
});

test('log UI keeps debug entries and filters them independently', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(logviewJsContent, context);
  vm.runInContext("let logs = [normalizeLogEntry({level:'debug',message:'[system] detail'},0), normalizeLogEntry({level:'info',message:'[system] summary'},1)]; logViewState.level = 'debug';", context);
  assert.equal(vm.runInContext('filterLogEntries().length', context), 1);
  assert.equal(vm.runInContext('filterLogEntries()[0].type', context), 'debug');
});
