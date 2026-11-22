import { globals } from '../configs/globals.js';
import { getPageTitle, jsonResponse, httpGet, sourceLogContext, runWithHttpCache, httpCacheContext } from '../utils/http-util.js';
import { log } from '../utils/log-util.js'
import { simplized } from '../utils/zh-util.js';
import { setRedisKey, updateRedisCaches } from "../utils/redis-util.js";
import { setLocalRedisKey, updateLocalRedisCaches } from "../utils/local-redis-util.js";
import {
    setCommentCache, addAnime, findAnimeIdByCommentId, findTitleById, findUrlById, getCommentCache, getPreferAnimeId,
    getSearchCache, removeEarliestAnime, resolveAnimeById, resolveAnimeByIdFromDetailStore, setPreferByAnimeId, setPreferForTitle, setSearchCache, storeAnimeIdsToMap, writeCacheToFile,
    updateLocalCaches, setLastSearch, getLastSearch, findAnimeTitleById, findIndexById, hasSeasonSpecificPreference, hasLegacySeasonPreference, getAddAnimeError, mergeAddAnimeError
} from "../utils/cache-util.js";
import { resolveFavoriteForSearchKeyword } from "../utils/favorite-util.js";
import { formatDanmuResponse, convertToDanmakuJson } from "../utils/danmu-util.js";
import { resolveOffsetRule, applyOffset, stripLinkOffset, offsetDuration } from "../utils/offset-util.js";
import { filterMappingQualifierCandidates, filterMappingTargetCandidates, resolveAutoMatchMapping } from "../utils/auto-match-mapping-util.js";
import { ensureRemoteAutoMatchMapping, getEffectiveAutoMatchMappingRules } from "../utils/auto-match-mapping-url-util.js";
import { 
  extractEpisodeTitle, convertChineseNumber, parseFileName, createDynamicPlatformOrder, normalizeTitleForMatch,
  extractYear, titleMatches, extractAnimeInfo, extractEpisodeNumberFromTitle, extractSeasonNumberFromAnimeTitle, extractAnimeTitle
} from "../utils/common-util.js";
import { getTMDBChineseTitle, getTmdbSeasonBoundaries } from "../utils/tmdb-util.js";
import { applyMergeLogic, mergeDanmakuList, MERGE_DELIMITER, alignSourceTimelines, sanitizeUrl } from "../utils/merge-util.js";
import { getHanjutvSourceLabel } from "../utils/hanjutv-util.js";
import AIClient from '../utils/ai-util.js';
import { getSourceByKey, getSourceMetaByKey, getSourceLabel, getLogNameByKey } from "../sources/registry.js";
import { isHongguoPlayerUrl, isHongguoSeriesId } from "../sources/hongguo.js";
import BilibiliSource from "../sources/bilibili.js"; // resolveB23Link 为 BilibiliSource 实例方法，单测中仍需直接 new
import { Anime, AnimeMatch, Episodes, Bangumi } from "../models/dandan-model.js";
import { createPhaseTimer, describeConfigValue, maskCredentialParams, markStepActive, peekConfigEffects, traceStep, recordConfigEffect } from "../utils/pipeline-trace.js";

// =====================
// 兼容弹弹play接口
// =====================

// 所有弹幕源实例统一由 sources/registry.js 注册表管理并按依赖顺序实例化，
// 新增源只需在 registry.js 加一条配置，无需在此处 import / new / 维护 if/else 分发链。
// 下列局部变量保留与原变量名一致，供文件内既有的源实例引用直接使用（一次性从注册表取用）。
const kan360Source = getSourceByKey('360');
const vodSource = getSourceByKey('vod');
const renrenSource = getSourceByKey('renren');
const hanjutvSource = getSourceByKey('hanjutv');
const bahamutSource = getSourceByKey('bahamut');
const dandanSource = getSourceByKey('dandan');
const customSource = getSourceByKey('custom');
const tencentSource = getSourceByKey('tencent');
const youkuSource = getSourceByKey('youku');
const iqiyiSource = getSourceByKey('iqiyi');
const mangoSource = getSourceByKey('imgo');
const bilibiliSource = getSourceByKey('bilibili');
const miguSource = getSourceByKey('migu');
const sohuSource = getSourceByKey('sohu');
const leshiSource = getSourceByKey('leshi');
const xiguaSource = getSourceByKey('xigua');
const maiduiduiSource = getSourceByKey('maiduidui');
const aiyifanSource = getSourceByKey('aiyifan');
const hongguoSource = getSourceByKey('hongguo');
const animekoSource = getSourceByKey('animeko');
const otherSource = getSourceByKey('other');
const localSource = getSourceByKey('local');
const doubanSource = getSourceByKey('douban');
const tmdbSource = getSourceByKey('tmdb');

// 用于聚合请求的去重Map
const PENDING_DANMAKU_REQUESTS = new Map();

// 统计源返回的原始候选数量，兼容数组与 VOD 多服务器返回结构
function countRawCandidates(searchResult) {
  if (!Array.isArray(searchResult)) return 0;
  let total = 0;
  for (const item of searchResult) {
    total += (item && Array.isArray(item.list)) ? item.list.length : 1;
  }
  return total;
}

function resolveCommentCacheKey(url) {
  const value = String(url || "");
  if (!globals.hongguoMergeAllEpisodes) return url;
  const containsHongguo = value.includes("hongguo:") || /https?:\/\/(?:www\.)?hongguoduanju\.com(?::\d+)?\/player\//i.test(value);
  return containsHongguo ? `${value}::hongguo-all-episodes` : url;
}

function normalizeDurationValue(rawValue) {
  const duration = Number(rawValue || 0);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration > 6 * 60 * 60 ? duration / 1000 : duration;
}

function shouldIncludeVideoDuration(queryFormat, includeDuration = false) {
  if (!includeDuration) return false;
  const format = String(queryFormat || globals.danmuOutputFormat || 'json').toLowerCase();
  return format === 'json';
}

