// AI 客户端：请求参数兼容性（max_tokens / max_completion_tokens / temperature）

import test from 'node:test';
import assert from 'node:assert/strict';
import AIClient from '../../utils/ai-util.js';
import { Globals } from '../../configs/globals.js';
import { matchAnime } from '../../apis/dandan-api.js';
import { getSourceByKey } from '../../sources/registry.js';
import { withMockFetch } from '../helpers/context.js';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(data),
  };
}

function successResponse(content = 'ok') {
  return jsonResponse({
    choices: [{ message: { content } }],
  });
}

function unsupportedParamError(param, message, code = 'unsupported_parameter') {
  return jsonResponse({
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  }, 400);
}

function captureRequests(handler) {
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return handler(requests.length, requests[requests.length - 1].body);
  };
  return { requests, mockFetch };
}

test('AI 请求默认使用 max_tokens 与 temperature，并支持覆盖参数', async () => {
  const { requests, mockFetch } = captureRequests(() => successResponse());

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-default.example/v1',
      model: 'default-model',
    });
    const reply = await ai.ask('hello');
    assert.strictEqual(reply, 'ok');

    const overridden = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-default.example/v1',
      model: 'default-model',
      systemPrompt: 'be brief',
    });
    await overridden.ask('hi', { model: 'override-model', maxTokens: 123, temperature: 0.7 });
  });

  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].url, 'https://ai-default.example/v1/chat/completions');
  assert.deepStrictEqual(requests[0].body, {
    model: 'default-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    max_tokens: 8192,
    temperature: 0,
  });
  assert.deepStrictEqual(requests[1].body, {
    model: 'override-model',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    stream: false,
    max_tokens: 123,
    temperature: 0.7,
  });
});

test('max_tokens 不被支持时自动改用 max_completion_tokens 并缓存结果', async () => {
  const { requests, mockFetch } = captureRequests((_, body) => {
    if ('max_tokens' in body) {
      return unsupportedParamError(
        'max_tokens',
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      );
    }
    return successResponse('adapted');
  });

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-token.example/v1',
      model: 'token-model',
    });
    assert.strictEqual(await ai.ask('first'), 'adapted');

    const reused = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-token.example/v1',
      model: 'token-model',
    });
    assert.strictEqual(await reused.ask('second'), 'adapted');
  });

  assert.strictEqual(requests.length, 3, '首次探测两次请求，缓存命中后只请求一次');
  assert.strictEqual(requests[0].body.max_tokens, 8192);
  assert.strictEqual(requests[1].body.max_completion_tokens, 8192);
  assert.strictEqual('max_tokens' in requests[1].body, false);
  assert.strictEqual(requests[2].body.max_completion_tokens, 8192);
  assert.strictEqual('max_tokens' in requests[2].body, false);
});

test('temperature 不被支持时移除该字段后重试', async () => {
  const { requests, mockFetch } = captureRequests((_, body) => {
    if ('temperature' in body) {
      return unsupportedParamError(
        'temperature',
        "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
        'unsupported_value',
      );
    }
    return successResponse('no-temperature');
  });

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-temperature.example/v1',
      model: 'temperature-model',
    });
    assert.strictEqual(await ai.ask('hi'), 'no-temperature');
  });

  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].body.temperature, 0);
  assert.strictEqual('temperature' in requests[1].body, false);
});

test('token 参数与 temperature 同时不兼容时最多请求三次', async () => {
  const { requests, mockFetch } = captureRequests((_, body) => {
    if ('max_tokens' in body) {
      return unsupportedParamError(
        'max_tokens',
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      );
    }
    if ('temperature' in body) {
      return unsupportedParamError(
        'temperature',
        'temperature is not supported with this model',
        'unsupported_parameter',
      );
    }
    return successResponse('both-adapted');
  });

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-both.example/v1',
      model: 'both-model',
    });
    assert.strictEqual(await ai.ask('hi'), 'both-adapted');
  });

  assert.strictEqual(requests.length, 3);
  assert.strictEqual('max_tokens' in requests[0].body, true);
  assert.strictEqual(requests[1].body.max_completion_tokens, 8192);
  assert.strictEqual(requests[1].body.temperature, 0);
  assert.strictEqual(requests[2].body.max_completion_tokens, 8192);
  assert.strictEqual('temperature' in requests[2].body, false);
});

test('无关的 400 错误不重试并保留服务端错误消息', async () => {
  const { requests, mockFetch } = captureRequests(() => unsupportedParamError(
    'model',
    'The model `unknown-model` does not exist',
    'model_not_found',
  ));

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-error.example/v1',
      model: 'unknown-model',
    });
    await assert.rejects(
      () => ai.ask('hi'),
      /AI API error 400: The model `unknown-model` does not exist/,
    );
  });

  assert.strictEqual(requests.length, 1);
});

test('400 响应不是 JSON 时仍返回可读错误', async () => {
  const { requests, mockFetch } = captureRequests(() => ({
    ok: false,
    status: 400,
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => 'Bad Request',
  }));

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-plain-error.example/v1',
      model: 'plain-error-model',
    });
    await assert.rejects(() => ai.ask('hi'), /AI API error 400: Bad Request/);
  });

  assert.strictEqual(requests.length, 1);
});

test('verify 在适配后成功，在无法适配时返回真实错误消息', async () => {
  const { mockFetch } = captureRequests((_, body) => {
    if ('max_tokens' in body) {
      return unsupportedParamError(
        'max_tokens',
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      );
    }
    return successResponse();
  });

  await withMockFetch(mockFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-verify.example/v1',
      model: 'verify-model',
    });
    const status = await ai.verify();
    assert.deepStrictEqual(status, { ok: true, reply: 'ok' });
  });

  const { mockFetch: failingFetch } = captureRequests(() => unsupportedParamError(
    'model',
    'The model `missing-model` does not exist',
    'model_not_found',
  ));

  await withMockFetch(failingFetch, async () => {
    const ai = new AIClient({
      apiKey: 'test-key',
      baseURL: 'https://ai-verify-fail.example/v1',
      model: 'missing-model',
    });
    const status = await ai.verify();
    assert.strictEqual(status.ok, false);
    assert.match(status.error, /AI API error 400: The model `missing-model` does not exist/);
  });
});

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
    const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName: 'AI空响应测试 S1E2' }) });
    const response = await (await matchAnime(new URL(req.url), req, '127.0.0.1')).json();
    assert.equal(response.isMatched, true);
    assert.match(response.matches[0].episodeTitle, /第2集/);
    assert.equal(Globals.logBuffer.some(entry => entry.message.includes('Failed to parse AI response')), false);
    assert.equal(Globals.logBuffer.some(entry => entry.message.includes('private reasoning')), false);
    assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });
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
