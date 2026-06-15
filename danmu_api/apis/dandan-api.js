import { globals } from '../configs/globals.js';
import { getPageTitle, jsonResponse, httpGet, sourceLogContext, toLogSourceName } from '../utils/http-util.js';
import { log } from '../utils/log-util.js'
import { simplized } from '../utils/zh-util.js';
import { setRedisKey, updateRedisCaches } from "../utils/redis-util.js";
import { setLocalRedisKey, updateLocalRedisCaches } from "../utils/local-redis-util.js";
import {
    setCommentCache, addAnime, findAnimeIdByCommentId, findTitleById, findUrlById, getCommentCache, getPreferAnimeId,
    getSearchCache, removeEarliestAnime, resolveAnimeById, resolveAnimeByIdFromDetailStore, setPreferByAnimeId, setSearchCache, storeAnimeIdsToMap, writeCacheToFile,
    updateLocalCaches, setLastSearch, getLastSearch, findAnimeTitleById, findIndexById
} from "../utils/cache-util.js";
import { formatDanmuResponse, convertToDanmakuJson } from "../utils/danmu-util.js";
import { resolveOffset, resolveOffsetRule, applyOffset } from "../utils/offset-util.js";
import { 
  extractEpisodeTitle, convertChineseNumber, parseFileName, createDynamicPlatformOrder, normalizeSpaces, 
  extractYear, titleMatches, extractAnimeInfo, extractEpisodeNumberFromTitle, extractSeasonNumberFromAnimeTitle, extractAnimeTitle
} from "../utils/common-util.js";
import { getTMDBChineseTitle } from "../utils/tmdb-util.js";
import { applyMergeLogic, mergeDanmakuList, MERGE_DELIMITER, alignSourceTimelines } from "../utils/merge-util.js";
import { getHanjutvSourceLabel } from "../utils/hanjutv-util.js";
import AIClient from '../utils/ai-util.js';
import Kan360Source from "../sources/kan360.js";
import VodSource from "../sources/vod.js";
import TmdbSource from "../sources/tmdb.js";
import DoubanSource from "../sources/douban.js";
import RenrenSource from "../sources/renren.js";
import HanjutvSource from "../sources/hanjutv.js";
import BahamutSource from "../sources/bahamut.js";
import DandanSource from "../sources/dandan.js";
import CustomSource from "../sources/custom.js";
import TencentSource from "../sources/tencent.js";
import IqiyiSource from "../sources/iqiyi.js";
import MangoSource from "../sources/mango.js";
import BilibiliSource from "../sources/bilibili.js";
import MiguSource from "../sources/migu.js";
import YoukuSource from "../sources/youku.js";
import SohuSource from "../sources/sohu.js";
import LeshiSource from "../sources/leshi.js";
import XiguaSource from "../sources/xigua.js";
import MaiduiduiSource from "../sources/maiduidui.js";
import AiyifanSource from "../sources/aiyifan.js";
import AnimekoSource from "../sources/animeko.js";
import OtherSource from "../sources/other.js";
import { Anime, AnimeMatch, Episodes, Bangumi } from "../models/dandan-model.js";

// =====================
// 兼容弹弹play接口
// =====================

const kan360Source = new Kan360Source();
const vodSource = new VodSource();
const renrenSource = new RenrenSource();
const hanjutvSource = new HanjutvSource();
const bahamutSource = new BahamutSource();
const dandanSource = new DandanSource();
const customSource = new CustomSource();
const tencentSource = new TencentSource();
const youkuSource = new YoukuSource();
const iqiyiSource = new IqiyiSource();
const mangoSource = new MangoSource();
const bilibiliSource = new BilibiliSource();
const miguSource = new MiguSource();
const sohuSource = new SohuSource();
const leshiSource = new LeshiSource();
const xiguaSource = new XiguaSource();
const maiduiduiSource = new MaiduiduiSource();
const aiyifanSource = new AiyifanSource();
const animekoSource = new AnimekoSource();
const otherSource = new OtherSource();
const doubanSource = new DoubanSource(tencentSource, iqiyiSource, youkuSource, bilibiliSource, miguSource);
const tmdbSource = new TmdbSource(doubanSource);

// 用于聚合请求的去重Map
const PENDING_DANMAKU_REQUESTS = new Map();

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
    log('warn', `[system] [Duration] 获取时长失败: ${error.message}`);
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
    const targetUrls = url.includes(MERGE_DELIMITER) ? extractMergedUrls(url) : [url];
    const durations = await Promise.all(targetUrls.map(resolveUrlDuration));
    return durations.reduce((maxValue, currentValue) => Math.max(maxValue, currentValue || 0), 0);
  } catch (error) {
    log('warn', `[system] [Duration] 获取时长失败: ${error.message}`);
    return 0;
  }
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

