import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, httpGetWithStreamCheck } from "../utils/http-util.js";
import { parseDanmakuBase64, md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { simplized } from "../utils/zh-util.js";
import { getTmdbJaOriginalTitle, smartTitleReplace } from "../utils/tmdb-util.js";

// =====================
// 获取b站弹幕
// =====================
export default class BilibiliSource extends BaseSource {
  // WBI 签名相关常量
  static WBI_MIXIN_KEY_CACHE = { key: null, timestamp: 0 };
  static WBI_MIXIN_KEY_CACHE_TTL = 3600; // 缓存1小时
  static WBI_MIXIN_KEY_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  // APP 签名相关常量 (Android 粉版 - 港澳台搜索用)
  static APP_KEY = '1d8b6e7d45233436';
  static APP_SEC = '560c52ccd288fed045859ed18bffd973';

  // 解析 b23.tv 短链接
  async resolveB23Link(shortUrl) {
    try {
      log("info", `正在解析 b23.tv 短链接: ${shortUrl}`);

      // 设置超时时间（默认5秒）
      const timeout = parseInt(globals.vodRequestTimeout);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // 使用原生 fetch 获取重定向后的 URL
      // fetch 默认会自动跟踪重定向，response.url 会是最终的 URL
      const response = await httpGet(shortUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        signal: controller.signal,
        redirect: 'follow'
      });

      clearTimeout(timeoutId);

      // 获取最终的 URL（重定向后的 URL）
      const finalUrl = response.url;
      if (finalUrl && finalUrl !== shortUrl) {
        log("info", `b23.tv 短链接已解析为: ${finalUrl}`);
        return finalUrl;
      }

      log("error", "无法解析 b23.tv 短链接");
      return shortUrl; // 如果解析失败，返回原 URL
    } catch (error) {
      log("error", "解析 b23.tv 短链接失败:", error);
      return shortUrl; // 如果出错，返回原 URL
    }
  }

  /**
   * 获取 WBI mixin key（带缓存）
   */
  async _getWbiMixinKey() {
    const now = Math.floor(Date.now() / 1000);
    const cache = BilibiliSource.WBI_MIXIN_KEY_CACHE;

    if (cache.key && (now - cache.timestamp < BilibiliSource.WBI_MIXIN_KEY_CACHE_TTL)) {
      return cache.key;
    }

    log("info", "[Bilibili] WBI mixin key 已过期或不存在，正在获取新的...");

    try {
      const navResp = await httpGet("https://api.bilibili.com/x/web-interface/nav", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bilibili.com/",
          "Cookie": globals.bilibliCookie || ""
        }
      });

      const data = typeof navResp.data === "string" ? JSON.parse(navResp.data) : navResp.data;

      if (data.code !== 0) {
        log("error", "[Bilibili] 获取 WBI 密钥失败:", data.message);
        return "dba4a5925b345b4598b7452c75070bca"; // Fallback
      }

      const wbiImg = data.data?.wbi_img || {};
      const imgUrl = wbiImg.img_url || "";
      const subUrl = wbiImg.sub_url || "";

      const imgKey = imgUrl.split('/').pop()?.split('.')[0] || "";
      const subKey = subUrl.split('/').pop()?.split('.')[0] || "";

      const mixinKey = BilibiliSource.WBI_MIXIN_KEY_TABLE
        .map(i => (imgKey + subKey)[i])
        .join('')
        .substring(0, 32);

      cache.key = mixinKey;
      cache.timestamp = now;

      log("info", "[Bilibili] 成功获取新的 WBI mixin key");
      return mixinKey;
    } catch (error) {
      log("error", "[Bilibili] 获取 WBI 密钥失败:", error.message);
      return "dba4a5925b345b4598b7452c75070bca"; // Fallback
    }
  }

  /**
   * 对参数进行 WBI 签名
   */
  _getWbiSignedParams(params, mixinKey) {
    const signedParams = { ...params };
    signedParams.wts = Math.floor(Date.now() / 1000);

    // 按键名排序
    const sortedKeys = Object.keys(signedParams).sort();
    const queryParts = sortedKeys.map(key => {
      const value = signedParams[key] ?? "";
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    });

    const query = queryParts.join('&');
    const signedQuery = query + mixinKey;
    const wRid = md5(signedQuery);

    signedParams.w_rid = wRid;
    return signedParams;
  }

  /**
   * 按类型搜索
   */
  async _searchByType(keyword, searchType, mixinKey) {
    try {
      log("info", `[Bilibili] 搜索类型 '${searchType}'，关键词 '${keyword}'`);

      const searchParams = { keyword, search_type: searchType };
      const signedParams = this._getWbiSignedParams(searchParams, mixinKey);

      const queryString = Object.keys(signedParams)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(signedParams[key])}`)
        .join('&');

      const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${queryString}`;

      const response = await httpGet(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bilibili.com/",
          "Cookie": globals.bilibliCookie || ""
        }
      });

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.code !== 0 || !data.data?.result) {
        log("info", `[Bilibili] 类型 '${searchType}' 无结果 (Code: ${data.code})`);
        return [];
      }

      const results = [];
      for (const item of data.data.result) {
        const mediaId = item.season_id ? `ss${item.season_id}` : item.bvid ? `bv${item.bvid}` : "";
        if (!mediaId) continue;

        // 提取媒体类型（参考 bilibili.py 和优化后的 youku.js）
        const mediaType = this._extractMediaType(item.season_type_name);
        const episodeCount = mediaType === "电影" ? 1 : (item.ep_size || 0);

        // 提取年份
        let year = null;
        try {
          if (item.pubdate) {
            if (typeof item.pubdate === 'number') {
              year = new Date(item.pubdate * 1000).getFullYear();
            } else if (typeof item.pubdate === 'string' && item.pubdate.length >= 4) {
              year = parseInt(item.pubdate.substring(0, 4));
            }
          } else if (item.pubtime) {
            year = new Date(item.pubtime * 1000).getFullYear();
          }
        } catch (e) {
          // 忽略年份解析错误
        }

        // 清理标题
        const cleanedTitle = (item.title || "")
          .replace(/<[^>]+>/g, '')  // 移除 HTML 标签
          .replace(/&[^;]+;/g, match => {  // 解码 HTML 实体
            const entities = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
            return entities[match] || match;
          })
          .replace(/:/g, '：')
          .trim();

		// 清洗原标题
        const cleanedOrgTitle = (item.org_title || "")
          .replace(/<[^>]+>/g, '')
          .replace(/&[^;]+;/g, match => {
            const entities = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
            return entities[match] || match;
          })
          .trim();

        const resultItem = {
          provider: "bilibili",
          mediaId,
          title: cleanedTitle,
		  org_title: cleanedOrgTitle,
          type: mediaType,
          year,
          imageUrl: item.cover || null,
          episodeCount
        };

        // 如果搜索结果自带分集信息（Web端特性），挂载到对象上
        if (item.eps && item.eps.length > 0) {
            resultItem._eps = item.eps;
        }

        results.push(resultItem);
      }

      log("info", `[Bilibili] 类型 '${searchType}' 找到 ${results.length} 个结果`);
      return results;
    } catch (error) {
      log("error", `[Bilibili] 搜索类型 '${searchType}' 失败:`, error.message);
      return [];
    }
  }

  /**
   * 从 season_type_name 提取媒体类型
   * B站 API 返回的类型包括：电影、番剧、国创、纪录片、综艺、电视剧等
   * @param {string} seasonTypeName - API 返回的 season_type_name
   * @returns {string} 标准化的媒体类型
   */
  _extractMediaType(seasonTypeName) {
    const typeName = (seasonTypeName || "").toLowerCase();
    
    // 电影类型
    if (typeName.includes("电影") || typeName.includes("movie")) {
      return "电影";
    }
    
    // 动漫类型（包括番剧和国创）
    if (typeName.includes("番剧") || typeName.includes("国创") || 
        typeName.includes("动漫") || typeName.includes("anime")) {
      return "动漫";
    }
    
    // 纪录片类型
    if (typeName.includes("纪录片") || typeName.includes("documentary")) {
      return "纪录片";
    }
    
    // 综艺类型
    if (typeName.includes("综艺") || typeName.includes("variety")) {
      return "综艺";
    }
    
    // 电视剧类型
    if (typeName.includes("电视剧") || typeName.includes("剧集") || 
        typeName.includes("drama") || typeName.includes("tv")) {
      return "电视剧";
    }
    
    // 默认返回电视剧（最常见的类型）
    return "电视剧";
  }

  async search(keyword) {
    try {
      log("info", `[Bilibili] 开始搜索: ${keyword}`);

      const mixinKey = await this._getWbiMixinKey();
      const searchTypes = ["media_bangumi", "media_ft"];

      const searchPromises = searchTypes.map(type => this._searchByType(keyword, type, mixinKey));
      const tasks = [...searchPromises];

      // 检测到代理配置时，启用港澳台并行搜索
      if (this._hasBilibiliProxy()) {
        log("info", `[Bilibili] 检测到代理配置，启用港澳台并行搜索`);
        tasks.push(this._searchOversea(keyword));
      }

      const results = await Promise.all(tasks);

      // 合并结果并去重
      const allResults = results.flat();
      const uniqueResults = [];
      const seenIds = new Set();

      for (const item of allResults) {
        if (!seenIds.has(item.mediaId)) {
          seenIds.add(item.mediaId);
          uniqueResults.push(item);
        }
      }

      log("info", `[Bilibili] 搜索完成，找到 ${uniqueResults.length} 个有效结果`);
      return uniqueResults;
    } catch (error) {
      log("error", "[Bilibili] 搜索出错:", error.message);
      return [];
    }
  }

  /**
   * 获取番剧分集列表
   */
  async _getPgcEpisodes(seasonId) {
    let rawEpisodes = [];
    // 增加 Section 接口作为回退，解决港澳台个别条目分集不显式输出
    const apis = [
        `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`,
        `https://api.bilibili.com/pgc/web/season/section?season_id=${seasonId}`
    ];

    for (const url of apis) {
        try {
            const response = await httpGet(url, {
                headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://www.bilibili.com/",
                "Cookie": globals.bilibliCookie || ""
                }
            });
    
            const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    
            if (data.code === 0 && data.result) {
                // 优先从 main_section 获取分集，兼容 view 和 section 接口
                rawEpisodes = data.result.main_section?.episodes || data.result.episodes || [];
                if (rawEpisodes.length > 0) break;
            }
        } catch(e) {
            // 忽略错误，尝试下一个接口
        }
    }

    if (rawEpisodes.length === 0) {
        log("error", `[Bilibili] 获取番剧分集失败 (season_id=${seasonId}): 所有接口均无数据`);
        return [];
    }

    const episodes = rawEpisodes.map((ep, index) => ({
        vid: `${ep.aid},${ep.cid}`,
        id: ep.id,
        title: (ep.show_title || ep.long_title || ep.title || `第${index + 1}集`).trim(),
        link: `https://www.bilibili.com/bangumi/play/ep${ep.id}`
    }));

    log("info", `[Bilibili] 获取到 ${episodes.length} 个番剧分集`);
    return episodes;
  }

  /**
   * 获取普通视频分集列表
   */
  async _getUgcEpisodes(bvid) {
    try {
      const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

      const response = await httpGet(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bilibili.com/",
          "Cookie": globals.bilibliCookie || ""
        }
      });

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.code !== 0 || !data.data) {
        log("error", `[Bilibili] 获取视频分集失败 (bvid=${bvid}):`, data.message);
        return [];
      }

      const pages = data.data.pages || [];

      if (pages.length === 0) {
        log("info", `[Bilibili] 视频 bvid=${bvid} 无分集数据`);
        return [];
      }

      const episodes = pages.map((page, index) => ({
        vid: `${data.data.aid},${page.cid}`,
        id: page.cid,
        title: (page.part || `P${page.page}`).trim(),
        link: `https://www.bilibili.com/video/${bvid}?p=${page.page}`
      }));

      log("info", `[Bilibili] 获取到 ${episodes.length} 个视频分集`);
      return episodes;
    } catch (error) {
      log("error", `[Bilibili] 获取视频分集出错 (bvid=${bvid}):`, error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    if (id.startsWith('ss')) {
      const seasonId = id.substring(2);
      return await this._getPgcEpisodes(seasonId);
    } else if (id.startsWith('bv')) {
      const bvid = id.substring(2);
      return await this._getUgcEpisodes(bvid);
    }

    log("error", `[Bilibili] 不支持的 ID 格式: ${id}`);
    return [];
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Bilibili] sourceAnimes is not a valid array");
      return [];
    }

    // 应用tmdb智能标题替换
    const cnAlias = sourceAnimes.length > 0 ? sourceAnimes[0]._tmdbCnAlias : null;
    smartTitleReplace(sourceAnimes, cnAlias);

    const processPromises = sourceAnimes
      // 港澳台资源不做严格标题匹配，因为可能搜到的是日语/繁体标题
      .filter(anime => anime.isOversea || titleMatches(anime.title, queryTitle)||(anime.org_title && titleMatches(anime.org_title, queryTitle)))
      .map(async (anime) => {
        try {
          let links = [];

          // 如果 content 包含"查看全部"，说明搜索结果给的 eps 是残缺预览调用 getEpisodes 获取完整列表
          const isIncomplete = anime.checkMore?.content?.includes("查看全部");

          // 优先使用搜索结果中自带的分集信息 (港澳台/WBI结果)
          if (anime._eps && anime._eps.length > 0 && !isIncomplete) {
             links = anime._eps.map((ep, index) => {
               let realVal;
               if (anime.isOversea && ep.position) {
                   realVal = ep.position.toString();
               } else {
                   realVal = ep.index_title || ep.index || (index + 1).toString();
               }

               const epIndex = ep.title || ep.index_title || realVal;
               const longTitle = ep.long_title || "";
               
               let displayTitle = /^\d+(\.\d+)?$/.test(epIndex) ? `第${epIndex}话` : epIndex;
               if (longTitle && longTitle !== epIndex) displayTitle += ` ${longTitle}`;

               const epId = ep.id || ep.param;
               let linkUrl = `https://www.bilibili.com/bangumi/play/ep${epId}?season_id=${anime.mediaId.substring(2)}`;
               
               // 传递区域标记，供后续提取视频信息使用
               if (anime.isOversea) linkUrl += "&area=hkmt";

               return {
                 name: realVal,
                 url: linkUrl,
                 title: `【bilibili1】 ${displayTitle.trim()}`
               };
             });

             // 按照提取出的 name (真实集号) 进行升序排列
             links.sort((a, b) => {
                  const numA = parseFloat(a.name);
                  const numB = parseFloat(b.name);
                  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                  return 0;
             });

             log("info", `[Bilibili] 直接使用搜索结果中的 ${links.length} 集分集`);
          } else {
             const eps = await this.getEpisodes(anime.mediaId);
             if (eps.length === 0) {
               log("info", `[Bilibili] ${anime.title} 无分集，跳过`);
               return;
             }
             links = eps.map((ep, index) => {
                let linkUrl = ep.link + `?season_id=${anime.mediaId.substring(2)}`;
                // 传递区域标记
                if (anime.isOversea) linkUrl += "&area=hkmt";
                return {
                    name: `${index + 1}`,
                    url: linkUrl,
                    title: `【bilibili1】 ${ep.title}`
                };
             });
          }

          if (links.length === 0) return;

          const numericAnimeId = convertToAsciiSum(anime.mediaId);
          
          // 优先使用tmdb智能标题替换的标题，否则对原标题进行繁转简处理
          const displayTitle = anime._displayTitle || simplized(anime.title);

          const transformedAnime = {
            animeId: numericAnimeId,
            bangumiId: anime.mediaId,
            animeTitle: `${displayTitle}(${anime.year || 'N/A'})【${anime.type}】from bilibili`,
            type: anime.type,
            typeDescription: anime.type,
            imageUrl: anime.imageUrl,
            startDate: generateValidStartDate(anime.year),
            episodeCount: links.length,
            rating: 0,
            isFavorited: true,
            source: "bilibili",
          };

          tmpAnimes.push(transformedAnime);
          addAnime({ ...transformedAnime, links });

          if (globals.animes.length > globals.MAX_ANIMES) {
            removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Bilibili] 处理 ${anime.title} 失败:`, error.message);
        }
      });

    await Promise.all(processPromises);

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return tmpAnimes;
  }

  // 提取视频信息的公共方法
  async _extractVideoInfo(id) {
    log("info", "提取B站视频信息...", id);

    const api_video_info = "https://api.bilibili.com/x/web-interface/view";
    const api_epid_cid = "https://api.bilibili.com/pgc/view/web/season";

    // 解析 URL 获取必要参数
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
      path.unshift("");
      log("info", path);
    } else {
      log("error", 'Invalid URL');
      return null;
    }

    let cid, aid, duration, title;

    // 普通投稿视频
    if (id.includes("video/")) {
      try {
        // 获取查询字符串部分（从 `?` 开始的部分）
        const queryString = id.split('?')[1];

        // 如果查询字符串存在，则查找参数 p
        let p = 1; // 默认值为 1
        if (queryString) {
            const params = queryString.split('&'); // 按 `&` 分割多个参数
            for (let param of params) {
              const [key, value] = param.split('='); // 分割每个参数的键值对
              if (key === 'p') {
                p = value || 1; // 如果找到 p，使用它的值，否则使用默认值
              }
            }
        }
        log("info", `p: ${p}`);

        let videoInfoUrl;
        if (id.includes("BV")) {
          videoInfoUrl = `${api_video_info}?bvid=${path[2]}`;
        } else {
          aid = path[2].substring(2)
          videoInfoUrl = `${api_video_info}?aid=${path[2].substring(2)}`;
        }

        const res = await httpGet(videoInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取普通投稿视频信息失败:", data.message);
          return null;
        }

        duration = data.data.duration;
        cid = data.data.pages[p - 1].cid;
      } catch (error) {
        log("error", "请求普通投稿视频信息失败:", error);
        return null;
      }

    // 番剧 - ep格式
    } else if (id.includes("bangumi/") && id.includes("ep")) {
      try {
        const epid = path.slice(-1)[0].slice(2);
        
        // 解析特殊参数：season_id 和 area 标记
        const urlParams = id.split('?')[1] || "";
        let seasonId = null, isOversea = false;
        urlParams.split('&').forEach(p => { 
            const [k, v] = p.split('='); 
            if (k === 'season_id') seasonId = v; 
            if (k === 'area' && v === 'hkmt') isOversea = true; 
        });
        
        let success = false;

        // 轨道一：直连模式 (非港澳台标记)
        if (!isOversea) {
            const res = await httpGet(`${api_epid_cid}?ep_id=${epid}`, {
               headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }
            });
            const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
            if (data.code === 0 && data.result) {
               const ep = data.result.episodes.find(e => e.id == epid);
               if (ep) { cid = ep.cid; duration = ep.duration / 1000; title = ep.share_copy; success = true; }
            }
        }

        // 轨道二：代理模式 (港澳台标记 或 直连失败且有seasonId)
        if ((!success || isOversea) && seasonId && this._hasBilibiliProxy()) {
            // 尝试 View 接口 (必须走代理)
            try {
                const proxyUrl = this._makeProxyUrl(`https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`);
                const res = await httpGet(proxyUrl, { headers: { "Cookie": globals.bilibliCookie || "", "User-Agent": "Mozilla/5.0" } });
                const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
                if (data.code === 0 && data.result) {
                    const ep = (data.result.episodes || data.result.main_section?.episodes || []).find(e => e.id == epid);
                    if (ep) { cid = ep.cid; aid = ep.aid; duration = ep.duration / 1000; title = ep.long_title; success = true; }
                }
            } catch(e) {}
            
            // 尝试 Section 接口 (直连回退)
            if (!success) {
                try {
                    const res = await httpGet(`https://api.bilibili.com/pgc/web/season/section?season_id=${seasonId}`, { headers: { "User-Agent": "Mozilla/5.0", "Cookie": globals.bilibliCookie||"" } });
                    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
                    if (data.code === 0 && data.result?.main_section?.episodes) {
                        const ep = data.result.main_section.episodes.find(e => e.id == epid);
                        if (ep) { cid = ep.cid; aid = ep.aid; duration = ep.duration ? ep.duration / 1000 : 0; title = ep.long_title; success = true; }
                    }
                } catch(e) {}
            }
        }

        if (!cid) {
          log("error", "未找到匹配的番剧集信息");
          return null;
        }

        // 兜底 duration
        if (!duration && duration !== 0) duration = 0;

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return null;
      }

    // 番剧 - ss格式
    } else if (id.includes("bangumi/") && id.includes("ss")) {
      try {
        const ssid = path.slice(-1)[0].slice(2).split('?')[0]; // 移除可能的查询参数
        const ssInfoUrl = `${api_epid_cid}?season_id=${ssid}`;

        log("info", `获取番剧信息: season_id=${ssid}`);

        const res = await httpGet(ssInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取番剧视频信息失败:", data.message);
          return null;
        }

        // 检查是否有episodes数据
        if (!data.result.episodes || data.result.episodes.length === 0) {
          log("error", "番剧没有可用的集数");
          return null;
        }

        // 默认获取第一集的弹幕
        const firstEpisode = data.result.episodes[0];
        cid = firstEpisode.cid;
        duration = firstEpisode.duration / 1000;
        title = firstEpisode.share_copy;

        log("info", `使用第一集: ${title}, cid=${cid}`);

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return null;
      }

    } else {
      log("error", "不支持的B站视频网址，仅支持普通视频(av,bv)、剧集视频(ep,ss)");
      return null;
    }

    log("info", `提取视频信息完成: cid=${cid}, aid=${aid}, duration=${duration}`);

    return { cid, aid, duration, title };
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求B站弹幕...", id);

    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 分批并发请求，防止请求过多
    const BATCH_SIZE = 6;
    let contents = [];
    
    for (let i = 0; i < segmentList.length; i += BATCH_SIZE) {
        const batch = segmentList.slice(i, i + BATCH_SIZE);
        const promises = batch.map(segment => this.getEpisodeSegmentDanmu(segment).then(d => ({status: 'ok', value: d})).catch(e => ({status: 'err', error: e})));
        
        const results = await Promise.all(promises);
        let stop = false;
        
        for (const res of results) {
            if (res.status === 'ok' && res.value) {
                contents.push(...res.value);
            } else {
                // 请求失败视为视频结束（熔断机制）
                log("info", "[Bilibili] 捕获到分段请求出错，说明请求完毕，停止后续请求");
                stop = true;
            }
        }
        if (stop) break;
    }

    return contents;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取B站弹幕分段列表...", id);

    // 提取视频信息
    const videoInfo = await this._extractVideoInfo(id);
    if (!videoInfo) {
      return new SegmentListResponse({
        "type": "bilibili1",
        "segmentList": []
      });
    }

    const { cid, aid, duration } = videoInfo;
    log("info", `视频信息: cid=${cid}, aid=${aid}, duration=${duration}`);

    // [提示] 无时长时的默认分段策略提示
    if (duration <= 0) {
        log("info", "[Bilibili] 未获取到精准时长，使用预设 36 分段");
    }

    // 计算视频的分片数量
    const maxLen = (duration > 0) ? (Math.floor(duration / 360) + 1) : 36;
    log("info", `maxLen: ${maxLen}`);

    const segmentList = [];
    for (let i = 0; i < maxLen; i += 1) {
      let danmakuUrl;
      if (aid) {
        danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${i + 1}`;
      } else {
        danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${i + 1}`;
      }

      segmentList.push({
        "type": "bilibili1",
        "segment_start": i * 360,
        "segment_end": (i + 1) * 360,
        "url": danmakuUrl
      });
    }

    return new SegmentListResponse({
      "type": "bilibili1",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "Cookie": globals.bilibliCookie
        },
        base64Data: true,
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        contents = parseDanmakuBase64(response.data);
      }

      return contents;
    } catch (error) {
      // 抛出错误以触发外层的熔断机制
      throw error;
    }
  }

  formatComments(comments) {
    return comments.map(c => {
        if (globals.danmuSimplifiedTraditional === 'simplified') {
            if (c.m) c.m = simplized(c.m);
        }
        c.like = c.like_num;
        return c;
    });
  }

  // 构建代理URL
  _makeProxyUrl(targetUrl) {
    return globals.makeProxyUrl(targetUrl);
  }

  // 检查是否配置了B站专用代理
  _hasBilibiliProxy() {
    return (globals.proxyUrl || '').split(',').some(p => {
        const t = p.trim();
        return t.startsWith('bilibili@') || t.startsWith('@');
    });
  }

  // APP接口专用 URL 编码
  _javaUrlEncode(str) {
    return encodeURIComponent(str)
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A')
      .replace(/%20/g, '+');
  }

  // 港澳台代理搜索请求
  async _searchOverseaRequest(keyword, appType, webSearchType, label="Original", signal = null) {
    const rawCookie = globals.bilibliCookie || "";
    const akMatch = rawCookie.match(/([0-9a-fA-F]{32})/);
    const proxy = (globals.proxyUrl||'').includes('bilibili@') || (globals.proxyUrl||'').includes('@');
    if (!proxy) return [];

    // 1. 尝试 App 接口
    if (akMatch) {
        log("info", `[Bilibili-Proxy][${label}] 检测到 Access Key，启用 APP 端接口模式 (Type: ${appType})...`);
        try {
            const params = { keyword, type: appType, area: 'tw', mobi_app: 'android', platform: 'android', build: '8140200', ts: Math.floor(Date.now()/1000), appkey: BilibiliSource.APP_KEY, access_key: akMatch[1], disable_rcmd: 1 };
            const qs = Object.keys(params).sort().map(k => `${k}=${this._javaUrlEncode(String(params[k]))}`).join('&');
            const sign = md5(qs + BilibiliSource.APP_SEC);
            
            const target = `https://app.bilibili.com/x/v2/search/type?${qs}&sign=${sign}`;
            const url = globals.makeProxyUrl(target);
            
            const data = await this._fetchAppSearchWithStream(url, { "User-Agent": "Mozilla/5.0 Android", "X-From-Biliroaming": "1.0.0" }, label, signal);
            
            if (data && data.code === 0) {
                // 兼容 items (影视/综艺) 和 result (番剧) 两种字段结构
                return (data.data?.items || data.data?.result || data.data || [])
                    .filter(i => i.goto !== 'recommend_tips' && i.area !== '漫游' && i.badge !== '公告')
                    .map(i => ({
                        provider: "bilibili",
                        mediaId: i.season_id ? `ss${i.season_id}` : (i.uri.match(/season\/(\d+)/)?.[1] ? `ss${i.uri.match(/season\/(\d+)/)[1]}` : ""),
                        title: (i.title||"").replace(/<[^>]+>/g,'').trim(),
                        type: this._extractMediaType(i.season_type_name),
                        year: i.ptime ? new Date(i.ptime*1000).getFullYear() : null,
                        imageUrl: i.cover||i.pic||"",
                        episodeCount: 0,
                        _eps: i.episodes || i.episodes_new,
						checkMore: i.check_more,
                        isOversea: true
                    })).filter(i => i.mediaId);
            }
            if (data && data.code !== 0) log("warn", `[Bilibili-Proxy] App 接口返回错误 Code ${data.code}: ${data.message}`);
        } catch(e) {
            if (e.name === 'AbortError') throw e;
            log("error", `[Bilibili-Proxy] App 接口请求异常: ${e.message}`);
        }
        log("info", `[Bilibili-Proxy] App 接口请求失败，自动降级至 Web 接口...`);
    } else {
        log("info", `[Bilibili-Proxy][${label}] 未检测到 Access Key，启用 Web 端接口模式 (Type: ${webSearchType})...`);
    }

    // 2. Web 接口兜底
    try {
        const params = { keyword, search_type: webSearchType, area: 'tw', page: 1, order: 'totalrank', __refresh__: true, _timestamp: Date.now() };
        const qs = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
        
        const target = `https://api.bilibili.com/x/web-interface/search/type?${qs}`;
        const url = globals.makeProxyUrl(target);
        
        const res = await httpGet(url, { 
            headers: { "User-Agent": "Mozilla/5.0", "Cookie": globals.bilibliCookie||"", "X-From-Biliroaming": "1.0.0" },
            signal: signal 
        });
        const data = typeof res.data==="string"?JSON.parse(res.data):res.data;
        
        if (data.code !== 0) {
            log("warn", `[Bilibili-Proxy] Web 接口返回错误 Code ${data.code}: ${data.message}`);
            return [];
        }
        if(data.data?.result) {
            return data.data.result.filter(i => i.url?.includes("bilibili.com") && (!i.areas?.includes("漫游"))).map(i => ({
                provider: "bilibili", mediaId: i.season_id?`ss${i.season_id}`:"", title: (i.title||"").replace(/<[^>]+>/g,'').trim(),
                type: this._extractMediaType(i.season_type_name), year: i.pubtime?new Date(i.pubtime*1000).getFullYear():null, imageUrl: i.cover||null,
                episodeCount: i.ep_size||0, _eps: i.eps, isOversea: true
            })).filter(i => i.mediaId);
        }
    } catch(e) {
        if (e.name === 'AbortError') throw e;
        log("error", `[Bilibili-Proxy] Web 接口请求异常: ${e.message}（如果是-500/-502说明只是风控）`);
    }
    return [];
  }

  // 综合港澳台搜索入口
  async _searchOversea(keyword) {
      const tmdbAbortController = new AbortController();
      
      // 定义搜索配置：同时搜索番剧(App:7, Web:media_bangumi)和影视(App:8, Web:media_ft)
      const searchConfigs = [
          { appType: 7, webType: 'media_bangumi' },
          { appType: 8, webType: 'media_ft' }
      ];
      
      // 1. 原始关键词搜索 (并发执行所有类型，增加间隔延迟)
      const t1 = Promise.all(searchConfigs.map(async (conf, index) => {
          if (index > 0) await new Promise(r => setTimeout(r, index * 300)); // 错峰请求避免风控
          return this._searchOverseaRequest(keyword, conf.appType, conf.webType, "Original");
      })).then(results => {
          const flatResults = results.flat();
          if(flatResults.length) tmdbAbortController.abort(); 
          // 挂载原始 keyword
          flatResults.forEach(i => i._originalQuery = keyword); 
          return flatResults; 
      }).catch(()=>[]);
      
      // 2. TMDB 辅助搜索
      const t2 = globals.tmdbApiKey ? (new Promise(r=>setTimeout(r,100)).then(async ()=>{
          // 获取 TMDB 原名及别名
          const tmdbResult = await getTmdbJaOriginalTitle(keyword, tmdbAbortController.signal, "Bilibili");
          
          if (tmdbResult && tmdbResult.title && tmdbResult.title !== keyword) {
             const { title: tmdbTitle, cnAlias } = tmdbResult;
             
             // 使用日语原名进行并发搜索 (包含番剧和影视，增加间隔延迟)
             const tmdbPromises = searchConfigs.map(async (conf, index) => {
                 if (index > 0) await new Promise(r => setTimeout(r, index * 300)); // 错峰请求避免风控
                 return this._searchOverseaRequest(tmdbTitle, conf.appType, conf.webType, "TMDB", tmdbAbortController.signal);
             });
             
             const results = (await Promise.all(tmdbPromises)).flat();
             
             // 注入上下文信息，包括别名
             results.forEach(r => {
                 r._originalQuery = keyword;
                 r._searchUsedTitle = tmdbTitle;
                 r._tmdbCnAlias = cnAlias; 
             });
             return results;
          }
          return [];
      }).catch(()=>[])) : Promise.resolve([]);
      
      return (await Promise.all([t1, t2])).flat();
  }

  // APP搜索流式嗅探，针对 B 站港澳台无结果时返回的大体积推荐数据
  async _fetchAppSearchWithStream(url, headers, label, signal) {
    if (typeof httpGetWithStreamCheck !== 'function') return null;
    
    let trusted = false;
    let isNoResult = false; // 标记是否为"无结果"中断

    const result = await httpGetWithStreamCheck(url, { 
        headers: headers,
        sniffLimit: 8192,
        signal: signal 
    }, (chunk) => {
        if (trusted) return true;
        if (chunk.includes('"goto":"recommend_tips"') || chunk.includes('暂无搜索结果')) {
            log("info", `[Bilibili-Proxy][${label}] 嗅探到无效数据，中断`); 
            isNoResult = true; // 标记为无结果
            return false;
        }
        if (chunk.includes('"season_id"') || chunk.includes('"episodes"')) trusted = true;
        return true;
    });

    // 如果是无结果导致的中断，构造一个伪造的空成功响应
    if (isNoResult) {
        return { code: 0, data: { items: [] } };
    }

    return result;
  }
}
