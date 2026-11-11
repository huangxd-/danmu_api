// OpenAI 兼容接口的最小客户端：只服务于自动匹配的 AI 兜底判定。
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_TIMEOUT_MS = 20000;

function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

// 模型可能把 JSON 包在代码块或说明文字里，这里只取第一个完整的 JSON 对象。
export function extractJsonObject(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 调用 OpenAI 兼容的 /chat/completions，返回助手文本内容。
 * 新版模型不接受 max_tokens / temperature 时，按报错调整一次参数后重试。
 */
export async function askAi({ baseUrl, apiKey, model, messages, maxTokens = 700, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('缺少 AI API Key');
  const body = { model: model || DEFAULT_MODEL, messages, temperature: 0, max_tokens: maxTokens };
  const send = async () => {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { response, text: await response.text() };
  };

  let result = await send();
  if (!result.response.ok) {
    if (/max_completion_tokens/.test(result.text)) {
      delete body.max_tokens;
      body.max_completion_tokens = maxTokens;
    } else if (/temperature/.test(result.text)) {
      delete body.temperature;
    } else {
      throw new Error(`AI 请求失败 ${result.response.status}: ${result.text.slice(0, 200)}`);
    }
    result = await send();
    if (!result.response.ok) throw new Error(`AI 请求失败 ${result.response.status}: ${result.text.slice(0, 200)}`);
  }

  const data = JSON.parse(result.text);
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回内容为空');
  return content;
}
