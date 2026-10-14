import BaseSource from "./base.js";
import { globals } from "../configs/globals.js";
import { log } from "../utils/log-util.js";
import { httpGet, httpPost, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum, md5, stringToUtf8Bytes } from "../utils/codec-util.js";
import {
  addAnime,
  readCacheFromFile,
  writeCacheToFile,
} from "../utils/cache-util.js";
import { getLocalRedisKey, setLocalRedisKey } from "../utils/local-redis-util.js";
import { getRedisKey, setRedisKey } from "../utils/redis-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from "../models/dandan-model.js";

import {
  COMMENT_WINDOW_MS, MIN_IDENTITY_SAMPLE,
  createHongguoIdentity, maskHongguoIdentity, parseHongguoIdentity, isQualityDelivery,
  signHongguoRequest, createHongguoEpisodeId, parseHongguoEpisodeId,
  createHongguoSeriesId, parseHongguoSeriesId, isHongguoSeriesId, parseHongguoPlayerUrl,
  parseWebSearchResults, parseSearchSuggestions, parseWebPlayerDuration,
  parseHongguoResponse, parseApiEpisodeDetails, parseWebEpisodeDetails,
  positiveDuration, parseSearchCell, parseDeclaredCount,
  parseCommentWindow, dedupeDanmus, getFragmentNumber,
} from "../utils/hongguo-util.js";

// 读取顺序：云端 Upstash → 本地 Redis → 文件（.cache）；各后端独立容错，失败即跳过。
async function readPersistedIdentity() {
  try {
    if (globals.redisUrl && globals.redisToken) {
      const identity = parseHongguoIdentity(await getRedisKey(COMMENT_IDENTITY_CACHE_KEY));
      if (identity) return identity;
    }
  } catch {
    // 单后端失败不影响其他后端
  }
  try {
    if (globals.localRedisUrl) {
      const identity = parseHongguoIdentity(await getLocalRedisKey(COMMENT_IDENTITY_CACHE_KEY));
      if (identity) return identity;
    }
  } catch {
    // 同上
  }
  try {
    const identity = globals.localCacheEnabled === false
      ? null
      : parseHongguoIdentity(readCacheFromFile(COMMENT_IDENTITY_CACHE_KEY));
    if (identity) return identity;
  } catch {
    // 同上
  }
  return null;
}

// 写入所有可用后端（文件 / 本地 Redis / Upstash），返回成功的后端名列表；都失败则本次仅内存复用。
async function persistHongguoIdentity(identity) {
  const saved = [];
  try {
    if (writeCacheToFile(COMMENT_IDENTITY_CACHE_KEY, identity, { force: true })) saved.push("file");
  } catch {
    // ignore
  }
  try {
    if (globals.localRedisUrl) {
      const result = await setLocalRedisKey(COMMENT_IDENTITY_CACHE_KEY, identity);
      if (result && result.result === "OK") saved.push("localRedis");
    }
  } catch {
    // ignore
  }
  try {
    if (globals.redisUrl && globals.redisToken) {
      const result = await setRedisKey(COMMENT_IDENTITY_CACHE_KEY, identity);
      if (result && result.result === "OK") saved.push("upstash");
    }
  } catch {
    // ignore
  }
  return saved;
}

const CLIENT_CONFIG = {
  // api5-normal-lf / api5-normal-lq / api5-normal-hl 为降级节点：
  // 实测任何设备身份（含优质身份）在它们上都只下发 7 条/窗口，直接移除不再使用。
  apiHosts: Object.freeze([
    "api5-normal-sinfonlinea.fqnovel.com",
    "api5-normal-sinfonlinec.fqnovel.com",
    "api5-normal-sinfonlineb.fqnovel.com",
  ]),
  baseQuery: {
    channel: "huawei_8662_64",
    device_type: "V2284A",
    aid: "8662",
    app_name: "novelread",
    version_code: "72932",
    version_name: "7.2.9.32",
    device_platform: "android",
    ac: "wifi",
    os: "android",
    ssmix: "a",
    device_brand: "vivo",
    language: "zh",
    os_api: "32",
    os_version: "12",
    manifest_version_code: "72932",
    resolution: "1080*1920",
    dpi: "280",
    update_version_code: "72932",
    host_abi: "arm64-v8a",
    dragon_device_type: "phone",
    pv_player: "72932",
    compliance_status: "0",
    need_personal_recommend: "1",
    player_so_load: "1",
    is_android_pad_screen: "1",
    rom_version: "V417IR+release-keys",
  },
  headers: {
    "user-agent": "com.phoenix.read/72932 (Linux; U; Android 12; zh_CN; V2284A; Build/V417IR;tt-ok/3.12.13.20)",
    "x-tt-store-region": "cn-zj",
    "x-tt-store-region-src": "did",
    "passport-sdk-version": "5051452",
    "sdk-version": "2",
  },
};

const WEB_ORIGIN = "https://hongguoduanju.com";