// 从本步骤尚未归并的配置生效记录中取最早的弹幕条数，作为处理前数量；无记录时返回 null
function stepEffectsRawDanmuCount() {
  for (const effect of peekConfigEffects()) {
    const value = effect.before?.['弹幕条数'];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function buildDanmuResponse(data, videoDuration = null) {
  if (videoDuration === null) return data;
  return { videoDuration, ...data };
}

function extractDurationFromSegments(segmentResult) {
  const explicitDuration = normalizeDurationValue(segmentResult?.duration || segmentResult?.videoDuration || 0);
  if (explicitDuration > 0) return explicitDuration;

  const segmentList = Array.isArray(segmentResult?.segmentList) ? segmentResult.segmentList : [];
  if (!segmentList.length) return 0;

  let duration = 0;
  segmentList.forEach((segment) => {
    const normalized = normalizeDurationValue(segment?.segment_end || 0);
    if (normalized <= 0) return;
    if (normalized > duration) duration = normalized;
  });

  return duration > 0 ? duration : 0;
}

async function resolveUrlDuration(url) {
  if (String(url || '').startsWith('hongguo:') || isHongguoPlayerUrl(url)) {
    const segmentResult = await sourceLogContext.run('hongguo', () => hongguoSource.getComments(url, 'hongguo', true));
    return extractDurationFromSegments(segmentResult);
  }
  if (!/^https?:\/\//i.test(url)) return 0;

  try {
    let targetUrl = url;
    let segmentResult = null;

    if (targetUrl.includes('.qq.com')) {
      segmentResult = await sourceLogContext.run('tencent', () => tencentSource.getComments(targetUrl, 'qq', true));
    } else if (targetUrl.includes('.iqiyi.com')) {
      segmentResult = await sourceLogContext.run('iqiyi', () => iqiyiSource.getComments(targetUrl, 'qiyi', true));
    } else if (targetUrl.includes('.mgtv.com')) {
      segmentResult = await sourceLogContext.run('mango', () => mangoSource.getComments(targetUrl, 'imgo', true));
    } else if (targetUrl.includes('.bilibili.com') || targetUrl.includes('b23.tv')) {
      if (targetUrl.includes('b23.tv')) {
        targetUrl = await sourceLogContext.run('bilibili', () => bilibiliSource.resolveB23Link(targetUrl));
      }
      segmentResult = await sourceLogContext.run('bilibili', () => bilibiliSource.getComments(targetUrl, 'bilibili1', true));
    } else if (targetUrl.includes('.youku.com')) {
      segmentResult = await sourceLogContext.run('youku', () => youkuSource.getComments(targetUrl, 'youku', true));
    } else if (targetUrl.includes('.miguvideo.com')) {
      segmentResult = await sourceLogContext.run('migu', () => miguSource.getComments(targetUrl, 'migu', true));
    } else if (targetUrl.includes('.sohu.com')) {
      segmentResult = await sourceLogContext.run('sohu', () => sohuSource.getComments(targetUrl, 'sohu', true));
    } else if (targetUrl.includes('.le.com')) {
      segmentResult = await sourceLogContext.run('leshi', () => leshiSource.getComments(targetUrl, 'leshi', true));
    } else if (targetUrl.includes('.douyin.com') || targetUrl.includes('.ixigua.com')) {
      segmentResult = await sourceLogContext.run('xigua', () => xiguaSource.getComments(targetUrl, 'xigua', true));
    } else if (targetUrl.includes('.mddcloud.com.cn')) {
      segmentResult = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getComments(targetUrl, 'maiduidui', true));
    } else if (targetUrl.includes('.yfsp.tv')) {
      segmentResult = await sourceLogContext.run('aiyifan', () => aiyifanSource.getComments(targetUrl, 'aiyifan', true));
    }

    return extractDurationFromSegments(segmentResult);
  } catch (error) {
    log('warn', `[system] [duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

function extractMergedUrls(url) {
  return String(url || '')
    .split(MERGE_DELIMITER)
    .map((part) => {
      const firstColonIndex = part.indexOf(':');
      if (firstColonIndex === -1) return part.trim();
      return part.slice(firstColonIndex + 1).trim();
    })
    .filter(Boolean);
}

async function resolveMergedDuration(url) {
  if (!url) return 0;

  try {
    // 单链接：时长按链接偏移换算到偏移后的时间轴末端
    if (!url.includes(MERGE_DELIMITER)) {
      const meta = stripLinkOffset(url);
      const sourceDuration = await resolveUrlDuration(meta.cleanUrl);
      return offsetDuration(sourceDuration, meta.offset, meta.percent);
    }

    // 合并链接的时长取各子链接偏移后时间轴末端的最大值，而非各子链接时长的简单取大
    const linkMetas = extractMergedUrls(url).map(stripLinkOffset);
    const durations = await Promise.all(linkMetas.map((meta) => resolveUrlDuration(meta.cleanUrl)));
    // 复用 offsetDuration 的端点语义计算各子链接末端，确保返回的合并时长与弹幕实际落点完全一致
    return linkMetas.reduce((maxEnd, meta, index) => {
      const end = offsetDuration(durations[index], meta.offset, meta.percent);
      return end > maxEnd ? end : maxEnd;
    }, 0);
  } catch (error) {
    log('warn', `[system] [duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

/**
 * 解析条目对应的偏移规则
 * @param {string} animeTitle 条目标题
 * @param {string} episodeTitle 集标题
 * @param {number} commentId 弹幕 ID
 * @param {string} source 来源
 * @returns {{ctx: Object|null, rule: Object|null, offset: number}} 匹配上下文、命中规则与偏移量
 */
function resolveCommentOffsetRule(animeTitle, episodeTitle, commentId, source) {
  if (!animeTitle || !episodeTitle || !(globals.danmuOffsetRules?.length > 0)) {
    return { ctx: null, rule: null, offset: 0 };
  }
  const { baseTitle, fullTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
  const ctx = {
    anime: baseTitle,
    fullTitle,
    season: `S${String(season || 1).padStart(2, '0')}`,
    episode: `E${String(episode || findIndexById(commentId) + 1).padStart(2, '0')}`,
    source
  };
  const rule = resolveOffsetRule(globals.danmuOffsetRules, ctx);
  return { ctx, rule, offset: rule?.offset || 0 };
}

// 匹配年份函数，优先于季匹配
function matchYear(anime, queryYear) {
  if (!queryYear) {
    return true; // 如果没有查询年份，则视为匹配
  }
  
  const animeYear = extractYear(anime.animeTitle);
  if (!animeYear) {
    return true; // 如果动漫没有年份信息，则视为匹配（允许匹配）
  }
  
  return animeYear === queryYear;
}

// 在带有 SxxExx 的匹配请求中，电影通常也只有一个“第 1 集”链接，
// 会错误地抢在同名电视剧之前命中。优先使用详情中的有效集数，声明集数作为补充。
function isMovieMatchCandidate(anime) {
  const type = `${anime?.type || ''} ${anime?.typeDescription || ''}`;
  return /(电影|剧场版|movie|film)/i.test(type);
}

// 计算对外上报的集数：过滤只会减少可用集数，平台声明值更小时以声明值为准
export function resolveEpisodeCount(declaredCount, availableCount) {
  const declared = Number(declaredCount) || 0;
  const available = Number(availableCount) || 0;
  if (available <= 0) return declared;
  return declared > 0 ? Math.min(declared, available) : available;
}

// 按集标题过滤剧集
export function filterEpisodesByTitle(episodes) {
  return episodes.filter(episode => !globals.episodeTitleFilter.test(episode.episodeTitle));
}

// 按集标题过滤剧集，并把过滤后的可用集数写回该动漫
export function applyEpisodeTitleFilter(anime, links) {
  const episodesList = filterEpisodesByTitle(links.map((link, index) => ({
    episodeId: link.id,
    episodeTitle: link.title,
    episodeNumber: index + 1
  })));
  anime.episodeCount = resolveEpisodeCount(anime.episodeCount, episodesList.length);
  return episodesList;
}

// 缓存命中的动漫按过滤后的可用集数上报集数，不改写缓存里的对象
export function withAvailableEpisodeCount(animes, resolveAnimeDetail) {
  if (!globals.enableAnimeEpisodeFilter) return animes;
  return animes.map(anime => {
    const animeData = resolveAnimeDetail(anime);
    if (!animeData || !animeData.links) return anime;
    const counted = { ...anime };
    applyEpisodeTitleFilter(counted, animeData.links);
    return counted;
  });
}

function getMatchEpisodeCount(anime, bangumiData) {
  // 部分源（如 360）会把同一部电影的多个平台链接都放进 links，
  // 不能把平台链接数当成电影集数。
  if (isMovieMatchCandidate(anime)) return 1;
  const episodes = bangumiData?.bangumi?.episodes;
  const filtered = Array.isArray(episodes)
    ? filterSameEpisodeTitle(filterEpisodesByTitle(episodes))
    : [];
  const declaredCount = Number(anime?.episodeCount) || 0;
  return Math.max(filtered.length, declaredCount);
}

function isSingleEpisodeMatchCandidate(anime, bangumiData) {
  // 只上传一集的本地电视剧仍按剧集参与源优先级匹配。
  if (anime?.source === 'local' && !isMovieMatchCandidate(anime)) return false;
  return getMatchEpisodeCount(anime, bangumiData) <= 1;
}

export function matchSeason(anime, queryTitle, season) {
  // 先从原始带括号的标题中分离出名称主体再对主体进行净化剥离非法字符
  const match = anime.animeTitle.match(/^(.*?)\(\d{4}\)/);
  const originalTitle = match ? match[1].trim() : anime.animeTitle.split("(")[0].trim();
  const normalizedAnimeTitle = normalizeTitleForMatch(originalTitle);
  // 本地上传的年份单独匹配，文件名中的年份不属于剧名或季号。
  const seasonQueryTitle = anime.source === 'local'
    ? queryTitle.replace(/[（(]\s*(?:19|20)\d{2}\s*[）)]/g, '').trim()
    : queryTitle;
  const normalizedQueryTitle = normalizeTitleForMatch(seasonQueryTitle);

  if (normalizedAnimeTitle.includes(normalizedQueryTitle)) {
    if (normalizedAnimeTitle.startsWith(normalizedQueryTitle)) {
      const afterTitle = normalizedAnimeTitle.substring(normalizedQueryTitle.length).trim();
      if (afterTitle === '' && season === 1) {
        return true;
      }
      // match number from afterTitle
      const seasonIndex = afterTitle.match(/\d+/);
      if (seasonIndex && seasonIndex[0] === season.toString()) {
        return true;
      }
      // match chinese number
      const chineseNumber = afterTitle.match(/[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+/);
      if (chineseNumber && convertChineseNumber(chineseNumber[0]) === season) {
        return true;
      }
    }
    return false;
  } else {
    return false;
  }
}

/**
 * 验证指定结果集中是否满足目标集数的需求
 * 依据目标平台偏好，推断核心数据源容量，决定是否需要触发跨季全量检索
 * @param {Array} animesList 动漫列表
 * @param {number|null} querySeason 目标季数
 * @param {number|null} queryEpisode 目标集数
 * @param {Map} requestAnimeDetailsMap 详情缓存字典
 * @param {string|null} targetPlatform 期望优先验证的目标平台
 * @returns {boolean} 是否满足需求
 */
function checkEpisodeSatisfied(animesList, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform, unsatisfiedOut = null) {
  if (queryEpisode === null || querySeason === null) return true;

  let targetPlatforms = [];
  if (targetPlatform) {
    targetPlatforms = targetPlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  }

  if (targetPlatforms.length === 0) {
    targetPlatforms = ['_any_'];
  }

  let allSatisfied = true;
  let anyPlatformHadData = false;

  for (const tPlat of targetPlatforms) {
    let isEpisodeSatisfied = false;
    const seasonCapacities = new Map();
    let platformHasData = false;
    const providedSources = new Set();

    for (const anime of animesList) {
      // 候选平台由番剧身份标签(标题 from 段或 source)与所挂集标签共同决定，使身份名(如tencent)与优选平台名(如qq)不一致但集上挂有目标标签的源也能被正确识别为该平台有数据
      const identityPlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;
      const bData = getBangumiDataForMatch(anime, requestAnimeDetailsMap);
      const epPlatforms = new Set();
      if (bData?.success && bData.bangumi?.episodes) {
        for (const ep of bData.bangumi.episodes) {
          const epPlat = extractEpisodeTitle(ep.episodeTitle);
          if (epPlat) epPlatforms.add(epPlat);
        }
      }
      const actualPlatform = [...new Set([identityPlatform, ...epPlatforms].filter(Boolean)
          .flatMap(p => p.split(/[&＆]/).map(s => s.trim().toLowerCase())).filter(s => s))].join('&');

      if (tPlat !== '_any_' && getPlatformMatchScore(actualPlatform, tPlat) === 0) {
        continue;
      }

      platformHasData = true;
      providedSources.add(anime.source);

      if (bData?.success && bData.bangumi?.episodes) {
        const validEps = filterEpisodesByTitle(bData.bangumi.episodes);
        const filtered = filterSameEpisodeTitle(validEps, {
          preferredPlatform: tPlat === '_any_' ? null : tPlat
        });

        if (filtered.some(ep => extractEpisodeNumberFromTitle(ep.episodeTitle) === queryEpisode)) {
          isEpisodeSatisfied = true;
          break;
        }

        const candidateTitles = [anime.animeTitle];
        if (anime.aliases && Array.isArray(anime.aliases)) candidateTitles.push(...anime.aliases);

        let sNum = null;
        for (const candTitle of candidateTitles) {
          if (!candTitle) continue;
          const s = extractSeasonNumberFromAnimeTitle(candTitle).season;
          if (s !== null) { sNum = s; break; }
        }
        if (sNum === null) sNum = 1;

        const currentMax = seasonCapacities.get(sNum) || 0;
        if (filtered.length > currentMax) {
          seasonCapacities.set(sNum, filtered.length);
        }
      }
    }

    if (!platformHasData) {
      continue;
    }
    anyPlatformHadData = true;

    if (!isEpisodeSatisfied) {
      let totalValidEpisodes = 0;
      for (const [sNum, capacity] of seasonCapacities) {
        // 仅累加不超过查询季号的容量，防止跳跃季（如别名指示S3但S2缺失）导致虚高
        if (sNum <= querySeason) {
          totalValidEpisodes += capacity;
        }
      }
      if (totalValidEpisodes < queryEpisode) {
        allSatisfied = false;
        if (unsatisfiedOut) {
          for (const s of providedSources) unsatisfiedOut.add(s);
        }
      }
    }
  }

  // 优先平台无匹配数据时回退到不区分平台重新检查全部可用数据
  if (!anyPlatformHadData && targetPlatform) {
    return checkEpisodeSatisfied(animesList, querySeason, queryEpisode, requestAnimeDetailsMap, null);
  }

  return allSatisfied;
}

/**
 * 执行配置数据源的并发请求与解析逻辑
 * 负责将获取的源站数据映射、过滤，并存入目标季度的动漫结果集合中
 * 各源并发执行 handleAnimes，完成后按 SOURCE_ORDER 顺序合并结果，确保优先级
 * @param {Object} resultData 并发请求的原始返回数据集
 * @param {string} queryTitle 搜索关键词
 * @param {Array} targetAnimesList 目标存储列表
 * @param {Map} requestAnimeDetailsMap 详情缓存字典
 * @param {number|null} targetSeason 目标季数
 * @param {string|null} preferAnimeId 优选ID
 * @param {string|null} preferSource 优选源
 */
async function executeSourceHandlers(resultData, queryTitle, targetAnimesList, requestAnimeDetailsMap, targetSeason, preferAnimeId = null, preferSource = null) {
  // 仅处理resultData中存在数据的源，避免将undefined传入handleAnimes
  const activeSourceKeys = globals.sourceOrderArr.filter(key => resultData[key] !== undefined);
  const sourceTasks = [];

  for (const key of activeSourceKeys) {
    const isolatedAnimes = [];
    const isolatedDetailStore = new Map();
    const meta = getSourceMetaByKey(key);
    if (!meta) {
      log("warn", `[system] [searchAnime] 未注册的源键 "${key}"，已跳过 handleAnimes`);
      continue;
    }
    const searchResult = resultData[key];
    // 统一通过注册表适配器调用 handleAnimes，消除各源签名差异（vod 遍历、custom 少参等）
    const promise = sourceLogContext.run(meta.logName, () => meta.handleAdapter(meta.instance, searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason));
    sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise });
  }

  // 并发执行所有源的handleAnimes
  const results = await Promise.allSettled(sourceTasks.map(task => task.promise));

  // 按SOURCE_ORDER顺序合并各源的独立结果到目标容器
  // 先处理的源数据优先保留（animeId去重、detailStore键去重）
  const existingAnimeIds = new Set(targetAnimesList.map(a => a.animeId));

  for (let i = 0; i < sourceTasks.length; i++) {
    if (results[i].status === 'rejected') {
      log("error", `[system] [executeSourceHandlers] 源 ${sourceTasks[i].key} 处理失败: ${results[i].reason}`);
      continue;
    }

    const { animes: isolatedAnimes, detailStore: isolatedDetailStore } = sourceTasks[i];

    // 合并动漫结果列表（使用 Set 确保 O(1) 检索，优先源先入为主）
    for (const anime of isolatedAnimes) {
      if (!existingAnimeIds.has(anime.animeId)) {
        targetAnimesList.push(anime);
        existingAnimeIds.add(anime.animeId);
      }
    }

    // 合并详情缓存（键去重，先到先得）
    for (const [key, value] of isolatedDetailStore) {
      if (!requestAnimeDetailsMap.has(key)) {
        requestAnimeDetailsMap.set(key, value);
      }
    }
    // 逐源隔离的详情存储也会暂存 addAnime 失败原因，合并后由响应统一提示。
    mergeAddAnimeError(requestAnimeDetailsMap, isolatedDetailStore);
  }
}

// Extracted function for GET /api/v2/search/anime
export async function searchAnime(url, preferAnimeId = null, preferSource = null, detailStore = null, targetPlatform = null, forceRefresh = false) {
  // 单次搜索请求内启用 HTTP 响应复用缓存: 作为各源通用的请求级复用安全网, 借助 AsyncLocalStorage 做请求级隔离
  if (httpCacheContext.getStore()) {
    return searchAnimeBody(url, preferAnimeId, preferSource, detailStore, targetPlatform, forceRefresh);
  }
  return runWithHttpCache(() => searchAnimeBody(url, preferAnimeId, preferSource, detailStore, targetPlatform, forceRefresh));
}

// 从详情缓存里解析动漫的详情数据
function resolveAnimeDetailForSearch(anime, requestAnimeDetailsMap) {
  return resolveAnimeByIdFromDetailStore(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeByIdFromDetailStore(anime?.animeId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeById(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeById(anime?.animeId, requestAnimeDetailsMap, anime?.source);
}

async function searchAnimeBody(url, preferAnimeId = null, preferSource = null, detailStore = null, targetPlatform = null, forceRefresh = false) {
  let queryTitle = url.searchParams.get("keyword");

  // 搜索·缓存查询 阶段开始：本阶段内的配置读取与查询预处理统一归属到此，便于排错定位
  markStepActive('搜索·缓存查询');
  const cacheStartedAt = Date.now();

  // 搜索词杂音清理：移除画质/配音/版本等杂音词后再提交源站搜索
  if (globals.titleNoiseFilter) {
    const noisyTitle = queryTitle;
    queryTitle = queryTitle.replace(globals.titleNoiseFilter, '').trim();
    if (noisyTitle !== queryTitle) {
      recordConfigEffect('TITLE_NOISE_FILTER', { label: '剧名杂音清理', before: noisyTitle, after: queryTitle, hit: true });
    }
  }

  let querySeason = url.searchParams.get("season");
  querySeason = querySeason ? parseInt(querySeason, 10) : null;
  let queryEpisode = url.searchParams.get("episode");
  queryEpisode = queryEpisode ? parseInt(queryEpisode, 10) : null;
  let tmdbSeasonBoundaries = null;
  log("info", `[system] [searchAnime] Search anime with keyword: ${queryTitle}, target season: ${querySeason}, target episode: ${queryEpisode}`);

  // 关键字为空直接返回，不用多余查询
  if (queryTitle === "") {
    traceStep('搜索·缓存查询', cacheStartedAt, { status: 'skip', reason: '关键字为空，直接返回空结果', inputs: { q: queryTitle }, outputs: { hit: false, finalCount: 0, count: 0 } });
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: [],
    });
  }

  // 如果启用了搜索关键字繁转简，则进行转换
  if (globals.animeTitleSimplified) {
    const simplifiedTitle = simplized(queryTitle);
    log("info", `[system] [searchAnime] searchAnime converted traditional to simplified: ${queryTitle} -> ${simplifiedTitle}`);
    if (queryTitle !== simplifiedTitle) {
      recordConfigEffect('ANIME_TITLE_SIMPLIFIED', { label: '剧名繁转简', before: queryTitle, after: simplifiedTitle, hit: true });
    }
    queryTitle = simplifiedTitle;
  }

  const requestAnimeDetailsMap = detailStore instanceof Map ? detailStore : new Map();
  const cacheKey = querySeason !== null ? `${queryTitle}_S${querySeason}` : queryTitle;
  recordConfigEffect('SEARCH_CACHE_MINUTES', {
    label: '搜索缓存键与有效期', kind: 'stats',
    context: {
      搜索词: queryTitle,
      季: querySeason === null ? '未指定' : `第 ${querySeason} 季`,
      缓存键: cacheKey,
      有效期: `${globals.searchCacheMinutes} 分钟`,
    },
  });
  const resolveSearchAnimeDetail = anime => resolveAnimeDetailForSearch(anime, requestAnimeDetailsMap);

  // 收藏缓存命中后必须直接返回，不能因目标集数判断继续请求外部源。
  if (!forceRefresh && resolveFavoriteForSearchKeyword(cacheKey)) {
    const favoriteResults = withAvailableEpisodeCount(getSearchCache(cacheKey, requestAnimeDetailsMap) || [], resolveSearchAnimeDetail);
    traceStep('搜索·缓存查询', cacheStartedAt, {
      status: 'hit', reason: '收藏缓存命中',
      inputs: { q: queryTitle, animeId: preferAnimeId ?? undefined, cacheKey },
      outputs: { hit: true, cachedCount: favoriteResults.length, count: favoriteResults.length },
    });
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: favoriteResults,
    });
  }

  // 检查普通搜索缓存；刷新收藏时显式跳过所有缓存。
  let cachedResults = forceRefresh ? null : getSearchCache(cacheKey, requestAnimeDetailsMap);

  // 如果带季度的特定缓存未命中，尝试获取不带季度的通用搜索缓存
  if (cachedResults === null && querySeason !== null) {
    const genericCachedResults = getSearchCache(queryTitle, requestAnimeDetailsMap);
    if (genericCachedResults !== null) {
      log("info", `[system] [searchAnime] Cache miss for ${cacheKey}, fallback to generic cache for ${queryTitle}`);
      cachedResults = genericCachedResults;
    }
  }

  if (cachedResults !== null) {
    let satisfied = checkEpisodeSatisfied(cachedResults, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform);
    if (satisfied) {
      const cachedAvailable = withAvailableEpisodeCount(cachedResults, resolveSearchAnimeDetail);
      traceStep('搜索·缓存查询', cacheStartedAt, {
        status: 'hit', reason: '普通搜索缓存命中',
        inputs: { q: queryTitle, animeId: preferAnimeId ?? undefined, cacheKey },
        outputs: { hit: true, cachedCount: cachedAvailable.length, count: cachedAvailable.length },
      });
      return jsonResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        animes: cachedAvailable,
      });
    } else {
      // 当前季度缓存未能满足目标集数，尝试顺延加载后续季度的缓存拼接
      let currentS = querySeason + 1;
      let combinedCachedResults = [...cachedResults];
      let cacheMissed = false;
      
      while (!satisfied && !cacheMissed) {
        const nextCacheKey = `${queryTitle}_S${currentS}`;
        const nextCache = getSearchCache(nextCacheKey, requestAnimeDetailsMap);
        if (nextCache !== null && nextCache.length > 0) {
          combinedCachedResults.push(...nextCache);
          satisfied = checkEpisodeSatisfied(combinedCachedResults, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform);
          currentS++;
        } else {
          cacheMissed = true; 
        }
      }
      
      if (satisfied) {
        log("info", `[system] [LogVar-API] Episode ${queryEpisode} satisfied by combining cached seasons S${querySeason} to S${currentS - 1}`);
        traceStep('搜索·缓存查询', cacheStartedAt, {
          status: 'hit', reason: '跨季缓存拼接命中',
          inputs: { q: queryTitle, animeId: preferAnimeId ?? undefined, cacheKey },
          outputs: { hit: true, cachedCount: combinedCachedResults.length, count: combinedCachedResults.length },
        });
        return jsonResponse({
          errorCode: 0,
          success: true,
          errorMessage: "",
          animes: withAvailableEpisodeCount(combinedCachedResults, resolveSearchAnimeDetail),
        });
      }
      log("info", `[system] [LogVar-API] Episode ${queryEpisode} not satisfied in cache. Proceeding to network search.`);
    }
  }

  traceStep('搜索·缓存查询', cacheStartedAt, { status: 'miss', reason: '缓存未命中，进入逐源检索', inputs: { q: queryTitle, animeId: preferAnimeId ?? undefined }, outputs: { hit: false, count: 0 } });

  const curAnimes = [];

  // 多链接合并解析：空格分隔的多个 URL → 聚合弹幕
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
  const spaceSeparatedUrls = queryTitle.split(/\s+/).filter(u => {
    const cleanUrl = stripLinkOffset(u).cleanUrl;
    return urlRegex.test(cleanUrl);
  });
  if (spaceSeparatedUrls.length >= 2) {
    const mergeParts = spaceSeparatedUrls.map((singleUrl) => {
      const { source, realId } = resolveSourceAndRealId(singleUrl);
      return source ? `${source}:${realId}` : '';
    }).filter(Boolean);

    if (mergeParts.length >= 2) {
      const mergeUrl = mergeParts.join(MERGE_DELIMITER);

      // 逐链接获取网页标题，不可直连的平台跳过
      const titles = [];
      for (const singleUrl of spaceSeparatedUrls) {
        const { source } = resolveSourceAndRealId(singleUrl);
        if (source === 'animeko') {
          const bgmId = singleUrl.match(/(?:bgm\.tv|bangumi\.tv|bangumi\.lol|chii\.in)\/ep\/(\d+)/);
          titles.push(`【animeko】 BGMEp${bgmId ? bgmId[1] : '?'}`);
        } else if (source === 'bahamut') {
          titles.push(`【bahamut】 BahaSn${singleUrl.match(/sn=(\d+)/)?.[1] || '?'}`);
        } else {
          const pt = await sourceLogContext.run(getLogNameByKey(source), () => getPageTitle(stripLinkOffset(singleUrl).cleanUrl));
          titles.push(`【${source}】 ${pt}`);
        }
      }
      const mergedTitle = titles.join('＆');

      const tmpAnime = Anime.fromJson({
        "animeId": 0,
        "bangumiId": "0",
        "animeTitle": queryTitle,
        "type": "",
        "typeDescription": "链接合并",
        "imageUrl": "",
        "startDate": "",
        "episodeCount": 1,
        "rating": 0,
        "isFavorited": true
      });

      const links = [{
        "name": "手动合并弹幕",
        "url": mergeUrl,
        "title": mergedTitle
      }];
      curAnimes.push(tmpAnime);
      addAnime(Anime.fromJson({...tmpAnime, links: links}), requestAnimeDetailsMap);
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
      if (globals.localCacheValid && curAnimes.length !== 0) await updateLocalCaches();
      if (globals.redisValid && curAnimes.length !== 0) await updateRedisCaches();
      if (globals.localRedisValid && curAnimes.length !== 0) await updateLocalRedisCaches();
      const responseAnimes = curAnimes.map(({ links, ...pureAnime }) => pureAnime);
      // 链接解析类响应恒有一条合成条目，缓存写入告警放进来会变成"成功却带错误"，此处不承载。
      return jsonResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        animes: responseAnimes
      });
    }
  }

  // 单链接弹幕解析
  if (urlRegex.test(queryTitle)) {
    const tmpAnime = Anime.fromJson({
      "animeId": 0,
      "bangumiId": "0",
      "animeTitle": queryTitle,
      "type": "",
      "typeDescription": "链接解析",
      "imageUrl": "",
      "startDate": "",
      "episodeCount": 1,
      "rating": 0,
      "isFavorited": true
    });

    let platform = "unknown";
    if (queryTitle.includes(".qq.com")) {
      platform = "qq";
    } else if (queryTitle.includes(".iqiyi.com")) {
      platform = "qiyi";
    } else if (queryTitle.includes(".mgtv.com")) {
      platform = "imgo";
    } else if (queryTitle.includes(".youku.com")) {
      platform = "youku";
    } else if (queryTitle.includes(".bilibili.com") || queryTitle.includes('b23.tv')) {
      platform = "bilibili1";
    } else if (queryTitle.includes('.miguvideo.com')) {
      platform = "migu";
    } else if (queryTitle.includes('.sohu.com')) {
      platform = "sohu";
    } else if (queryTitle.includes('.le.com')) {
      platform = "leshi";
    } else if (queryTitle.includes('.douyin.com') || queryTitle.includes('.ixigua.com')) {
      platform = "xigua";
    } else if (queryTitle.includes('.mddcloud.com.cn')) {
      platform = "maiduidui";
    } else if (queryTitle.includes('.yfsp.tv')) {
      platform = "aiyifan";
    } else if (isHongguoPlayerUrl(queryTitle)) {
      platform = "hongguo";
    } else if (/(?:bgm|bangumi)\.(?:tv|lol)\/ep\/|chii\.in\/ep\//.test(queryTitle)) {
      platform = "animeko";
    } else if (queryTitle.includes('ani.gamer.com.tw')) {
      platform = "bahamut";
    }

    // 提取 animeko/bahamut 的视频标识符（无法直连获取网页标题）
    let extractedId = queryTitle;
    let pageTitle = queryTitle;
    if (platform === 'animeko') {
      const m = queryTitle.match(/(?:bgm\.tv|bangumi\.tv|bangumi\.lol|chii\.in)\/ep\/(\d+)/);
      extractedId = m ? m[1] : queryTitle;
      pageTitle = `BGMEp${extractedId}`;
    } else if (platform === 'bahamut') {
      const m = queryTitle.match(/sn=(\d+)/);
      extractedId = m ? m[1] : queryTitle;
      pageTitle = `BahaSn${extractedId}`;
    } else if (platform === 'hongguo') {
      pageTitle = '红果短剧';
    } else {
      // 将源标识符统一映射到日志标签规范名称；取标题前剥离 @偏移 后缀，避免带偏移的链接请求失败
      pageTitle = await sourceLogContext.run(getLogNameByKey(platform), () => getPageTitle(stripLinkOffset(queryTitle).cleanUrl));
    }

    const links = [{
      "name": "手动解析链接弹幕",
      "url": extractedId,
      "title": `【${platform}】 ${pageTitle}`
    }];
    curAnimes.push(tmpAnime);
    addAnime(Anime.fromJson({...tmpAnime, links: links}), requestAnimeDetailsMap);
    if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();

    // 如果有新的anime获取到，则更新本地缓存
    if (globals.localCacheValid && curAnimes.length !== 0) {
      await updateLocalCaches();
    }
    // 如果有新的anime获取到，则更新redis
    if (globals.redisValid && curAnimes.length !== 0) {
      await updateRedisCaches();
    }
    if (globals.localRedisValid && curAnimes.length !== 0) {
      await updateLocalRedisCaches();
    }

    // 构造响应 DTO：剥离合并产生的 links，确保接口纯净
    const responseAnimes = curAnimes.map(({ links, ...pureAnime }) => pureAnime);

    // 合并弹幕分支同样恒有一条合成条目，缓存写入告警不放进 errorMessage。
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: responseAnimes,
    });
  }

  const sourceSearchStartedAt = Date.now();
  try {
    // 根据 sourceOrderArr 动态构建逐源管道：每个源形成独立的 search → handleAnimes 流水线
    log("info", `[system] [LogVar-API] Search sourceOrderArr: ${globals.sourceOrderArr}`);

    // 搜索·逐源检索 阶段开始
    markStepActive('搜索·逐源检索');

    // 存储各源搜索结果的容器，供S2+季度扩展逻辑读取
    const resultData = {};

    // 源Key到对应搜索Promise的映射：统一从注册表查实例与日志标签，新增源无需改此处分发
    const sourceSearchMap = {};
    for (const source of globals.sourceOrderArr) {
      const meta = getSourceMetaByKey(source);
      if (!meta) {
        log("warn", `[system] [LogVar-API] 未注册的源键 "${source}"，已跳过`);
        continue;
      }
      const args = meta.extraSearchArgs ? [queryTitle, preferAnimeId, preferSource] : [queryTitle];
      sourceSearchMap[source] = sourceLogContext.run(meta.logName, () => meta.instance.search(...args));
    }

    // 构建逐源管道：每个源 search 完成后，通过 executeSourceHandlers 处理 handleAnimes
    // 传入仅含当前源数据的 resultData，使 executeSourceHandlers 仅处理该源
    const pipelineTasks = globals.sourceOrderArr.map(source => {
      const isolatedAnimes = [];
      const isolatedDetailStore = new Map();
      const task = { key: source, animes: isolatedAnimes, detailStore: isolatedDetailStore, startedAt: Date.now(), elapsedMs: 0, promise: null };
      const pipelinePromise = sourceSearchMap[source].then(async searchResult => {
        resultData[source] = searchResult;
        await executeSourceHandlers({ [source]: searchResult }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource);
      }).finally(() => {
        task.elapsedMs = Math.max(0, Math.round(Date.now() - task.startedAt));
      });
      task.promise = pipelinePromise;
      return task;
    });

    // 并发执行所有逐源管道，每个管道内部 search 完成后立即衔接 handleAnimes
    const pipelineResults = await Promise.allSettled(pipelineTasks.map(task => task.promise));

    // 按SOURCE_ORDER顺序合并各管道的独立结果到目标容器
    // 先处理的源数据优先保留（animeId去重、detailStore键去重）
    const existingAnimeIds = new Set(curAnimes.map(a => a.animeId));

    for (let i = 0; i < pipelineTasks.length; i++) {
      if (pipelineResults[i].status === 'rejected') {
        log("error", `[system] [searchAnime] 源 ${pipelineTasks[i].key} 管道处理失败: ${pipelineResults[i].reason}`);
        continue;
      }

      const { animes: isolatedAnimes, detailStore: isolatedDetailStore } = pipelineTasks[i];

      // 合并动漫结果列表（使用 Set 确保 O(1) 检索，优先源先入为主）
      for (const anime of isolatedAnimes) {
        if (!existingAnimeIds.has(anime.animeId)) {
          curAnimes.push(anime);
          existingAnimeIds.add(anime.animeId);
        }
      }

      // 合并详情缓存（键去重，先到先得）
      for (const [key, value] of isolatedDetailStore) {
        if (!requestAnimeDetailsMap.has(key)) {
          requestAnimeDetailsMap.set(key, value);
        }
      }
      // 逐源隔离的详情存储也会暂存 addAnime 失败原因，合并后由响应统一提示。
      mergeAddAnimeError(requestAnimeDetailsMap, isolatedDetailStore);
    }

    const perSourceRows = [];
    pipelineTasks.forEach((task, i) => {
      const result = pipelineResults[i];
      const status = result ? (result.status === 'fulfilled' ? 'ok' : 'rejected') : 'skipped';
      const rawCount = countRawCandidates(resultData[task.key]);
      const error = status === 'rejected' ? String(result.reason?.message || result.reason) : undefined;
      const kept = task.animes.length;
      const removedBy = Math.max(0, rawCount - kept);
      let note = '';
      if (error) note = error;
      else if (status === 'skipped') note = '未执行检索';
      else if (rawCount === 0) note = '未返回候选';
      else if (removedBy === 0) note = '候选全部保留';
      else note = `剔除 ${removedBy} 条`;
      // 豆瓣为聚合源：一个条目可联动多个平台产出，仅当产出数超过原始条目数时才需说明倒挂
      if (task.key === 'douban' && kept > rawCount) note += '（聚合产出）';
      perSourceRows.push({
        源: getSourceLabel(task.key),
        状态: status === 'rejected' ? '失败' : status === 'skipped' ? '未执行' : '成功',
        原始候选: rawCount,
        保留: kept,
        剔除: removedBy,
        '耗时(ms)': task.elapsedMs,
        说明: note,
      });
    });
    const rawTotal = perSourceRows.reduce((sum, row) => sum + row.原始候选, 0);
    const keptTotal = perSourceRows.reduce((sum, row) => sum + row.保留, 0);
    const droppedSources = perSourceRows.filter(row => row.状态 === '失败' || row.说明 === '未返回候选');
    recordConfigEffect('SOURCE_ORDER', {
      label: '逐源检索结果',
      kind: 'stats',
      context: {
        检索顺序: globals.sourceOrderArr.map(key => getSourceLabel(key)).join(' → '),
        源数量: globals.sourceOrderArr.length,
      },
      // 聚合源一个条目可联动多个平台产出，保留数可能多于原始候选数，需在摘要中说明避免读者误解
      summary: `${globals.sourceOrderArr.length} 个源共返回 ${rawTotal} 条候选，逐源保留 ${keptTotal} 条`
        + (keptTotal > rawTotal ? '（含聚合源联动产出）' : '')
        + (keptTotal !== curAnimes.length ? `，跨源去重后 ${curAnimes.length} 条` : '')
        + (droppedSources.length > 0 ? `，${droppedSources.length} 个源无结果` : ''),
      table: {
        columns: ['源', '状态', '原始候选', '保留', '剔除', '耗时(ms)', '说明'],
        rows: perSourceRows,
      },
    });
    traceStep('搜索·逐源检索', sourceSearchStartedAt, {
      status: curAnimes.length === 0 ? 'empty' : 'ok',
      reason: curAnimes.length === 0 ? '所有源均未返回可用候选' : undefined,
      inputs: { sources: globals.sourceOrderArr },
      outputs: { count: curAnimes.length },
    });

    // 缓存首季/默认请求结果，剥离附加链接
    if (curAnimes.length > 0) {
      setSearchCache(cacheKey, curAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
    }

    // 搜索·结果合并与跨季扩展 阶段开始
    markStepActive('搜索·结果合并与跨季扩展');
    const mergeStartedAt = Date.now();
    const beforeExpansion = curAnimes.length;

    // 判断当前获取的季度是否已包含用户指定的集数
    const unsatisfiedPlatforms = new Set();
    const isEpisodeSatisfied = checkEpisodeSatisfied(curAnimes, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform, unsatisfiedPlatforms);

    // 若未包含且用户指定了季度，推导最大季并扩展至后续季以辅助跨季匹配
    if (!isEpisodeSatisfied && querySeason !== null) {
      let maxSeason = querySeason;
      for (const source of globals.sourceOrderArr) {
        const rawAnimes = resultData[source];
        if (Array.isArray(rawAnimes)) {
          for (const item of rawAnimes) {
            const list = (item && Array.isArray(item.list)) ? item.list : [item];
            for (const a of list) {
              if (!a) continue;
              // 用titleMatches过滤与查询无关的条目，仅从相关结果中提取季号
              const testTitle = a.animeTitle || a.title || a.name || a.name_cn || "";
              if (testTitle && !titleMatches(testTitle, queryTitle, null, true, 0.6)) continue;
              const s = extractSeasonNumberFromAnimeTitle(testTitle).season;
              if (s !== null && s > maxSeason) maxSeason = s;
            }
          }
        }
      }

      if (maxSeason > querySeason) {
        log("info", `[system] [LogVar-API] Episode ${queryEpisode} not satisfied in Season ${querySeason}. Parallel mapping to S${querySeason + 1}~S${maxSeason}...`);
        // 依据 bangumi-data 的 TMDB 季边界定位目标集所在季, 跨季扩展直接收敛至目标季并跳过无关中间季, 集数扣减交由 findCrossSeasonEpisodeMap 借 TMDB 边界完成
        let targetSeasons = [];
        if (globals.useBangumiData && queryEpisode) {
          tmdbSeasonBoundaries = await getTmdbSeasonBoundaries(queryTitle);
          if (tmdbSeasonBoundaries && tmdbSeasonBoundaries.length >= 2) {
            for (let i = tmdbSeasonBoundaries.length - 1; i >= 0; i--) {
              const b = tmdbSeasonBoundaries[i];
              if (queryEpisode >= b.startEpisode) {
                targetSeasons = [b.order];
                break;
              }
            }
          }
        }

        const expansionStart = targetSeasons.length > 0 ? Math.min(...targetSeasons) : querySeason + 1;
        const expansionEnd = targetSeasons.length > 0 ? Math.max(...targetSeasons) : maxSeason;
        recordConfigEffect('USE_BANGUMI_DATA', {
          label: 'Bangumi Data 季边界收敛',
          hit: targetSeasons.length > 0,
          before: { startSeason: querySeason + 1, endSeason: maxSeason },
          after: { startSeason: expansionStart, endSeason: expansionEnd, boundaryCount: tmdbSeasonBoundaries?.length || 0 },
        });

        const expandPromises = [];
        for (const source of globals.sourceOrderArr) {
          if (!resultData[source]) continue;
          // 在PLATFORM_ORDER模式下，跳过已满足平台的对应源；unsatisfied为空时不跳过
          if (targetPlatform && unsatisfiedPlatforms.size > 0 && !unsatisfiedPlatforms.has(source)) continue;
          // 源间并发、源内顺序，防止同源并发导致模块级缓存竞态
          expandPromises.push((async () => {
            const sourceResults = [];
            for (let s = expansionStart; s <= expansionEnd; s++) {
              const seasonAnimes = [];
              await executeSourceHandlers({ [source]: resultData[source] }, queryTitle, seasonAnimes, requestAnimeDetailsMap, s, preferAnimeId, preferSource);
              if (seasonAnimes.length > 0) {
                setSearchCache(`${queryTitle}_S${s}`, seasonAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
              }
              sourceResults.push(seasonAnimes);
            }
            return sourceResults;
          })());
        }
        const expandedResults = (await Promise.all(expandPromises)).flat();
        for (const res of expandedResults) {
          curAnimes.push(...res);
        }
      }
    }

    const afterExpansion = curAnimes.length;
    traceStep('搜索·结果合并与跨季扩展', mergeStartedAt, {
      status: afterExpansion === 0 ? 'empty' : 'ok',
      reason: afterExpansion === 0 ? '跨季扩展后仍无候选' : undefined,
      inputs: { rawCount: beforeExpansion },
      outputs: { mergedCount: afterExpansion, crossSeasonApplied: afterExpansion > beforeExpansion, count: afterExpansion },
    });
  } catch (error) {
    log("error", "[system] [LogVar-API] 发生错误:", error);
    traceStep('搜索·检索异常', sourceSearchStartedAt, {
      status: 'fail',
      reason: '逐源检索或跨季扩展抛出异常，本次结果可能不完整',
      error: error?.message || String(error),
    });
  }

  // 搜索·源合并与过滤 阶段开始
  markStepActive('搜索·源合并与过滤');
  const filterStartedAt = Date.now();
  const countBeforeFilter = curAnimes.length;

  // 执行源合并逻辑（支持常规配对组和自定义规则表触发）
  const hasMergePairs = globals.mergeSourcePairs && globals.mergeSourcePairs.length > 0;
  const hasCustomRules = globals.customMergeRules && globals.customMergeRules.length > 0;
  if (hasMergePairs || hasCustomRules) {
    await applyMergeLogic(curAnimes, requestAnimeDetailsMap);
  }

  storeAnimeIdsToMap(curAnimes, queryTitle);

  // 如果启用了集标题过滤，则为每个动漫添加过滤后的 episodes
  if (globals.enableAnimeEpisodeFilter) {
    const validAnimes = [];
    const removedAnimeTitles = [];
    const removedEpisodeTitles = [];
    let episodeCountBefore = 0;
    let episodeCountAfter = 0;
    for (const anime of curAnimes) {
      // 首先检查剧名是否包含过滤关键词
      const animeTitle = anime.animeTitle || '';
      if (globals.animeTitleFilter && globals.animeTitleFilter.test(animeTitle)) {
        log("info", `[system] [searchAnime] Anime ${anime.animeId} filtered by name: ${animeTitle}`);
        removedAnimeTitles.push(animeTitle);
        continue; // 跳过该动漫
      }

      const animeData = resolveAnimeDetailForSearch(anime, requestAnimeDetailsMap);
      if (animeData && animeData.links) {
        const beforeEpisodeTitles = animeData.links.map(link => link.title || '');
        const episodesList = applyEpisodeTitleFilter(anime, animeData.links);
        const keptTitles = new Set(episodesList.map(episode => episode.episodeTitle));
        for (const title of beforeEpisodeTitles) {
          if (!keptTitles.has(title)) removedEpisodeTitles.push(title);
        }
        episodeCountBefore += animeData.links.length;
        episodeCountAfter += episodesList.length;

        log("info", `[system] [searchAnime] Anime ${anime.animeId} filtered episodes: ${episodesList.length}/${animeData.links.length}`);

        // 只有当过滤后还有有效剧集时才保留该动漫
        if (episodesList.length > 0) {
          validAnimes.push(anime);
        }
      }
    }
    // 用过滤后的动漫列表替换原列表
    curAnimes.length = 0;
    curAnimes.push(...validAnimes);
    recordConfigEffect('ANIME_TITLE_FILTER', {
      label: '剧名过滤',
      hit: removedAnimeTitles.length > 0,
      before: { animeCount: countBeforeFilter },
      after: { animeCount: validAnimes.length },
      removed: removedAnimeTitles.map(title => ({ value: title })),
      removedCount: removedAnimeTitles.length,
    });
    recordConfigEffect('EPISODE_TITLE_FILTER', {
      label: '集标题过滤',
      hit: removedEpisodeTitles.length > 0,
      before: { episodeCount: episodeCountBefore },
      after: { episodeCount: episodeCountAfter },
      removed: removedEpisodeTitles.map(title => ({ value: title })),
      removedCount: removedEpisodeTitles.length,
    });
  }

  const filtersApplied = [];
  if (hasMergePairs || hasCustomRules) filtersApplied.push('mergeSourcePairs/customMergeRules');
  if (globals.enableAnimeEpisodeFilter) filtersApplied.push('animeTitleFilter/episodeTitleFilter');
  traceStep('搜索·源合并与过滤', filterStartedAt, {
    status: curAnimes.length === 0 ? 'empty' : 'ok',
    reason: curAnimes.length === 0 && countBeforeFilter > 0 ? '剧名或集标题过滤后候选归零' : undefined,
    inputs: { filtersApplied, beforeCount: countBeforeFilter },
    outputs: { filteredCount: curAnimes.length, removedBy: countBeforeFilter - curAnimes.length, count: curAnimes.length },
  });

    // 搜索·持久化与响应 阶段开始
    markStepActive('搜索·持久化与响应');
    const persistStartedAt = Date.now();

    // 如果有新的anime获取到，则更新本地缓存
    if (globals.localCacheValid && curAnimes.length !== 0) {
      await updateLocalCaches();
    }
    // 如果有新的anime获取到，则更新redis
    if (globals.redisValid && curAnimes.length !== 0) {
      await updateRedisCaches();
    }
    if (globals.localRedisValid && curAnimes.length !== 0) {
      await updateLocalRedisCaches();
    }

    // 构造响应 DTO：剥离合并产生的 links，确保接口纯净
    const responseAnimes = curAnimes.map(({ links, ...pureAnime }) => pureAnime);

    // 缓存搜索结果
    if (responseAnimes.length > 0) {
      const cacheKey = querySeason !== null ? `${queryTitle}_S${querySeason}` : queryTitle;
      setSearchCache(cacheKey, responseAnimes, requestAnimeDetailsMap);
    }

    traceStep('搜索·持久化与响应', persistStartedAt, {
      status: responseAnimes.length === 0 ? 'empty' : 'ok',
      reason: responseAnimes.length === 0 ? '本次搜索未返回任何结果' : undefined,
      outputs: {
        finalCount: responseAnimes.length,
        // 结果为空时不写搜索缓存，下次请求会重新检索；有结果时命中缓存可省去逐源请求
        searchCacheWritten: responseAnimes.length > 0,
        count: responseAnimes.length,
      },
    });

    // errorMessage 只在"没有结果"时承载 addAnime 写入失败原因；结果可用时它不是错误而是提示，
    // 放进 errorMessage 会让按"非空即报错"判断的客户端误报。
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: responseAnimes.length === 0 ? getAddAnimeError(requestAnimeDetailsMap) : "",
      animes: responseAnimes,
      tmdbSeasonBoundaries,
    });

}

