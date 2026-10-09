import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { hexToInt } from "../utils/danmu-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";
import { globals } from '../configs/globals.js';
import { AiyifanAppSigningProvider, AIYIFAN_APP_BASE_URL, AIYIFAN_WEB_YEAR_MAX_WAIT_MS } from '../utils/aiyifan-util.js';

// =====================
// 获取爱壹帆弹幕（App 链路）
// =====================
// 链路对照（签名细节见 utils/aiyifan-util.js 顶部注释）：
//   搜索  POST https://api.tripdata.app/api/List/GetTitleGetData   body: {"SearchCriteria": 关键词}
//   选集  POST https://api.tripdata.app/api/Video/VideoChooseGather body: {"mediaKey": mediaKey}
//   详情  GET  https://api.tripdata.app/api/Video/VideoDetails?mediaKey=&videoType=&episodeKey=
//   弹幕  GET  https://api.tripdata.app/api/Video/GetBarrages?mediaKey=&videoId=&videoType=1
// 其中展示用链接仍保留 https://www.yfsp.tv/play/... 形式，
// 因为 danmu_api 依据 URL 中的 .yfsp.tv 判定来源平台为 aiyifan。
// 注意：弹幕接口的 videoId 取选集列表里的 uniqueID（不是 episodeId）。

export default class AiyifanSource extends BaseSource {
  constructor() {
    super();

    // App 接口基础地址（1.7.8 安装包内 com.ppde.ppcd 使用 api.tripdata.app）
    this.SEARCH_API = AIYIFAN_APP_BASE_URL + "api/List/GetTitleGetData";
    this.EPISODES_API = AIYIFAN_APP_BASE_URL + "api/Video/VideoChooseGather";
    this.DETAILS_API = AIYIFAN_APP_BASE_URL + "api/Video/VideoDetails";
    this.DANMU_API = AIYIFAN_APP_BASE_URL + "api/Video/GetBarrages";

    // 仅用于拼接剧集链接（保持 .yfsp.tv 域名以维持平台识别）
    this.PLAY_PAGE_BASE = "https://www.yfsp.tv/play";
    this.DEFAULT_VIDEO_TYPE = 1;

    this.signingProvider = new AiyifanAppSigningProvider();
    this.inflightDanmuRequests = new Map();
  }

  extractEpisodeRequestKey(id) {
    try {
      return new URL(id).searchParams.get("id") ?? id;
    } catch {
      return id;
    }
  }

  /**
   * 解析剧集链接
   * 形如 https://www.yfsp.tv/play/{mediaKey}?id={episodeKey}&videoId={uniqueID}&videoType=1
   * @param {string} id - 剧集链接
   * @returns {Object|null} { mediaKey, episodeKey, videoId, videoType }
   */
  parseEpisodeLink(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }

    let url;
    try {
      url = new URL(id);
    } catch {
      return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    return {
      mediaKey: segments.length ? segments[segments.length - 1] : '',
      episodeKey: url.searchParams.get("id") || '',
      videoId: url.searchParams.get("videoId") || '',
      videoType: url.searchParams.get("videoType") || String(this.DEFAULT_VIDEO_TYPE)
    };
  }

