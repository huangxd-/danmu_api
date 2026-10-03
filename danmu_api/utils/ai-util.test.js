import test from 'node:test';
import assert from 'node:assert/strict';
import AIClient from './ai-util.js';
import { Globals } from '../configs/globals.js';
import { matchAnime } from '../apis/dandan-api.js';
import { getSourceByKey } from '../sources/registry.js';

test('empty AI completion is rejected before JSON matching and normal matching still works', async t => {
  const originalFetch = globalThis.fetch;
  const source = getSourceByKey('tencent');
  const originalSearch = source.search;
  const originalHandle = source.handleAnimes;
  t.after(() => { globalThis.fetch = originalFetch; source.search = originalSearch; source.handleAnimes = originalHandle; });
  Globals.init({ AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'test-key', AI_MODEL: 'deepseek-v4-flash', USE_BANGUMI_DATA: 'false', LOG_LEVEL: 'info' });
  Globals.aiValid = true;
  Globals.envs.sourceOrderArr = ['tencent'];
  Globals.logBuffer = [];
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'private reasoning' }, finish_reason: 'length' }],
    usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } }
    }), { headers: { 'content-type': 'application/json' } });
  };
  const client = new AIClient({ apiKey: 'test-key', baseURL: 'https://ai.example/v1', model: 'deepseek-v4-flash' });
  await t.test('client does not return an unusable blank answer', async () => {
    await assert.rejects(client.ask('select one'), error => {
      assert.equal(error.code, 'AI_EMPTY_RESPONSE');
      assert.match(error.message, /finish_reason=length/);
      assert.match(error.message, /reasoning_tokens=8192/);
      assert.ok(!error.message.includes('private reasoning'));
      return true;
    });
  });
  await t.test('connectivity verification does not report an empty response as usable', async () => {
    assert.equal((await client.verify()).ok, false);
    assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });
    assert.equal(requests.at(-1).max_tokens, 128);
  });
  source.search = async () => [{}];
  source.handleAnimes = async (_data, _title, results, details) => {
    const anime = { animeId: 998001, bangumiId: '998001', animeTitle: 'AI空响应测试', type: 'tvseries', source: 'tencent', episodeCount: 2,
      links: [1, 2].map(i => ({ id: 9980010 + i, title: `【qq】 第${i}集`, url: `https://v.qq.com/x/cover/test/${i}.html` })) };
    results.push(anime); details.set(String(anime.animeId), anime);
  };
  await t.test('match returns the normal match without a misleading JSON parse error', async () => {
    const before = requests.length;
    const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName: 'AI空响应测试 S1E2' }) });
    const response = await (await matchAnime(new URL(req.url), req, '127.0.0.1')).json();
    assert.equal(response.isMatched, true);
    assert.match(response.matches[0].episodeTitle, /第2集/);
    assert.equal(Globals.logBuffer.some(entry => entry.message.includes('Failed to parse AI response')), false);
    assert.equal(Globals.logBuffer.some(entry => entry.message.includes('private reasoning')), false);
    assert.equal(requests.length, before);
  });
});

test('AI response validation preserves final text and keeps DeepSeek options provider-specific', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let payload;
  let response = { choices: [{ message: { content: ' {"animeIndex": 0} ', reasoning_content: 'not the answer' }, finish_reason: 'stop' }] };
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify(response));
  };
  const generic = new AIClient({ apiKey: 'test-key', baseURL: 'https://ai.example/v1', model: 'generic-model' });
  assert.equal(await generic.ask('choose', { thinking: false }), ' {"animeIndex": 0} ');
  assert.equal(Object.hasOwn(payload, 'thinking'), false);
  const deepseek = new AIClient({ apiKey: 'test-key', baseURL: 'https://ai.example/v1', model: 'deepseek-v4-flash' });
  assert.equal((await deepseek.verify()).ok, true);
  assert.deepEqual(payload.thinking, { type: 'disabled' });
  for (const data of [{}, { choices: [] }, { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: ' \n ' } }] }]) {
    response = data;
    await assert.rejects(deepseek.ask('choose'), { code: 'AI_EMPTY_RESPONSE' });
  }
});