export function filterSameEpisodeTitle(filteredTmpEpisodes, options = {}) {
    const { preferredPlatform = null } = options;
    const filteredEpisodes = filteredTmpEpisodes.filter((episode, index, episodes) => {
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            return prevEpisode.episodeTitle === episode.episodeTitle;
        });
    });
    // 对聚合采集源（如360）中来自不同平台的同名集号做二次去重
    // 默认保留首次出现的条目；指定平台时保留该平台得分更高的代表条目。
    const selectedByNumber = new Map();
    for (const episode of filteredEpisodes) {
        const num = extractEpisodeNumberFromTitle(episode.episodeTitle);
        if (num === null) continue;

        const selected = selectedByNumber.get(num);
        if (!selected) {
            selectedByNumber.set(num, episode);
            continue;
        }

        if (preferredPlatform) {
            const selectedScore = getPlatformMatchScore(extractEpisodeTitle(selected.episodeTitle), preferredPlatform);
            const candidateScore = getPlatformMatchScore(extractEpisodeTitle(episode.episodeTitle), preferredPlatform);
            if (candidateScore > selectedScore) {
                selectedByNumber.set(num, episode);
            }
        }
    }

    return filteredEpisodes.filter(ep => {
        const num = extractEpisodeNumberFromTitle(ep.episodeTitle);
        if (num === null) return true;
        return selectedByNumber.get(num) === ep;
    });
}

/**
 * 计算平台匹配得分 (新增函数 - 用于支持合并源模糊匹配和杂质过滤)
 * @param {string} candidatePlatform 候选平台字符串 (e.g., "bilibili&dandan")
 * @param {string} targetPlatform 目标配置字符串 (e.g., "bilibili1&dandan")
 * @returns {number} 得分：越高越好，0表示不匹配
 */
function getPlatformMatchScore(candidatePlatform, targetPlatform) {
  if (!candidatePlatform || !targetPlatform) return 0;
  
  // 预处理：按半角/全角 & 分割，转小写去空格并去重，避免合并标题重复标签抬高杂质长度导致评分失真
  const cParts = [...new Set(candidatePlatform.split(/[&＆]/).map(s => s.trim().toLowerCase()).filter(s => s))];
  const tParts = [...new Set(targetPlatform.split(/[&＆]/).map(s => s.trim().toLowerCase()).filter(s => s))];
  
  let matchCount = 0;

  // 计算交集：统计有多少个目标平台在候选平台中存在
  // 使用 includes 进行模糊匹配，解决部分平台名称差异问题
  for (const tPart of tParts) {
    const isFound = cParts.some(cPart => 
        cPart === tPart || 
        (cPart.includes(tPart) && tPart.length > 2) || 
        (tPart.includes(cPart) && cPart.length > 2)
    );
    if (isFound) {
        matchCount++;
    }
  }
  
  if (matchCount === 0) return 0;

  // 评分公式：基于命中数计算权重，其次考虑候选长度（越短越好，即杂质越少分越高）
  // 示例: Target="bilibili"
  // Candidate="bilibili" -> Match=1, Len=1 -> 1000 - 1 = 999 (Best)
  // Candidate="animeko&bilibili" -> Match=1, Len=2 -> 1000 - 2 = 998 (Valid but lower score)
  return (matchCount * 1000) - cParts.length;
}

// 辅助函数：从标题中提取来源平台列表 (新增函数 - 适配合并源标题格式)
function extractPlatformFromTitle(title) {
    const match = title.match(/from\s+([a-zA-Z0-9&＆]+)/i);
    return match ? match[1] : null;
}

// 根据集数匹配episode（优先使用集标题中的集数，其次使用episodeNumber，最后使用数组索引）
function findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, platform = null) {
  if (!filteredEpisodes || filteredEpisodes.length === 0) {
    return null;
  }
  
  // 如果指定了平台，先过滤出该平台的集数 (修改点：使用 getPlatformMatchScore 支持模糊匹配)
  let platformEpisodes = filteredEpisodes;
  if (platform) {
    platformEpisodes = filteredEpisodes.filter(ep => {
        const epTitlePlatform = extractEpisodeTitle(ep.episodeTitle);
        // 使用评分机制判断是否匹配，只要有分就保留
        return getPlatformMatchScore(epTitlePlatform, platform) > 0;
    });
  }
  
  if (platformEpisodes.length === 0) {
    return null;
  }
  
  // 策略1：从集标题中提取集数进行匹配
  for (const ep of platformEpisodes) {
    const extractedNumber = extractEpisodeNumberFromTitle(ep.episodeTitle);
    if (episode === targetEpisode && extractedNumber === targetEpisode) {
      log("info", `[system] [match] Found episode by title number: ${ep.episodeTitle} (extracted: ${extractedNumber})`);
      return ep;
    }
  }

  // 没有 offset 映射且标题含明确集号时，精确匹配失败就应视为目标集缺失。
  // 数组位置和生成的 episodeNumber 只能用于无集号标题或 offset 映射场景。
  const hasExplicitEpisodeNumbers = platformEpisodes.some(ep => extractEpisodeNumberFromTitle(ep.episodeTitle) !== null);
  const canUsePositionalFallback = episode !== targetEpisode || !hasExplicitEpisodeNumbers;

  if (canUsePositionalFallback) {
    // 策略2：使用数组索引
    if (targetEpisode > 0 && platformEpisodes.length >= targetEpisode) {
      const fallbackEp = platformEpisodes[targetEpisode - 1];
      // 本地上传可能只有第 5、10 集，已标明集数的资源不能按列表位置补成第 1、2 集。
      const numberedLocalEpisode = fallbackEp?.url?.startsWith('local:') && extractEpisodeNumberFromTitle(fallbackEp.episodeTitle) !== null;
      if (fallbackEp && !numberedLocalEpisode) {
        log("info", `[system] [match] Using fallback array index for episode ${targetEpisode}: ${fallbackEp.episodeTitle}`);
        return fallbackEp;
      }
    }

    // 策略3：使用episodeNumber字段匹配
    for (const ep of platformEpisodes) {
      if (ep.episodeNumber && parseInt(ep.episodeNumber, 10) === targetEpisode) {
        log("info", `[system] [match] Found episode by episodeNumber: ${ep.episodeTitle} (episodeNumber: ${ep.episodeNumber})`);
        return ep;
      }
    }
  }
  
  return null;
}