export function matchSeason(anime, queryTitle, season) {
  // 先从原始带括号的标题中分离出名称主体再对主体进行净化剥离非法字符
  const match = anime.animeTitle.match(/^(.*?)\(\d{4}\)/);
  const originalTitle = match ? match[1].trim() : anime.animeTitle.split("(")[0].trim();
  const normalizedAnimeTitle = normalizeSpaces(originalTitle);
  const normalizedQueryTitle = normalizeSpaces(queryTitle);

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
function checkEpisodeSatisfied(animesList, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform) {
  if (queryEpisode === null || querySeason === null) return true;

  let targetPlatforms = [];
  if (targetPlatform) {
    targetPlatforms = targetPlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  }

  if (targetPlatforms.length === 0) {
    targetPlatforms = ['_any_'];
  }

  let allSatisfied = true;

  for (const tPlat of targetPlatforms) {
    let isEpisodeSatisfied = false;
    const seasonCapacities = new Map();
    let platformHasData = false;

    for (const anime of animesList) {
      const actualPlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;

      if (tPlat !== '_any_' && getPlatformMatchScore(actualPlatform, tPlat) === 0) {
        continue;
      }

      platformHasData = true;

      const bData = getBangumiDataForMatch(anime, requestAnimeDetailsMap);
      if (bData?.success && bData.bangumi?.episodes) {
        const validEps = bData.bangumi.episodes.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle));
        const filtered = filterSameEpisodeTitle(validEps);

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

    if (!isEpisodeSatisfied) {
      let totalValidEpisodes = 0;
      for (const capacity of seasonCapacities.values()) {
        totalValidEpisodes += capacity;
      }
      if (totalValidEpisodes < queryEpisode) {
        allSatisfied = false;
        break;
      }
    }
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
  const {
    vod: animesVodResults, 360: animes360, tmdb: animesTmdb, douban: animesDouban, renren: animesRenren,
    hanjutv: animesHanjutv, bahamut: animesBahamut, dandan: animesDandan, custom: animesCustom,
    tencent: animesTencent, youku: animesYouku, iqiyi: animesIqiyi, imgo: animesImgo, bilibili: animesBilibili,
    migu: animesMigu, sohu: animesSohu, leshi: animesLeshi, xigua: animesXigua, maiduidui: animesMaiduidui,
    aiyifan: animesAiyifan, animeko: animesAnimeko
  } = resultData;

  // 仅处理resultData中存在数据的源，避免将undefined传入handleAnimes
  const activeSourceKeys = globals.sourceOrderArr.filter(key => resultData[key] !== undefined);
  const sourceTasks = [];

  for (const key of activeSourceKeys) {
    const isolatedAnimes = [];
    const isolatedDetailStore = new Map();

    if (key === '360') {
      // 处理360来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(toLogSourceName(key), () => kan360Source.handleAnimes(animes360, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'vod') {
      // 处理Vod来源（遍历所有VOD服务器的结果，依次在同一隔离容器中处理）
      if (animesVodResults && Array.isArray(animesVodResults)) {
        const vodPromise = sourceLogContext.run(key, () => (async () => {
          for (const vodResult of animesVodResults) {
            if (vodResult && vodResult.list && vodResult.list.length > 0) {
              await vodSource.handleAnimes(vodResult.list, queryTitle, isolatedAnimes, vodResult.serverName, isolatedDetailStore, targetSeason);
            }
          }
        })());
        sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: vodPromise });
      }
    } else if (key === 'tmdb') {
      // 处理TMDB来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => tmdbSource.handleAnimes(animesTmdb, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'douban') {
      // 处理Douban来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => doubanSource.handleAnimes(animesDouban, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'renren') {
      // 处理Renren来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => renrenSource.handleAnimes(animesRenren, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'hanjutv') {
      // 处理Hanjutv来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => hanjutvSource.handleAnimes(animesHanjutv, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'bahamut') {
      // 处理Bahamut来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => bahamutSource.handleAnimes(animesBahamut, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'dandan') {
      // 处理弹弹play来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => dandanSource.handleAnimes(animesDandan, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'custom') {
      // 处理自定义弹幕源来源（handleAnimes签名不含detailStore和querySeason）
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => customSource.handleAnimes(animesCustom, queryTitle, isolatedAnimes)) });
    } else if (key === 'tencent') {
      // 处理Tencent来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => tencentSource.handleAnimes(animesTencent, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'youku') {
      // 处理Youku来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => youkuSource.handleAnimes(animesYouku, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'iqiyi') {
      // 处理iQiyi来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => iqiyiSource.handleAnimes(animesIqiyi, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'imgo') {
      // 处理Mango来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(toLogSourceName(key), () => mangoSource.handleAnimes(animesImgo, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'bilibili') {
      // 处理Bilibili来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => bilibiliSource.handleAnimes(animesBilibili, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'migu') {
      // 处理Migu来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => miguSource.handleAnimes(animesMigu, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'sohu') {
      // 处理Sohu来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => sohuSource.handleAnimes(animesSohu, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'leshi') {
      // 处理Leshi来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => leshiSource.handleAnimes(animesLeshi, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'xigua') {
      // 处理Xigua来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => xiguaSource.handleAnimes(animesXigua, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'maiduidui') {
      // 处理Maiduidui来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => maiduiduiSource.handleAnimes(animesMaiduidui, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'aiyifan') {
      // 处理Aiyifan来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => aiyifanSource.handleAnimes(animesAiyifan, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    } else if (key === 'animeko') {
      // 处理Animeko来源
      sourceTasks.push({ key, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: sourceLogContext.run(key, () => animekoSource.handleAnimes(animesAnimeko, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)) });
    }
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
  }
}

