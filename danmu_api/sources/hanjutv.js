import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { createHanjutvUid, createHanjutvSearchHeaders, decodeHanjutvEncryptedPayload } from "../utils/hanjutv-util.js";

// =====================
// 获取韩剧TV弹幕
// =====================
export default class HanjutvSource extends BaseSource {
  constructor() {
    super();
    this.webHost = "https://hxqapi.hiyun.tv";
    this.appHost = "https://hxqapi.hiyun.tv";
    this.oldDanmuHost = "https://hxqapi.zmdcq.com";
    this.defaultRefer = "2JGztvGjRVpkxcr0T4ZWG2k+tOlnHmDGUNMwAGSeq548YV2FMbs0h0bXNi6DJ00L";
    this.webUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
    this.appUserAgent = "HanjuTV/6.8 (23127PN0CC; Android 16; Scale/2.00)";
  }

  getWebHeaders() {
    return {
      "Content-Type": "application/json",
      "User-Agent": this.webUserAgent,
    };
  }

  getAppHeaders() {
    return {
      vc: "a_8260",
      vn: "6.8",
      ch: "xiaomi",
      app: "hj",
      "User-Agent": this.appUserAgent,
      "Accept-Encoding": "gzip",
    };
  }

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
          image: {
            ...imageObj,
            thumb,
          },
        };
      })
      .filter(Boolean);
  }

  normalizeEpisodes(items = []) {
    if (!Array.isArray(items)) return [];

    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const pid = item.pid || item.id || item.programId || item.episodeId;
        if (!pid) return null;

        const serialCandidate = item.serialNo ?? item.serial_no ?? item.sort ?? item.sortNo ?? item.num ?? item.episodeNo ?? (index + 1);
        const serialNo = Number(serialCandidate);

        return {
          ...item,
          pid: String(pid),
          serialNo: Number.isFinite(serialNo) && serialNo > 0 ? serialNo : (index + 1),
          title: item.title || item.name || item.programName || item.episodeTitle || "",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.serialNo - b.serialNo);
  }

  extractSearchItems(data) {
    const list = data?.seriesData?.seriesList || data?.seriesList || [];
    return this.normalizeSearchItems(list);
  }

  dedupeBySid(items = []) {
    const map = new Map();
    for (const item of items) {
      if (!item?.sid) continue;
      const sid = String(item.sid);
      if (!map.has(sid)) map.set(sid, item);
    }
    return Array.from(map.values());
  }

  async searchWithS5Api(keyword) {
    const uid = createHanjutvUid();
    const headers = await createHanjutvSearchHeaders(uid);
    const q = encodeURIComponent(keyword);

    const resp = await httpGet(`https://hxqapi.hiyun.tv/api/search/s5?k=${q}&srefer=search_input&type=0&page=1`, {
      headers,
      timeout: 10000,
      retries: 1,
    });

    const payload = resp?.data;
    if (!payload || typeof payload !== "object") {
      throw new Error("s5 响应为空");
    }

    if (typeof payload.data === "string" && payload.data.length > 0) {
      let decoded;
      try {
        decoded = await decodeHanjutvEncryptedPayload(payload, uid);
      } catch (error) {
        throw new Error(`s5 响应解密失败: ${error.message}`);
      }

      const items = this.extractSearchItems(decoded);
      if (items.length === 0) throw new Error("s5 解密后无有效结果");
      return items;
    }

    const plainItems = this.extractSearchItems(payload);
    if (plainItems.length === 0) throw new Error("s5 无有效结果");
    return plainItems;
  }

  async searchWithLegacyApi(keyword) {
    const q = encodeURIComponent(keyword);
    const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/search/aggregate/search?keyword=${q}&scope=101&page=1`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000,
      retries: 1,
    });
    return this.extractSearchItems(resp?.data);
  }

  async search(keyword) {
    try {
      const key = String(keyword || "").trim();
      if (!key) return [];

      let s5List = [];
      let webList = [];

      try {
        s5List = await this.searchWithS5Api(key);
      } catch (error) {
        log("warn", `[Hanjutv] s5 搜索失败，降级旧接口: ${error.message}`);
      }

      let resultList = this.dedupeBySid(s5List);

      if (resultList.length === 0) {
        try {
          webList = await this.searchWithLegacyApi(key);
        } catch (error) {
          log("warn", `[Hanjutv] 旧搜索接口失败: ${error.message}`);
        }
        resultList = this.dedupeBySid(webList);
      }

      if (resultList.length === 0) {
        log("info", "hanjutvSearchresp: s5 与旧接口均无有效结果");
        return [];
      }

      log("info", `[Hanjutv] 搜索候选统计 s5=${s5List.length}, web=${webList.length}`);
      log("info", `[Hanjutv] 搜索找到 ${resultList.length} 个有效结果`);

      return resultList.map((anime) => {
        const animeId = convertToAsciiSum(anime.sid);
        return { ...anime, animeId };
      });
    } catch (error) {
      log("error", "getHanjutvAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getDetail(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return [];

      let detail = null;

      try {
        const appResp = await httpGet(`${this.appHost}/api/series/detail?sid=${sid}`, {
          headers: this.getAppHeaders(),
          timeout: 10000,
          retries: 1,
        });
        detail = appResp?.data?.series || null;
      } catch {
      }

      if (!detail) {
        try {
          const webResp = await httpGet(`${this.webHost}/wapi/series/series/detail?sid=${sid}`, {
            headers: this.getWebHeaders(),
            timeout: 10000,
            retries: 1,
          });
          detail = webResp?.data?.series || null;
        } catch {
        }
      }

      if (!detail) {
        log("info", "getHanjutvDetail: series 不存在");
        return [];
      }

      return detail;
    } catch (error) {
      log("error", "getHanjutvDetail error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      const sid = String(id || "").trim();
      if (!sid) return [];

      let episodes = [];

      try {
        const detailResp = await httpGet(`${this.appHost}/api/series/detail?sid=${sid}`, {
          headers: this.getAppHeaders(),
          timeout: 10000,
          retries: 1,
        });
        const detailData = detailResp?.data;
        const playItems = Array.isArray(detailData?.playItems) ? detailData.playItems : [];
        episodes = this.normalizeEpisodes(playItems);
      } catch {
      }

      if (episodes.length === 0) {
        try {
          const epResp = await httpGet(`${this.appHost}/api/series2/episodes?sid=${sid}&refer=${encodeURIComponent(this.defaultRefer)}`, {
            headers: this.getAppHeaders(),
            timeout: 10000,
            retries: 1,
          });
          const epData = epResp?.data;
          episodes = this.normalizeEpisodes(epData?.programs || epData?.episodes || epData?.qxkPrograms || []);
        } catch {
        }
      }

      if (episodes.length === 0) {
        try {
          const pResp = await httpGet(`${this.appHost}/api/series/programs_v2?sid=${sid}`, {
            headers: this.getAppHeaders(),
            timeout: 10000,
            retries: 1,
          });
          const pData = pResp?.data;
          const programs = [
            ...(Array.isArray(pData?.programs) ? pData.programs : []),
            ...(Array.isArray(pData?.qxkPrograms) ? pData.qxkPrograms : []),
          ];
          episodes = this.normalizeEpisodes(programs);
        } catch {
        }
      }

      if (episodes.length === 0) {
        try {
          const webResp = await httpGet(`${this.webHost}/wapi/series/series/detail?sid=${sid}`, {
            headers: this.getWebHeaders(),
            timeout: 10000,
            retries: 1,
          });
          episodes = this.normalizeEpisodes(webResp?.data?.episodes || []);
        } catch {
        }
      }

      if (episodes.length === 0) {
        log("info", "getHanjutvEposides: episodes 不存在");
        return [];
      }

      return episodes.sort((a, b) => a.serialNo - b.serialNo);
    } catch (error) {
      log("error", "getHanjutvEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const cateMap = {1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧"}

    function getCategory(key) {
      return cateMap[key] || "其他";
    }

    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Hanjutv] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processHanjutvAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.name, queryTitle))
      .map(async (anime) => {
        try {
          const detail = await this.getDetail(anime.sid);
          const eps = await this.getEpisodes(anime.sid);
          let links = [];
          for (const ep of eps) {
            const epTitle = ep.title && ep.title.trim() !== "" ? `第${ep.serialNo}集：${ep.title}` : `第${ep.serialNo}集`;
            links.push({
              "name": epTitle,
              "url": ep.pid,
              "title": `【hanjutv】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: anime.animeId,
              bangumiId: String(anime.animeId),
              animeTitle: `${anime.name}(${new Date(anime.updateTime).getFullYear()})【${getCategory(detail.category)}】from hanjutv`,
              type: getCategory(detail.category),
              typeDescription: getCategory(detail.category),
              imageUrl: anime.image.thumb,
              startDate: generateValidStartDate(new Date(anime.updateTime).getFullYear()),
              episodeCount: links.length,
              rating: detail.rank,
              isFavorited: true,
              source: "hanjutv",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Hanjutv] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processHanjutvAnimes;
  }

  async getEpisodeDanmu(id) {
    let allDanmus = [];
    let fromAxis = 0;
    const maxAxis = 100000000;

    try {
      while (fromAxis < maxAxis) {
        const resp = await httpGet(`https://hxqapi.zmdcq.com/api/danmu/playItem/list?fromAxis=${fromAxis}&pid=${id}&toAxis=${maxAxis}`, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          retries: 1,
        });

        // 将当前请求的 episodes 拼接到总数组
        if (resp.data && resp.data.danmus) {
          allDanmus = allDanmus.concat(resp.data.danmus);
        }

        // 获取 nextAxis，更新 fromAxis
        const nextAxis = resp.data.nextAxis || maxAxis;
        if (nextAxis >= maxAxis) {
          break; // 如果 nextAxis 达到或超过最大值，退出循环
        }
        fromAxis = nextAxis;
      }

      return allDanmus;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "fetchHanjutvEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return allDanmus; // 返回已收集的 episodes
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取韩剧TV弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "hanjutv",
      "segmentList": [{
        "type": "hanjutv",
        "segment_start": 0,
        "segment_end": 30000,
        "url": id
      }]
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getEpisodeDanmu(segment.url);
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.did),
      p: `${(c.t / 1000).toFixed(2)},${c.tp === 2 ? 5 : c.tp},${Number(c.sc)},[hanjutv]`,
      m: c.lc ? `${c.con} 👍${c.lc}` : c.con,
      t: Math.round(c.t / 1000)
    }));
  }
}