async function matchAniAndEpByAi(season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, detailStore = null) {
  const aiBaseUrl = globals.aiBaseUrl;
  const aiModel = globals.aiModel;
  const aiApiKey = globals.aiApiKey;
  const aiMatchPrompt = globals.aiMatchPrompt;
  const preferredPlatform = dynamicPlatformOrder.find(platform => Boolean(platform)) || null;

  if (!globals.aiValid || !aiMatchPrompt) {
    log("warn", "[system] [match] AI configuration is incomplete, falling back to normal matching");
    return { resEpisode: null, resAnime: null };
  }

  const aiClient = new AIClient({
    apiKey: aiApiKey,
    baseURL: aiBaseUrl,
    model: aiModel,
    systemPrompt: aiMatchPrompt
  });

  const matchData = {
    title,
    season,
    episode,
    year,
    dynamicPlatformOrder,
    preferAnimeId,
    animes: searchData.animes.map(anime => {
      const normalizedAnimeTitle = anime.animeTitle || '';
      const match = normalizedAnimeTitle.match(/^(.*?)\(\d{4}\)/);
      const title = match ? match[1].trim() : normalizedAnimeTitle.split("(")[0].trim();
      return {
        animeId: anime.animeId,
        animeTitle: title,
        aliases: anime.aliases || [],
        type: anime.type,
        year: anime.startDate ? anime.startDate.slice(0, 4) : null,
        episodeCount: anime.episodeCount,
        source: anime.source
      };
    })
  };

  try {
    // userPrompt 只传入结构化数据
    const userPrompt = JSON.stringify(matchData, null, 2);

    const aiResponse = await aiClient.ask(userPrompt, { thinking: false });
    // const aiResponse = '{ "animeIndex": 0 }';
    log("info", `[system] [match] AI match response: ${aiResponse}`);

    let parsedResponse;
    try {
      const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```|```([\s\S]*?)\s*```|({[\s\S]*})/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2] || jsonMatch[3]) : aiResponse;
      parsedResponse = JSON.parse(jsonString.trim());
    } catch (parseError) {
      log("error", `[system] [match] Failed to parse AI response: ${parseError.message}`);
      return { resEpisode: null, resAnime: null };
    }

    const animeIndex = parsedResponse.animeIndex;

    if (animeIndex === null || animeIndex === undefined) {
      return { resEpisode: null, resAnime: null };
    }

    const selectedAnime = searchData.animes[animeIndex];
    if (!selectedAnime) {
      log("error", `[system] [match] AI returned invalid anime index: ${animeIndex}`);
      return { resEpisode: null, resAnime: null };
    }

    // AI 有时会把同名电影选为首个候选；存在季集参数时交给常规匹配，
    // 让多集电视剧候选按季集和集数优先级决策，避免单集电影抢占 S01E01。
    const bangumiData = getBangumiDataForMatch(selectedAnime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      return { resEpisode: null, resAnime: null };
    }

    const hasSeriesCandidate = searchData.animes.some(candidate => {
      const candidateData = getBangumiDataForMatch(candidate, detailStore);
      return !isMovieMatchCandidate(candidate) && getMatchEpisodeCount(candidate, candidateData) > 1;
    });
    if (season && episode && isSingleEpisodeMatchCandidate(selectedAnime, bangumiData) && hasSeriesCandidate) {
      log('info', '[system] [match] AI selected a single-episode candidate while series candidates exist; falling back to season/episode matching');
      return { resEpisode: null, resAnime: null };
    }

    let filteredEpisode = null;
    
    if (season && episode) {
        // 剧集模式逻辑
        const filteredTmpEpisodes = filterEpisodesByTitle(bangumiData.bangumi.episodes);
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes, { preferredPlatform });
        
        log("info", "[system] [match] 过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        // 匹配集数 (注意：findEpisodeByNumber 已增强支持模糊平台匹配)
        filteredEpisode = findEpisodeByNumber(filteredEpisodes, episode, episode, preferredPlatform);
    } else {
        // 电影模式逻辑
        if (bangumiData.bangumi.episodes.length > 0) {
          filteredEpisode = bangumiData.bangumi.episodes[0];
        }
    }

    return { resEpisode: filteredEpisode, resAnime: selectedAnime };
  } catch (error) {
    log("error", `[system] [match] AI matching failed: ${error.message}`);
    return { resEpisode: null, resAnime: null };
  }
}

export function getBangumiDataForMatch(anime, detailStore = null) {
  const detailAnime =
    resolveAnimeByIdFromDetailStore(anime?.bangumiId, detailStore, anime?.source) ||
    resolveAnimeByIdFromDetailStore(anime?.animeId, detailStore, anime?.source);

  if (!detailAnime) {
    log("warn", `[system] [match] Missing request detail snapshot for anime ${anime?.animeId ?? anime?.bangumiId}`);
    return null;
  }

  return buildBangumiData(detailAnime, anime?.bangumiId || anime?.animeId || "");
}

function computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode) {
  const seasonKey = String(season);
  const match = offsets[seasonKey].match(/^([^:]+):(.+)$/);
  const offsetEpisode = Number(match?.[1]) || 0;
  const offsetEpisodeTitle = match?.[2] || '';
  // 计算本次获取和保存的Episode差值
  const offset = episode - offsetEpisode;
  // 通过offsetEpisodeTitle获取保存的所在集index
  const offsetIndex = filteredEpisodes.findIndex(episode => episode.episodeTitle === offsetEpisodeTitle);
  if (offsetIndex !== -1) {
    // 计算本次获取的目标index
    targetEpisode = offsetIndex + offset + 1;
    log("info", `[system] [match] Applying offset "${offsets[seasonKey]}" for S${season}E${episode} -> ${targetEpisode}`);
  }
  return targetEpisode;
}

// 候选季号：取标题及别名中首个可识别的季号，均无法识别时按第 1 季处理
function resolveCandidateSeason(anime) {
  const titles = [anime.animeTitle];
  if (anime.aliases && Array.isArray(anime.aliases)) titles.push(...anime.aliases);

  for (const candTitle of titles) {
    if (!candTitle) continue;
    const s = extractSeasonNumberFromAnimeTitle(candTitle).season;
    if (s !== null) return s;
  }
  return 1;
}

/**
 * 跨季集数顺延映射逻辑
 * @param {Object} searchData 搜索结果数据
 * @param {string} title 搜索标题
 * @param {number|null} year 年份
 * @param {number} season 当前季数
 * @param {number} episode 目标集数
 * @param {string|null} platform 平台偏好
 * @param {Map|null} detailStore 详情缓存
 * @returns {Object} 匹配结果 { resEpisode, resAnime }
 */
function findCrossSeasonEpisodeMap(searchData, title, year, season, episode, platform, detailStore) {
  // 仅在当前季集三种匹配策略均未命中时才启动相对顺延溢出机制
  if (!season || !episode) return { resEpisode: null, resAnime: null };

  log("info", `[system] [spillover] 当前季集匹配策略失败 (S${season}E${episode})，正在进行跨季集数映射匹配...`);
  const normalizedTitle = normalizeTitleForMatch(title);
  const seasonMap = new Map();

  for (const anime of searchData.animes) {
    // 本地列表仅代表已上传的集数，不能用它推算整季长度并跨季顺延。
    if (anime.source === 'local') continue;
    const candidateTitles = [anime.animeTitle];
    if (anime.aliases && Array.isArray(anime.aliases)) candidateTitles.push(...anime.aliases);

    let isBaseMatch = false;
    for (const candTitle of candidateTitles) {
      if (!candTitle) continue;
      if (normalizeTitleForMatch(candTitle).includes(normalizedTitle)) {
        if (!matchYear(anime, year)) continue;
        isBaseMatch = true;
        break;
      }
    }
    if (!isBaseMatch) continue;

    const sNum = resolveCandidateSeason(anime);

    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (bangumiData?.success && bangumiData?.bangumi?.episodes) {
      const filteredTmpEpisodes = filterEpisodesByTitle(bangumiData.bangumi.episodes);
      const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes, { preferredPlatform: platform });

      if (filteredEpisodes.length > 0) {
        const existing = seasonMap.get(sNum);
        // 同一季号存在多个候选时，保留集数更多的条目（如 TV 系列覆盖剧场版/特别篇）
        if (!existing || filteredEpisodes.length > existing.episodes.length) {
          seasonMap.set(sNum, {
            anime: anime,
            episodes: filteredEpisodes,
            actualPlatform: extractPlatformFromTitle(anime.animeTitle) || anime.source
          });
        }
      }
    }
  }

  // 依据 TMDB 季边界推导「季号 -> 该季标准集数」, 使跨季顺延按剧集标准结构扣减而非依赖单源实际集数
  const boundaries = searchData.tmdbSeasonBoundaries;
  const seasonBoundaryCount = new Map();
  if (Array.isArray(boundaries) && boundaries.length >= 2) {
    for (let i = 0; i < boundaries.length; i++) {
      const cur = boundaries[i];
      const next = boundaries[i + 1];
      seasonBoundaryCount.set(cur.order, next ? next.startEpisode - cur.startEpisode : null);
    }
  }


  let currentTargetEpisode = episode;
  let currentSeason = season;
  let bestRes = { anime: null, episode: null, score: 0 };

  while (seasonMap.has(currentSeason) || seasonBoundaryCount.has(currentSeason)) {
    const seasonData = seasonMap.get(currentSeason);
    // 该季标准集数: 优先取 TMDB 边界推导值, 末季或边界缺失时回退至实际过滤后集数
    const boundaryCount = seasonBoundaryCount.get(currentSeason);

    // 中间季未拉取详情(已被 TMDB 边界跳过)时, 仅按其标准集数扣减以推进到目标季, 不参与实际集标题匹配
    if (!seasonData) {
      if (boundaryCount && boundaryCount > 0) {
        currentTargetEpisode -= boundaryCount;
        currentSeason++;
        continue;
      }
      break;
    }

    const allEps = seasonData.episodes;
    const seasonEpisodeTotal = (boundaryCount && boundaryCount > 0) ? boundaryCount : allEps.length;


    let absoluteMatch = null;
    for (const ep of allEps) {
      const extNum = extractEpisodeNumberFromTitle(ep.episodeTitle);
      if (extNum === episode) { 
        absoluteMatch = ep;
        break;
      }
    }

    if (absoluteMatch) {
      if (platform && getPlatformMatchScore(extractEpisodeTitle(absoluteMatch.episodeTitle), platform) === 0) {
          currentSeason++;
          continue;
      }
      log("info", `[system] [spillover] 跨季溢出查找命中 (按绝对标题数字) -> 所在季：S${currentSeason} 集标题：${absoluteMatch.episodeTitle}`);
      bestRes = {
        anime: seasonData.anime,
        episode: absoluteMatch,
        score: platform ? getPlatformMatchScore(seasonData.actualPlatform, platform) : 1
      };
      break;
    }

    if (currentTargetEpisode > 0 && currentTargetEpisode <= allEps.length) {
      const targetEp = allEps[currentTargetEpisode - 1];
      if (targetEp) {
        if (platform && getPlatformMatchScore(extractEpisodeTitle(targetEp.episodeTitle), platform) === 0) {
          currentSeason++;
          continue;
        }
        log("info", `[system] [spillover] 跨季溢出查找命中 (按相对排位计算) -> 所在季：S${currentSeason} 集标题：${targetEp.episodeTitle}`);
        bestRes = {
          anime: seasonData.anime,
          episode: targetEp,
          score: platform ? getPlatformMatchScore(seasonData.actualPlatform, platform) : 1
        };
        break;
      }
    }

    // 目标集号超出实际集数但仍落在该季 TMDB 标准区间内: 真实集数偏短时返回该季最后一集, 避免无谓顺延至后续季
    if (currentTargetEpisode <= seasonEpisodeTotal) {
      const targetEp = allEps[allEps.length - 1];
      if (platform && getPlatformMatchScore(extractEpisodeTitle(targetEp.episodeTitle), platform) === 0) {
          currentSeason++;
          continue;
      }
      log("info", `[system] [spillover] 跨季溢出查找命中 (按相对排位计算) -> 所在季：S${currentSeason} 集标题：${targetEp.episodeTitle}`);
      bestRes = {
        anime: seasonData.anime,
        episode: targetEp,
        score: platform ? getPlatformMatchScore(seasonData.actualPlatform, platform) : 1
      };
      break;
    }

    log("info", `[system] [spillover] S${currentSeason} 共有 ${seasonEpisodeTotal} 集(已过滤番外)，剩余目标集数为 ${currentTargetEpisode}，映射至 S${currentSeason + 1} 继续查找`);
    currentTargetEpisode -= seasonEpisodeTotal;
    currentSeason++;
  }

  return { resEpisode: bestRes.episode, resAnime: bestRes.anime };
}

export async function matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore = null) {
  // 定义最佳匹配结果容器
  let bestRes = {
    anime: null,
    episode: null,
    score: -9999 // 初始分数为极低值
  };
  // 记录每个候选的判定阶段，供接口详情说明最终选择
  const candidates = [];

  // 匹配·搜索与候选评分 阶段开始：本函数内的配置读取（如 REMEMBER_LAST_SELECT）归属到此
  markStepActive('匹配·搜索与候选评分');

  const normalizedTitle = normalizeTitleForMatch(title);
  const hasMultiEpisodeCandidate = season && episode && searchData.animes.some(candidate => {
    const candidateData = getBangumiDataForMatch(candidate, detailStore);
    return getMatchEpisodeCount(candidate, candidateData) > 1;
  });

  // 遍历所有搜索结果，寻找最佳匹配
  for (const anime of searchData.animes) {
    const candidateQueryTitle = anime.source === 'local'
      ? normalizeTitleForMatch(title.replace(/[（(]\s*(?:19|20)\d{2}\s*[）)]/g, '').trim())
      : normalizedTitle;

    let isMatch = false;
    let yearMismatch = false;

    // 构建待匹配的标题候选池 (主标题 + 所有别名)
    const candidateTitles = [anime.animeTitle];
    if (anime.aliases && Array.isArray(anime.aliases)) {
        candidateTitles.push(...anime.aliases);
    }

    // 1. 标题/年份/别名综合匹配检查
    for (const candTitle of candidateTitles) {
        if (!candTitle) continue;

        if (season && episode) {
            // 剧集模式
            if (normalizeTitleForMatch(candTitle).includes(candidateQueryTitle)) {
                // 年份匹配依然以原始 anime 为准，且年份匹配优先于季匹配
                if (!matchYear(anime, year)) {
                    log("info", `[system] [match] Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
                    continue;
                }

                // 年份匹配通过后，再判断season
                const animeIsPrefer = 
                  globals.rememberLastSelect && 
                  preferAnimeId && 
                  (String(anime.bangumiId) === String(preferAnimeId) || 
                  String(anime.animeId) === String(preferAnimeId));

                // 构造一个虚拟的 anime 对象传入 matchSeason，这样当命中别名时，matchSeason 才能正确判断后缀
                const tempAnime = { ...anime, animeTitle: candTitle };
                
                const seasonOk = matchSeason(tempAnime, title, season);
                if (seasonOk || animeIsPrefer) {
                    isMatch = true;
                    break; // 别名命中跳出
                }
            }
        } else {
            // 电影模式
            const cleanTitle = candTitle.split("(")[0].trim();
            if (normalizeTitleForMatch(cleanTitle) === candidateQueryTitle) {
                // 年份匹配检查
                if (!matchYear(anime, year)) {
                    log("info", `[system] [match] Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
                    continue;
                }
                isMatch = true;
                break; // 别名命中跳出
            }
        }
    }

    if (!isMatch) {
      candidates.push({ title: anime.animeTitle, source: anime.source, stage: yearMismatch ? '年份不符' : '标题未命中' });
      continue;
    }

    // 2. 获取剧集详情 (无条件获取，确保数据完整性)
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      candidates.push({ title: anime.animeTitle, source: anime.source, stage: '无分集' });
      continue;
    }

    // S01E01 不能仅凭“第 1 集”命中电影；只要搜索结果中存在多集候选，
    // 单集候选就不参与本轮季集匹配。这样不受平台顺序影响。
    if (hasMultiEpisodeCandidate && isSingleEpisodeMatchCandidate(anime, bangumiData)) {
      log('info', `[system] [match] Skip single-episode candidate for S${season}E${episode}: ${anime.animeTitle}`);
      candidates.push({ title: anime.animeTitle, source: anime.source, stage: '单集候选跳过' });
      continue;
    }
    
    // 输出匹配分数及原始数据日志
    log("info", "[system] [match] 判断剧集", `Anime: ${anime.animeTitle}`);
    log("info", "[system] [match]", bangumiData);

    let matchedEpisode = null;

    // 判定当前循环的 anime 是否为用户手动指定的优选偏好
    const isPreferredAnime = globals.rememberLastSelect && preferAnimeId != null && 
        (String(anime.bangumiId) === String(preferAnimeId) || String(anime.animeId) === String(preferAnimeId));

    if (season && episode) {
        // 剧集模式逻辑
        const filteredTmpEpisodes = filterEpisodesByTitle(bangumiData.bangumi.episodes);
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes, { preferredPlatform: platform });
        
        log("info", "[system] [match] 过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        let targetEpisode = episode;
        if (offsets && offsets[String(season)] !== undefined) {
          targetEpisode = computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode);
        }

        // 匹配集数
        matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, platform);

        // 当指定平台与候选动画源不匹配导致过滤后无匹配时，回退到不区分平台提取集数
        if (!matchedEpisode && platform) {
            const actualAnimePlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;
            if (getPlatformMatchScore(actualAnimePlatform, platform) === 0) {
                matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, null);
            }
        }

        // 如果当前是用户的优选偏好，但由于平台配置限制导致未命中目标平台，则放宽条件无视平台限制提取集数
        if (!matchedEpisode && isPreferredAnime) {
            log("info", `[system] [match] 优选剧集未命中目标平台 ${platform}，放宽条件提取集数`);
            matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, null);
        }
    } else {
        // 电影模式逻辑
        if (bangumiData.bangumi.episodes.length > 0) {
            if (platform) {
                // 在剧集列表中寻找匹配特定平台的资源
                const targetEp = bangumiData.bangumi.episodes.find(ep => {
                    const epTitlePlatform = extractEpisodeTitle(ep.episodeTitle);
                    return getPlatformMatchScore(epTitlePlatform, platform) > 0;
                });
                
                if (targetEp) {
                    matchedEpisode = targetEp;
                } else if (isPreferredAnime) {
                    log("info", `[system] [match] 优选电影未命中目标平台 ${platform}，放宽条件提取资源`);
                    matchedEpisode = bangumiData.bangumi.episodes[0];
                } else {
                    // 候选存在但资源挂在其他平台，当前偏好组不可用
                    candidates.push({ title: anime.animeTitle, source: anime.source, stage: '资源平台不匹配偏好组', detail: platform });
                }
            } else {
                matchedEpisode = bangumiData.bangumi.episodes[0];
            }
        }
    }

    if (!matchedEpisode) {
        // 候选通过标题校验但集数未对上：可能是季集号在候选中不存在，或资源平台与偏好组不符
        // 平台不匹配的候选已在电影分支记录，这里只补集数对不上的情况
        if (!candidates.some(item => item.title === anime.animeTitle && item.stage !== '参与评分')) {
          candidates.push({ title: anime.animeTitle, source: anime.source, stage: '无匹配集数', detail: platform ? `偏好组 ${platform}` : '' });
        }
    }

    // 3. 匹配结果处理与评分比较
    if (matchedEpisode) {
        // 计算当前匹配的得分
        // 候选平台由番剧身份标签（标题 from 段或 source）与命中集所挂平台标签共同决定，使身份名（如 tencent）与优选平台名（如 qq）不一致但集上挂有该标签的源也能正确加分
        const identityPlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;
        const epPlatform = matchedEpisode ? extractEpisodeTitle(matchedEpisode.episodeTitle) : null;
        const candidatePlatform = [...new Set([identityPlatform, epPlatform].filter(Boolean)
            .flatMap(p => p.split(/[&＆]/).map(s => s.trim().toLowerCase())).filter(s => s))].join('&');
        let currentScore = 0;

        if (platform) {
            // 如果指定了平台偏好，计算匹配得分
            currentScore = getPlatformMatchScore(candidatePlatform, platform);
        } else {
            // 如果没有指定平台偏好，默认为 1
            currentScore = 1;
        }

        // 赋予手动指定偏好最高分数权重，确保其在多源匹配中具有绝对优先级
        if (isPreferredAnime) {
            currentScore += 9999;
        }

        // 比较并更新最佳结果。带季集时多集候选优先；单集候选仅作为兜底。
        const isSingleEpisodeCandidate = season && episode && isSingleEpisodeMatchCandidate(anime, bangumiData);
        if (isSingleEpisodeCandidate) {
            currentScore -= 100;
        } else if (season && episode) {
            currentScore += 100;
        }
        const detail = [
          platform ? `平台 ${platform} 计分` : '无平台偏好 +1',
          isPreferredAnime ? '手动优选 +9999' : null,
          isSingleEpisodeCandidate ? '单集兜底 -100' : (season && episode ? '多集 +100' : null),
          `合计 ${currentScore}`,
        ].filter(Boolean).join('、');
        candidates.push({
          title: anime.animeTitle,
          animeId: anime.animeId,
          source: anime.source,
          episodeTitle: matchedEpisode.episodeTitle,
          score: currentScore,
          stage: '参与评分',
          detail,
        });

        // 逻辑：如果有更好的分数，或者之前没有匹配到任何结果，则更新
        if (currentScore > bestRes.score) {
             bestRes = {
                anime: anime,
                episode: matchedEpisode,
                score: currentScore
            };
        }

        // 已命中最高优先级的手动优选，或不存在平台偏好且无待匹配的优选条目时立刻跳出查找
        if (isPreferredAnime || (!platform && !preferAnimeId && !isSingleEpisodeCandidate)) {
          break;
        }
        
        // 如果指定了平台偏好，则继续循环查找是否有得分更高的源（最小杂质匹配）
    }
  }

  //  跨季集数顺延映射匹配逻辑
  if (!bestRes.episode && season && episode) {
    const spilloverRes = findCrossSeasonEpisodeMap(searchData, title, year, season, episode, platform, detailStore);
    if (spilloverRes.resEpisode) {
      // 候选平台由番剧身份标签与命中集所挂平台标签共同决定，与 matchAniAndEp 评分口径保持一致
      const spillIdentity = extractPlatformFromTitle(spilloverRes.resAnime.animeTitle) || spilloverRes.resAnime.source;
      const spillEpPlatform = spilloverRes.resEpisode ? extractEpisodeTitle(spilloverRes.resEpisode.episodeTitle) : null;
      const spillCandidate = [...new Set([spillIdentity, spillEpPlatform].filter(Boolean)
          .flatMap(p => p.split(/[&＆]/).map(s => s.trim().toLowerCase())).filter(s => s))].join('&');
      bestRes = {
        episode: spilloverRes.resEpisode,
        anime: spilloverRes.resAnime,
        score: platform ? getPlatformMatchScore(spillCandidate, platform) : 1
      };
    }
  }

  // 指定平台偏好时仅当最佳结果真实命中该平台（得分 > 0）才视为有效匹配，否则视作该平台无可用源交由上层按 PLATFORM_ORDER 顺延到下一平台或回退默认匹配，避免首个命中标题但平台得分 0 的番剧被误判为该平台匹配而阻断后续平台递进
  if (platform && bestRes.score <= 0) {
    return { resEpisode: null, resAnime: null, candidates };
  }

  return { resEpisode: bestRes.episode, resAnime: bestRes.anime, candidates };
}

export async function fallbackMatchAniAndEp(searchData, req, season, episode, year, title, resEpisode, resAnime, offsets, detailStore = null) {
  // 兜底先尝试季号与目标季一致的候选，全部落空后再退回不限季的取值逻辑，避免直接取到其它季的同集号
  const sameSeasonAnimes = [];
  const restAnimes = [];
  for (const anime of searchData.animes) {
    if (season && resolveCandidateSeason(anime) === season) {
      sameSeasonAnimes.push(anime);
    } else {
      restAnimes.push(anime);
    }
  }

  for (const anime of [...sameSeasonAnimes, ...restAnimes]) {
    // 年份匹配优先（如果提供了年份）
    if (year && !matchYear(anime, year)) {
      log("info", `[system] [match] Fallback: Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
      continue;
    }
    
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      continue;
    }
    log("info", "[system] [match]", bangumiData);
    if (season && episode) {
      // 过滤集标题正则条件的 episode
      const filteredTmpEpisodes = filterEpisodesByTitle(bangumiData.bangumi.episodes);

      // 过滤集标题一致的 episode，且保留首次出现的集标题的 episode
      const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);

      log("info", "[system] [LogVar-API] 过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

      let targetEpisode = episode;
      if (offsets && offsets[String(season)] !== undefined) {
        targetEpisode = computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode);
      }

      // 使用新的集数匹配策略
      const matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, null);
      if (matchedEpisode) {
        resEpisode = matchedEpisode;
        resAnime = anime;
        break;
      }
    } else {
      if (bangumiData.bangumi.episodes.length > 0) {
        resEpisode = bangumiData.bangumi.episodes[0];
        resAnime = anime;
        break;
      }
    }
  }

  // 跨季兜底溢出查找逻辑
  let isSpillover = false;
  if (!resEpisode && season && episode) {
    const spilloverRes = findCrossSeasonEpisodeMap(searchData, title, year, season, episode, null, detailStore);
    if (spilloverRes.resEpisode) {
      resEpisode = spilloverRes.resEpisode;
      resAnime = spilloverRes.resAnime;
      isSpillover = true;
    }
  }

  return {resEpisode, resAnime, isSpillover};
}

