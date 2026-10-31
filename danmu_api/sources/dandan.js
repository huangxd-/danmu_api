import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { fetchNipaplayDanmaku, fetchNipaplayBangumiDetail, resolveNipaplayLink, applyShiftToDanmu } from '../utils/nipaplay-util.js';
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { getTmdbJaOriginalTitle, smartTitleReplace } from "../utils/tmdb-util.js";
import TencentSource from "./tencent.js";
import IqiyiSource from "./iqiyi.js";
import MangoSource from "./mango.js";
import BilibiliSource from "./bilibili.js";
import YoukuSource from "./youku.js";
import BahamutSource from "./bahamut.js";
import { titleMatches, normalizeTitleForMatch, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";
import { isNonChinese } from "../utils/zh-util.js";
import { searchBangumiData } from '../utils/bangumi-data-util.js';

const tencentSource = new TencentSource();
const iqiyiSource = new IqiyiSource();
const mangoSource = new MangoSource();
const bilibiliSource = new BilibiliSource();
const youkuSource = new YoukuSource();
const bahamutSource = new BahamutSource();

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
    if (globals.useBangumiData && !isFallback) {
      const localMatches = await searchBangumiData(keyword, ['anidb']);
      if (localMatches.length > 0) {
        log("info", `[dandan] Bangumi-Data 本地命中 ${localMatches.length} 条数据（检索词：${keyword}）`);
        return localMatches.map(m => {
          const displayTitle = m.titles.find(t => t && t.includes(keyword)) || m.titles[1] || m.title;
          const finalTitle = displayTitle + (m.titleSuffix || '');

          return {
            animeId: parseInt(m.siteId),
            animeTitle: finalTitle,
            type: m.typeId, 
            typeDescription: m.typeStr, 
            imageUrl: "", 
            startDate: m.begin,
            rating: 0,
            aliases: [...m.titles],
            // 标题与别名取自 Bangumi Data，详情接口不可用时不重复补全
            _bangumiDataHit: true
          };
        });
      }
    }

    try {
      log("info", `[dandan] 原始搜索词: ${keyword}`);

      // 创建 AbortController 用于取消 TMDB 流程
      const tmdbAbortController = new AbortController();

      // 第一次搜索：使用原始关键词搜索番剧列表
      const originalSearchPromise = (async () => {
        try {
          // 经 danmaku-anywhere 镜像弹弹play服务端搜索作品（镜像侧数据按 TTL 延迟更新）
          const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/search/anime?keyword=${keyword}`, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": DandanUserAgent,
            },
			retries: 1,
          });

          // 判断 resp 和 resp.data 是否存在
          if (!resp || !resp.data) {
            log("info", "[dandan] 原始搜索请求失败或无数据返回 (source: original)");
            return { success: false, source: 'original' };
          }

          // 判断 animes 是否存在且有结果
          if (!resp.data.animes || resp.data.animes.length === 0) {
            log("info", "[dandan] 原始搜索成功，但未返回任何结果 (source: original)");
            return { success: false, source: 'original' };
          }
          const animes = resp.data.animes;
          log("info", `[dandan] dandanSearchresp (original): ${JSON.stringify(animes)}`);
          log("info", `[dandan] 返回 ${animes.length} 条结果 (source: original)`);
          return { success: true, data: animes, source: 'original' };
        } catch (error) {
          // 捕获原始搜索错误，但不阻塞 TMDB 搜索
          log("error", "[dandan] getDandanAnimes error:", {
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
            log("info", "[dandan] TMDB转换未返回结果，取消日语原名搜索");
            return { success: false, source: 'tmdb' };
          }

          const { title: tmdbTitle, cnAlias } = tmdbResult;
          log("info", `[dandan] 使用日语原名通过 episodes 接口进行搜索: ${tmdbTitle}`);

          // episodes 接口对日语原名的支持更好，使用其进行 TMDB 原名搜索
          // 经 danmaku-anywhere 镜像弹弹play服务端按 TMDB 原名搜索剧集
          const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/search/episodes?anime=${encodeURIComponent(tmdbTitle)}`, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": DandanUserAgent,
            },
            signal: tmdbAbortController.signal,
			retries: 1,
          });

          // 判断 resp 和 resp.data 是否存在
          if (!resp || !resp.data) {
            log("info", "[dandan] 日语原名搜索请求失败或无数据返回 (source: tmdb)");
            return { success: false, source: 'tmdb' };
          }

          // 判断 animes 是否存在且有结果
          if (!resp.data.animes || resp.data.animes.length === 0) {
            log("info", "[dandan] 日语原名搜索成功，但未返回任何结果 (source: tmdb)");
            return { success: false, source: 'tmdb' };
          }

          const animes = resp.data.animes;

          // 标记 TMDB 来源并注入别名，供后续处理环节识别与替换
          for (const anime of animes) {
            anime.isTmdbSource = true;
            anime._tmdbCnAlias = cnAlias;
          }

          log("info", `[dandan] dandanSearchresp (tmdb): ${JSON.stringify(animes)}`);
          log("info", `[dandan] 返回 ${animes.length} 条结果 (source: tmdb)`);
          return { success: true, data: animes, source: 'tmdb' };
        } catch (error) {
          // 捕获被中断的错误
          if (error.name === 'AbortError') {
            log("info", "[dandan] 原始搜索成功，中断日语原名搜索");
            return { success: false, source: 'tmdb', aborted: true };
          }
          // 抛出其他错误（例如 httpGet 超时）
          throw error;
        }
      })();

      // 搜索结果预过滤：先拿到原始结果再决定是否等待TMDB兜底
      const originalResult = await originalSearchPromise;
      if (originalResult.success) {
        const resolvedSeason = getExplicitSeasonNumber(keyword);
        // 外文检索词（罗马字/英文等）与中文标题无字符交集，包含与相似度匹配必然失败，
        // 会误杀 dandan 官方搜索的正确命中（如 "Sayonara Lara" → "再见，拉拉"，animeId 已正确返回）。
        // 两级策略：标题直击优先——归一化标题包含检索词的条目存在时只返回直击条目
        // （如 "mygo" 只回标题含 MyGO 的 BanG Dream，滤掉别名子串混入的我女神系列）；
        // 无直击时全量放行，交由 handleAnimes 用详情接口的别名池（含罗马字标题）做最终判定。
        let preFiltered;
        if (isNonChinese(keyword)) {
          const kw = normalizeTitleForMatch(keyword).toLowerCase();
          if (kw) {
            const directHits = originalResult.data.filter(anime => {
              if (anime.isTmdbSource) return true;
              const t = normalizeTitleForMatch(anime.animeTitle || anime.title || '').toLowerCase();
              return t.includes(kw);
            });
            preFiltered = directHits.length > 0 ? directHits : originalResult.data;
          } else {
            // 归一化后为空的检索词（纯符号/空白）无语义，维持全量放行
            preFiltered = originalResult.data;
          }
        } else {
          preFiltered = originalResult.data.filter(anime => {
            if (anime.isTmdbSource) return true;
            const t = anime.animeTitle || anime.title || '';
            return titleMatches(t, keyword, resolvedSeason, true, 0.8);
          });
        }
        if (preFiltered.length > 0) {
          tmdbAbortController.abort();
          // 记录原始搜索结果的全部animeId，供handleAnimes关联作品恢复误过滤条目使用
          preFiltered._originalAnimeIds = originalResult.data.map(a => a.animeId);
          return preFiltered;
        }
        // 初筛清空原始结果时不abort，等待TMDB兜底
      }

      // 原始搜索无结果或被初筛清空，等待并返回TMDB搜索结果
      const tmdbResult = await tmdbSearchPromise;

      // 原始搜索无结果，对TMDB日语原名结果做最终预过滤
      if (tmdbResult.success) {
        const resolvedSeason = getExplicitSeasonNumber(keyword);
        if (isNonChinese(keyword)) {
          // 外文检索词与 TMDB episodes 返回的中文标题无字符交集，titleMatches 会全灭整批结果（同 original 路径根因）。
          // 剥离 isTmdbSource 免检标记与 _tmdbCnAlias，使 handleAnimes 走常规 allTitles 匹配：
          // 用详情接口的别名池（含罗马字/英文别名）做最终判定，别名池不含检索词的无关条目（同字异作）会被自然过滤。
          const relaxed = tmdbResult.data.map(({ isTmdbSource, _tmdbCnAlias, ...rest }) => rest);
          if (relaxed.length > 0) {
            log("info", `[dandan] 外文检索词跳过TMDB结果预过滤，剥离免检标记后交由别名池匹配 (${relaxed.length} 条)`);
            return relaxed;
          }
        } else {
          const tmdbFiltered = tmdbResult.data.filter(anime => {
            const t = anime.animeTitle || anime.title || '';
            return titleMatches(t, keyword, resolvedSeason, true, 0.19);
          });
          if (tmdbFiltered.length > 0) return tmdbFiltered;
        }
      }

      log("info", `[dandan] 原始搜索和基于TMDB的搜索均未返回任何结果 (当前搜索词: ${keyword})`);

      // 当搜索无结果且包含季度信息时，尝试剥离季度信息后重新搜索
      if (!isFallback) {
        const strippedKeyword = keyword.replace(/(?:第\s*[0-9一二三四五六七八九十百千万]+\s*[季期部])|(?:S(?:eason)?\s*\d+)|(?:Part\s*\d+)/gi, '').trim();

        if (strippedKeyword && strippedKeyword !== keyword) {
          log("info", `[dandan] 尝试去除季度信息进行降级搜索: ${strippedKeyword}`);
          return await this.search(strippedKeyword, true);
        }
      }

      return [];
    } catch (error) {
      // 捕获请求中的错误
      log("error", "[dandan] getDandanAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  // 获取番剧详情和剧集列表
  async getEpisodes(id, contextAnime = null) {
    try {
      // 经 danmaku-anywhere 镜像弹弹play服务端获取作品详情与剧集列表
      const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/bangumi/${id}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": DandanUserAgent,
        },
        retries: 1,
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "[dandan] getDandanEposides: 请求失败或无数据返回");
        return await this.resolveUnavailableDetail(id, contextAnime);
      }

      // 判断 bangumi 数据是否存在
      if (!resp.data.bangumi) {
        log("info", "[dandan] getDandanEposides: bangumi 数据不存在");
        return await this.resolveUnavailableDetail(id, contextAnime);
      }

      const bangumiData = resp.data.bangumi;

      // danmaku-anywhere 镜像弹弹play服务端详情接口未返回剧集时由 NipaPlay 中转弹弹play服务端兜底：danmaku-anywhere 镜像服务端集未更新时取原站数据
      const nipaplayDetail = (Array.isArray(bangumiData.episodes) ? bangumiData.episodes.length : 0) === 0
        ? await fetchNipaplayBangumiDetail(id)
        : null;
      if (nipaplayDetail) log("info", "[dandan] getDandanEposides: danmaku-anywhere 镜像弹弹play服务端未返回剧集，详情取自 NipaPlay 中转弹弹play服务端");
      const detail = nipaplayDetail || bangumiData;

      return await this.extractDetailResult(id, detail);

    } catch (error) {
      // 捕获请求中的错误：httpGet 重试耗尽后以异常抛出，此处同样进入详情不可用的兜底
      log("error", "[dandan] getDandanEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return await this.resolveUnavailableDetail(id, contextAnime);
    }
  }

  // 详情接口重试后仍不可用时的兜底：NipaPlay 中转弹弹play服务端优先，其次按 Bangumi Data 补全剧集。
  // Bangumi Data 不提供相关作品、标签与封面，返回空值；标题与别名仅在搜索条目未由 Bangumi Data 提供时补全。
  async resolveUnavailableDetail(id, contextAnime, lookupItem = lookupBangumiDataItemByAnime) {
    const nipaplayDetail = await fetchNipaplayBangumiDetail(id);
    if (nipaplayDetail) {
      log("info", "[dandan] getDandanEposides: 详情接口不可用，详情取自 NipaPlay 中转弹弹play服务端");
      return await this.extractDetailResult(id, nipaplayDetail);
    }

    const item = await lookupItem(contextAnime, id);
    if (!item) {
      log("info", `[dandan] getDandanEposides: 详情接口不可用，Bangumi Data 未命中条目（作品 ${id}）`);
      return emptyEpisodeDetail();
    }

    // 整部无集：按 Bangumi Data 的放送区间推算集数；详情不可用故无 metadata 可回退，lookup 直接复用已定位到的条目
    const filledEpisodes = await fillMissingEpisodes(id, { metadata: [] }, [], async () => item);
    if (filledEpisodes.length === 0) return emptyEpisodeDetail();

    const fromBangumiData = contextAnime?._bangumiDataHit === true;
    const titles = fromBangumiData ? [] : [...new Set(item.titles || [])];
    log("info", `[dandan] getDandanEposides: 详情接口不可用，按 Bangumi Data 补全 ${filledEpisodes.length} 集（作品 ${id}）`);
    return {
      episodes: filledEpisodes,
      titles,
      relateds: [],
      type: item.typeId || null,
      typeDescription: item.typeStr || null,
      imageUrl: null,
    };
  }

  // 从详情数据提取剧集、别名、相关作品、类型与封面，并按 Bangumi Data 的放送区间补全缺失集
  async extractDetailResult(id, detail) {
    // 提取剧集列表，确保它是数组
    const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];

    // 提取标题别名列表
    // 数据源格式: [{"language":"主标题","title":"雨天遇见狸"}, ...]
    const titles = Array.isArray(detail.titles) ? detail.titles.map(t => t.title) : [];

    // 提取相关作品列表以供系列扩展搜索
    const relateds = Array.isArray(detail.relateds) ? detail.relateds : [];

    // 提取番剧类型信息，用于相关作品无法从搜索接口获取该字段时的数据补全
    const type = detail.type || null;
    let typeDescription = detail.typeDescription || null;

    // 识别 3D 与 2D 标签并追加至类型描述
    let is3D = false;
    let is2D = false;
    if (detail.tags && Array.isArray(detail.tags)) {
      detail.tags.forEach(tag => {
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
    const imageUrl = detail.imageUrl || null;

    // 集缺失时按 Bangumi Data 的放送区间推理补全：覆盖 danmaku-anywhere 镜像弹弹play服务端集未更新与整部无集两种情形
    const filledEpisodes = await fillMissingEpisodes(id, detail, episodes);

    // 正常情况下输出 JSON 字符串
    log("info", `[dandan] getDandanEposides: ${JSON.stringify(filledEpisodes)}`);

    // 返回包含剧集、别名、相关作品、类型及封面信息的完整对象
    return { episodes: filledEpisodes, titles, relateds, type, typeDescription, imageUrl };
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

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[dandan] sourceAnimes is not a valid array");
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

    // 提取搜索词中的明确季度信息或使用传入的季度参数
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    // 初始列表预过滤机制：若用户指定了季度，优先检查初始结果中是否已包含匹配项
    let matchedAnimes = sourceAnimes;
    let isTargetFoundInInitial = false;

    if (resolvedQuerySeason !== null) {
      const filtered = sourceAnimes.filter(anime => {
        const titleToCheck = anime._displayTitle || anime.animeTitle;
        const s = extractSeasonNumberFromAnimeTitle(titleToCheck).season;
        return s === resolvedQuerySeason || (resolvedQuerySeason === 1 && s === null);
      });

      // 如果已命中目标，减少详情请求量
      if (filtered.length > 0) {
        matchedAnimes = filtered;
        isTargetFoundInInitial = true;
        log("info", `[dandan] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    // 初始化任务队列与去重池：将筛选后的条目载入队列，标记为非相关作品
    for (const anime of matchedAnimes) {
      existingIds.add(anime.animeId);
      queue.push({ ...anime, isRelated: false });
    }

    // 递归获取所有层级关联作品，批次处理避免并发过载
    while (queue.length > 0) {
      const currentBatch = queue.splice(0, queue.length);

      await Promise.all(currentBatch.map(async (anime) => {
        try {
          // 获取详情数据（包含剧集、别名和相关作品）
          const details = await this.getEpisodes(anime.animeId, anime);
          const eps = details.episodes; // 提取剧集列表
          const apiAliases = details.titles || []; // 提取 API 返回的别名列表

          // 计算当前作品标题与用户原始搜索词的相似度
          const similarity = this.calculateSimilarity(queryTitle, anime.animeTitle);

          // 关联挖掘控制逻辑：仅当用户未指定明确季度，或者初始扫描未命中目标季度时，才执行相关作品的深度展开
          const canExpandRelateds = !isTargetFoundInInitial;

          // 相似度高于10%时，对每个关联作品单独判断是否符合展开条件：
          // 关联作品标题含季度信息（避免范围发散），或初始搜索结果不少于25个（API25个结果上限，用相关作品突破）
          if (similarity >= 0.1 && details.relateds && Array.isArray(details.relateds)) {
            for (const rel of details.relateds) {
              const hasSeason = extractSeasonNumberFromAnimeTitle(rel.animeTitle).season !== null;
              if (!existingIds.has(rel.animeId) && (hasSeason || initialCount >= 25)) {
                existingIds.add(rel.animeId);
                // 关联作品追加到sourceAnimes供跨季扩展感知
                if (!sourceAnimes.some(a => a.animeId === rel.animeId)) {
                  sourceAnimes.push({
                    animeId: rel.animeId,
                    animeTitle: rel.animeTitle,
                    title: rel.animeTitle,
                    imageUrl: rel.imageUrl,
                    rating: rel.rating || 0,
                    isRelated: true
                  });
                }
                if (canExpandRelateds) {
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

            // 关联作品补回预过滤误剔除的原始搜索结果条目（如翻译差异导致误过滤）
            if (!isTargetFoundInInitial && Array.isArray(details.relateds)) {
              const originalIds = sourceAnimes._originalAnimeIds;
              if (Array.isArray(originalIds) && originalIds.length > 0) {
                const recoveredIds = new Set(originalIds);
                for (const rel of details.relateds) {
                  if (recoveredIds.has(rel.animeId) && !existingIds.has(rel.animeId)) {
                    existingIds.add(rel.animeId);
                    if (!sourceAnimes.some(a => a.animeId === rel.animeId)) {
                      sourceAnimes.push({
                        animeId: rel.animeId,
                        animeTitle: rel.animeTitle,
                        title: rel.animeTitle,
                        imageUrl: rel.imageUrl,
                        rating: rel.rating || 0,
                        isRelated: true
                      });
                    }
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
            }
          }

          // 区分初始搜索结果与动态相关作品的结果过滤逻辑
          const allTitles = [
            anime.animeTitle, 
            ...apiAliases, 
            ...(anime.aliases || [])
          ];
          let isMatch = false;

          if (anime.isRelated || anime.isTmdbSource) {
            // 相关作品及TMDB原名搜索结果逻辑：仅执行单纯的季度过滤，跳过常规标题匹配，防止标题差异导致误判
            if (resolvedQuerySeason !== null) {
              let titleSeason = null;
              for (const t of allTitles) {
                if (!t) continue;
                const s = getExplicitSeasonNumber(t);
                if (s !== null) {
                  titleSeason = s;
                  break;
                }
              }
              if (resolvedQuerySeason > 1) {
                isMatch = (titleSeason || 1) === resolvedQuerySeason;
              } else if (resolvedQuerySeason === 1) {
                isMatch = titleSeason === null || titleSeason === 1;
              }
            } else {
              isMatch = true; // 搜索词无指定季度，相关作品直接放行
            }
          } else {
            // 初始数据源逻辑：执行严密的完整标题及季度双重校验
            isMatch = allTitles.some(t => t && titleMatches(t, queryTitle, resolvedQuerySeason));
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
            const finalAliases = [...new Set([...apiAliases, ...(anime.aliases || [])])];
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
          log("error", `[dandan] Error processing anime: ${error.message}`);
        }
      }));
    }

    // 按年份排序并推入当前列表
    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  // 合并链接按 $$$ 拆分后逐段传入，每段形如 `<源名>:<真实ID>`；据此取出已参与合并的源名，避免对其重复拉取
  async getEpisodeDanmu(id, mergedSources = []) {
    const coveredSources = new Set((mergedSources || [])
      .map((part) => String(part).split(':')[0])
      .filter(Boolean));

    try {
      // 配置弹弹play账号后经 NipaPlay 中转弹弹play服务端取弹幕，并把同一请求下发的弹弹302关联链接分发给
      // 已在 SOURCE_ORDER 开启的对应平台源实时拉取，两部分由去重阶段按来源合并；
      // 未配置账号或 NipaPlay 中转弹弹play服务端不可用时回退弹弹原生弹幕。
      const nipaplay = await fetchNipaplayDanmaku(id);
      if (!nipaplay) return await fetchDandanComments(id);

      const related = await getRelatedDanmuViaNipaplay(nipaplay.relatedLinks, coveredSources);
      log("info", `[dandan] NipaPlay 中转弹弹play服务端弹幕 ${nipaplay.comments.length} 条，弹弹302关联链接获取 ${related.length} 条`);
      return [...nipaplay.comments, ...related];
    } catch (error) {
      log("error", "[dandan] getEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "[dandan] 获取弹弹play弹幕分段列表...", id);

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
      // 已经被实时抓取的其它源弹幕，略过复杂的 Dandan 转换。
      if (c.isRealTimePulled) {
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
        m: c.m,
      };
    });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// 补全集标题标记，用于区分系统按放送区间推理出的集
const SYSTEM_FILLED_MARK = '（系统补全）';

// 解析时间字符串为毫秒时间戳，无法解析时返回 null
function parseTimeValue(value) {
  if (!value || typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// 从详情接口 metadata 的「放送开始」提取放送日期；仅记录到年（如「放送开始: 2026年」）时无法确定周次，返回 null
export function extractBroadcastStart(metadata) {
  if (!Array.isArray(metadata)) return null;
  const entry = metadata.find((line) => typeof line === 'string' && line.trim().startsWith('放送开始'));
  const match = entry && entry.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? time : null;
}

// 详情接口的 bangumiUrl 指向 bangumi.tv/subject/{id}，据此与 Bangumi Data 条目的站点 id 精确对应
function extractBangumiSubjectId(bangumiUrl) {
  const match = typeof bangumiUrl === 'string' ? bangumiUrl.match(/(?:bangumi|bgm)\.tv\/subject\/(\d+)/) : null;
  return match ? match[1] : null;
}

// 按一周一集推算从放送开始到指定时间应有的集数（含首集）
function countEpisodesWeekly(beginTime, untilTime) {
  return Math.floor((untilTime - beginTime) / WEEK_MS) + 1;
}

// 生成补全集：集号自现有正片集顺延，id 沿用弹弹play 的 animeId + 4 位集号，插入在正片之后、番外之前
function buildFilledEpisodes(animeId, episodes, totalCount) {
  const normalNumbers = episodes
    .filter((ep) => /^\d+$/.test(String(ep.episodeNumber ?? '')))
    .map((ep) => Number(ep.episodeNumber));
  const lastNumber = normalNumbers.length > 0 ? Math.max(...normalNumbers) : 0;
  const filled = [];
  for (let n = lastNumber + 1; n <= totalCount; n++) {
    filled.push({
      seasonId: null,
      episodeId: Number(`${animeId}${String(n).padStart(4, '0')}`),
      episodeTitle: `第${n}话 ${SYSTEM_FILLED_MARK}`,
      episodeNumber: String(n),
      lastWatched: null,
      airDate: null,
    });
  }
  if (filled.length === 0) return episodes;
  const lastNormalIndex = episodes.reduce((acc, ep, i) => (/^\d+$/.test(String(ep.episodeNumber ?? '')) ? i : acc), -1);
  return [...episodes.slice(0, lastNormalIndex + 1), ...filled, ...episodes.slice(lastNormalIndex + 1)];
}

// 详情不可用且兜底无结果时的空返回，保持调用方原有的字段结构
function emptyEpisodeDetail() {
  return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null, imageUrl: null };
}

// 从按 anidb 与 bangumi 站点检索出的结果中挑选对应条目。弹弹play 的作品 id 与 Bangumi Data 的 anidb 站点 id 同源，优先取 anidb id 一致且唯一的一条。
// 同一 anidb id 对应多个分部条目、或该作品没有 anidb 站点记录时，回退到 bangumi 站点 id。
export function selectBangumiDataItem(matches, animeId, subjectId) {
  const anidbMatches = (matches || []).filter((m) => m.matchedSiteKey === 'anidb' && String(m.siteId) === String(animeId));
  if (anidbMatches.length === 1) return anidbMatches[0];
  return (matches || []).find((m) => m.matchedSiteKey === 'bangumi' && String(m.siteId) === subjectId) || null;
}

// 在 Bangumi Data 中定位详情接口对应的条目：标题取自详情接口主标题
async function lookupBangumiDataItem(detail, animeId) {
  const searchTitle = (Array.isArray(detail.titles) ? detail.titles.find((t) => t?.language === '主标题')?.title : null)
    || detail.animeTitle;
  if (!searchTitle) return null;
  const matches = await searchBangumiData(searchTitle, ['anidb', 'bangumi']);
  return selectBangumiDataItem(matches, animeId, extractBangumiSubjectId(detail.bangumiUrl));
}

// 详情接口不可用时以搜索条目的标题与别名在 Bangumi Data 中逐个检索：此时详情主标题不可得，只能以搜索条目作检索词
async function lookupBangumiDataItemByAnime(anime, animeId) {
  const keywords = [anime?.animeTitle, ...(anime?.aliases || [])].filter(Boolean);
  for (const keyword of keywords) {
    const matches = await searchBangumiData(keyword, ['anidb']);
    const item = selectBangumiDataItem(matches, animeId, null);
    if (item) return item;
  }
  return null;
}

// 放送截止日期与用户系统时间均不可知时按该集数补全（云部署等环境下运行期时间不可用时的兜底）
const DEFAULT_FILL_EPISODE_COUNT = 26;

// 集数推算上限：按放送区间一周一集线性推集会随放送时长放大（长寿番可推至数千集），超过上限时按上限处理
const MAX_FILL_EPISODE_COUNT = 100;

// 集数推算结果的日志文本：超过上限时注明按上限补全，并保留原始推算值
function describeFillCount(inferredCount) {
  return inferredCount > MAX_FILL_EPISODE_COUNT
    ? `${inferredCount} 集，超过上限按 ${MAX_FILL_EPISODE_COUNT} 集补全`
    : `${inferredCount} 集`;
}

// 按 Bangumi Data 的放送区间推理并补全详情接口缺失的集。
// 放送开始须可取到（Bangumi Data 的 begin，缺失时回退详情接口 metadata 的放送开始），取不到时不补全。
// 放送截止依次回退 end、用户系统时间（按当前周推算并额外补两集）、默认集数。
// 已有集时仅补齐末集之后的集，整部无集时按放送区间推算总集数，推算集数受 MAX_FILL_EPISODE_COUNT 约束。
export async function fillMissingEpisodes(animeId, detail, episodes, lookupItem = lookupBangumiDataItem, now = Date.now()) {
  // 补全日志的作品标识：作品 id 与主标题，用于区分同一次流程中不同作品的判定结果
  const mainTitle = (Array.isArray(detail.titles) ? detail.titles.find((t) => t?.language === '主标题')?.title : null) || detail.animeTitle || '';
  const fillLabel = mainTitle ? `${animeId} ${mainTitle}` : `${animeId}`;
  const normalEpisodes = episodes.filter((ep) => /^\d+$/.test(String(ep.episodeNumber ?? '')));
  const lastAirTime = normalEpisodes.length > 0
    ? parseTimeValue(normalEpisodes[normalEpisodes.length - 1].airDate)
    : null;
  // 末集放送日期在一周内时不可能缺集，无需查询 Bangumi Data
  if (episodes.length > 0 && lastAirTime !== null && now - lastAirTime < WEEK_MS) return episodes;

  const item = await lookupItem(detail, animeId);
  const beginTime = parseTimeValue(item?.begin) ?? extractBroadcastStart(detail.metadata);
  if (beginTime === null) {
    log("info", `[dandan] 集补全跳过（${fillLabel}）：放送开始时间不可知`);
    return episodes;
  }
  const endTime = parseTimeValue(item?.end);

  if (episodes.length === 0) {
    let totalCount;
    if (endTime !== null) {
      totalCount = countEpisodesWeekly(beginTime, endTime);
      log("info", `[dandan] 集补全（${fillLabel}，整部无集，按放送区间）: 应有 ${describeFillCount(totalCount)}`);
    } else if (Number.isFinite(now)) {
      totalCount = countEpisodesWeekly(beginTime, now) + 2;
      log("info", `[dandan] 集补全（${fillLabel}，整部无集，放送截止不可知按当前周并额外补两集）: 应有 ${describeFillCount(totalCount)}`);
    } else {
      totalCount = DEFAULT_FILL_EPISODE_COUNT;
      log("info", `[dandan] 集补全（${fillLabel}，整部无集，放送截止与系统时间均不可知，按默认集数）: 应有 ${describeFillCount(totalCount)}`);
    }
    return buildFilledEpisodes(animeId, episodes, Math.max(1, Math.min(MAX_FILL_EPISODE_COUNT, totalCount)));
  }

  if (endTime === null) {
    log("info", `[dandan] 集补全跳过（${fillLabel}）：已存在集且放送截止不可知`);
    return episodes;
  }
  // 末集放送日期与放送结束相同或相差不超过两天，说明中途有周未放送，集数正确
  if (lastAirTime !== null && Math.abs(endTime - lastAirTime) <= 2 * DAY_MS) {
    log("info", `[dandan] 集补全跳过（${fillLabel}）：末集放送日期已对齐放送截止`);
    return episodes;
  }
  const inferredCount = countEpisodesWeekly(beginTime, endTime);
  const totalCount = Math.min(MAX_FILL_EPISODE_COUNT, inferredCount);
  if (totalCount <= normalEpisodes.length) {
    log("info", `[dandan] 集补全跳过（${fillLabel}）：按放送区间应有 ${totalCount} 集，未超过现有 ${normalEpisodes.length} 集`);
    return episodes;
  }
  log("info", `[dandan] 集补全（${fillLabel}，补齐末集之后的集）: 按放送区间应有 ${describeFillCount(inferredCount)}，现有 ${normalEpisodes.length} 集，补 ${totalCount - normalEpisodes.length} 集`);
  return buildFilledEpisodes(animeId, episodes, totalCount);
}

const DandanUserAgent = `LogVar Danmu API/${globals.version}`

// 源标识 → 平台标识映射，与核心路由一致（见 ALLOWED_PLATFORMS：bilibili1/qq/qiyi/imgo 等），
// 使实时拉取的弹弹302关联弹幕在 [来源＆平台] 标签中标注真实平台，并让去重阶段按来源统计重复弹幕。
const SOURCE_TO_PLATFORM = {
  bilibili: 'bilibili1',
  bahamut: 'bahamut',
  iqiyi: 'qiyi',
  youku: 'youku',
  tencent: 'qq',
  imgo: 'imgo',
};

// 汇总跨平台实时弹幕，复用核心路由同款链接解析（gamer→sn）与各源既有 formatComments，
// 使每源入参与核心路由一致；仅分发已在 SOURCE_ORDER 开启且未被已独立选择的合并源覆盖的平台；
// 每条弹幕标记实时拉取来源，供 convertToDanmakuJson 组装 [来源＆平台] 标签，并让去重阶段按真实来源统计重复弹幕；
// 同平台多个链接串行、间隔 1 秒请求，与手动解析链接防风控一致。
async function getRelatedDanmuViaNipaplay(links, coveredSources) {
  if (!links) return [];
  // 关联链接的源需已在 SOURCE_ORDER 中开启，与搜索可选源保持一致
  const enabledSources = new Set(globals.sourceOrderArr);
  const summary = Object.entries(links)
    .filter(([p, arr]) => arr && arr.length && enabledSources.has(p))
    .map(([p, arr]) => `${SOURCE_TO_PLATFORM[p] || p}×${arr.length}`)
    .join(', ');
  if (summary) log("info", `[dandan] 弹弹302关联链接分发目标: ${summary}`);
  const sourceMap = {
    bilibili: bilibiliSource,
    bahamut: bahamutSource,
    iqiyi: iqiyiSource,
    youku: youkuSource,
    tencent: tencentSource,
    imgo: mangoSource,
  };
  // 收集待拉取任务（按平台标识分组以便同平台串行），未在 SOURCE_ORDER 开启的源与已独立选择的合并源跳过。
  const pending = [];
  const skippedDisabled = [];
  const skippedCovered = [];
  for (const [platform, linksOfPlatform] of Object.entries(links)) {
    if (!linksOfPlatform || linksOfPlatform.length === 0) continue;
    const platformLabel = SOURCE_TO_PLATFORM[platform];
    if (!platformLabel) continue;
    if (!enabledSources.has(platform)) {
      skippedDisabled.push(platformLabel);
      continue;
    }
    if (coveredSources.has(platform) || coveredSources.has(platformLabel)) {
      skippedCovered.push(platformLabel);
      continue;
    }
    const sourceInstance = sourceMap[platform];
    if (!sourceInstance) continue;
    for (const { url, shift } of linksOfPlatform) {
      const { source, realId } = resolveNipaplayLink(url);
      if (source !== platform) {
        log("info", `[dandan] 弹弹302关联链接平台解析不一致，声明 ${platform} 实得 ${source}，跳过: ${url}`);
        continue;
      }
      pending.push({
        platformLabel,
        run: () => sourceInstance.getEpisodeDanmu(realId)
          .then((raw) => sourceInstance.formatComments(raw || []).map((d) => applyShiftToDanmu({ ...d, realTimeSource: platformLabel }, shift)))
          .catch((e) => { log("error", `[dandan] 弹弹302关联拉取 ${platformLabel} 失败: ${e.message}`); return []; }),
      });
    }
  }
  if (skippedCovered.length) log("info", `[dandan] 弹弹302关联分发跳过已合并源（避免重复拉取）: ${skippedCovered.join(', ')}`);
  if (skippedDisabled.length) log("info", `[dandan] 弹弹302关联分发跳过未在 SOURCE_ORDER 开启的源: ${skippedDisabled.join(', ')}`);
  // 同平台串行、间隔 1 秒，不同平台并行（防风控）。
  const groups = new Map();
  for (const task of pending) {
    if (!groups.has(task.platformLabel)) groups.set(task.platformLabel, []);
    groups.get(task.platformLabel).push(task.run);
  }
  const results = await Promise.all(Array.from(groups.values()).map(async (runs) => {
    const items = [];
    for (let i = 0; i < runs.length; i++) {
      // 每个任务返回单链接弹幕数组，展开后 items 为本平台串行汇总，便于最终 flat 拉平为单条弹幕。
      items.push(...await runs[i]());
      if (i < runs.length - 1) await new Promise((r) => setTimeout(r, 1000));
    }
    return items;
  }));
  return results.flat().filter(Boolean);
}

// 请求弹弹play原生弹幕：未配置弹弹play账号或 NipaPlay 中转弹弹play服务端不可用时使用；失败时返回空数组以免阻断后续流程。
async function fetchDandanComments(id) {
  try {
    // 经 danmaku-anywhere 镜像弹弹play服务端获取弹弹play原生弹幕
    const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=%2Fv2%2Fcomment%2F${id}%3Ffrom%3D0%26withRelated%3Dtrue%26chConvert%3D0`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": DandanUserAgent,
      },
      retries: 1,
    });
    if (resp && resp.data && resp.data.comments) return resp.data.comments;
    return [];
  } catch (e) {
    log("error", `[dandan] dandan base comments error: ${e.message}`);
    return [];
  }
}
