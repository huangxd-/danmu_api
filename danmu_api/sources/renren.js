import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { getPathname, httpGet, sortedQueryString, updateQueryString } from "../utils/http-util.js";
import { autoDecode, createHmacSha256 } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";

// =====================
// 获取人人视频弹幕
// =====================
export default class RenrenSource extends BaseSource {
  parseRRSPPFields(pField) {
    const parts = String(pField).split(",");
    const num = (i, cast, dft) => { try { return cast(parts[i]); } catch { return dft; } };
    const timestamp = num(0, parseFloat, 0);
    const mode = num(1, x=>parseInt(x,10),1);
    const size = num(2, x=>parseInt(x,10),25);
    const color = num(3, x=>parseInt(x,10),16777215);
    const userId = parts[6] || "";
    const contentId = parts[7] || `${timestamp}:${userId}`;
    return { timestamp, mode, size, color, userId, contentId };
  }

  generateSignature(method, aliId, ct, cv, timestamp, path, sortedQuery, secret) {
    const signStr = `${method.toUpperCase()}\naliId:${aliId}\nct:${ct}\ncv:${cv}\nt:${timestamp}\n${path}?${sortedQuery}`;
    return createHmacSha256(secret, signStr);
  }

  buildSignedHeaders({ method, url, params = {}, deviceId, token }) {
    const ClientProfile = {
      client_type: "web_pc",
      client_version: "1.0.0",
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    const pathname = getPathname(url);
    const qs = sortedQueryString(params);
    const nowMs = Date.now();
    const SIGN_SECRET = "ES513W0B1CsdUrR13Qk5EgDAKPeeKZY";
    const xCaSign = this.generateSignature(
      method, deviceId, ClientProfile.client_type, ClientProfile.client_version,
      nowMs, pathname, qs, SIGN_SECRET
    );
    return {
      clientVersion: ClientProfile.client_version,
      deviceId,
      clientType: ClientProfile.client_type,
      t: String(nowMs),
      aliId: deviceId,
      umid: deviceId,
      token: token || "",
      cv: ClientProfile.client_version,
      ct: ClientProfile.client_type,
      uet: "9",
      "x-ca-sign": xCaSign,
      Accept: "application/json",
      "User-Agent": ClientProfile.user_agent,
      Origin: ClientProfile.origin,
      Referer: ClientProfile.referer,
    };
  }

  async renrenHttpGet(url, { params = {}, headers = {} } = {}) {
    const u = updateQueryString(url, params)
    const resp = await httpGet(u, {
        headers: headers,
    });
    return resp;
  }

  generateDeviceId() {
    return (Math.random().toString(36).slice(2)).toUpperCase();
  }

  async renrenRequest(method, url, params = {}) {
    const deviceId = this.generateDeviceId();
    const headers = this.buildSignedHeaders({ method, url, params, deviceId });
    const resp = await httpGet(url + "?" + sortedQueryString(params), {
        headers: headers,
    });
    return resp;
  }

  async performNetworkSearch(
    keyword,
    {
      lockRef = null,
      lastRequestTimeRef = { value: 0 },  // 调用方传引用
      minInterval = 500                   // 默认节流间隔（毫秒）
    } = {}
  ) {
    try {
      const url = `https://api.rrmj.plus/m-station/search/drama`;
      const params = { keywords: keyword, size: 20, order: "match", search_after: "", isExecuteVipActivity: true };

      // 🔒 锁逻辑（可选）
      if (lockRef) {
        while (lockRef.value) await new Promise(r => setTimeout(r, 50));
        lockRef.value = true;
      }

      // ⏱️ 节流逻辑（依赖 lastRequestTimeRef）
      const now = Date.now();
      const dt = now - lastRequestTimeRef.value;
      if (dt < minInterval) await new Promise(r => setTimeout(r, minInterval - dt));

      const resp = await this.renrenRequest("GET", url, params);
      lastRequestTimeRef.value = Date.now(); // 更新引用

      if (lockRef) lockRef.value = false;

      if (!resp.data) return [];

      const decoded = autoDecode(resp.data);
      const list = decoded?.data?.searchDramaList || [];
      return list.map((item, idx) => ({
        provider: "renren",
        mediaId: String(item.id),
        title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
        type: "tv_series",
        season: null,
        year: item.year,
        imageUrl: item.cover,
        episodeCount: item.episodeTotal,
        currentEpisodeIndex: null,
      }));
    } catch (error) {
      log("error", "getRenrenAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async search(keyword) {
    const parsedKeyword = { title: keyword, season: null }; // 简化 parse_search_keyword
    const searchTitle = parsedKeyword.title;
    const searchSeason = parsedKeyword.season;

    const lock = { value: false };
    const lastRequestTime = { value: 0 };
    let allResults = await this.performNetworkSearch(searchTitle, { lockRef: lock, lastRequestTimeRef: lastRequestTime, minInterval: 400 });

    if (searchSeason == null) return allResults;

    // 按 season 过滤
    return allResults.filter(r => r.season === searchSeason);
  }

  async getDetail(id) {
    const url = `https://api.rrmj.plus/m-station/drama/page`;
    const params = { hsdrOpen:0,isAgeLimit:0,dramaId:String(id),hevcOpen:1 };
    const resp = await this.renrenRequest("GET", url, params);
    if (!resp.data) return null;
    const decoded = autoDecode(resp.data);
    return decoded?.data || null;
  }

  async getEpisodes(id) {
    const detail = await this.getDetail(id);
    if (!detail || !detail.episodeList) return [];

    let episodes = [];
    detail.episodeList.forEach((ep, idx)=>{
      const sid = String(ep.sid || "").trim();
      if(!sid) return;
      const title = String(ep.title || `第${idx+1}`.padStart(2,"0")+"集");
      episodes.push({ sid, order: idx+1, title });
    });

    return episodes.map(e=>({
      provider: "renren",
      episodeId: e.sid,
      title: e.title,
      episodeIndex: e.order,
      url: null
    }));
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processRenrenAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        const eps = await this.getEpisodes(anime.mediaId);
        let links = [];
        for (const ep of eps) {
          links.push({
            "name": ep.episodeIndex,
            "url": ep.episodeId,
            "title": `【${ep.provider}】 ${ep.title}`
          });
        }

        if (links.length > 0) {
          let transformedAnime = {
            animeId: Number(anime.mediaId),
            bangumiId: String(anime.mediaId),
            animeTitle: `${anime.title}(${anime.year})【${anime.type}】from renren`,
            type: anime.type,
            typeDescription: anime.type,
            imageUrl: anime.imageUrl,
            startDate: generateValidStartDate(anime.year),
            episodeCount: links.length,
            rating: 0,
            isFavorited: true,
          };

          tmpAnimes.push(transformedAnime);

          addAnime({...transformedAnime, links: links});

          if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processRenrenAnimes;
  }

  async getEpisodeDanmu(id) {
    const ClientProfile = {
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    const url = `https://static-dm.rrmj.plus/v1/produce/danmu/EPISODE/${id}`;
    const headers = {
      "Accept": "application/json",
      "User-Agent": ClientProfile.user_agent,
      "Origin": ClientProfile.origin,
      "Referer": ClientProfile.referer,
    };
    const resp = await this.renrenHttpGet(url, { headers });
    if (!resp.data) return null;
    const data = autoDecode(resp.data);
    if (Array.isArray(data)) return data;
    if (data?.data && Array.isArray(data.data)) return data.data;
    return null;
  }

  formatComments(comments) {
    return comments.map(item => {
      const text = String(item.d || "");
      const meta = this.parseRRSPPFields(item.p);
      return {
        cid: Number(meta.contentId),
        p: `${meta.timestamp.toFixed(2)},${meta.mode},${meta.color},[renren]`,
        m: text,
        t: meta.timestamp
      };
    });
  }
}