import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { getPathname, httpGet, sortedQueryString, updateQueryString } from "../utils/http-util.js";
import { autoDecode, createHmacSha256, generateRandomSid, generateSign, generateXCaSign } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取人人视频弹幕
// =====================
export default class RenrenSource extends BaseSource {
  API_CONFIG = {
    SECRET_KEY: "cf65GPholnICgyw1xbrpA79XVkizOdMq",
    SEARCH_HOST: "api.qwdjapp.com",
    DRAMA_HOST: "api.zhimeisj.top",
    DANMU_HOST: "static-dm.qwdjapp.com",
    APP_VERSION: "10.31.2",
    USER_AGENT: 'Mozilla/5.0 (Linux; Android 16; 23127PN0CC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.146 Mobile Safari/537.36 App/RRSPApp platform/android AppVersion/10.31.2'
  };

  generateAppCommonHeaders(timestamp, sign, xCaSign = null) {
    const headers = {
      'User-Agent': this.API_CONFIG.USER_AGENT,
      'deviceId': 'T2%2Bjh%2FnHhJkWEzPnQT2E0%2FEw865FTT0uL%2BiBwRa2ZdM%3D',
      'aliId': 'aUzmLtnZIYoDAA9KyLdcLQpM',
      'umId': '53e0f078fa8474ae7ba412f766989b54od',
      'clientType': 'android_rrsp_xb_XiaoMi',
      't': timestamp.toString(),
      'sign': sign,
      'isAgree': '1',
      'cv': this.API_CONFIG.APP_VERSION,
      'ct': 'android_rrsp_xb_XiaoMi',
      'pkt': 'rrmj',
      'p': 'Android',
      'wcode': '3',
      'et': '2',
      'uet': '1',
      'folding-screen': '1',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'Connection': 'close'
    };

    if (xCaSign) {
      headers['x-ca-sign'] = xCaSign;
      headers['x-ca-method'] = '1';
    }

    return headers;
  }

  async searchAppContent(keyword, size = 15) {
    try {
      const timestamp = Date.now();
      const path = "/search/content";
      const queryParams = {
        keywords: keyword,
        size: size,
        search_after: "",
        order: "match",
        isAgeLimit: false
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);

      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === null || v === undefined ? "" : String(v))}`)
        .join('&');

      const xCaSign = generateXCaSign(path, timestamp, queryString, this.API_CONFIG.SECRET_KEY);

      const headers = this.generateAppCommonHeaders(timestamp, sign, xCaSign);
      headers['Host'] = this.API_CONFIG.SEARCH_HOST;
      headers['Origin'] = 'https://d.rrsp.com.cn';
      headers['Referer'] = 'https://d.rrsp.com.cn/';

      const resp = await httpGet(`https://${this.API_CONFIG.SEARCH_HOST}${path}?${queryString}`, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data) return [];

      // 服务端明确提示"版本过低/强制更新"时：直接返回空，让上层走备用搜索
      if (resp?.data?.code === "0001") return [];

