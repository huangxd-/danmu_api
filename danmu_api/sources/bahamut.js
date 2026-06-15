import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { simplized, traditionalized } from "../utils/zh-util.js";
import { getTmdbJaOriginalTitle, smartTitleReplace } from "../utils/tmdb-util.js";
import { strictTitleMatch, normalizeSpaces, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { searchBangumiData } from '../utils/bangumi-data-util.js';

// =====================
// 获取巴哈姆特弹幕
// =====================

// 具体搜索部分
export default class BahamutSource extends BaseSource {
  async search(keyword) {
    try {
      let localMatches = [];
      // 提前获取本地匹配结果
      if (globals.useBangumiData) {
        localMatches = await searchBangumiData(keyword, ['gamer', 'gamer_hk']);
        log("info", `[Bahamut] Bangumi-Data 本地命中 ${localMatches.length} 条数据`);
      }

      // 筛选出含有 video_sn 的本地匹配项
      const localWithVideoSn = localMatches.filter(m => m.video_sn);

      // 数据源直通模式：Bangumi-Data 本地数据完全覆盖时，跳过巴哈姆特搜索接口（零网络请求）
      if (localMatches.length > 0 && localMatches.length === localWithVideoSn.length) {
        log("info", `[Bahamut] Bangumi-Data 本地命中均含 video_sn，启用数据源直通模式（跳过搜索接口）`);
        return localMatches.map(m => {
          const displayTitle = m.titles.find(t => t && t.includes(keyword)) || m.titles[1] || m.title;
          const finalTitle = displayTitle + (m.titleSuffix || '');
          return {
            video_sn: parseInt(m.video_sn),
            title: finalTitle,
            _displayTitle: finalTitle,
            isLocalPriority: true,
            aliases: [...m.titles],
            _typeStr: m.typeStr,
            _fromDataSourceDirectHit: true, // 标记来源于数据源直通模式
            _originalQuery: keyword,
            // 保留 begin 年份供 handleAnimes 使用
            _bangumiBegin: m.begin || null
          };
        });
      }

      // 在函数内部进行简转繁
      const traditionalizedKeyword = traditionalized(keyword);
      const tmdbSearchKeyword = keyword;
      const encodedKeyword = encodeURIComponent(traditionalizedKeyword);

      log("info", `[Bahamut] 原始搜索词: ${keyword}`);
      log("info", `[Bahamut] 巴哈使用搜索词: ${traditionalizedKeyword}`);

      // 创建一个 AbortController 用于取消 TMDB 流程
      const tmdbAbortController = new AbortController();

      // 第一次搜索：繁体词搜索
      const originalSearchPromise = (async () => {
        try {
          const targetUrl = `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedKeyword}`;
          const url = globals.makeProxyUrl(targetUrl);

          const originalResp = await httpGet(url, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
            },
			retries: 3,
          });

          // 如果原始搜索有结果，中断 TMDB 流程
          if (
            originalResp &&
            originalResp.data &&
            originalResp.data.anime &&
            originalResp.data.anime.length > 0
          ) {
            tmdbAbortController.abort(); 
            const anime = originalResp.data.anime;
            for (const a of anime) {
              try {
                a._originalQuery = keyword;
                a._searchUsedTitle = traditionalizedKeyword;
              } catch (e) {}
            }
            log("info", `[Bahamut] bahamutSearchresp (original): ${JSON.stringify(anime)}`);
            log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: original)`);
            return { success: true, data: anime, source: 'original' };
          }

          log("info", `[Bahamut] 原始搜索成功，但未返回任何结果 (source: original)`);
          return { success: false, source: 'original' };
        } catch (error) {
          // ️捕获原始搜索错误，但不阻塞 TMDB 搜索
          log("error", "[Bahamut] 原始搜索失败:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
          });
          return { success: false, source: 'original' };
        }
      })();

      // 第二次搜索：TMDB转换后搜索（并行执行）
      const tmdbSearchPromise = (async () => {
        try {
          // 延迟100毫秒，避免与原始搜索争抢同一连接池
          await new Promise(resolve => setTimeout(resolve, 100));

          // 获取 TMDB 日语原名及中文别名 (解构返回值)
          const tmdbResult = await getTmdbJaOriginalTitle(tmdbSearchKeyword, tmdbAbortController.signal, "Bahamut");

          // 如果没有结果或者没有标题，则停止
          if (!tmdbResult || !tmdbResult.title) {
            log("info", "[Bahamut] TMDB转换未返回结果，取消日语原名搜索");
            return { success: false, source: 'tmdb' };
          }

          // 解构出日语原名和中文别名
          const { title: tmdbTitle, cnAlias } = tmdbResult;

          log("info", `[Bahamut] 使用日语原名进行搜索: ${tmdbTitle}`);
          const encodedTmdbTitle = encodeURIComponent(tmdbTitle);
          const targetUrl = `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedTmdbTitle}`;
          const tmdbSearchUrl = globals.makeProxyUrl(targetUrl);

          const tmdbResp = await httpGet(tmdbSearchUrl, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
            },
            signal: tmdbAbortController.signal,
            retries: 3,
          });

          if (tmdbResp && tmdbResp.data && tmdbResp.data.anime && tmdbResp.data.anime.length > 0) {
            const anime = tmdbResp.data.anime;
            for (const a of anime) {
              try {
                a._originalQuery = keyword;
                a._searchUsedTitle = tmdbTitle;
                a._tmdbCnAlias = cnAlias;
              } catch (e) {}
            }
            log("info", `[Bahamut] bahamutSearchresp (TMDB): ${JSON.stringify(anime)}`);
            log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: tmdb)`);
            return { success: true, data: anime, source: 'tmdb' };
          }
          log("info", `[Bahamut] 日语原名搜索成功，但未返回任何结果 (source: tmdb)`);
          return { success: false, source: 'tmdb' };
        } catch (error) {
          // 捕获被中断的错误
          if (error.name === 'AbortError') {
            log("info", "[Bahamut] 原始搜索成功，中断日语原名搜索");
            return { success: false, source: 'tmdb', aborted: true };
          }
          // TMDB搜索失败不阻塞原始搜索结果，与originalSearchPromise保持一致的错误处理策略
          log("error", "[Bahamut] TMDB搜索失败:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
          });
          return { success: false, source: 'tmdb' };
        }
      })();

      // 如果两个搜索同时完成，优先采用原始搜索结果
      const [originalResult, tmdbResult] = await Promise.all([
        originalSearchPromise,
        tmdbSearchPromise
      ]);

      let finalResults = [];
      if (originalResult.success) {
        finalResults = originalResult.data;
      } else if (tmdbResult.success) {
        finalResults = tmdbResult.data;
      } else {
        log("info", "[Bahamut] 原始搜索和基于TMDB的搜索均未返回任何结果");
      }

      // 对齐 Bangumi Data 进行信息强化
      if (finalResults.length > 0 && localMatches.length > 0) {
        for (const item of finalResults) {
          if (!item || !item.acg_sn) continue;

          // 对齐逻辑：优先精准匹配 acg_sn，其次降级匹配原名
          const matchedLocal = 
              localMatches.find(m => String(item.acg_sn) === String(m.siteId)) || 
              localMatches.find(m => item.title && m.title === item.title);

          if (matchedLocal) {
              const originalBahamutTitle = item.title;
              const displayTitle = matchedLocal.titles.find(t => t && t.includes(keyword)) || matchedLocal.titles[1] || matchedLocal.title;
              const finalTitle = displayTitle + (matchedLocal.titleSuffix || '');

              // 注入本地别名和优选标题，同时挂载精准类型
              item.title = finalTitle;
              item._displayTitle = finalTitle;
			  item.isLocalPriority = true;
              item.aliases = [...matchedLocal.titles];

              // 将原始网络标题加入别名池，防止后续匹配时丢失源站的精确特征
              if (originalBahamutTitle && !item.aliases.includes(originalBahamutTitle)) {
                  item.aliases.push(originalBahamutTitle);
              }

              item._typeStr = matchedLocal.typeStr; 

              log("info", `[Bahamut] 网络结果 [${item.title}] 成功对齐本地 Bangumi-Data 数据`);
          }
        }
      }

      return finalResults;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "[Bahamut] getBahamutAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      // 构建剧集信息 URL
      const targetUrl = `https://api.gamer.com.tw/anime/v1/video.php?videoSn=${id}`;
      const url = globals.makeProxyUrl(targetUrl);
      const resp = await httpGet(url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
        },
		retries: 3,
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "[Bahamut] getBahamutEposides: 请求失败或无数据返回");
        return [];
      }

      // 判断 seriesData 是否存在
      if (!resp.data.data || !resp.data.data.video || !resp.data.data.anime) {
        log("info", "[Bahamut] getBahamutEposides: video 或 anime 不存在");
        return [];
      }

      // 正常情况下输出调试所需的关键字段，对齐其他源做法避免全量输出 contentHtml 等冗余数据
      const { video: vData, anime: aData } = resp.data.data;
      log("info", `[Bahamut] getBahamutEposides: videoSn=${vData.videoSn}, ` +
        `animeSn=${aData.animeSn}, title=${aData.title}, ` +
        `totalEpisode=${aData.totalEpisode}, episodes=${JSON.stringify(aData.episodes)}`);

      return resp.data.data;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "[Bahamut] getBahamutEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  /**
   * 处理搜索结果
   * @param {Array} sourceAnimes 原始数据
   * @param {string} queryTitle 关键词
   * @param {Array} curAnimes 结果池
   * @param {Map|null} detailStore 详情缓存
   * @param {number|null} querySeason 目标季度
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    const tmpAnimes = [];

    // 使用正则判断原始搜索词是否包含日文平假名或片假名
    const isJapaneseKeyword = /[\u3040-\u309F\u30A0-\u30FF]/.test(queryTitle);
    queryTitle = traditionalized(queryTitle);

    // 巴哈姆特搜索辅助函数
    function bahamutTitleMatches(itemTitle, queryTitle, searchUsedTitle) {
      if (!itemTitle) return false;

      // 统一输入格式
      const tItem = String(itemTitle);
      const q = String(queryTitle || "");
      const used = String(searchUsedTitle || "");

      // 如果启用严格匹配模式
      if (globals.strictTitleMatch) {
        // 检查原始查询词
        if (strictTitleMatch(tItem, q)) return true;
        if (used && strictTitleMatch(tItem, used)) return true;

        // 尝试繁体/简体互转后的严格匹配
        try {
          if (strictTitleMatch(tItem, traditionalized(q))) return true;
          if (strictTitleMatch(tItem, simplized(q))) return true;
          if (used) {
            if (strictTitleMatch(tItem, traditionalized(used))) return true;
            if (strictTitleMatch(tItem, simplized(used))) return true;
          }
        } catch (e) {
          // 转换过程中可能会因为异常输入而抛错；忽略继续
        }

        return false;
      }

      // 宽松模糊匹配模式（默认）
      // 规范化空格后进行直接包含检查
      const normalizedItem = normalizeSpaces(tItem);
      const normalizedQ = normalizeSpaces(q);
      const normalizedUsed = used ? normalizeSpaces(used) : '';

      if (normalizedItem.includes(normalizedQ)) return true;
      if (normalizedUsed && normalizedItem.includes(normalizedUsed)) return true;

      // 尝试繁体/简体互转（双向匹配）
      try {
        if (normalizedItem.includes(normalizeSpaces(traditionalized(q)))) return true;
        if (normalizedItem.includes(normalizeSpaces(simplized(q)))) return true;
        if (normalizedUsed) {
          if (normalizedItem.includes(normalizeSpaces(traditionalized(used)))) return true;
          if (normalizedItem.includes(normalizeSpaces(simplized(used)))) return true;
        }
      } catch (e) {
        // 转换过程中可能会因为异常输入而抛错；忽略继续
      }

      // 尝试不区分大小写的拉丁字母匹配
      try {
        if (normalizedItem.toLowerCase().includes(normalizedQ.toLowerCase())) return true;
        if (normalizedUsed && normalizedItem.toLowerCase().includes(normalizedUsed.toLowerCase())) return true;
      } catch (e) { }

      return false;
    }

    // 安全措施:确保一定是数组类型
    const arr = Array.isArray(sourceAnimes) ? sourceAnimes : [];

    // 使用稳健匹配器过滤项目,同时利用之前注入的 _searchUsedTitle 字段
    const filtered = arr.filter(item => {
      const itemTitle = item.title || "";
      const usedSearchTitle = item._searchUsedTitle || item._originalQuery || "";

      // 如果搜索词是日语，或者该结果是基于TMDB转换得来的，则直接跳过匹配规则放行
      if (isJapaneseKeyword || (item._searchUsedTitle && item._searchUsedTitle !== queryTitle)) {
        log("info", `[Bahamut] 命中日语关键词或TMDB结果，绕过匹配规则直接保留: ${itemTitle}`);
        return true;
      }

      // 优先匹配主标题，若失败则继续在别名池中进行匹配兜底
      return bahamutTitleMatches(itemTitle, queryTitle, usedSearchTitle) || 
             (Array.isArray(item.aliases) && item.aliases.some(alias => bahamutTitleMatches(alias, queryTitle, usedSearchTitle)));
    });

    // 记录替换前的原始标题，作为别名传递给合并工具进行比对
    filtered.forEach(item => {
      item._originalTitleAlias = item.title ? simplized(item.title) : "";
    });

    // 应用tmdb智能标题替换
    const cnAlias = filtered.length > 0 ? filtered[0]._tmdbCnAlias : null;
    smartTitleReplace(filtered, cnAlias);

    // 提取搜索词中的明确季度信息或使用传入的季度参数
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    // 初始列表预过滤机制：若用户指定了季度，优先检查初始结果中是否已包含匹配项
    let matchedAnimes = filtered;

    if (resolvedQuerySeason !== null) {
      const seasonFiltered = filtered.filter(anime => {
        const titleToCheck = anime._displayTitle || anime.title;
        const s = extractSeasonNumberFromAnimeTitle(titleToCheck).season;
        return s === resolvedQuerySeason || (resolvedQuerySeason === 1 && s === null);
      });

      // 如果已命中目标，减少详情请求量
      if (seasonFiltered.length > 0) {
        matchedAnimes = seasonFiltered;
        log("info", `[Bahamut] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    // 同一调用内对相同 video_sn 去重（缓存 Promise 避免并发竞态）
    const episodeCache = new Map();
    const processBahamutAnimes = await Promise.all(matchedAnimes.map(async (anime) => {
      try {
        // 复用同一 video_sn 的在途 Promise 避免重复请求
        const cacheKey = String(anime.video_sn);
        if (!episodeCache.has(cacheKey)) {
          episodeCache.set(cacheKey, this.getEpisodes(anime.video_sn));
        }
        const epData = await episodeCache.get(cacheKey);
        // getEpisodes 网络失败时返回空数组而非对象，必须校验结构有效性
        if (!epData || typeof epData !== 'object' || Array.isArray(epData)) return null;
        const detail = epData.video;

        // episodes 可能在不同键中（如 "0"、"1"），电影类内容尤其常见
        let eps = null;
        if (epData.anime.episodes) {
          // 优先使用 "0" 键，如果不存在则使用第一个可用的键
          eps = epData.anime.episodes["0"] || Object.values(epData.anime.episodes)[0];
        }

        let links = [];
        if (eps && Array.isArray(eps)) {
          for (const ep of eps) {
            const epTitle = `第${ep.episode}集`;
            links.push({
              "name": ep.episode.toString(),
              "url": ep.videoSn.toString(),
              "title": `【bahamut】 ${epTitle}`
            });
          }
        }

        if (links.length > 0) {
          // 年份优先级：bangumi-data begin > 详情接口 seasonStart/upTime > 搜索接口 info
          let resolvedYear = null;
          if (anime._bangumiBegin) {
            resolvedYear = parseInt(anime._bangumiBegin.substring(0, 4));
          }
          if (!resolvedYear && epData.anime && epData.anime.seasonStart) {
            resolvedYear = new Date(epData.anime.seasonStart).getFullYear();
          }
          if (!resolvedYear && detail && detail.upTime) {
            const upTimeStr = String(detail.upTime);
            const upTimeMatch = upTimeStr.match(/(\d{4})/);
            if (upTimeMatch) resolvedYear = parseInt(upTimeMatch[1]);
          }
          if (!resolvedYear) {
            // 最后降级到搜索接口的 info 字段
            const yearMatch = (anime.info || "").match(/(\d{4})/);
            if (yearMatch) resolvedYear = parseInt(yearMatch[1]);
          }

          // 封面优先级：动漫主封面(anime) > 搜索接口 cover > 单集封面(video)
          const resolvedCover = (epData.anime && epData.anime.cover) || anime.cover || (detail && detail.cover) || "";

          // 优先使用tmdb智能标题替换的标题，否则简转繁处理原标题
          const displayTitle = anime._displayTitle || simplized(anime.title);

          // 提取网络结果原标题以及在 search 阶段注入的本地多国别名
          const aliases = Array.isArray(anime.aliases) ? [...anime.aliases] : [];
          if (anime._originalTitleAlias && anime._originalTitleAlias !== displayTitle && !aliases.includes(anime._originalTitleAlias)) {
            aliases.push(anime._originalTitleAlias);
          }

          // 优先使用本地数据标注的精准类型，如果不存在则使用原版默认类型兜底
          let itemType = anime._typeStr || "动漫";
          const fullTitle = (epData.anime && epData.anime.title) || (detail && detail.title) || "";

          if (fullTitle.includes("[電影]")) {
            itemType = "剧场版";
          } else if (fullTitle.includes("[特別篇]")) {
            itemType = "OVA";
          }

          let transformedAnime = {
            animeId: anime.video_sn,
            bangumiId: String(anime.video_sn),
            animeTitle: `${displayTitle}(${resolvedYear || 'N/A'})【${itemType}】from bahamut`,
            aliases: aliases,
            type: "动漫",
            typeDescription: "动漫",
            imageUrl: resolvedCover,
            startDate: resolvedYear ? generateValidStartDate(resolvedYear) : generateValidStartDate(epData.anime.seasonStart ? new Date(epData.anime.seasonStart).getFullYear() : null),
            episodeCount: links.length,
            rating: detail.rating,
            isFavorited: true,
            source: "bahamut",
          };

          tmpAnimes.push(transformedAnime);

          addAnime({...transformedAnime, links: links}, detailStore);

          if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
        }
      } catch (error) {
        log("error", `[Bahamut] Error processing anime: ${error.message}`);
      }
    }));

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processBahamutAnimes;
  }

  async getEpisodeDanmu(id) {
    let danmus = [];

    try {
      // 构建弹幕 URL
      const targetUrl = `https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn=${id}`;
      const url = globals.makeProxyUrl(targetUrl);
      const resp = await httpGet(url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
        },
        retries: 3,
      });

      // 将当前请求的 episodes 拼接到总数组
      if (resp.data && resp.data.data && resp.data.data.danmu) {
        danmus = resp.data.data.danmu;
      }

      return danmus;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "[Bahamut] fetchBahamutEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return danmus; // 返回已收集的 episodes
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "[Bahamut] 获取巴哈姆特弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "bahamut",
      "segmentList": [{
        "type": "bahamut",
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
    const positionToMode = { 0: 1, 1: 5, 2: 4 };
    return comments.map(c => ({
      cid: Number(c.sn),
      p: `${(c.time / 10).toFixed(2)},${positionToMode[c.position] || c.tp},${parseInt(c.color.slice(1), 16)},[bahamut]`,
      // 根据 globals.danmuSimplifiedTraditional 控制是否繁转简
      m: globals.danmuSimplifiedTraditional === 'simplified' ? simplized(c.text) : c.text,
      t: c.time / 10
    }));
  }
}