/**
 * 解析单个链接，返回源标识符和用于弹幕获取的 realId
 * @param {string} url
 * @returns {{source: string, realId: string}}
 */
function resolveSourceAndRealId(url) {
  // Animeko: bgm.tv/bangumi.tv/chii.in/bangumi.lol/ep/xxx → animeko:xxx(@offset)
  const bgmMatch = url.match(/(?:bgm\.tv|bangumi\.tv|bangumi\.lol|chii\.in)\/ep\/(\d+)/);
  if (bgmMatch) {
    const { offset, percent } = stripLinkOffset(url);
    return { source: 'animeko', realId: bgmMatch[1] + (offset !== 0 ? `@${offset}${percent ? '%' : ''}` : '') };
  }
  // Bahamut: ani.gamer.com.tw/animeVideo.php?sn=xxx → bahamut:xxx(@offset)
  const bahaMatch = url.match(/ani\.gamer\.com\.tw\/animeVideo\.php\?sn=(\d+)/);
  if (bahaMatch) {
    const { offset, percent } = stripLinkOffset(url);
    return { source: 'bahamut', realId: bahaMatch[1] + (offset !== 0 ? `@${offset}${percent ? '%' : ''}` : '') };
  }
  // 其他平台：直接传递完整 URL
  const source = detectPlatformFromUrl(url);
  return { source, realId: url };
}

/**
 * 根据 URL 域名返回源标识符
 * @param {string} url
 * @returns {string}
 */
function detectPlatformFromUrl(url) {
  if (String(url).startsWith('hongguo:') || isHongguoPlayerUrl(url)) return 'hongguo';
  if (url.includes('.qq.com')) return 'tencent';
  if (url.includes('.iqiyi.com')) return 'iqiyi';
  if (url.includes('.mgtv.com')) return 'imgo';
  if (url.includes('.youku.com')) return 'youku';
  if (url.includes('.bilibili.com') || url.includes('b23.tv')) return 'bilibili';
  if (url.includes('.miguvideo.com')) return 'migu';
  if (url.includes('.sohu.com')) return 'sohu';
  if (url.includes('.le.com')) return 'leshi';
  if (url.includes('.douyin.com') || url.includes('.ixigua.com')) return 'xigua';
  if (url.includes('.mddcloud.com.cn')) return 'maiduidui';
  if (url.includes('.yfsp.tv')) return 'aiyifan';
  return 'unknown';
}

export async function extractTitleSeasonEpisode(cleanFileName) {
  const regex = /^(.+?)[.\s]+S(\d+)E(\d+)/i;
  const match = cleanFileName.match(regex);

  let title, season, episode, year;

  if (match) {
    // 匹配到 S##E## 格式
    title = match[1].trim();
    season = parseInt(match[2], 10);
    episode = parseInt(match[3], 10);

    // ============ 提取年份 =============
    // 从文件名中提取年份（支持多种格式：.2009、.2024、(2009)、(2024) 等）
    const yearMatch = cleanFileName.match(/(?:\.|\(|（)((?:19|20)\d{2})(?:\)|）|\.|$)/);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
    }

    // ============ 新标题提取逻辑（重点）============
    // 目标：
    // 1. 优先保留最干净、最像剧名的那一段（通常是开头）
    // 2. 支持：纯中文、纯英文、中英混排、带年份的、中文+单个字母（如亲爱的X）
    // 3. 自动去掉后面的年份、技术参数等垃圾

    // 情况1：开头是中文（最常见的中文字幕组文件名）
    const chineseStart = title.match(/^[\u4e00-\u9fa5·]+[^.\r\n]*/); // 允许中文后面紧跟非.符号，如 亲爱的X、宇宙Marry Me?
    if (chineseStart) {
      title = chineseStart[0];
    }
    // 情况2：开头是英文（欧美剧常见，如 Blood.River）
    else if (/^[A-Za-z0-9]/.test(title)) {
      // 从开头一直取到第一个明显的技术字段或年份之前
      const engMatch = title.match(/^([A-Za-z0-9.&\s]+?)(?=\.\d{4}|$)/);
      if (engMatch) {
        title = engMatch[1].trim().replace(/[._]/g, ' '); // Blood.River → Blood River（也可以保留.看你喜好）
        // 如果你想保留原样点号，就去掉上面这行 replace
      }
    }
    // 情况3：中文+英文混排（如 爱情公寓.ipartment.2009）
    else {
      // 先尝试取到第一个年份或分辨率之前的所有内容，再优先保留中文开头部分
      const beforeYear = title.split(/\.(?:19|20)\d{2}|2160p|1080p|720p|H265|iPhone/)[0];
      const chineseInMixed = beforeYear.match(/^[\u4e00-\u9fa5·]+/);
      title = chineseInMixed ? chineseInMixed[0] : beforeYear.trim();
    }

    // 最后再保险清理一次常见的年份尾巴（防止漏网）
    title = title.replace(/\.\d{4}$/i, '').trim();
  } else {
    // 没有 S##E## 格式，尝试提取第一个片段作为标题
    // 匹配第一个中文/英文标题部分（在年份、分辨率等技术信息之前）
    const titleRegex = /^([^.\s]+(?:[.\s][^.\s]+)*?)(?:[.\s](?:\d{4}|(?:19|20)\d{2}|\d{3,4}p|S\d+|E\d+|WEB|BluRay|Blu-ray|HDTV|DVDRip|BDRip|x264|x265|H\.?264|H\.?265|AAC|AC3|DDP|TrueHD|DTS|10bit|HDR|60FPS))/i;
    const titleMatch = cleanFileName.match(titleRegex);

    title = titleMatch ? titleMatch[1].replace(/[._]/g, ' ').trim() : cleanFileName;
    season = null;
    episode = null;
    
    // 从文件名中提取年份
    const yearMatch = cleanFileName.match(/(?:\.|\(|（)((?:19|20)\d{2})(?:\)|）|\.|$)/);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
    }
  }

  // 如果外语标题转换中文开关已开启，则尝试获取中文标题
  if (globals.titleToChinese) {
    // 如果title中包含.，则用空格替换
    title = await getTMDBChineseTitle(title.replace('.', ' '), season, episode);
  }

  log("info", "[system] [match] Parsed title, season, episode, year", {title, season, episode, year});
  return {title, season, episode, year};
}

export function buildSearchAnimeUrl(baseUrl, keyword, season, episode) {
  const searchUrl = new URL(baseUrl);
  const apiPrefix = searchUrl.pathname.replace(/\/(?:match|search\/episodes)$/, '');
  searchUrl.pathname = `${apiPrefix}/search/anime`;
  searchUrl.search = '';
  searchUrl.searchParams.set('keyword', keyword || '');
  if (season !== undefined) {
    searchUrl.searchParams.set('season', season || '');
  }
  if (episode !== undefined) {
    searchUrl.searchParams.set('episode', episode || '');
  }
  return searchUrl;
}

async function selectAnimeMatch({ season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, offsets, detailStore }) {
  let resAnime = null;
  let resEpisode = null;
  let spilloverMatched = false;

  const aiMatchResult = await matchAniAndEpByAi(
    season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, detailStore
  );
  if (aiMatchResult.resAnime && aiMatchResult.resEpisode) {
    // AI 直接给出结果，没有逐平台评分
    return { resAnime: aiMatchResult.resAnime, resEpisode: aiMatchResult.resEpisode, spilloverMatched: false, platformAttempts: [] };
  }

  const platformAttempts = [];
  for (const platform of dynamicPlatformOrder) {
    const matched = await matchAniAndEp(
      season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore
    );
    platformAttempts.push({
      platform: platform || '默认',
      selected: Boolean(matched.resAnime),
      candidates: matched.candidates || [],
    });
    resEpisode = matched.resEpisode;
    resAnime = matched.resAnime;
    if (resAnime) {
      log("info", `[system] [match] Found match with platform: ${platform || 'default'}`);
      break;
    }
  }

  if (!resAnime) {
    const fallback = await fallbackMatchAniAndEp(
      searchData, req, season, episode, year, title, resEpisode, resAnime, offsets, detailStore
    );
    resEpisode = fallback.resEpisode;
    resAnime = fallback.resAnime;
    spilloverMatched = fallback.isSpillover;
  }

  return { resAnime, resEpisode, spilloverMatched, platformAttempts };
}

function createMatchPlatformOrder(preferredPlatform, secondaryPreferredPlatform = null) {
  const dynamicPlatformOrder = createDynamicPlatformOrder(preferredPlatform);
  if (!secondaryPreferredPlatform || secondaryPreferredPlatform === preferredPlatform ||
      !globals.allowedPlatforms.includes(secondaryPreferredPlatform)) {
    return dynamicPlatformOrder;
  }

  const withoutSecondary = dynamicPlatformOrder.filter(platform => platform !== secondaryPreferredPlatform);
  withoutSecondary.splice(preferredPlatform ? 1 : 0, 0, secondaryPreferredPlatform);
  return withoutSecondary;
}

async function executeMatchAttempt({ req, title, season, episode, year, preferredPlatform, secondaryPreferredPlatform, preferAnimeId, preferSource, offsets, mapping }) {
  const dynamicPlatformOrder = createMatchPlatformOrder(preferredPlatform, secondaryPreferredPlatform);
  const targetPlatform = dynamicPlatformOrder.length > 0 ? dynamicPlatformOrder[0] : null;
  const detailStore = new Map();
  const searchUrl = buildSearchAnimeUrl(req.url, title, season, episode);
  const searchRes = await searchAnime(searchUrl, preferAnimeId, preferSource, detailStore, targetPlatform);
  const searchData = await searchRes.json();
  log("info", `[system] [match] searchData: ${searchData.animes}`);
  log("info", `[system] [match] Dynamic platformOrder: ${dynamicPlatformOrder}`);
  log("info", `[system] [match] Preferred platform: ${preferredPlatform || 'none'}`);

  // 本次尝试写入缓存时若失败（如剧集 ID 越界），带回原因，供"未匹配"时向调用方说明
  const cacheWarning = getAddAnimeError(detailStore);

  if (!searchData?.success || !Array.isArray(searchData.animes) || searchData.animes.length === 0) {
    return { resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning, candidateCount: 0 };
  }

  const targetCandidates = mapping ? filterMappingTargetCandidates(searchData.animes, mapping) : searchData.animes;
  if (mapping && targetCandidates.length === 0) {
    return { resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning, candidateCount: 0 };
  }

  const targetSearchData = { ...searchData, animes: targetCandidates };
  const candidatePasses = [];
  if (mapping?.targetYear || mapping?.targetType) {
    const qualified = filterMappingQualifierCandidates(targetCandidates, mapping);
    if (qualified.length > 0) {
      candidatePasses.push({
        searchData: { ...searchData, animes: qualified },
        year: mapping.targetYear || null,
        label: 'qualified'
      });
    }
  }
  candidatePasses.push({ searchData: targetSearchData, year: mapping ? null : year, label: 'fallback' });

  for (const pass of candidatePasses) {
    if (mapping && pass.label === 'fallback' && (mapping.targetYear || mapping.targetType)) {
      log('info', `[system] [auto-match-mapping] Relaxing target qualifiers for "${mapping.targetDisplayTitle}" while keeping the target title`);
    }
    const selected = await selectAnimeMatch({
      season,
      episode,
      year: pass.year,
      searchData: pass.searchData,
      title,
      req,
      dynamicPlatformOrder,
      preferAnimeId,
      offsets,
      detailStore
    });
    if (selected.resAnime && selected.resEpisode) {
      if (mapping && pass.label === 'qualified') {
        log('info', `[system] [auto-match-mapping] Matched preferred target qualifiers for "${mapping.targetDisplayTitle}"`);
      }
      return { ...selected, title, season, episode, cacheWarning, candidateCount: targetCandidates.length };
    }
  }

  return {
    resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning,
    candidateCount: targetCandidates.length, platformAttempts: [],
  };
}