      const list = resp?.data?.data?.searchDramaList || [];
      return list.map((item) => ({
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
      const msg = String(error?.message || "");
      const is418 = /status:\s*418\b/.test(msg);

      if (is418) {
        log("warn", "[Renren] /search/content 被服务端拦截 (418)，已降级为备用搜索接口");
        return [];
      }

      log("error", "[Renren] searchAppContent error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getAppDramaDetail(dramaId, episodeSid = "") {
    try {
      if (!episodeSid) episodeSid = generateRandomSid();

      const timestamp = Date.now();
      const path = "/app/drama/page";
      const queryParams = {
        isAgeLimit: false,
        dramaId: dramaId,
        episodeSid: episodeSid,
        quality: "SD",
        subtitle: 3,
        hsdrOpen: 1,
        hevcOpen: 1,
        tria4k: 1
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      const headers = this.generateAppCommonHeaders(timestamp, sign);
      headers['Host'] = this.API_CONFIG.DRAMA_HOST;
      headers['ignore'] = 'false';

      const resp = await httpGet(`https://${this.API_CONFIG.DRAMA_HOST}${path}?${queryString}`, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data) return null;

      return resp.data;
    } catch (error) {
      log("error", "[Renren] getAppDramaDetail error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return null;
    }
  }

  // ========== 弹幕API ==========
  async getAppDanmu(episodeSid) {
    try {
      const timestamp = Date.now();
      const path = `/v1/produce/danmu/emo/EPISODE/${episodeSid}`;

      const sign = generateSign(path, timestamp, {}, this.API_CONFIG.SECRET_KEY);
      const xCaSign = generateXCaSign(path, timestamp, "", this.API_CONFIG.SECRET_KEY);

      const headers = this.generateAppCommonHeaders(timestamp, sign, xCaSign);
      headers['Host'] = this.API_CONFIG.DANMU_HOST;

      const resp = await httpGet(`https://${this.API_CONFIG.DANMU_HOST}${path}`, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data) return null;

      return resp.data;
    } catch (error) {
      log("error", "[Renren] getAppDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return null;
    }
  }

  parseRRSPPFields(pField) {
    const parts = String(pField).split(",");
    const num = (i, cast, dft) => { 
      try { return cast(parts[i]); } 
      catch { return dft; } 
    };
    const timestamp = num(0, parseFloat, 0);
    const mode = num(1, x => parseInt(x, 10), 1);
    const size = num(2, x => parseInt(x, 10), 25);
    const color = num(3, x => parseInt(x, 10), 16777215);
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
    const u = updateQueryString(url, params);
    const resp = await httpGet(u, {
      headers: headers,
      retries: 1,
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
      retries: 1,
    });
    return resp;
  }

  async performNetworkSearch(keyword, { lockRef = null, lastRequestTimeRef = { value: 0 }, minInterval = 500 } = {}) {
    try {
      const url = `https://api.rrmj.plus/m-station/search/drama`;
      const params = { 
        keywords: keyword, 
        size: 20, 
        order: "match", 
        search_after: "", 
        isExecuteVipActivity: true 
      };

      if (lockRef) {
        while (lockRef.value) await new Promise(r => setTimeout(r, 50));
        lockRef.value = true;
      }

      const now = Date.now();
      const dt = now - lastRequestTimeRef.value;
      if (dt < minInterval) await new Promise(r => setTimeout(r, minInterval - dt));

      const resp = await this.renrenRequest("GET", url, params);
      lastRequestTimeRef.value = Date.now();

      if (lockRef) lockRef.value = false;

      if (!resp.data) return [];

      const decoded = autoDecode(resp.data);
      const list = decoded?.data?.searchDramaList || [];
      return list.map((item) => ({
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
      log("error", "[Renren] performNetworkSearch error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async search(keyword) {
    const parsedKeyword = { title: keyword, season: null };
    const searchTitle = parsedKeyword.title;
    const searchSeason = parsedKeyword.season;

    let allResults = [];
    
    // 优先使用 APP 接口搜索
    // allResults = await this.searchAppContent(searchTitle);
    
    // APP 接口失败时降级到网页接口
    if (allResults.length === 0) {
      log("info", "[Renren] APP 搜索无结果，降级到网页接口");
      const lock = { value: false };
      const lastRequestTime = { value: 0 };
      allResults = await this.performNetworkSearch(searchTitle, { 
        lockRef: lock, 
        lastRequestTimeRef: lastRequestTime, 
        minInterval: 400 
      });
    }

    if (searchSeason == null) return allResults;

    return allResults.filter(r => r.season === searchSeason);
  }

  async getDetail(id) {
    // 优先使用 APP 接口
    // const resp = await this.getAppDramaDetail(String(id));
    // if (resp) {
    //   return resp.data;
    // }
    
    // // APP 接口失败时降级到网页接口
    // log("info", "[Renren] APP 详情接口失败，降级到网页接口");
    const url = `https://api.rrmj.plus/m-station/drama/page`;
    const params = { hsdrOpen: 0, isAgeLimit: 0, dramaId: String(id), hevcOpen: 1 };
    const fallbackResp = await this.renrenRequest("GET", url, params);
    if (!fallbackResp.data) return null;
    const decoded = autoDecode(fallbackResp.data);
    return decoded?.data || null;
  }

  async getEpisodes(id) {
    const detail = await this.getDetail(id);
    if (!detail || !detail.episodeList) return [];

    let episodes = [];
    detail.episodeList.forEach((ep, idx) => {
      const sid = String(ep.sid || "").trim();
      if (!sid) return;
      const title = String(ep.title || `第${String(idx + 1).padStart(2, "0")}集`);
      episodes.push({ sid, order: idx + 1, title });
    });

    return episodes.map(e => ({
      provider: "renren",
      episodeId: e.sid,
      title: e.title,
      episodeIndex: e.order,
      url: null
    }));
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Renren] sourceAnimes is not a valid array");
      return [];
    }

    await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          let links = [];
          for (const ep of eps) {
            links.push({
              "name": ep.episodeIndex.toString(),
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
              source: "renren",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({ ...transformedAnime, links: links });

            if (globals.animes.length > globals.MAX_ANIMES) {
              removeEarliestAnime();
            }
          }
        } catch (error) {
          log("error", `[Renren] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  async getEpisodeDanmu(id) {
    // 优先使用 APP 接口
    // const resp = await this.getAppDanmu(id);
    // if (resp) {
    //   return resp;
    // }

    // // APP 接口失败时降级到网页接口
    // log("info", "[Renren] APP 弹幕接口失败，降级到网页接口");
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
    
    const fallbackResp = await this.renrenHttpGet(url, { headers });
    if (!fallbackResp.data) return null;
    
    const data = autoDecode(fallbackResp.data);
    if (Array.isArray(data)) return data;
    if (data?.data && Array.isArray(data.data)) return data.data;
    return null;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "[Renren] 获取弹幕分段列表:", id);

    return new SegmentListResponse({
      "type": "renren",
      "segmentList": [{
        "type": "renren",
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