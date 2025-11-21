import { globals } from '../configs/globals.js';
import { log } from './log-util.js'

// =====================
// 请求工具方法
// =====================

export async function httpGet(url, options = {}) {
  // 从 options 中获取重试次数，默认为 0
  const maxRetries = parseInt(options.retries || '0', 10) || 0;
  let lastError;

  // 执行请求，包含重试逻辑
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      log("info", `[请求模拟] 第 ${attempt} 次重试: ${url}`);
      // 可选：添加重试延迟（指数退避）
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 5000)));
    } else {
      log("info", `[请求模拟] HTTP GET: ${url}`);
    }

    // 设置超时时间（默认5秒）
    const timeout = parseInt(globals.vodRequestTimeout || '5000', 10) || 5000;
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
          log("error", "[请求模拟] 解压缩失败", e);
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

      // 请求成功，返回结果
      if (attempt > 0) {
        log("info", `[请求模拟] 重试成功`);
      }

      // 模拟 iOS 环境：返回 { data: ... } 结构
      return {
        data: parsedData,
        status: response.status,
        headers: headers
      };

    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      // 检查是否是超时错误
      if (error.name === 'AbortError') {
        log("error", `[请求模拟] 请求超时:`, error.message);
        log("error", '详细诊断:');
        log("error", '- URL:', url);
        log("error", '- 超时时间:', `${timeout}ms`);
        log("error", `- 当前尝试: ${attempt + 1}/${maxRetries + 1}`);
      } else {
        log("error", `[请求模拟] 请求失败:`, error.message);
        log("error", '详细诊断:');
        log("error", '- URL:', url);
        log("error", '- 错误类型:', error.name);
        log("error", '- 消息:', error.message);
        log("error", `- 当前尝试: ${attempt + 1}/${maxRetries + 1}`);
        if (error.cause) {
          log("error", '- 码:', error.cause.code);
          log("error", '- 原因:', error.cause.message);
        }
      }

      // 如果还有重试机会，继续循环；否则在循环结束后抛出错误
      if (attempt < maxRetries) {
        log("info", `[请求模拟] 准备重试...`);
        continue;
      }
    }
  }

  // 所有重试都失败，抛出最后一个错误
  log("error", `[请求模拟] 所有重试均失败 (${maxRetries + 1} 次尝试)`);
  throw lastError;
}

export async function httpPost(url, body, options = {}) {
  // 从 options 中获取重试次数，默认为 0
  const maxRetries = parseInt(options.retries || '0', 10) || 0;
  let lastError;

  // 执行请求，包含重试逻辑
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      log("info", `[请求模拟] 第 ${attempt} 次重试: ${url}`);
      // 可选：添加重试延迟（指数退避）
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 5000)));
    } else {
      log("info", `[请求模拟] HTTP POST: ${url}`);
    }

    // 设置超时时间（默认5秒）
    const timeout = parseInt(globals.vodRequestTimeout || '5000', 10) || 5000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 处理请求头、body 和其他参数
    const { headers = {}, params, allow_redirects = true } = options;
    const fetchOptions = {
      method: 'POST',
      headers: {
        ...headers,
      },
      body: body,
      signal: controller.signal
    };

    if (!allow_redirects) {
      fetchOptions.redirect = 'manual';  // 禁止重定向
    }

    try {
      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      const data = await response.text();


      if (!response.ok) {
        log("error", `[请求模拟] response data: `, data);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let parsedData;
      try {
        parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
      } catch (e) {
        parsedData = data;  // 如果解析失败，保留原始文本
      }

      // 请求成功，返回结果
      if (attempt > 0) {
        log("info", `[请求模拟] 重试成功`);
      }

      // 模拟 iOS 环境：返回 { data: ... } 结构
      return {
        data: parsedData,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      };

    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      // 检查是否是超时错误
      if (error.name === 'AbortError') {
        log("error", `[请求模拟] 请求超时:`, error.message);
        log("error", '详细诊断:');
        log("error", '- URL:', url);
        log("error", '- 超时时间:', `${timeout}ms`);
        log("error", `- 当前尝试: ${attempt + 1}/${maxRetries + 1}`);
      } else {
        log("error", `[请求模拟] 请求失败:`, error.message);
        log("error", '详细诊断:');
        log("error", '- URL:', url);
        log("error", '- 错误类型:', error.name);
        log("error", '- 消息:', error.message);
        log("error", `- 当前尝试: ${attempt + 1}/${maxRetries + 1}`);
        if (error.cause) {
          log("error", '- 码:', error.cause.code);
          log("error", '- 原因:', error.cause.message);
        }
      }

      // 如果还有重试机会，继续循环；否则在循环结束后抛出错误
      if (attempt < maxRetries) {
        log("info", `[请求模拟] 准备重试...`);
        continue;
      }
    }
  }

  // 所有重试都失败，抛出最后一个错误
  log("error", `[请求模拟] 所有重试均失败 (${maxRetries + 1} 次尝试)`);
  throw lastError;
}

/**
 * 通用 HTTP 请求函数（模拟环境返回结构）
 * @param {string} method - HTTP 方法
 * @param {string} url - 请求地址
 * @param {any} [body] - 请求体（可选）
 * @param {object} [options] - 选项
 * @param {object} [options.headers] - 请求头
 * @param {object} [options.params] - 查询参数（暂未实现）
 * @param {boolean} [options.allow_redirects=true] - 是否允许重定向（暂未实现）
 * @returns {Promise<{data: any, status: number, headers: Record<string, string>}>}
 */
