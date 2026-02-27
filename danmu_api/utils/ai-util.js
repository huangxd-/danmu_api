import { httpPost } from "./http-util.js";

export default class AIClient {
  constructor({ apiKey, baseURL = 'https://api.openai.com/v1', model = 'gpt-4o', systemPrompt = '' }) {
    this.apiKey = apiKey
    this.baseURL = baseURL.replace(/\/$/, '')
    this.model = model
    this.systemPrompt = systemPrompt
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature ?? 0.0,
      max_tokens: options.maxTokens ?? 8192,
      stream: false,
    }

    const res = await httpPost(`${this.baseURL}/chat/completions`, JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      timeout: 60000
    });
    const data = res.data;

    if (data?.error) {
      const err = data.error.message
      throw new Error(`AI API error ${res.status}: ${err}`)
    }

    return data.choices[0].message.content;
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
        const result = await this.ask('hi', { maxTokens: 1 })
        return { ok: true, reply: result }
    } catch (err) {
        return { ok: false, error: err.message }
    }
  }
}