// Extracted function for GET /api/v2/search/anime
export async function searchAnime(url, preferAnimeId = null, preferSource = null, detailStore = null, targetPlatform = null) {
  let queryTitle = url.searchParams.get("keyword");
  let querySeason = url.searchParams.get("season");
  querySeason = querySeason ? parseInt(querySeason, 10) : null;
  let queryEpisode = url.searchParams.get("episode");
  queryEpisode = queryEpisode ? parseInt(queryEpisode, 10) : null;
  log("info", `[system] [searchAnime] Search anime with keyword: ${queryTitle}, target season: ${querySeason}, target episode: ${queryEpisode}`);

  // 关键字为空直接返回，不用多余查询
  if (queryTitle === "") {
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
    queryTitle = simplifiedTitle;
  }

  const requestAnimeDetailsMap = detailStore instanceof Map ? detailStore : new Map();
  const cacheKey = querySeason !== null ? `${queryTitle}_S${querySeason}` : queryTitle;

  // 检查搜索缓存
  let cachedResults = getSearchCache(cacheKey, requestAnimeDetailsMap);

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
      return jsonResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        animes: cachedResults,
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
        return jsonResponse({
          errorCode: 0,
          success: true,
          errorMessage: "",
          animes: combinedCachedResults,
        });
      }
      log("info", `[system] [LogVar-API] Episode ${queryEpisode} not satisfied in cache. Proceeding to network search.`);
    }
  }

  const curAnimes = [];

  // 链接弹幕解析
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
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
    } else if (queryTitle.includes(".bilibili.com")) {
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
    }

    // 将源标识符统一映射到日志标签规范名称
    const pageTitle = await sourceLogContext.run(toLogSourceName(platform), () => getPageTitle(queryTitle));

    const links = [{
      "name": "手动解析链接弹幕",
      "url": queryTitle,
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

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: responseAnimes,
    });
  }

  try {
    // 根据 sourceOrderArr 动态构建逐源管道：每个源形成独立的 search → handleAnimes 流水线
    log("info", `[system] [LogVar-API] Search sourceOrderArr: ${globals.sourceOrderArr}`);

    // 存储各源搜索结果的容器，供S2+季度扩展逻辑读取
    const resultData = {};

    // 源Key到对应搜索Promise的映射
    const sourceSearchMap = {};
    for (const source of globals.sourceOrderArr) {
      if (source === "360") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => kan360Source.search(queryTitle));
      else if (source === "vod") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => vodSource.search(queryTitle, preferAnimeId, preferSource));
      else if (source === "tmdb") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => tmdbSource.search(queryTitle));
      else if (source === "douban") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => doubanSource.search(queryTitle));
      else if (source === "renren") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => renrenSource.search(queryTitle));
      else if (source === "hanjutv") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => hanjutvSource.search(queryTitle));
      else if (source === "bahamut") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => bahamutSource.search(queryTitle));
      else if (source === "dandan") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => dandanSource.search(queryTitle));
      else if (source === "custom") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => customSource.search(queryTitle));
      else if (source === "tencent") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => tencentSource.search(queryTitle));
      else if (source === "youku") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => youkuSource.search(queryTitle));
      else if (source === "iqiyi") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => iqiyiSource.search(queryTitle));
      else if (source === "imgo") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => mangoSource.search(queryTitle));
      else if (source === "bilibili") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => bilibiliSource.search(queryTitle));
      else if (source === "migu") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => miguSource.search(queryTitle));
      else if (source === "sohu") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => sohuSource.search(queryTitle));
      else if (source === "leshi") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => leshiSource.search(queryTitle));
      else if (source === "xigua") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => xiguaSource.search(queryTitle));
      else if (source === "maiduidui") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => maiduiduiSource.search(queryTitle));
      else if (source === "aiyifan") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => aiyifanSource.search(queryTitle));
      else if (source === "animeko") sourceSearchMap[source] = sourceLogContext.run(toLogSourceName(source), () => animekoSource.search(queryTitle));
    }

    // 构建逐源管道：每个源 search 完成后，通过 executeSourceHandlers 处理 handleAnimes
    // 传入仅含当前源数据的 resultData，使 executeSourceHandlers 仅处理该源
    const pipelineTasks = globals.sourceOrderArr.map(source => {
      const isolatedAnimes = [];
      const isolatedDetailStore = new Map();
      const pipelinePromise = sourceSearchMap[source].then(async searchResult => {
        resultData[source] = searchResult;
        await executeSourceHandlers({ [source]: searchResult }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource);
      });
      return { key: source, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: pipelinePromise };
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
    }

    // 缓存首季/默认请求结果，剥离附加链接
    if (curAnimes.length > 0) {
      setSearchCache(cacheKey, curAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
    }

    // 判断当前获取的季度是否已包含用户指定的集数
    const isEpisodeSatisfied = checkEpisodeSatisfied(curAnimes, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform);

    // 若未包含且用户指定了季度，推导最大季并并行映射 S2、S3 等结果，合并同一次搜索下的后续季以辅助跨季匹配
    if (!isEpisodeSatisfied && querySeason !== null) {
      let maxSeason = querySeason;
      for (const source of globals.sourceOrderArr) {
        const rawAnimes = resultData[source];
        if (Array.isArray(rawAnimes)) {
          for (const item of rawAnimes) {
            const list = (item && Array.isArray(item.list)) ? item.list : [item];
            for (const a of list) {
              if (!a) continue;
              const s = extractSeasonNumberFromAnimeTitle(a.animeTitle || a.title || "").season;
              if (s !== null && s > maxSeason) maxSeason = s;
            }
          }
        }
      }

      if (maxSeason > querySeason) {
        log("info", `[system] [LogVar-API] Episode ${queryEpisode} not satisfied in Season ${querySeason}. Parallel mapping to S${querySeason + 1}~S${maxSeason}...`);
        const expandPromises = [];
        for (let s = querySeason + 1; s <= maxSeason; s++) {
          expandPromises.push((async () => {
            const seasonAnimes = [];
            await executeSourceHandlers(resultData, queryTitle, seasonAnimes, requestAnimeDetailsMap, s, preferAnimeId, preferSource);
            // 缓存额外季度的结果
            if (seasonAnimes.length > 0) {
              setSearchCache(`${queryTitle}_S${s}`, seasonAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
            }
            return seasonAnimes;
          })());
        }
        const expandedResults = await Promise.all(expandPromises);
        for (const res of expandedResults) {
          curAnimes.push(...res);
        }
      }
    }
  } catch (error) {
    log("error", "[system] [LogVar-API] 发生错误:", error);
  }

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
    for (const anime of curAnimes) {
      // 首先检查剧名是否包含过滤关键词
      const animeTitle = anime.animeTitle || '';
      if (globals.animeTitleFilter && globals.animeTitleFilter.test(animeTitle)) {
        log("info", `[searchAnime] Anime ${anime.animeId} filtered by name: ${animeTitle}`);
        continue; // 跳过该动漫
      }

      const animeData =
        resolveAnimeByIdFromDetailStore(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
        resolveAnimeByIdFromDetailStore(anime?.animeId, requestAnimeDetailsMap, anime?.source) ||
        resolveAnimeById(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
        resolveAnimeById(anime?.animeId, requestAnimeDetailsMap, anime?.source);
      if (animeData && animeData.links) {
        let episodesList = animeData.links.map((link, index) => ({
          episodeId: link.id,
          episodeTitle: link.title,
          episodeNumber: index + 1
        }));

        // 应用过滤
        episodesList = episodesList.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });

        log("info", `[searchAnime] Anime ${anime.animeId} filtered episodes: ${episodesList.length}/${animeData.links.length}`);

        // 只有当过滤后还有有效剧集时才保留该动漫
        if (episodesList.length > 0) {
          validAnimes.push(anime);
        }
      }
    }
    // 用过滤后的动漫列表替换原列表
    curAnimes.length = 0;
    curAnimes.push(...validAnimes);
  }

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

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: responseAnimes,
    });

}

export function filterSameEpisodeTitle(filteredTmpEpisodes) {
    const filteredEpisodes = filteredTmpEpisodes.filter((episode, index, episodes) => {
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            return prevEpisode.episodeTitle === episode.episodeTitle;
        });
    });
    return filteredEpisodes;
}

/**
 * 计算平台匹配得分 (新增函数 - 用于支持合并源模糊匹配和杂质过滤)
 * @param {string} candidatePlatform 候选平台字符串 (e.g., "bilibili&dandan")
 * @param {string} targetPlatform 目标配置字符串 (e.g., "bilibili1&dandan")
 * @returns {number} 得分：越高越好，0表示不匹配
 */
function getPlatformMatchScore(candidatePlatform, targetPlatform) {
  if (!candidatePlatform || !targetPlatform) return 0;
  
  // 预处理：按 & 分割，转小写，去空格
  const cParts = candidatePlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  const tParts = targetPlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  
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
    const match = title.match(/from\s+([a-zA-Z0-9&]+)/i);
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
      log("info", `Found episode by title number: ${ep.episodeTitle} (extracted: ${extractedNumber})`);
      return ep;
    }
  }

  // 策略2：使用数组索引
  if (platformEpisodes.length >= targetEpisode) {
    const fallbackEp = platformEpisodes[targetEpisode - 1];
    log("info", `Using fallback array index for episode ${targetEpisode}: ${fallbackEp.episodeTitle}`);
    return fallbackEp;
  }
  
  // 策略3：使用episodeNumber字段匹配
  for (const ep of platformEpisodes) {
    if (ep.episodeNumber && parseInt(ep.episodeNumber, 10) === targetEpisode) {
      log("info", `Found episode by episodeNumber: ${ep.episodeTitle} (episodeNumber: ${ep.episodeNumber})`);
      return ep;
    }
  }
  
  return null;
}