// 逐轮展开各偏好组的候选与分数，标记最终选中项
// 每轮尝试独立成行，同一候选在不同偏好组的重复参与如实标为多轮
export function buildMatchScoring(platformAttempts, resAnime) {
  const rows = [];
  const counts = { 标题未命中: 0, 年份不符: 0, 无分集: 0, 单集候选跳过: 0, 无匹配集数: 0, 资源平台不匹配偏好组: 0 };
  for (const [attemptIndex, attempt] of (platformAttempts || []).entries()) {
    const selectedKey = attempt.selected && resAnime
      ? `${resAnime.animeTitle}|${resAnime.animeId ?? ''}|${resAnime.source ?? ''}`
      : null;
    const platformLabel = attempt.platform.split(/[&＆]/).map(name => name.trim()).filter(Boolean).join('、');
    // 每轮尝试单独成组，同一候选在不同偏好组的重复参与如实标为多轮，不合并成多个候选
    const attemptLabel = `第 ${attemptIndex + 1} 轮 · ${platformLabel}`;
    const scored = [];
    for (const candidate of attempt.candidates || []) {
      if (candidate.stage === '参与评分') {
        scored.push(candidate);
        continue;
      }
      counts[candidate.stage] = (counts[candidate.stage] || 0) + 1;
      rows.push({
        尝试: attemptLabel,
        候选: candidate.title,
        命中集: '—',
        分数: '—',
        结果: candidate.stage,
        结果说明: [platformLabel + ' 偏好组下淘汰', candidate.detail].filter(Boolean).join('：'),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    // 同分并列时由遍历顺序决定选中项，标明该依据，避免分数列无法解释选中
    const scoreTally = new Map();
    for (const candidate of scored) scoreTally.set(candidate.score, (scoreTally.get(candidate.score) || 0) + 1);
    for (const candidate of scored) {
      // 不同源可能返回相同标题的候选，选中判定须同时比对唯一标识
      const isSelected = Boolean(
        selectedKey
        && `${candidate.title}|${candidate.animeId ?? ''}|${candidate.source ?? ''}` === selectedKey
      );
      const tieNote = isSelected && scoreTally.get(candidate.score) > 1 ? '与同分候选并列，按候选顺序优先' : '';
      rows.push({
        尝试: attemptLabel,
        候选: candidate.title,
        命中集: candidate.episodeTitle || '—',
        分数: candidate.score,
        结果: isSelected ? '选中' : '未选中',
        结果说明: [candidate.detail, tieNote].filter(Boolean).join('；') || '—',
      });
    }
  }
  return { rows, counts };
}

// 归一化查询标题；record 为真时登记繁转简与杂音清理的生效明细
function prepareQueryTitle(title, record = false) {
  let normalized = String(title || '').trim();
  if (globals.animeTitleSimplified) {
    const simplified = simplized(normalized);
    if (record && simplified !== normalized) {
      recordConfigEffect('ANIME_TITLE_SIMPLIFIED', { label: '剧名繁转简', before: normalized, after: simplified, hit: true });
    }
    normalized = simplified;
  }
  if (globals.titleNoiseFilter) {
    const cleaned = normalized.replace(globals.titleNoiseFilter, '').trim();
    if (record && cleaned !== normalized) {
      recordConfigEffect('TITLE_NOISE_FILTER', { label: '剧名杂音清理', before: normalized, after: cleaned, hit: true });
    }
    normalized = cleaned;
  }
  return normalized;
}

function resolveLegacyMatchTitle(title) {
  const mapped = globals.resolveTitleMapping(title);
  if (mapped) log("info", `[system] [match] Title mapped from original: ${title} to: ${mapped}`);
  return prepareQueryTitle(mapped || title);
}

function findSeasonPreferenceTitle(titles, season) {
  if (!globals.rememberLastSelect) return null;
  for (const title of titles) {
    if (title && hasSeasonSpecificPreference(title, season)) return title;
  }
  return null;
}

function findLegacySeasonPreferenceTitle(titles, season) {
  for (const title of titles) {
    if (title && hasLegacySeasonPreference(title, season)) return title;
  }
  return null;
}

// Extracted function for POST /api/v2/match
export async function matchAnime(url, req, clientIp) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body) {
      log("error", "[system] [match] Request body is empty");
      traceStep('匹配·参数校验', Date.now(), { status: 'fail', reason: '请求体为空' });
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Empty request body" },
        400
      );
    }

    // 处理请求体中的数据
    // 假设请求体包含一个字段，比如 { query: "anime name" }
    const { fileName } = body;
    if (!fileName) {
      log("error", "[system] [match] Missing fileName parameter in request body");
      traceStep('匹配·参数校验', Date.now(), { status: 'fail', reason: '缺少 fileName 参数' });
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing fileName parameter" },
        400
      );
    }

    // 匹配·文件名解析 阶段开始
    markStepActive('匹配·文件名解析');
    const matchParseStartedAt = Date.now();

    // 解析fileName，提取平台偏好
    const { cleanFileName, preferredPlatform } = parseFileName(fileName);
    log("info", `[system] [match] Processing anime match for query: ${fileName}`);
    log("info", `[system] [match] Parsed cleanFileName: ${cleanFileName}, preferredPlatform: ${preferredPlatform}`);

    const parsed = await extractTitleSeasonEpisode(cleanFileName);
    const originalTitle = prepareQueryTitle(parsed.title, true);
    const originalSeason = parsed.season;
    const originalEpisode = parsed.episode;
    const originalYear = parsed.year;

    traceStep('匹配·文件名解析', matchParseStartedAt, { status: 'ok', inputs: { fileName }, outputs: { title: parsed.title, season: parsed.season, episode: parsed.episode, year: parsed.year } });

    const preferenceTitles = [...new Set([originalTitle, parsed.title].filter(Boolean))];
    // 匹配·映射表加载 阶段开始
    markStepActive('匹配·映射表加载');
    const matchMappingStartedAt = Date.now();

    await ensureRemoteAutoMatchMapping();
    const effectiveRules = getEffectiveAutoMatchMappingRules();
    const localRuleCount = effectiveRules.filter(rule => rule.origin === 'local').length;
    const remoteRuleCount = effectiveRules.filter(rule => rule.origin === 'remote').length;
    const configuredMapping = resolveAutoMatchMapping(effectiveRules, {
      title: originalTitle,
      season: originalSeason,
      episode: originalEpisode
    });
    recordConfigEffect('AUTO_MATCH_MAPPING_TABLE', {
      label: '自动匹配映射规则命中',
      hit: Boolean(configuredMapping),
      before: {
        title: originalTitle, season: originalSeason, episode: originalEpisode,
        localRules: localRuleCount, remoteRules: remoteRuleCount,
      },
      after: configuredMapping ? {
        title: configuredMapping.targetTitle,
        season: configuredMapping.targetSeason,
        episode: configuredMapping.targetEpisode,
        platform: configuredMapping.targetPlatform || null,
        rule: configuredMapping.raw,
        origin: configuredMapping.origin,
      } : null,
    });
    recordConfigEffect('AUTO_MATCH_MAPPING_TABLE_URL', {
      label: '远程季集映射规则加载', kind: 'stats',
      hit: remoteRuleCount > 0,
      context: {
        地址: describeConfigValue('autoMatchMappingTableUrl', globals.autoMatchMappingTableUrl),
        远程规则数: remoteRuleCount,
      },
      summary: remoteRuleCount > 0 ? `从远程加载 ${remoteRuleCount} 条规则` : '远程规则为空',
    });
    const manualPreferenceTitle = findSeasonPreferenceTitle(preferenceTitles, originalSeason);
    const mapping = manualPreferenceTitle ? null : configuredMapping;
    if (configuredMapping && manualPreferenceTitle) {
      log('info', `[system] [auto-match-mapping] Explicit manual preference for "${manualPreferenceTitle}" S${originalSeason} overrides rule "${configuredMapping.raw}"`);
    } else if (configuredMapping) {
      const legacyPreferenceTitle = findLegacySeasonPreferenceTitle(preferenceTitles, originalSeason);
      if (legacyPreferenceTitle) {
        log('info', `[system] [auto-match-mapping] Ignoring unmarked legacy preference for "${legacyPreferenceTitle}" S${originalSeason}`);
      }
    }

    traceStep('匹配·映射表加载', matchMappingStartedAt, {
      status: 'ok',
      inputs: {
        title: originalTitle, season: originalSeason, episode: originalEpisode,
        titleMappingTable: globals.titleMappingTable?.size ?? 0,
        titleMappingTableUrl: describeConfigValue('titleMappingTableUrl', globals.titleMappingTableUrl),
        autoMatchMappingTableUrl: describeConfigValue('autoMatchMappingTableUrl', globals.autoMatchMappingTableUrl),
        useBangumiData: globals.useBangumiData, titleToChinese: globals.titleToChinese,
      },
      outputs: { mappingHit: Boolean(mapping), candidate: mapping ? mapping.targetTitle : null },
    });

    // 匹配·搜索与候选评分 阶段开始
    markStepActive('匹配·搜索与候选评分');
    const matchScoreStartedAt = Date.now();

    let attempt;
    let mappingApplied = false;

    if (mapping) {
      const mappedTitle = prepareQueryTitle(mapping.targetTitle);
      const mappedPlatform = mapping.targetPlatform || preferredPlatform;
      log('info', `[system] [auto-match-mapping] ${originalTitle} S${originalSeason}E${originalEpisode} -> ${mappedTitle} S${mapping.targetSeason}E${mapping.targetEpisode}${mapping.targetPlatform ? ` @${mapping.targetPlatform}` : ''}`);
      attempt = await executeMatchAttempt({
        req,
        title: mappedTitle,
        season: mapping.targetSeason,
        episode: mapping.targetEpisode,
        year: mapping.targetYear,
        preferredPlatform: mappedPlatform,
        secondaryPreferredPlatform: mapping.targetPlatform ? preferredPlatform : null,
        preferAnimeId: null,
        preferSource: null,
        offsets: null,
        mapping
      });
      mappingApplied = Boolean(attempt.resAnime && attempt.resEpisode);
      if (!mappingApplied) {
        log('warn', `[system] [auto-match-mapping] Target failed for "${mapping.raw}", falling back to original match`);
      }
    }

    if (!mappingApplied) {
      const title = manualPreferenceTitle || resolveLegacyMatchTitle(parsed.title);
      const preferenceKey = manualPreferenceTitle || title;
      const [preferAnimeId, preferSource, offsets] = globals.rememberLastSelect
        ? getPreferAnimeId(preferenceKey, originalSeason)
        : [null, null, null];
      log("info", `[system] [match] prefer animeId: ${preferAnimeId} from ${preferSource}`);
      attempt = await executeMatchAttempt({
        req,
        title,
        season: originalSeason,
        episode: originalEpisode,
        year: originalYear,
        preferredPlatform,
        secondaryPreferredPlatform: null,
        preferAnimeId,
        preferSource,
        offsets,
        mapping: null
      });
    }

    const { resAnime, resEpisode, spilloverMatched } = attempt;

    const { rows: scoringRows, counts: stageCounts } = buildMatchScoring(attempt.platformAttempts, resAnime);

    traceStep('匹配·搜索与候选评分', matchScoreStartedAt, {
      status: resAnime && resEpisode ? 'ok' : 'empty',
      reason: resAnime && resEpisode ? undefined : '候选评分未选出匹配结果',
      outputs: {
        candidateCount: attempt.candidateCount,
        matched: Boolean(resAnime && resEpisode),
        source: resAnime?.source,
        episodeId: resEpisode?.episodeId,
        mappingApplied,
        count: resAnime && resEpisode ? 1 : 0,
        ...stageCounts,
      },
      table: scoringRows.length > 0
        ? { columns: ['尝试', '候选', '命中集', '分数', '结果', '结果说明'], rows: scoringRows }
        : undefined,
    });

    // 匹配·结果组装 阶段开始
    markStepActive('匹配·结果组装');
    const matchAssembleStartedAt = Date.now();

    let resData = {
      "errorCode": 0,
      "success": true,
      "errorMessage": "",
      "isMatched": false,
      "matches": []
    };

    resData["isMatched"] = Boolean(resAnime && resEpisode);

    if (resEpisode) {
      if (clientIp && !spilloverMatched) {
        setLastSearch(clientIp, mappingApplied ? {
          title: originalTitle,
          season: originalSeason,
          episode: originalEpisode,
          episodeId: resEpisode.episodeId,
          autoMatchMappingApplied: true,
          mappingTargetTitle: mapping.targetTitle
        } : {
          title: attempt.title,
          season: attempt.season,
          episode: attempt.episode,
          episodeId: resEpisode.episodeId
        });
      }
      resData["matches"] = [
        AnimeMatch.fromJson({
          "episodeId": resEpisode.episodeId,
          "animeId": resAnime.animeId,
          "animeTitle": resAnime.animeTitle,
          "episodeTitle": resEpisode.episodeTitle,
          "type": resAnime.type,
          "typeDescription": resAnime.typeDescription,
          "shift": 0,
          "imageUrl": resAnime.imageUrl,
          "url": resEpisode.url || ""
        })
      ]
    }

    // 与搜索接口一致：只有"没匹配上"才用 errorMessage 说明缓存写入失败的原因。
    if (resData["matches"].length === 0 && attempt.cacheWarning) {
      resData["errorMessage"] = attempt.cacheWarning;
    }

    if (resData["matches"] && resData["matches"].length > 0) {
      const favoriteTitle = mappingApplied ? originalTitle : attempt.title;
      const favoriteSeason = mappingApplied ? originalSeason : attempt.season;
      const favoriteKey = favoriteSeason !== null ? `${favoriteTitle}_S${favoriteSeason}` : favoriteTitle;
      if (resolveFavoriteForSearchKeyword(favoriteKey)) {
        resData["matches"] = resData["matches"].map(m => ({ ...m, isFavorite: true }));
      }
    }

    log("info", `[system] [match] resMatchData: ${resData}`);

    traceStep('匹配·结果组装', matchAssembleStartedAt, {
      status: resData.matches.length === 0 ? 'empty' : 'ok',
      reason: resData.matches.length === 0 ? '未组装出匹配结果' : undefined,
      outputs: {
        finalSubjectId: resAnime?.animeId,
        isMatched: Boolean(resAnime && resEpisode),
        // 用户最关心最终选中哪一条，标题与集名比数字 ID 更直观
        animeTitle: resData.matches[0]?.animeTitle,
        episodeTitle: resData.matches[0]?.episodeTitle,
        matchCount: resData.matches.length,
        count: resData.matches.length,
      },
    });

    // 示例返回
    return jsonResponse(resData);
  } catch (error) {
    // 处理匹配请求中的异常
    log("error", `[system] [match] Error processing match request: ${error.stack || error.message}`);
    traceStep('匹配·处理异常', Date.now(), {
      status: 'fail',
      reason: '匹配请求处理失败',
      error: error.message,
    });
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: error.message || "Invalid JSON body" },
      400
    );
  }
}

// Extracted function for GET /api/v2/search/episodes
export async function searchEpisodes(url) {
  let anime = url.searchParams.get("anime");
  const episode = url.searchParams.get("episode") || "";

  // 如果启用了搜索关键字繁转简，则进行转换
  if (globals.animeTitleSimplified) {
    const simplifiedTitle = simplized(anime);
    log("info", `[system] [episodes] searchEpisodes converted traditional to simplified: ${anime} -> ${simplifiedTitle}`);
    anime = simplifiedTitle;
  }

  log("info", `[system] [episodes] Search episodes with anime: ${anime}, episode: ${episode}`);

  if (!anime) {
    log("error", "[system] [episodes] Missing anime parameter");
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Missing anime parameter" },
      400
    );
  }

  // 先搜索动漫
  let searchUrl = buildSearchAnimeUrl(url, anime);
  const requestAnimeDetailsMap = new Map();

  const searchRes = await searchAnime(searchUrl, null, null, requestAnimeDetailsMap);
  const searchData = await searchRes.json();

  if (!searchData.success || !searchData.animes || searchData.animes.length === 0) {
    log("info", "[system] [episodes] No anime found for the given title");
    // 没有结果时，缓存写入失败才是调用方唯一能 actionable 的线索
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: getAddAnimeError(requestAnimeDetailsMap),
      hasMore: false,
      animes: []
    });
  }

  let resultAnimes = [];

  // 分集·详情组装 阶段开始
  markStepActive('分集·详情组装');
  const episodesStartedAt = Date.now();

  // 遍历所有找到的动漫，获取它们的集数信息
  for (const animeItem of searchData.animes) {
    const detailAnime =
      resolveAnimeById(animeItem.bangumiId, requestAnimeDetailsMap, animeItem.source) ||
      resolveAnimeById(animeItem.animeId, requestAnimeDetailsMap, animeItem.source);

    let bangumiData = null;
    if (detailAnime) {
      bangumiData = buildBangumiData(detailAnime, animeItem.bangumiId);
    } else {
      const bangumiUrl = new URL(`/bangumi/${animeItem.bangumiId}`, url.origin);
      const bangumiRes = await getBangumi(bangumiUrl.pathname);
      bangumiData = await bangumiRes.json();
    }

    if (bangumiData.success && bangumiData.bangumi && bangumiData.bangumi.episodes) {
      let filteredEpisodes = bangumiData.bangumi.episodes;

      // 根据 episode 参数过滤集数
      if (episode) {
        if (episode === "movie") {
          // 仅保留剧场版结果
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep =>
            animeItem.typeDescription && (
              animeItem.typeDescription.includes("电影") ||
              animeItem.typeDescription.includes("剧场版") ||
              ep.episodeTitle.toLowerCase().includes("movie") ||
              ep.episodeTitle.includes("剧场版")
            )
          );
        } else if (/^\d+$/.test(episode)) {
          // 纯数字：集标题中的集号唯一命中时按集号匹配，否则按 episodeNumber 字段匹配
          const targetEpisode = parseInt(episode);
          const episodesByTitleNumber = bangumiData.bangumi.episodes.filter(ep =>
            extractEpisodeNumberFromTitle(ep.episodeTitle) === targetEpisode
          );
          filteredEpisodes = episodesByTitleNumber.length === 1
            ? episodesByTitleNumber
            : bangumiData.bangumi.episodes.filter(ep => parseInt(ep.episodeNumber) === targetEpisode);
        }
      }

      // 只有当过滤后还有集数时才添加到结果中
      if (filteredEpisodes.length > 0) {
        resultAnimes.push(Episodes.fromJson({
          animeId: animeItem.animeId,
          animeTitle: animeItem.animeTitle,
          type: animeItem.type,
          typeDescription: animeItem.typeDescription,
          episodes: filteredEpisodes.map(ep => ({
            episodeId: ep.episodeId,
            episodeTitle: ep.episodeTitle,
            url: ep.url || ""
          }))
        }));
      }
    }
  }

  // 命中的集标题让用户直接看到请求的集数对应到哪些平台的哪一集，最多展示 5 条
  const matchedEpisodeTitles = [];
  for (const item of resultAnimes) {
    const title = item.episodes?.[0]?.episodeTitle;
    if (title && !matchedEpisodeTitles.includes(title)) matchedEpisodeTitles.push(title);
    if (matchedEpisodeTitles.length >= 5) break;
  }

  traceStep('分集·详情组装', episodesStartedAt, {
    status: resultAnimes.length === 0 ? 'empty' : 'ok',
    reason: resultAnimes.length === 0
      ? (episode ? `搜索结果中没有包含第 ${episode} 集的剧集` : '未找到匹配的剧集')
      : undefined,
    inputs: { anime, requestedEpisode: episode || '未指定', searchedAnime: searchData.animes.length },
    outputs: {
      animeCount: resultAnimes.length,
      episodeCount: resultAnimes.reduce((sum, a) => sum + (a.episodes?.length || 0), 0),
      matchedEpisodeTitles,
      count: resultAnimes.length,
    },
  });

  log("info", `[system] [episodes] Found ${resultAnimes.length} animes with filtered episodes`);

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: resultAnimes
  });
}

