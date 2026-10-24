import { log } from './log-util.js';
import { httpGet } from './http-util.js';
import { globals } from '../configs/globals.js';

// =====================
// Animeko 镜像域名工具（镜像发布页 https://bangumi.wiki）
// =====================

// 镜像域名发布页公开接口，按分类返回可用镜像域名及其权重
const MIRROR_PUBLISH_API = 'https://bangumi.wiki/api/v1/mirrors';

// 请求发布页时使用的客户端标识
const MIRROR_PUBLISH_USER_AGENT = `huangxd-/danmu_api/${globals.version}(https://github.com/huangxd-/danmu_api)`;

// 内置镜像 API 基础域名，提供与官方一致的 /v0 接口
export const BUILTIN_MIRROR_API_BASE = 'https://api.bangumi.lat';

// 镜像请求失败后从发布页获取的备用域名数量上限
export const MAX_MIRROR_FALLBACK_HOSTS = 2;

// 发布页域名列表的缓存有效期：10 分钟
const MIRROR_HOSTS_CACHE_TTL = 10 * 60 * 1000;

// 模块级状态仅在进程内有效：边缘函数实例被驱逐重建后重新获取
let mirrorHostsCache = null; // 发布页解析结果缓存，内容为按权重降序排列的 API 域名列表
let currentMirrorBase = BUILTIN_MIRROR_API_BASE; // 当前使用的镜像基础域名
let mirrorHostsRequestPromise = null; // 发布页请求并发锁：缓存未命中时多个请求共享同一在途请求，避免重复请求发布页

/**
 * 重置镜像域名缓存、当前使用的镜像域名与在途发布页请求
 * 供测试用例隔离模块级状态
 */
export function resetMirrorState() {
  mirrorHostsCache = null;
  currentMirrorBase = BUILTIN_MIRROR_API_BASE;
  mirrorHostsRequestPromise = null;
}

/**
 * 提取 URL 中的主机名
 * @param {string} url 完整 URL
 * @returns {string} 主机名，解析失败时返回空字符串
 */
export function extractHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * 校验字符串是否为合法的主机名
 * 仅接受由小写字母、数字、连字符组成的多层级域名标签，拒绝协议、路径、端口与 IP 字面量等非域名内容
 * @param {string} host 主机名
 * @returns {boolean} 是否为合法主机名
 */
export function isValidHostname(host) {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/**
 * 从发布页响应中提取 API 域名候选
 * 按权重降序排列，权重相同时推荐域名优先，同一域名只保留一次
 * @param {Object} payload 发布页响应
 * @returns {Array<string>} 域名列表
 */
export function parseMirrorApiHosts(payload) {
  const mirrors = Array.isArray(payload?.mirrors) ? payload.mirrors : [];
  const candidates = [];

  for (const mirror of mirrors) {
    const weight = Number(mirror?.weight) || 0;
    const recommended = mirror?.recommended === true;
    const services = Array.isArray(mirror?.services) ? mirror.services : [];

    for (const service of services) {
      if (service?.id !== 'api') continue;
      const hosts = Array.isArray(service.hosts) ? service.hosts : [];

      for (const host of hosts) {
        if (typeof host !== 'string') continue;
        const normalized = host.trim().toLowerCase();
        if (!isValidHostname(normalized)) continue;
        candidates.push({ host: normalized, weight, recommended });
      }
    }
  }

  candidates.sort((a, b) => (b.weight - a.weight) || (Number(b.recommended) - Number(a.recommended)));

  const seen = new Set();
  const hosts = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.host)) continue;
    seen.add(candidate.host);
    hosts.push(candidate.host);
  }
  return hosts;
}

/**
 * 读取发布页数据，读取结果在有效期内复用
 * 并发请求未命中缓存时共享同一在途请求，避免重复请求发布页
 * @returns {Promise<Array<string>>} 按权重降序排列的 API 域名列表
 */
async function loadMirrorHosts() {
  const now = Date.now();
  if (mirrorHostsCache && now - mirrorHostsCache.timestamp < MIRROR_HOSTS_CACHE_TTL) {
    return mirrorHostsCache.hosts;
  }

  if (mirrorHostsRequestPromise) return mirrorHostsRequestPromise;

  mirrorHostsRequestPromise = (async () => {
    try {
      const resp = await httpGet(MIRROR_PUBLISH_API, {
        headers: { 'User-Agent': MIRROR_PUBLISH_USER_AGENT },
        timeout: 5000
      });
      const hosts = parseMirrorApiHosts(resp.data);
      mirrorHostsCache = { timestamp: now, hosts };

      if (hosts.length === 0) {
        log("warn", '[animeko] [mirror] 镜像发布页未返回可用的 API 域名');
        return hosts;
      }

      log("info", `[animeko] [mirror] 镜像发布页返回 ${hosts.length} 个 API 域名`);
      return hosts;
    } catch (error) {
      log("warn", `[animeko] [mirror] 镜像发布页请求失败: ${error.message}`);
      return [];
    }
  })();
  mirrorHostsRequestPromise.finally(() => { mirrorHostsRequestPromise = null; });
  return mirrorHostsRequestPromise;
}

/**
 * 获取当前使用的镜像基础域名
 * @returns {string} 镜像基础域名
 */
export function getCurrentMirrorBase() {
  return currentMirrorBase;
}

/**
 * 获取备用镜像 API 域名
 * 排除指定域名后按权重降序返回，数量受 MAX_MIRROR_FALLBACK_HOSTS 限制
 * @param {Array<string>} excludeHosts 需要排除的域名
 * @returns {Promise<Array<string>>} 备用域名列表
 */
export async function fetchMirrorFallbackHosts(excludeHosts = []) {
  const excluded = new Set(excludeHosts.map(host => host.toLowerCase()));
  const hosts = await loadMirrorHosts();
  return hosts.filter(host => !excluded.has(host)).slice(0, MAX_MIRROR_FALLBACK_HOSTS);
}

/**
 * 以指定镜像基础域名执行一次请求
 * @param {string} base 镜像基础域名
 * @param {(base: string) => Promise<any>} attempt 请求执行器
 * @returns {Promise<any>} 请求结果，失败时返回 null
 */
async function attemptMirrorBase(base, attempt) {
  try {
    const result = await attempt(base);
    if (result) return result;
    log("info", `[animeko] [mirror] 镜像域名 ${base} 未返回可用数据`);
  } catch (error) {
    log("warn", `[animeko] [mirror] 镜像域名 ${base} 请求失败: ${error.message}`);
  }
  return null;
}

/**
 * 依次尝试镜像域名执行请求
 * 当前镜像域名失败后从发布页获取备用域名重试，成功后该域名成为当前使用的镜像域名
 * @param {(base: string) => Promise<any>} attempt 以指定镜像基础域名执行请求，返回假值表示该域名不可用
 * @returns {Promise<{base: string, result: any}|null>} 成功时的镜像基础域名与请求结果，全部失败时返回 null
 */
export async function requestMirror(attempt) {
  const currentBase = getCurrentMirrorBase();
  const currentResult = await attemptMirrorBase(currentBase, attempt);
  if (currentResult) {
    return { base: currentBase, result: currentResult };
  }

  const fallbackHosts = await fetchMirrorFallbackHosts([extractHost(currentBase)]);
  for (const host of fallbackHosts) {
    const fallbackBase = `https://${host}`;
    const result = await attemptMirrorBase(fallbackBase, attempt);
    if (result) {
      log("info", `[animeko] [mirror] 切换至镜像域名 ${fallbackBase}`);
      currentMirrorBase = fallbackBase;
      return { base: fallbackBase, result };
    }
  }

  return null;
}
