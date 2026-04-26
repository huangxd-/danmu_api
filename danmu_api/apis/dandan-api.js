```javascript
import { globals } from '../configs/globals.js';
import { getPageTitle, jsonResponse, httpGet } from '../utils/http-util.js';
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
  extractYear, titleMatches, extractAnimeInfo, extractEpisodeNumberFromTitle
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
    if (targetUrl.includes('.qq.com')) segmentResult = await tencentSource.getComments(targetUrl, 'qq', true);
    else if (targetUrl.includes('.iqiyi.com')) segmentResult = await iqiyiSource.getComments(targetUrl, 'qiyi', true);
    else if (targetUrl.includes('.mgtv.com')) segmentResult = await mangoSource.getComments(targetUrl, 'imgo', true);
    else if (targetUrl.includes('.bilibili.com') || targetUrl.includes('b23.tv')) {
      if (targetUrl.includes('b23.tv')) targetUrl = await bilibiliSource.resolveB23Link(targetUrl);
      segmentResult = await bilibiliSource.getComments(targetUrl, 'bilibili1', true);
    } else if (targetUrl.includes('.youku.com')) segmentResult = await youkuSource.getComments(targetUrl, 'youku', true);
    else if (targetUrl.includes('.miguvideo.com')) segmentResult = await miguSource.getComments(targetUrl, 'migu', true);
    else if (targetUrl.includes('.sohu.com')) segmentResult = await sohuSource.getComments(targetUrl, 'sohu', true);
    else if (targetUrl.includes('.le.com')) segmentResult = await leshiSource.getComments(targetUrl, 'leshi', true);
    else if (targetUrl.includes('.douyin.com') || targetUrl.includes('.ixigua.com')) segmentResult = await xiguaSource.getComments(targetUrl, 'xigua', true);
    else if (targetUrl.includes('.mddcloud.com.cn')) segmentResult = await maiduiduiSource.getComments(targetUrl, 'maiduidui', true);
    else if (targetUrl.includes('.yfsp.tv')) segmentResult = await aiyifanSource.getComments(targetUrl, 'aiyifan', true);
    return extractDurationFromSegments(segmentResult);
  } catch (error) {
    log('warn', `[Duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

function extractMergedUrls(url) {
  return String(url || '').split(MERGE_DELIMITER).map((part) => {
    const firstColonIndex = part.indexOf(':');
    if (firstColonIndex === -1) return part.trim();
    return part.slice(firstColonIndex + 1).trim();
  }).filter(Boolean);
}

async function resolveMergedDuration(url) {
  if (!url) return 0;
  try {
    const targetUrls = url.includes(MERGE_DELIMITER) ? extractMergedUrls(url) : [url];
    const durations = await Promise.all(targetUrls.map(resolveUrlDuration));
    return durations.reduce((maxValue, currentValue) => Math.max(maxValue, currentValue || 0), 0);
  } catch (error) {
    log('warn', `[Duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

function matchYear(anime, queryYear) {
  if (!queryYear) return true;
  const animeYear = extractYear(anime.animeTitle);
  if (!animeYear) return true;
  return animeYear === queryYear;
}

export function matchSeason(anime, queryTitle, season) {
  const match = anime.animeTitle.match(/^(.*?)\(\d{4}\)/);
  const originalTitle = match ? match[1].trim() : anime.animeTitle.split("(")[0].trim();
  const normalizedAnimeTitle = normalizeSpaces(originalTitle);
  const normalizedQueryTitle = normalizeSpaces(queryTitle);
  if (normalizedAnimeTitle.includes(normalizedQueryTitle)) {
    if (normalizedAnimeTitle.startsWith(normalizedQueryTitle)) {
      const afterTitle = normalizedAnimeTitle.substring(normalizedQueryTitle.length).trim();
      if (afterTitle === '' && season === 1) return true;
      const seasonIndex = afterTitle.match(/\d+/);
      if (seasonIndex && seasonIndex[0] === season.toString()) return true;
      const chineseNumber = afterTitle.match(/[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+/);
      if (chineseNumber && convertChineseNumber(chineseNumber[0]) === season) return true;
    }
    return false;
  }
  return false;
}

export async function searchAnime(url, preferAnimeId = null, preferSource = null, detailStore = null) {
  let queryTitle = url.searchParams.get("keyword");
  log("info", `Search anime with keyword: ${queryTitle}`);

  if (queryTitle === "") {
    return jsonResponse({ errorCode: 0, success: true, errorMessage: "", animes: [] });
  }

  if (globals.animeTitleSimplified) {
    queryTitle = simplized(queryTitle);
  }

  const requestAnimeDetailsMap = detailStore instanceof Map ? detailStore : new Map();
  const cachedResults = getSearchCache(queryTitle, requestAnimeDetailsMap);
  if (cachedResults !== null) {
    return jsonResponse({ errorCode: 0, success: true, errorMessage: "", animes: cachedResults });
  }

  let curAnimes = [];
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
  if (urlRegex.test(queryTitle)) {
    const tmpAnime = Anime.fromJson({
      "animeId": 0, "bangumiId": "0", "animeTitle": queryTitle, "type": "", "typeDescription": "链接解析",
      "imageUrl": "", "startDate": "", "episodeCount": 1, "rating": 0, "isFavorited": true
    });
    let platform = "unknown";
    if (queryTitle.includes(".qq.com")) platform = "qq";
    else if (queryTitle.includes(".iqiyi.com")) platform = "qiyi";
    else if (queryTitle.includes(".bilibili.com")) platform = "bilibili1";
    else if (queryTitle.includes(".youku.com")) platform = "youku";
    
    const pageTitle = await getPageTitle(queryTitle);
    const links = [{ "name": "手动解析链接弹幕", "url": queryTitle, "title": `【${platform}】 ${pageTitle}` }];
    curAnimes.push(tmpAnime);
    addAnime(Anime.fromJson({...tmpAnime, links: links}), requestAnimeDetailsMap);
    
    if (globals.localCacheValid) await updateLocalCaches();
    return jsonResponse({ errorCode: 0, success: true, errorMessage: "", animes: curAnimes });
  }

  try {
    const requestPromises = globals.sourceOrderArr.map(source => {
      if (source === "360") return kan360Source.search(queryTitle);
      if (source === "vod") return vodSource.search(queryTitle, preferAnimeId, preferSource);
      if (source === "tmdb") return tmdbSource.search(queryTitle);
      if (source === "douban") return doubanSource.search(queryTitle);
      if (source === "renren") return renrenSource.search(queryTitle);
      if (source === "hanjutv") return hanjutvSource.search(queryTitle);
      if (source === "bahamut") return bahamutSource.search(queryTitle);
      if (source === "dandan") return dandanSource.search(queryTitle);
      if (source === "custom") return customSource.search(queryTitle);
      if (source === "tencent") return tencentSource.search(queryTitle);
      if (source === "youku") return youkuSource.search(queryTitle);
      if (source === "iqiyi") return iqiyiSource.search(queryTitle);
      if (source === "imgo") return mangoSource.search(queryTitle);
      if (source === "bilibili") return bilibiliSource.search(queryTitle);
      if (source === "migu") return miguSource.search(queryTitle);
      if (source === "sohu") return sohuSource.search(queryTitle);
      if (source === "leshi") return leshiSource.search(queryTitle);
      if (source === "xigua") return xiguaSource.search(queryTitle);
      if (source === "maiduidui") return maiduiduiSource.search(queryTitle);
      if (source === "aiyifan") return aiyifanSource.search(queryTitle);
      if (source === "animeko") return animekoSource.search(queryTitle);
    });

    const results = await Promise.all(requestPromises);
    const resultData = {};
    globals.sourceOrderArr.forEach((source, index) => { resultData[source] = results[index]; });

    for (const key of globals.sourceOrderArr) {
      if (key === 'vod' && resultData.vod) {
        for (const vodResult of resultData.vod) {
          if (vodResult?.list?.length > 0) await vodSource.handleAnimes(vodResult.list, queryTitle, curAnimes, vodResult.serverName, requestAnimeDetailsMap);
        }
      } else if (resultData[key]) {
        const sourceInst = { '360': kan360Source, 'tmdb': tmdbSource, 'douban': doubanSource, 'renren': renrenSource, 'hanjutv': hanjutvSource, 'bahamut': bahamutSource, 'dandan': dandanSource, 'custom': customSource, 'tencent': tencentSource, 'youku': youkuSource, 'iqiyi': iqiyiSource, 'imgo': mangoSource, 'bilibili': bilibiliSource, 'migu': miguSource, 'sohu': sohuSource, 'leshi': leshiSource, 'xigua': xiguaSource, 'maiduidui': maiduiduiSource, 'aiyifan': aiyifanSource, 'animeko': animekoSource }[key];
        if (sourceInst) await sourceInst.handleAnimes(resultData[key], queryTitle, curAnimes, requestAnimeDetailsMap);
      }
    }
  } catch (error) { log("error", "Search error:", error); }

  if (globals.mergeSourcePairs.length > 0) await applyMergeLogic(curAnimes, requestAnimeDetailsMap);

  // 【优化点1】物理排序：大厂正片置顶
  const priorityPlatforms = ['bilibili', 'tencent', 'iqiyi', 'youku', 'qq', 'qiyi'];
  curAnimes.sort((a, b) => {
    const aSource = (a.source || "").toLowerCase();
    const bSource = (b.source || "").toLowerCase();
    const aIsPriority = priorityPlatforms.some(p => aSource.includes(p));
    const bIsPriority = priorityPlatforms.some(p => bSource.includes(p));
    
    if (aIsPriority && !bIsPriority) return -1;
    if (!aIsPriority && bIsPriority) return 1;
    // 同样是大厂，集数多的排前面（防剧场版）
    return (b.episodeCount || 0) - (a.episodeCount || 0);
  });

  storeAnimeIdsToMap(curAnimes, queryTitle);

  if (curAnimes.length > 0) {
    if (globals.localCacheValid) await updateLocalCaches();
    if (globals.redisValid) await updateRedisCaches();
    setSearchCache(queryTitle, curAnimes, requestAnimeDetailsMap);
  }

  return jsonResponse({ errorCode: 0, success: true, errorMessage: "", animes: curAnimes });
}

function filterSameEpisodeTitle(filteredTmpEpisodes) {
    return filteredTmpEpisodes.filter((episode, index, episodes) => {
        return !episodes.slice(0, index).some(prevEpisode => prevEpisode.episodeTitle === episode.episodeTitle);
    });
}

function getPlatformMatchScore(candidatePlatform, targetPlatform) {
  if (!candidatePlatform || !targetPlatform) return 0;
  const cParts = candidatePlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  const tParts = targetPlatform.split('&').map(s => s.trim().toLowerCase()).filter(s => s);
  let matchCount = 0;
  for (const tPart of tParts) {
    const isFound = cParts.some(cPart => cPart === tPart || (cPart.includes(tPart) && tPart.length > 2) || (tPart.includes(cPart) && cPart.length > 2));
    if (isFound) matchCount++;
  }
  if (matchCount === 0) return 0;
  return (matchCount * 1000) - cParts.length;
}

function extractPlatformFromTitle(title) {
    const match = title.match(/from\s+([a-zA-Z0-9&]+)/i);
    return match ? match[1] : null;
}

function findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, platform = null) {
  if (!filteredEpisodes || filteredEpisodes.length === 0) return null;
  let platformEpisodes = filteredEpisodes;
  if (platform) {
    platformEpisodes = filteredEpisodes.filter(ep => getPlatformMatchScore(extractEpisodeTitle(ep.episodeTitle), platform) > 0);
  }
  if (platformEpisodes.length === 0) return null;
  
  for (const ep of platformEpisodes) {
    const extractedNumber = extractEpisodeNumberFromTitle(ep.episodeTitle);
    if (episode === targetEpisode && extractedNumber === targetEpisode) return ep;
  }
  if (platformEpisodes.length >= targetEpisode) return platformEpisodes[targetEpisode - 1];
  for (const ep of platformEpisodes) {
    if (ep.episodeNumber && parseInt(ep.episodeNumber, 10) === targetEpisode) return ep;
  }
  return null;
}

async function matchAniAndEpByAi(season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, detailStore = null) {
  const aiBaseUrl = globals.aiBaseUrl;
  const aiModel = globals.aiModel;
  const aiApiKey = globals.aiApiKey;
  const aiMatchPrompt = globals.aiMatchPrompt;

  if (!globals.aiValid || !aiMatchPrompt) return { resEpisode: null, resAnime: null };

  const aiClient = new AIClient({ apiKey: aiApiKey, baseURL: aiBaseUrl, model: aiModel, systemPrompt: aiMatchPrompt });
  const matchData = {
    title, season, episode, year, dynamicPlatformOrder, preferAnimeId,
    animes: searchData.animes.map(anime => ({
      animeId: anime.animeId, animeTitle: anime.animeTitle?.split("(")[0].trim(),
      aliases: anime.aliases || [], type: anime.type, year: anime.startDate?.slice(0, 4),
      episodeCount: anime.episodeCount, source: anime.source
    }))
  };

  try {
    const userPrompt = JSON.stringify(matchData, null, 2);
    const aiResponse = await aiClient.ask(userPrompt);
    log("info", `AI response: ${aiResponse}`);

    let parsedResponse;
    try {
      // 【优化点2】最强JSON提取正则，无视一切杂质
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      parsedResponse = JSON.parse(jsonMatch ? jsonMatch[0] : aiResponse);
    } catch (parseError) {
      log("error", `AI response invalid JSON: ${parseError.message}`);
      return { resEpisode: null, resAnime: null };
    }

    const animeIndex = parsedResponse.animeIndex;
    if (animeIndex === null || animeIndex === undefined || !searchData.animes[animeIndex]) {
      return { resEpisode: null, resAnime: null };
    }

    const selectedAnime = searchData.animes[animeIndex];

    // 【优化点3】聚合源强制拦截机制
    const preferredPlatformSources = ['bilibili', 'tencent', 'iqiyi', 'youku', 'qq', 'qiyi'];
    const isAggregateOnly = !preferredPlatformSources.some(p => (selectedAnime.source || "").toLowerCase().includes(p));
    
    if (isAggregateOnly && dynamicPlatformOrder?.length > 0) {
      const hasPreferredPlatformAnime = searchData.animes.some(a =>
        preferredPlatformSources.some(p => (a.source || "").toLowerCase().includes(p))
      );
      if (hasPreferredPlatformAnime) {
        log("warn", `AI选了纯聚合源 ${selectedAnime.source}，强制回退找大厂`);
        return { resEpisode: null, resAnime: null };
      }
    }

    const bangumiData = getBangumiDataForMatch(selectedAnime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) return { resEpisode: null, resAnime: null };

    let filteredEpisode = null;
    if (season && episode) {
        const filteredEpisodes = filterSameEpisodeTitle(bangumiData.bangumi.episodes.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle)));
        filteredEpisode = findEpisodeByNumber(filteredEpisodes, episode, episode);
    } else {
        if (bangumiData.bangumi.episodes.length > 0) filteredEpisode = bangumiData.bangumi.episodes[0];
    }

    return { resEpisode: filteredEpisode, resAnime: selectedAnime };
  } catch (error) {
    log("error", `AI match failed: ${error.message}`);
    return { resEpisode: null, resAnime: null };
  }
}

function getBangumiDataForMatch(anime, detailStore = null) {
  const detailAnime = resolveAnimeById(anime?.bangumiId, detailStore, anime?.source) || resolveAnimeById(anime?.animeId, detailStore, anime?.source);
  if (!detailAnime) return null;
  return buildBangumiData(detailAnime, anime?.bangumiId || anime?.animeId || "");
}

function computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode) {
  const match = offsets[String(season)].match(/^([^:]+):(.+)$/);
  const offsetIndex = filteredEpisodes.findIndex(ep => ep.episodeTitle === (match?.[2] || ''));
  if (offsetIndex !== -1) targetEpisode = offsetIndex + (episode - (Number(match?.[1]) || 0)) + 1;
  return targetEpisode;
}

async function matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore = null) {
  let bestRes = { anime: null, episode: null, score: -9999 };
  const normalizedTitle = normalizeSpaces(title);

  for (const anime of searchData.animes) {
    const animeIsNotPrefer = globals.rememberLastSelect && preferAnimeId && String(anime.bangumiId) !== String(preferAnimeId) && String(anime.animeId) !== String(preferAnimeId);
    if (animeIsNotPrefer) continue;

    let isMatch = false;
    const candidateTitles = [anime.animeTitle, ...(anime.aliases || [])];

    for (const candTitle of candidateTitles) {
        if (!candTitle) continue;
        if (season && episode) {
            if (normalizeSpaces(candTitle).includes(normalizedTitle)) {
                if (!matchYear(anime, year)) continue;
                const animeIsPrefer = globals.rememberLastSelect && preferAnimeId && (String(anime.bangumiId) === String(preferAnimeId) || String(anime.animeId) === String(preferAnimeId));
                if (matchSeason({ ...anime, animeTitle: candTitle }, title, season) || animeIsPrefer) { isMatch = true; break; }
            }
        } else {
            if (candTitle.split("(")[0].trim() === title) {
                if (!matchYear(anime, year)) continue;
                isMatch = true; break;
            }
        }
    }

    if (!isMatch) continue;

    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) continue;

    let matchedEpisode = null;
    if (season && episode) {
        const filteredEpisodes = filterSameEpisodeTitle(bangumiData.bangumi.episodes.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle)));
        let targetEpisode = episode;
        if (offsets && offsets[String(season)]) targetEpisode = computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode);
        matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, platform);
    } else {
        if (bangumiData.bangumi.episodes.length > 0) {
            matchedEpisode = platform ? bangumiData.bangumi.episodes.find(ep => getPlatformMatchScore(extractEpisodeTitle(ep.episodeTitle), platform) > 0) || bangumiData.bangumi.episodes[0] : bangumiData.bangumi.episodes[0];
        }
    }

    if (matchedEpisode) {
        let currentScore = platform ? getPlatformMatchScore(extractPlatformFromTitle(anime.animeTitle) || anime.source, platform) : 1;
        if (currentScore > bestRes.score) bestRes = { anime, episode: matchedEpisode, score: currentScore };
        if (!platform) break; 
    }
  }
  return { resEpisode: bestRes.episode, resAnime: bestRes.anime };
}

async function fallbackMatchAniAndEp(searchData, req, season, episode, year, resEpisode, resAnime, offsets, detailStore = null) {
  for (const anime of searchData.animes) {
    if (year && !matchYear(anime, year)) continue;
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes) continue;
    
    if (season && episode) {
      const filteredEpisodes = filterSameEpisodeTitle(bangumiData.bangumi.episodes.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle)));
      let targetEpisode = episode;
      if (offsets && offsets[String(season)]) targetEpisode = computeTargetEpisode(offsets, season, episode, filteredEpisodes, targetEpisode);
      const matchedEpisode = findEpisodeByNumber(filteredEpisodes, episode, targetEpisode, null);
      if (matchedEpisode) { resEpisode = matchedEpisode; resAnime = anime; break; }
    } else {
      if (bangumiData.bangumi.episodes.length > 0) { resEpisode = bangumiData.bangumi.episodes[0]; resAnime = anime; break; }
    }
  }
  return {resEpisode, resAnime};
}

export async function extractTitleSeasonEpisode(cleanFileName) {
  const regex = /^(.+?)[.\s]+S(\d+)E(\d+)/i;
  const match = cleanFileName.match(regex);
  let title, season, episode, year;
  const yearMatch = cleanFileName.match(/(?:\.|\(|（)((?:19|20)\d{2})(?:\)|）|\.|$)/);
  if (yearMatch) year = parseInt(yearMatch[1], 10);

  if (match) {
    title = match[1].trim();
    season = parseInt(match[2], 10);
    episode = parseInt(match[3], 10);

    const chineseStart = title.match(/^[\u4e00-\u9fa5·]+[^.\r\n]*/);
    if (chineseStart) title = chineseStart[0];
    else if (/^[A-Za-z0-9]/.test(title)) {
      const engMatch = title.match(/^([A-Za-z0-9.&\s]+?)(?=\.\d{4}|$)/);
      if (engMatch) title = engMatch[1].trim().replace(/[._]/g, ' ');
    } else {
      const beforeYear = title.split(/\.(?:19|20)\d{2}|2160p|1080p|720p|H265|iPhone/)[0];
      const chineseInMixed = beforeYear.match(/^[\u4e00-\u9fa5·]+/);
      title = chineseInMixed ? chineseInMixed[0] : beforeYear.trim();
    }
    title = title.replace(/\.\d{4}$/i, '').trim();
  } else {
    const titleRegex = /^([^.\s]+(?:[.\s][^.\s]+)*?)(?:[.\s](?:\d{4}|(?:19|20)\d{2}|\d{3,4}p|S\d+|E\d+|WEB|BluRay|Blu-ray|HDTV|DVDRip|BDRip|x264|x265|H\.?264|H\.?265|AAC|AC3|DDP|TrueHD|DTS|10bit|HDR|60FPS))/i;
    const titleMatch = cleanFileName.match(titleRegex);
    title = titleMatch ? titleMatch[1].replace(/[._]/g, ' ').trim() : cleanFileName;
  }

  if (globals.titleToChinese) title = await getTMDBChineseTitle(title.replace('.', ' '), season, episode);
  return {title, season, episode, year};
}

export async function matchAnime(url, req, clientIp) {
  try {
    const body = await req.json();
    if (!body || !body.fileName) return jsonResponse({ errorCode: 400, success: false, errorMessage: "Missing body or fileName" }, 400);

    const { cleanFileName, preferredPlatform } = parseFileName(body.fileName);
    let {title, season, episode, year} = await extractTitleSeasonEpisode(cleanFileName);

    if (globals.titleMappingTable && globals.titleMappingTable.size > 0) {
      if (globals.titleMappingTable.get(title)) title = globals.titleMappingTable.get(title);
    }
    if (globals.animeTitleSimplified) title = simplized(title);

    const [preferAnimeId, preferSource, offsets] = getPreferAnimeId(title, season);
    const requestAnimeDetailsMap = new Map();
    let originSearchUrl = new URL(req.url.replace("/match", `/search/anime?keyword=${title}`));
    
    const searchRes = await searchAnime(originSearchUrl, preferAnimeId, preferSource, requestAnimeDetailsMap);
    const searchData = await searchRes.json();

    let resAnime, resEpisode;
    let resData = { "errorCode": 0, "success": true, "errorMessage": "", "isMatched": false, "matches": [] };
    const dynamicPlatformOrder = createDynamicPlatformOrder(preferredPlatform);

    // AI匹配调用
    const aiMatchResult = await matchAniAndEpByAi(season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, requestAnimeDetailsMap);
    
    // 【优化点4】防止 137 集空指针崩溃
    if (aiMatchResult.resAnime && aiMatchResult.resEpisode) {
      resAnime = aiMatchResult.resAnime;
      resEpisode = aiMatchResult.resEpisode;
      resData["isMatched"] = true;
      log("info", `AI match found: ${resAnime.animeTitle}`);
    } else {
      log("info", "AI未找到有效动漫或剧集，执行传统智能回退...");
      for (const platform of dynamicPlatformOrder) {
        const __ret = await matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, requestAnimeDetailsMap);
        resEpisode = __ret.resEpisode; resAnime = __ret.resAnime;
        if (resAnime) { resData["isMatched"] = true; break; }
      }
      if (!resAnime) {
        const __ret = await fallbackMatchAniAndEp(searchData, req, season, episode, year, resEpisode, resAnime, offsets, requestAnimeDetailsMap);
        resEpisode = __ret.resEpisode; resAnime = __ret.resAnime;
      }
    }

    if (resEpisode) {
      if (clientIp) setLastSearch(clientIp, { title, season, episode, episodeId: resEpisode.episodeId });
      resData["matches"] = [AnimeMatch.fromJson({
        "episodeId": resEpisode.episodeId, "animeId": resAnime.animeId, "animeTitle": resAnime.animeTitle,
        "episodeTitle": resEpisode.episodeTitle, "type": resAnime.type, "typeDescription": resAnime.typeDescription,
        "shift": 0, "imageUrl": resAnime.imageUrl
      })];
    }
    return jsonResponse(resData);
  } catch (error) {
    log("error", `Failed to parse request: ${error.message}`);
    return jsonResponse({ errorCode: 400, success: false, errorMessage: "Invalid request body" }, 400);
  }
}

export async function searchEpisodes(url) {
  let anime = url.searchParams.get("anime");
  const episode = url.searchParams.get("episode") || "";
  if (globals.animeTitleSimplified) anime = simplized(anime);
  if (!anime) return jsonResponse({ errorCode: 400, success: false, errorMessage: "Missing anime parameter" }, 400);

  const requestAnimeDetailsMap = new Map();
  const searchRes = await searchAnime(new URL(`/search/anime?keyword=${anime}`, url.origin), null, null, requestAnimeDetailsMap);
  const searchData = await searchRes.json();

  if (!searchData.success || !searchData.animes || searchData.animes.length === 0) return jsonResponse({ errorCode: 0, success: true, errorMessage: "", hasMore: false, animes: [] });

  let resultAnimes = [];
  for (const animeItem of searchData.animes) {
    const detailAnime = resolveAnimeById(animeItem.bangumiId, requestAnimeDetailsMap, animeItem.source) || resolveAnimeById(animeItem.animeId, requestAnimeDetailsMap, animeItem.source);
    let bangumiData = detailAnime ? buildBangumiData(detailAnime, animeItem.bangumiId) : await (await getBangumi(new URL(`/bangumi/${animeItem.bangumiId}`, url.origin).pathname)).json();

    if (bangumiData.success && bangumiData.bangumi && bangumiData.bangumi.episodes) {
      let filteredEpisodes = bangumiData.bangumi.episodes;
      if (episode) {
        if (episode === "movie") filteredEpisodes = filteredEpisodes.filter(ep => animeItem.typeDescription?.includes("电影") || ep.episodeTitle.includes("剧场版"));
        else if (/^\d+$/.test(episode)) filteredEpisodes = filteredEpisodes.filter(ep => parseInt(ep.episodeNumber) === parseInt(episode));
      }
      if (filteredEpisodes.length > 0) resultAnimes.push(Episodes.fromJson({ animeId: animeItem.animeId, animeTitle: animeItem.animeTitle, type: animeItem.type, typeDescription: animeItem.typeDescription, episodes: filteredEpisodes.map(ep => ({ episodeId: ep.episodeId, episodeTitle: ep.episodeTitle })) }));
    }
  }
  return jsonResponse({ errorCode: 0, success: true, errorMessage: "", animes: resultAnimes });
}

export async function getBangumi(path, detailStore = null, source = null) {
  const idParam = path.split("/").pop();
  const anime = resolveAnimeByIdFromDetailStore(idParam, detailStore, source) || resolveAnimeById(idParam);
  if (!anime) return jsonResponse({ errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null }, 404);
  return jsonResponse(buildBangumiData(anime, idParam));
}

function buildBangumiData(anime, idParam = "") {
  let episodesList = anime.links.map((link, i) => ({ seasonId: `season-${anime.animeId}`, episodeId: link.id, episodeTitle: `${link.title}`, episodeNumber: `${i+1}`, airDate: anime.startDate }));
  if (globals.enableAnimeEpisodeFilter) episodesList = episodesList.filter(ep => !globals.episodeTitleFilter.test(ep.episodeTitle)).map((ep, i) => ({ ...ep, episodeNumber: `${i+1}` }));
  const bangumi = Bangumi.fromJson({
    animeId: anime.animeId, bangumiId: anime.bangumiId, animeTitle: anime.animeTitle, imageUrl: anime.imageUrl, isOnAir: true, airDay: 1, isFavorited: anime.isFavorited, rating: anime.rating, type: anime.type, typeDescription: anime.typeDescription,
    seasons: [{ id: `season-${anime.animeId}`, airDate: anime.startDate, name: "Season 1", episodeCount: anime.episodeCount }], episodes: episodesList,
  });
  return { errorCode: 0, success: true, errorMessage: "", bangumi: bangumi };
}

async function fetchMergedComments(url, animeTitle, commentId) {
  const parts = url.split(MERGE_DELIMITER);
  const partMetas = parts.map((part) => {
    const idx = part.indexOf(':');
    if (idx === -1) return { realId: '', logicalSource: '', sourceLabel: '' };
    const sn = part.substring(0, idx); const ri = part.substring(idx + 1);
    return sn !== 'hanjutv' ? { realId: ri, logicalSource: sn, sourceLabel: sn } : { realId: ri, logicalSource: 'hanjutv', sourceLabel: getHanjutvSourceLabel(ri) };
  });
  const sourceNames = partMetas.map(m => m.logicalSource).filter(Boolean);
  const realIds = partMetas.map(m => m.realId);
  const sourceTag = partMetas.map(m => m.sourceLabel).filter(Boolean).join('＆');

  const cached = getCommentCache(url);
  if (cached) return cached;

  const stats = {};
  const tasks = partMetas.map(async (meta) => {
    if (!meta.logicalSource || !meta.realId) return [];
    const pKey = `${meta.logicalSource}:${meta.realId}`;
    if (PENDING_DANMAKU_REQUESTS.has(pKey)) { try { return await PENDING_DANMAKU_REQUESTS.get(pKey) || []; } catch(e) { return []; } }
    
    const fetchTask = (async () => {
      let inst = { 'renren': renrenSource, 'hanjutv': hanjutvSource, 'bahamut': bahamutSource, 'dandan': dandanSource, 'tencent': tencentSource, 'youku': youkuSource, 'iqiyi': iqiyiSource, 'imgo': mangoSource, 'bilibili': bilibiliSource, 'migu': miguSource, 'sohu': sohuSource, 'leshi': leshiSource, 'xigua': xiguaSource, 'maiduidui': maiduiduiSource, 'aiyifan': aiyifanSource, 'animeko': animekoSource }[meta.logicalSource];
      if (inst) {
        try {
          const raw = await inst.getEpisodeDanmu(meta.realId, parts);
          const fmt = inst.formatComments(raw);
          if (Array.isArray(fmt)) fmt.forEach(i => { if(!i._sourceLabel) i._sourceLabel = meta.sourceLabel || meta.logicalSource; });
          stats[meta.sourceLabel || meta.logicalSource] = fmt.length;
          return fmt;
        } catch(e) { stats[meta.sourceLabel || meta.logicalSource] = 0; return []; }
      }
      return [];
    })();
    PENDING_DANMAKU_REQUESTS.set(pKey, fetchTask);
    try { return await fetchTask; } finally { PENDING_DANMAKU_REQUESTS.delete(pKey); }
  });

  const results = await Promise.all(tasks);
  alignSourceTimelines(results, sourceNames, realIds);

  if (globals.danmuOffsetRules?.length > 0 && animeTitle && commentId) {
    const [, , episodeTitle] = findAnimeIdByCommentId(commentId);
    if (episodeTitle) {
      let { baseTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
      season ||= 1; episode ||= findIndexById(commentId) + 1;
      const sStr = `S${season.toString().padStart(2, '0')}`; const eStr = `E${episode.toString().padStart(2, '0')}`;
      for (let idx = 0; idx < results.length; idx++) {
        const off = resolveOffsetRule(globals.danmuOffsetRules, { anime: baseTitle, season: sStr, episode: eStr, source: sourceNames[idx] });
        if (off?.offset) results[idx] = applyOffset(results[idx], off.offset, { usePercent: off.usePercent, videoDuration: off.usePercent ? await resolveUrlDuration(realIds[idx]) : 0 });
      }
    }
  }

  let mergedList = [];
  results.forEach(list => { mergedList = mergeDanmakuList(mergedList, list); });
  return convertToDanmakuJson(mergedList, sourceTag);
}

export async function getComment(path, queryFormat, segmentFlag, clientIp, includeDuration = false) {
  const commentId = parseInt(path.split("/").pop());
  let animeTitle = findAnimeTitleById(commentId);
  let url = findUrlById(commentId);
  let title = findTitleById(commentId);
  let plat = title ? (title.match(/【(.*?)】/) || [null])[0]?.replace(/[【】]/g, '') : null;
  const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);

  if (!url) return jsonResponse({ count: 0, comments: [] }, 404);

  const cachedComments = getCommentCache(url);
  if (cachedComments !== null) return formatDanmuResponse(buildDanmuResponse({ count: cachedComments.length, comments: cachedComments }, shouldAttachDuration ? await resolveMergedDuration(url) : null), queryFormat);

  let danmus = [];
  const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;

  if (url && url.includes(MERGE_DELIMITER)) danmus = await fetchMergedComments(url, animeTitle, commentId);
  else {
    const domains = { 'qq': tencentSource, 'qiyi': iqiyiSource, 'imgo': mangoSource, 'bilibili1': bilibiliSource, 'youku': youkuSource, 'migu': miguSource, 'sohu': sohuSource, 'leshi': leshiSource, 'xigua': xiguaSource, 'maiduidui': maiduiduiSource, 'aiyifan': aiyifanSource };
    let matchedDomain = false;
    for (const [key, sourceInst] of Object.entries(domains)) {
      if (url.includes(`.${key === 'bilibili1' ? 'bilibili' : key.replace('1','').replace('imgo','mgtv').replace('qiyi','iqiyi')}.com`) || (key === 'bilibili1' && url.includes('b23.tv'))) {
        if (key === 'bilibili1' && url.includes('b23.tv')) url = await bilibiliSource.resolveB23Link(url);
        danmus = await sourceInst.getComments(url, plat, segmentFlag);
        matchedDomain = true; break;
      }
    }
    if (!matchedDomain) {
      if (plat === "renren") danmus = await renrenSource.getComments(url, plat, segmentFlag);
      else if (plat === "hanjutv") danmus = await hanjutvSource.getComments(url, plat, segmentFlag);
      else if (plat === "bahamut") danmus = await bahamutSource.getComments(url, plat, segmentFlag);
      else if (plat === "dandan") danmus = await dandanSource.getComments(url, plat, segmentFlag);
      else if (plat === "custom") danmus = await customSource.getComments(url, plat, segmentFlag);
      else if (plat === "animeko") danmus = await animekoSource.getComments(url, plat, segmentFlag);
      else if (/^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i.test(url)) danmus = await otherSource.getComments(url, "other_server", segmentFlag);
    }
  }

  const [animeId, source, episodeTitle] = findAnimeIdByCommentId(commentId);
  if (animeId && source) {
    let lastTitle = null, lastSeason = null, offset = null;
    if (clientIp) {
      const lastSearch = getLastSearch(clientIp);
      if (lastSearch && lastSearch.title && lastSearch.season && lastSearch.episode && episodeTitle) {
        lastTitle = lastSearch.title; lastSeason = lastSearch.season; offset = `${lastSearch.episode}:${episodeTitle}`;
      }
    }
    if (titleMatches(animeTitle, lastTitle)) setPreferByAnimeId(animeId, source, lastSeason, offset);
    if (globals.localCacheValid && animeId) writeCacheToFile('lastSelectMap', JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
    if (globals.redisValid && animeId) setRedisKey('lastSelectMap', globals.lastSelectMap).catch(e=>{});
    if (globals.localRedisValid && animeId) setLocalRedisKey('lastSelectMap', globals.lastSelectMap);
  }

  if (animeTitle && episodeTitle && globals.danmuOffsetRules?.length > 0 && !(url && url.includes(MERGE_DELIMITER))) {
    let { baseTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
    season ||= 1; episode ||= findIndexById(commentId) + 1;
    const off = resolveOffsetRule(globals.danmuOffsetRules, { anime: baseTitle, season: `S${season.toString().padStart(2, '0')}`, episode: `E${episode.toString().padStart(2, '0')}`, source });
    if (off?.offset) danmus = applyOffset(danmus, off.offset, { usePercent: off.usePercent, videoDuration: off.usePercent ? await resolveUrlDuration(url) : 0 });
  }

  if (!segmentFlag && danmus) {
    if (danmus.comments) danmus = danmus.comments;
    if (Array.isArray(danmus) && danmus.length > 0) setCommentCache(url, danmus);
  }

  return formatDanmuResponse(buildDanmuResponse({ count: danmus?.length || 0, comments: danmus || [] }, durationPromise ? await durationPromise : null), queryFormat);
}

export async function getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration = false) {
  try {
    if (!videoUrl || typeof videoUrl !== 'string' || !videoUrl.trim().startsWith('http')) return jsonResponse({ errorCode: 400, success: false, errorMessage: "Invalid url", count: 0, comments: [] }, 400);
    let url = videoUrl.trim();
    const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) return formatDanmuResponse(buildDanmuResponse({ errorCode: 0, success: true, count: cachedComments.length, comments: cachedComments }, shouldAttachDuration ? await resolveMergedDuration(url) : null), queryFormat);

    let danmus = [];
    const durationPromise = shouldAttachDuration ? resolveMergedDuration(url) : null;
    
    // 省略中间获取逻辑同 getComment...
    const domains = { 'qq': tencentSource, 'qiyi': iqiyiSource, 'imgo': mangoSource, 'bilibili1': bilibiliSource, 'youku': youkuSource, 'migu': miguSource, 'sohu': sohuSource, 'leshi': leshiSource, 'xigua': xiguaSource, 'maiduidui': maiduiduiSource, 'aiyifan': aiyifanSource };
    let matchedDomain = false;
    for (const [key, sourceInst] of Object.entries(domains)) {
      if (url.includes(`.${key === 'bilibili1' ? 'bilibili' : key.replace('1','').replace('imgo','mgtv').replace('qiyi','iqiyi')}.com`) || (key === 'bilibili1' && url.includes('b23.tv'))) {
        if (key === 'bilibili1' && url.includes('b23.tv')) url = await bilibiliSource.resolveB23Link(url);
        danmus = await sourceInst.getComments(url, key, segmentFlag);
        matchedDomain = true; break;
      }
    }
    if (!matchedDomain && /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i.test(url)) danmus = await otherSource.getComments(url, "other_server", segmentFlag);

    if (danmus.length > 0) setCommentCache(url, danmus);
    return formatDanmuResponse(buildDanmuResponse({ errorCode: 0, success: true, count: danmus.length, comments: danmus }, durationPromise ? await durationPromise : null), queryFormat);
  } catch (error) { return jsonResponse({ errorCode: 500, success: false, count: 0, comments: [] }, 500); }
}

export async function getSegmentComment(segment, queryFormat) {
  try {
    let url = segment.url; let platform = segment.type;
    if (!url || typeof url !== 'string') return jsonResponse({ errorCode: 400, success: false, count: 0, comments: [] }, 400);
    url = url.trim();
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) return formatDanmuResponse({ errorCode: 0, success: true, count: cachedComments.length, comments: cachedComments }, queryFormat);

    let danmus = [];
    const insts = { "qq": tencentSource, "qiyi": iqiyiSource, "imgo": mangoSource, "bilibili1": bilibiliSource, "youku": youkuSource, "migu": miguSource, "sohu": sohuSource, "leshi": leshiSource, "xigua": xiguaSource, "maiduidui": maiduiduiSource, "aiyifan": aiyifanSource, "hanjutv": hanjutvSource, "bahamut": bahamutSource, "renren": renrenSource, "dandan": dandanSource, "animeko": animekoSource, "custom": customSource, "other_server": otherSource };
    if (insts[platform]) danmus = await insts[platform].getSegmentComments(segment);

    if (danmus.length > 0) setCommentCache(url, danmus);
    return formatDanmuResponse({ errorCode: 0, success: true, count: danmus.length, comments: danmus }, queryFormat);
  } catch (error) { return jsonResponse({ errorCode: 500, success: false, count: 0, comments: [] }, 500); }
}


```
