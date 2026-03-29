import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import {
  buildHanjutvSearchHeaders,
  decodeHanjutvEncryptedPayload,
  buildLiteHeaders,
  encodeMergedHanjutvEpisodeDanmuId,
  parseHanjutvEpisodeDanmuId,
  getHanjutvSourceLabel,
} from "../utils/hanjutv-util.js";

const CATE_MAP = { 1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧" };
const MAX_AXIS = 100000000;
const DANMU_WINDOW_MS = 60000;
const HANJUTV_VARIANTS = Object.freeze({
  HXQ: "hxq",
  TV: "tv",
  MERGED: "merged",
});

// =====================
// 获取韩剧TV弹幕
// =====================
export default class HanjutvSource extends BaseSource {
  constructor() {
    super();
    this.appHost = "https://hxqapi.hiyun.tv";
    this.tvHost = "https://api.xiawen.tv";
    this.fallbackDanmuHost = "https://hxqapi.zmdcq.com";
    this.danmuHosts = Array.from(new Set([this.appHost, this.fallbackDanmuHost]));
    this.defaultRefer = "2JGztvGjRVpkxcr0T4ZWG2k+tOlnHmDGUNMwAGSeq548YV2FMbs0h0bXNi6DJ00L";
    this.danmuUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
    this.appUserAgent = "HanjuTV/6.8.2 (Redmi Note 12; Android 14; Scale/2.00)";
    this._mobileMakeHeaders = null;
    this._tvMakeHeaders = null;
  }

  getDanmuHeaders() {
    return {
      "Content-Type": "application/json",
      "User-Agent": this.danmuUserAgent,
    };
  }

  getAppHeaders() {
    return {
      vc: "a_8280",
      vn: "6.8.2",
      ch: "xiaomi",
      app: "hj",
      "User-Agent": this.appUserAgent,
      "Accept-Encoding": "gzip",
    };
  }

  getCategory(key) {
    return CATE_MAP[key] || "其他";
  }

  /**
   * 构建 TV 端请求头，返回 { headers, uid }
   */
  async buildTvHeaders() {
    if (!this._tvMakeHeaders) {
      this._tvMakeHeaders = await buildLiteHeaders(Date.now());
    }
    return this._tvMakeHeaders(Date.now());
  }

  async buildMobileHeaders() {
    if (!this._mobileMakeHeaders) {
      this._mobileMakeHeaders = await buildHanjutvSearchHeaders(Date.now());
    }
    return this._mobileMakeHeaders(Date.now());
  }

  /**
   * 向 TV 端发起 GET 请求并自动解密响应
   */
  async tvGet(path, options = {}) {
    const headerInfo = await this.buildTvHeaders();
    const resp = await httpGet(`${this.tvHost}${path}`, {
      headers: headerInfo.headers,
      timeout: 10000,
      retries: 1,
      ...options,
    });
    return decodeHanjutvEncryptedPayload(resp?.data, headerInfo.uid);
  }

  /**
   * 统一的错误日志格式
   */
  logError(tag, error) {
    log("error", `${tag}:`, {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
  }

  attachDanmuSourceLabel(comments = [], rawId = "") {
    const sourceLabel = getHanjutvSourceLabel(rawId);
    return Array.isArray(comments)
      ? comments.map(item => ({ ...item, _sourceLabel: sourceLabel }))
      : [];
  }

  /**
   * 安全执行异步操作，失败时返回 fallback 值并可选打印警告
   */
  async tryGet(fn, fallback, warnTag) {
    try {
      return await fn();
    } catch (error) {
      if (warnTag) log("warn", `${warnTag}: ${error.message}`);
      return fallback;
    }
  }

  // ── 数据规范化 ──────────────────────────────────────────────

  normalizeSearchItems(items = []) {
    if (!Array.isArray(items)) return [];

    return items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const sid = item.sid || item.seriesId || item.id || item.series_id;
        const name = item.name || item.title || item.seriesName || item.showName;
        if (!sid || !name) return null;

        const imageObj = typeof item.image === "object" && item.image !== null ? item.image : {};
        const thumb = imageObj.thumb || imageObj.poster || imageObj.url || item.thumb || item.poster || "";

        return {
          ...item,
          sid: String(sid),
          name: String(name),
          image: { ...imageObj, thumb },
        };
      })
      .filter(Boolean);
  }

  normalizeEpisodes(items = [], variant = "") {
    if (!Array.isArray(items)) return [];

    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const pid = item.pid || item.programId || (variant !== HANJUTV_VARIANTS.TV ? (item.episodeId || item.id || "") : "");
        const eid = item.eid || (variant !== HANJUTV_VARIANTS.HXQ ? (item.episodeId || item.id || "") : "");
        const episodeId = pid || eid;
        if (!episodeId) return null;

        const serialCandidate = item.serialNo ?? item.serial_no ?? item.sort ?? item.sortNo ?? item.num ?? item.episodeNo ?? (index + 1);
        const serialNo = Number(serialCandidate);

        return {
          ...item,
          episodeId: String(episodeId),
          pid: pid ? String(pid) : "",
          eid: eid ? String(eid) : "",
          serialNo: Number.isFinite(serialNo) && serialNo > 0 ? serialNo : (index + 1),
          title: item.title || item.name || item.programName || item.episodeTitle || "",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.serialNo - b.serialNo);
  }

  normalizeHxqEpisodes(items = []) {
    return this.normalizeEpisodes(items, HANJUTV_VARIANTS.HXQ)
      .filter(item => item.pid)
      .map(item => ({
        ...item,
        pid: String(item.pid),
      }));
  }

  normalizeTvEpisodes(items = []) {
    return this.normalizeEpisodes(items, HANJUTV_VARIANTS.TV)
      .map((item) => {
        const eid = item.eid || item.pid || item.programId || item.episodeId || item.id || "";
        return eid ? { ...item, eid: String(eid) } : null;
      })
      .filter(Boolean);
  }

  extractSearchItems(data) {
    const list = data?.seriesData?.seriesList || data?.seriesList || data?.seriesData?.series || [];
    return this.normalizeSearchItems(list);
  }

  // ── 搜索候选合并 ─────────────────────────────────────────────

  dedupeBySid(items = []) {
    const map = new Map();
    for (const item of items) {
      if (!item?.sid) continue;
      const sid = String(item.sid);
      if (!map.has(sid)) map.set(sid, item);
    }
    return Array.from(map.values());
  }

  isMergeableSearchPair(leftItem, rightItem, keyword = "") {
    if (!leftItem?.name || !rightItem?.name) return false;
    if (keyword) {
      if (!titleMatches(leftItem.name, keyword) || !titleMatches(rightItem.name, keyword)) return false;
    }

    return titleMatches(leftItem.name, rightItem.name) && titleMatches(rightItem.name, leftItem.name);
  }

  buildSearchCandidate(item, variant, linkedSid = "") {
    if (!item?.sid) return null;

    const primarySid = String(item.sid);
    const normalizedLinkedSid = String(linkedSid || "").trim();
    const animeId = variant === HANJUTV_VARIANTS.MERGED
      ? convertToAsciiSum(`hxq:${primarySid}|tv:${normalizedLinkedSid}`)
      : convertToAsciiSum(primarySid);

    return {
      ...item,
      animeId,
      _variant: variant,
      ...(normalizedLinkedSid ? { tvSid: normalizedLinkedSid } : {}),
    };
  }

  mergeSearchCandidates(keyword, s5List = [], tvList = []) {
    const s5Unique = this.dedupeBySid(s5List);
    const tvUnique = this.dedupeBySid(tvList);

    const partition = (items) => {
      const matched = [];
      const unmatched = [];
      for (const item of items) {
        (titleMatches(item?.name || "", keyword) ? matched : unmatched).push(item);
      }
      return { matched, unmatched };
    };

    const s5 = partition(s5Unique);
    const tv = partition(tvUnique);
    const hasMatched = s5.matched.length + tv.matched.length > 0;

    const resultList = [];
    const usedTvSids = new Set();

    for (const item of s5.matched) {
      const pairedTv = tv.matched.find(candidate => !usedTvSids.has(String(candidate.sid)) && this.isMergeableSearchPair(item, candidate, keyword));
      if (pairedTv) {
        usedTvSids.add(String(pairedTv.sid));
        resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.MERGED, pairedTv.sid));
      } else {
        resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.HXQ));
      }
    }

    tv.matched
      .filter(item => !usedTvSids.has(String(item.sid)))
      .forEach(item => {
        resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.TV));
      });

    if (hasMatched) {
      s5.unmatched.forEach(item => {
        resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.HXQ));
      });
      tv.unmatched.forEach(item => {
        resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.TV));
      });
    } else {
      s5Unique.forEach(item => resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.HXQ)));
      tvUnique.forEach(item => resultList.push(this.buildSearchCandidate(item, HANJUTV_VARIANTS.TV)));
    }

    const names = (list) => list.map(item => item.name);

    return {
      resultList,
      stats: {
        s5Total: s5Unique.length,
        s5Matched: s5.matched.length,
        tvTotal: tvUnique.length,
        tvMatched: tv.matched.length,
        mergedCount: hasMatched ? resultList.filter(item => item?._variant === HANJUTV_VARIANTS.MERGED).length : 0,
        s5MatchedList: names(s5.matched),
        s5UnmatchedList: names(s5.unmatched),
        tvMatchedList: names(tv.matched),
        tvUnmatchedList: names(tv.unmatched),
      },
    };
  }

  // ── 搜索接口 ─────────────────────────────────────────────────

  /**
   * 从响应 payload 中提取搜索结果；支持加密与明文两种格式
   */
  async extractFromPayload(payload, uid, tag) {
    if (!payload || typeof payload !== "object") throw new Error(`${tag} 响应为空`);

    if (typeof payload.data === "string" && payload.data.length > 0) {
      let decoded;
      try {
        decoded = await decodeHanjutvEncryptedPayload(payload, uid);
      } catch (error) {
        throw new Error(`${tag} 响应解密失败: ${error.message}`);
      }
      const items = this.extractSearchItems(decoded);
      if (items.length === 0) throw new Error(`${tag} 解密后无有效结果`);
      return items;
    }

    const items = this.extractSearchItems(payload);
    if (items.length === 0) throw new Error(`${tag} 无有效结果`);
    return items;
  }

  async warmupMobileIdentity(headers) {
    try {
      await httpGet(`${this.appHost}/api/common/configs`, { headers, timeout: 8000, retries: 0 });
    } catch (_) {
      // 暖身失败不阻断搜索
    }
  }

  async searchWithS5Api(keyword) {
    const warmupHeaderInfo = await this.buildMobileHeaders();
    await this.warmupMobileIdentity(warmupHeaderInfo.headers);

    const { uid, headers } = await this.buildMobileHeaders();
    const q = encodeURIComponent(keyword);
    const resp = await httpGet(`https://hxqapi.hiyun.tv/api/search/s5?k=${q}&srefer=search_input&type=0&page=1`, {
      headers,
      timeout: 10000,
      retries: 1,
    });
    return this.extractFromPayload(resp?.data, uid, "s5");
  }

  async searchWithTvApi(keyword) {
    const q = encodeURIComponent(keyword);
    const headerInfo = await this.buildTvHeaders();
    const resp = await httpGet(`https://api.xiawen.tv/api/v1/aggregate/search?key=${q}&scope=101&page=1`, {
      headers: headerInfo.headers,
      timeout: 10000,
      retries: 1,
    });
    return this.extractFromPayload(resp?.data, headerInfo.uid, "tv");
  }

  async search(keyword) {
    try {
      const key = String(keyword || "").trim();
      if (!key) return [];

      const [s5List, tvList] = await Promise.all([
        this.tryGet(() => this.searchWithS5Api(key), [], `[Hanjutv] s5 搜索失败`),
        this.tryGet(() => this.searchWithTvApi(key), [], `[Hanjutv] TV 搜索失败`),
      ]);

      const { resultList, stats } = this.mergeSearchCandidates(key, s5List, tvList);
      const totalMatched = stats.s5Matched + stats.tvMatched;

      if (resultList.length > 0 && totalMatched === 0) {
        log("warn", `[Hanjutv] 所有候选均未命中关键词，丢弃疑似推荐流结果: ${key}`);
        return [];
      }

      if (resultList.length === 0) {
        log("info", "hanjutvSearchresp: s5 与 TV 接口均无有效结果");
        return [];
      }

      log("info", `[Hanjutv] 搜索候选统计 s5MatchedList=${JSON.stringify(stats.s5MatchedList)}, s5UnmatchedList=${JSON.stringify(stats.s5UnmatchedList)}, tvMatchedList=${JSON.stringify(stats.tvMatchedList)}, tvUnmatchedList=${JSON.stringify(stats.tvUnmatchedList)}`);
      log("info", `[Hanjutv] 搜索候选统计 s5=${stats.s5Total}(命中${stats.s5Matched}), tv=${stats.tvTotal}(命中${stats.tvMatched}), merged=${stats.mergedCount}`);
      log("info", `[Hanjutv] 搜索找到 ${resultList.length} 个有效结果`);

      return resultList.filter(Boolean);
    } catch (error) {
      this.logError("getHanjutvAnimes error", error);
      return [];
    }
  }

  // ── 详情 & 剧集 ──────────────────────────────────────────────

  async getHxqDetail(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return null;

      const detail = await this.tryGet(async () => {
        const r = await httpGet(`${this.appHost}/api/series/detail?sid=${sid}`, {
          headers: this.getAppHeaders(),
          timeout: 10000,
          retries: 1,
        });
        return r?.data?.series ?? null;
      }, null, "getHanjutvHxqDetail error");

      if (!detail) {
        log("info", "getHanjutvHxqDetail: series 不存在");
        return null;
      }
      return detail;
    } catch (error) {
      this.logError("getHanjutvHxqDetail error", error);
      return null;
    }
  }

  async getTvDetail(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return null;

      const detail = await this.tryGet(async () => {
        const decoded = await this.tvGet(`/api/v1/series/detail/query?sid=${sid}`);
        return decoded?.series ?? null;
      }, null, "getHanjutvTvDetail error");

      if (!detail) {
        log("info", "getHanjutvTvDetail: series 不存在");
        return null;
      }
      return detail;
    } catch (error) {
      this.logError("getHanjutvTvDetail error", error);
      return null;
    }
  }

  async getHxqEpisodes(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return [];

      const attempts = [
        async () => {
          const r = await httpGet(`${this.appHost}/api/series/detail?sid=${sid}`, {
            headers: this.getAppHeaders(),
            timeout: 10000,
            retries: 1,
          });
          return this.normalizeHxqEpisodes(Array.isArray(r?.data?.playItems) ? r.data.playItems : []);
        },
        async () => {
          const r = await httpGet(`${this.appHost}/api/series2/episodes?sid=${sid}&refer=${encodeURIComponent(this.defaultRefer)}`, {
            headers: this.getAppHeaders(),
            timeout: 10000,
            retries: 1,
          });
          const data = r?.data;
          return this.normalizeHxqEpisodes(data?.programs || data?.episodes || data?.qxkPrograms || []);
        },
        async () => {
          const r = await httpGet(`${this.appHost}/api/series/programs_v2?sid=${sid}`, {
            headers: this.getAppHeaders(),
            timeout: 10000,
            retries: 1,
          });
          const data = r?.data;
          return this.normalizeHxqEpisodes([
            ...(Array.isArray(data?.programs) ? data.programs : []),
            ...(Array.isArray(data?.qxkPrograms) ? data.qxkPrograms : []),
          ]);
        },
      ];

      let episodes = [];
      for (const attempt of attempts) {
        if (episodes.length > 0) break;
        episodes = await this.tryGet(attempt, []);
      }

      if (episodes.length === 0) {
        log("info", "getHanjutvHxqEpisodes: episodes 不存在");
        return [];
      }

      return episodes.sort((a, b) => a.serialNo - b.serialNo);
    } catch (error) {
      this.logError("getHanjutvHxqEpisodes error", error);
      return [];
    }
  }

  async getTvEpisodes(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return [];

      const episodes = await this.tryGet(async () => {
        const decoded = await this.tvGet(`/api/v1/series/detail/query?sid=${sid}`);
        return this.normalizeTvEpisodes(decoded?.episodes || []);
      }, [], "getHanjutvTvEpisodes error");

      if (episodes.length === 0) {
        log("info", "getHanjutvTvEpisodes: episodes 不存在");
        return [];
      }

      return episodes.sort((a, b) => a.serialNo - b.serialNo);
    } catch (error) {
      this.logError("getHanjutvTvEpisodes error", error);
      return [];
    }
  }

  resolveAnimeYear(anime, ...details) {
    const candidates = [
      anime?.updateTime,
      anime?.publishTime,
      ...details.map(item => item?.updateTime),
      ...details.map(item => item?.publishTime),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const parsed = new Date(candidate);
      const year = parsed.getFullYear();
      if (Number.isFinite(year) && year > 1900) return year;
    }

    return new Date().getFullYear();
  }

  buildEpisodeTitle(serialNo, rawTitle = "") {
    const title = String(rawTitle || "").trim();
    return title ? `第${serialNo}集：${title}` : `第${serialNo}集`;
  }

  buildEpisodeLink(hxqEpisode, tvEpisode) {
    const serialNo = hxqEpisode?.serialNo ?? tvEpisode?.serialNo ?? 1;
    const title = this.buildEpisodeTitle(serialNo, hxqEpisode?.title || tvEpisode?.title || "");

    let url = "";
    if (hxqEpisode?.pid && tvEpisode?.eid) {
      const mergedId = encodeMergedHanjutvEpisodeDanmuId(hxqEpisode.pid, tvEpisode.eid);
      url = mergedId ? `hanjutv:${mergedId}` : "";
    } else if (hxqEpisode?.pid) {
      url = `hxq:${hxqEpisode.pid}`;
    } else if (tvEpisode?.eid) {
      url = `tv:${tvEpisode.eid}`;
    }

    if (!url) return null;

    return { name: title, url, title: `【hanjutv】 ${title}` };
  }

  mergeVariantEpisodes(hxqEpisodes = [], tvEpisodes = []) {
    const hxqMap = new Map(hxqEpisodes.map(item => [Number(item.serialNo), item]));
    const tvMap = new Map(tvEpisodes.map(item => [Number(item.serialNo), item]));
    const serialNos = Array.from(new Set([
      ...hxqMap.keys(),
      ...tvMap.keys(),
    ])).filter(Number.isFinite).sort((a, b) => a - b);

    return serialNos
      .map(serialNo => this.buildEpisodeLink(hxqMap.get(serialNo), tvMap.get(serialNo)))
      .filter(Boolean);
  }

  buildAnimeSummary(anime, detail, links, animeId) {
    const category = this.getCategory(detail?.category ?? anime?.category);
    const year = this.resolveAnimeYear(anime, detail);
    return {
      animeId,
      bangumiId: String(animeId),
      animeTitle: `${anime.name}(${year})【${category}】from hanjutv`,
      type: category,
      typeDescription: category,
      imageUrl: anime?.image?.thumb || "",
      startDate: generateValidStartDate(year),
      episodeCount: links.length,
      rating: Number(detail?.rank ?? 0),
      isFavorited: true,
      source: "hanjutv",
    };
  }

  async getHxqBundle(sid) {
    if (!sid) return { detail: null, episodes: [] };
    const [detail, episodes] = await Promise.all([this.getHxqDetail(sid), this.getHxqEpisodes(sid)]);
    return { detail, episodes };
  }

  async getTvBundle(sid) {
    if (!sid) return { detail: null, episodes: [] };
    const [detail, episodes] = await Promise.all([this.getTvDetail(sid), this.getTvEpisodes(sid)]);
    return { detail, episodes };
  }

  async buildAnimePayload(anime) {
    const variant = anime?._variant || HANJUTV_VARIANTS.HXQ;
    const hxqSid = String(anime?.sid || "").trim();
    const tvSid = String(anime?.tvSid || "").trim();
    const tvLookupSid = String(tvSid || hxqSid || "").trim();
    const parsedAnimeId = Number(anime?.animeId);
    const stableMergedAnimeId = variant === HANJUTV_VARIANTS.MERGED && hxqSid && tvSid
      ? ((Number.isFinite(parsedAnimeId) && parsedAnimeId > 0) ? parsedAnimeId : convertToAsciiSum(`hxq:${hxqSid}|tv:${tvSid}`))
      : null;
    const needsHxqBundle = (variant === HANJUTV_VARIANTS.HXQ || variant === HANJUTV_VARIANTS.MERGED) && hxqSid;
    const needsTvBundle = (variant === HANJUTV_VARIANTS.TV || variant === HANJUTV_VARIANTS.MERGED) && tvLookupSid;
    const [hxqBundle, tvBundle] = await Promise.all([
      needsHxqBundle ? this.getHxqBundle(hxqSid) : Promise.resolve({ detail: null, episodes: [] }),
      needsTvBundle ? this.getTvBundle(tvLookupSid) : Promise.resolve({ detail: null, episodes: [] }),
    ]);

    if (variant === HANJUTV_VARIANTS.MERGED && hxqSid && tvSid) {
      const links = this.mergeVariantEpisodes(hxqBundle.episodes, tvBundle.episodes);
      if (links.length > 0) {
        const detail = hxqBundle.detail?.category
          ? hxqBundle.detail
          : (tvBundle.detail?.category ? tvBundle.detail : (hxqBundle.detail || tvBundle.detail));
        return { summary: this.buildAnimeSummary(anime, detail, links, stableMergedAnimeId), links };
      }
    }

    if ((variant === HANJUTV_VARIANTS.HXQ || variant === HANJUTV_VARIANTS.MERGED) && hxqSid) {
      const links = hxqBundle.episodes.map(ep => this.buildEpisodeLink(ep, null)).filter(Boolean);
      if (links.length > 0) {
        return {
          summary: this.buildAnimeSummary(
            anime,
            hxqBundle.detail,
            links,
            stableMergedAnimeId ?? convertToAsciiSum(hxqSid),
          ),
          links,
        };
      }
    }

    if ((variant === HANJUTV_VARIANTS.TV || variant === HANJUTV_VARIANTS.MERGED) && tvLookupSid) {
      const links = tvBundle.episodes.map(ep => this.buildEpisodeLink(null, ep)).filter(Boolean);
      if (links.length > 0) {
        return {
          summary: this.buildAnimeSummary(
            anime,
            tvBundle.detail,
            links,
            stableMergedAnimeId ?? convertToAsciiSum(tvLookupSid),
          ),
          links,
        };
      }
    }

    return null;
  }

  // ── 番剧处理 ─────────────────────────────────────────────────

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null) {
    if (!Array.isArray(sourceAnimes)) {
      log("error", "[Hanjutv] sourceAnimes is not a valid array");
      return [];
    }

    const tmpAnimes = [];

    await Promise.all(
      sourceAnimes
        .filter(s => titleMatches(s.name, queryTitle))
        .map(async (anime) => {
          try {
            const payload = await this.buildAnimePayload(anime);
            if (!payload || !payload.summary || !Array.isArray(payload.links) || payload.links.length === 0) return;

            tmpAnimes.push(payload.summary);
            addAnime({ ...payload.summary, links: payload.links }, detailStore);
            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          } catch (error) {
            log("error", `[Hanjutv] Error processing anime: ${error.message}`);
          }
        })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return tmpAnimes;
  }

  // ── 弹幕 ─────────────────────────────────────────────────────

  async fetchEpisodeDanmuByRef(episodeRef) {
    const episodeId = String(episodeRef?.id || "").trim();
    if (!episodeId) return [];

    let allDanmus = [];

    if (!episodeRef.preferTv) {
      const headers = this.getDanmuHeaders();

      for (const danmuHost of this.danmuHosts) {
        const hostDanmus = [];
        try {
          let prevId = 0;
          let fromAxis = 0;
          let toAxis = DANMU_WINDOW_MS;
          let pageCount = 0;
          const maxPages = 240;

          while (fromAxis < MAX_AXIS && pageCount < maxPages) {
            const resp = await httpGet(`${danmuHost}/api/danmu/playItem/list?pid=${episodeId}&prevId=${prevId}&fromAxis=${fromAxis}&toAxis=${toAxis}&offset=0`, {
              headers,
              timeout: 10000,
              retries: 1,
            });

            pageCount++;
            const pageDanmus = Array.isArray(resp?.data?.danmus) ? resp.data.danmus : [];
            if (pageDanmus.length > 0) hostDanmus.push(...pageDanmus);

            const hasMore = Number(resp?.data?.more ?? 0) === 1 || resp?.data?.more === true || resp?.data?.more === "1";
            const nextAxis = Number(resp?.data?.nextAxis ?? MAX_AXIS);
            const lastId = Number(resp?.data?.lastId ?? prevId);

            if (!Number.isFinite(nextAxis) || nextAxis <= fromAxis || nextAxis >= MAX_AXIS) break;

            if (Number.isFinite(lastId) && lastId > prevId) prevId = lastId;
            fromAxis = nextAxis;

            if (hasMore) {
              continue;
            }

            if (pageDanmus.length === 0) break;
            toAxis = fromAxis + DANMU_WINDOW_MS;
          }

          if (hostDanmus.length > 0) {
            allDanmus = hostDanmus;
            break;
          }
        } catch (error) {
          this.logError(`fetchHanjutvEpisodeDanmu(韩小圈弹幕:${danmuHost})`, error);
          if (hostDanmus.length > 0) {
            allDanmus = hostDanmus;
            break;
          }
        }
      }
    }

    if (allDanmus.length === 0) {
      let prevId = 0;
      let fromAxis = 0;
      let pageCount = 0;
      const maxPages = 120;

      while (fromAxis < MAX_AXIS && pageCount < maxPages) {
        try {
          const data = await this.tvGet(`/api/v1/bulletchat/episode/get?eid=${episodeId}&prevId=${prevId}&fromAxis=${fromAxis}&toAxis=${MAX_AXIS}&offset=0`);

          pageCount++;
          const pageDanmus = Array.isArray(data?.bulletchats) ? data.bulletchats : [];
          if (pageDanmus.length > 0) allDanmus.push(...pageDanmus);

          const hasMore = Number(data.more ?? 0) === 1 || data.more === true || data.more === "1";
          const nextAxis = Number(data.nextAxis ?? MAX_AXIS);
          const lastId = Number(data.lastId ?? prevId);

          if (!Number.isFinite(nextAxis) || nextAxis <= fromAxis || nextAxis >= MAX_AXIS) break;

          if (Number.isFinite(lastId) && lastId > prevId) prevId = lastId;
          fromAxis = nextAxis;
          if (!hasMore) prevId = 0;
          if (pageDanmus.length === 0 && !hasMore) break;
        } catch (error) {
          this.logError("fetchHanjutvEpisodeDanmu(TV端)", error);
          break;
        }
      }
    }

    return allDanmus;
  }

  async getEpisodeDanmu(id) {
    const episodeRef = parseHanjutvEpisodeDanmuId(id);
    const refs = Array.isArray(episodeRef?.refs) ? episodeRef.refs.filter(item => item?.id) : [];
    if (refs.length === 0) return [];

    if (refs.length === 1) {
      const comments = await this.fetchEpisodeDanmuByRef(refs[0]);
      return this.attachDanmuSourceLabel(comments, refs[0].rawId);
    }

    const results = await Promise.all(refs.map(ref => this.fetchEpisodeDanmuByRef(ref)));
    return this.attachDanmuSourceLabel(results.flat(), episodeRef.rawId || id);
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取韩剧TV弹幕分段列表...", id);

    return new SegmentListResponse({
      type: "hanjutv",
      duration: 0,
      segmentList: [],
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getEpisodeDanmu(segment.url);
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.did),
      p: `${(c.t / 1000).toFixed(2)},${c.tp === 2 ? 5 : c.tp},${Number(c.sc)},[${c._sourceLabel || "hanjutv"}]`,
      m: c.con,
      t: Math.round(c.t / 1000),
      like: c.lc,
      _sourceLabel: c._sourceLabel,
    }));
  }
}
