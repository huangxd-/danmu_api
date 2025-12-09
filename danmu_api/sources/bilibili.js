import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet} from "../utils/http-util.js";
import { parseDanmakuBase64, md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";

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
      const response = await fetch(shortUrl, {
        method: 'GET',
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

        results.push({
          provider: "bilibili",
          mediaId,
          title: cleanedTitle,
          type: mediaType,
          year,
          imageUrl: item.cover || null,
          episodeCount
        });
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
      const results = await Promise.all(searchPromises);

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
    try {
      const url = `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`;

      const response = await httpGet(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bilibili.com/",
          "Cookie": globals.bilibliCookie || ""
        }
      });

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.code !== 0 || !data.result) {
        log("error", `[Bilibili] 获取番剧分集失败 (season_id=${seasonId}):`, data.message);
        return [];
      }

      // 优先从 main_section 获取分集
      const rawEpisodes = data.result.main_section?.episodes || data.result.episodes || [];

      if (rawEpisodes.length === 0) {
        log("info", `[Bilibili] 番剧 season_id=${seasonId} 无分集数据`);
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
    } catch (error) {
      log("error", `[Bilibili] 获取番剧分集出错 (season_id=${seasonId}):`, error.message);
      return [];
    }
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

    const processPromises = sourceAnimes
      .filter(anime => titleMatches(anime.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);

          if (eps.length === 0) {
            log("info", `[Bilibili] ${anime.title} 无分集，跳过`);
            return;
          }

          const links = eps.map((ep, index) => ({
            name: `${index + 1}`,
            url: ep.link,
            title: `【bilibili1】 ${ep.title}`
          }));

          const numericAnimeId = convertToAsciiSum(anime.mediaId);
          const transformedAnime = {
            animeId: numericAnimeId,
            bangumiId: anime.mediaId,
            animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from bilibili`,
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

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求B站弹幕...", id);

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://api.bilibili.com/x/web-interface/view";
    const api_epid_cid = "https://api.bilibili.com/pgc/view/web/season";

    // 解析 URL 获取必要参数
    // 手动解析 URL（没有 URL 对象的情况下）
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
      path.unshift("");
      log("info", path);
    } else {
      log("error", 'Invalid URL');
      return [];
    }

    let title, danmakuUrl, cid, aid, duration;

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
          return [];
        }

        duration = data.data.duration;
        cid = data.data.pages[p - 1].cid;
        danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
      } catch (error) {
        log("error", "请求普通投稿视频信息失败:", error);
        return [];
      }

    // 番剧 - ep格式
    } else if (id.includes("bangumi/") && id.includes("ep")) {
      try {
        const epid = path.slice(-1)[0].slice(2);
        const epInfoUrl = `${api_epid_cid}?ep_id=${epid}`;

        const res = await httpGet(epInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取番剧视频信息失败:", data.message);
          return [];
        }

        for (const episode of data.result.episodes) {
          if (episode.id == epid) {
            title = episode.share_copy;
            cid = episode.cid;
            duration = episode.duration / 1000;
            danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
            break;
          }
        }

        if (!danmakuUrl) {
          log("error", "未找到匹配的番剧集信息");
          return [];
        }

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return [];
      }

    // 番剧 - ss格式
    } else if (id.includes("bangumi/") && inputUrl.includes("ss")) {
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
          return [];
        }

        // 检查是否有episodes数据
        if (!data.result.episodes || data.result.episodes.length === 0) {
          log("error", "番剧没有可用的集数");
          return [];
        }

        // 默认获取第一集的弹幕
        const firstEpisode = data.result.episodes[0];
        title = firstEpisode.share_copy;
        cid = firstEpisode.cid;
        duration = firstEpisode.duration / 1000;
        danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;

        log("info", `使用第一集: ${title}, cid=${cid}`);

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return [];
      }

    } else {
      log("error", "不支持的B站视频网址，仅支持普通视频(av,bv)、剧集视频(ep,ss)");
      return [];
    }
    log("info", danmakuUrl, cid, aid, duration);

    // 计算视频的分片数量
    const maxLen = Math.floor(duration / 360) + 1;
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
        segment_start: i * 360 * 1000,
        segment_end: (i + 1) * 360 * 1000,
        url: danmakuUrl,
      });
    }

    // 使用 Promise.all 并行请求所有分片
    try {
      const allComments = await Promise.all(
        segmentList.map(async (segment) => {
          log("info", "正在请求弹幕数据...", segment.url);
          try {
            // 请求单个分片的弹幕数据
            let res = await httpGet(segment.url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Cookie": globals.bilibliCookie
              },
              base64Data: true,
              retries: 1,
            });

            return parseDanmakuBase64(res.data);
          } catch (error) {
            log("error", "请求弹幕数据失败: ", error);
            return [];
          }
        })
      );

      // 合并所有分片的弹幕数据
      const mergedComments = allComments.flat();
      return mergedComments;
    } catch (error) {
      log("error", "获取所有弹幕数据时出错: ", error);
      return [];
    }
  }

  formatComments(comments) {
    return comments;
  }
}