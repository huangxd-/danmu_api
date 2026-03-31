import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { httpGet, updateQueryString } from "../utils/http-util.js";
import { convertToAsciiSum, md5 } from "../utils/codec-util.js";
import { hexToInt } from "../utils/danmu-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { simplized } from "../utils/zh-util.js";
import { globals } from '../configs/globals.js';

// =====================
// 获取爱壹帆弹幕
// =====================
export default class AiyifanSource extends BaseSource {
  constructor() {
    super();
    this.USER_AGENT = (
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0 Safari/537.36"
    );

    // API 基础地址
    this.SEARCH_API      = "https://rankv21.tripdata.app/v3/list/briefsearch";
    this.PLAYLIST_API    = "https://m10.yfsp.tv/v3/video/languagesplaylist";
    this.VIDEO_API       = "https://m10.yfsp.tv/v3/video/play";
    this.DANMU_API       = "https://m10.yfsp.tv/api/video/getBarrage";
    this.DOMAIN_API      = "https://www.yfsp.tv/play";
    this.CONFIG_PAGE_API = "https://www.yfsp.tv/";

    this.signingConfig = null;
    this.signingConfigFetchedAt = 0;
    this.SIGNING_CONFIG_TTL_MS = 60 * 1000;
  }

  /**
   * 计算接口签名 vv
   */
  computeVv(params, signingConfig) {
    const sortedParams = Object.keys(params)
      .map(k => `${k}=${params[k]}`)
      .join('&');
    const raw = signingConfig.publicKey + "&" + sortedParams.toLowerCase() + "&" + signingConfig.privateKey;
    return md5(raw);
  }

