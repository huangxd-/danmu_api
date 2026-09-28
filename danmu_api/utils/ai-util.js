import { httpPost } from "./http-util.js";
import { log } from "./log-util.js";

// =====================
// AI客户端工具
// =====================

const MAX_CHAT_ATTEMPTS = 3;
const MAX_TOKENS_PARAM = 'max_tokens';
const MAX_COMPLETION_TOKENS_PARAM = 'max_completion_tokens';

// 按 baseURL + 模型缓存已确认可用的请求参数，避免每次请求都先触发一次参数错误
const modelParamCache = new Map();

function buildCacheKey(baseURL, model) {
  return `${baseURL}|${model}`;
}

function getApiError(data) {
  if (!data || typeof data !== 'object' || !data.error) return null;
  return data.error;
}

function getApiErrorMessage(data) {
  const error = getApiError(data);
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || '';
}

function getApiErrorText(data) {
  const error = getApiError(data);
  if (!error) return '';
  if (typeof error === 'string') return error.toLowerCase();
  return [error.message, error.code, error.param]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isUnsupportedTokenParam(data, tokenParam) {
  const error = getApiError(data);
  if (!error) return false;
  if (typeof error === 'object' && error.param === tokenParam) return true;

  const text = getApiErrorText(data);
  if (tokenParam === MAX_TOKENS_PARAM) {
    return text.includes(MAX_COMPLETION_TOKENS_PARAM) ||
      (text.includes(MAX_TOKENS_PARAM) && /unsupported|not supported|invalid|unknown/.test(text));
  }
  return /max_completion_tokens.*(unsupported|not supported|invalid|unknown)/.test(text) ||
    /(unsupported|not supported|invalid|unknown).*max_completion_tokens/.test(text);
}

function isUnsupportedTemperature(data) {
  const error = getApiError(data);
  if (!error) return false;
  if (typeof error === 'object' && error.param === 'temperature') return true;

  const text = getApiErrorText(data);
  return text.includes('temperature') &&
    /unsupported|not supported|invalid|unknown|only the default/.test(text);
}

function buildChatBody({ model, messages, tokenParam, maxTokens, temperature, includeTemperature, thinking }) {
  const body = {
    model,
    messages,
    stream: false,
  };
  body[tokenParam] = maxTokens;
  if (includeTemperature) {
    body.temperature = temperature;
  }
  // DeepSeek defaults to thinking mode. Selection/verification can explicitly
  // request final text without spending the output budget on reasoning.
  if (thinking !== undefined && /deepseek/i.test(model)) {
    body.thinking = { type: thinking ? 'enabled' : 'disabled' };
  }
  return body;
}

export default class AIClient {
  constructor({ apiKey, baseURL = 'https://api.openai.com/v1', model = 'gpt-4o', systemPrompt = '' }) {
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.model = model
    this.systemPrompt = systemPrompt
  }

  async chat(messages, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens ?? 8192;
    const temperature = options.temperature ?? 0.0;
    const thinking = options.thinking;
    const cacheKey = buildCacheKey(this.baseURL, model);
    const cachedParams = modelParamCache.get(cacheKey);

    let tokenParam = cachedParams?.tokenParam || MAX_TOKENS_PARAM;
    let includeTemperature = !cachedParams?.omitTemperature;
    let tokenParamSwitched = false;
    let temperatureSwitched = false;

    for (let attempt = 0; attempt < MAX_CHAT_ATTEMPTS; attempt++) {
      const body = buildChatBody({
        model,
        messages,
        tokenParam,
        maxTokens,
        temperature,
        includeTemperature,
        thinking,
      });

      const res = await httpPost(`${this.baseURL}/chat/completions`, JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: 60000,
        validStatusCodes: [400, 422]
      });
      const data = res.data;
      const apiError = getApiError(data);

      if (apiError || res.status >= 400) {
        if (!tokenParamSwitched && isUnsupportedTokenParam(data, tokenParam)) {
          const nextTokenParam = tokenParam === MAX_TOKENS_PARAM
            ? MAX_COMPLETION_TOKENS_PARAM
            : MAX_TOKENS_PARAM;
          log("info", `[system] [ai] 模型 ${model} 不支持 ${tokenParam}，改用 ${nextTokenParam} 重试`);
          tokenParam = nextTokenParam;
          tokenParamSwitched = true;
          continue;
        }

        if (includeTemperature && !temperatureSwitched && isUnsupportedTemperature(data)) {
          log("info", `[system] [ai] 模型 ${model} 不支持自定义 temperature，移除该参数后重试`);
          includeTemperature = false;
          temperatureSwitched = true;
          continue;
        }

        const message = getApiErrorMessage(data)
          || (typeof data === 'string' ? data : 'Unknown error');
        throw new Error(`AI API error ${res.status}: ${message}`);
      }

      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const finishReason = choice?.finish_reason || 'unknown';
        const completionTokens = data?.usage?.completion_tokens ?? 'unknown';
        const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? 'unknown';
        // Report only response metadata; reasoning_content is not a final answer.
        const error = new Error(`AI returned empty final content (finish_reason=${finishReason}, completion_tokens=${completionTokens}, reasoning_tokens=${reasoningTokens})`);
        error.code = 'AI_EMPTY_RESPONSE';
        throw error;
      }
      modelParamCache.set(cacheKey, {
        tokenParam,
        omitTemperature: !includeTemperature,
      });
      return content;
    }
    throw new Error(`AI API error: failed after ${MAX_CHAT_ATTEMPTS} attempts`);
  }

  // 单轮对话快捷方法
  async ask(prompt, options = {}) {
    const messages = []
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })
    return this.chat(messages, options)
  }

  // 多轮对话，自动维护历史
  session(options = {}) {
    const history = []
    const chat = this.chat.bind(this)  // 在这里固定好 this
    const systemPrompt = this.systemPrompt

    if (systemPrompt) {
        history.push({ role: 'system', content: systemPrompt })
    }

    return {
        async send(userMessage) {
            history.push({ role: 'user', content: userMessage })
            const reply = await chat(history, options)  // 直接用 chat，不依赖 this
            history.push({ role: 'assistant', content: reply })
            return reply
        },
        clear() {
            history.length = 0
            if (systemPrompt) {
                history.push({ role: 'system', content: systemPrompt })
            }
        },
        getHistory() {
            return [...history]
        },
    }
  }

  async verify() {
    try {
        const result = await this.ask('Reply with OK only.', { maxTokens: 128, thinking: false })
        return { ok: true, reply: result }
    } catch (err) {
        return { ok: false, error: err.message }
    }
  }
}