const COMMENT_SOURCE = 601;
const SERVER_CHANNEL = 1000;
const COMMENT_COUNT = 500;
const COMMENT_CONCURRENCY = 8;
// 两类请求分别节流；遇冷却翻倍退避，连续成功后逐档恢复。
const COMMENT_THROTTLE_MS = 30;
const COMMENT_THROTTLE_JITTER_MS = 30;
const THROTTLE_MAX_BACKOFF = 8;
const THROTTLE_RECOVER_STREAK = 10;
// 设备身份探测：含持久化身份最多四组，达到优质线即提前停止，否则复用本轮最佳身份。
const COMMENT_IDENTITY_CACHE_KEY = "hongguo_identity";
const COMMENT_IDENTITY_CANDIDATES = 4;
// 探测请求之间的额外间隔（避免连续拨打触发风控）与连续失败上限（提前收手，保住已有的最优身份）
const COMMENT_IDENTITY_PROBE_INTERVAL_MS = 600;
const COMMENT_IDENTITY_PROBE_JITTER_MS = 300;
const COMMENT_IDENTITY_PROBE_MAX_FAILURES = 2;
const COMMENT_IDENTITY_RETRY_MS = 30_000;
const COMMENT_IDENTITY_MAX_RETRY_MS = 300_000;
// 未知时长的抓取、裁剪、分段和全集偏移统一使用三分钟；不写入真实时长缓存。
const EPISODE_FALLBACK_DURATION_SECONDS = 180;
const DURATION_LOOKUP_CONCURRENCY = 3;
const DURATION_FAILURE_TTL_MS = 30_000;
const DETAIL_CACHE_TTL_MS = 120_000;
const DETAIL_FAILURE_TTL_MS = 30_000;
const DETAIL_LOOKUP_TIMEOUT_MS = 6000;
const PLAYER_LOOKUP_TIMEOUT_MS = 2000;
const DETAIL_CACHE_MAX_ITEMS = 100;
const DURATION_FAILURE_MAX_ITEMS = 1000;
const METADATA_THROTTLE_MS = 100;
const METADATA_THROTTLE_JITTER_MS = 51;
const MAX_SEARCH_ITEMS = 20;
const SEARCH_SUGGESTION_COUNT = 50;
const SEARCH_SUGGESTION_TIMEOUT_MS = 2000;
const SEARCH_DETAIL_CONCURRENCY = 3;
const SEARCH_DETAIL_BUDGET_MS = 8000;
const IMAGE_SHRINK =
  "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1h\n" +
  "Z2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d\n";

function checkAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("已取消", "AbortError");
}

