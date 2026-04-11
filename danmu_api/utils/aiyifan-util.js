import { globals } from '../configs/globals.js';
import { log } from "./log-util.js";
import { md5 } from "./codec-util.js";
import { httpGet, updateQueryString } from "./http-util.js";

const DEFAULT_CONFIG_PAGE_URL = "https://www.yfsp.tv/";
const DEFAULT_USER_AGENT = (
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0 Safari/537.36"
);

export const AIYIFAN_SIGNING_CONFIG_TTL_MS = 60 * 1000;

// 安全获取对象属性（替代可选链操作符）
function safeGet(obj, path, defaultValue) {
  if (obj == null) return defaultValue;
  const keys = path.split('.');
  let result = obj;
  for (let i = 0; i < keys.length; i++) {
    if (result == null) return defaultValue;
    // 处理数组索引，如 config[0]
    const key = keys[i];
    const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const arrKey = arrayMatch[1];
      const index = parseInt(arrayMatch[2], 10);
      result = result[arrKey];
      if (Array.isArray(result) && index < result.length) {
        result = result[index];
      } else {
        return defaultValue;
      }
    } else {
      result = result[key];
    }
  }
  return result !== undefined ? result : defaultValue;
}

function extractAssignedObjectLiteral(html, variableName) {
  const assignmentPattern = new RegExp('\\b(?:var|let|const)\\s+' + variableName + '\\s*=\\s*');
  const match = assignmentPattern.exec(html);
  if (!match) {
    return null;
  }

  const objectStart = html.indexOf("{", match.index + match[0].length);
  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = objectStart; i < html.length; i++) {
    const char = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function parseFallbackPConfig(html) {
  const match = html.match(/"pConfig"\s*:\s*\{\s*"publicKey"\s*:\s*"([^"]+)"\s*,\s*"privateKey"\s*:\s*\[(.*?)\]\s*\}/s);
  if (!match) {
    return null;
  }

  let privateKeys = [];
  try {
    privateKeys = JSON.parse('[' + match[2] + ']');
  } catch (e) {
    return null;
  }

  if (!match[1] || !privateKeys.length) {
    return null;
  }

  return {
    publicKey: match[1],
    privateKey: privateKeys[0]
  };
}

export function extractPConfigFromInjectJson(injectJson) {
  // 使用安全获取替代可选链
  const config = safeGet(injectJson, 'config[0]', null);
  const pConfig = config ? config.pConfig : null;
  
  if (!pConfig) return null;
  
  const publicKey = pConfig.publicKey;
  const privateKey = Array.isArray(pConfig.privateKey) ? pConfig.privateKey[0] : pConfig.privateKey;

  if (!publicKey || !privateKey) {
    return null;
  }

  return { publicKey, privateKey };
}

export function extractPConfigFromHtml(html) {
  const objectLiteral = extractAssignedObjectLiteral(html, "injectJson");
  if (objectLiteral) {
    try {
      const injectJson = JSON.parse(objectLiteral);
      const signingConfig = extractPConfigFromInjectJson(injectJson);
      if (signingConfig) {
        return signingConfig;
      }
    } catch (error) {
      log("warn", '[Aiyifan] 解析 injectJson 失败，回退到 pConfig 提取: ' + (error.message || '未知错误'));
    }
  }

  return parseFallbackPConfig(html);
}

function normalizeQueryValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function isSigningParam(key) {
  return key === "vv" || key === "pub";
}

function splitQueryString(queryString) {
  if (!queryString) {
    return [];
  }

  return queryString
    .split("&")
    .filter(Boolean)
    .map(function(pair) {
      const equalsIndex = pair.indexOf("=");
      const rawKey = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
      const rawValue = equalsIndex === -1 ? "" : pair.slice(equalsIndex + 1);
      
      // 手动解码，替代 decodeURIComponent 的异常处理
      function safeDecode(str) {
        try {
          return decodeURIComponent(str.replace(/\+/g, "%20"));
        } catch (e) {
          return str;
        }
      }
      
      const key = safeDecode(rawKey);
      const value = safeDecode(rawValue);
      return [key, value];
    });
}

function getQueryEntries(input) {
  if (!input) {
    return [];
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return [];
    }

    let queryString = trimmed;
    const queryIndex = trimmed.indexOf("?");
    if (queryIndex !== -1) {
      const hashIndex = trimmed.indexOf("#", queryIndex);
      queryString = trimmed.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);
    } else if (trimmed.charAt(0) === "?") {
      queryString = trimmed.slice(1);
    }

    return splitQueryString(queryString);
  }

  // 移除 URLSearchParams 检查，统一按普通对象处理
  if (typeof input === "object" && input !== null) {
    // 如果 input 有 entries 方法且返回数组，使用它
    if (typeof input.entries === "function") {
      try {
        var entries = input.entries();
        if (Array.isArray(entries)) {
          return entries;
        }
        // 处理迭代器情况
        var result = [];
        // 尝试作为 Map 或类似对象处理
        if (typeof input.forEach === "function") {
          input.forEach(function(value, key) {
            result.push([key, normalizeQueryValue(value)]);
          });
          return result.filter(function(item) {
            return item[1] !== null;
          });
        }
      } catch (e) {
        // 失败则回退到 Object.entries
      }
    }
    
    // 标准对象处理
    return Object.keys(input).map(function(key) {
      return [key, normalizeQueryValue(input[key])];
    }).filter(function(item) {
      return item[1] !== null;
    });
  }

  return [];
}