  /**
   * 搜索剧目
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Object|null>} 搜索结果
   */
  async searchDrama(keyword) {
    log("info", `[aiyifan] [搜索] 关键词: ${keyword}`);

    try {
      const { data } = await this.signingProvider.signedPostJson(this.SEARCH_API, {
        SearchCriteria: keyword
      }, "搜索");
      return data;
    } catch (error) {
      log("error", `[aiyifan] [搜索失败] 错误: ${error.message}`);
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
    const list = searchResult?.data?.list || [];

    if (!list.length) {
      log("warn", "[aiyifan] [警告] 搜索结果为空");
      return dramas;
    }

    for (const item of list) {
      if (!item || !item.title) {
        continue;
      }

      // App 搜索里的 mediaKey 即剧集标识，也是选集/弹幕接口的入参
      const mediaKey = item.mediaKey || item.mediaId;
      if (!mediaKey) {
        continue;
      }

      const episodes = Array.isArray(item.episodes) ? item.episodes : [];
      const playableEpisodes = episodes.filter(ep => ep && ep.episodeKey);
      dramas.push({
        mediaKey: mediaKey,
        mediaId: item.mediaId,
        title: item.title,
        type: item.mediaType || item.contentType || "影视",
        // App 的 postTime 是站点加入时间，不能作为作品年份
        year: null,
        imageUrl: item.coverImgUrl || null,
        episodeCount: playableEpisodes.length,
        raw: item
      });
      log("info", `[aiyifan] [发现剧目] ${item.title}  mediaKey=${mediaKey}`);
    }

    return dramas;
  }

  /**
   * 获取剧集分集列表
   * @param {string} id - 剧集 mediaKey
   * @returns {Promise<Array>} 分集列表
   */
  async getEpisodes(id) {
    log("info", `[aiyifan] [选集] 请求 mediaKey: ${id}`);

    let list = [];
    try {
      const { data } = await this.signingProvider.signedPostJson(this.EPISODES_API, {
        mediaKey: id
      }, "选集");
      list = data?.data?.list || [];
    } catch (error) {
      log("error", `[aiyifan] [选集失败] 错误: ${error.message}`);
      return [];
    }

    // 转换为标准格式，弹幕接口需要的 videoId 存在链接里（取 uniqueID）
    const result = list
      .filter(ep => ep && ep.episodeKey)
      .map((ep, index) => {
        const videoType = ep.videoType != null ? ep.videoType : this.DEFAULT_VIDEO_TYPE;
        const videoId = ep.uniqueID != null ? ep.uniqueID : ep.episodeId;
        return {
          vid: videoId,
          id: ep.episodeKey,
          title: ep.episodeTitle || ep.title || `第${index + 1}集`,
          link: `${this.PLAY_PAGE_BASE}/${id}?id=${encodeURIComponent(ep.episodeKey)}&videoId=${videoId}&videoType=${videoType}`
        };
      });

    log("info", `[aiyifan] [选集] 共获取到 ${result.length} 集`);
    return result;
  }

  /**
   * 获取视频详情（用于补齐老链接缺失的 videoId）
   * @param {string} mediaKey - 剧集标识
   * @param {string} episodeKey - 分集标识
   * @param {string|number} videoType - 视频类型
   * @returns {Promise<Object>} 详情数据
   */
  async getVideoInfo(mediaKey, episodeKey, videoType) {
    log("info", `[aiyifan] [详情] 请求 mediaKey: ${mediaKey} episodeKey: ${episodeKey}`);

    try {
      const { data } = await this.signingProvider.signedGetJson(this.DETAILS_API, {
        mediaKey: mediaKey,
        videoType: videoType,
        episodeKey: episodeKey
      }, "详情");
      return data?.data || {};
    } catch (error) {
      log("error", `[aiyifan] [详情失败] 错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 获取弹幕列表
   * @param {string} mediaKey - 剧集标识
   * @param {string|number} videoId - 分集弹幕标识（uniqueID）
   * @param {string|number} videoType - 视频类型
   * @returns {Promise<Array>} 弹幕列表
   */
  async fetchBarrage(mediaKey, videoId, videoType) {
    log("info", `[aiyifan] [弹幕] 请求 mediaKey=${mediaKey} videoId=${videoId} videoType=${videoType}`);

    try {
      const { data } = await this.signingProvider.signedGetJson(this.DANMU_API, {
        mediaKey: mediaKey,
        videoId: videoId,
        videoType: videoType
      }, "弹幕");

      const danmuList = data?.data?.list || [];
      log("info", `[aiyifan] [弹幕] 获取到 ${danmuList.length} 条弹幕`);
      return danmuList;
    } catch (error) {
      log("error", `[aiyifan] [弹幕失败] 错误: ${error.message}`);
      return [];
    }
  }

  /**
   * 搜索功能
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Array>} 搜索结果
   */
  async search(keyword) {
    log("info", `[aiyifan] 开始搜索: ${keyword}`);

    // App 接口不返回真实年份（postTime 是加入时间），这里与 App 搜索并发请求
    // 旧网页搜索接口补真实年份；该接口取不到时保留未知年份。
    // lookupYears 内部已兜底，不会 reject。
    const yearPromise = this.waitYearMap(
      this.signingProvider.lookupYears(keyword, "年份"), AIYIFAN_WEB_YEAR_MAX_WAIT_MS
    );

    // Step 1: 搜索，拿到剧目列表
    const searchResult = await this.searchDrama(keyword);
    if (!searchResult) {
      log("error", "[aiyifan] 搜索失败，退出");
      return [];
    }

    const dramas = this.extractDramaList(searchResult);
    if (!dramas.length) {
      log("warn", "[aiyifan] 未找到剧目信息，退出");
      return [];
    }

    // 从发起年份查询算起最多等 5 秒，App 搜索较慢时仍保留已返回的年份
    const yearMap = (await yearPromise) || new Map();

    // 转换搜索结果格式
    const results = dramas.map(drama => {
      const year = yearMap.get(drama.mediaKey) || null;
      return {
        provider: "aiyifan",
        mediaId: drama.mediaKey,  // mediaKey 作为剧集标识
        title: drama.title,
        type: drama.type,
        year: year,
        imageUrl: drama.imageUrl,
        episodeCount: drama.episodeCount
      };
    });

    log("info", `[aiyifan] 搜索完成，找到 ${results.length} 个结果`);
    return results;
  }

  /**
   * 等待网页搜索补年份的结果，最多等 timeoutMs：
   * 被 Cloudflare 拦、超时或出错都不阻塞搜索，直接返回 null（调用方保留未知年份）。
   * 后台请求若稍后完成，结果仍会写入 provider 缓存，下次搜索可直接命中。
   * @param {Promise<Map>} promise - lookupYears 返回的 Promise
   * @param {number} timeoutMs - 最长等待时间
   * @returns {Promise<Map|null>} 年份映射，或 null（超时/失败）
   */
  waitYearMap(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) {
      return promise;
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        log("warn", `[aiyifan] 网页年份查询超过 ${timeoutMs}ms 未返回，本次保留未知年份`);
        resolve(null);
      }, timeoutMs);

      promise.then((map) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(map);
      }).catch(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /**
   * 处理搜索结果
   * @param {Array} sourceAnimes 原始数据
   * @param {string} queryTitle 关键词
   * @param {Array} curAnimes 结果池
   * @param {Map} detailStore 详情缓存
   * @param {number|null} querySeason 目标季度
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[aiyifan] sourceAnimes is not a valid array");
      return [];
    }

    // 基础标题与季度匹配过滤
    let filteredAnimes = sourceAnimes.filter(anime => titleMatches(anime.title, queryTitle, querySeason));

    // 提取搜索词中的明确季度信息或使用传入的季度参数
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    // 初始列表预过滤机制：若用户指定了季度，优先检查结果中是否已包含匹配项
    if (resolvedQuerySeason !== null) {
      const seasonFiltered = filteredAnimes.filter(anime => {
        const s = extractSeasonNumberFromAnimeTitle(anime.title).season;
        return s === resolvedQuerySeason || (resolvedQuerySeason === 1 && s === null);
      });

      // 如果已命中目标，减少详情请求量
      if (seasonFiltered.length > 0) {
        filteredAnimes = seasonFiltered;
        log("info", `[aiyifan] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    const processPromises = filteredAnimes.map(async (anime) => {
        try {
          // 获取剧集列表
          const eps = await this.getEpisodes(anime.mediaId);
          if (eps.length === 0) {
            log("info", `[aiyifan] ${anime.title} 无分集，跳过`);
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
            startDate: anime.year ? generateValidStartDate(anime.year) : '',
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
          log("error", `[aiyifan] 处理 ${anime.title} 失败:`, error.message);
        }
      });

    await Promise.all(processPromises);

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return tmpAnimes;
  }

  /**
   * 获取某集的弹幕
   * @param {string} id - 剧集链接
   * @returns {Promise<Array>} 弹幕列表
   */
  async getEpisodeDanmu(id) {
    log("info", `[aiyifan] 获取弹幕: ${id}`);

    const episodeLink = this.parseEpisodeLink(id);
    if (!episodeLink || !episodeLink.mediaKey) {
      log("error", "[aiyifan] 无法解析剧集链接");
      return [];
    }

    const requestKey = this.extractEpisodeRequestKey(id);
    const inflightRequest = this.inflightDanmuRequests.get(requestKey);
    if (inflightRequest) {
      log("info", `[aiyifan] 复用进行中的弹幕请求: ${requestKey}`);
      return await inflightRequest;
    }

    const requestPromise = (async () => {
      let videoId = episodeLink.videoId;
      let videoType = episodeLink.videoType;

      // 兼容缺少 videoId 的旧链接：用 App 详情接口补齐 ID 和视频类型
      if (!videoId && episodeLink.episodeKey) {
        const videoInfo = await this.getVideoInfo(episodeLink.mediaKey, episodeLink.episodeKey, videoType);
        const detailInfo = videoInfo?.detailInfo || {};
        // 弹幕接口用的 videoId 是 uniqueID，episodeId 部分剧集是另一个值（会取不到弹幕）
        videoId = detailInfo.uniqueID != null ? detailInfo.uniqueID : detailInfo.episodeId;
        if (detailInfo.videoType != null) {
          videoType = detailInfo.videoType;
        }
        log("info", `[aiyifan] 详情接口补齐 videoId: ${videoId}`);
      }

      if (!videoId) {
        log("error", "[aiyifan] 未获取到 videoId，无法获取弹幕");
        return [];
      }

      const danmuList = await this.fetchBarrage(episodeLink.mediaKey, videoId, videoType);
      if (danmuList.length === 0) {
        log("info", "[aiyifan] 未获取到弹幕");
        return [];
      }

      // 按时间排序
      danmuList.sort((a, b) => (a.second || 0) - (b.second || 0));

      log("info", `[aiyifan] 获取到 ${danmuList.length} 条弹幕`);
      return danmuList;
    })();

    this.inflightDanmuRequests.set(requestKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      this.inflightDanmuRequests.delete(requestKey);
    }
  }

  /**
   * 获取某集的弹幕分片列表
   * @param {string} id - 剧集链接
   * @returns {Promise<any>} 弹幕分片列表
   */
  async getEpisodeDanmuSegments(id) {
    const danmaku = await this.getEpisodeDanmu(id);
    const maxSecond = danmaku.length ? Math.max(...danmaku.map(d => d.second || 0)) : 0;

    // App 弹幕接口一次返回全量，这里仍按分片结构返回，url 直接复用剧集链接
    const segmentList = [{
      "type": "aiyifan",
      "segment_start": 0,
      "segment_end": maxSecond,
      "url": id
    }];

    return {
      "type": "aiyifan",
      "duration": maxSecond,
      "segmentList": segmentList
    };
  }

  /**
   * 获取某集的分片弹幕
   * @param {any} segment - 分片信息
   * @returns {Promise<Array>} 分片弹幕
   */
  async getEpisodeSegmentDanmu(segment) {
    const link = this.resolveSegmentLink(segment);
    if (!link) {
      log("warn", "[aiyifan] 分片信息缺少剧集链接");
      return [];
    }
    return await this.getEpisodeDanmu(link);
  }

  resolveSegmentLink(segment) {
    if (!segment) {
      return null;
    }

    const rawUrl = typeof segment.url === 'string' ? segment.url : '';
    if (!rawUrl) {
      return null;
    }

    try {
      const url = new URL(rawUrl);
      // 先解包旧分片 URL，再判断是否为真正的剧集链接
      const link = url.searchParams.get('link') || url.searchParams.get('uniqueKey') || rawUrl;
      const episodeUrl = new URL(link);
      if ((episodeUrl.hostname === 'yfsp.tv' || episodeUrl.hostname.endsWith('.yfsp.tv'))
          && episodeUrl.pathname.startsWith('/play/')) {
        return link;
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * 格式化弹幕
   * @param {Array} comments - 原始弹幕
   * @returns {Array} 格式化后的弹幕
   */
  formatComments(comments) {
    return comments.map(comment => {
      const colorHex = String(comment.color || '#ffffff').replace('#', '');
      // 将弹幕转换为标准格式
      return {
        // 时间（秒）
        p: `${comment.second || 0},${comment.position === 1 ? 5 : 1},25,${hexToInt(colorHex)},0,0,0,0`, // 标准弹幕格式: time, type, fontsize, color, unix_timestamp, pool, uid, row_id
        m: comment.contxt || comment.content || '', // 弹幕内容
        like: comment.good, // 点赞数
        // 保留原始数据
        ...comment
      };
    });
  }
}
