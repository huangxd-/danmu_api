import { globals } from '../configs/globals.js';
import { log } from './log-util.js'

// =====================
// 请求工具方法
// =====================

export async function httpGet(url, options) {

  log("info", `[请求模拟] HTTP GET: ${url}`);

  // 设置超时时间（默认5秒）
  const timeout = parseInt(globals.vodRequestTimeout);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...options.headers,
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    let data;

    if (options.base64Data) {
      log("info", "base64模式");

      // 先拿二进制
      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 转换为 Base64
      let binary = '';
      const chunkSize = 0x8000; // 分块防止大文件卡死
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        let chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      data = btoa(binary); // 得到 base64 字符串

    } else if (options.zlibMode) {
      log("info", "zlib模式")

      // 获取 ArrayBuffer
      const arrayBuffer = await response.arrayBuffer();

      // 使用 DecompressionStream 进行解压
      // "deflate" 对应 zlib 的 inflate
      const decompressionStream = new DecompressionStream("deflate");
      const decompressedStream = new Response(
        new Blob([arrayBuffer]).stream().pipeThrough(decompressionStream)
      );

      // 读取解压后的文本
      let decodedData;
      try {
        decodedData = await decompressedStream.text();
      } catch (e) {
        log("error", "[iOS模拟] 解压缩失败", e);
        throw e;
      }

      data = decodedData; // 更新解压后的数据
    } else {
      data = await response.text();
    }

    let parsedData;
    try {
      parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
    } catch (e) {
      parsedData = data;  // 如果解析失败，保留原始文本
    }

    // 获取所有 headers，但特别处理 set-cookie
    const headers = {};
    let setCookieValues = [];

    // 遍历 headers 条目
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        setCookieValues.push(value);
      } else {
        headers[key] = value;
      }
    }

    // 如果存在 set-cookie 头，将其合并为分号分隔的字符串
    if (setCookieValues.length > 0) {
      headers['set-cookie'] = setCookieValues.join(';');
    }
    // 模拟 iOS 环境：返回 { data: ... } 结构
    return {
      data: parsedData,
      status: response.status,
      headers: headers
    };

  } catch (error) {
    clearTimeout(timeoutId);

    // 检查是否是超时错误
    if (error.name === 'AbortError') {
      log("error", `[iOS模拟] 请求超时:`, error.message);
      log("error", '详细诊断:');
      log("error", '- URL:', url);
      log("error", '- 超时时间:', `${timeout}ms`);
      throw new Error(`Request timeout after ${timeout}ms`);
    }

    log("error", `[iOS模拟] 请求失败:`, error.message);
    log("error", '详细诊断:');
    log("error", '- URL:', url);
    log("error", '- 错误类型:', error.name);
    log("error", '- 消息:', error.message);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
    throw error;
  }
}

export async function httpPost(url, body, options = {}) {
  log("info", `[请求模拟] HTTP POST: ${url}`);

  // 处理请求头、body 和其他参数
  const { headers = {}, params, allow_redirects = true } = options;
  const fetchOptions = {
    method: 'POST',
    headers: {
      ...headers,
    },
    body: body
  };

  if (!allow_redirects) {
    fetchOptions.redirect = 'manual';  // 禁止重定向
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    let parsedData;
    try {
      parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
    } catch (e) {
      parsedData = data;  // 如果解析失败，保留原始文本
    }

    // 模拟 iOS 环境：返回 { data: ... } 结构
    return {
      data: parsedData,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    };

  } catch (error) {
    log("error", `[iOS模拟] 请求失败:`, error.message);
    log("error", '详细诊断:');
    log("error", '- URL:', url);
    log("error", '- 错误类型:', error.name);
    log("error", '- 消息:', error.message);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
    throw error;
  }
}

export async function getPageTitle(url) {
  try {
    // 使用 httpGet 获取网页内容
    const response = await httpGet(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });

    // response.data 包含 HTML 内容
    const html = response.data;

    // 方法1: 使用正则表达式提取 <title> 标签
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      // 解码 HTML 实体（如 &nbsp; &amp; 等）
      const title = titleMatch[1]
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      return title;
    }

    // 如果没找到 title 标签
    return url;

  } catch (error) {
    log("error", `获取标题失败: ${error.message}`);
    return url;
  }
}