export function buildCanonicalQuery(input) {
  return getQueryEntries(input)
    .filter(function(item) {
      return !isSigningParam(item[0]);
    })
    .map(function(item) {
      return item[0] + "=" + item[1];
    })
    .join("&");
}

export function computeAiyifanVv(input, signingConfig) {
  const query = buildCanonicalQuery(input);
  const raw = signingConfig.publicKey + "&" + query.toLowerCase() + "&" + signingConfig.privateKey;
  return md5(raw);
}

function normalizeJsonPayload(data) {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  return data;
}

function isSignedRequestSuccessful(payload) {
  // 使用安全获取替代可选链
  var ret = safeGet(payload, 'ret', null);
  var code = safeGet(payload, 'data.code', null);
  return ret === 200 && code === 0;
}

function getFailureMessage(payload, status) {
  // 使用安全获取替代可选链
  var msg = safeGet(payload, 'data.msg', null) || safeGet(payload, 'msg', null);
  return msg || ('HTTP ' + status);
}

export class AiyifanSigningProvider {
  constructor(options) {
    options = options || {};
    this.proxyUrlBuilder = options.proxyUrlBuilder || function(url) { 
      return globals.makeProxyUrl(url); 
    };
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.configPageUrl = options.configPageUrl || DEFAULT_CONFIG_PAGE_URL;
    this.ttlMs = options.ttlMs || AIYIFAN_SIGNING_CONFIG_TTL_MS;
    this.now = options.now || function() { return Date.now(); };
    this.signingConfig = null;
    this.signingConfigFetchedAt = 0;
  }

  async getSigningConfig(forceRefresh) {
    forceRefresh = forceRefresh || false;
    var now = this.now();
    var cacheValid = this.signingConfig && (now - this.signingConfigFetchedAt) < this.ttlMs;

    if (!forceRefresh && cacheValid) {
      return this.signingConfig;
    }

    var response = await httpGet(this.proxyUrlBuilder(this.configPageUrl), {
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    var html = typeof response.data === "string" ? response.data : String(response.data || "");
    var signingConfig = extractPConfigFromHtml(html);
    if (!signingConfig) {
      throw new Error("未能从桌面站页面解析到 pConfig");
    }

    this.signingConfig = signingConfig;
    this.signingConfigFetchedAt = now;
    log("info", '[Aiyifan] 已更新桌面站签名配置: ' + signingConfig.publicKey.slice(0, 12) + '...');
    return signingConfig;
  }

  buildSignedParams(baseParams, signingConfig) {
    var result = {};
    // 手动复制对象，替代展开运算符
    for (var key in baseParams) {
      if (baseParams.hasOwnProperty(key)) {
        result[key] = baseParams[key];
      }
    }
    result.vv = computeAiyifanVv(baseParams, signingConfig);
    result.pub = signingConfig.publicKey;
    return result;
  }

  async signedGetJson(api, baseParams, headers, logPrefix, forceRefresh) {
    headers = headers || {};
    logPrefix = logPrefix || "Aiyifan";
    forceRefresh = forceRefresh || false;
    
    var signingConfig = await this.getSigningConfig(forceRefresh);
    var signedParams = this.buildSignedParams(baseParams, signingConfig);
    var requestUrl = updateQueryString(api, signedParams);
    var response = await httpGet(this.proxyUrlBuilder(requestUrl), { headers: headers });

    var payload;
    try {
      payload = normalizeJsonPayload(response.data);
    } catch (error) {
      if (!forceRefresh) {
        log("warn", '[' + logPrefix + '] 响应无法解析为 JSON，刷新签名配置后重试: ' + (error.message || '未知错误'));
        return this.signedGetJson(api, baseParams, headers, logPrefix, true);
      }
      throw error;
    }

    // 安全获取状态码，如果不存在则默认为200
    var statusCode = response.status != null ? response.status : 200;
    if (statusCode !== 200 || !isSignedRequestSuccessful(payload)) {
      if (!forceRefresh) {
        log("warn", '[' + logPrefix + '] 当前签名请求失败，刷新 pConfig 后重试: ' + getFailureMessage(payload, statusCode));
        return this.signedGetJson(api, baseParams, headers, logPrefix, true);
      }
      throw new Error(getFailureMessage(payload, statusCode));
    }

    return {
      data: payload,
      vv: signedParams.vv,
      signingConfig: signingConfig
    };
  }
}