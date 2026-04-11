import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { simplized } from "../utils/zh-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { getTmdbJaOriginalTitle, smartTitleReplace } from "../utils/tmdb-util.js";
import TencentSource from "./tencent.js";
import IqiyiSource from "./iqiyi.js";
import MangoSource from "./mango.js";
import BilibiliSource from "./bilibili.js";
import YoukuSource from "./youku.js";
import BahamutSource from "./bahamut.js";
import { titleMatches, getExplicitSeasonNumber } from "../utils/common-util.js";

const tencentSource = new TencentSource();
const iqiyiSource = new IqiyiSource();
const mangoSource = new MangoSource();
const bilibiliSource = new BilibiliSource();
const youkuSource = new YoukuSource();
const bahamutSource = new BahamutSource();

const DandanUserAgent = `LogVar Danmu API/${globals.version}`

// =====================
// 获取弹弹play弹幕
// =====================
export default class DandanSource extends BaseSource {

  /**
   * 搜索动画条目
   * 包含常规搜索、TMDB 日语原名搜索，以及去除季度信息后的降级搜索策略
   * @param {string} keyword 搜索关键词
   * @param {boolean} isFallback 标记当前是否处于降级搜索状态，防止无限递归
   */
  async search(keyword, isFallback = false) {
    try {
      log("info", `[Dandan] 原始搜索词: ${keyword}`);

      // 创建 AbortController 用于取消 TMDB 流程
      const tmdbAbortController = new AbortController();

      // 第一次搜索：使用原始关键词搜索番剧列表
      const originalSearchPromise = (async () => {
        try {
          const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/search/anime?keyword=${keyword}`, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": DandanUserAgent,
            },
          });

          // 判断 resp 和 resp.data 是否存在
          if (!resp || !resp.data) {
            log("info", "[Dandan] 原始搜索请求失败或无数据返回 (source: original)");
            return { success: false, source: 'original' };
          }

          // 判断 animes 是否存在且有结果
          if (!resp.data.animes || resp.data.animes.length === 0) {
            log("info", "[Dandan] 原始搜索成功，但未返回任何结果 (source: original)");
            return { success: false, source: 'original' };
          }

          // 原始搜索有结果，中断 TMDB 流程
          tmdbAbortController.abort();
          const animes = resp.data.animes;
          log("info", `dandanSearchresp (original): ${JSON.stringify(animes)}`);
          log("info", `[Dandan] 返回 ${animes.length} 条结果 (source: original)`);
          return { success: true, data: animes, source: 'original' };
        } catch (error) {
          // 捕获原始搜索错误，但不阻塞 TMDB 搜索
          log("error", "getDandanAnimes error:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
          });
          return { success: false, source: 'original' };
        }
      })();

      // 第二次搜索：TMDB 日语原名转换后使用 episodes 接口搜索（并行执行）
      const tmdbSearchPromise = (async () => {
        try {
          // 延迟100毫秒，避免与原始搜索争抢同一连接池
          await new Promise(resolve => setTimeout(resolve, 100));

          // 获取 TMDB 日语原名及中文别名
          const tmdbResult = await getTmdbJaOriginalTitle(keyword, tmdbAbortController.signal, "Dandan");

          // 如果没有结果或者没有标题，则停止
          if (!tmdbResult || !tmdbResult.title) {
            log("info", "[Dandan] TMDB转换未返回结果，取消日语原名搜索");
            return { success: false, source: 'tmdb' };
          }

          const { title: tmdbTitle, cnAlias } = tmdbResult;
          log("info", `[Dandan] 使用日语原名通过 episodes 接口进行搜索: ${tmdbTitle}`);

          // episodes 接口对日语原名的支持更好，使用其进行 TMDB 原名搜索
          const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/search/episodes?anime=${encodeURIComponent(tmdbTitle)}`, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": DandanUserAgent,
            },
            signal: tmdbAbortController.signal,
          });

          // 判断 resp 和 resp.data 是否存在
          if (!resp || !resp.data) {
            log("info", "[Dandan] 日语原名搜索请求失败或无数据返回 (source: tmdb)");
            return { success: false, source: 'tmdb' };
          }

          // 判断 animes 是否存在且有结果
          if (!resp.data.animes || resp.data.animes.length === 0) {
            log("info", "[Dandan] 日语原名搜索成功，但未返回任何结果 (source: tmdb)");
            return { success: false, source: 'tmdb' };
          }

          const animes = resp.data.animes;

          // 标记 TMDB 来源并注入别名，供后续处理环节识别与替换
          for (const anime of animes) {
            anime.isTmdbSource = true;
            anime._tmdbCnAlias = cnAlias;
          }

          log("info", `dandanSearchresp (tmdb): ${JSON.stringify(animes)}`);
          log("info", `[Dandan] 返回 ${animes.length} 条结果 (source: tmdb)`);
          return { success: true, data: animes, source: 'tmdb' };
        } catch (error) {
          // 捕获被中断的错误
          if (error.name === 'AbortError') {
            log("info", "[Dandan] 原始搜索成功，中断日语原名搜索");
            return { success: false, source: 'tmdb', aborted: true };
          }
          // 抛出其他错误（例如 httpGet 超时）
          throw error;
        }
      })();

      // 等待两个搜索任务同时完成，优先采用原始搜索结果
      const [originalResult, tmdbResult] = await Promise.all([
        originalSearchPromise,
        tmdbSearchPromise
      ]);

      // 优先返回原始搜索结果
      if (originalResult.success) {
        return originalResult.data;
      }

      // 原始搜索无结果，返回 TMDB 搜索结果
      if (tmdbResult.success) {
        return tmdbResult.data;
      }

      log("info", `[Dandan] 原始搜索和基于TMDB的搜索均未返回任何结果 (当前搜索词: ${keyword})`);

      // 当搜索无结果且包含季度信息时，尝试剥离季度信息后重新搜索
      if (!isFallback) {
        const strippedKeyword = keyword.replace(/(?:第\s*[0-9一二三四五六七八九十百千万]+\s*[季期部])|(?:S(?:eason)?\s*\d+)|(?:Part\s*\d+)/gi, '').trim();

        if (strippedKeyword && strippedKeyword !== keyword) {
          log("info", `[Dandan] 尝试去除季度信息进行降级搜索: ${strippedKeyword}`);
          return await this.search(strippedKeyword, true);
        }
      }

      return [];
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getDandanAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  // 获取番剧详情和剧集列表
  async getEpisodes(id) {
    try {
      const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/bangumi/${id}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": DandanUserAgent,
        },
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getDandanEposides: 请求失败或无数据返回");
        return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null };
      }

      // 判断 bangumi 数据是否存在
      if (!resp.data.bangumi) {
        log("info", "getDandanEposides: bangumi 数据不存在");
        return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null };
      }

      const bangumiData = resp.data.bangumi;

      // 提取剧集列表，确保它是数组
      const episodes = Array.isArray(bangumiData.episodes) ? bangumiData.episodes : [];

      // 提取标题别名列表
      // 数据源格式: [{"language":"主标题","title":"雨天遇见狸"}, ...]
      const titles = Array.isArray(bangumiData.titles) ? bangumiData.titles.map(t => t.title) : [];

      // 提取相关作品列表以供系列扩展搜索
      const relateds = Array.isArray(bangumiData.relateds) ? bangumiData.relateds : [];

      // 提取番剧类型信息，用于相关作品无法从搜索接口获取该字段时的数据补全
      const type = bangumiData.type || null;
      let typeDescription = bangumiData.typeDescription || null;

      // 识别 3D 与 2D 标签并追加至类型描述
      let is3D = false;
      let is2D = false;
      if (bangumiData.tags && Array.isArray(bangumiData.tags)) {
          bangumiData.tags.forEach(tag => {
              if (tag.name && tag.name.toUpperCase().includes('3D')) is3D = true;
              if (tag.name && tag.name.toUpperCase().includes('2D')) is2D = true;
          });
      }
      if (is3D) {
          typeDescription = "3D" + (typeDescription || "");
      } else if (is2D) {
          typeDescription = "2D" + (typeDescription || "");
      }

      // 提取封面图片 URL，用于 episodes 接口返回结果缺少 imageUrl 时的数据补全
      const imageUrl = bangumiData.imageUrl || null;

      // 正常情况下输出 JSON 字符串
      log("info", `getDandanEposides: ${JSON.stringify(resp.data.bangumi.episodes)}`);

      // 返回包含剧集、别名、相关作品、类型及封面信息的完整对象
      return { episodes, titles, relateds, type, typeDescription, imageUrl };

    } catch (error) {
      // 捕获请求中的错误
      log("error", "getDandanEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null, imageUrl: null };
    }
  }

  // 计算两个字符串的文本相似度（字符集交并比算法）
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = new Set(str1.toLowerCase());
    const s2 = new Set(str2.toLowerCase());
    const intersection = [...s1].filter(char => s2.has(char)).length;
    const union = new Set([...s1, ...s2]).size;
    return intersection / union;
  }

  // 处理并转换番剧信息
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Dandan] sourceAnimes is not a valid array");
      return [];
    }

    // 提取并映射 title 字段以适配 smartTitleReplace 工具
    sourceAnimes.forEach(anime => {
      anime.title = anime.animeTitle;
    });

    // 应用 TMDB 智能标题替换
    const cnAlias = sourceAnimes.length > 0 ? sourceAnimes[0]._tmdbCnAlias : null;
    smartTitleReplace(sourceAnimes, cnAlias);

    // 初始搜索结果数量，用于判断是否展开相关作品搜索
    const initialCount = sourceAnimes.length;
    const existingIds = new Set();
    const queue = [];

    // 初始化任务队列与去重池：将所有初始搜索结果载入队列，标记为非相关作品
    for (const anime of sourceAnimes) {
      existingIds.add(anime.animeId);
      queue.push({ ...anime, isRelated: false });
    }

    // 递归获取所有层级关联作品，批次处理避免并发过载
    while (queue.length > 0) {
      const currentBatch = queue.splice(0, queue.length);

      await Promise.all(currentBatch.map(async (anime) => {
        try {
          // 获取详情数据（包含剧集、别名和相关作品）
          const details = await this.getEpisodes(anime.animeId);
          const eps = details.episodes; // 提取剧集列表
          const apiAliases = details.titles || []; // 提取 API 返回的别名列表

          // 计算当前作品标题与用户原始搜索词的相似度
          const similarity = this.calculateSimilarity(queryTitle, anime.animeTitle);

          // 相似度高于10%时，对每个关联作品单独判断是否符合展开条件：
          // 关联作品标题含季度信息（避免范围发散），或初始搜索结果不少于25个（API25个结果上限，用相关作品突破）
          if (similarity >= 0.1 && details.relateds && Array.isArray(details.relateds)) {
            for (const rel of details.relateds) {
              const hasSeason = getExplicitSeasonNumber(rel.animeTitle) !== null;
              if (!existingIds.has(rel.animeId) && (hasSeason || initialCount >= 25)) {
                existingIds.add(rel.animeId);
                queue.push({
                  animeId: rel.animeId,
                  animeTitle: rel.animeTitle,
                  imageUrl: rel.imageUrl,
                  rating: rel.rating || 0,
                  isRelated: true // 标记动态挖掘出的条目为相关作品
                });
              }
            }
          }

          // 区分初始搜索结果与动态相关作品的结果过滤逻辑
          const allTitles = [anime.animeTitle, ...apiAliases];
          let isMatch = false;

          if (anime.isRelated || anime.isTmdbSource) {
            // 相关作品及TMDB原名搜索结果逻辑：仅执行单纯的季度过滤，跳过常规标题匹配，防止标题差异导致误判
            const querySeason = getExplicitSeasonNumber(queryTitle);
            if (querySeason !== null) {
              let titleSeason = null;
              for (const t of allTitles) {
                if (!t) continue;
                const s = getExplicitSeasonNumber(t);
                if (s !== null) {
                  titleSeason = s;
                  break;
                }
              }
              if (querySeason > 1) {
                isMatch = (titleSeason || 1) === querySeason;
              } else if (querySeason === 1) {
                isMatch = titleSeason === null || titleSeason === 1;
              }
            } else {
              isMatch = true; // 搜索词无指定季度，相关作品直接放行
            }
          } else {
            // 初始数据源逻辑：执行严密的完整标题及季度双重校验
            isMatch = allTitles.some(t => t && titleMatches(t, queryTitle));
          }

          // 丢弃不符合拦截策略的条目，停止后续构建流程
          if (!isMatch) {
            return;
          }

          let links = [];
          for (const ep of eps) {
            // 格式化剧集标题
            const epTitle = ep.episodeTitle && ep.episodeTitle.trim() !== "" ? `${ep.episodeTitle}` : `第${ep.episodeNumber}集`;
            links.push({
              "name": epTitle,
              "url": ep.episodeId.toString(),
              "title": `【dandan】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            // 优先使用 TMDB 智能标题替换后的标题，如果没有则直接使用原标题
            const displayTitle = anime._displayTitle || anime.animeTitle;

            // 合并别名池：API返回的别名 + 原始标题（供合并工具对齐使用）
            const finalAliases = [...apiAliases];
            if (anime.animeTitle && anime.animeTitle !== displayTitle && !finalAliases.includes(anime.animeTitle)) {
              finalAliases.push(anime.animeTitle);
            }

            // 构造标准番剧对象
            // 类型统一从 bangumi 详情接口读取，确保相关作品不会错误继承主作品类型
            const resolvedType = details.type || anime.type || "tvseries";
            const resolvedTypeDescription = details.typeDescription || anime.typeDescription || "TV动画";
            // 年份优先使用搜索接口提供的 startDate，相关作品无此字段时降级到第一话的 airDate
            const resolvedStartDate = anime.startDate || (eps.length > 0 ? eps[0].airDate : null);
            const yearStr = resolvedStartDate ? new Date(resolvedStartDate).getFullYear() : '未知';
            let transformedAnime = {
              animeId: anime.animeId,
              bangumiId: String(anime.animeId),
              animeTitle: `${displayTitle}(${yearStr})【${resolvedTypeDescription}】from dandan`,
              aliases: finalAliases,
              type: resolvedType,
              typeDescription: resolvedTypeDescription,
              imageUrl: details.imageUrl || anime.imageUrl,
              startDate: resolvedStartDate,
              episodeCount: links.length,
              rating: anime.rating || 0,
              isFavorited: true,
              source: "dandan",
            };

            tmpAnimes.push(transformedAnime);

            // 添加到全局缓存
            addAnime({...transformedAnime, links: links}, detailStore);

            // 维护缓存大小
            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Dandan] Error processing anime: ${error.message}`);
        }
      }));
    }

    // 按年份排序并推入当前列表
    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  // 接收 mergedSources 参数，包含所有参与合并的具体源链接信息，用于避免重复获取
  async getEpisodeDanmu(id, mergedSources = []) {
    let allDanmus = [];
    const stats = {}; // 统计各源弹幕数量

    try {
      // 获取 dandan 弹幕
      const dandanPromise = httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=%2Fv2%2Fcomment%2F${id}%3Ffrom%3D0%26withRelated%3Dtrue%26chConvert%3D0`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": DandanUserAgent,
        },
        retries: 1,
      }).catch(e => { log('error', `dandan base comments error: ${e.message}`); return null; });

      const resp = await dandanPromise;

      if (resp && resp.data && resp.data.comments) {
        allDanmus = resp.data.comments;
        stats['dandan'] = allDanmus.length;
      } else {
        stats['dandan'] = 0;
      }

    } catch (error) {
      log("error", "getEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
    }

    return allDanmus;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取弹弹play弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "dandan",
      "segmentList": [{
        "type": "dandan",
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
    return comments.map(c => {
      // 已经被实时抓取的其它源弹幕，略过复杂的 Dandan 转换，进行繁转简处理
      if (c.isRealTimePulled) {
        if (globals.danmuSimplifiedTraditional === 'simplified' && c.m) {
          return { ...c, m: simplized(c.m) };
        }
        return c;
      }

      return {
        cid: c.cid,
        p: `${c.p.replace(/([A-Za-z]+)([0-9a-fA-F]{6})/, (_, platform, hexColor) => {
          // 转换 hexColor 为十进制颜色值
          const r = parseInt(hexColor.substring(0, 2), 16);
          const g = parseInt(hexColor.substring(2, 4), 16);
          const b = parseInt(hexColor.substring(4, 6), 16);
          const decimalColor = r * 256 * 256 + g * 256 + b;
          return `${platform}${decimalColor}`;
        })}`,
        // 根据 globals.danmuSimplifiedTraditional 控制是否繁转简
        m: globals.danmuSimplifiedTraditional === 'simplified' ? simplized(c.m) : c.m,
      };
    });
  }
}