// Extracted function for GET /api/v2/bangumi/:animeId
export async function getBangumi(path, detailStore = null, source = null) {
  const phase = createPhaseTimer();
  markStepActive('详情·剧集定位');
  const idParam = path.split("/").pop();
  const anime =
    resolveAnimeByIdFromDetailStore(idParam, detailStore, source) ||
    resolveAnimeById(idParam);

  phase('详情·剧集定位', {
    status: anime ? 'ok' : 'empty',
    reason: anime ? undefined : '缓存中不存在该剧集，可能已过期或未搜索过',
    inputs: { animeId: idParam, fromRequestStore: Boolean(detailStore) },
    outputs: anime
      ? { animeTitle: anime.animeTitle, sourceKey: anime.source, linkCount: anime.links?.length || 0, count: anime.links?.length || 0 }
      : { count: 0 },
  });

  if (!anime) {
    log("error", `[system] [bangumi] Anime with ID ${idParam} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  markStepActive('详情·响应组装');
  const bangumiData = buildBangumiData(anime, idParam);
  phase('详情·响应组装', {
    status: bangumiData.success === false ? 'empty' : 'ok',
    reason: bangumiData.success === false ? bangumiData.errorMessage : undefined,
    inputs: { animeTitle: anime.animeTitle },
    outputs: { episodeCount: bangumiData.bangumi?.episodes?.length || 0, count: bangumiData.bangumi?.episodes?.length || 0 },
  });
  return jsonResponse(bangumiData);
}

export function buildBangumiData(anime, idParam = "") {
  log("info", `[system] [bangumi] Fetched details for anime ID: ${idParam || anime.bangumiId}`);
  const localSeason = anime.source === 'local' ? (extractSeasonNumberFromAnimeTitle(anime.animeTitle).season ?? 1) : 1;

  // 构建 episodes 列表
  let episodesList = [];
  for (let i = 0; i < anime.links.length; i++) {
    const link = anime.links[i];
    episodesList.push({
      seasonId: `season-${anime.animeId}`,
      episodeId: link.id,
      episodeTitle: `${link.title}`,
      episodeNumber: `${anime.source === 'local' ? (extractEpisodeNumberFromTitle(link.title) ?? i + 1) : i + 1}`,
      airDate: anime.startDate,
      url: link.url || ""
    });
  }

  // 如果启用了集标题过滤，则应用过滤
  if (globals.enableAnimeEpisodeFilter) {
    const episodeTitlesBefore = episodesList.map(episode => episode.episodeTitle);
    const filteredEpisodes = filterEpisodesByTitle(episodesList);
    const keptTitles = new Set(filteredEpisodes.map(episode => episode.episodeTitle));
    const removedEpisodeTitles = episodeTitlesBefore.filter(title => !keptTitles.has(title));
    recordConfigEffect('EPISODE_TITLE_FILTER', {
      label: '集标题过滤',
      hit: removedEpisodeTitles.length > 0,
      before: { episodeCount: episodeTitlesBefore.length },
      after: { episodeCount: filteredEpisodes.length },
      removed: removedEpisodeTitles.map(title => ({ value: title })),
      removedCount: removedEpisodeTitles.length,
      sum: true,
    });
    episodesList = filteredEpisodes;
    log("info", `[system] [getBangumi] Episode filter enabled. Filtered episodes: ${episodesList.length}/${anime.links.length}`);

    // 如果过滤后没有有效剧集，返回错误
    if (episodesList.length === 0) {
      log("warn", `[system] [getBangumi] No valid episodes after filtering for anime ID ${idParam || anime.bangumiId}`);
      return {
        errorCode: 404,
        success: false,
        errorMessage: "No valid episodes after filtering",
        bangumi: null
      };
    }

    // 重新排序episodeNumber
    episodesList = episodesList.map((episode, index) => ({
      ...episode,
      episodeNumber: anime.source === 'local' ? episode.episodeNumber : `${index+1}`
    }));
  }

  const bangumi = Bangumi.fromJson({
    animeId: anime.animeId,
    bangumiId: anime.bangumiId,
    animeTitle: anime.animeTitle,
    imageUrl: anime.imageUrl,
    isOnAir: true,
    airDay: 1,
    isFavorited: anime.isFavorited,
    rating: anime.rating,
    type: anime.type,
    typeDescription: anime.typeDescription,
    seasons: [
      {
        id: `season-${anime.animeId}`,
        airDate: anime.startDate,
        name: `Season ${localSeason}`,
        episodeCount: globals.enableAnimeEpisodeFilter
          ? resolveEpisodeCount(anime.episodeCount, episodesList.length)
          : anime.episodeCount,
      },
    ],
    episodes: episodesList,
  });

  return {
    errorCode: 0,
    success: true,
    errorMessage: "",
    bangumi: bangumi
  };
}

/**
 * 处理聚合源弹幕获取
 * @param {string} url 聚合URL
 * @returns {Promise<Array>} 合并后的弹幕列表
 */
async function fetchMergedComments(url, animeTitle, commentId) {
  const parts = url.split(MERGE_DELIMITER);
  const partMetas = parts.map((part) => {
    const firstColonIndex = part.indexOf(':');
    if (firstColonIndex === -1) {
      return {
        realId: '',
        logicalSource: '',
        sourceLabel: '',
      };
    }

    const sourceName = part.substring(0, firstColonIndex);
    let realId = part.substring(firstColonIndex + 1);
    
    // 提取链接尾部偏移值（@100/@-50 秒数偏移，@%30/@%-11 百分比偏移）
    const linkMeta = stripLinkOffset(realId);
    const manualOffset = linkMeta.offset;
    const manualOffsetPercent = linkMeta.percent;
    realId = linkMeta.cleanUrl;

    if (sourceName !== 'hanjutv') {
      return {
        realId,
        logicalSource: sourceName,
        sourceLabel: sourceName,
        manualOffset,
        manualOffsetPercent,
      };
    }

    return {
      realId,
      logicalSource: 'hanjutv',
      sourceLabel: getHanjutvSourceLabel(realId),
      manualOffset,
      manualOffsetPercent,
    };
  });
  const sourceNames = partMetas.map(meta => meta.logicalSource).filter(Boolean);
  const realIds = partMetas.map(meta => meta.realId);
  const sourceTag = partMetas.map(meta => meta.sourceLabel).filter(Boolean).join('＆');

  log("info", `[merge] 开始获取 [${sourceTag}] 聚合弹幕...`);

  // 1. 检查聚合缓存
  const cached = getCommentCache(resolveCommentCacheKey(url));
  if (cached) {
    log("info", `[merge] 命中缓存 [${sourceTag}]，返回 ${cached.length} 条`);
    return cached;
  }

  const stats = {};
  
  // 2. 构建任务工厂（延迟启动，到分组后再执行）
  const taskFactories = partMetas.map((meta) => {
    return async () => {
    const sourceName = meta.logicalSource;
    const sourceLabel = meta.sourceLabel || meta.logicalSource;
    // 日志标签取源的日志规范名，与请求作用域标签一致
    const sourceLogName = getLogNameByKey(sourceName);
    const realId = meta.realId;

    if (!sourceName || !realId) return [];

    // 构建去重Key
    const pendingKey = `${sourceName}:${realId}`;

    // 检查是否有正在进行的相同请求（请求合并）
    if (PENDING_DANMAKU_REQUESTS.has(pendingKey)) {
        log("info", `[merge] 复用正在进行的请求: ${pendingKey}`);
        try {
            const list = await PENDING_DANMAKU_REQUESTS.get(pendingKey);
            return list || [];
        } catch (e) {
            return [];
        }
    }

    // 定义请求任务
    const fetchTask = sourceLogContext.run(sourceLogName, async () => {
        const sourceInstance = getSourceByKey(sourceName);

        if (sourceInstance) {
          try {
            // b23.tv 短链需要先解析为完整 BV URL
            let resolvedId = realId;
            if (sourceName === 'bilibili' && String(resolvedId).includes('b23.tv')) {
              resolvedId = await bilibiliSource.resolveB23Link(resolvedId);
            }
            // 获取原始数据 -> 格式化
            const raw = await sourceInstance.getEpisodeDanmu(resolvedId, parts);
            let formatted = sourceInstance.formatComments(raw);
            log("info", `[${sourceLogName}] 获取弹幕 ${formatted.length} 条`);
            
            // 应用手动偏移值
            if (meta.manualOffset && formatted && Array.isArray(formatted)) {
              if (meta.manualOffsetPercent) {
                const maxTime = Math.max(...formatted.map(d => parseFloat(String(d.p).split(',')[0]) || 0), 0);
                formatted = applyOffset(formatted, meta.manualOffset, { usePercent: true, videoDuration: maxTime || 1 });
                log("info", `[${sourceLogName}] 应用百分比偏移 ${meta.manualOffset}s (时长=${maxTime}s)`);
              } else {
                formatted = applyOffset(formatted, meta.manualOffset);
                log("info", `[${sourceLogName}] 应用手动偏移 ${meta.manualOffset}s`);
              }
            }
            
            // 给合并工具里的每一条弹幕打上独立的原始源标签
            if (formatted && Array.isArray(formatted)) {
                formatted.forEach(item => {
                    if (!item._sourceLabel) item._sourceLabel = sourceLabel;
                });
            }

            stats[sourceLabel] = formatted.length;
            return formatted;
          } catch (e) {
            log("error", `[merge] 获取 ${sourceLabel} 失败: ${e.message}`);
            stats[sourceLabel] = 0;
            return [];
          }
        }
        return [];
    });

    // 将任务加入队列
    PENDING_DANMAKU_REQUESTS.set(pendingKey, fetchTask);

    try {
        return await fetchTask;
    } finally {
        // 任务完成后移除队列
        PENDING_DANMAKU_REQUESTS.delete(pendingKey);
    }
    };
  });

  // 按平台分组执行：同平台（sourceName 相同）任务串行执行，每个间隔 1 秒，防止短时间内对同一个平台发起多次并发请求触发风控；不同平台仍并行执行。
  // taskFactories 而非直接 map(async) 确保任务在分组后才启动，避免 async 函数同步段在分组前就已执行。
  const sourceGroups = new Map();
  taskFactories.forEach((factory, i) => {
    const src = partMetas[i]?.logicalSource || 'unknown';
    if (!sourceGroups.has(src)) sourceGroups.set(src, []);
    sourceGroups.get(src).push({ factory, index: i });
  });
  const indexedResults = await Promise.all(
    Array.from(sourceGroups.values()).map(async (group) => {
      const items = [];
      for (let j = 0; j < group.length; j++) {
        items.push({ index: group[j].index, data: await group[j].factory() });
        if (j < group.length - 1) await new Promise(r => setTimeout(r, 1000));
      }
      return items;
    })
  );
  const results = indexedResults.flat().sort((a, b) => a.index - b.index).map(x => x.data);
  
  // 调用以dandan为基准的跨源时间轴对齐函数（仅当存在 dandan 源时执行）
  alignSourceTimelines(results, sourceNames, realIds);

  // 按来源分别应用弹幕时间偏移（对齐后、合并前）
  if (globals.danmuOffsetRules?.length > 0 && animeTitle && commentId) {
    const [, , episodeTitle] = findAnimeIdByCommentId(commentId);
    if (episodeTitle) {
      let { baseTitle, fullTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
      season ||= 1;
      episode ||= findIndexById(commentId) + 1;
      const seasonStr = `S${season.toString().padStart(2, '0')}`;
      const episodeStr = `E${episode.toString().padStart(2, '0')}`;
      for (let idx = 0; idx < results.length; idx++) {
        const list = results[idx];
        const sourceName = sourceNames[idx];
        const offsetRule = resolveOffsetRule(globals.danmuOffsetRules, {
          anime: baseTitle,
          fullTitle,
          season: seasonStr,
          episode: episodeStr,
          source: sourceName
        });
        const offset = offsetRule?.offset || 0;
        const videoDuration = offset !== 0 && offsetRule?.usePercent ? await resolveUrlDuration(realIds[idx]) : 0;
        log("info", `[merge] [offset] [${sourceName}] ${fullTitle || baseTitle} ${offsetRule ? `命中偏移规则: ${offsetRule.raw}` : '未命中偏移规则'}`);
        if (offset !== 0) {
          results[idx] = applyOffset(list, offset, {
            usePercent: offsetRule?.usePercent,
            videoDuration
          });
        }
      }
    }
  }

  // 3. 合并数据
  let mergedList = [];
  results.forEach(list => {
    mergedList = mergeDanmakuList(mergedList, list);
  });

  const statDetails = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join(', ');
  log("info", `[merge] 聚合原始数据完成: 总计 ${mergedList.length} 条 (${statDetails})`);

  // 4. 统一处理（去重、过滤、转JSON）
  return convertToDanmakuJson(mergedList, sourceTag);
}

// Extracted function for GET /api/v2/comment/:commentId
export async function getComment(path, queryFormat, segmentFlag, clientIp, includeDuration = false) {
  const phase = createPhaseTimer();
  markStepActive('弹幕·资源定位');
  const commentId = parseInt(path.split("/").pop());
  let animeTitle = findAnimeTitleById(commentId);
  let url = findUrlById(commentId);
  let title = findTitleById(commentId);
  let plat = title ? extractEpisodeTitle(title) : null;
  if (url?.startsWith('local:')) {
    phase('弹幕·资源定位', {
      status: 'ok', reason: '弹幕库 ID 指向本地资源，转由本地弹幕流程处理',
      inputs: { commentId }, outputs: { url: maskCredentialParams(url) },
    });
    return getCommentByUrl(url, queryFormat, segmentFlag, includeDuration);
  }
  phase('弹幕·资源定位', {
    status: url ? 'ok' : 'empty',
    reason: url ? undefined : '该弹幕库 ID 未关联播放地址',
    inputs: { commentId },
    outputs: { animeTitle, episodeTitle: title, sourceKey: plat, url: maskCredentialParams(url) },
  });
  // 分段请求不会用到本地兜底结果，直接跳过这次全量扫描（本地资源多时它是白跑的开销）。
  markStepActive('弹幕·本地弹幕');
  const localResource = segmentFlag ? null : await (async () => {
    try {
      const { findLocalDanmu } = await import('../utils/local-danmu-store.js');
      const [localAnimeId] = findAnimeIdByCommentId(commentId);
      const localAnime = globals.animes.find(a => String(a.animeId) === String(localAnimeId));
      const matchTitle = extractAnimeTitle(animeTitle || '').split('【')[0].trim();
      const seasonSuffix = matchTitle.match(/\s*(?:第\s*[0-9一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+\s*[季期部]|(?:S(?:eason)?|Part)\s*\d+)\s*$/i);
      const season = seasonSuffix ? (extractSeasonNumberFromAnimeTitle(matchTitle).season ?? 1) : 1;
      return findLocalDanmu({
        videoId: String(commentId),
        title: seasonSuffix ? matchTitle.slice(0, seasonSuffix.index).trim() : matchTitle,
        year: extractYear(animeTitle || ''),
        type: localAnime?.typeDescription || localAnime?.type || '',
        season,
        episode: extractEpisodeNumberFromTitle(title || '')
      });
    } catch { return null; }
  })();
  if (localResource && !segmentFlag) {
    const localComments = await localSource.getComments(localResource.resourceKey, 'local');
    phase('弹幕·本地弹幕', {
      status: localComments.length > 0 ? 'hit' : 'empty',
      reason: localComments.length > 0 ? '命中本地弹幕资源，直接返回本地弹幕' : '本地资源无弹幕',
      inputs: { resourceKey: localResource.resourceKey },
      outputs: { count: localComments.length },
    });
    return formatDanmuResponse(buildDanmuResponse({ count: localComments.length, comments: localComments }, null), queryFormat);
  }
  phase('弹幕·本地弹幕', {
    status: segmentFlag ? 'skip' : 'miss',
    reason: segmentFlag ? '分段请求跳过本地弹幕扫描' : '未匹配到本地弹幕资源',
    inputs: { commentId, animeTitle },
    outputs: { found: false },
  });
  const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);
  log("info", "[system] [LogVar-API] comment url...", url);
  log("info", "[system] [LogVar-API] comment title...", title);
  log("info", "[system] [LogVar-API] comment platform...", plat);
  if (!url) {
    log("error", `[system] [LogVar-API] Comment with ID ${commentId} not found`);
    return jsonResponse({ count: 0, comments: [] }, 404);
  }
  log("info", `[system] [LogVar-API] Fetched comment ID: ${commentId}`);

  // 检查弹幕缓存
  markStepActive('弹幕·缓存查询');
  const cacheKey = resolveCommentCacheKey(url);
  const cachedComments = getCommentCache(cacheKey);
  if (cachedComments !== null) {
    let videoDuration = shouldAttachDuration ? await resolveMergedDuration(url) : null;
    if (shouldAttachDuration) {
      const [, cachedSource, cachedEpisodeTitle] = findAnimeIdByCommentId(commentId);
      const { rule, offset } = resolveCommentOffsetRule(animeTitle, cachedEpisodeTitle, commentId, cachedSource);
      videoDuration = offsetDuration(videoDuration, offset, rule?.usePercent === true);
    }
    const responseData = buildDanmuResponse(
      { count: cachedComments.length, comments: cachedComments },
      videoDuration
    );
    recordConfigEffect('COMMENT_CACHE_MINUTES', {
      label: '弹幕缓存', kind: 'stats', hit: true,
      context: { 缓存键: cacheKey, 有效期: `${globals.commentCacheMinutes} 分钟` },
      summary: `命中缓存，直接返回 ${cachedComments.length} 条弹幕`,
    });
    phase('弹幕·缓存查询', {
      status: 'hit', reason: '弹幕缓存命中，直接返回缓存内容',
      inputs: { cacheKey }, outputs: { count: cachedComments.length },
    });
    return formatDanmuResponse(responseData, queryFormat);
  }

  recordConfigEffect('COMMENT_CACHE_MINUTES', {
    label: '弹幕缓存', kind: 'stats', hit: false,
    context: { 缓存键: cacheKey, 有效期: `${globals.commentCacheMinutes} 分钟` },
    summary: '未命中缓存，继续抓取弹幕',
  });
  phase('弹幕·缓存查询', {
    status: 'miss', reason: '弹幕缓存未命中，开始向弹幕源请求',
    inputs: { cacheKey }, outputs: { count: 0 },
  });
  markStepActive('弹幕·抓取与过滤');

  log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
  let danmus = [];
  const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;

  // 提取单链接偏移值（@秒数 / @%百分比）
  const linkMeta = stripLinkOffset(url);
  const singleUrlOffset = linkMeta.offset;
  const singleUrlOffsetPercent = linkMeta.percent;
  const cleanUrl = linkMeta.cleanUrl;
  if (singleUrlOffset !== 0) {
    log("info", `[system] [LogVar-API] 检测到链接${singleUrlOffsetPercent ? '百分比' : ''}偏移: ${singleUrlOffset}s`);
  }

  if (url && url.includes(MERGE_DELIMITER)) {
    danmus = await fetchMergedComments(url, animeTitle, commentId);
  } else {
    const commentUrl = cleanUrl;
    const isHongguoUrl = isHongguoPlayerUrl(commentUrl) || isHongguoSeriesId(commentUrl);

    if (url.includes('.qq.com')) {
      danmus = await sourceLogContext.run('tencent', () => tencentSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.iqiyi.com')) {
      danmus = await sourceLogContext.run('iqiyi', () => iqiyiSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.mgtv.com')) {
      danmus = await sourceLogContext.run('mango', () => mangoSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      let resolvedUrl = commentUrl;
      if (resolvedUrl.includes('b23.tv')) {
        resolvedUrl = await sourceLogContext.run('bilibili', () => bilibiliSource.resolveB23Link(resolvedUrl));
      }
      danmus = await sourceLogContext.run('bilibili', () => bilibiliSource.getComments(resolvedUrl, plat, segmentFlag));
    } else if (url.includes('.youku.com')) {
      danmus = await sourceLogContext.run('youku', () => youkuSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.miguvideo.com')) {
      danmus = await sourceLogContext.run('migu', () => miguSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.sohu.com')) {
      danmus = await sourceLogContext.run('sohu', () => sohuSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.le.com')) {
      danmus = await sourceLogContext.run('leshi', () => leshiSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.douyin.com') || url.includes('.ixigua.com')) {
      danmus = await sourceLogContext.run('xigua', () => xiguaSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.mddcloud.com.cn')) {
      danmus = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getComments(commentUrl, plat, segmentFlag));
    } else if (url.includes('.yfsp.tv')) {
      danmus = await sourceLogContext.run('aiyifan', () => aiyifanSource.getComments(commentUrl, plat, segmentFlag));
    } else if (isHongguoUrl) {
      danmus = await sourceLogContext.run('hongguo', () => hongguoSource.getComments(commentUrl, 'hongguo', segmentFlag));
    } else if (/(?:bgm|bangumi)\.(?:tv|lol)\/ep\/|chii\.in\/ep\//.test(url)) {
      const bgmMatch = commentUrl.match(/(?:bgm\.tv|bangumi\.tv|bangumi\.lol|chii\.in)\/ep\/(\d+)/);
      danmus = await sourceLogContext.run('animeko', () => animekoSource.getComments(bgmMatch ? bgmMatch[1] : commentUrl, plat, segmentFlag));
    } else if (url.includes('ani.gamer.com.tw')) {
      const bahaMatch = commentUrl.match(/sn=(\d+)/);
      danmus = await sourceLogContext.run('bahamut', () => bahamutSource.getComments(bahaMatch ? bahaMatch[1] : commentUrl, plat, segmentFlag));
    }

    // 请求其他平台弹幕
    const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
    if (!urlPattern.test(url) && !isHongguoUrl) {
      // 剥离单源 source:id 前缀（如 bahamut:50709 → 50709），使各源拿到真实 ID，与合并路径分割逻辑一致
      const sourceUrl = sanitizeUrl(commentUrl);
      // plat 值即源调度键名，直接从注册表查实例；未注册则跳过
      const platSource = getSourceByKey(plat);
      if (platSource) {
        danmus = await sourceLogContext.run(plat, () => platSource.getComments(sourceUrl, plat, segmentFlag));
      }
    }

    // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
    if ((!danmus || danmus.length === 0) && urlPattern.test(url)) {
      danmus = await sourceLogContext.run('other', () => otherSource.getComments(url, "other_server", segmentFlag));
    }
  }

  // 本步骤内部完成了屏蔽词、同时间点去重等处理，取各配置记录中最早登记的弹幕条数作为处理前数量，
  // 使诊断链能看到数量变化而不是三步相同
  phase('弹幕·抓取与过滤', {
    status: danmus.length === 0 ? 'empty' : 'ok',
    reason: danmus.length === 0 ? '所有弹幕源均未返回内容' : undefined,
    inputs: { sourceKey: plat || '按链接域名识别', 链接数: String(url || '').split(MERGE_DELIMITER).filter(Boolean).length, segment: segmentFlag },
    outputs: { rawCount: stepEffectsRawDanmuCount(), count: danmus.length },
  });

  // 单链接偏移值应用（合并链接已在 fetchMergedComments 中按来源分别应用，此处仅处理单链接）
  if (!(url && url.includes(MERGE_DELIMITER)) && singleUrlOffset !== 0 && danmus && Array.isArray(danmus) && danmus.length > 0) {
    if (singleUrlOffsetPercent) {
      const maxTime = Math.max(...danmus.map(d => parseFloat(String(d.p).split(',')[0]) || 0), 0);
      danmus = applyOffset(danmus, singleUrlOffset, { usePercent: true, videoDuration: maxTime || 1 });
      log("info", `[system] [LogVar-API] 应用链接百分比偏移 ${singleUrlOffset}s (时长=${maxTime}s)`);
    } else {
      danmus = applyOffset(danmus, singleUrlOffset);
      log("info", `[system] [LogVar-API] 应用链接偏移 ${singleUrlOffset}s`);
    }
  }

  const [animeId, source, episodeTitle, animeAliases] = findAnimeIdByCommentId(commentId);
  if (animeId && source) {
    let lastTitle = null;
    let lastSeason = null;
    let offset = null;
    let lastSearchContext = null;

    if (clientIp && globals.rememberLastSelect) {
      const lastSearch = getLastSearch(clientIp);
      // lastSearch 仅在 Match/Search 时更新，小幻顺播下一集时不刷新。
      // 加 3 分钟 TTL 防止过期 episode 值导致错误偏移（如 E21 时搜的，20 分钟后顺播到 E24 时仍以 E21 为基准记录）。
      if (lastSearch && lastSearch.title
        && lastSearch.season !== null && lastSearch.season !== undefined
        && lastSearch.episode && episodeTitle) {
        if (Date.now() - lastSearch.timestamp < 180000) {
          lastSearchContext = lastSearch;
          const isAutomaticResult = lastSearch.episodeId !== null && lastSearch.episodeId !== undefined &&
            String(lastSearch.episodeId) === String(commentId);
          if (isAutomaticResult) {
            log('info', `[system] [match] Skip preference write for automatically returned episode ${commentId}`);
          } else {
            lastTitle = lastSearch.title;
            lastSeason = lastSearch.season;
            offset = `${lastSearch.episode}:${episodeTitle}`;
            log("info", `[system] [LogVar-API] Calculated episode offset for IP ${clientIp}: Query E${lastSearch.episode}, Selected ${episodeTitle} -> Offset ${offset} (Season ${lastSeason})`);
          }
        }
      }
    }

    log("info", `[system] [LogVar-API] animeTitle：${animeTitle}; lastTitle：${lastTitle}; titleMatches：${titleMatches(animeTitle, lastTitle, null, true)}`);

    // 校验番剧标题或别名是否匹配最新搜索/匹配上下文，别名检查用于兼容不同源对同一番剧的标题命名差异
    // 偏好记录使用非严格匹配（forceNonStrict=true），因为用户手动选择不应受严格标题匹配限制
    const titleOrAliasMatches = titleMatches(animeTitle, lastTitle, null, true) ||
        (Array.isArray(animeAliases) && animeAliases.some(alias => titleMatches(alias, lastTitle, null, true))) ||
        (lastSearchContext?.autoMatchMappingApplied && (
          titleMatches(animeTitle, lastSearchContext.mappingTargetTitle, null, true) ||
          (Array.isArray(animeAliases) && animeAliases.some(alias => titleMatches(alias, lastSearchContext.mappingTargetTitle, null, true)))
        ));

    if (titleOrAliasMatches && lastTitle) {
      if (lastSearchContext?.autoMatchMappingApplied) {
        log("info", `[system] [auto-match-mapping] Saving explicit mapped-result correction for "${lastTitle}" S${lastSeason}`);
        setPreferForTitle(lastTitle, animeId, source, lastSeason, offset);
      } else {
        log("info", `[system] [match] Saving explicit manual preference for "${lastTitle}" S${lastSeason}`);
        setPreferByAnimeId(animeId, source, lastSeason, offset);
      }
    }

    if (globals.localCacheValid && animeId) {
        writeCacheToFile('lastSelectMap', JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
    }
    if (globals.redisValid && animeId) {
        setRedisKey('lastSelectMap', globals.lastSelectMap).catch(e => log("error", "[system] [LogVar-API] Redis set error", e));
    }
    if (globals.localRedisValid && animeId) {
        setLocalRedisKey('lastSelectMap', globals.lastSelectMap);
    }
  }

  // 应用弹幕时间偏移（合并源已在 fetchMergedComments 中按来源分别应用）
  let appliedRuleOffset = 0;
  let appliedRulePercent = false;
  let offsetMatchTitle = '';
  if (animeTitle && episodeTitle && !(url && url.includes(MERGE_DELIMITER))) {
    const { ctx, rule, offset } = resolveCommentOffsetRule(animeTitle, episodeTitle, commentId, source);
    // 记录参与匹配的剧名，未命中时用来说明规则与实际标题对不上
    if (ctx && !rule) offsetMatchTitle = ctx.fullTitle || ctx.anime || '';
    if (ctx) {
      // 无链接偏移时，请求已解析的时长与原始片长一致，直接复用，避免重复拉取分片列表
      const videoDuration = offset !== 0 && rule?.usePercent
        ? (singleUrlOffset === 0 && durationPromise ? await durationPromise : await resolveUrlDuration(cleanUrl))
        : 0;
      log("info", `[system] [offset] ${ctx.fullTitle || ctx.anime} ${rule ? `命中偏移规则: ${rule.raw}` : '未命中偏移规则'}`);
      if (offset !== 0) {
        danmus = applyOffset(danmus, offset, {
          usePercent: rule?.usePercent,
          videoDuration
        });
        appliedRuleOffset = offset;
        appliedRulePercent = rule?.usePercent === true;
      }
    }
  }

  markStepActive('弹幕·偏移处理');
  const offsetMissReason = offsetMatchTitle
    ? '偏移规则未命中，请核对 DANMU_OFFSET 中的剧名是否与实际剧名相符'
    : '未命中偏移规则或偏移量为 0';
  phase('弹幕·偏移处理', {
    status: 'ok',
    reason: appliedRuleOffset !== 0 ? '应用来源偏移规则' : offsetMissReason,
    // 实际剧名放在输入里：管理端可直接查看，非管理端按输入脱敏规则打码，避免从说明文本泄露
    inputs: { linkOffset: singleUrlOffset, ruleOffset: appliedRuleOffset, percent: appliedRulePercent, matchedTitle: offsetMatchTitle || undefined },
    outputs: { count: Array.isArray(danmus) ? danmus.length : 0 },
  });

  // 缓存弹幕结果
  if (!segmentFlag) {
    if (danmus && danmus.comments) danmus = danmus.comments;
    if (!Array.isArray(danmus)) danmus = [];
    if (danmus.length > 0) {
        setCommentCache(cacheKey, danmus);
    }
  }

  let responseDuration = durationPromise ? await durationPromise : null;
  if (responseDuration !== null) {
    responseDuration = offsetDuration(responseDuration, appliedRuleOffset, appliedRulePercent);
  }
  const responseData = buildDanmuResponse(
    { count: danmus.length, comments: danmus },
    responseDuration
  );
  markStepActive('弹幕·响应组装');
  phase('弹幕·响应组装', {
    status: danmus.length === 0 ? 'empty' : 'ok',
    reason: danmus.length === 0 ? '本次请求未返回任何弹幕' : undefined,
    inputs: { format: queryFormat || 'json', segment: segmentFlag },
    outputs: { count: danmus.length, duration: responseDuration },
  });
  return formatDanmuResponse(responseData, queryFormat);
}

// Extracted function for GET /api/v2/comment?url=xxx or /api/v2/extcomment?url=xxx
export async function getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration = false) {
  const phase = createPhaseTimer();
  markStepActive('弹幕·地址解析');
  try {
    // 验证URL参数
    if (!videoUrl || typeof videoUrl !== 'string') {
      log("error", "[system] [LogVar-API] Missing or invalid url parameter");
      phase('弹幕·地址解析', {
        status: 'fail',
        reason: '缺少或无效的 url 参数',
        inputs: { url: maskCredentialParams(videoUrl) },
      });
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    videoUrl = videoUrl.trim();
    if (videoUrl.startsWith('local:')) {
      const key = videoUrl.slice(6);
      if (segmentFlag) {
        const segments = await localSource.getComments(key, 'local', true);
        phase('弹幕·本地弹幕', {
          status: 'hit',
          reason: '本地资源返回分片列表',
          inputs: { url: maskCredentialParams(videoUrl) },
          outputs: { count: segments.segmentList.length },
        });
        return jsonResponse(segments);
      }
      const localComments = await localSource.getComments(key, 'local');
      if (!localComments.length) {
        phase('弹幕·本地弹幕', {
          status: 'miss',
          reason: '本地弹幕不存在',
          inputs: { url: maskCredentialParams(videoUrl) },
        });
        return jsonResponse({ success: false, count: 0, comments: [] }, 404);
      }
      phase('弹幕·本地弹幕', {
        status: 'hit',
        reason: '命中本地弹幕资源',
        inputs: { url: maskCredentialParams(videoUrl) },
        outputs: { count: localComments.length },
      });
      return formatDanmuResponse(buildDanmuResponse({ count: localComments.length, comments: localComments }, null), queryFormat);
    }

    // 验证URL格式
    if (!videoUrl.startsWith('http')) {
      log("error", "[system] [LogVar-API] Invalid url format, must start with http or https");
      phase('弹幕·地址解析', {
        status: 'fail',
        reason: 'url 必须以 http 或 https 开头',
        inputs: { url: maskCredentialParams(videoUrl) },
      });
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Invalid url format, must start with http or https", count: 0, comments: [] },
        400
      );
    }

    log("info", `[system] [LogVar-API] Processing comment request for URL: ${videoUrl}`);

    let url = videoUrl;
    const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);
    // 链接尾部的 @偏移 只接受 @秒数 或 @%秒数；写成 @30% 等会被当作地址的一部分传给源站并导致无结果
    const malformedOffset = /@\d+(?:\.\d+)?%$/.test(url)
      ? '链接偏移格式不支持 @30% 写法，百分比请写成 @%30'
      : '';
    phase('弹幕·地址解析', {
      status: 'ok',
      // 格式错误不改变流程，仅提示原因，避免用户把源站无结果误判为源故障
      reason: malformedOffset || undefined,
      inputs: { url: maskCredentialParams(url), format: queryFormat || 'json', segment: segmentFlag },
      outputs: { 链接数: String(url || '').split(MERGE_DELIMITER).filter(Boolean).length, attachDuration: shouldAttachDuration },
    });
    // 检查弹幕缓存
    markStepActive('弹幕·缓存查询');
    const cacheKey = resolveCommentCacheKey(url);
    const cachedComments = getCommentCache(cacheKey);
    if (cachedComments !== null) {
      const responseData = buildDanmuResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      }, shouldAttachDuration ? await resolveMergedDuration(url) : null);
      recordConfigEffect('COMMENT_CACHE_MINUTES', {
        label: '弹幕缓存', hit: true,
        before: { cacheKey, ttlMinutes: globals.commentCacheMinutes },
        after: { count: cachedComments.length },
      });
      phase('弹幕·缓存查询', {
        status: 'hit', reason: '弹幕缓存命中，直接返回缓存内容',
        inputs: { cacheKey }, outputs: { count: cachedComments.length },
      });
      return formatDanmuResponse(responseData, queryFormat);
    }

    recordConfigEffect('COMMENT_CACHE_MINUTES', {
      label: '弹幕缓存', hit: false,
      before: { cacheKey, ttlMinutes: globals.commentCacheMinutes },
      after: { count: 0 },
    });
    phase('弹幕·缓存查询', {
      status: 'miss', reason: '弹幕缓存未命中，开始向弹幕源请求',
      inputs: { cacheKey }, outputs: { count: 0 },
    });
    markStepActive('弹幕·抓取与过滤');

    log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
    let danmus = [];
    const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;

    // 提取单链接偏移值（@秒数 / @%百分比）
    const linkMeta = stripLinkOffset(url);
    const singleUrlOffset = linkMeta.offset;
    const singleUrlOffsetPercent = linkMeta.percent;
    const cleanUrl = linkMeta.cleanUrl;
    if (singleUrlOffset !== 0) {
      log("info", `[system] [LogVar-API] 检测到链接${singleUrlOffsetPercent ? '百分比' : ''}偏移: ${singleUrlOffset}s`);
    }

    // 根据URL域名判断平台并获取弹幕
    if (url.includes('.qq.com')) {
      danmus = await sourceLogContext.run('tencent', () => tencentSource.getComments(cleanUrl, "qq", segmentFlag));
    } else if (url.includes('.iqiyi.com')) {
      danmus = await sourceLogContext.run('iqiyi', () => iqiyiSource.getComments(cleanUrl, "qiyi", segmentFlag));
    } else if (url.includes('.mgtv.com')) {
      danmus = await sourceLogContext.run('mango', () => mangoSource.getComments(cleanUrl, "imgo", segmentFlag));
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      let resolvedUrl = cleanUrl;
      if (resolvedUrl.includes('b23.tv')) {
        resolvedUrl = await sourceLogContext.run('bilibili', () => bilibiliSource.resolveB23Link(resolvedUrl));
      }
      danmus = await sourceLogContext.run('bilibili', () => bilibiliSource.getComments(resolvedUrl, "bilibili1", segmentFlag));
    } else if (url.includes('.youku.com')) {
      danmus = await sourceLogContext.run('youku', () => youkuSource.getComments(cleanUrl, "youku", segmentFlag));
    } else if (url.includes('.miguvideo.com')) {
      danmus = await sourceLogContext.run('migu', () => miguSource.getComments(cleanUrl, "migu", segmentFlag));
    } else if (url.includes('.sohu.com')) {
      danmus = await sourceLogContext.run('sohu', () => sohuSource.getComments(cleanUrl, "sohu", segmentFlag));
    } else if (url.includes('.le.com')) {
      danmus = await sourceLogContext.run('leshi', () => leshiSource.getComments(cleanUrl, "leshi", segmentFlag));
    } else if (url.includes('.douyin.com') || url.includes('.ixigua.com')) {
      danmus = await sourceLogContext.run('xigua', () => xiguaSource.getComments(cleanUrl, "xigua", segmentFlag));
    } else if (url.includes('.mddcloud.com.cn')) {
      danmus = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getComments(cleanUrl, "maiduidui", segmentFlag));
    } else if (url.includes('.yfsp.tv')) {
      danmus = await sourceLogContext.run('aiyifan', () => aiyifanSource.getComments(cleanUrl, "aiyifan", segmentFlag));
    } else if (isHongguoPlayerUrl(cleanUrl)) {
      danmus = await sourceLogContext.run('hongguo', () => hongguoSource.getComments(cleanUrl, "hongguo", segmentFlag));
    } else {
      // 如果不是已知平台，尝试第三方弹幕服务器
      const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
      if (urlPattern.test(cleanUrl)) {
        danmus = await sourceLogContext.run('other', () => otherSource.getComments(cleanUrl, "other_server", segmentFlag));
      }
    }

    log("info", `[system] [LogVar-API] Successfully fetched ${danmus.length} comments from URL`);

    phase('弹幕·抓取与过滤', {
      status: danmus.length === 0 ? 'empty' : 'ok',
      reason: danmus.length === 0 ? '所有弹幕源均未返回内容' : undefined,
      inputs: { url: maskCredentialParams(cleanUrl), 链接数: String(url || '').split(MERGE_DELIMITER).filter(Boolean).length, segment: segmentFlag },
      outputs: { rawCount: stepEffectsRawDanmuCount(), count: danmus.length, linkOffset: singleUrlOffset, linkOffsetPercent: singleUrlOffsetPercent },
    });

    // 单链接偏移值应用
    if (singleUrlOffset !== 0 && danmus && Array.isArray(danmus) && danmus.length > 0) {
      if (singleUrlOffsetPercent) {
        const maxTime = Math.max(...danmus.map(d => parseFloat(String(d.p).split(',')[0]) || 0), 0);
        danmus = applyOffset(danmus, singleUrlOffset, { usePercent: true, videoDuration: maxTime || 1 });
        log("info", `[system] [LogVar-API] 应用链接百分比偏移 ${singleUrlOffset}s (时长=${maxTime}s)`);
      } else {
        danmus = applyOffset(danmus, singleUrlOffset);
        log("info", `[system] [LogVar-API] 应用链接偏移 ${singleUrlOffset}s`);
      }
    }

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(cacheKey, danmus);
    }

    const responseData = buildDanmuResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    }, durationPromise ? await durationPromise : null);
    markStepActive('弹幕·响应组装');
    phase('弹幕·响应组装', {
      status: danmus.length === 0 ? 'empty' : 'ok',
      reason: danmus.length === 0 ? '本次请求未返回任何弹幕' : undefined,
      inputs: { format: queryFormat || 'json' },
      outputs: { count: danmus.length },
    });
    return formatDanmuResponse(responseData, queryFormat);
  } catch (error) {
    // 处理异常
    log("error", `[system] [LogVar-API] Failed to process comment by URL request: ${error.message}`);
    phase('弹幕·处理异常', {
      status: 'fail',
      reason: '弹幕地址处理失败',
      error: error.message,
    });
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}

// Extracted function for GET /api/v2/segmentcomment
export async function getSegmentComment(segment, queryFormat) {
  const phase = createPhaseTimer();
  markStepActive('分段弹幕·请求解析');
  try {
    let url = segment.url;
    let platform = segment.type;

    // 验证URL参数
    if (!url || typeof url !== 'string') {
      log("error", "[system] [segmentcomment] Missing or invalid url parameter");
      phase('分段弹幕·请求解析', {
        status: 'fail',
        reason: '缺少或无效的 url 参数',
        inputs: { url: maskCredentialParams(url), platform },
      });
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    url = url.trim();

    log("info", `[system] [segmentcomment] Processing segment comment request for URL: ${url}`);

    phase('分段弹幕·请求解析', {
      status: 'ok',
      inputs: { url: maskCredentialParams(url), platform, segmentStart: segment.segment_start, segmentEnd: segment.segment_end },
      outputs: { format: queryFormat || 'json' },
    });

    // 检查弹幕缓存
    markStepActive('分段弹幕·缓存查询');
    const cacheKey = resolveCommentCacheKey(url);
    const cachedComments = getCommentCache(cacheKey);
    if (cachedComments !== null) {
      const responseData = {
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      };
      phase('分段弹幕·缓存查询', {
        status: 'hit', reason: '分段弹幕缓存命中',
        inputs: { cacheKey }, outputs: { count: cachedComments.length },
      });
      return formatDanmuResponse(responseData, queryFormat);
    }

    phase('分段弹幕·缓存查询', {
      status: 'miss', reason: '分段弹幕缓存未命中，开始向弹幕源请求',
      inputs: { cacheKey }, outputs: { count: 0 },
    });
    markStepActive('分段弹幕·抓取与过滤');

    log("info", `[system] [segmentcomment] 开始从本地请求分段弹幕... URL: ${url}`);
    let danmus = [];

    // 根据平台调用相应的分段弹幕获取方法
    if (platform === "qq") {
      danmus = await sourceLogContext.run('tencent', () => tencentSource.getSegmentComments(segment));
    } else if (platform === "qiyi") {
      danmus = await sourceLogContext.run('iqiyi', () => iqiyiSource.getSegmentComments(segment));
    } else if (platform === "imgo") {
      danmus = await sourceLogContext.run('mango', () => mangoSource.getSegmentComments(segment));
    } else if (platform === "bilibili1") {
      danmus = await sourceLogContext.run('bilibili', () => bilibiliSource.getSegmentComments(segment));
    } else if (platform === "youku") {
      danmus = await sourceLogContext.run('youku', () => youkuSource.getSegmentComments(segment));
    } else if (platform === "migu") {
      danmus = await sourceLogContext.run('migu', () => miguSource.getSegmentComments(segment));
    } else if (platform === "sohu") {
      danmus = await sourceLogContext.run('sohu', () => sohuSource.getSegmentComments(segment));
    } else if (platform === "leshi") {
      danmus = await sourceLogContext.run('leshi', () => leshiSource.getSegmentComments(segment));
    } else if (platform === "xigua") {
      danmus = await sourceLogContext.run('xigua', () => xiguaSource.getSegmentComments(segment));
    } else if (platform === "maiduidui") {
      danmus = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getSegmentComments(segment));
    } else if (platform === "aiyifan") {
      danmus = await sourceLogContext.run('aiyifan', () => aiyifanSource.getSegmentComments(segment));
    } else if (platform === "hongguo") {
      danmus = await sourceLogContext.run('hongguo', () => hongguoSource.getSegmentComments(segment));
    } else if (platform === "hanjutv") {
      danmus = await sourceLogContext.run('hanjutv', () => hanjutvSource.getSegmentComments(segment));
    } else if (platform === "bahamut") {
      danmus = await sourceLogContext.run('bahamut', () => bahamutSource.getSegmentComments(segment));
    } else if (platform === "renren") {
      danmus = await sourceLogContext.run('renren', () => renrenSource.getSegmentComments(segment));
    } else if (platform === "dandan") {
      danmus = await sourceLogContext.run('dandan', () => dandanSource.getSegmentComments(segment));
    } else if (platform === "animeko") {
      danmus = await sourceLogContext.run('animeko', () => animekoSource.getSegmentComments(segment));
    } else if (platform === "custom") {
      danmus = await sourceLogContext.run('custom', () => customSource.getSegmentComments(segment));
    } else if (platform === "local") {
      danmus = await sourceLogContext.run('local', () => localSource.getSegmentComments(segment));
    } else if (platform === "other_server") {
      danmus = await sourceLogContext.run('other', () => otherSource.getSegmentComments(segment));
    }

    log("info", `[system] [segmentcomment] Successfully fetched ${danmus.length} segment comments from URL`);

    phase('分段弹幕·抓取与过滤', {
      status: danmus.length === 0 ? 'empty' : 'ok',
      reason: danmus.length === 0 ? '该平台未返回分段弹幕' : undefined,
      inputs: { platform, url: maskCredentialParams(url) },
      outputs: { count: danmus.length },
    });

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(cacheKey, danmus);
    }

    const responseData = {
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    };
    markStepActive('分段弹幕·响应组装');
    phase('分段弹幕·响应组装', {
      status: danmus.length === 0 ? 'empty' : 'ok',
      inputs: { format: queryFormat || 'json' },
      outputs: { count: danmus.length },
    });
    return formatDanmuResponse(responseData, queryFormat);
  } catch (error) {
    // 处理异常
    log("error", `[system] [segmentcomment] Failed to process segment comment request: ${error.message}`);
    phase('分段弹幕·处理异常', {
      status: 'fail',
      reason: '分段弹幕处理失败',
      error: error.message,
    });
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}
