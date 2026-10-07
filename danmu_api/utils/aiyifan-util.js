import { globals } from '../configs/globals.js';
import { log } from "./log-util.js";
import { md5 } from "./codec-util.js";
import { httpGet, httpPost } from "./http-util.js";

// =====================
// 爱壹帆 App 链路签名工具
// =====================
// 逆向自 1.7.8 安装包（com.ppde.ppcd）的 OkHttp 拦截器
// （com/ppde/library/network/e.smali、d.smali）：
//   1. App 启动后先请求 GET https://api.tripdata.app/api/home/config，
//      该引导请求用内置私钥签名（x-pub 为空），返回 data.list.pConfig：
//      { publicKey, privateKey: ["..."] }；
//   2. 之后所有 App 接口都带三个请求头：
//        x-timestamp：秒级时间戳
//        x-pub：pConfig.publicKey
//        x-sign：MD5(query + x-timestamp + pConfig.privateKey[0])
//      query 为 URL 中 "?" 之后的部分；请求本身没有 query 时会先补
//      _t=<x-timestamp> 再参与签名（POST 请求即属于这种情况）。
//   3. 服务端当前对签名校验很宽松，但这里仍完全按 App 算法实现，
//      避免服务端以后收紧校验导致失效。

export const AIYIFAN_APP_BASE_URL = "https://api.tripdata.app/";
export const AIYIFAN_APP_CONFIG_API = "api/home/config";
export const AIYIFAN_APP_CONFIG_TTL_MS = 30 * 60 * 1000;
export const AIYIFAN_APP_DEFAULT_PRIVATE_KEY = "57688*1-331@";
export const AIYIFAN_APP_USER_AGENT = "okhttp-okgo/jeasonlzy";
export const AIYIFAN_APP_BUNDLE_ID = "com.cqcsy.ifvod";
export const AIYIFAN_APP_VERSION = "1.7.8";

export function computeAiyifanAppSign(query, timestamp, privateKey) {
  return md5(query + timestamp + privateKey);
}

function normalizeJsonPayload(data) {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  return data;
}

function isAppRequestSuccessful(payload) {
  return !!payload && payload.ret === 200;
}

function getFailureMessage(payload, status) {
  const msg = payload && (payload.msg || (payload.data && payload.data.msg));
  return msg || ('HTTP ' + status);
}

export class AiyifanAppSigningProvider {
  constructor(options) {
    options = options || {};
    this.baseUrl = options.baseUrl || AIYIFAN_APP_BASE_URL;
    this.configUrl = options.configUrl || (this.baseUrl + AIYIFAN_APP_CONFIG_API);
    this.proxyUrlBuilder = options.proxyUrlBuilder || function(url) {
      return globals.makeProxyUrl(url);
    };
    this.userAgent = options.userAgent || AIYIFAN_APP_USER_AGENT;
    this.version = options.version || AIYIFAN_APP_VERSION;
    this.deviceId = options.deviceId || "2da4a414036a4332782795a031dcab6b4";
    this.deviceInfo = options.deviceInfo || "Xiaomi 23127PN0CC";
    this.ttlMs = options.ttlMs || AIYIFAN_APP_CONFIG_TTL_MS;
    this.timeoutMs = options.timeoutMs || 10000;
    this.now = options.now || function() { return Date.now(); };
    this.signingConfig = null;
    this.signingConfigFetchedAt = 0;
    this.inflightConfigRequest = null;
  }

  // App 固定请求头（okhttp-okgo 默认头 + 设备信息）
  buildCommonHeaders() {
    return {
      "User-Agent": this.userAgent,
      "Accept-Language": "zh-CN,zh;q=0.8",
      "Lat": "0.0",
      "Lng": "0.0",
      "BundleId": AIYIFAN_APP_BUNDLE_ID,
      "AppVersion": this.version,
      "System": "Android",
      "SystemVersion": "17",
      "DeviceInfo": this.deviceInfo,
      "DeviceId": this.deviceId,
      "Version": "V3",
      "Lang": "0"
    };
  }

  buildSignedHeaders(query, timestamp, signingConfig) {
    const headers = this.buildCommonHeaders();
    headers["x-timestamp"] = String(timestamp);
    headers["x-pub"] = signingConfig.publicKey;
    headers["x-sign"] = computeAiyifanAppSign(query, timestamp, signingConfig.privateKey);
    return headers;
  }

  // 获取（并缓存）pConfig 签名配置；并发请求会合并到同一个请求上
  async getSigningConfig(forceRefresh) {
    forceRefresh = forceRefresh || false;
    if (this.inflightConfigRequest) {
      return await this.inflightConfigRequest;
    }

    const now = this.now();
    const cacheValid = this.signingConfig && (now - this.signingConfigFetchedAt) < this.ttlMs;
    if (!forceRefresh && cacheValid) {
      return this.signingConfig;
    }

    const task = this.fetchSigningConfig();
    this.inflightConfigRequest = task;
    try {
      return await task;
    } finally {
      this.inflightConfigRequest = null;
    }
  }

