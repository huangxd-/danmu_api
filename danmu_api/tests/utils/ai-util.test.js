// AI 客户端：请求参数兼容性（max_tokens / max_completion_tokens / temperature）

import test from 'node:test';
import assert from 'node:assert';
import AIClient from '../../utils/ai-util.js';
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