async function httpRequestMethod(method, url, body, options = {}) {
  log("info", `[请求模拟] HTTP ${method}: ${url}`);

  const { headers = {}, params, allow_redirects = true } = options;

  const fetchOptions = {
    method,
    headers: { ...headers },
  };

  // 只有在 body 存在时才设置（DELETE 通常无 body）
  if (body !== undefined && body !== null) {
    fetchOptions.body = body;
  }

  try {
    const response = await fetch(url, fetchOptions);
    const textData = await response.text();

    if (!response.ok) {
      log("error", `[请求模拟] response data: `, textData);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    let parsedData;
    try {
      parsedData = JSON.parse(textData);
    } catch (e) {
      parsedData = textData;
    }

    return {
      data: parsedData,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    log("error", `[请求模拟] 请求失败:`, error.message);
    log("error", '详细诊断:');
    log("error", '- URL:', url);
    log("error", '- 错误类型:', error.name);
    log("error", '- 消息:', error.message);
    if (error.cause) {
      log("error", '- 码:', error.cause?.code);
      log("error", '- 原因:', error.cause?.message);
    }
    throw error;
  }
}

export async function httpPatch(url, body, options = {}) {
  return httpRequestMethod('PATCH', url, body, options);
}

export async function httpPut(url, body, options = {}) {
  return httpRequestMethod('PUT', url, body, options);
}

export async function httpDelete(url, options = {}) {
  return httpRequestMethod('DELETE', url, undefined, options); // DELETE 不传 body
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

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export function xmlResponse(data, status = 200) {
  // 确保 data 是字符串且以 <?xml 开头
  if (typeof data !== 'string' || !data.trim().startsWith('<?xml')) {
    throw new Error('Expected data to be an XML string starting with <?xml');
  }

  // 直接返回 XML 字符串作为 Response 的 body
  return new Response(data, {
    status,
    headers: { 
      "Content-Type": "application/xml",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export function buildQueryString(params) {
  let queryString = '';

  // 遍历 params 对象的每个属性
  for (let key in params) {
    if (params.hasOwnProperty(key)) {
      // 如果 queryString 已经有参数了，则添加 '&'
      if (queryString.length > 0) {
        queryString += '&';
      }

      // 将 key 和 value 使用 encodeURIComponent 编码，并拼接成查询字符串
      queryString += encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }
  }

  return queryString;
}

export function sortedQueryString(params = {}) {
  const normalized = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "boolean") normalized[k] = v ? "true" : "false";
    else if (v == null) normalized[k] = "";
    else normalized[k] = String(v);
  }

  // 获取对象的所有键并排序
  const keys = [];
  for (const key in normalized) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      keys.push(key);
    }
  }
  keys.sort();

  // 构建键值对数组
  const pairs = [];
  for (const key of keys) {
    // 对键和值进行 URL 编码
    const encodedKey = encodeURIComponent(key);
    const encodedValue = encodeURIComponent(normalized[key]);
    pairs.push(`${encodedKey}=${encodedValue}`);
  }

  // 用 & 连接所有键值对
  return pairs.join('&');
}

export function updateQueryString(url, params) {
  // 解析 URL
  let baseUrl = url;
  let queryString = '';
  const hashIndex = url.indexOf('#');
  let hash = '';
  if (hashIndex !== -1) {
    baseUrl = url.substring(0, hashIndex);
    hash = url.substring(hashIndex);
  }
  const queryIndex = baseUrl.indexOf('?');
  if (queryIndex !== -1) {
    queryString = baseUrl.substring(queryIndex + 1);
    baseUrl = baseUrl.substring(0, queryIndex);
  }

  // 解析现有查询字符串为对象
  const queryParams = {};
  if (queryString) {
    const pairs = queryString.split('&');
    for (const pair of pairs) {
      if (pair) {
        const [key, value = ''] = pair.split('=').map(decodeURIComponent);
        queryParams[key] = value;
      }
    }
  }

  // 更新参数
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      queryParams[key] = params[key];
    }
  }

  // 构建新的查询字符串
  const newQuery = [];
  for (const key in queryParams) {
    if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
      newQuery.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`
      );
    }
  }

  // 拼接最终 URL
  return baseUrl + (newQuery.length ? '?' + newQuery.join('&') : '') + hash;
}

export function getPathname(url) {
  // 查找路径的起始位置（跳过协议和主机部分）
  let pathnameStart = url.indexOf('//') + 2;
  if (pathnameStart === 1) pathnameStart = 0; // 如果没有协议部分
  const pathStart = url.indexOf('/', pathnameStart);
  if (pathStart === -1) return '/'; // 如果没有路径，返回默认根路径
  const queryStart = url.indexOf('?', pathStart);
  const hashStart = url.indexOf('#', pathStart);
  // 确定路径的结束位置（查询字符串或片段之前）
  let pathEnd = queryStart !== -1 ? queryStart : (hashStart !== -1 ? hashStart : url.length);
  const pathname = url.substring(pathStart, pathEnd);
  return pathname || '/';
}