async function matchAniAndEpByAi(season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, detailStore = null) {
  const aiBaseUrl = globals.aiBaseUrl;
  const aiModel = globals.aiModel;
  const aiApiKey = globals.aiApiKey;
  const aiMatchPrompt = globals.aiMatchPrompt;

  if (!globals.aiValid || !aiMatchPrompt) {
    log("warn", "AI configuration is incomplete, falling back to normal matching");
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

    const aiResponse = await aiClient.ask(userPrompt);
    // const aiResponse = '{ "animeIndex": 0 }';
    log("info", `AI match response: ${aiResponse}`);

    let parsedResponse;
    try {
      const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```|```([\s\S]*?)\s*```|({[\s\S]*})/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2] || jsonMatch[3]) : aiResponse;
      parsedResponse = JSON.parse(jsonString.trim());
    } catch (parseError) {
      log("error", `Failed to parse AI response: ${parseError.message}`);
      return { resEpisode: null, resAnime: null };
    }

    const animeIndex = parsedResponse.animeIndex;

    if (animeIndex === null || animeIndex === undefined) {
      return { resEpisode: null, resAnime: null };
    }

    const selectedAnime = searchData.animes[animeIndex];
    if (!selectedAnime) {
      log("error", `AI returned invalid anime index: ${animeIndex}`);
      return { resEpisode: null, resAnime: null };
    }

    const bangumiData = getBangumiDataForMatch(selectedAnime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      return { resEpisode: null, resAnime: null };
    }

    let filteredEpisode = null;
    
    if (season && episode) {
        // 剧集模式逻辑
        const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);
        
        log("info", "过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        // 匹配集数 (注意：findEpisodeByNumber 已增强支持模糊平台匹配)
        filteredEpisode = findEpisodeByNumber(filteredEpisodes, episode, episode);
    } else {
        // 电影模式逻辑
        if (bangumiData.bangumi.episodes.length > 0) {
          filteredEpisode = bangumiData.bangumi.episodes[0];
        }
    }

    return { resEpisode: filteredEpisode, resAnime: selectedAnime };
  } catch (error) {
    log("error", `AI matching failed: ${error.message}`);
    return { resEpisode: null, resAnime: null };
  }
}

export function getBangumiDataForMatch(anime, detailStore = null) {
  const detailAnime =
    resolveAnimeByIdFromDetailStore(anime?.bangumiId, detailStore, anime?.source) ||
    resolveAnimeByIdFromDetailStore(anime?.animeId, detailStore, anime?.source);

  if (!detailAnime) {
    log("warn", `[matchAnime] Missing request detail snapshot for anime ${anime?.animeId ?? anime?.bangumiId}`);
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
    log("info", `Applying offset "${offsets[seasonKey]}" for S${season}E${episode} -> ${targetEpisode}`);
  }
  return targetEpisode;
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

  log("info", `[Spillover] 当前季集匹配策略失败 (S${season}E${episode})，正在进行跨季集数映射匹配...`);
  const normalizedTitle = normalizeSpaces(title);
  const seasonMap = new Map();

  for (const anime of searchData.animes) {
    const candidateTitles = [anime.animeTitle];
    if (anime.aliases && Array.isArray(anime.aliases)) candidateTitles.push(...anime.aliases);

    let isBaseMatch = false;
    for (const candTitle of candidateTitles) {
      if (!candTitle) continue;
      if (normalizeSpaces(candTitle).includes(normalizedTitle)) {
        if (!matchYear(anime, year)) continue;
        isBaseMatch = true;
        break;
      }
    }
    if (!isBaseMatch) continue;

    let sNum = null;
    for (const candTitle of candidateTitles) {
      if (!candTitle) continue;
      const s = extractSeasonNumberFromAnimeTitle(candTitle).season;
      if (s !== null) { sNum = s; break; }
    }
    if (sNum === null) sNum = 1;

    if (!seasonMap.has(sNum)) {
      const bangumiData = getBangumiDataForMatch(anime, detailStore);
      if (bangumiData?.success && bangumiData?.bangumi?.episodes) {
        const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle));
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);

        if (filteredEpisodes.length > 0) {
          seasonMap.set(sNum, {
            anime: anime,
            episodes: filteredEpisodes,
            actualPlatform: extractPlatformFromTitle(anime.animeTitle) || anime.source
          });
        }
      }
    }
  }

  let currentTargetEpisode = episode;
  let currentSeason = season;
  let bestRes = { anime: null, episode: null, score: 0 };

  while (seasonMap.has(currentSeason)) {
    const seasonData = seasonMap.get(currentSeason);
    const allEps = seasonData.episodes;

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
          break;
      }
      log("info", `[Spillover] 跨季溢出查找命中 (按绝对标题数字) -> 所在季：S${currentSeason} 集标题：${absoluteMatch.episodeTitle}`);
      bestRes = {
        anime: seasonData.anime,
        episode: absoluteMatch,
        score: platform ? getPlatformMatchScore(seasonData.actualPlatform, platform) : 1
      };
      break;
    }

    if (currentTargetEpisode <= allEps.length) {
      const targetEp = allEps[currentTargetEpisode - 1];
      if (platform && getPlatformMatchScore(extractEpisodeTitle(targetEp.episodeTitle), platform) === 0) {
          break;
      }
      log("info", `[Spillover] 跨季溢出查找命中 (按相对排位计算) -> 所在季：S${currentSeason} 集标题：${targetEp.episodeTitle}`);
      bestRes = {
        anime: seasonData.anime,
        episode: targetEp,
        score: platform ? getPlatformMatchScore(seasonData.actualPlatform, platform) : 1
      };
      break;
    }

    log("info", `[Spillover] S${currentSeason} 共有 ${allEps.length} 集(已过滤番外)，剩余目标集数为 ${currentTargetEpisode}，映射至 S${currentSeason + 1} 继续查找`);
    currentTargetEpisode -= allEps.length;
    currentSeason++;
  }

  return { resEpisode: bestRes.episode, resAnime: bestRes.anime };
}

async function matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore = null) {
  // 定义最佳匹配结果容器
  let bestRes = {
    anime: null,
    episode: null,
    score: -9999 // 初始分数为极低值
  };

  const normalizedTitle = normalizeSpaces(title);

  // 遍历所有搜索结果，寻找最佳匹配
  for (const anime of searchData.animes) {
    // 偏好过滤
    const animeIsNotPrefer = 
        globals.rememberLastSelect && 
        preferAnimeId && 
        String(anime.bangumiId) !== String(preferAnimeId) && 
        String(anime.animeId) !== String(preferAnimeId);
    if (animeIsNotPrefer) continue;

    let isMatch = false;

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
            if (normalizeSpaces(candTitle).includes(normalizedTitle)) {
                // 年份匹配依然以原始 anime 为准，且年份匹配优先于季匹配
                if (!matchYear(anime, year)) {
                    log("info", `Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
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
                
                if (matchSeason(tempAnime, title, season) || animeIsPrefer) {
                    isMatch = true;
                    break; // 别名命中跳出
                }
            }
        } else {
            // 电影模式
            const cleanTitle = candTitle.split("(")[0].trim();
            if (cleanTitle === title) {
                // 年份匹配检查
                if (!matchYear(anime, year)) {
                    log("info", `Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
                    continue;
                }
                isMatch = true;
                break; // 别名命中跳出
            }
        }
    }

    if (!isMatch) continue;

    // 2. 获取剧集详情 (无条件获取，确保数据完整性)
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      continue;
    }
    
    // 输出匹配分数及原始数据日志
    log("info", "判断剧集", `Anime: ${anime.animeTitle}`);
    log("info", bangumiData);

    let matchedEpisode = null;

    // 判定当前循环的 anime 是否为用户手动指定的优选偏好
    const isPreferredAnime = globals.rememberLastSelect && preferAnimeId != null && 
        (String(anime.bangumiId) === String(preferAnimeId) || String(anime.animeId) === String(preferAnimeId));

    if (season && episode) {
        // 剧集模式逻辑
        const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);
        
        log("info", "过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        let targetEpisode = episode;
        if (offsets && offsets[String(season)] !== undefined) {
          targetEpisode = computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode);
        }

        // 匹配集数
        matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, platform);

        // 如果当前是用户的优选偏好，但由于平台配置限制导致未命中目标平台，则放宽条件无视平台限制提取集数
        if (!matchedEpisode && isPreferredAnime) {
            log("info", `[system] [Match] 优选剧集未命中目标平台 ${platform}，放宽条件提取集数`);
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
                    log("info", `[system] [Match] 优选电影未命中目标平台 ${platform}，放宽条件提取资源`);
                    matchedEpisode = bangumiData.bangumi.episodes[0];
                }
            } else {
                matchedEpisode = bangumiData.bangumi.episodes[0];
            }
        }
    }

    // 3. 匹配结果处理与评分比较
    if (matchedEpisode) {
        // 计算当前匹配的得分
        const actualPlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;
        let currentScore = 0;
        
        if (platform) {
            // 如果指定了平台偏好，计算匹配得分
            currentScore = getPlatformMatchScore(actualPlatform, platform);
        } else {
            // 如果没有指定平台偏好，默认为 1
            currentScore = 1;
        }

        // 赋予手动指定偏好最高分数权重，确保其在多源匹配中具有绝对优先级
        if (isPreferredAnime) {
            currentScore += 9999;
        }

        // 比较并更新最佳结果
        // 逻辑：如果有更好的分数，或者之前没有匹配到任何结果，则更新
        if (currentScore > bestRes.score) {
             bestRes = {
                anime: anime,
                episode: matchedEpisode,
                score: currentScore
            };
        }

        // 如果没有指定平台偏好 (platform 为空) 或已命中最高优先级的手动优选，立刻跳出查找
        if (!platform || isPreferredAnime) {
            break; 
        }
        
        // 如果指定了平台偏好，则继续循环查找是否有得分更高的源（最小杂质匹配）
    }
  }

  //  跨季集数顺延映射匹配逻辑
  if (!bestRes.episode && season && episode) {
    const spilloverRes = findCrossSeasonEpisodeMap(searchData, title, year, season, episode, platform, detailStore);
    if (spilloverRes.resEpisode) {
      bestRes = {
        episode: spilloverRes.resEpisode,
        anime: spilloverRes.resAnime,
        score: platform ? getPlatformMatchScore(extractPlatformFromTitle(spilloverRes.resAnime.animeTitle) || spilloverRes.resAnime.source, platform) : 1
      };
    }
  }

  return { resEpisode: bestRes.episode, resAnime: bestRes.anime };
}

async function fallbackMatchAniAndEp(searchData, req, season, episode, year, title, resEpisode, resAnime, offsets, detailStore = null) {
  for (const anime of searchData.animes) {
    // 年份匹配优先（如果提供了年份）
    if (year && !matchYear(anime, year)) {
      log("info", `Fallback: Year mismatch: anime year ${extractYear(anime.animeTitle)} vs query year ${year}`);
      continue;
    }
    
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) {
      continue;
    }
    log("info", bangumiData);
    if (season && episode) {
      // 过滤集标题正则条件的 episode
      const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
        return !globals.episodeTitleFilter.test(episode.episodeTitle);
      });

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
  if (!resEpisode && season && episode) {
    const spilloverRes = findCrossSeasonEpisodeMap(searchData, title, year, season, episode, null, detailStore);
    if (spilloverRes.resEpisode) {
      resEpisode = spilloverRes.resEpisode;
      resAnime = spilloverRes.resAnime;
    }
  }

  return {resEpisode, resAnime};
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

  log("info", "[system] [Match] Parsed title, season, episode, year", {title, season, episode, year});
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

// Extracted function for POST /api/v2/match
export async function matchAnime(url, req, clientIp) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body) {
      log("error", "[system] [Match] Request body is empty");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Empty request body" },
        400
      );
    }

    // 处理请求体中的数据
    // 假设请求体包含一个字段，比如 { query: "anime name" }
    const { fileName } = body;
    if (!fileName) {
      log("error", "[system] [Match] Missing fileName parameter in request body");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing fileName parameter" },
        400
      );
    }

    // 解析fileName，提取平台偏好
    const { cleanFileName, preferredPlatform } = parseFileName(fileName);
    log("info", `[system] [Match] Processing anime match for query: ${fileName}`);
    log("info", `[system] [Match] Parsed cleanFileName: ${cleanFileName}, preferredPlatform: ${preferredPlatform}`);

    let {title, season, episode, year} = await extractTitleSeasonEpisode(cleanFileName);

    // 使用剧名映射表转换剧名
    if (globals.titleMappingTable && globals.titleMappingTable.size > 0) {
      const mappedTitle = globals.titleMappingTable.get(title);
      if (mappedTitle) {
        title = mappedTitle;
        log("info", `[system] [Match] Title mapped from original: ${url.searchParams.get("keyword")} to: ${title}`);
      }
    }

    // 如果启用了搜索关键字繁转简，则进行转换
    if (globals.animeTitleSimplified) {
      const simplifiedTitle = simplized(title);
      log("info", `[system] [Match] matchAnime converted traditional to simplified: ${title} -> ${simplifiedTitle}`);
      title = simplifiedTitle;
    }

    // 获取 prefer animeId（按 season 维度）
    const [preferAnimeId, preferSource, offsets] = getPreferAnimeId(title, season);
    log("info", `[system] [Match] prefer animeId: ${preferAnimeId} from ${preferSource}`);

    // 根据指定平台创建动态平台顺序
    const dynamicPlatformOrder = createDynamicPlatformOrder(preferredPlatform);
    const targetPlatform = dynamicPlatformOrder.length > 0 ? dynamicPlatformOrder[0] : null;

    const requestAnimeDetailsMap = new Map();
    let originSearchUrl = buildSearchAnimeUrl(req.url, title, season, episode);
    const searchRes = await searchAnime(originSearchUrl, preferAnimeId, preferSource, requestAnimeDetailsMap, targetPlatform);
    const searchData = await searchRes.json();
    log("info", `[system] [Match] searchData: ${searchData.animes}`);

    let resAnime;
    let resEpisode;

    let resData = {
      "errorCode": 0,
      "success": true,
      "errorMessage": "",
      "isMatched": false,
      "matches": []
    };

    log("info", `[system] [Match] Original platformOrderArr: ${globals.platformOrderArr}`);
    log("info", `[system] [Match] Dynamic platformOrder: ${dynamicPlatformOrder}`);
    log("info", `[system] [Match] Preferred platform: ${preferredPlatform || 'none'}`);

    // 尝试使用AI进行匹配
    const aiMatchResult = await matchAniAndEpByAi(season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, requestAnimeDetailsMap);
    if (aiMatchResult.resAnime && aiMatchResult.resEpisode) {
      resAnime = aiMatchResult.resAnime;
      resEpisode = aiMatchResult.resEpisode;
      resData["isMatched"] = true;
      log("info", `[system] [Match] AI match found: ${resAnime.animeTitle}; episode: ${resEpisode.episodeTitle}`);
    } else {
      // AI匹配失败或未配置，使用传统匹配方式
      for (const platform of dynamicPlatformOrder) {
        const __ret = await matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, requestAnimeDetailsMap);
        resEpisode = __ret.resEpisode;
        resAnime = __ret.resAnime;

        if (resAnime) {
          resData["isMatched"] = true;
          log("info", `[system] [Match] Found match with platform: ${platform || 'default'}`);
          break;
        }
      }

      // 如果都没有找到则返回第一个满足剧集数的剧集
      if (!resAnime) {
        const __ret = await fallbackMatchAniAndEp(searchData, req, season, episode, year, title, resEpisode, resAnime, offsets, requestAnimeDetailsMap);
        resEpisode = __ret.resEpisode;
        resAnime = __ret.resAnime;
      }
    }

    if (resEpisode) {
      if (clientIp) {
        setLastSearch(clientIp, { title, season, episode, episodeId: resEpisode.episodeId });
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
          "imageUrl": resAnime.imageUrl
        })
      ]
    }

    log("info", `[system] [Match] resMatchData: ${resData}`);

    // 示例返回
    return jsonResponse(resData);
  } catch (error) {
    // 处理 JSON 解析错误或其他异常
    log("error", `[system] [Match] Failed to parse request body: ${error.message}`);
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Invalid JSON body" },
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
    log("info", `[system] [Episodes] searchEpisodes converted traditional to simplified: ${anime} -> ${simplifiedTitle}`);
    anime = simplifiedTitle;
  }

  log("info", `[system] [Episodes] Search episodes with anime: ${anime}, episode: ${episode}`);

  if (!anime) {
    log("error", "[system] [Episodes] Missing anime parameter");
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
    log("info", "[system] [Episodes] No anime found for the given title");
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      hasMore: false,
      animes: []
    });
  }

  let resultAnimes = [];

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
          // 纯数字，仅保留指定集数
          const targetEpisode = parseInt(episode);
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep =>
            parseInt(ep.episodeNumber) === targetEpisode
          );
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
            episodeTitle: ep.episodeTitle
          }))
        }));
      }
    }
  }

  log("info", `[system] [Episodes] Found ${resultAnimes.length} animes with filtered episodes`);

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: resultAnimes
  });
}

// Extracted function for GET /api/v2/bangumi/:animeId
export async function getBangumi(path, detailStore = null, source = null) {
  const idParam = path.split("/").pop();
  const anime =
    resolveAnimeByIdFromDetailStore(idParam, detailStore, source) ||
    resolveAnimeById(idParam);

  if (!anime) {
    log("error", `[system] [Bangumi] Anime with ID ${idParam} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  return jsonResponse(buildBangumiData(anime, idParam));
}

function buildBangumiData(anime, idParam = "") {
  log("info", `[system] [Bangumi] Fetched details for anime ID: ${idParam || anime.bangumiId}`);

  // 构建 episodes 列表
  let episodesList = [];
  for (let i = 0; i < anime.links.length; i++) {
    const link = anime.links[i];
    episodesList.push({
      seasonId: `season-${anime.animeId}`,
      episodeId: link.id,
      episodeTitle: `${link.title}`,
      episodeNumber: `${i+1}`,
      airDate: anime.startDate,
    });
  }

  // 如果启用了集标题过滤，则应用过滤
  if (globals.enableAnimeEpisodeFilter) {
    episodesList = episodesList.filter(episode => {
      return !globals.episodeTitleFilter.test(episode.episodeTitle);
    });
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
      episodeNumber: `${index+1}`
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
        name: "Season 1",
        episodeCount: anime.episodeCount,
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
    const realId = part.substring(firstColonIndex + 1);

    if (sourceName !== 'hanjutv') {
      return {
        realId,
        logicalSource: sourceName,
        sourceLabel: sourceName,
      };
    }

    return {
      realId,
      logicalSource: 'hanjutv',
      sourceLabel: getHanjutvSourceLabel(realId),
    };
  });
  const sourceNames = partMetas.map(meta => meta.logicalSource).filter(Boolean);
  const realIds = partMetas.map(meta => meta.realId);
  const sourceTag = partMetas.map(meta => meta.sourceLabel).filter(Boolean).join('＆');

  log("info", `[Merge] 开始获取 [${sourceTag}] 聚合弹幕...`);

  // 1. 检查聚合缓存
  const cached = getCommentCache(url);
  if (cached) {
    log("info", `[Merge] 命中缓存 [${sourceTag}]，返回 ${cached.length} 条`);
    return cached;
  }

  const stats = {};
  
  // 2. 并行获取所有源的弹幕
  const tasks = partMetas.map(async (meta) => {
    const sourceName = meta.logicalSource;
    const sourceLabel = meta.sourceLabel || meta.logicalSource;
    const realId = meta.realId;

    if (!sourceName || !realId) return [];

    // 构建去重Key
    const pendingKey = `${sourceName}:${realId}`;

    // 检查是否有正在进行的相同请求（请求合并）
    if (PENDING_DANMAKU_REQUESTS.has(pendingKey)) {
        log("info", `[Merge] 复用正在进行的请求: ${pendingKey}`);
        try {
            const list = await PENDING_DANMAKU_REQUESTS.get(pendingKey);
            return list || [];
        } catch (e) {
            return [];
        }
    }

    // 定义请求任务
    const fetchTask = sourceLogContext.run(toLogSourceName(sourceName), async () => {
        let sourceInstance = null;

        if (sourceName === 'renren') sourceInstance = renrenSource;
        else if (sourceName === 'hanjutv') sourceInstance = hanjutvSource;
        else if (sourceName === 'bahamut') sourceInstance = bahamutSource;
        else if (sourceName === 'dandan') sourceInstance = dandanSource;
        else if (sourceName === 'tencent') sourceInstance = tencentSource;
        else if (sourceName === 'youku') sourceInstance = youkuSource;
        else if (sourceName === 'iqiyi') sourceInstance = iqiyiSource;
        else if (sourceName === 'imgo') sourceInstance = mangoSource;
        else if (sourceName === 'bilibili') sourceInstance = bilibiliSource;
        else if (sourceName === 'migu') sourceInstance = miguSource;
        else if (sourceName === 'sohu') sourceInstance = sohuSource;
        else if (sourceName === 'leshi') sourceInstance = leshiSource;
        else if (sourceName === 'xigua') sourceInstance = xiguaSource;
        else if (sourceName === 'maiduidui') sourceInstance = maiduiduiSource;
        else if (sourceName === 'aiyifan') sourceInstance = aiyifanSource;
        else if (sourceName === 'animeko') sourceInstance = animekoSource;
        // 如有新增允许的源合并，在此处添加

        if (sourceInstance) {
          try {
            // 获取原始数据 -> 格式化
            const raw = await sourceInstance.getEpisodeDanmu(realId, parts);
            const formatted = sourceInstance.formatComments(raw);
            log("info", `[${sourceLabel}] 获取弹幕 ${formatted.length} 条`);
            
            // 给合并工具里的每一条弹幕打上独立的原始源标签
            if (formatted && Array.isArray(formatted)) {
                formatted.forEach(item => {
                    if (!item._sourceLabel) item._sourceLabel = sourceLabel;
                });
            }

            stats[sourceLabel] = formatted.length;
            return formatted;
          } catch (e) {
            log("error", `[Merge] 获取 ${sourceLabel} 失败: ${e.message}`);
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
  });

  // 等待所有源请求完成
  const results = await Promise.all(tasks);
  
  // 调用以dandan为基准的跨源时间轴对齐函数（仅当存在 dandan 源时执行）
  alignSourceTimelines(results, sourceNames, realIds);

  // 按来源分别应用弹幕时间偏移（对齐后、合并前）
  if (globals.danmuOffsetRules?.length > 0 && animeTitle && commentId) {
    const [, , episodeTitle] = findAnimeIdByCommentId(commentId);
    if (episodeTitle) {
      let { baseTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
      season ||= 1;
      episode ||= findIndexById(commentId) + 1;
      const seasonStr = `S${season.toString().padStart(2, '0')}`;
      const episodeStr = `E${episode.toString().padStart(2, '0')}`;
      for (let idx = 0; idx < results.length; idx++) {
        const list = results[idx];
        const offsetRule = resolveOffsetRule(globals.danmuOffsetRules, {
          anime: baseTitle,
          season: seasonStr,
          episode: episodeStr,
          source: sourceNames[idx]
        });
        const offset = offsetRule?.offset || 0;
        if (offset !== 0) {
          const targetUrl = realIds[idx];
          const videoDuration = offsetRule?.usePercent ? await resolveUrlDuration(targetUrl) : 0;
          const offsetMode = offsetRule?.usePercent ? '%' : 's';
          log("info", `[Merge] 应用偏移 ${offset}${offsetMode} -> ${sourceNames[idx]} (${baseTitle}/${seasonStr}/${episodeStr})${offsetRule?.usePercent ? `, duration=${videoDuration}s` : ''}`);
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
  log("info", `[Merge] 聚合原始数据完成: 总计 ${mergedList.length} 条 (${statDetails})`);

  // 4. 统一处理（去重、过滤、转JSON）
  return convertToDanmakuJson(mergedList, sourceTag);
}

// Extracted function for GET /api/v2/comment/:commentId
export async function getComment(path, queryFormat, segmentFlag, clientIp, includeDuration = false) {
  const commentId = parseInt(path.split("/").pop());
  let animeTitle = findAnimeTitleById(commentId);
  let url = findUrlById(commentId);
  let title = findTitleById(commentId);
  let plat = title ? (title.match(/【(.*?)】/) || [null])[0]?.replace(/[【】]/g, '') : null;
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
  const cachedComments = getCommentCache(url);
  if (cachedComments !== null) {
    const responseData = buildDanmuResponse(
      { count: cachedComments.length, comments: cachedComments },
      shouldAttachDuration ? await resolveMergedDuration(url) : null
    );
    return formatDanmuResponse(responseData, queryFormat);
  }

  log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
  let danmus = [];
  const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;

  if (url && url.includes(MERGE_DELIMITER)) {
    danmus = await fetchMergedComments(url, animeTitle, commentId);
  } else {
    if (url.includes('.qq.com')) {
      danmus = await sourceLogContext.run('tencent', () => tencentSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.iqiyi.com')) {
      danmus = await sourceLogContext.run('iqiyi', () => iqiyiSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.mgtv.com')) {
      danmus = await sourceLogContext.run('mango', () => mangoSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      if (url.includes('b23.tv')) {
        url = await sourceLogContext.run('bilibili', () => bilibiliSource.resolveB23Link(url));
      }
      danmus = await sourceLogContext.run('bilibili', () => bilibiliSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.youku.com')) {
      danmus = await sourceLogContext.run('youku', () => youkuSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.miguvideo.com')) {
      danmus = await sourceLogContext.run('migu', () => miguSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.sohu.com')) {
      danmus = await sourceLogContext.run('sohu', () => sohuSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.le.com')) {
      danmus = await sourceLogContext.run('leshi', () => leshiSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.douyin.com') || url.includes('.ixigua.com')) {
      danmus = await sourceLogContext.run('xigua', () => xiguaSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.mddcloud.com.cn')) {
      danmus = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getComments(url, plat, segmentFlag));
    } else if (url.includes('.yfsp.tv')) {
      danmus = await sourceLogContext.run('aiyifan', () => aiyifanSource.getComments(url, plat, segmentFlag));
    }

    // 请求其他平台弹幕
    const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
    if (!urlPattern.test(url)) {
      if (plat === "renren") {
        danmus = await sourceLogContext.run('renren', () => renrenSource.getComments(url, plat, segmentFlag));
      } else if (plat === "hanjutv") {
        danmus = await sourceLogContext.run('hanjutv', () => hanjutvSource.getComments(url, plat, segmentFlag));
      } else if (plat === "bahamut") {
        danmus = await sourceLogContext.run('bahamut', () => bahamutSource.getComments(url, plat, segmentFlag));
      } else if (plat === "dandan") {
        danmus = await sourceLogContext.run('dandan', () => dandanSource.getComments(url, plat, segmentFlag));
      } else if (plat === "custom") {
        danmus = await sourceLogContext.run('custom', () => customSource.getComments(url, plat, segmentFlag));
      } else if (plat === "animeko") {
        danmus = await sourceLogContext.run('animeko', () => animekoSource.getComments(url, plat, segmentFlag));
      }
    }

    // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
    if ((!danmus || danmus.length === 0) && urlPattern.test(url)) {
      danmus = await sourceLogContext.run('other', () => otherSource.getComments(url, "other_server", segmentFlag));
    }
  }

  const [animeId, source, episodeTitle, animeAliases] = findAnimeIdByCommentId(commentId);
  if (animeId && source) {
    let lastTitle = null;
    let lastSeason = null;
    let offset = null;

    if (clientIp) {
      const lastSearch = getLastSearch(clientIp);
      if (lastSearch && lastSearch.title && lastSearch.season && lastSearch.episode && episodeTitle) {
        lastTitle = lastSearch.title;
        lastSeason = lastSearch.season;
        offset = `${lastSearch.episode}:${episodeTitle}`;
        log("info", `[system] [LogVar-API] Calculated episode offset for IP ${clientIp}: Query E${lastSearch.episode}, Selected ${episodeTitle} -> Offset ${offset} (Season ${lastSeason})`);
      }
    }

    log("info", `[system] [LogVar-API] animeTitle：${animeTitle}; lastTitle：${lastTitle}; titleMatches：${titleMatches(animeTitle, lastTitle)}`);

    // 校验番剧标题或别名是否匹配最新搜索/匹配上下文，别名检查用于兼容不同源对同一番剧的标题命名差异
    const titleOrAliasMatches = titleMatches(animeTitle, lastTitle) ||
        (Array.isArray(animeAliases) && animeAliases.some(alias => titleMatches(alias, lastTitle)));

    if (titleOrAliasMatches) {
      log("info", `[system] [LogVar-API] excute setPreferByAnimeId`);
      setPreferByAnimeId(animeId, source, lastSeason, offset);
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
  if (animeTitle && episodeTitle && globals.danmuOffsetRules?.length > 0 && !(url && url.includes(MERGE_DELIMITER))) {
    let { baseTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
    season ||= 1;
    episode ||= findIndexById(commentId) + 1;
    const seasonStr = `S${season.toString().padStart(2, '0')}`;
    const episodeStr = `E${episode.toString().padStart(2, '0')}`;
    const offsetRule = resolveOffsetRule(globals.danmuOffsetRules, {
      anime: baseTitle, season: seasonStr, episode: episodeStr, source
    });
    const offset = offsetRule?.offset || 0;
    if (offset !== 0) {
      const videoDuration = offsetRule?.usePercent ? await resolveUrlDuration(url) : 0;
      log("info", `[system] [LogVar-API] Applying danmu offset: ${offset}${offsetRule?.usePercent ? '%' : 's'} for ${baseTitle}/${seasonStr}/${episodeStr}${offsetRule?.usePercent ? `, duration=${videoDuration}s` : ''}`);
      danmus = applyOffset(danmus, offset, {
        usePercent: offsetRule?.usePercent,
        videoDuration
      });
    }
  }

  // 缓存弹幕结果
  if (!segmentFlag) {
    if (danmus && danmus.comments) danmus = danmus.comments;
    if (!Array.isArray(danmus)) danmus = [];
    if (danmus.length > 0) {
        setCommentCache(url, danmus);
    }
  }

  const responseData = buildDanmuResponse(
    { count: danmus.length, comments: danmus },
    durationPromise ? await durationPromise : null
  );
  return formatDanmuResponse(responseData, queryFormat);
}

// Extracted function for GET /api/v2/comment?url=xxx or /api/v2/extcomment?url=xxx
export async function getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration = false) {
  try {
    // 验证URL参数
    if (!videoUrl || typeof videoUrl !== 'string') {
      log("error", "[system] [LogVar-API] Missing or invalid url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    videoUrl = videoUrl.trim();

    // 验证URL格式
    if (!videoUrl.startsWith('http')) {
      log("error", "[system] [LogVar-API] Invalid url format, must start with http or https");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Invalid url format, must start with http or https", count: 0, comments: [] },
        400
      );
    }

    log("info", `[system] [LogVar-API] Processing comment request for URL: ${videoUrl}`);

    let url = videoUrl;
    const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);
    // 检查弹幕缓存
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) {
      const responseData = buildDanmuResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      }, shouldAttachDuration ? await resolveMergedDuration(url) : null);
      return formatDanmuResponse(responseData, queryFormat);
    }

    log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
    let danmus = [];
    const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;

    // 根据URL域名判断平台并获取弹幕
    if (url.includes('.qq.com')) {
      danmus = await sourceLogContext.run('tencent', () => tencentSource.getComments(url, "qq", segmentFlag));
    } else if (url.includes('.iqiyi.com')) {
      danmus = await sourceLogContext.run('iqiyi', () => iqiyiSource.getComments(url, "qiyi", segmentFlag));
    } else if (url.includes('.mgtv.com')) {
      danmus = await sourceLogContext.run('mango', () => mangoSource.getComments(url, "imgo", segmentFlag));
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      if (url.includes('b23.tv')) {
        url = await sourceLogContext.run('bilibili', () => bilibiliSource.resolveB23Link(url));
      }
      danmus = await sourceLogContext.run('bilibili', () => bilibiliSource.getComments(url, "bilibili1", segmentFlag));
    } else if (url.includes('.youku.com')) {
      danmus = await sourceLogContext.run('youku', () => youkuSource.getComments(url, "youku", segmentFlag));
    } else if (url.includes('.miguvideo.com')) {
      danmus = await sourceLogContext.run('migu', () => miguSource.getComments(url, "migu", segmentFlag));
    } else if (url.includes('.sohu.com')) {
      danmus = await sourceLogContext.run('sohu', () => sohuSource.getComments(url, "sohu", segmentFlag));
    } else if (url.includes('.le.com')) {
      danmus = await sourceLogContext.run('leshi', () => leshiSource.getComments(url, "leshi", segmentFlag));
    } else if (url.includes('.douyin.com') || url.includes('.ixigua.com')) {
      danmus = await sourceLogContext.run('xigua', () => xiguaSource.getComments(url, "xigua", segmentFlag));
    } else if (url.includes('.mddcloud.com.cn')) {
      danmus = await sourceLogContext.run('maiduidui', () => maiduiduiSource.getComments(url, "maiduidui", segmentFlag));
    } else if (url.includes('.yfsp.tv')) {
      danmus = await sourceLogContext.run('aiyifan', () => aiyifanSource.getComments(url, "aiyifan", segmentFlag));
    } else {
      // 如果不是已知平台，尝试第三方弹幕服务器
      const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
      if (urlPattern.test(url)) {
        danmus = await sourceLogContext.run('other', () => otherSource.getComments(url, "other_server", segmentFlag));
      }
    }

    log("info", `[system] [LogVar-API] Successfully fetched ${danmus.length} comments from URL`);

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(url, danmus);
    }

    const responseData = buildDanmuResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    }, durationPromise ? await durationPromise : null);
    return formatDanmuResponse(responseData, queryFormat);
  } catch (error) {
    // 处理异常
    log("error", `[system] [LogVar-API] Failed to process comment by URL request: ${error.message}`);
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}

// Extracted function for GET /api/v2/segmentcomment
export async function getSegmentComment(segment, queryFormat) {
  try {
    let url = segment.url;
    let platform = segment.type;

    // 验证URL参数
    if (!url || typeof url !== 'string') {
      log("error", "[system] [SegmentComment] Missing or invalid url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    url = url.trim();

    log("info", `[system] [SegmentComment] Processing segment comment request for URL: ${url}`);

    // 检查弹幕缓存
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) {
      const responseData = {
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      };
      return formatDanmuResponse(responseData, queryFormat);
    }

    log("info", `[system] [SegmentComment] 开始从本地请求分段弹幕... URL: ${url}`);
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
    } else if (platform === "other_server") {
      danmus = await sourceLogContext.run('other', () => otherSource.getSegmentComments(segment));
    }

    log("info", `[system] [SegmentComment] Successfully fetched ${danmus.length} segment comments from URL`);

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(url, danmus);
    }

    const responseData = {
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    };
    return formatDanmuResponse(responseData, queryFormat);
  } catch (error) {
    // 处理异常
    log("error", `[system] [SegmentComment] Failed to process segment comment request: ${error.message}`);
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}
