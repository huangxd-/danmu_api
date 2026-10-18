import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiVerifier } from './ai-verify-util.js';
import AIClient from './ai-util.js';
import worker from '../worker.js';

const config = { baseURL: 'https://ai.example/v1', apiKey: 'fixture', model: 'fixture' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('concurrent callers share a task and failures observe retry backoff', async () => {
  let time = 0; let calls = 0; const results = [];
  const task = deferred();
  const schedule = createAiVerifier({ verify: () => { calls++; return task.promise; }, onStatus: valid => results.push(valid), now: () => time, retryIntervalMs: 100 });
  const first = schedule(config);
  assert.equal(first, schedule(config));
  task.resolve({ ok: false }); await first;
  assert.equal(calls, 1); assert.equal(schedule(config), null);
  time = 100; await schedule(config); assert.equal(calls, 2);
  assert.equal(results.at(-1), false);
});

test('configuration changes invalidate success and discard stale completions', async () => {
  const tasks = []; const states = [];
  const schedule = createAiVerifier({ verify: () => { const task = deferred(); tasks.push(task); return task.promise; }, onStatus: value => states.push(value) });
  const old = schedule(config); await Promise.resolve();
  const changed = schedule({ ...config, apiKey: 'replacement' }); await Promise.resolve();
  tasks[0].resolve({ ok: true }); await old; assert.deepEqual(states, [false, false]);
  tasks[1].resolve({ ok: true }); await changed; assert.equal(states.at(-1), true);
  assert.equal(schedule({ ...config, apiKey: 'replacement' }), null);
  const next = schedule({ ...config, model: 'different' }); await Promise.resolve();
  assert.equal(states.at(-1), false); tasks[2].resolve({ ok: false }); await next;
});

test('removed credentials and thrown verification errors remain nonfatal', async () => {
  const states = []; const errors = [];
  const schedule = createAiVerifier({ verify: async () => { throw new Error('unavailable'); }, onStatus: value => states.push(value), onError: message => errors.push(message) });
  await schedule(config); assert.deepEqual(errors, ['unavailable']);
  assert.equal(schedule({ ...config, apiKey: '' }), null); assert.equal(states.at(-1), false);
});

test('Cloudflare returns the response while waitUntil owns the verification task', async t => {
  const original = AIClient.prototype.verify;
  const task = deferred(); const background = [];
  AIClient.prototype.verify = () => task.promise;
  t.after(() => { task.resolve({ ok: false }); AIClient.prototype.verify = original; });
  const response = await worker.fetch(new Request('http://localhost/'), {
    AI_BASE_URL: config.baseURL, AI_API_KEY: config.apiKey, AI_MODEL: config.model, LOG_LEVEL: 'error', USE_BANGUMI_DATA: 'false'
  }, { waitUntil: promise => background.push(promise) });
  assert.equal(response.status, 200); assert.ok(background.length >= 1);
  task.resolve({ ok: true }); await Promise.all(background);
});