  extractSigningConfig(html) {
    const match = html.match(/"pConfig":\{"publicKey":"([^"]+)","privateKey":\[(.*?)\]\}/);
    if (!match) {
      return null;
    }

    let privateKeys = [];
    try {
      privateKeys = JSON.parse(`[${match[2]}]`);
    } catch (error) {
      log("error", `[Aiyifan] 解析桌面站 privateKey 失败: ${error.message}`);
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

  async getSigningConfig(forceRefresh = false) {
    const now = Date.now();
    const cacheValid = this.signingConfig && now - this.signingConfigFetchedAt < this.SIGNING_CONFIG_TTL_MS;
    if (!forceRefresh && cacheValid) {
      return this.signingConfig;
    }

    const headers = {
      "User-Agent": this.USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    const response = await httpGet(globals.makeProxyUrl(this.CONFIG_PAGE_API), { headers });
    const html = typeof response.data === "string" ? response.data : String(response.data ?? "");
    const signingConfig = this.extractSigningConfig(html);

    if (!signingConfig) {
      throw new Error("未能从桌面站页面解析到 pConfig");
    }

    this.signingConfig = signingConfig;
    this.signingConfigFetchedAt = now;
    log("info", `[Aiyifan] 已更新桌面站签名配置: ${signingConfig.publicKey.slice(0, 12)}...`);
    return signingConfig;
  }

  async requestSignedJson(api, baseParams, headers, logPrefix, forceRefresh = false) {
    const signingConfig = await this.getSigningConfig(forceRefresh);
    const vv = this.computeVv(baseParams, signingConfig);
    const params = {
      ...baseParams,
      vv,
      pub: signingConfig.publicKey
    };

    const urlWithParams = updateQueryString(api, params);
    const response = await httpGet(globals.makeProxyUrl(urlWithParams), { headers });
    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (data?.ret !== 200 || data?.data?.code !== 0) {
      const message = data?.data?.msg || data?.msg || "未知错误";
      if (!forceRefresh) {
        log("warn", `[${logPrefix}] 当前签名配置请求失败，尝试刷新后重试: ${message}`);
        return this.requestSignedJson(api, baseParams, headers, logPrefix, true);
      }
      throw new Error(message);
    }

    return { data, signingConfig, vv };
  }

  /**
   * 搜索电视剧
   * @param {string} keyword - 搜索关键词
   * @param {number} page - 页码，默认为1
   * @param {number} size - 每页数量，默认为10
   * @returns {Promise<Object>} 搜索结果
   */
  async searchDrama(keyword, page = 1, size = 10) {
    const params = {
      tags: keyword,
      orderby: 4,
      page: page,
      size: size,
      desc: 1,
      isserial: -1
    };

    const headers = {
      "User-Agent": this.USER_AGENT,
      "Accept": "application/json"
    };

    log("info", `[搜索] 关键词: ${keyword}, 页码: ${page}`);
    
    try {
      const urlWithParams = updateQueryString(this.SEARCH_API, params);
      const response = await httpGet(globals.makeProxyUrl(urlWithParams), { headers });
      
      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
      return data;
    } catch (error) {
      log("error", `[搜索失败] 错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 从搜索结果中提取剧目列表
   * @param {Object} searchResult - 搜索结果
   * @returns {Array} 剧目列表
   */
  extractDramaList(searchResult) {
    const dramas = [];
    const infoList = searchResult?.data?.info || [];

    if (!infoList.length) {
      log("warn", "[警告] 搜索结果为空");
      return dramas;
    }

    for (const item of infoList) {
      const result = item.result || [];
      if (!result.length) {
        continue;
      }

      for (const dramaInfo of result) {
        const vid = dramaInfo.contxt;
        const title = dramaInfo.title;

        // 搜索结果里的 key 字段即为剧集 vid
        // 不同接口字段名可能不同，优先取 key
        dramas.push({
          contxt: vid,
          title: title,
          ...dramaInfo
        });
        log("info", `[发现剧目] ${title}  vid=${vid}`);
      }
    }

    return dramas;
  }

  /**
   * 通过 languagesplaylist 接口获取该剧集的全部集信息
   * @param {string} vid - 剧集唯一标识
   * @returns {Promise<Array>} 集列表
   */
  async getPlaylist(vid) {
    const baseParams = {
      cinema: 1,
      vid: vid,
      lsk: 1,
      taxis: 0,
      cid: "0,1,4,152",
    };

    const headers = {
      "User-Agent": this.USER_AGENT,
      "Accept": "application/json"
    };

    log("info", `[播放列表] 请求 vid: ${vid}`);
    
    try {
      const { data } = await this.requestSignedJson(this.PLAYLIST_API, baseParams, headers, "播放列表");

      const episodes = [];
      const infoList = data.data?.info || [];
      for (const info of infoList) {
        for (const ep of info.playList || []) {
          episodes.push(ep);
        }
      }

      log("info", `[播放列表] 共获取到 ${episodes.length} 集`);
      return episodes;
    } catch (error) {
      log("error", `[播放列表失败] 错误: ${error.message}`);
      return [];
    }
  }

  /**
   * 获取视频播放信息，包括 uniqueKey
   * @param {string} epKey - 剧集的 key
   * @param {number} epId - 剧集的 id（可选，用于打印）
   * @returns {Promise<Object>} 包含 uniqueKey 等信息的 data 字典
   */
  async getVideoInfo(epKey, epId = null) {
    const baseParams = {
      cinema: 1,
      id: epKey,
      a: 0,
      lang: "none",
      usersign: 1,
      region: "GL.",
      device: 0,
      isMasterSupport: 1
    };

    const headers = {
      "User-Agent": this.USER_AGENT,
      "Accept": "application/json"
    };

    const epInfo = epId ? `(ID:${epId})` : "";
    log("info", `[视频信息] 请求 key: ${epKey} ${epInfo}`);

    try {
      const { data, vv } = await this.requestSignedJson(this.VIDEO_API, baseParams, headers, "视频信息");
      log("info", `[视频信息] vv签名: ${vv.substring(0, 16)}...`);
      return data.data || {};
    } catch (error) {
      log("error", `[视频信息失败] 错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 从视频信息中提取 uniqueKey
   * @param {Object} videoInfo - 视频信息
   * @returns {string} uniqueKey
   */
  extractUniqueKey(videoInfo) {
    const info = videoInfo.info?.[0] || {};
    const uniqueKey = info.uniqueKey;
    if (uniqueKey) {
      log("info", `[视频信息] 获取到 uniqueKey: ${uniqueKey}`);
    }
    return uniqueKey;
  }

  /**
   * 获取弹幕列表
   * @param {string} uniqueKey - 唯一标识
   * @param {number} page - 页码，默认为1
   * @param {number} size - 每页数量，默认为30000
   * @returns {Promise<Array>} 弹幕列表
   */
  async fetchBarrage(uniqueKey, page = 1, size = 30000) {
    const baseParams = {
      cinema: 1,
      page: page,
      size: size,
      uniqueKey: uniqueKey,
    };

    const headers = {
      "User-Agent": this.USER_AGENT,
    };

    log("info", `[弹幕] 请求 uniqueKey: ${uniqueKey}`);

    try {
      const { data, vv } = await this.requestSignedJson(this.DANMU_API, baseParams, headers, "弹幕");
      log("info", `[弹幕] vv签名: ${vv.substring(0, 16)}...`);

      const danmuList = data.data?.info || [];
      log("info", `[弹幕] 获取到 ${danmuList.length} 条弹幕`);
      return danmuList;
    } catch (error) {
      log("error", `[弹幕失败] 错误: ${error.message}`);
      return [];
    }
  }

  /**
   * 搜索功能
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Array>} 搜索结果
   */
  async search(keyword) {
    log("info", `[Aiyifan] 开始搜索: ${keyword}`);

    // Step 1: 搜索，拿到剧目列表
    const searchResult = await this.searchDrama(keyword);
    if (!searchResult) {
      log("error", "搜索失败，退出");
      return [];
    }

    const dramas = this.extractDramaList(searchResult);
    if (!dramas.length) {
      log("warn", "未找到剧目信息，退出");
      return [];
    }

    // 转换搜索结果格式
    const results = dramas.map(drama => {
      return {
        provider: "aiyifan",
        mediaId: drama.contxt,  // vid 作为 mediaId
        title: drama.title,
        type: drama.atypeName,  // 默认类型
        year: new Date(drama.postTime).getFullYear(),  // 年份信息可能需要从其他地方获取
        imageUrl: drama.imgPath || null,  // 图片链接
        episodeCount: 0 // 初始集数为0，后续获取
      };
    });

    log("info", `[Aiyifan] 搜索完成，找到 ${results.length} 个结果`);
    return results;
  }

  /**
   * 获取剧集详情
   * @param {string} id - 剧集ID
   * @returns {Promise<Array>} 剧集列表
   */
  async getEpisodes(id) {
    log("info", `[Aiyifan] 获取剧集详情: ${id}`);

    // 获取播放列表
    const episodes = await this.getPlaylist(id);
    if (!episodes.length) {
      log("error", "获取播放列表失败");
      return [];
    }

    // 转换为标准格式
    const result = episodes.map((ep, index) => ({
      vid: ep.key,  // 使用key作为vid
      id: ep.id,
      title: ep.name || `第${index + 1}集`,
      link: `${this.DOMAIN_API}/${id}?id=${ep.key}`
    }));

    log("info", `[Aiyifan] 获取到 ${result.length} 个剧集`);
    return result;
  }

  /**
   * 处理animes结果
   * @param {Array} sourceAnimes - 源动漫数据
   * @param {string} queryTitle - 查询标题
   * @param {Array} curAnimes - 当前动漫列表
   * @param {any} detailStore - 详情存储
   * @returns {Promise<Array>} 处理后的动漫列表
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Aiyifan] sourceAnimes is not a valid array");
      return [];
    }

    const processPromises = sourceAnimes
      .filter(anime => titleMatches(anime.title, queryTitle))
      .map(async (anime) => {
        try {
          // 获取剧集列表
          const eps = await this.getEpisodes(anime.mediaId);
          if (eps.length === 0) {
            log("info", `[Aiyifan] ${anime.title} 无分集，跳过`);
            return;
          }

          // 构建链接
          const links = eps.map((ep, index) => ({
            name: ep.title || `${index + 1}`,
            url: ep.link,
            title: `【aiyifan】 ${ep.title}`
          }));

          if (links.length === 0) return;

          // 计算动漫ID
          const numericAnimeId = convertToAsciiSum(anime.mediaId);

          // 构建动漫对象
          const transformedAnime = {
            animeId: numericAnimeId,
            bangumiId: anime.mediaId,
            animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from aiyifan`,
            type: anime.type,
            typeDescription: anime.type,
            imageUrl: anime.imageUrl,
            startDate: generateValidStartDate(anime.year),
            episodeCount: links.length,
            rating: 0,
            isFavorited: true,
            source: "aiyifan",
          };

          tmpAnimes.push(transformedAnime);
          addAnime({ ...transformedAnime, links }, detailStore);

          if (globals.animes.length > globals.MAX_ANIMES) {
            removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Aiyifan] 处理 ${anime.title} 失败:`, error.message);
        }
      });

    await Promise.all(processPromises);

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return tmpAnimes;
  }

  /**
   * 获取某集的弹幕
   * @param {string} id - 视频ID
   * @returns {Promise<Array>} 弹幕列表
   */
  async getEpisodeDanmu(id) {
    log("info", `[Aiyifan] 获取弹幕: ${id}`);

    // 从 URL 中提取 id 参数
    const videoId = new URL(id).searchParams.get("id") ?? id;

    // 获取视频信息
    const videoInfo = await this.getVideoInfo(videoId);
    if (!videoInfo) {
      log("error", "获取视频信息失败");
      return [];
    }

    // 提取uniqueKey
    const uniqueKey = this.extractUniqueKey(videoInfo);
    if (!uniqueKey) {
      log("error", "未获取到uniqueKey");
      return [];
    }

    // 获取弹幕
    const danmuList = await this.fetchBarrage(uniqueKey);
    if (danmuList.length === 0) {
      log("info", "未获取到弹幕");
      return [];
    }

    // 按时间排序
    danmuList.sort((a, b) => (a.second || 0) - (b.second || 0));

    log("info", `[Aiyifan] 获取到 ${danmuList.length} 条弹幕`);
    return danmuList;
  }

  /**
   * 获取某集的弹幕分片列表
   * @param {string} id - 视频ID
   * @returns {Promise<any>} 弹幕分片列表
   */
  async getEpisodeDanmuSegments(id) {
    // 这里可以实现分片逻辑，暂时返回基本结构
    const danmaku = await this.getEpisodeDanmu(id);
    
    // 创建分段列表
    const segmentList = [{
      "type": "aiyifan",
      "segment_start": 0,
      "segment_end": Math.max(...danmaku.map(d => d.second || 0), 0),
      "url": `${this.DANMU_API}?uniqueKey=${id}`
    }];

    return {
      "type": "aiyifan",
      "duration": Math.max(...danmaku.map(d => d.second || 0), 0),
      "segmentList": segmentList
    };
  }

  /**
   * 获取某集的分片弹幕
   * @param {any} segment - 分片信息
   * @returns {Promise<Array>} 分片弹幕
   */
  async getEpisodeSegmentDanmu(segment) {
    // 从segment中提取uniqueKey并获取弹幕
    const uniqueKey = segment.url?.split('uniqueKey=')[1];
    if (!uniqueKey) {
      return [];
    }
    
    return await this.getEpisodeDanmu(uniqueKey);
  }

  /**
   * 格式化弹幕
   * @param {Array} comments - 原始弹幕
   * @returns {Array} 格式化后的弹幕
   */
  formatComments(comments) {
    return comments.map(comment => {
      // 将弹幕转换为标准格式
      return {
        // 时间（秒）
        p: `${comment.second || 0},${comment.position === 1 ? 5 : 1},25,${hexToInt(comment.color.replace("#", ""))},0,0,0,0`, // 标准弹幕格式: time, type, fontsize, color, unix_timestamp, pool, uid, row_id
        m: comment.contxt || comment.content || '', // 弹幕内容
        like: comment.good, // 点赞数
        // 保留原始数据
        ...comment
      };
    }).map(c => {
      if (globals.danmuSimplifiedTraditional === 'simplified') {
        if (c.m) c.m = simplized(c.m);
      }
      return c;
    });
  }
}