  async fetchSigningConfig() {
    const timestamp = Math.floor(this.now() / 1000);
    const query = "_t=" + timestamp;
    const headers = this.buildCommonHeaders();
    headers["x-timestamp"] = String(timestamp);
    headers["x-pub"] = "";
    headers["x-sign"] = computeAiyifanAppSign(query, timestamp, AIYIFAN_APP_DEFAULT_PRIVATE_KEY);

    const response = await httpGet(this.proxyUrlBuilder(this.configUrl + "?" + query), {
      headers: headers,
      timeout: this.timeoutMs,
      retries: 2,
      // 配置已有 TTL 缓存和并发合并；实际获取时绕过请求内缓存，避免同秒刷新复用旧配置。
      bypassCache: true
    });

    const payload = normalizeJsonPayload(response.data);
    const pConfig = payload?.data?.list?.pConfig;
    const publicKey = pConfig?.publicKey;
    const privateKeyList = pConfig?.privateKey;
    const privateKey = Array.isArray(privateKeyList) ? privateKeyList[0] : privateKeyList;

    if (!publicKey || !privateKey) {
      throw new Error("未能从 App 配置接口(/api/home/config)获取 pConfig");
    }

    this.signingConfig = { publicKey: publicKey, privateKey: privateKey };
    this.signingConfigFetchedAt = this.now();
    log("info", '[system] [aiyifan] 已更新 App 签名配置: ' + publicKey.slice(0, 12) + '...');
    return this.signingConfig;
  }

  // 按 App 规则拼签名 query：GET 用原始参数，POST 用 _t 时间戳
  buildSignQuery(method, params, timestamp) {
    if (method === 'POST') {
      return "_t=" + timestamp;
    }
    const entries = [];
    for (const key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        continue;
      }
      const value = params[key];
      if (value === undefined || value === null) {
        continue;
      }
      entries.push(key + "=" + value);
    }
    return entries.length ? entries.join("&") : "_t=" + timestamp;
  }

  async signedRequest(method, api, params, body, logPrefix, forceRefresh) {
    const signingConfig = await this.getSigningConfig(forceRefresh);
    const timestamp = Math.floor(this.now() / 1000);
    const query = this.buildSignQuery(method, params, timestamp);
    const headers = this.buildSignedHeaders(query, timestamp, signingConfig);
    const requestUrl = this.proxyUrlBuilder(api + "?" + query);

    let payload;
    let statusCode = 200;
    try {
      if (method === 'POST') {
        headers["Content-Type"] = "application/json;charset=utf-8";
        const response = await httpPost(requestUrl, JSON.stringify(body), { headers: headers, timeout: this.timeoutMs, retries: 2 });
        statusCode = response.status != null ? response.status : 200;
        payload = normalizeJsonPayload(response.data);
      } else {
        const response = await httpGet(requestUrl, {
          headers: headers,
          timeout: this.timeoutMs,
          retries: 2,
          // 签名更新后 URL 可能相同，重试必须重新发送请求。
          bypassCache: forceRefresh
        });
        statusCode = response.status != null ? response.status : 200;
        payload = normalizeJsonPayload(response.data);
      }
    } catch (error) {
      if (!forceRefresh) {
        log("warn", '[' + logPrefix + '] 请求异常，刷新 App 签名配置后重试: ' + (error.message || '未知错误'));
        return await this.signedRequest(method, api, params, body, logPrefix, true);
      }
      throw error;
    }

    if (statusCode !== 200 || !isAppRequestSuccessful(payload)) {
      if (!forceRefresh) {
        log("warn", '[' + logPrefix + '] 当前签名请求失败，刷新 App 签名配置后重试: ' + getFailureMessage(payload, statusCode));
        return await this.signedRequest(method, api, params, body, logPrefix, true);
      }
      throw new Error(getFailureMessage(payload, statusCode));
    }

    return {
      data: payload,
      signingConfig: signingConfig
    };
  }

  async signedGetJson(api, params, logPrefix, forceRefresh) {
    logPrefix = logPrefix || "Aiyifan";
    forceRefresh = forceRefresh || false;
    return await this.signedRequest('GET', api, params || {}, null, logPrefix, forceRefresh);
  }

  async signedPostJson(api, body, logPrefix, forceRefresh) {
    logPrefix = logPrefix || "Aiyifan";
    forceRefresh = forceRefresh || false;
    return await this.signedRequest('POST', api, null, body, logPrefix, forceRefresh);
  }
}