function waitWithSignal(task, signal) {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason || new DOMException("已取消", "AbortError"));
    };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function sleep(milliseconds, signal) {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || new DOMException("已取消", "AbortError"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

// httpGet 自身的超时只覆盖响应头；外部信号同时限制正文读取和调用方等待。
async function boundedHttpGet(url, options = {}, timeoutMs = SEARCH_SUGGESTION_TIMEOUT_MS) {
  const controller = new AbortController();
  const aborted = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) aborted();
  else options.signal?.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    checkAborted(controller.signal);
    return await waitWithSignal(httpGet(url, { ...options, timeout: timeoutMs, retries: 0, signal: controller.signal }), controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
  }
}

function rememberTimed(map, key, value, ttlMs, maxItems) {
  const now = Date.now();
  for (const [oldKey, entry] of map) if (entry.expiresAt <= now) map.delete(oldKey);
  map.delete(key);
  map.set(key, { value, expiresAt: now + ttlMs });
  while (map.size > maxItems) map.delete(map.keys().next().value);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

export default class HongguoSource extends BaseSource {
  constructor() {
    super();
    this.preferredApiHost = CLIENT_CONFIG.apiHosts[0];
    this.nextRequestAt = 0;
    this.nextCommentRequestAt = 0;
    this.requestCooldownUntil = 0;
    this.metadataCooldownUntil = 0;
    this.playerEpisodeResolutions = new Map();
    this.activeCommentRequests = 0;
    this.commentRequestWaiters = [];
    this.activeMetadataRequests = 0;
    this.metadataRequestWaiters = [];
    this.episodeDetailsCache = new Map();
    this.pendingEpisodeDetails = new Map();
    this.durationCache = new Map();
    this.durationFailures = new Map();
    this.pendingDurationLookups = new Map();
    this.pendingEpisodeDanmu = new Map();
    this.deliveryIdentity = createHongguoIdentity();
    this.deliveryIdentityReady = false;
    this.deliveryIdentityTask = null;
    this.deliveryIdentityRetryAt = 0;
    this.deliveryIdentityRetryCount = 0;
    // 弹幕节流自适应：1 为 30ms 快档，翻倍退避最多 THROTTLE_MAX_BACKOFF 倍
    this.commentThrottleBackoff = 1;
    this.commentSuccessStreak = 0;
    this.metadataThrottleBackoff = 1;
    this.metadataSuccessStreak = 0;
  }

  buildUrl(path, extraQuery = {}, apiHost = this.preferredApiHost) {
    const query = { ...CLIENT_CONFIG.baseQuery, ...this.deliveryIdentity, ...extraQuery, _rticket: String(Date.now()) };
    return `https://${apiHost || CLIENT_CONFIG.apiHosts[0]}${path}?${buildQueryString(query)}`;
  }

  getApiHosts() {
    const preferred = this.preferredApiHost;
    if (!preferred || !CLIENT_CONFIG.apiHosts.includes(preferred)) return [...CLIENT_CONFIG.apiHosts];
    return [preferred, ...CLIENT_CONFIG.apiHosts.filter((host) => host !== preferred)];
  }

  async throttle(baseMs = METADATA_THROTTLE_MS, jitterMs = METADATA_THROTTLE_JITTER_MS, { comment = false, signal } = {}) {
    const nextKey = comment ? "nextCommentRequestAt" : "nextRequestAt";
    const cooldownKey = comment ? "requestCooldownUntil" : "metadataCooldownUntil";
    for (;;) {
      checkAborted(signal);
      const now = Date.now();
      const scheduled = Math.max(now, this[nextKey], this[cooldownKey]);
      this[nextKey] = scheduled + baseMs + Math.floor(Math.random() * jitterMs);
      if (scheduled > now) await sleep(scheduled - now, signal);
      // 其他并发请求可能在本次等待期间收到冷却指令，重新排队后再发送。
      if (Date.now() >= this[cooldownKey]) return;
    }
  }

  async request(method, path, { body = null, extraQuery = {}, comment = false, signal } = {}) {
    const apiHosts = this.getApiHosts();
    const failures = [];
    const payload = body == null ? null : JSON.stringify(body);
    const kind = comment ? "comment" : "metadata";
    const backoffKey = `${kind}ThrottleBackoff`;
    const successKey = `${kind}SuccessStreak`;
    const baseMs = comment ? COMMENT_THROTTLE_MS : METADATA_THROTTLE_MS;
    const jitterMs = comment ? COMMENT_THROTTLE_JITTER_MS : METADATA_THROTTLE_JITTER_MS;
    for (let index = 0; index < apiHosts.length; index++) {
      const apiHost = apiHosts[index];
      // 同类接口跨主机共享冷却；弹幕和元数据各自遵守服务端返回的冷却指令。
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let releaseSlot;
        try {
          checkAborted(signal);
          releaseSlot = await this.acquireRequestSlot(comment, signal);
          await this.throttle(baseMs * this[backoffKey], jitterMs * this[backoffKey], { comment, signal });
          checkAborted(signal);
          // 排队和冷却结束后再构建 URL / 签名，避免发送过期的时间戳。
          const url = this.buildUrl(path, extraQuery, apiHost);
          const headers = { ...CLIENT_CONFIG.headers, "content-type": "application/json; charset=utf-8" };
          if (comment) {
            headers["comment-source"] = String(COMMENT_SOURCE);
            headers["server-channel"] = String(SERVER_CHANNEL);
            headers["x-ss-stub"] = "";
          } else if (payload != null) {
            headers["x-ss-stub"] = md5(stringToUtf8Bytes(payload)).toUpperCase();
          }
          Object.assign(headers, signHongguoRequest(url, { headers }));
          const response = await waitWithSignal(method === "GET"
            ? httpGet(url, { headers, timeout: 30000, signal })
            : httpPost(url, payload, { headers, timeout: 30000, signal }), signal);
          const result = parseHongguoResponse(response);
          this.preferredApiHost = apiHost;
          if (++this[successKey] >= THROTTLE_RECOVER_STREAK) {
            this[successKey] = 0;
            this[backoffKey] = Math.max(1, this[backoffKey] / 2);
          }
          return result;
        } catch (error) {
          checkAborted(signal);
          if (error && error.coolDownMs) {
            // 先公布该类接口的期限，再释放槽位；另一类接口不被这次冷却阻塞。
            log("warn", `[Hongguo] ${apiHost} 触发风控冷却 ${Math.round(error.coolDownMs / 1000)}s，退避后重试`);
            const cooldownKey = comment ? "requestCooldownUntil" : "metadataCooldownUntil";
            const nextKey = comment ? "nextCommentRequestAt" : "nextRequestAt";
            this[cooldownKey] = Math.max(
              this[cooldownKey],
              Date.now() + error.coolDownMs + Math.floor(Math.random() * 1000),
            );
            this[nextKey] = Math.max(this[nextKey], this[cooldownKey]);
            this[successKey] = 0;
            this[backoffKey] = Math.min(THROTTLE_MAX_BACKOFF, this[backoffKey] * 2);
            if (attempt < maxAttempts - 1) continue;
          }
          const message = error && error.message ? error.message : String(error);
          failures.push({ host: apiHost, message });
          const nextApiHost = apiHosts[index + 1];
          if (nextApiHost) {
            log("warn", `[Hongguo] ${apiHost} 请求失败，切换到 ${nextApiHost}: ${message}`);
          }
          break;
        } finally {
          if (releaseSlot) releaseSlot();
        }
      }
    }
    const details = failures.map(({ host, message }) => `${host}: ${message}`).join(" | ");
    const requestError = new Error(`红果请求失败，${apiHosts.length} 条线路均不可用: ${details}`);
    requestError.name = "HongguoHostError";
    requestError.failures = failures;
    throw requestError;
  }

  async fetchWebSearch(keyword) {
    const response = await boundedHttpGet(`${WEB_ORIGIN}/search/${encodeURIComponent(keyword)}`, {
      headers: { accept: "text/html" },
    });
    return parseWebSearchResults(typeof response.data === "string" ? response.data : "");
  }

  async fetchSearchSuggestions(keyword) {
    const query = buildQueryString({ app_id: "8662", query: keyword, count: String(SEARCH_SUGGESTION_COUNT) });
    const response = await boundedHttpGet(`${WEB_ORIGIN}/incent_resource/suggestion?${query}`, {
      headers: { accept: "application/json", referer: `${WEB_ORIGIN}/`, "user-agent": "Mozilla/5.0" },
    });
    return parseSearchSuggestions(parseHongguoResponse(response));
  }

  async search(keyword) {
    const pages = await Promise.allSettled([this.fetchWebSearch(keyword), this.fetchSearchSuggestions(keyword)]);
    const merged = new Map();
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      if (page.status === "rejected") {
        log("warn", `[Hongguo] ${index === 0 ? "网页搜索" : "搜索联想"}不可用: ${page.reason.message}`);
        continue;
      }
      for (const item of page.value) if (!merged.has(item.seriesId)) merged.set(item.seriesId, item);
    }
    if (merged.size) {
      const allResults = [...merged.values()];
      let results = allResults.slice(0, MAX_SEARCH_ITEMS);
      if (allResults.length > MAX_SEARCH_ITEMS && pages[0].status === "fulfilled" && pages[1].status === "fulfilled") {
        const webIds = new Set(pages[0].value.map(item => item.seriesId));
        const suggestionOnly = [...new Map(pages[1].value.filter(item => !webIds.has(item.seriesId)).map(item => [item.seriesId, item])).values()];
        // 给联想独有结果预留最多一半名额，网页满额时也能保留补出的季。
        const reserved = suggestionOnly.slice(0, Math.ceil(MAX_SEARCH_ITEMS / 2));
        const reservedIds = new Set(reserved.map(item => item.seriesId));
        results = allResults.filter(item => !reservedIds.has(item.seriesId)).slice(0, MAX_SEARCH_ITEMS - reserved.length).concat(reserved);
      }
      log("info", `[Hongguo] 网页与联想合并后找到 ${results.length} 个结果`);
      return results;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_SUGGESTION_TIMEOUT_MS);
    try {
      const results = [];
      const seen = new Set();
      let offset = 0;
      let passback = "";
      let searchId = "";
      for (let page = 0; page < 12 && results.length < MAX_SEARCH_ITEMS; page++) {
        const params = {
          query: keyword,
          tab_name: "feed",
          search_source: "1",
          offset: String(offset),
          count: "0",
          use_correct: "true",
        };
        if (passback) params.passback = passback;
        if (searchId) params.search_id = searchId;
        const payload = await waitWithSignal(this.request("GET", "/reading/bookapi/search/tab/v", {
          extraQuery: params, signal: controller.signal,
        }), controller.signal);
        const tabs = payload.search_tabs || [];
        if (!tabs.length) break;
        const tab = tabs[0];
        const data = tab.data || [];
        for (const cell of data) {
          const item = parseSearchCell(cell);
          if (!item || seen.has(item.seriesId)) continue;
          seen.add(item.seriesId);
          results.push(item);
          if (results.length >= MAX_SEARCH_ITEMS) break;
        }
        offset = tab.next_offset == null ? offset : tab.next_offset;
        passback = tab.passback || passback;
        searchId = tab.search_id || searchId;
        if (!tab.has_more || !data.length) break;
      }
      log("info", `[Hongguo] 搜索找到 ${results.length} 个结果`);
      return results;
    } catch (error) {
      log("error", `[Hongguo] 搜索失败: ${error.message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async getEpisodes(seriesId, { signal } = {}) {
    checkAborted(signal);
    const key = String(seriesId);
    const cached = this.episodeDetailsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
    this.episodeDetailsCache.delete(key);
    let task = this.pendingEpisodeDetails.get(key);
    if (!task) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DETAIL_LOOKUP_TIMEOUT_MS);
      // 共享加载有自己的截止时间；一个搜索调用取消，不会中断其他调用正在复用的详情。
      task = waitWithSignal(this.fetchEpisodeDetails(key, controller.signal), controller.signal).catch(error => {
        if (!controller.signal.aborted) throw error;
        log("warn", `[Hongguo] 剧集 ${key} 详情达到 ${DETAIL_LOOKUP_TIMEOUT_MS / 1000}s 等待上限`);
        return { episodes: [], year: null, imageUrl: "" };
      }).then(details => {
        rememberTimed(this.episodeDetailsCache, key, details,
          details.episodes.length ? DETAIL_CACHE_TTL_MS : DETAIL_FAILURE_TTL_MS, DETAIL_CACHE_MAX_ITEMS);
        return details;
      }).finally(() => {
        clearTimeout(timer);
        this.pendingEpisodeDetails.delete(key);
      });
      this.pendingEpisodeDetails.set(key, task);
    }
    return structuredClone(await waitWithSignal(task, signal));
  }

  async fetchEpisodeDetails(seriesId, signal) {
    const body = {
      biz_param: {
        detail_page_version: 0,
        disable_digg_stat: false,
        disable_video_relate_book: false,
        image_shrink_datas_str: IMAGE_SHRINK,
        need_all_video_definition: false,
        need_mp4_align: false,
        screen_width_px: "900",
        source: 7,
        use_os_player: false,
        use_server_dns: false,
      },
      series_id: String(seriesId),
    };

    try {
      const payload = await this.request("POST", "/novel/player/multi_video_detail/v1/", { body, signal });
      const details = parseApiEpisodeDetails(payload, seriesId);
      if (details) {
        this.cacheEpisodeDurations(seriesId, details.episodes);
        return details;
      }
      log("warn", `[Hongguo] API detail returned no episodes for series ${seriesId}, falling back to web detail`);
    } catch (error) {
      log("warn", `[Hongguo] API detail unavailable: ${error.message}, falling back to web detail`);
    }
    try {
      const response = await boundedHttpGet(`${WEB_ORIGIN}/detail?series_id=${encodeURIComponent(seriesId)}`, {
        headers: { accept: "text/html" }, signal,
      });
      const details = parseWebEpisodeDetails(typeof response.data === "string" ? response.data : "");
      if (details) {
        this.cacheEpisodeDurations(seriesId, details.episodes);
        return details;
      }
    } catch (error) {
      log("warn", `[Hongguo] web detail unavailable: ${error.message}`);
    }
    return { episodes: [], year: null, imageUrl: "" };
  }

  cacheEpisodeDurations(seriesId, episodes) {
    for (const episode of episodes) {
      const duration = positiveDuration(episode.duration);
      if (duration) this.durationCache.set(`${seriesId}:${episode.vid}`, duration);
    }
  }

  async resolveEpisodeDuration(info, refreshDetails = false) {
    const duration = positiveDuration(info.duration);
    if (duration) return duration;
    const cacheKey = `${info.seriesId}:${info.vid}`;
    const cached = positiveDuration(this.durationCache.get(cacheKey));
    if (cached) return cached;
    const failure = this.durationFailures.get(cacheKey);
    if (failure && failure.expiresAt > Date.now()) return 0;
    this.durationFailures.delete(cacheKey);
    const pending = this.pendingDurationLookups.get(cacheKey);
    if (pending) return pending;
    const task = (async () => {
      if (refreshDetails) {
        try {
          const details = await this.getEpisodes(info.seriesId);
          this.cacheEpisodeDurations(info.seriesId, details.episodes);
          const fromDetails = positiveDuration(this.durationCache.get(cacheKey));
          if (fromDetails) return fromDetails;
        } catch (error) {
          log("warn", `[Hongguo] 补查详情时长失败: ${error.message}`);
        }
      }
      try {
        const response = await boundedHttpGet(`${WEB_ORIGIN}/player/${encodeURIComponent(info.seriesId)}/${encodeURIComponent(info.vid)}`, {
          headers: { accept: "text/html" },
        }, PLAYER_LOOKUP_TIMEOUT_MS);
        const fromPlayer = parseWebPlayerDuration(typeof response.data === "string" ? response.data : "", info);
        if (fromPlayer) {
          this.durationCache.set(cacheKey, fromPlayer);
          this.durationFailures.delete(cacheKey);
          return fromPlayer;
        }
      } catch (error) {
        log("warn", `[Hongguo] 播放页时长不可用(${info.vid}): ${error.message}`);
      }
      // 0 表示真实时长仍未知；兜底值只用于排布，不写入真实时长缓存。
      rememberTimed(this.durationFailures, cacheKey, null, DURATION_FAILURE_TTL_MS, DURATION_FAILURE_MAX_ITEMS);
      return 0;
    })().finally(() => this.pendingDurationLookups.delete(cacheKey));
    this.pendingDurationLookups.set(cacheKey, task);
    return task;
  }

  async getSeriesEpisodeInfos(seriesId) {
    const details = await this.getEpisodes(seriesId);
    this.cacheEpisodeDurations(seriesId, details.episodes);
    return mapWithConcurrency(details.episodes, DURATION_LOOKUP_CONCURRENCY, async episode => ({
      ...episode,
      duration: await this.resolveEpisodeDuration({ ...episode, seriesId }),
    }));
  }

  async enrichEpisodeInfo(info) {
    return { ...info, duration: await this.resolveEpisodeDuration(info, true) };
  }

  async resolveEpisodeInfo(value) {
    let raw = typeof value === "object" && value !== null
      ? String(value.url || value.id || value.value || "")
      : String(value || "");
    raw = raw.trim();
    const embedded = raw.match(/hongguo:v1:[^\s#]+:[^\s#]+:\d+/);
    if (embedded) {
      try { return this.enrichEpisodeInfo(parseHongguoEpisodeId(embedded[0])); } catch { /* continue */ }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (raw.split("#", 1)[0].startsWith("hongguo:v1:")) return this.enrichEpisodeInfo(parseHongguoEpisodeId(raw));
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch { break; }
    }

    const player = parseHongguoPlayerUrl(raw);
    const cacheKey = `${player.seriesId}:${player.vid}`;
    let resolution = this.playerEpisodeResolutions.get(cacheKey);
    if (!resolution) {
      resolution = (async () => {
        const details = await this.getEpisodes(player.seriesId);
        const episode = details.episodes.find((item) => item.vid === player.vid);
        if (!episode) {
          throw new Error(`播放链接中的 vid ${player.vid} 不属于剧集 ${player.seriesId}`);
        }
        return {
          seriesId: player.seriesId,
          vid: player.vid,
          duration: await this.resolveEpisodeDuration({ ...episode, seriesId: player.seriesId }),
        };
      })();
      this.playerEpisodeResolutions.set(cacheKey, resolution);
    }

    try {
      const info = await resolution;
      if (!info.duration) this.playerEpisodeResolutions.delete(cacheKey);
      return info;
    } catch (error) {
      if (this.playerEpisodeResolutions.get(cacheKey) === resolution) {
        this.playerEpisodeResolutions.delete(cacheKey);
      }
      throw error;
    }
  }

  createRequestSlotRelease(comment) {
    const waiters = comment ? this.commentRequestWaiters : this.metadataRequestWaiters;
    const activeKey = comment ? "activeCommentRequests" : "activeMetadataRequests";
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) {
        next(this.createRequestSlotRelease(comment));
      } else {
        this[activeKey]--;
      }
    };
  }

  async acquireRequestSlot(comment, signal) {
    checkAborted(signal);
    const activeKey = comment ? "activeCommentRequests" : "activeMetadataRequests";
    const waiters = comment ? this.commentRequestWaiters : this.metadataRequestWaiters;
    const limit = comment ? COMMENT_CONCURRENCY : SEARCH_DETAIL_CONCURRENCY;
    if (this[activeKey] < limit) {
      this[activeKey]++;
      return this.createRequestSlotRelease(comment);
    }
    return new Promise((resolve, reject) => {
      const ready = release => { signal?.removeEventListener("abort", aborted); resolve(release); };
      const aborted = () => {
        const index = waiters.indexOf(ready);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason || new DOMException("已取消", "AbortError"));
      };
      waiters.push(ready);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  resolveSeriesId(value) {
    if (isHongguoSeriesId(value)) return parseHongguoSeriesId(value).seriesId;
    if (String(value || "").split("#", 1)[0].startsWith("hongguo:v1:")) {
      return parseHongguoEpisodeId(value).seriesId;
    }
    return parseHongguoPlayerUrl(value).seriesId;
  }

  shouldMergeAllEpisodes(value) {
    return isHongguoSeriesId(value) || Boolean(globals.hongguoMergeAllEpisodes);
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    if (!Array.isArray(sourceAnimes)) return [];
    const transformed = [];
    const filtered = sourceAnimes.filter((item) => titleMatches(item.name, queryTitle, querySeason));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_DETAIL_BUDGET_MS);
    let detailed;
    try {
      detailed = await mapWithConcurrency(filtered, SEARCH_DETAIL_CONCURRENCY, async (anime) => {
        if (controller.signal.aborted) return null;
        try {
          return { anime, details: await waitWithSignal(this.getEpisodes(anime.seriesId, { signal: controller.signal }), controller.signal) };
        } catch (error) {
          if (!controller.signal.aborted) log("warn", `[Hongguo] 剧集 ${anime.seriesId} 详情获取失败: ${error.message}`);
          return null;
        }
      });
      if (controller.signal.aborted) log("warn", `[Hongguo] 搜索详情达到 ${SEARCH_DETAIL_BUDGET_MS / 1000}s 等待上限，保留已完成的结果`);
    } finally {
      clearTimeout(timer);
    }
    // 详情请求并行，缓存写入保持搜索结果顺序。
    for (const result of detailed) {
      if (!result) continue;
      const { anime, details } = result;
      const episodes = details.episodes;
      const links = globals.hongguoMergeAllEpisodes && episodes.length
        ? [{
            name: "全集",
            url: createHongguoSeriesId(anime.seriesId),
            title: "【hongguo】 全集",
          }]
        : episodes.map((episode) => {
            const episodeTitle = `第${episode.index}集${episode.title ? ` ${episode.title}` : ""}`;
            return {
              name: episodeTitle,
              url: createHongguoEpisodeId(anime.seriesId, episode.vid, episode.duration),
              title: `【hongguo】 ${episodeTitle}`,
            };
          });
      if (!links.length) continue;
      const year = Number.isInteger(anime.year)
        ? anime.year
        : (Number.isInteger(details.year) ? details.year : null);
      const item = {
        animeId: convertToAsciiSum(anime.seriesId),
        bangumiId: String(anime.seriesId),
        animeTitle: `${anime.name}${year ? `(${year})` : ""}【短剧】from hongguo`,
        type: "短剧",
        typeDescription: "短剧",
        imageUrl: anime.imageUrl || details.imageUrl || "",
        startDate: generateValidStartDate(year),
        episodeCount: links.length,
        rating: Number(anime.score) || 0,
        isFavorited: true,
        source: "hongguo",
      };
      transformed.push(item);
      addAnime({ ...item, links }, detailStore);
    }
    this.sortAndPushAnimesByYear(transformed, curAnimes);
    return transformed;
  }

  buildCommentBody(info, startMs, cursor) {
    return {
      comment_source: COMMENT_SOURCE,
      server_channel: SERVER_CHANNEL,
      group_id: info.vid,
      group_type: 30,
      comment_type: 20,
      sort: 1,
      business_param: {
        book_id: info.seriesId,
        start_offset_time: Math.max(0, Math.trunc(startMs)),
        playlet_item_duration: Math.max(0, Math.trunc(info.duration * 1000)),
        need_danmaku_guide_type: [1, 3, 4, 2],
      },
      count: COMMENT_COUNT,
      cursor: String(cursor || ""),
      aid: Number(CLIENT_CONFIG.baseQuery.aid),
      compliance_status: 0,
    };
  }

  async fetchCommentWindow(info, startMs, cursor = "") {
    const path = `/novel/commentapi/comment/list/${encodeURIComponent(info.vid)}/v1/`;
    const payload = await this.request("POST", path, {
      body: this.buildCommentBody(info, startMs, cursor),
      comment: true,
    });
    return parseCommentWindow(payload, startMs);
  }

  // 同身份下发量有长期粘性；复检持久化身份，候选择优后供整个实例复用。
  async ensureDeliveryIdentity(info) {
    if (this.deliveryIdentityReady) return;
    if (this.deliveryIdentityTask) return this.deliveryIdentityTask;
    if (Date.now() < this.deliveryIdentityRetryAt) return;
    this.deliveryIdentityTask = (async () => {
      const candidates = [];
      let bestPage = null;
      const saved = await readPersistedIdentity();
      if (saved) candidates.push(saved);
      if (!candidates.length) candidates.push(this.deliveryIdentity);
      while (candidates.length < COMMENT_IDENTITY_CANDIDATES) candidates.push(createHongguoIdentity());
      let best = null;
      let bestCount = -1;
      let bestQuality = false;
      let failures = 0;
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (index > 0) {
          await sleep(COMMENT_IDENTITY_PROBE_INTERVAL_MS + Math.floor(Math.random() * COMMENT_IDENTITY_PROBE_JITTER_MS));
        }
        this.deliveryIdentity = candidate;
        let count;
        let declared;
        let page;
        try {
          page = await this.fetchCommentWindow(info, 0, "");
          count = dedupeDanmus(page.comments.filter(item => item.offsetMs >= 0 && item.offsetMs < page.nextStart)).length;
          declared = Number(page.declaredWindowComments) || 0;
          failures = 0;
        } catch (error) {
          failures++;
          log("warn", `[Hongguo] 设备身份探测失败(${maskHongguoIdentity(candidate)}): ${error.message}`);
          if (failures >= COMMENT_IDENTITY_PROBE_MAX_FAILURES) {
            log("warn", "[Hongguo] 设备身份探测连续失败，提前结束并使用当前最优身份");
            break;
          }
          continue;
        }
        const quality = isQualityDelivery(count, declared);
        log("info", `[Hongguo] 设备身份探测 ${maskHongguoIdentity(candidate)} 窗口0下发 ${count}${declared > 0 ? `/${declared}` : ""} 条${quality ? "（优质档）" : ""}`);
        if (count > bestCount || (count === bestCount && quality && !bestQuality)) {
          best = candidate;
          bestCount = count;
          bestPage = page;
          bestQuality = quality;
        }
        if (quality && best === candidate) break;
        // 明确声明窗口 0 为空时无法评估身份；未知计数的空响应仍需尝试其他候选。
        if (count === 0 && (page.declaredTotal === 0 || parseDeclaredCount(page.declaredWindows?.['0']) === 0)) break;
        // 声明量本来不足五条时，继续换身份也无法达到最小样本要求。
        if (count < MIN_IDENTITY_SAMPLE && declared > 0 && declared < MIN_IDENTITY_SAMPLE) break;
      }
      if (best) {
        this.deliveryIdentity = best;
        // 探测窗口拿到的数据本身就可以用于本次弹幕获取，避免重复请求。
        this.deliveryIdentityProbe = { vid: String(info.vid), page: bestPage };
        const backends = bestCount >= MIN_IDENTITY_SAMPLE ? await persistHongguoIdentity(best) : [];
        const tierHint = bestCount < MIN_IDENTITY_SAMPLE
          ? "，样本不足，稍后继续探测"
          : bestQuality ? "" : "，未达优质线，重启/冷启动会继续自动探测";
        log("info", `[Hongguo] 采用设备身份 ${maskHongguoIdentity(best)}（窗口0 探测 ${bestCount} 条，持久化: ${backends.join("/") || "仅内存"}${tierHint}）`);
      } else if (candidates.length) {
        // 全部探测失败：保留原身份，短暂退避后允许后续请求重新探测。
        this.deliveryIdentity = candidates[0];
        log("warn", `[Hongguo] 设备身份探测均未成功，回退使用 ${maskHongguoIdentity(candidates[0])}`);
      }
      this.deliveryIdentityReady = bestCount >= MIN_IDENTITY_SAMPLE;
      this.deliveryIdentityRetryCount = this.deliveryIdentityReady ? 0 : this.deliveryIdentityRetryCount + 1;
      const retryMs = Math.min(COMMENT_IDENTITY_MAX_RETRY_MS,
        COMMENT_IDENTITY_RETRY_MS * 2 ** Math.min(this.deliveryIdentityRetryCount - 1, 4));
      this.deliveryIdentityRetryAt = this.deliveryIdentityReady ? 0 : Date.now() + retryMs;
    })().finally(() => {
      this.deliveryIdentityTask = null;
    });
    return this.deliveryIdentityTask;
  }

  async getDanmuForEpisode(info) {
    await this.ensureDeliveryIdentity(info);
    const knownDurationMs = positiveDuration(info.duration) * 1000;
    const durationMs = knownDurationMs || EPISODE_FALLBACK_DURATION_SECONDS * 1000;
    const comments = [];
    const seenMarkers = new Set();
    let startMs = 0;
    let cursor = "";
    let declaredWindows = null;
    let declaredTotal = null;
    const probe = this.deliveryIdentityProbe;
    let initialPage = null;
    if (probe && probe.vid === String(info.vid) && probe.page) {
      this.deliveryIdentityProbe = null;
      initialPage = probe.page;
    }
    const maxRequests = Math.max(1, Math.ceil(durationMs / COMMENT_WINDOW_MS) + 5);
    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex++) {
      const marker = `${startMs}:${cursor}`;
      if (seenMarkers.has(marker)) break;
      seenMarkers.add(marker);
      // 探测页与普通页共用终止和空窗口跳过逻辑，避免多请求或漏处理。
      const page = initialPage || await this.fetchCommentWindow(info, startMs, cursor);
      initialPage = null;
      comments.push(...page.comments.filter(item => item.offsetMs >= startMs && item.offsetMs < Math.min(page.nextStart, durationMs)));
      if (page.declaredWindows) declaredWindows = page.declaredWindows;
      if (Number.isFinite(page.declaredTotal)) declaredTotal = page.declaredTotal;
      if (page.nextStart >= durationMs) break;
      if (!page.hasMore && !knownDurationMs) break;
      let nextStart = page.nextStart;
      let nextCursor = page.cursor;
      // 空窗口跳过：cursor 里带整集窗口计数表，声明为 0 的窗口无需请求；
      // 声明缺失（拿不到计数）的窗口仍照常请求，保证不丢弹幕。
      if (declaredTotal === 0 && comments.length === 0) {
        log("info", `[Hongguo] 该集无弹幕数据，跳过剩余窗口: ${info.vid}`);
        break;
      }
      if (declaredWindows) {
        const declaredAt = (start) => {
          return parseDeclaredCount(declaredWindows[String(start)]);
        };
        let skippedTo = nextStart;
        while (declaredAt(skippedTo) === 0 && skippedTo < durationMs) skippedTo += COMMENT_WINDOW_MS;
        if (skippedTo > nextStart) {
          log("info", `[Hongguo] 跳过空窗口至 ${skippedTo / 1000}s: ${info.vid}`);
          nextStart = skippedTo;
          // 跳过窗口后不再沿用旧 cursor（旧 cursor 会覆盖 start 的窗口范围），改为直接按窗口起点请求
          nextCursor = "";
        }
      }
      if (nextStart >= durationMs) break;
      startMs = nextStart;
      cursor = nextCursor;
    }
    return comments;
  }

  async getSeriesDanmu(seriesId) {
    const episodes = await this.getSeriesEpisodeInfos(seriesId);
    let cumulativeMs = 0;
    const episodeTasks = episodes.map((episode) => {
      const task = { episode, offsetMs: cumulativeMs };
      cumulativeMs += this.getSeriesEpisodeDuration(seriesId, episode) * 1000;
      return task;
    });
    const groupedComments = await mapWithConcurrency(episodeTasks, COMMENT_CONCURRENCY, async ({ episode, offsetMs }) => {
      const episodeComments = await this.getDanmuForEpisode({
        seriesId: String(seriesId),
        vid: episode.vid,
        duration: episode.duration,
      });
      return episodeComments.map((comment) => ({
        ...comment,
        offsetMs: comment.offsetMs + offsetMs,
      }));
    });
    return dedupeDanmus(groupedComments.flat());
  }

  async getEpisodeDanmu(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmu(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const cacheKey = `${info.seriesId}:${info.vid}`;
      // in-flight 去重：同一集并发请求只抓取一次，避免重复命中接口加重风控
      const pending = this.pendingEpisodeDanmu.get(cacheKey);
      if (pending) {
        log("info", `[Hongguo] 复用进行中的整段弹幕请求: ${cacheKey}`);
        return await pending;
      }
      const task = this.getDanmuForEpisode(info).then(dedupeDanmus).finally(() => {
        this.pendingEpisodeDanmu.delete(cacheKey);
      });
      this.pendingEpisodeDanmu.set(cacheKey, task);
      return await task;
    } catch (error) {
      log("error", `[Hongguo] 获取弹幕失败(${String(id).slice(0, 80)}): ${error.message}`);
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmuSegments(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const episodeId = createHongguoEpisodeId(info.seriesId, info.vid, info.duration);
      const segmentList = [];
      const effectiveDuration = this.getSeriesEpisodeDuration(info.seriesId, info);
      for (let start = 0; start < effectiveDuration; start += COMMENT_WINDOW_MS / 1000) {
        segmentList.push({
          type: "hongguo",
          segment_start: start,
          segment_end: Math.min(start + COMMENT_WINDOW_MS / 1000, effectiveDuration),
          url: `${episodeId}#segment=${start}`,
        });
      }
      return new SegmentListResponse({ type: "hongguo", segmentList, duration: effectiveDuration });
    } catch (error) {
      log("error", `[Hongguo] 创建弹幕分段失败: ${error.message}`);
      return new SegmentListResponse({ type: "hongguo", segmentList: [] });
    }
  }

  async getSeriesDanmuSegments(seriesId) {
    const episodes = await this.getSeriesEpisodeInfos(seriesId);
    const segmentList = [];
    let cumulativeSeconds = 0;
    for (const episode of episodes) {
      const duration = this.getSeriesEpisodeDuration(seriesId, episode);
      const episodeId = createHongguoEpisodeId(seriesId, episode.vid, episode.duration);
      for (let start = 0; start < duration; start += COMMENT_WINDOW_MS / 1000) {
        const end = Math.min(start + COMMENT_WINDOW_MS / 1000, duration);
        segmentList.push({
          type: "hongguo",
          segment_start: cumulativeSeconds + start,
          segment_end: cumulativeSeconds + end,
          url: `${episodeId}#segment=${start}&offset=${cumulativeSeconds}`,
        });
      }
      cumulativeSeconds += duration;
    }
    return new SegmentListResponse({ type: "hongguo", segmentList, duration: cumulativeSeconds });
  }

  getSeriesEpisodeDuration(seriesId, episode) {
    const duration = positiveDuration(episode.duration);
    if (duration) return duration;
    // 与全集分段采用同一兜底时长，避免未知时长的集把后续弹幕叠在同一时间点。
    const cached = positiveDuration(this.durationCache.get(`${seriesId}:${episode.vid}`));
    return cached || EPISODE_FALLBACK_DURATION_SECONDS;
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const segmentUrl = typeof segment === "string" ? segment : segment.url;
      const info = await this.resolveEpisodeInfo(segmentUrl);
      const globalOffsetSeconds = Math.max(0, getFragmentNumber(segmentUrl, "offset") || 0);
      const fragmentStart = getFragmentNumber(segmentUrl, "segment");
      const localStartSeconds = Math.max(0, fragmentStart == null
        ? Number(segment.segment_start || 0) - globalOffsetSeconds
        : fragmentStart);
      const segmentDurationSeconds = typeof segment === "string" ? COMMENT_WINDOW_MS / 1000 : Math.max(0, Number(segment.segment_end) - Number(segment.segment_start));
      const localEndSeconds = Math.min(info.duration > 0 ? info.duration : localStartSeconds + segmentDurationSeconds, localStartSeconds + segmentDurationSeconds);
      const startMs = localStartSeconds * 1000;
      const endMs = Math.max(startMs, localEndSeconds * 1000);
      await this.ensureDeliveryIdentity(info);
      let page;
      const probe = this.deliveryIdentityProbe;
      if (startMs === 0 && probe && probe.vid === String(info.vid) && probe.page) {
        this.deliveryIdentityProbe = null;
        page = probe.page;
      } else {
        page = await this.fetchCommentWindow(info, startMs, "");
      }
      const offsetMs = globalOffsetSeconds * 1000;
      return dedupeDanmus(page.comments
        .filter((item) => item.offsetMs >= startMs && item.offsetMs < endMs)
        .map((item) => ({ ...item, offsetMs: item.offsetMs + offsetMs })));
    } catch (error) {
      log("error", `[Hongguo] 获取分段弹幕失败: ${error.message}`);
      return [];
    }
  }

  formatComments(comments) {
    return comments.map((comment) => ({
      p: `${(comment.offsetMs / 1000).toFixed(2)},1,16777215,[hongguo]`,
      m: comment.text,
      t: comment.offsetMs / 1000,
      like: comment.diggCount,
    }));
  }
}
