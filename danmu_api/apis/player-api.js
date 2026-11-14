import { resolveSourceLocation } from '../sources/location.js';
import { runWithCommentTransform } from '../utils/comment-context.js';
import { resolveTmdbMatchIdentity, filterTmdbMatchCandidates, findSavedTmdbIdentity, resolveTmdbEpisodeMetadata, selectTmdbEpisode, selectVarietyEpisodeByKey, varietyKey } from '../utils/tmdb-match-util.js';
import { SUPPORTED_SOURCES, isSupportedSource, sourceForUrl } from '../sources/policy.js';
import { movieAudioVersion, stripMovieAudioTags, selectMovieVersions } from '../utils/movie-version-util.js';
import { askAi, extractJsonObject } from '../utils/ai-util.js';
import { canonicalPlatformName } from '../utils/platform-util.js';
import { runWithMatchTrace, traceMatchStep, getMatchTracePrefix } from '../utils/match-trace-util.js';
import { globals } from '../configs/globals.js';
import { createUgcLogger, ugcSupplement, isUgcApplicable, buildUgcRequestContext, pickUgcEpisode, mergeUgcComments, ugcEpisodeTitles } from '../utils/bilibili-ugc-util.js';
import { getPageTitle, jsonResponse, sourceLogContext, runWithHttpCache, httpCacheContext } from '../utils/http-util.js';
import { log } from '../utils/log-util.js';
import { logEvent } from '../utils/log-util.js';
import { simplized } from '../utils/zh-util.js';

import { updateLocalRedisCaches } from "../utils/local-redis-util.js";
import { setCommentCache, addAnime, addEpisode, getPreferAnimeId, getSearchCache, removeEarliestAnime, resolveAnimeById, resolveAnimeByIdFromDetailStore, setSearchCache, storeAnimeIdsToMap, updateLocalCaches, setLastSearch, getLastSearch, hasSeasonSpecificPreference, getAddAnimeError, mergeAddAnimeError } from "../utils/cache-util.js";

import { convertToDanmakuJson } from "../utils/danmu-util.js";
import { stripLinkOffset } from "../utils/offset-util.js";
import { applySearchKeywordMapping, ensureRemoteTitleMapping, ensureCachedRemoteTitleMapping, resolveLocalTitleMapping, resolveCachedRemoteTitleMapping } from "../utils/title-mapping-url-util.js";
import { filterMappingQualifierCandidates, filterMappingTargetCandidates, collectAutoMatchCandidates } from "../utils/auto-match-mapping-util.js";
import { ensureRemoteAutoMatchMapping, getCachedRemoteAutoMatchMappingRules } from "../utils/auto-match-mapping-url-util.js";
import { extractEpisodeTitle, convertChineseNumber, parseFileName, extractReleaseGroups, createDynamicPlatformOrder, normalizeTitleForMatch, extractYear, workIdentityConflict, titleMatches, extractEpisodeNumberFromTitle, extractSeasonNumberFromAnimeTitle, extractAnimeTitle, buildTitleKeywordQueries, compoundTitleMatches, getExplicitSeasonNumber } from "../utils/common-util.js";
import { getTmdbMediaTitleById, getTmdbSeasonBoundaries } from "../utils/tmdb-util.js";
import { applyMergeLogic, MERGE_DELIMITER } from "../utils/merge-util.js";


import { getSourceMetaByKey, getLogNameByKey } from "../sources/registry.js";
import { isHongguoPlayerUrl } from "../sources/hongguo.js";
import { Anime, AnimeMatch, Episodes, Bangumi } from "../models/player-model.js";

import { resolveCommentCacheKey, fetchMergedComments, supplementUgcForEpisode } from './comment-api.js';
export { getComment, getCommentByUrl, getSegmentComment } from './comment-api.js';

// =====================
// 兼容弹弹play接口
// =====================

// 匹配阶段用 B站投稿兜底时的检索预算：这段时间是播放器在等匹配结果，固定 5 秒——
// 既不跟随弹幕阶段的 BILIBILI_UGC_BUDGET_MS，也不作为配置项暴露。
const UGC_MATCH_BUDGET_MS = 5000;

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

/**
 * 校验电影分集是否为真正的正片；排除纯预告、特辑、片段、花絮、新闻等非正片视频。
 */
export function isMovieFeatureFilmEpisode(ep, anime) {
  if (!ep || !ep.episodeTitle) return false;
  const cleanEpTitle = String(ep.episodeTitle).replace(/^【.*?】|^\[.*?\]/, '').trim();
  if (!cleanEpTitle) return true;

  // 1. 明确的正片标识词
  const featureTagRegex = /^(?:正片|电影正片|原片|完整版|公映版|剧场版正片|movie|film)(?:[（(].*?[）)])?$/i;
  if (featureTagRegex.test(cleanEpTitle)) return true;

  // 2. 明确的非正片标识词（预告/花絮/特辑/片段/新闻/战报等）
  const nonFeatureRegex = /预告|特辑|花絮|片段|幕后|采访|专访|首映|发布会|MV|推广曲|主题曲|预售|定档|开机|杀青|票房|战报|登顶|路透|高光|速看|看点|回顾|解说|点评|彩蛋/i;
  if (nonFeatureRegex.test(cleanEpTitle)) return false;

  // 平台常用配音版本代替片名；只接受完整版本标签，不接受带宣传描述的标题。
  const versionLabel = /^(?:普通|普通话|普通話|国语|國語|粤语|粵語|中文|日语|日語|英语|英語|原声|原聲|原)(?:版)?$/;
  if (versionLabel.test(cleanEpTitle)) return true;

  // 3. 分集标题等于电影标题或别名
  const animeTitle = extractAnimeTitle(anime?.animeTitle || '');
  const normAnime = normalizeTitleForMatch(animeTitle);
  const normEp = normalizeTitleForMatch(cleanEpTitle);

  if (normAnime && normEp === normAnime) return true;
  if (Array.isArray(anime?.aliases) && anime.aliases.some(a => normalizeTitleForMatch(a) === normEp)) return true;

  const withoutVersion = cleanEpTitle.replace(/\s*[（(]?(?:普通话|普通話|国语|國語|粤语|粵語|中文|英语|英語|原声|原聲|原)(?:版)?[）)]?\s*$/, '').trim();
  if (normAnime && normalizeTitleForMatch(withoutVersion) === normAnime) return true;

  // 4. 标题为电影名加上正片/版本修饰后缀（如 "流浪地球2 正片"、"流浪地球2 4K"）
  const strippedEp = cleanEpTitle.replace(/(?:正片|完整版|公映版|原片|国语版|粤语版|原声版|中字|双语|1080p|4k|超清|高清).*$/i, '').trim();
  if (normAnime && normalizeTitleForMatch(strippedEp) === normAnime) return true;

  // 5. 常见电影单集标识：如 "1"、"01"、"第1集"、"全1集"
  if (/^(?:第\s*0*1\s*集|全\s*0*1\s*集|0*1)$/.test(cleanEpTitle)) return true;

  return false;
}

// 计算对外上报的集数：过滤只会减少可用集数，平台声明值更小时以声明值为准
export function resolveEpisodeCount(declaredCount, availableCount) {
  const declared = Number(declaredCount) || 0;
  const available = Number(availableCount) || 0;
  if (available <= 0) return declared;
  return declared > 0 ? Math.min(declared, available) : available;
}

// 按集标题过滤剧集，所有需要过滤的位置统一走这里
export function filterEpisodesByTitle(episodes) {
  return episodes.filter(episode => !globals.episodeTitleFilter.test(episode.episodeTitle));
}

// 按集标题过滤链接，并把过滤后的可用集数写回该动漫
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

  if (compoundTitleMatches(originalTitle, seasonQueryTitle)) {
    const candidateSeason = getExplicitSeasonNumber(originalTitle);
    return candidateSeason !== null ? candidateSeason === season : season === 1;
  }

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

// 无数字季号的目录需要分集季号证据，或带季限定的明确标题映射。
function matchEpisodeSeason(anime, queryTitle, season, detailStore, mappedTitleSeason = false) {
  const titles = [anime.animeTitle, ...(anime.aliases || [])];
  if (titles.some(title => extractSeasonNumberFromAnimeTitle(title).season !== null)) return false;
  const episodes = getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes || [];
  const query = normalizeTitleForMatch(queryTitle.replace(/\s*(?:最终季|完结季)$/, ''));
  const seasons = new Set();
  const numbers = new Set();
  for (const ep of episodes) {
    const raw = ep.episodeTitle.replace(/^【[^】]+】\s*/, '').trim();
    const numbered = raw.match(/^(.*?)\s*(?:第\s*)?(\d{1,2})\s*(?:季)?\s*[_\.\-]\s*(\d{1,3})(?:\s|$)/);
    if (!numbered || normalizeTitleForMatch(numbered[1]) !== query) continue;
    seasons.add(Number(numbered[2]));
    numbers.add(Number(numbered[3]));
  }
  if (seasons.size) return seasons.size === 1 && seasons.has(season) && numbers.size >= 2;
  // A season-qualified title rule explicitly identifies this standalone catalog.
  // Do not infer this from a generic title alias or override numbered seasons.
  const catalogTitle = anime.animeTitle.split(/[(（]/)[0].trim();
  return mappedTitleSeason && episodes.length > 0 &&
    normalizeTitleForMatch(catalogTitle) === normalizeTitleForMatch(queryTitle);
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
    targetPlatforms = targetPlatform.split('&').map(s => canonicalPlatformName(s.trim().toLowerCase())).filter(s => s);
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
      // 候选平台由番剧身份标签(标题 from 段或 source)与所挂集标签共同决定，同时兼容旧缓存中的平台别名
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
          .flatMap(p => p.split(/[&＆]/).map(s => canonicalPlatformName(s.trim().toLowerCase()))).filter(s => s))].join('&');

      if (tPlat !== '_any_' && getPlatformMatchScore(actualPlatform, tPlat) === 0) {
        continue;
      }

      platformHasData = true;
      providedSources.add(anime.source);

      if (bData?.success && bData.bangumi?.episodes) {
        const validEps = filterEpisodesByTitle(bData.bangumi.episodes);
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
async function executeSourceHandlers(resultData, queryTitle, targetAnimesList, requestAnimeDetailsMap, targetSeason, preferAnimeId = null, preferSource = null, sourceOrder = globals.sourceOrderArr) {
  // 仅处理resultData中存在数据的源，避免将undefined传入handleAnimes
  const activeSourceKeys = sourceOrder.filter(key => resultData[key] !== undefined);
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
  const existingAnimeIds = new Set(targetAnimesList.map(a => `${a.source || ''}:${a.animeId}`));

  for (let i = 0; i < sourceTasks.length; i++) {
    if (results[i].status === 'rejected') {
      log("error", `[system] [executeSourceHandlers] 源 ${sourceTasks[i].key} 处理失败: ${results[i].reason}`);
      continue;
    }

    const { animes: isolatedAnimes, detailStore: isolatedDetailStore } = sourceTasks[i];

    // 合并动漫结果列表（使用 Set 确保 O(1) 检索，优先源先入为主）
    for (const anime of isolatedAnimes) {
      const identityKey = `${anime.source || ''}:${anime.animeId}`;
      if (!existingAnimeIds.has(identityKey)) {
        targetAnimesList.push(anime);
        existingAnimeIds.add(identityKey);
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

function withEpisodeLookupTimeout(promise, source, deadline) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`单集查找等待超时，跳过慢源 ${source}`);
      error.code = 'EPISODE_LOOKUP_TIMEOUT';
      reject(error);
    }, Math.max(0, deadline - performance.now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function searchScopeCacheKey(key, searchSources) {
  return searchSources
    ? JSON.stringify(['match-sources', searchSources, globals.mergeSourcePairs, globals.customMergeRules, key]) : key;
}

// Extracted function for GET /api/v2/search/anime
export async function searchAnime(url, preferAnimeId = null, preferSource = null, detailStore = null, targetPlatform = null, forceRefresh = false, onProgress = null, sourceSearches = null, searchSources = null, clientIp = null, episodeLookupDeadline = null) {
  // 单次搜索请求内启用 HTTP 响应复用缓存: 作为各源通用的请求级复用安全网, 借助 AsyncLocalStorage 做请求级隔离
  const run = () => searchAnimeBody(url, preferAnimeId, preferSource, detailStore, targetPlatform, forceRefresh, onProgress, sourceSearches, searchSources, episodeLookupDeadline);
  const response = await (httpCacheContext.getStore() ? run() : runWithHttpCache(run));
  const previous = clientIp ? getLastSearch(clientIp) : null;
  const target = previous?.matchIdentity || previous?.failedMatch;
  const keyword = normalizeTitleForMatch(url.searchParams.get('keyword') || '');
  if (!target || Date.now() - previous.timestamp >= 180000 ||
      ![target.title, ...(target.tmdbIdentity?.aliases || [])].some(title => normalizeTitleForMatch(title) === keyword)) return response;
  const data = await response.json();
  if (!data.success || !Array.isArray(data.animes)) return jsonResponse(data, response.status);
  data.animes = data.animes.filter(anime => {
    if (anime.type === 'B站投稿' && !globals.bilibiliUgcEnabled) return false;
    const reason = workIdentityConflict(anime, target);
    if (reason) log('info', `[system] [search-reject] 已确认身份拒绝搜索候选：${anime.animeTitle}，原因=${reason}`);
    return !reason;
  });
  if (globals.bilibiliUgcEnabled) {
    for (const anime of globals.animes) {
      if (anime.type !== 'B站投稿' || workIdentityConflict(anime, target) ||
          !anime.aliases.some(title => normalizeTitleForMatch(title) === keyword) ||
          data.animes.some(item => item.animeId === anime.animeId && item.source === anime.source)) continue;
      const { links, ...item } = anime;
      data.animes.push(item);
    }
  }
  return jsonResponse(data, response.status);
}

async function searchAnimeBody(url, preferAnimeId = null, preferSource = null, detailStore = null, targetPlatform = null, forceRefresh = false, onProgress = null, sourceSearches = null, searchSources = null, episodeLookupDeadline = null) {
  const sourceOrder = searchSources ?? globals.sourceOrderArr;
  // Scoped searches never masquerade as complete manual-search caches.
  const scopedKey = key => searchScopeCacheKey(key, searchSources);
  let queryTitle = url.searchParams.get("keyword");
  const skipTitleMapping = url.searchParams.get('_skipTitleMapping') === '1';

  const originalSearchKeyword = queryTitle;
  if (!skipTitleMapping) {
    // 外部搜索维持原行为；/match 分层尝试会显式传入最终标题并禁止重复映射。
    await ensureRemoteTitleMapping();
    queryTitle = applySearchKeywordMapping(queryTitle);
  }
  const keywordWasMapped = queryTitle !== originalSearchKeyword;

  // 识别信息：随搜索响应一并返回，便于调试界面直接查看
  const recognitionInfo = {
    originalKeyword: String(originalSearchKeyword ?? ""),
    finalKeyword: queryTitle,
    mappingApplied: keywordWasMapped,
  };

  // 诊断回显：每次搜索都把「识别结果 + 各源命中情况」写回 [title-mapping] 日志分类
  const logMappingSearchOutcome = (animes, viaCache = false) => {
    const count = Array.isArray(animes) ? animes.length : 0;
    const kwDesc = keywordWasMapped
      ? `「${originalSearchKeyword}」映射为「${queryTitle}」`
      : `「${queryTitle}」（未触发映射）`;
    if (count === 0) {
      log("warn", `[system] [title-mapping] [search] 🔎 搜索 ${kwDesc} 结果: 0 条（各源均未找到${viaCache ? "，来自缓存" : ""}）`);
      return;
    }
    const bySource = {};
    for (const a of animes) {
      const src = a.source || "unknown";
      bySource[src] = (bySource[src] || 0) + 1;
    }
    const sourceSummary = Object.entries(bySource).map(([s, n]) => `${s}×${n}`).join(", ");
    const topTitles = animes.slice(0, 5).map((a, i) => `${i + 1}. ${a.animeTitle}`).join("；");
    log("info", `[system] [title-mapping] [search] 🔎 搜索 ${kwDesc} 结果: ${count} 条（${sourceSummary}${viaCache ? "，来自缓存" : ""}）→ ${topTitles}${count > 5 ? ` …等共 ${count} 条` : ""}`);
  };

  // 搜索词杂音清理：移除画质/配音/版本等杂音词后再提交源站搜索
  if (globals.titleNoiseFilter) {
    queryTitle = queryTitle.replace(globals.titleNoiseFilter, '').trim();
  }

  let querySeason = url.searchParams.get("season");
  querySeason = querySeason ? parseInt(querySeason, 10) : null;
  let queryEpisode = url.searchParams.get("episode");
  queryEpisode = queryEpisode ? parseInt(queryEpisode, 10) : null;
  let tmdbSeasonBoundaries = null;
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
  let canCacheLookup = episodeLookupDeadline === null;
  const cacheKey = querySeason !== null ? `${queryTitle}_S${querySeason}` : queryTitle;
  const resolveSearchAnimeDetail = anime =>
    resolveAnimeByIdFromDetailStore(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeByIdFromDetailStore(anime?.animeId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeById(anime?.bangumiId, requestAnimeDetailsMap, anime?.source) ||
    resolveAnimeById(anime?.animeId, requestAnimeDetailsMap, anime?.source);

  let cachedResults = forceRefresh ? null : getSearchCache(scopedKey(cacheKey), requestAnimeDetailsMap);

  // 如果带季度的特定缓存未命中，尝试获取不带季度的通用搜索缓存
  if (!forceRefresh && cachedResults === null && querySeason !== null) {
    const genericCachedResults = getSearchCache(scopedKey(queryTitle), requestAnimeDetailsMap);
    if (genericCachedResults !== null) {
      log("info", `[system] [searchAnime] Cache miss for ${cacheKey}, fallback to generic cache for ${queryTitle}`);
      cachedResults = genericCachedResults;
    }
  }

  if (cachedResults !== null) {
    let satisfied = checkEpisodeSatisfied(cachedResults, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform);
    if (satisfied) {
      logMappingSearchOutcome(cachedResults, true);
      return jsonResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        animes: withAvailableEpisodeCount(cachedResults, resolveSearchAnimeDetail),
        titleMappingInfo: recognitionInfo,
      });
    } else {
      // 当前季度缓存未能满足目标集数，尝试顺延加载后续季度的缓存拼接
      let currentS = querySeason + 1;
      let combinedCachedResults = [...cachedResults];
      let cacheMissed = false;

      while (!satisfied && !cacheMissed) {
        const nextCacheKey = `${queryTitle}_S${currentS}`;
        const nextCache = getSearchCache(scopedKey(nextCacheKey), requestAnimeDetailsMap);
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
        logMappingSearchOutcome(combinedCachedResults, true);
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

  const curAnimes = [];

  // 多链接合并解析：空格分隔的多个 URL → 聚合弹幕
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
  const spaceSeparatedUrls = queryTitle.split(/\s+/).filter(u => {
    const cleanUrl = stripLinkOffset(u).cleanUrl;
    return urlRegex.test(cleanUrl);
  });
  if (spaceSeparatedUrls.length >= 2) {
    if (spaceSeparatedUrls.some(u => !sourceForUrl(stripLinkOffset(u).cleanUrl))) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',animes:[]},400);
    const mergeParts = spaceSeparatedUrls.map((singleUrl) => {
      const { source, realId } = resolveSourceAndRealId(singleUrl);
      return source && isSupportedSource(source) ? `${source}:${realId}` : '';
    }).filter(Boolean);

    if (mergeParts.length >= 2) {
      const mergeUrl = mergeParts.join(MERGE_DELIMITER);

      // 逐链接获取网页标题，不可直连的平台跳过
      const titles = [];
      for (const singleUrl of spaceSeparatedUrls) {
        const { source } = resolveSourceAndRealId(singleUrl);
        if (source === 'bahamut') {
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
    if (!sourceForUrl(stripLinkOffset(queryTitle).cleanUrl)) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',animes:[]},400);
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
    });

    let platform = "unknown";
    if (queryTitle.includes(".qq.com")) {
      platform = "tencent";
    } else if (queryTitle.includes(".iqiyi.com")) {
      platform = "iqiyi";
    } else if (queryTitle.includes(".mgtv.com")) {
      platform = "imgo";
    } else if (queryTitle.includes(".youku.com")) {
      platform = "youku";
    } else if (queryTitle.includes(".bilibili.com") || queryTitle.includes('b23.tv')) {
      platform = "bilibili";
    } else if (queryTitle.includes('.miguvideo.com')) {
      platform = "migu";
    } else if (queryTitle.includes('.sohu.com')) {
      platform = "sohu";
    } else if (queryTitle.includes('.le.com')) {
      platform = "leshi";
    } else if (isHongguoPlayerUrl(queryTitle)) {
      platform = "hongguo";
    } else if (queryTitle.includes('ani.gamer.com.tw')) {
      platform = "bahamut";
    }

    // 提取 bahamut 的视频标识符（无法直连获取网页标题）
    if (!isSupportedSource(platform)) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',animes:[]},400);
    let extractedId = queryTitle;
    let pageTitle = queryTitle;
    if (platform === 'bahamut') {
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

  try {
    // 根据 sourceOrderArr 动态构建逐源管道：每个源形成独立的 search → handleAnimes 流水线
    log("info", `[system] [LogVar-API] Search sourceOrderArr: ${sourceOrder}`);

    // 存储各源搜索结果的容器，供S2+季度扩展逻辑读取
    const resultData = {};

    // 源Key到对应搜索Promise的映射：统一从注册表查实例与日志标签，新增源无需改此处分发
    const sourceSearchMap = {};
    for (const source of sourceOrder) {
      const meta = getSourceMetaByKey(source);
      if (!meta) {
        log("warn", `[system] [LogVar-API] 未注册的源键 "${source}"，已跳过`);
        continue;
      }
      const args = meta.extraSearchArgs ? [queryTitle, preferAnimeId, preferSource] : [queryTitle];
      const searchKey = JSON.stringify([source, ...args]);
      if (sourceSearches?.has(searchKey)) {
        log('info', '[system] [match-search] 复用本次请求的来源搜索: ' + source);
        sourceSearchMap[source] = sourceSearches.get(searchKey);
      } else {
        sourceSearchMap[source] = traceMatchStep(log, `来源 ${source} 搜索`, () =>
          sourceLogContext.run(meta.logName, () => meta.instance.search(...args)));
        sourceSearches?.set(searchKey, sourceSearchMap[source]);
      }
    }

    // 构建逐源管道：每个源 search 完成后，通过 executeSourceHandlers 处理 handleAnimes
    // 传入仅含当前源数据的 resultData，使 executeSourceHandlers 仅处理该源
    const completedSources = new Map();
    const pipelineTasks = sourceOrder.filter(source => sourceSearchMap[source]).map(source => {
      const isolatedAnimes = [];
      const isolatedDetailStore = new Map();
      const rawPipelinePromise = sourceSearchMap[source].then(async searchResult => {
        if (sourceSearches) searchResult = structuredClone(searchResult);
        resultData[source] = searchResult;
        await traceMatchStep(log, `来源 ${source} 分集目录处理`, () =>
          executeSourceHandlers({ [source]: searchResult }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource, sourceOrder));
        // 检索词可调整分隔写法，处理和最终选择始终校验原始完整作品。
        for (const keyword of buildTitleKeywordQueries(queryTitle)) {
          if (isolatedAnimes.length) break;
          const meta = getSourceMetaByKey(source);
          const args = meta.extraSearchArgs ? [keyword, preferAnimeId, preferSource] : [keyword];
          const key = JSON.stringify([source, ...args]);
          let pending = sourceSearches?.get(key);
          if (!pending) {
            log('info', `[system] [match-search] ${source} 主副标题关键词回退: ${keyword}`);
            pending = sourceLogContext.run(meta.logName, () => meta.instance.search(...args));
            sourceSearches?.set(key, pending);
          }
          const rows = structuredClone(await pending);
          resultData[source] = rows;
          await executeSourceHandlers({ [source]: rows }, queryTitle, isolatedAnimes, isolatedDetailStore, querySeason, preferAnimeId, preferSource, sourceOrder);
        }
        if (getMatchTracePrefix()) log('info', `[system] [match-source] ${source} 管道完成，候选 ${isolatedAnimes.length} 个（空结果不代表故障）`);
        completedSources.set(source, { animes: isolatedAnimes, details: isolatedDetailStore });
        if (onProgress) {
          const readyAnimes = [];
          const readyDetails = new Map();
          for (const key of sourceOrder) {
            const ready = completedSources.get(key);
            if (!ready) continue;
            readyAnimes.push(...ready.animes);
            for (const [id, anime] of ready.details) if (!readyDetails.has(id)) readyDetails.set(id, anime);
          }
          onProgress({ animes: readyAnimes, details: readyDetails });
        }
      });
      const pipelinePromise = episodeLookupDeadline === null ? rawPipelinePromise
        : withEpisodeLookupTimeout(rawPipelinePromise, source, episodeLookupDeadline);
      return { key: source, animes: isolatedAnimes, detailStore: isolatedDetailStore, promise: pipelinePromise };
    });

    // 并发执行所有逐源管道，每个管道内部 search 完成后立即衔接 handleAnimes
    const pipelineResults = await Promise.allSettled(pipelineTasks.map(task => task.promise));
    canCacheLookup = episodeLookupDeadline === null || pipelineResults.every(result => result.status === 'fulfilled');

    // 按SOURCE_ORDER顺序合并各管道的独立结果到目标容器
    // 先处理的源数据优先保留（animeId去重、detailStore键去重）
    const existingAnimeIds = new Set(curAnimes.map(a => `${a.source || ''}:${a.animeId}`));

    for (let i = 0; i < pipelineTasks.length; i++) {
      if (pipelineResults[i].status === 'rejected') {
        const reason = pipelineResults[i].reason;
        log(reason?.code === 'EPISODE_LOOKUP_TIMEOUT' ? 'warn' : 'error',
          `[system] [searchAnime] 源 ${pipelineTasks[i].key} 管道处理失败: ${reason}`);
        continue;
      }

      const { animes: isolatedAnimes, detailStore: isolatedDetailStore } = pipelineTasks[i];

      // 合并动漫结果列表（使用 Set 确保 O(1) 检索，优先源先入为主）
      for (const anime of isolatedAnimes) {
        const identityKey = `${anime.source || ''}:${anime.animeId}`;
        if (!existingAnimeIds.has(identityKey)) {
          curAnimes.push(anime);
          existingAnimeIds.add(identityKey);
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

    // 缓存首季/默认请求结果，剥离附加链接
    if (curAnimes.length > 0 && !searchSources && canCacheLookup) {
      setSearchCache(scopedKey(cacheKey), curAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
    }

    // 判断当前获取的季度是否已包含用户指定的集数
    const unsatisfiedPlatforms = new Set();
    const isEpisodeSatisfied = checkEpisodeSatisfied(curAnimes, querySeason, queryEpisode, requestAnimeDetailsMap, targetPlatform, unsatisfiedPlatforms);

    // 若未包含且用户指定了季度，推导最大季并扩展至后续季以辅助跨季匹配
    if (!isEpisodeSatisfied && querySeason !== null) {
      let maxSeason = querySeason;
      for (const source of sourceOrder) {
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
        // 依据 bangumi-data 的 TMDB 季边界定位目标集所在季, 跨季扩展直接收敛至目标季并跳过无关中间季, 季信息用于目录定位
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

        const expandPromises = [];
        for (const source of sourceOrder) {
          if (!resultData[source]) continue;
          // 在PLATFORM_ORDER模式下，跳过已满足平台的对应源；unsatisfied为空时不跳过
          if (targetPlatform && unsatisfiedPlatforms.size > 0 && !unsatisfiedPlatforms.has(source)) continue;
          // 源间并发、源内顺序，防止同源并发导致模块级缓存竞态
          expandPromises.push((async () => {
            const sourceResults = [];
            for (let s = expansionStart; s <= expansionEnd; s++) {
              const seasonAnimes = [];
              await executeSourceHandlers({ [source]: resultData[source] }, queryTitle, seasonAnimes, requestAnimeDetailsMap, s, preferAnimeId, preferSource, sourceOrder);
              if (seasonAnimes.length > 0 && !searchSources && canCacheLookup) {
                setSearchCache(scopedKey(`${queryTitle}_S${s}`), seasonAnimes.map(({ links, ...pureAnime }) => pureAnime), requestAnimeDetailsMap);
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

      const animeData = resolveSearchAnimeDetail(anime);
      if (animeData && animeData.links) {
        const episodesList = applyEpisodeTitleFilter(anime, animeData.links);

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

    if (globals.localRedisValid && curAnimes.length !== 0) {
      await updateLocalRedisCaches();
    }

    // 构造响应 DTO：剥离合并产生的 links，确保接口纯净
    const responseAnimes = curAnimes.map(({ links, ...pureAnime }) => pureAnime);

    // 缓存搜索结果
    if (responseAnimes.length > 0 && canCacheLookup) {
      const cacheKey = querySeason !== null ? `${queryTitle}_S${querySeason}` : queryTitle;
      setSearchCache(scopedKey(cacheKey), responseAnimes, requestAnimeDetailsMap);
    }

    logMappingSearchOutcome(responseAnimes, false);

    // errorMessage 只在"没有结果"时承载 addAnime 写入失败原因；结果可用时它不是错误而是提示，
    // 放进 errorMessage 会让按"非空即报错"判断的客户端误报。
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: responseAnimes.length === 0 ? getAddAnimeError(requestAnimeDetailsMap) : "",
      animes: responseAnimes,
      tmdbSeasonBoundaries,
      titleMappingInfo: recognitionInfo,
    });

}

export function filterSameEpisodeTitle(filteredTmpEpisodes) {
    const filteredEpisodes = filteredTmpEpisodes.filter((episode, index, episodes) => {
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            return prevEpisode.episodeTitle === episode.episodeTitle;
        });
    });
    // 对聚合采集源（如360）中来自不同平台的同名集号做二次去重
    // 同一集号保留首次出现（最早平台）的条目
    const seenNumbers = new Set();
    return filteredEpisodes.filter(ep => {
        const num = extractEpisodeNumberFromTitle(ep.episodeTitle);
        if (num === null) return true;
        if (seenNumbers.has(num)) return false;
        seenNumbers.add(num);
        return true;
    });
}

/**
 * 计算平台匹配得分 (新增函数 - 用于支持合并源模糊匹配和杂质过滤)
 * @param {string} candidatePlatform 候选平台字符串 (e.g., "bilibili&youku")
 * @param {string} targetPlatform 目标配置字符串 (e.g., "bilibili&youku")
 * @returns {number} 得分：越高越好，0表示不匹配
 */
function getPlatformMatchScore(candidatePlatform, targetPlatform) {
  if (!candidatePlatform || !targetPlatform) return 0;

  // 预处理：按半角/全角 & 分割，转小写去空格并去重，避免合并标题重复标签抬高杂质长度导致评分失真
  const cParts = [...new Set(candidatePlatform.split(/[&＆]/).map(s => canonicalPlatformName(s.trim().toLowerCase())).filter(s => s))];
  const tParts = [...new Set(targetPlatform.split(/[&＆]/).map(s => canonicalPlatformName(s.trim().toLowerCase())).filter(s => s))];

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
  // Candidate="youku&bilibili" -> Match=1, Len=2 -> 1000 - 2 = 998 (Valid but lower score)
  return (matchCount * 1000) - cParts.length;
}

// 辅助函数：从标题中提取来源平台列表 (新增函数 - 适配合并源标题格式)
function extractPlatformFromTitle(title) {
    const match = title.match(/from\s+([a-zA-Z0-9&＆]+)/i);
    return match ? match[1] : null;
}

// 根据集数匹配episode（优先使用集标题中的集数，其次使用episodeNumber）
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

  const numbered = platformEpisodes.filter(ep => extractEpisodeNumberFromTitle(ep.episodeTitle) === targetEpisode);
  const candidates = numbered.length ? numbered : platformEpisodes.filter(ep =>
    extractEpisodeNumberFromTitle(ep.episodeTitle) === null && Number(ep.episodeNumber) === targetEpisode);
  const unique = [...new Map(candidates.map(ep => [ep.url || ep.episodeId, ep])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) log('warn', `[system] [match-reject] 第${targetEpisode}集对应多个不同视频，拒绝按目录顺序选择`);

  return null;
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
  const mappedEpisode = offsetIndex < 0 ? null : filteredEpisodes[offsetIndex + offset];
  if (!mappedEpisode) {
    log('info', `[system] [match-reject] 保存的选集定位不存在或越界: ${offsets[seasonKey]} / S${season}E${episode}`);
    return NaN;
  }
  // 人工锚点按目录位置顺延，但后续匹配必须使用该条目的真实集号。
  targetEpisode = extractEpisodeNumberFromTitle(mappedEpisode.episodeTitle) ?? Number(mappedEpisode.episodeNumber);
  log("info", `Applying offset "${offsets[seasonKey]}" for S${season}E${episode} -> ${targetEpisode}`);
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


export async function matchAniAndEp(season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore = null, mappedTitleSeason = false, movieVersion = null) {
  const movieMatches = [];
  // 定义最佳匹配结果容器
  let bestRes = {
    anime: null,
    episode: null,
    score: -9999 // 初始分数为极低值
  };

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
            if (normalizeTitleForMatch(candTitle).includes(candidateQueryTitle) || compoundTitleMatches(candTitle, title)) {
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

                const seasonOk = matchSeason(tempAnime, title, season) || matchEpisodeSeason(anime, title, season, detailStore, mappedTitleSeason);
                if (seasonOk || animeIsPrefer) {
                    isMatch = true;
                    break; // 别名命中跳出
                }
            }
        } else {
            // 电影模式
            const cleanTitle = stripMovieAudioTags(candTitle.split("(")[0].trim());
            if (normalizeTitleForMatch(cleanTitle) === candidateQueryTitle || compoundTitleMatches(cleanTitle, title)) {
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

    // S01E01 不能仅凭“第 1 集”命中电影；只要搜索结果中存在多集候选，
    // 单集候选就不参与本轮季集匹配。这样不受平台顺序影响。
    if (hasMultiEpisodeCandidate && isSingleEpisodeMatchCandidate(anime, bangumiData)) {
      log('info', `[system] [match] Skip single-episode candidate for S${season}E${episode}: ${anime.animeTitle}`);
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
        const filteredTmpEpisodes = filterEpisodesByTitle(bangumiData.bangumi.episodes);
        // 保留不同视频和不同平台的同号条目，交给选集阶段核对；不能提前按集号丢弃。
        const filteredEpisodes = filteredTmpEpisodes;

        log("info", "过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

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
        // 电影模式逻辑：候选分集中必须包含真正的“正片”，没有正片（纯预告/花絮/短片）则不予匹配
        const features = bangumiData.bangumi.episodes.filter(ep => isMovieFeatureFilmEpisode(ep, anime));
        let featuresForPlatform = platform ? features.filter(ep =>
          getPlatformMatchScore(extractEpisodeTitle(ep.episodeTitle), platform) > 0) : features;
        if (!featuresForPlatform.length && isPreferredAnime) featuresForPlatform = features;
        const selected = selectMovieVersions(featuresForPlatform, anime.animeTitle, movieVersion);
        matchedEpisode = selected[0] || null;
        for (const ep of selected) movieMatches.push({ anime, episode: ep });
        if (!matchedEpisode) log('info', `[system] [match] 电影候选没有匹配音轨的正片: ${anime.animeTitle}`);
    }

    // 3. 匹配结果处理与评分比较
    if (matchedEpisode) {
        // 计算当前匹配的得分
        // 候选平台由番剧身份标签（标题 from 段或 source）与命中集所挂平台标签共同决定，同时兼容旧缓存中的平台别名
        const identityPlatform = extractPlatformFromTitle(anime.animeTitle) || anime.source;
        const epPlatform = matchedEpisode ? extractEpisodeTitle(matchedEpisode.episodeTitle) : null;
        const candidatePlatform = [...new Set([identityPlatform, epPlatform].filter(Boolean)
            .flatMap(p => p.split(/[&＆]/).map(s => canonicalPlatformName(s.trim().toLowerCase()))).filter(s => s))].join('&');
        let currentScore = 0;

        if (platform) {
            // 如果指定了平台偏好，计算匹配得分
            currentScore = getPlatformMatchScore(candidatePlatform, platform);
            // 不属于当前平台组的候选留给后续组或最终回退，不能抢占第一组。
            if (currentScore === 0 && !isPreferredAnime) continue;
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
        // 逻辑：如果有更好的分数，或者之前没有匹配到任何结果，则更新
        if (currentScore > bestRes.score) {
             bestRes = {
                anime: anime,
                episode: matchedEpisode,
                score: currentScore
            };
        }

        // 已命中最高优先级的手动优选，或不存在平台偏好且无待匹配的优选条目时立刻跳出查找
        if ((season && episode) && (isPreferredAnime || (!platform && !preferAnimeId && !isSingleEpisodeCandidate))) {
          break;
        }

        // 如果指定了平台偏好，则继续循环查找是否有得分更高的源（最小杂质匹配）
    }
  }


  // 指定平台偏好时仅当最佳结果真实命中该平台（得分 > 0）才视为有效匹配，否则视作该平台无可用源交由上层按 PLATFORM_ORDER 顺延到下一平台或回退默认匹配，避免首个命中标题但平台得分 0 的番剧被误判为该平台匹配而阻断后续平台递进
  if (platform && bestRes.score <= 0) {
    return { resEpisode: null, resAnime: null };
  }

  if (!(season && episode) && bestRes.anime) {
    // 仅使用已通过片名、年份及当前平台校验的正片，兼容配音版单独建条目的来源。
    const sameSource = movieMatches.filter(item => item.anime.source === bestRes.anime.source);
    const entries = sameSource.map(item => ({ ...item.episode, anime: item.anime,
      movieVersion: movieAudioVersion(item.episode.episodeTitle) || movieAudioVersion(item.anime.animeTitle) }));
    const exact = movieVersion ? entries.filter(ep => ep.movieVersion === movieVersion) : [];
    let selected = exact.length ? exact : entries;
    if (!movieVersion) {
      const versions = entries.filter(ep => !ep.movieVersion || ['mandarin', 'original'].includes(ep.movieVersion));
      selected = versions.some(ep => ep.movieVersion === 'original') && versions.some(ep => ep.movieVersion !== 'original')
        ? versions : [bestRes.episode];
    } else selected = selected.slice(0, 1);
    if (selected.length === 1) {
      const { anime, movieVersion: _version, ...episode } = selected[0];
      bestRes.episode = episode;
      if (anime) bestRes.anime = anime;
    }
    else if (selected.length > 1) {
      const urls = [...new Set(selected.flatMap(ep => {
        if (ep.url.includes(MERGE_DELIMITER)) return ep.url.split(MERGE_DELIMITER);
        const { source, realId } = resolveSourceAndRealId(ep.url);
        return source ? [`${source}:${realId}`] : [];
      }))];
      if (urls.length > 1) {
        const episodeTitle = `【${bestRes.anime.source}】 正片（普通版＋原版）`;
        const stored = addEpisode(urls.join(MERGE_DELIMITER), episodeTitle);
        bestRes.episode = { episodeId: stored.id, episodeTitle, url: stored.url };
        // 保存独立的合并选集引用，后续按 ID 获取弹幕仍能找到作品和人物过滤上下文。
        stored.animeTitle = bestRes.anime.animeTitle;
        log('info', `[system] [movie-version] 文件名未明确音轨版本，合并 ${urls.length} 个普通版/原版正片链接`);
      }
    }
    if (movieVersion) log('info', `[system] [movie-version] 按文件名选择 ${movieVersion}: ${bestRes.episode.episodeTitle}`);
  }

  return { resEpisode: bestRes.episode, resAnime: bestRes.anime };
}


/**
 * 解析单个链接，返回源标识符和用于弹幕获取的 realId
 * @param {string} url
 * @returns {{source: string, realId: string}}
 */
function resolveSourceAndRealId(url) {
  const location = resolveSourceLocation(url);
  if (!location) return { source: null, realId: url };
  const suffix = location.offset ? `@${location.percent ? '%' : ''}${location.offset}` : '';
  return { source: location.source, realId: location.realId + suffix };
}

/**
 * 【从文件名里提取出：剧名 / 季数 / 集数 / 年份】——自动匹配的“第一步”
 *
 * 用户传进来的是一整个文件路径/文件名，例如：
 *   "[WEB-DL] 宝可梦 地平线 烈空坐飞升.2024.S01E01.1080p.x264.mkv"
 *
 * 而我们要做的是把里面的“真正的剧名”抠出来，并解析出：
 *   剧名   -> "宝可梦 地平线 烈空坐飞升"
 *   季数   -> 1
 *   集数   -> 1
 *   年份   -> 2024
 *
 * 抠出来的剧名会交给剧名映射表处理（见 title-mapping-url-util.js）。
 * 所以这里必须先清掉文件名里那些“不是剧名”的杂质，
 * 否则 "[WEB-DL]"、"1080p"、".mkv" 这些会污染剧名，导致映射永远命不中。
 */
export async function extractTitleSeasonEpisode(cleanFileName, suppliedReleaseGroups = null) {
  const releaseGroups = Array.isArray(suppliedReleaseGroups)
    ? suppliedReleaseGroups
    : extractReleaseGroups(cleanFileName);
  // 第一步：清理文件名最前面的「发布标签」。
  // 这些方括号标签（如 [WEB-DL]、[1080p]、[字幕组名]）不是剧名，全部剥掉；
  // 同时去掉结尾的视频扩展名（.mkv/.mp4 等）。
  let normalizedFileName = String(cleanFileName || '')
    .replace(/^(?:\s*(?:\[[^\]]+\]|【[^】]+】)\s*)+/, '')
    .replace(/\.(?:mkv|mp4|avi|mov|wmv|m4v|ts)$/i, '');
  // 中文季集与 SxxExx 共用后续解析，避免被当成电影名或检索关键词。
  const chineseEpisode = normalizedFileName.match(/^(.+?)[.\s_-]*(?:第\s*([\d零一二三四五六七八九十百两]+)\s*季[.\s_-]*)?第\s*([\d零一二三四五六七八九十百两]+)\s*[集话回]/);
  if (chineseEpisode && !/S\d+[.\s_-]*E\d+/i.test(normalizedFileName)) {
    const seasonNumber = chineseEpisode[2] ? convertChineseNumber(chineseEpisode[2].replace(/两/g, '二')) : 1;
    normalizedFileName = `${chineseEpisode[1]} S${seasonNumber}E${convertChineseNumber(chineseEpisode[3].replace(/两/g, '二'))}${normalizedFileName.slice(chineseEpisode[0].length)}`;
  }
  // A suffix group such as `-ADWeb` is useful as a rule qualifier but must
  // not become part of the search title. Leading bracket groups were removed
  // above; remove only the explicit suffix form to avoid trimming real title
  // words (for example the final word in `Blood River`).
  if (/\bS\d+E\d+\b/i.test(normalizedFileName)) {
    for (const group of releaseGroups) {
      const escaped = String(group).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      normalizedFileName = normalizedFileName.replace(new RegExp(`[\\s._-]+${escaped}$`, 'i'), '');
    }
  }
  // 第二步：用正则找“剧名 + S季E集”模式。
  // 例："宝可梦 地平线.S01E01" → 前面是剧名，S01=季1，E01=集1
  const regex = /^(.+?)[.\s_-]*S(\d+)[.\s_-]*E(\d+)/i;
  const match = normalizedFileName.match(regex);

  let title, season, episode, year;

  if (match) {
    // ----- 情况 A：文件名里带 S##E##（最标准、最常见的格式） -----
    title = match[1].replace(/[.\s_-]+$/, '');    // 剧名 = S 前面那段
    season = parseInt(match[2], 10);  // 季数 = S 后面的数字
    episode = parseInt(match[3], 10); // 集数 = E 后面的数字

    // 年份位于 SxxExx 前时也支持空格分隔，避免留在剧名里。
    const titleYear = title.match(/^(.+?)[._\s(（]+((?:19|20)\d{2})[)）]?$/);
    if (titleYear) {
      title = titleYear[1].trim();
      year = Number(titleYear[2]);
    }

    // ============ 提取年份 =============
    // 从文件名中提取年份（支持多种格式：.2009、.2024、(2009)、(2024) 等）
    const yearMatch = normalizedFileName.match(/(?:\.|\(|（)((?:19|20)\d{2})(?:\)|）|\.|$)/);
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
      const engMatch = title.match(/^([A-Za-z0-9._&\s]+?)(?=\.\d{4}|$)/);
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
    // ----- 情况 B：文件名里没有 S##E##（比如只有年份/分辨率）-----
    // 这时只能尽力“在技术参数出现之前”截取剧名。
    // 正则里的关键部分：(?:\d{4}|\d{3,4}p|S\d+|WEB|x264|...) 表示“技术字段”，
    // 遇到它们就停，把前面那段当剧名。
    const titleRegex = /^([^.\s]+(?:[.\s][^.\s]+)*?)(?:[.\s](?:\d{4}|(?:19|20)\d{2}|\d{3,4}p|S\d+|E\d+|WEB|BluRay|Blu-ray|HDTV|DVDRip|BDRip|x264|x265|H\.?264|H\.?265|AAC|AC3|DDP|TrueHD|DTS|10bit|HDR|60FPS))/i;
    const titleMatch = normalizedFileName.match(titleRegex);

    // 找到就以空格分隔（点号转为空格）；找不到就整串当剧名（至少不会更糟）
    // 中文名.英文名.年份是双语资源名；先取中文名，再转换分隔符，避免把英文别名并入搜索词。
    const titlePart = titleMatch?.[1].replace(/^([\u4e00-\u9fa5·]+)\.[A-Za-z][A-Za-z0-9._ &'!?-]*$/, '$1');
    title = titleMatch ? titlePart.replace(/[._]/g, ' ').trim() : normalizedFileName;
    season = null;
    episode = null;

    // 从文件名中提取年份
    const yearMatch = normalizedFileName.match(/(?:\.|\(|（)((?:19|20)\d{2})(?:\)|）|\.|$)/);
    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
    }
  }

  const episodeTitle = match ? normalizedFileName.slice(match[0].length).replace(/^[.\s_-]+/, '')
    .replace(/(?:^|[.\s_-])(?:\d{3,4}p|WEB(?:-?DL)?|BluRay|HDTV|[xh]\.?26[45]|AAC|DDP|HDR|HEVC)\b.*$/i, '').trim() : '';
  return {title, season, episode, year, releaseGroups, episodeTitle};
}

// 综艺文件名里的「第N期[上下]」已经写明了是哪一期，直接用它去官方目录定位即可，
// 不必先问 TMDB；期号可能出现在 SxxExx 前后任意位置，所以扫描整串。
export function extractVarietyFragment(cleanFileName) {
  const cleaned = String(cleanFileName || '')
    .replace(/^(?:\s*(?:\[[^\]]+\]|【[^】]+】)\s*)+/, '')
    .replace(/\.(?:mkv|mp4|avi|mov|wmv|ts)$/i, '');
  const match = /第\s*\d+\s*期/.exec(cleaned);
  return match ? cleaned.slice(match.index).trim() : '';
}

export function buildSearchAnimeUrl(baseUrl, keyword, season, episode, skipTitleMapping = false) {
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
  if (skipTitleMapping) searchUrl.searchParams.set('_skipTitleMapping', '1');
  return searchUrl;
}

async function selectAnimeMatch({ season, episode, year, searchData, title, req, dynamicPlatformOrder, preferAnimeId, offsets, detailStore, mappedTitleSeason = false, movieVersion = null }) {
  let resAnime = null;
  let resEpisode = null;
  let spilloverMatched = false;

  for (const platform of dynamicPlatformOrder) {
    const matched = await matchAniAndEp(
      season, episode, year, searchData, title, req, platform, preferAnimeId, offsets, detailStore, mappedTitleSeason, movieVersion
    );
    resEpisode = matched.resEpisode;
    resAnime = matched.resAnime;
    if (resAnime) {
      log("info", `[system] [match] Found match with platform: ${platform || 'default'}`);
      break;
    }
  }

  if (!resAnime) {
    const fallback = await matchAniAndEp(season, episode, year, searchData, title, req, null, preferAnimeId, offsets, detailStore, mappedTitleSeason, movieVersion);
    resEpisode = fallback.resEpisode;
    resAnime = fallback.resAnime;
  }

  return { resAnime, resEpisode, spilloverMatched };
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

async function selectReadyMatch({ animes, details, title, season, episode, year, platform, req, mapping, strictTargetTitle, mappedTitleSeason = false }) {
  const guard = mapping || (strictTargetTitle ? { targetTitle: title } : null);
  let candidates = guard ? filterMappingTargetCandidates(animes, guard) : animes;
  // 快速路径只接受明确季号与集标题，不用数组位置或跨季推算。
  candidates = candidates.filter(anime => {
    if (anime.type === 'B站投稿' && !globals.bilibiliUgcEnabled) return false;
    if (anime.isHiddenChild || !matchYear(anime, year)) return false;
    const titles = [anime.animeTitle, ...(anime.aliases || [])];
    if (!titles.some(candidate => matchSeason({ ...anime, animeTitle: candidate }, title, season)) &&
        !matchEpisodeSeason(anime, title, season, details, mappedTitleSeason)) return false;
    const episodes = getBangumiDataForMatch(anime, details)?.bangumi?.episodes || [];
    return filterEpisodesByTitle(episodes).some(ep =>
      extractEpisodeNumberFromTitle(ep.episodeTitle) === episode &&
      getPlatformMatchScore(extractEpisodeTitle(ep.episodeTitle), platform) > 0);
  });
  if (candidates.length === 0) return null;
  const selected = await matchAniAndEp(season, episode, year, { animes: candidates }, title, req, platform, null, null, details, mappedTitleSeason);
  if (!selected.resAnime || !selected.resEpisode || extractEpisodeNumberFromTitle(selected.resEpisode.episodeTitle) !== episode) return null;
  return { ...selected, spilloverMatched: false, title, season, episode };
}

// 电影模式不把剧集类型候选交给模型，避免只有“第1集”的剧集被当成电影正片。
function isSeriesType(anime) {
  return /tvseries|tv_series|电视剧|综艺|纪录片|紀錄片|documentary/i.test(String(anime.type || '') + String(anime.typeDescription || ''));
}

function confidentCandidates(animes, { title, season, episode, year, mapping, tmdbIdentity, details, mediaType, decision, mappedTitleSeason = false }) {
  const guard = mapping || { targetTitle: title };
  let candidates = tmdbIdentity
    ? filterTmdbMatchCandidates(animes, tmdbIdentity, mapping, globals.animes)
    : animes.filter(anime => filterMappingTargetCandidates([anime], guard).length > 0 ||
      (!mapping && [anime.animeTitle, ...(anime.aliases || [])].some(candidate => compoundTitleMatches(candidate, title))));
  candidates = candidates.filter(anime => {
    const target = { year: mapping?.targetYear || year, mediaType: mapping?.targetType || tmdbIdentity?.mediaType || mediaType || (season && episode ? 'tv' : 'movie'), tmdbIdentity };
    const conflict = workIdentityConflict(anime, target);
    if (conflict) {
      logEvent('info', 'match.candidate.reject', `[system] [match-reject] ${anime.animeTitle}，原因=${conflict}`, { candidateTitle: anime.animeTitle, reason: conflict, year: target.year, mediaType: target.mediaType });
      return false;
    }
    if (season && episode) {
      if (isMovieMatchCandidate(anime)) return false;
      return [anime.animeTitle, ...(anime.aliases || [])].some(candidate =>
        matchSeason({ ...anime, animeTitle: candidate }, title, season)) || matchEpisodeSeason(anime, title, season, details, mappedTitleSeason);
    }
    return !isSeriesType(anime);
  });
  if (!year) {
    const years = new Set(candidates.map(anime => extractYear(anime.animeTitle) || Number(String(anime.startDate || '').slice(0, 4))).filter(Boolean));
    if (years.size > 1) {
      if (decision) decision.ambiguousWork = true;
      log('info', '[system] [match-reject] 同名同季候选年份不同，需进一步确认作品');
      return [];
    }
  }
  return candidates;
}

async function executeMatchAttempt(options) {
  // Platform-qualified mappings may only search their own numbering system.
  const platformOrder = options.mapping?.targetPlatform
    ? [options.mapping.targetPlatform]
    : createMatchPlatformOrder(options.preferSource || options.preferredPlatform, options.secondaryPreferredPlatform);
  // Legacy remembered IDs without a source still need the full catalog to locate that ID.
  if (options.preferAnimeId && !options.preferSource) return executeMatchAttemptBody(options);

  const sourceSearches = options.sourceSearches ?? new Map();
  const searchedSources = new Set();
  const visitedScopes = new Set();
  let attempt = { resAnime: null, resEpisode: null, spilloverMatched: false,
    title: options.title, season: options.season, episode: options.episode };
  for (const platform of platformOrder) {
    if (options.collectionRace?.ugcMatched) break;
    const members = new Set(String(platform || '').split(/[&＆]/).map(canonicalPlatformName).filter(Boolean));
    // The final default pass only searches enabled sources not covered by earlier groups.
    const searchSources = globals.sourceOrderArr.filter(source => platform ? members.has(source) : !searchedSources.has(source));
    const scope = searchSources.join(',');
    if (!searchSources.length || visitedScopes.has(scope)) continue;
    visitedScopes.add(scope);
    searchSources.forEach(source => searchedSources.add(source));
    const label = platform || '其余启用来源';
    log('info', `[system] [match-search] 开始平台组 ${label}，搜索来源: ${scope}`);
    const selected = await executeMatchAttemptBody({ ...options, sourceSearches, searchSources, stagePlatform: platform });
    attempt = { ...selected, cacheWarning: selected.cacheWarning || attempt.cacheWarning };
    // 同名作品有歧义时先回到作品识别，不能让后续只有一个候选的平台绕过校验。
    if (selected.ambiguousWork) return attempt;
    if (selected.resAnime && selected.resEpisode) {
      log('info', `[system] [match-search] 平台组 ${label} 匹配成功，跳过后续平台组`);
      return attempt;
    }
    log('info', `[system] [match-search] 平台组 ${label} 无可用匹配，继续下一组`);
  }
  return attempt;
}

function needsGroupMerge(sources) {
  const active = new Set(sources);
  if ((globals.mergeSourcePairs || []).some(group =>
    new Set([group.primary, ...group.secondaries].filter(source => active.has(source))).size > 1)) return true;
  return (globals.customMergeRules || []).some(rule => rule.action !== 'block' &&
    rule.primary.source.split('&').some(source => active.has(source)) &&
    rule.secondary.source.split('&').some(source => active.has(source)));
}

// ===== AI 兜底匹配 =====
// 常规的标题、季号与分集都没命中时，让模型在已通过年份/类型过滤的候选里再判一次。
// 模型只负责“选作品 + 选分集”，取到的条目仍然是候选目录里的真实分集。
const AI_CANDIDATE_LIMIT = 10;
const AI_EPISODE_LIMIT = 30;

function aiEpisodeCandidates(anime, detailStore) {
  const episodes = getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes || [];
  return filterEpisodesByTitle(episodes).filter(ep => ep.episodeTitle);
}

function buildAiMatchMessages({ title, season, episode, year, pools }) {
  const candidates = pools.map((pool, index) => ({
    anime: index + 1,
    title: String(pool.anime.animeTitle || '').slice(0, 60),
    aliases: (pool.anime.aliases || []).slice(0, 3).map(alias => String(alias).slice(0, 60)),
    episodes: pool.episodes.slice(0, AI_EPISODE_LIMIT).map((item, epIndex) => ({
      episode: epIndex + 1, title: String(item.episodeTitle).slice(0, 40)
    }))
  }));
  const query = { title, season: season || null, episode: episode || null, year: year || null };
  return [
    { role: 'system', content: '你是番剧目录核对器。只输出一个 JSON 对象，不写解释。' },
    { role: 'user', content: `判断搜索词与哪个候选是同一部作品的同一季，并选出搜索词要求的分集。\n搜索词：${JSON.stringify(query)}\n候选：${JSON.stringify(candidates)}\n只输出 {"anime": 候选编号或 0, "episode": 该候选的 episode 编号或 0, "reason": "一句话理由"}。\n不是同一部作品时必须输出 anime=0；不要因为名字相近就选；分集无法确定时输出 episode=0。` }
  ];
}

async function aiMatchFallback({ animes, title, season, episode, year, detailStore, movieVersion = null }) {
  if (!globals.aiApiKey || !Array.isArray(animes) || animes.length === 0) return null;

  const pools = [];
  for (const anime of animes) {
    const episodes = aiEpisodeCandidates(anime, detailStore);
    if (episodes.length === 0) continue;
    pools.push({ anime, episodes });
    if (pools.length === AI_CANDIDATE_LIMIT) break;
  }
  if (pools.length === 0) return null;

  let answer = null;
  try {
    const content = await askAi({
      baseUrl: globals.aiBaseUrl,
      apiKey: globals.aiApiKey,
      model: globals.aiModel,
      messages: buildAiMatchMessages({ title, season, episode, year, pools })
    });
    answer = extractJsonObject(content);
  } catch (error) {
    log('warn', `[system] [match-ai] 兜底判定失败，忽略 AI 结果: ${error.message}`);
    return null;
  }

  const picked = pools[Math.trunc(Number(answer?.anime)) - 1];
  if (!picked) {
    log('info', `[system] [match-ai] AI 未认定同一部作品，跳过兜底: ${answer?.reason || '无理由'}`);
    return null;
  }

  const pickedEpisode = season && episode ? picked.episodes[Math.trunc(Number(answer?.episode)) - 1] : null;
  const matchedEpisode = pickedEpisode
    || (season && episode ? findEpisodeByNumber(picked.episodes, episode, episode, null) : null)
    || (season && episode ? null : selectMovieVersions(
      picked.episodes.filter(ep => isMovieFeatureFilmEpisode(ep, picked.anime)), picked.anime.animeTitle, movieVersion)[0] || null);
  if (!matchedEpisode) {
    log('info', `[system] [match-ai] AI 选中 ${picked.anime.animeTitle} 但没有可取分集，忽略本次结果`);
    return null;
  }
  log('info', `[system] [match-ai] AI 兜底命中: ${picked.anime.animeTitle} / ${matchedEpisode.episodeTitle}（${answer?.reason || '无理由'}）`);
  return { resAnime: picked.anime, resEpisode: matchedEpisode };
}

// 交给模型的候选池只排除年份、类型和作品身份冲突，不要求标题互相包含：
// 别名、译名与平台写法差异正是常规匹配失败的主要原因。
function aiFallbackPool(animes, { season, episode, year, mediaType, tmdbIdentity }) {
  const target = { year, mediaType: tmdbIdentity?.mediaType || mediaType || (season && episode ? 'tv' : 'movie'), tmdbIdentity };
  const seen = new Set();
  return animes.filter(anime => {
    const key = `${anime.source}:${anime.animeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (workIdentityConflict(anime, target)) return false;
    return season && episode ? !isMovieMatchCandidate(anime) : !isSeriesType(anime);
  });
}

async function executeMatchAttemptBody({ req, title, season, episode, year, mediaType = null, preferredPlatform, secondaryPreferredPlatform, preferAnimeId, preferSource, offsets, mapping, strictTargetTitle = false, mappedTitleSeason = false, tmdbIdentity = null, tmdbEpisode = null, tmdbEpisodeHint = null, fileNameVarietyKey = null, movieVersion = null, collectionContext = null, sourceSearches = null, searchSources = null, stagePlatform, aiContext = null }) {
  if (fileNameVarietyKey && !mediaType) mediaType = 'tv';
  const startedAt = Date.now();
  // A platform-qualified rule describes that platform's numbering. Never
  // apply its offset to another source if the platform has no matching episode.
  const dynamicPlatformOrder = stagePlatform !== undefined ? [stagePlatform] : mapping?.targetPlatform
    ? [mapping.targetPlatform]
    : createMatchPlatformOrder(preferredPlatform, secondaryPreferredPlatform);
  const targetPlatform = dynamicPlatformOrder.length > 0 ? dynamicPlatformOrder[0] : null;
  const detailStore = new Map();
  const searchUrl = buildSearchAnimeUrl(req.url, title, season, episode, true);
  const budget = globals.matchSearchBudgetMs;
  const catalogKey = `${title}_S${season}`;
  const mustCompleteMerge = needsGroupMerge(searchSources ?? globals.sourceOrderArr);
  const canUseReady = !collectionContext && !tmdbEpisode && !mustCompleteMerge && budget > 0 && season && episode && targetPlatform && !preferAnimeId && !offsets &&
    !(mapping?.targetYear || mapping?.targetType || (mapping?.targetTmdbId && !tmdbIdentity));
  const fastDisabledReasons = [];
  if (mustCompleteMerge) fastDisabledReasons.push('先完成当前平台组的源合并');
  if (collectionContext) fastDisabledReasons.push('合集需要核对版本与单集标题');
  if (!(budget > 0)) fastDisabledReasons.push('搜索预算关闭');
  if (!season || !episode) fastDisabledReasons.push('缺少明确季集');
  if (!targetPlatform) fastDisabledReasons.push('缺少优先平台');
  if (preferAnimeId) fastDisabledReasons.push('手动作品偏好');
  if (offsets) fastDisabledReasons.push('集数偏移');


  if (mapping?.targetYear || mapping?.targetType || (mapping?.targetTmdbId && !tmdbIdentity)) fastDisabledReasons.push('映射含年份/类型/未确认TMDB限定');
  logEvent('info', 'match.fast', `[system] [match-fast] ${canUseReady ? `启用，预算 ${budget}ms，优先平台 ${targetPlatform}` : `未启用：${fastDisabledReasons.join('、')}；等待完整搜索`}`, { enabled: Boolean(canUseReady), budgetMs: budget, reasons: fastDisabledReasons, platform: targetPlatform });
  const probe = progress => selectReadyMatch({ ...progress,
    animes: confidentCandidates(progress.animes, { title, season, episode, year, mapping, tmdbIdentity, mediaType, details: progress.details, mappedTitleSeason }),
    title, season, episode, year, platform: targetPlatform, req, mapping, strictTargetTitle, mappedTitleSeason });
  if (canUseReady) {
    // 已保存的目录仍包含可用剧集 URL；缺集、不确定季号或优先组无数据时才重新搜索。
    const details = new Map();
    const cached = getSearchCache(searchScopeCacheKey(catalogKey, searchSources), details) ??
      getSearchCache(searchScopeCacheKey(title, searchSources), details);
    const activeSources = searchSources ?? globals.sourceOrderArr;
    const catalog = cached ?? globals.animes.filter(anime => activeSources.includes(anime.source) &&
      !anime.mergedChildren?.length && !/[&＆]/.test(extractPlatformFromTitle(anime.animeTitle) || ''));
    if (cached === null) catalog.forEach((anime, index) => details.set(index, anime));
    const ready = await probe({ animes: catalog, details });
    if (ready) {
      log('info', `[system] [match-fast] 复用已保存目录，耗时 ${Date.now() - startedAt}ms: ${ready.resAnime.animeTitle}, ${ready.resEpisode.episodeTitle}`);
      return ready;
    }
    log('info', '[system] [match-fast] 已保存目录未找到满足标题、季度、明确集号及优先平台的候选，转入搜索');
  }

  let latestProgress = null;
  let budgetElapsed = false;
  let closed = false;
  let resolveReady;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });
  const checkReady = async () => {
    if (closed || !budgetElapsed || !latestProgress) return;
    const progress = latestProgress;
    const ready = await probe(progress);
    if (!ready || closed) return;
    for (const [key, value] of progress.details) detailStore.set(key, value);
    log('info', `[system] [match-fast] 当前平台组准确命中，耗时 ${Date.now() - startedAt}ms，组内已启动的慢源继续搜索: ${ready.resAnime.animeTitle}, ${ready.resEpisode.episodeTitle}`);
    resolveReady({ ready });
  };
  const onProgress = canUseReady ? progress => {
    latestProgress = progress;
    void checkReady().catch(error => log('warn', `[system] [match-fast] ${error.message}`));
  } : null;
  const timer = canUseReady ? setTimeout(() => {
    budgetElapsed = true;
    log('info', `[system] [match-fast] 搜索预算 ${budget}ms 到期，检查优先组；没有准确候选时继续等待`);
    void checkReady().catch(error => log('warn', `[system] [match-fast] ${error.message}`));
  }, budget) : null;
  const searchStep = searchSources ? `完整搜索（平台组 ${targetPlatform || '其余启用来源'}，含目录处理与缓存）` : '完整搜索（含目录处理与缓存）';
  const fullSearch = traceMatchStep(log, searchStep, () =>
    searchAnime(searchUrl, preferAnimeId, preferSource, detailStore, targetPlatform, false, onProgress, sourceSearches, searchSources));
  // 当前组继续完成目录与缓存；不会启动后续组或写成手动全源搜索缓存。
  fullSearch.catch(error => log('warn', `[system] [match-fast] 完整搜索失败: ${error.message}`));
  let outcome;
  try {
    outcome = await Promise.race([fullSearch.then(response => ({ response })), readyPromise]);
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
  }
  if (outcome.ready) return outcome.ready;
  const searchRes = outcome.response;
  const searchData = await searchRes.json();
  // 记下本组候选与目录快照，供整次匹配都失败后的 AI 兜底使用（键按加入顺序生成，按作品 ID 查找）。
  if (aiContext && Array.isArray(searchData?.animes)) {
    aiContext.animes.push(...searchData.animes);
    for (const value of detailStore.values()) aiContext.details.set(aiContext.details.size, value);
  }
  log('info', `[system] [match-timing] 搜索等待结束，耗时 ${Date.now() - startedAt}ms，候选 ${searchData?.animes?.length || 0} 个`);
  log("info", `[system] [match] searchData: ${searchData.animes}`);
  log("info", `[system] [match] Dynamic platformOrder: ${dynamicPlatformOrder}`);
  log("info", `[system] [match] Preferred platform: ${preferredPlatform || 'none'}`);

  // 本次尝试写入缓存时若失败（如剧集 ID 越界），带回原因，供"未匹配"时向调用方说明
  const cacheWarning = getAddAnimeError(detailStore);

  if (!searchData?.success || !Array.isArray(searchData.animes) || searchData.animes.length === 0) {
    return { resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning };
  }

  if (collectionContext) {
    const candidates = searchData.animes.filter(anime => {
      const reason = workIdentityConflict(anime, { year, mediaType: mediaType || 'tv', tmdbIdentity });
      if (reason) log('info', `[system] [match-reject] ${anime.animeTitle}，原因=${reason}`);
      return !reason;
    });
    const selected = selectCollectionEpisode(candidates, collectionContext,
      anime => getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes || []);
    return { resAnime: null, resEpisode: null, spilloverMatched: false, ...selected, title, season, episode, cacheWarning };
  }

  if (fileNameVarietyKey) {
    const candidates = tmdbIdentity ? filterTmdbMatchCandidates(searchData.animes, tmdbIdentity) : searchData.animes;
    const catalog = candidates.filter(anime => !workIdentityConflict(anime, { year, mediaType, tmdbIdentity })).map(anime => ({ ...anime, links:
      resolveAnimeByIdFromDetailStore(anime.bangumiId || anime.animeId, detailStore, anime.source)?.links || anime.links }));
    const selected = selectVarietyEpisodeByKey(catalog, fileNameVarietyKey,
      anime => getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes);
    if (selected) log('info', `[system] [match] 文件名期号直接对应平台分集: ${fileNameVarietyKey} -> ${selected.resAnime.animeTitle} / ${selected.resEpisode.episodeTitle}`);
    else log('info', '[system] [match-reject] 文件名期号在官方目录里没有唯一对应的分集');
    return { resAnime: null, resEpisode: null, spilloverMatched: false, ...selected, title, season, episode, cacheWarning };
  }

  if (tmdbEpisode) {
    const catalog = searchData.animes.map(anime => ({ ...anime, links:
      resolveAnimeByIdFromDetailStore(anime.bangumiId || anime.animeId, detailStore, anime.source)?.links || anime.links }));
    const selected = selectTmdbEpisode(catalog, tmdbEpisode, tmdbIdentity,
      anime => getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes);
    if (selected) log('info', `[system] [match] TMDB 分集精确对应: ${tmdbEpisode.name} -> ${selected.resAnime.animeTitle} / ${selected.resEpisode.episodeTitle}`);
    else log('info', '[system] [match-reject] TMDB 分集没有唯一且符合季号、年份、标题或真实日期及上下篇的分集');
    return { resAnime: null, resEpisode: null, spilloverMatched: false, ...selected, title, season, episode, cacheWarning };
  }

  if (!season && !episode) searchData.animes = searchData.animes.map(anime => {
    const original = extractAnimeTitle(anime.animeTitle);
    const baseTitle = stripMovieAudioTags(original);
    return baseTitle !== original ? { ...anime, aliases: [...new Set([...(anime.aliases || []), baseTitle])] } : anime;
  });
  const titleGuard = mapping || (strictTargetTitle ? { targetTitle: title } : null);
  const guardedCandidates = titleGuard ? filterMappingTargetCandidates(searchData.animes, titleGuard) : searchData.animes;
  const decision = {};
  const targetCandidates = confidentCandidates(guardedCandidates, { title, season, episode, year, mapping, tmdbIdentity, mediaType, details: detailStore, decision, mappedTitleSeason });
  if (decision.ambiguousWork) return { resAnime: null, resEpisode: null, spilloverMatched: false,
    ambiguousWork: true, title, season, episode, cacheWarning };
  if (titleGuard && targetCandidates.length === 0) {
    log('info', '[system] [match-reject] 映射目标标题过滤后无候选');
    return { resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning };
  }

  const targetSearchData = { ...searchData, animes: targetCandidates };
  const candidatePasses = [];
  if (mapping?.targetYear || mapping?.targetType || mapping?.targetTmdbId) {
    const qualified = filterMappingQualifierCandidates(targetCandidates, mapping);
    if (qualified.length > 0) {
      candidatePasses.push({ searchData: { ...searchData, animes: qualified }, year: mapping.targetYear || null, label: 'qualified' });
    }
  }
  if (!(mapping?.targetYear || mapping?.targetType || mapping?.targetTmdbId)) {
    candidatePasses.push({ searchData: targetSearchData, year: mapping ? null : year, label: mapping ? 'fallback' : 'default' });
  }

  for (const pass of candidatePasses) {
    const selected = await traceMatchStep(log, `候选验证 ${pass.label}`, () => selectAnimeMatch({
      season,
      episode,
      year: pass.year,
      searchData: pass.searchData,
      title,
      req,
      dynamicPlatformOrder,
      preferAnimeId,
      offsets,
      detailStore, mappedTitleSeason, movieVersion
    }));
    if (selected.resAnime && selected.resEpisode) {
      // Explicit mappings must yield that episode in that numbering system.
      // The ordinary fallback may use array positions or another platform;
      // those results are not evidence that a mapped path succeeded.
      if (mapping && (selected.spilloverMatched
          || extractEpisodeNumberFromTitle(selected.resEpisode.episodeTitle) !== episode
          || (mapping.targetPlatform && getPlatformMatchScore(
            extractEpisodeTitle(selected.resEpisode.episodeTitle), mapping.targetPlatform) <= 0))) {
        log('info', '[system] [match-reject] 季集映射候选不满足明确目标集号或指定平台，或发生跨季溢出，继续回退');
        continue;
      }
      if (mapping && pass.label === 'qualified') {
        log('info', `[system] [auto-match-mapping] Matched preferred target qualifiers for "${mapping.targetDisplayTitle}"`);
      }
      if (!preferAnimeId && !offsets && season && episode &&
          (selected.spilloverMatched || extractEpisodeNumberFromTitle(selected.resEpisode.episodeTitle) !== episode)) {
        log('info', '[system] [match-reject] 缺少明确目标集号，不能用跨季或数组位置代替');
        continue;
      }
      return { ...selected, title, season, episode, cacheWarning };
    }
  }

  // 常规季集选择失败后，用 TMDB 分集身份在本平台组内再定位一次（整次匹配只查询一次 TMDB）；
  // 命中即可停止遍历后续平台组，避免为同一部作品重复搜索所有来源。
  if (tmdbEpisodeHint && !tmdbEpisode) {
    const hint = await tmdbEpisodeHint().catch(() => null);
    if (hint) {
      const hintCatalog = targetCandidates.map(anime => ({ ...anime, links:
        resolveAnimeByIdFromDetailStore(anime.bangumiId || anime.animeId, detailStore, anime.source)?.links || anime.links }));
      const hinted = selectTmdbEpisode(hintCatalog, hint, tmdbIdentity,
        anime => getBangumiDataForMatch(anime, detailStore)?.bangumi?.episodes);
      if (hinted) {
        log('info', `[system] [match] TMDB 分集提示命中: ${hint.name} -> ${hinted.resAnime.animeTitle} / ${hinted.resEpisode.episodeTitle}`);
        return { resAnime: null, resEpisode: null, spilloverMatched: false, ...hinted, title, season, episode, cacheWarning };
      }
    }
  }

  return { resAnime: null, resEpisode: null, spilloverMatched: false, title, season, episode, cacheWarning };
}

export function selectCollectionEpisode(animes, context, getEpisodes) {
  const normalize = title => normalizeTitleForMatch(String(title).normalize('NFKC').toLowerCase());
  const names = ugcEpisodeTitles(context).map(normalize);
  const related = new Set([...filterMappingTargetCandidates(animes, { targetTitle: context.title }),
    ...filterMappingTargetCandidates(animes, { targetTitle: context.collectionTitle })]);
  const candidates = animes.filter(anime => related.has(anime));
  for (const anime of candidates) {
    const candidateYear = extractYear(anime.animeTitle) || Number(String(anime.startDate || '').slice(0, 4));
    let reason = null;
    // 重编合集的目录年份不代表其中短片的年份；有单集名时按内容身份确认。
    if (!names.length && context.yearRange && candidateYear &&
        (candidateYear < context.yearRange[0] || candidateYear > context.yearRange[1])) reason = 'year-outside-collection';
    const sameCollection = [anime.animeTitle, ...(anime.aliases || [])]
      .some(title => normalize(String(title).replace(/\s*from\s+.+$/i, '').replace(/【[^】]*】/g, '')) === normalize(context.collectionTitle));
    if (!names.length && !sameCollection) reason ||= 'collection-version-unconfirmed';
    if (reason) {
      logEvent('info', 'match.candidate.reject', `[system] [match-reject] ${anime.animeTitle}，原因=${reason}`,
        { candidateTitle: anime.animeTitle, reason, collectionTitle: context.collectionTitle, yearRange: context.yearRange });
      continue;
    }
    // 合集编号只在同一合集目录中有效；其他目录必须通过具体短片名确认内容。
    const episodes = filterEpisodesByTitle(getEpisodes(anime));
    const matching = episodes.filter(ep => names.length
      ? ugcEpisodeTitles({ episodeTitle: ep.episodeTitle }).some(candidate => {
        const normalized = normalize(candidate).replace(normalize(context.title), '').trim();
        return names.includes(normalized);
      })
      : extractEpisodeNumberFromTitle(ep.episodeTitle) === context.episode);
    if (matching.length !== 1) {
      const reason = matching.length ? 'collection-episode-ambiguous' : 'episode-title-mismatch';
      logEvent('info', 'match.candidate.reject', `[system] [match-reject] ${anime.animeTitle}，原因=${reason}`,
        { candidateTitle: anime.animeTitle, reason, episodeTitle: context.episodeTitle, matchingCount: matching.length });
      continue;
    }
    log('info', `[system] [match] 合集分集确认: ${context.collectionTitle} S${context.season}E${context.episode} / ${context.episodeTitle} -> ${anime.animeTitle} / ${matching[0].episodeTitle}`);
    return { resAnime: anime, resEpisode: matching[0] };
  }
  return null;
}

function normalizeMatchTitle(title) {
  let normalized = String(title || '').trim();
  if (globals.animeTitleSimplified) normalized = simplized(normalized);
  if (globals.titleNoiseFilter) normalized = normalized.replace(globals.titleNoiseFilter, '').trim();
  return normalized;
}

function findSeasonPreferenceTitle(titles, season) {
  if (!globals.rememberLastSelect) return null;
  for (const title of titles) {
    if (title && hasSeasonSpecificPreference(title, season)) return title;
  }
  return null;
}

// Extracted function for POST /api/v2/match
export function matchAnime(url, req, clientIp) {
  return runWithCommentTransform(() => matchAnimeRequest(url, req, clientIp), { deferProcessing: true });
}

async function matchAnimeRequest(url, req, clientIp) {
  return runWithHttpCache(() => runWithMatchTrace(async () => {
    const startedAt = performance.now();
    logEvent('info', 'match.start', '[system] [match-trace] 开始匹配');
    try {
      const response = await matchAnimeWithTrace(url, req, clientIp);
      const durationMs = Math.round(performance.now() - startedAt);
      logEvent('info', 'match.return', `[system] [match-trace] 请求返回，HTTP ${response.status}，总耗时 ${durationMs}ms（当前平台组已启动的后台搜索可能继续）`, { status: response.status, durationMs });
      return response;
    } catch (error) {
      log('error', `[system] [match-trace] 请求异常，总耗时 ${Math.round(performance.now() - startedAt)}ms`);
      throw error;
    }
  }));
}

async function matchAnimeWithTrace(url, req, clientIp) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body) {
      log("error", "[system] [match] Request body is empty");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Empty request body" },
        400
      );
    }

    // 处理请求体中的数据
    // 假设请求体包含一个字段，比如 { query: "anime name" }
    const { fileName } = body;
    logEvent('info', 'match.request', '[system] [match-trace] 播放器原始请求 ' + JSON.stringify({ fileName,
      method: req.method, endpoint: '/api/v2/match', userAgent: req.headers.get('user-agent'), clientIp }),
      { fileName, method: req.method, endpoint: '/api/v2/match', userAgent: req.headers.get('user-agent'), clientIp });
    const requestMediaType = body.mediaType;
    if ((requestMediaType !== undefined && !['tv', 'movie'].includes(requestMediaType)) ||
        (body.year !== undefined && (!Number.isInteger(body.year) || body.year < 1900 || body.year > 2099)) ||
        (body.tmdbId !== undefined && (!/^[1-9]\d*$/.test(String(body.tmdbId)) || !Number.isSafeInteger(Number(body.tmdbId)) || !requestMediaType))) {
      return jsonResponse({ errorCode: 400, success: false, errorMessage: 'Invalid year, mediaType or tmdbId; tmdbId requires mediaType (tv/movie)' }, 400);
    }
    if (typeof fileName !== 'string' || !fileName.trim()) {
      log("error", "[system] [match] Missing fileName parameter in request body");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing fileName parameter" },
        400
      );
    }

    // 解析fileName，提取平台偏好
    const { cleanFileName, preferredPlatform, releaseGroups } = parseFileName(fileName);
    log("info", `[system] [match] Processing anime match for query: ${fileName}`);
    log("info", `[system] [match] Parsed cleanFileName: ${cleanFileName}, preferredPlatform: ${preferredPlatform}, releaseGroups: ${releaseGroups.join(',') || 'none'}`);

    const movieVersion = movieAudioVersion(fileName.split(/[\\/]/).pop());
    const parsed = await traceMatchStep(log, '文件名解析', () => extractTitleSeasonEpisode(cleanFileName, releaseGroups));
    if (!parsed.season && !parsed.episode) parsed.title = stripMovieAudioTags(parsed.title);
    if (body.year !== undefined) parsed.year = body.year;
    if (requestMediaType) parsed.mediaType = requestMediaType;
    if (body.tmdbId !== undefined) parsed.tmdbId = String(body.tmdbId);
    if (requestMediaType === 'movie') { parsed.season = null; parsed.episode = null; }
    const fileNameVarietyKey = varietyKey(extractVarietyFragment(cleanFileName));
    if (fileNameVarietyKey) log('info', `[system] [match] 文件名已写明综艺期号: ${fileNameVarietyKey}`);
    const originalTitle = normalizeMatchTitle(parsed.title);
    const originalSeason = parsed.season;
    const preferenceTitles = [...new Set([originalTitle, parsed.title].filter(Boolean))];
    const manualPreferenceTitle = findSeasonPreferenceTitle(preferenceTitles, originalSeason);
    let savedIdentityCandidates = globals.animes;
    if (manualPreferenceTitle && !parsed.year && !parsed.tmdbId) {
      // 无身份请求先尊重已选版本，不能借用同名其他版本的 TMDB 缓存覆盖选择。
      const [animeId, source] = getPreferAnimeId(manualPreferenceTitle, originalSeason);
      savedIdentityCandidates = globals.animes.filter(anime => String(anime.animeId) === String(animeId) &&
        (!source || anime.source === source));
    }
    let tmdbIdentity = findSavedTmdbIdentity(savedIdentityCandidates, parsed);
    let tmdbIdentityAttempted = false;
    if (parsed.tmdbId) {
      tmdbIdentityAttempted = true;
      tmdbIdentity = await traceMatchStep(log, '播放器 TMDB 身份', () => resolveTmdbMatchIdentity(parsed));
      if (!tmdbIdentity) return jsonResponse({ errorCode: 0, success: true, errorMessage: 'Unable to confirm supplied TMDB identity', isMatched: false, matches: [] });
    }
    const sourceSearches = new Map();
    const identity = { title: parsed.title, year: parsed.year, mediaType: requestMediaType, season: parsed.season, episode: parsed.episode, preferredPlatform, releaseGroups, tmdbIdentity };
    logEvent('info', 'match.identity', '[system] [match-trace] 解析身份 ' + JSON.stringify(identity), identity);
    const originalEpisode = parsed.episode;
    const fileEpisodeTitle = parsed.episodeTitle;
    const fileContext = buildUgcRequestContext({ title: parsed.title, year: parsed.year,
      season: originalSeason, episode: originalEpisode, episodeTitle: fileEpisodeTitle, type: '电视剧' });
    const collectionContext = fileContext?.collectionTitle ? fileContext : null;
    if (collectionContext) logEvent('info', 'match.collection', '[system] [match-trace] 保留合集身份 ' + JSON.stringify(collectionContext), collectionContext);
    let originalYear = parsed.year || (tmdbIdentity ? (originalSeason > 1 ? tmdbIdentity.seasonYear : tmdbIdentity.year) : null);
    const originalReleaseGroups = parsed.releaseGroups || releaseGroups || [];

    const attemptedTitlePaths = new Set();
    let attempt = null;
    let mappingApplied = false;
    let mapping = null;
    let matchStage = '';
    let localTitleMapping = null;
    let remoteTitleMapping = null;
    let collectionRace = null;
    let ugcAttemptPromise = null;

    // 常规匹配、映射、TMDB 与投稿兜底都失败后，用这次请求搜索到的候选做最后一次 AI 判定。
    const aiContext = { animes: [], details: new Map() };

    const succeeded = value => Boolean(value?.resAnime && value?.resEpisode);

    // 同一个 TMDB 分集查询在整次匹配中只执行一次：只有平台组完成搜索且常规季集选择失败时
    // 才会真正发起，命中后当前平台组直接返回，不再遍历后续平台组。
    let tmdbEpisodeHintPromise = null;
    const tmdbEpisodeHint = () => {
      if (collectionContext || !tmdbIdentity || originalSeason === 0 || !Number.isInteger(originalSeason) ||
          !Number.isInteger(originalEpisode) || originalEpisode < 1) return Promise.resolve(null);
      tmdbEpisodeHintPromise ||= resolveTmdbEpisodeMetadata(tmdbIdentity, originalSeason, originalEpisode)
        .catch(error => { log('warn', `[system] [match] TMDB 分集提示查询失败: ${error.message}`); return null; });
      return tmdbEpisodeHintPromise;
    };

    const tryTitlePath = async ({ stage, title, preferAnimeId = null, preferSource = null, offsets = null, strictTargetTitle = false, mappedTitleSeason = false }) => {
      const normalizedTitle = normalizeMatchTitle(title);
      const pathKey = JSON.stringify([normalizedTitle, originalSeason, originalEpisode, preferAnimeId, preferSource, offsets, strictTargetTitle, mappedTitleSeason]);
      if (attemptedTitlePaths.has(pathKey)) {
        log('info', `[system] [match-waterfall] 跳过重复路径 ${stage}`);
        return null;
      }
      attemptedTitlePaths.add(pathKey);
      log('info', `[system] [match-waterfall] 尝试 ${stage}: ${normalizedTitle} S${originalSeason}E${originalEpisode}`);
      const result = await traceMatchStep(log, stage, () => executeMatchAttempt({
        req,
        title: normalizedTitle,
        season: originalSeason,
        episode: originalEpisode,
        year: originalYear,
        mediaType: requestMediaType,
        movieVersion,
        preferredPlatform,
        secondaryPreferredPlatform: null,
        preferAnimeId,
        preferSource,
        offsets,
        mapping: null,
        tmdbIdentity,
        tmdbEpisodeHint,
        sourceSearches,
        strictTargetTitle, mappedTitleSeason,
        collectionContext: !strictTargetTitle && !preferAnimeId && !offsets ? collectionContext : null,
        collectionRace, aiContext
      }));
      if (!succeeded(result) && !collectionRace?.ugcMatched) log('info', `[system] [match-waterfall] ${stage} 未得到有效作品与分集，继续回退`);
      if (succeeded(result) && !collectionRace?.ugcMatched) {
        matchStage = stage;
        log('info', `[system] [match-waterfall] ${stage} 实际匹配成功，停止后续匹配`);
      }
      return result;
    };

    const tryAutoMappingPath = async (stage, rule) => {
      if (!rule) return null;
      const ruleId = rule.sourceTmdbId || rule.targetTmdbId;
      const ruleType = rule.sourceTmdbType || rule.targetTmdbType || 'tv';
      if (tmdbIdentity && ruleId && `${ruleType}:${ruleId}` !== tmdbIdentity.key) return null;
      const mappedTitle = normalizeMatchTitle(rule.targetTitle);
      const mappedPlatform = rule.targetPlatform || preferredPlatform;
      log('info', `[system] [match-waterfall] 尝试 ${stage}: ${originalTitle} S${originalSeason}E${originalEpisode} -> ${mappedTitle} S${rule.targetSeason}E${rule.targetEpisode}`);
      const result = await traceMatchStep(log, stage, () => executeMatchAttempt({
        req,
        title: mappedTitle,
        season: rule.targetSeason,
        episode: rule.targetEpisode,
        year: rule.targetYear,
        mediaType: requestMediaType,
        preferredPlatform: mappedPlatform,
        secondaryPreferredPlatform: rule.targetPlatform ? preferredPlatform : null,
        preferAnimeId: null,
        preferSource: null,
        offsets: null,
        mapping: rule,
        tmdbIdentity,
        sourceSearches, aiContext
      }));
      if (!succeeded(result)) log('info', `[system] [match-waterfall] ${stage} 未得到有效作品与分集，继续回退`);
      if (succeeded(result)) {
        mapping = rule;
        mappingApplied = true;
        matchStage = stage;
        log('info', `[system] [match-waterfall] ${stage} 实际匹配成功，停止后续匹配`);
      }
      return result;
    };

    // 1. 本机显式选择最高优先；失败才继续其他本机路径。
    if (manualPreferenceTitle) {
      const [preferAnimeId, preferSource, offsets] = getPreferAnimeId(manualPreferenceTitle, originalSeason);
      attempt = await tryTitlePath({ stage: '本机手动选择', title: manualPreferenceTitle, preferAnimeId, preferSource, offsets });
    }

    // 2. 本机规则先按原始标题/别名查找明确季集修正，失败再仅替换标题。
    // 本机手动选择和本机配置仍优先于远程数据；所有阶段以实际匹配为准。
    if (!succeeded(attempt)) {
      localTitleMapping = resolveLocalTitleMapping(parsed.title, originalSeason, originalYear);
      const localOptions = {
        title: originalTitle,
        identityKey: tmdbIdentity?.key || '',
        aliasTitle: localTitleMapping.matched ? normalizeMatchTitle(localTitleMapping.title) : '',
        season: originalSeason, episode: originalEpisode,
        releaseGroups: originalReleaseGroups, preferredPlatform
      };
      const localCandidates = [...collectAutoMatchCandidates(globals.autoMatchMappingTable, localOptions),
        ...(tmdbIdentity ? collectAutoMatchCandidates(globals.autoMatchMappingTable, { ...localOptions, identityKey: '' }) : [])];
      for (const rule of localCandidates) {
        attempt = await tryAutoMappingPath('本机标题+季集映射', rule) || attempt;
        if (succeeded(attempt)) break;
      }
      if (!succeeded(attempt) && localTitleMapping.matched) {
        const title = normalizeMatchTitle(localTitleMapping.title);
        const [preferAnimeId, preferSource, offsets] = globals.rememberLastSelect
          ? getPreferAnimeId(title, originalSeason) : [null, null, null];
        attempt = await tryTitlePath({ stage: '本机标题映射', title, preferAnimeId, preferSource, offsets, strictTargetTitle: true, mappedTitleSeason: /S0*([1-9]\d*)(?!\d)/i.exec(localTitleMapping.key)?.[1] === String(originalSeason) }) || attempt;
      }
    }

    // 3. 远程表只读本机缓存，不在请求中下载规则。明确季集规则先于标题别名。
    if (!succeeded(attempt)) {
      await ensureCachedRemoteTitleMapping();
      await ensureRemoteAutoMatchMapping();
      remoteTitleMapping = resolveCachedRemoteTitleMapping(parsed.title, originalSeason, originalYear);
      const remoteOptions = {
        title: originalTitle,
        identityKey: tmdbIdentity?.key || '',
        aliasTitle: remoteTitleMapping.matched ? normalizeMatchTitle(remoteTitleMapping.title) : '',
        season: originalSeason, episode: originalEpisode,
        releaseGroups: originalReleaseGroups, preferredPlatform
      };
      const remoteCandidates = [...collectAutoMatchCandidates(getCachedRemoteAutoMatchMappingRules(), remoteOptions),
        ...(tmdbIdentity ? collectAutoMatchCandidates(getCachedRemoteAutoMatchMappingRules(), { ...remoteOptions, identityKey: '' }) : [])];
      for (const rule of remoteCandidates) {
        attempt = await tryAutoMappingPath('远程标题+季集缓存', rule) || attempt;
        if (succeeded(attempt)) break;
      }
      if (!succeeded(attempt) && remoteTitleMapping.matched) {
        const title = normalizeMatchTitle(remoteTitleMapping.title);
        const [preferAnimeId, preferSource, offsets] = globals.rememberLastSelect
          ? getPreferAnimeId(title, originalSeason) : [null, null, null];
        attempt = await tryTitlePath({ stage: '远程标题缓存', title, preferAnimeId, preferSource, offsets, strictTargetTitle: true, mappedTitleSeason: /S0*([1-9]\d*)(?!\d)/i.exec(remoteTitleMapping.key)?.[1] === String(originalSeason) }) || attempt;
      }
    }

    const tryTmdbEpisodePath = async () => {
      if (collectionContext || !tmdbIdentity || !Number.isInteger(originalSeason) || !Number.isInteger(originalEpisode)) return;
      const label = originalSeason === 0 ? 'TMDB 特别篇' : 'TMDB 普通分集';
      let metadata = null;
      try {
        metadata = await traceMatchStep(log, `${label}分集查询`, () =>
          resolveTmdbEpisodeMetadata(tmdbIdentity, originalSeason, originalEpisode));
      } catch (error) { log('warn', `[system] [match] ${label}查询失败: ` + error.message); }
      if (metadata) {
        log('info', '[system] [match-trace] TMDB 分集身份 ' + JSON.stringify(metadata));
        attempt = await traceMatchStep(log, `${label}对应平台分集`, () => executeMatchAttempt({
          req, title: tmdbIdentity.title, season: metadata.targetSeason, episode: null,
          year: metadata.year, mediaType: requestMediaType, preferredPlatform, tmdbIdentity, tmdbEpisode: metadata,
          sourceSearches, preferAnimeId: null, preferSource: null, offsets: null, mapping: null, aiContext
        }));
        if (succeeded(attempt)) matchStage = `${label}对应平台分集`;
      }
    };

    // 官方平台在适用画像下都没命中时，用 B站投稿兜底出一个可分集，让播放器仍有弹幕可取。
    // 只面向番剧/国外剧/国外平台（见 isUgcApplicable）；预算用完就放弃，返回未匹配。
    const tryUgcFallback = async () => {
      if (!globals.bilibiliUgcEnabled) return null;
      const isMovie = (tmdbIdentity?.mediaType || requestMediaType) === 'movie' ||
        (originalSeason === null && originalEpisode === null);
      if (!isMovie && (!Number.isInteger(originalEpisode) || originalEpisode < 1)) {
        logEvent('info', 'ugc.skip', '[system] [ugc] 缺少有效剧集编号，跳过投稿兜底', { reason: 'missing-episode', title: originalTitle });
        return null;
      }
      const context = buildUgcRequestContext({
        title: collectionContext ? originalTitle : tmdbIdentity?.title || originalTitle, aliases: tmdbIdentity?.aliases || [],
        year: originalYear, season: originalSeason, episode: originalEpisode, tmdbIdentity,
        episodeTitle: fileEpisodeTitle,
        type: isMovie ? '电影' : '电视剧'
      });
      if (!context) return null;
      // 官方目录里同名条目给出适用画像：候选项类型、命中来源、B站是否已有正片。
      const wanted = normalizeTitleForMatch(String(context.title));
      const related = wanted ? globals.animes.filter(anime => anime.type !== 'B站投稿' &&
        !workIdentityConflict(anime, { year: originalYear, mediaType: tmdbIdentity?.mediaType || requestMediaType, tmdbIdentity }) &&
        normalizeTitleForMatch(String(anime.animeTitle).normalize('NFKC').replace(/\s*from\s+.+$/i, '')).includes(wanted)) : [];
      const types = [...new Set(related.map(anime => anime.type || anime.typeDescription).filter(Boolean))];
      const sources = [...new Set(related.map(anime => anime.source).filter(Boolean))];
      if (!isUgcApplicable({ identity: tmdbIdentity, sources, types }) && !(context.collectionTitle && !tmdbIdentity)) {
        log('info', '[system] [match] UGC 兜底不适用当前作品，跳过');
        return null;
      }
      const logger = createUgcLogger(context);
      if (context.collectionTitle) logger('match.keyword', '从合集名称提取检索词：' + context.title,
        { collectionTitle: context.collectionTitle, keyword: context.title, yearRange: context.yearRange, episodeTitle: context.episodeTitle });
      logger('match.start', collectionRace ? '与正式源并行准备 B站投稿' : '官方源未命中，尝试 B站投稿兜底',
        { season: originalSeason, episode: originalEpisode, mode: collectionRace ? 'parallel' : 'fallback' });
      let found = null;
      try {
        const prepared = await ugcSupplement.prepare(context, { budgetMs: UGC_MATCH_BUDGET_MS, logger });
        found = prepared.result;
      } catch (error) {
        logger('match.failure', 'UGC 兜底检索失败：' + error.message, { reason: error.message }, 'warn');
        return null;
      }
      const candidates = (found?.candidates || []).filter(item =>
        found.accepted.some(accepted => accepted.cid === item.cid && accepted.comments.length))
        .map(item => ({ ...item, searchCount: found.accepted.find(accepted => accepted.cid === item.cid).comments.length }));
      const candidate = pickUgcEpisode(candidates);
      if (!candidate) {
        const timedOut = !found || found.timedOut;
        logger('match.none', timedOut ? 'UGC 兜底超时，未取得可用弹幕' : 'UGC 兜底没有可用分集',
          { reason: timedOut ? 'timeout' : 'no-usable-comments' });
        return null;
      }
      const accepted = found.accepted.filter(item => candidates.some(candidate => candidate.cid === item.cid));
      const comments = convertToDanmakuJson(mergeUgcComments([], accepted), 'bilibili');
      if (!comments.length) { logger('match.none', 'UGC 兜底没有有效时间范围内的弹幕'); return null; }
      const urls = [...new Set(candidates.map(item => item.url))].sort();
      const episodeUrl = urls.length > 1 ? urls.map(url => 'bilibili:' + url).join(MERGE_DELIMITER) : candidate.url;
      const ugcAnimeId = 900000000 + [...String(candidate.bvid)].reduce((acc, ch) => (acc * 31 + ch.codePointAt(0)) % 99999999, 7);
      const prior = globals.animes.find(anime => anime.animeId === ugcAnimeId && anime.type === 'B站投稿');
      const episodeTitle = isMovie ? '正片' : `第${String(originalEpisode).padStart(2, '0')}集`;
      const links = [...(prior?.links || []).filter(link => link.title !== episodeTitle), { url: episodeUrl, title: episodeTitle }];
      const resAnime = { animeId: ugcAnimeId, source: 'bilibili', bangumiId: 'ugc:' + candidate.bvid, type: 'B站投稿', typeDescription: 'B站投稿',
        animeTitle: `${context.title}${originalYear ? `(${originalYear})` : ''}${originalSeason > 1 ? ` 第${originalSeason}季` : ''}【B站投稿】`,
        imageUrl: '', startDate: originalYear ? `${originalYear}-01-01` : '', episodeCount: links.length,
        aliases: [originalTitle, context.title, ...(context.aliases || [])], tmdbIdentity, links };
      if (!addAnime(resAnime)) return null;
      const episode = globals.animes.find(anime => anime.animeId === ugcAnimeId && anime.type === 'B站投稿').links.find(link => link.url === episodeUrl);
      setCommentCache(resolveCommentCacheKey(episodeUrl), comments);
      if (globals.localCacheValid) await updateLocalCaches({ keys: ['animes', 'episodeIds', 'episodeNum'] });
      if (globals.localRedisValid) await updateLocalRedisCaches({ keys: ['animes', 'episodeIds', 'episodeNum'] });
      logger('match.hit', 'UGC 兜底合并 ' + urls.length + ' 个投稿分P，过滤去重后返回 ' + comments.length + ' 条弹幕',
        { bvid: candidate.bvid, cid: candidate.cid, episodeId: episode.id, searchCount: candidate.searchCount,
          candidates: candidates.map(item => ({ bvid: item.bvid, cid: item.cid, page: item.page, title: item.title, part: item.part, evidence: item.evidence, count: item.searchCount })),
          finalCount: comments.length, episodeTitleMatched: Boolean(candidate.evidence?.episodeTitleMatched) });
      return {
        resAnime,
        resEpisode: { episodeId: episode.id, episodeTitle, url: episodeUrl },
        spilloverMatched: false, title: context.title, season: originalSeason, episode: originalEpisode
      };
    };

    // S00 uses TMDB's special numbering. Resolve the episode before starting
    // ordinary platform groups; explicit preferences and mappings stay first.
    if (!succeeded(attempt) && originalSeason === 0 && !tmdbIdentity && (globals.tmdbApiKey || globals.proxyUrl)) {
      tmdbIdentityAttempted = true;
      try { tmdbIdentity = await traceMatchStep(log, 'TMDB 特别篇作品识别', () => resolveTmdbMatchIdentity(parsed)); }
      catch (error) { log('warn', '[system] [match] TMDB 特别篇作品识别失败: ' + error.message); }
      if (tmdbIdentity) {
        log('info', '[system] [match] 已确认 TMDB 身份: ' + tmdbIdentity.key);
        const options = { identityKey: tmdbIdentity.key, season: originalSeason, episode: originalEpisode,
          releaseGroups: originalReleaseGroups, preferredPlatform };
        for (const rules of [globals.autoMatchMappingTable, getCachedRemoteAutoMatchMappingRules()]) {
          for (const rule of collectAutoMatchCandidates(rules, options)) {
            attempt = await tryAutoMappingPath('TMDB 身份季集修正', rule) || attempt;
            if (succeeded(attempt)) break;
          }
          if (succeeded(attempt)) break;
        }
      }
    }

    if (!succeeded(attempt) && tmdbIdentity && originalSeason === 0) await tryTmdbEpisodePath();

    // 6. 非 S00 请求先走默认匹配；S00 不使用平台目录位置解释特别篇编号。
    if (!succeeded(attempt) && originalSeason !== 0) {
      const [preferAnimeId, preferSource, offsets] = globals.rememberLastSelect
        ? getPreferAnimeId(originalTitle, originalSeason) : [null, null, null];
      const options = { stage: tmdbIdentity ? 'TMDB 作品直接搜索' : '本机普通匹配',
        title: collectionContext?.title || tmdbIdentity?.title || originalTitle, preferAnimeId, preferSource, offsets };
      if (collectionContext && ugcEpisodeTitles(collectionContext).length && globals.bilibiliUgcEnabled &&
          !preferredPlatform && !preferAnimeId && !offsets) {
        // 已有具体短片身份时，两边仍各自校验；返回最先确认的内容，不等所有平台失败。
        collectionRace = { ugcMatched: false };
        const raceStarted = performance.now();
        let selectedKind = null;
        const completed = {};
        const recordCompletion = (kind, value) => {
          completed[kind] = { durationMs: Math.round(performance.now() - raceStarted),
            matched: Boolean(succeeded(value)), episodeId: value?.resEpisode?.episodeId ?? null };
          logEvent('info', 'match.parallel.complete', `[system] [match-parallel] ${kind} 完成，${selectedKind ? `已选择 ${selectedKind}` : '尚未选择'}`,
            { kind, ...completed[kind], selectedKind, completedAfterSelection: selectedKind !== null });
          return value;
        };
        logEvent('info', 'match.parallel.start', '[system] [match-parallel] 正式源与UGC同时启动',
          { episodeTitle: fileEpisodeTitle, ugcBudgetMs: UGC_MATCH_BUDGET_MS });
        ugcAttemptPromise = traceMatchStep(log, '合集单集投稿并行匹配', tryUgcFallback)
          .then(value => recordCompletion('ugc', value));
        const ordinary = tryTitlePath(options).then(value => recordCompletion('official', value));
        let winner = await Promise.race([
          ordinary.then(value => ({ kind: 'official', value })),
          ugcAttemptPromise.then(value => ({ kind: 'ugc', value }))
        ]);
        if (!succeeded(winner.value)) winner = winner.kind === 'official'
          ? { kind: 'ugc', value: await ugcAttemptPromise }
          : { kind: 'official', value: await ordinary };
        attempt = winner.value || attempt;
        selectedKind = succeeded(winner.value) ? winner.kind : 'none';
        logEvent('info', 'match.parallel.choice', `[system] [match-parallel] 最终选择 ${selectedKind}，按先成功返回，未比较弹幕数量`,
          { selectedKind, durationMs: Math.round(performance.now() - raceStarted),
            official: completed.official || { pending: true }, ugc: completed.ugc || { pending: true },
            reason: 'first-success', episodeId: winner.value?.resEpisode?.episodeId ?? null });
        if (succeeded(attempt) && winner.kind === 'ugc') {
          collectionRace.ugcMatched = true;
          matchStage = '合集单集投稿快速匹配';
        }
      } else attempt = await tryTitlePath(options) || attempt;
    }

    // 文件名已经写明「第N期[上下]」时直接用它在官方目录里定位，先不问 TMDB：
    // 作品名 + 期号 + 上下篇已经足够，唯一命中即返回；没有期号或不唯一才继续走 TMDB。
    if (!succeeded(attempt) && originalSeason !== 0 && fileNameVarietyKey) {
      attempt = await traceMatchStep(log, '文件名期号对应平台分集', () => executeMatchAttempt({
        req, title: normalizeMatchTitle(tmdbIdentity?.title || originalTitle), season: originalSeason, episode: null,
        year: originalYear, mediaType: requestMediaType, preferredPlatform, fileNameVarietyKey, sourceSearches, tmdbIdentity,
        preferAnimeId: null, preferSource: null, offsets: null, mapping: null
      })) || attempt;
      if (succeeded(attempt)) matchStage = '文件名期号对应平台分集';
    }

    if (!succeeded(attempt) && !collectionContext && !tmdbIdentity && !tmdbIdentityAttempted && (globals.tmdbApiKey || globals.proxyUrl)) {
      tmdbIdentityAttempted = true;
      try { tmdbIdentity = await traceMatchStep(log, 'TMDB 辅助识别', () => resolveTmdbMatchIdentity(parsed)); }
      catch (error) { log('warn', '[system] [match] TMDB 辅助识别失败: ' + error.message); }
      if (tmdbIdentity) {
        log('info', '[system] [match] 已确认 TMDB 身份: ' + tmdbIdentity.key);
        originalYear = parsed.year || (originalSeason > 1 ? tmdbIdentity.seasonYear : tmdbIdentity.year);
        const options = { identityKey: tmdbIdentity.key, season: originalSeason, episode: originalEpisode,
          releaseGroups: originalReleaseGroups, preferredPlatform };
        for (const rules of [globals.autoMatchMappingTable, getCachedRemoteAutoMatchMappingRules()]) {
          for (const rule of collectAutoMatchCandidates(rules, options)) {
            attempt = await tryAutoMappingPath('TMDB 身份季集修正', rule) || attempt;
            if (succeeded(attempt)) break;
          }
          if (succeeded(attempt)) break;
        }
        // Limit alias expansion to one new title; reuse raw searches when the title is unchanged.
        if (!succeeded(attempt)) {
          attemptedTitlePaths.clear();
          attempt = await tryTitlePath({ stage: 'TMDB 辅助作品匹配', title: tmdbIdentity.title }) || attempt;
        }
      }
    }


    // Ordinary episodes enter this fallback only after default matching fails.
    if (!succeeded(attempt) && tmdbIdentity && originalSeason !== 0) await tryTmdbEpisodePath();

    if (!succeeded(attempt) && originalSeason !== 0) {
      const ugcAttempt = await (ugcAttemptPromise ||= traceMatchStep(log, 'B站投稿兜底', tryUgcFallback));
      if (ugcAttempt) { attempt = ugcAttempt; matchStage = 'B站投稿兜底'; }
    }

    // 常规的标题、季号与分集匹配，以及映射、TMDB 和投稿兜底都没结果时，才让模型在本次搜索到的候选里判一次。
    if (!succeeded(attempt) && !collectionContext && !fileNameVarietyKey && aiContext.animes.length) {
      const aiMatched = await traceMatchStep(log, 'AI 兜底判定', () => aiMatchFallback({
        animes: aiFallbackPool(aiContext.animes, { season: originalSeason, episode: originalEpisode,
          year: originalYear, mediaType: requestMediaType, tmdbIdentity }),
        title: originalTitle, season: originalSeason, episode: originalEpisode,
        year: originalYear, detailStore: aiContext.details, movieVersion
      }));
      if (aiMatched) {
        attempt = { ...aiMatched, spilloverMatched: false, title: originalTitle, season: originalSeason, episode: originalEpisode };
        matchStage = 'AI 兜底判定';
      }
    }

    attempt ||= { resAnime: null, resEpisode: null, spilloverMatched: false, title: originalTitle, season: originalSeason, episode: originalEpisode };

    let { resAnime, resEpisode, spilloverMatched } = attempt;
    if (tmdbIdentity && resAnime && resEpisode && !spilloverMatched) {
      const stored = globals.animes.find(anime => anime.animeId === resAnime.animeId && anime.source === resAnime.source);
      if (stored) {
        stored.tmdbIdentity = tmdbIdentity;
        if (globals.localCacheValid) await updateLocalCaches({ keys: ['animes'] });
        if (globals.localRedisValid) await updateLocalRedisCaches({ keys: ['animes'] });
      }
    }

    if (globals.bilibiliUgcEnabled && resEpisode?.url?.includes(MERGE_DELIMITER) && resAnime.type !== 'B站投稿') {
      try {
        const comments = await fetchMergedComments(resEpisode.url, resAnime.animeTitle, resEpisode.episodeId);
        const cacheKey = resolveCommentCacheKey(resEpisode.url, resEpisode.episodeId);
        const cachedAddedCount = globals.commentCache.get(cacheKey)?.ugcAddedCount || 0;
        const supplemented = await supplementUgcForEpisode(resEpisode.episodeId, resEpisode.url, comments, false);
        if (supplemented.length > comments.length) {
          setCommentCache(cacheKey, supplemented);
          const cached = globals.commentCache.get(cacheKey);
          if (cached) cached.ugcAddedCount = cachedAddedCount + supplemented.length - comments.length;
        }
        if (supplemented.length > comments.length || cachedAddedCount > 0) {
          resAnime = { ...resAnime, animeTitle: resAnime.animeTitle + '【B站投稿】' };
        }
      } catch (error) {
        log('warn', '[system] [match] 合并源 UGC 检查失败，保留官方匹配：' + error.message);
      }
    }

    let resData = {
      "errorCode": 0,
      "success": true,
      "errorMessage": "",
      "isMatched": false,
      "matches": []
    };

    resData["isMatched"] = Boolean(resAnime && resEpisode);
    if (tmdbIdentity) resData.tmdb = tmdbIdentity;

    if (clientIp && !resData.isMatched) {
      setLastSearch(clientIp, { matchIdentity: { title: originalTitle, year: originalYear,
        mediaType: tmdbIdentity?.mediaType || requestMediaType, tmdbIdentity } });
    }

    if (resEpisode) {
      if (clientIp && !spilloverMatched) {
        setLastSearch(clientIp, mappingApplied ? {
          title: originalTitle,
          season: originalSeason,
          episode: originalEpisode,
          episodeId: resEpisode.episodeId,
          matchIdentity: { title: originalTitle, year: originalYear, mediaType: tmdbIdentity?.mediaType || requestMediaType, tmdbIdentity },
          autoMatchMappingApplied: true,
          mappingTargetTitle: mapping.targetTitle
        } : {
          title: attempt.title,
          season: attempt.season,
          episode: attempt.episode,
          episodeId: resEpisode.episodeId,
          matchIdentity: { title: originalTitle, year: originalYear, mediaType: tmdbIdentity?.mediaType || requestMediaType, tmdbIdentity }
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

    const choice = { stage: matchStage || '无成功阶段', isMatched: resData.isMatched, matches: resData.matches.map(m => ({ animeId: m.animeId, animeTitle: m.animeTitle, episodeId: m.episodeId, episodeTitle: m.episodeTitle })) };
    logEvent('info', 'match.result', '[system] [match-trace] 最终选择 ' + JSON.stringify(choice), choice);
    log("info", '[system] [match] resMatchData:', resData);

    // 示例返回
    return jsonResponse(resData);
  } catch (error) {
    // 处理匹配请求中的异常
    log("error", `[system] [match] Error processing match request: ${error.stack || error.message}`);
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: error.message || "Invalid JSON body" },
      400
    );
  }
}

function resolveMissingDirectFallbackSources() {
  const configured = new Set(globals.sourceOrderArr);
  return SUPPORTED_SOURCES.filter(source => !configured.has(source));
}

function resolveTmdbMediaType(url, episode) {
  const type = url.searchParams.get('tmdbIdType');
  return type === '1' || (type !== '0' && String(episode).toLowerCase() === 'movie') ? 'movie' : 'tv';
}

const FEATURE_EDITORIAL_MARKERS = Object.freeze([
  '预告',
  '预览',
  '先导',
  '花絮',
  '彩蛋',
  '幕后',
  '专访',
  '采访',
  '解说',
  '深度解读',
  '影评',
  '解析',
  '盘点',
  '混剪',
  '回顾',
  '速看',
  'reaction',
  'trailer',
  'making of',
  'behind the scenes',
]);

function isFeatureRequest(url, episode) {
  return resolveTmdbMediaType(url, episode) === 'movie'
    || String(episode || '').toLowerCase() === 'movie';
}

function isEditorialTitle(value) {
  const text = String(value || '').toLowerCase();
  return FEATURE_EDITORIAL_MARKERS.some(marker => text.includes(marker));
}

function selectRequestedEpisodes(episodes, targetEpisode, links = []) {
  const usableEpisodes = (episodes || []).filter(ep => !isEditorialTitle(ep?.episodeTitle));
  const target = Number(targetEpisode);
  if (!Number.isInteger(target) || target < 1) return [];

  // 先相信标题中的明确集数。这样即使源站把预告/花絮插在正片前面，或返回顺序不是
  // 第 1 集开始，也不会把数组下标误当成集数。
  const titleNumberedEpisodes = usableEpisodes.filter(ep =>
    extractEpisodeNumberFromTitle(ep?.episodeTitle) !== null
  );
  const titleMatches = titleNumberedEpisodes.filter(ep =>
    extractEpisodeNumberFromTitle(ep?.episodeTitle) === target
  );
  if (titleNumberedEpisodes.length > 0) return titleMatches;

  // 只相信来源元数据，不能把 buildBangumiData 生成的数组编号误当成来源集号。
  const metadata = new Map(links.map(link => [link.id,
    [link.episodeNumber, link.sort].map(Number).find(number => Number.isFinite(number) && number > 0)]));
  const numberedEpisodes = usableEpisodes.filter(ep => metadata.get(ep.episodeId) !== undefined);
  if (numberedEpisodes.length) return numberedEpisodes.filter(ep => metadata.get(ep.episodeId) === target);

  // 整组正片都没有集号时，才允许按过滤后的位置选择。
  return usableEpisodes[target - 1] ? [usableEpisodes[target - 1]] : [];
}

function isFeatureCandidate(animeItem, requestedYear = null) {
  const typeText = `${animeItem?.type || ''} ${animeItem?.typeDescription || ''} ${animeItem?.animeTitle || ''}`;
  // TMDB 的 movie 可能被视频源标记为纪录片、综艺、动漫或演唱会，不能只认“电影”。
  if (!/电影|纪录片|综艺|动漫|动画|演唱会|短片|音乐|movie|documentary|variety|anime|animation|concert|short/i.test(typeText)) return false;
  if (/电视剧|剧集|tvseries|series/i.test(typeText) && !/电影|movie/i.test(typeText)) return false;
  if (isEditorialTitle(animeItem?.animeTitle)) return false;

  const candidateYear = extractYear(String(animeItem?.animeTitle || ''));
  return !requestedYear || !candidateYear || candidateYear === requestedYear;
}

function mergeEpisodeSearchResults(...responses) {
  const animes = [];
  const seen = new Set();

  for (const response of responses) {
    for (const anime of response?.animes || []) {
      const key = [anime?.source || '', anime?.bangumiId || anime?.animeId || '', anime?.animeTitle || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      animes.push(anime);
    }
  }

  return {
    ...(responses.find(response => response && typeof response === 'object') || {}),
    success: responses.some(response => response?.success === true),
    errorMessage: '',
    animes,
  };
}

// Extracted function for GET /api/v2/search/episodes
export async function searchEpisodes(url, clientIp = null, options = {}) {
  const searchAnimeFn = options.searchAnimeFn || searchAnime;
  const tmdbTitleResolver = options.tmdbTitleResolver || getTmdbMediaTitleById;
  let anime = url.searchParams.get('anime') || '';
  const rawTmdbId = (url.searchParams.get('tmdbId') || '').trim();
  const tmdbId = /^\d+$/.test(rawTmdbId) ? rawTmdbId : '';
  const episode = url.searchParams.get('episode') || '';
  const featureRequest = isFeatureRequest(url, episode);
  const mediaType = resolveTmdbMediaType(url, episode);
  const sourceOrderOverride = options.sourceOrderOverride || null;
  let requestedYear = null;
  let originalTitle = '';
  if (!anime && tmdbId) {
    const media = await tmdbTitleResolver(tmdbId, resolveTmdbMediaType(url, episode));
    anime = media?.title || '';
    originalTitle = media?.originalTitle || '';
    requestedYear = media?.year || null;
  }
  if (globals.animeTitleSimplified) {
    anime = simplized(anime);
    originalTitle = simplized(originalTitle);
  }
  if (!anime) {
    return jsonResponse(tmdbId
      ? { errorCode: 0, success: true, errorMessage: '', hasMore: false, animes: [] }
      : { errorCode: 400, success: false, errorMessage: 'Missing anime or tmdbId parameter' }, tmdbId ? 200 : 400);
  }

  // 所有来源与补搜共用等待预算，避免一轮慢源后又串行等待多个完整超时。
  const deadline = performance.now() + 6500;
  const details = new Map();
  const lookup = async (title, sources = sourceOrderOverride) => {
    if (performance.now() >= deadline) return { success: true, animes: [] };
    const searchUrl = buildSearchAnimeUrl(url, title);
    const response = await searchAnimeFn(searchUrl, null, null, details, null, false, null, null, sources, clientIp, deadline);
    return response.json();
  };
  const collect = async data => {
    const results = [];
    for (const item of data?.animes || []) {
      const detail = resolveAnimeByIdFromDetailStore(item.bangumiId, details, item.source)
        || resolveAnimeByIdFromDetailStore(item.animeId, details, item.source)
        || resolveAnimeById(item.bangumiId, details, item.source) || resolveAnimeById(item.animeId, details, item.source);
      const catalog = detail ? buildBangumiData(detail, item.bangumiId)
        : await (await getBangumi(`/bangumi/${item.bangumiId}`, details, item.source)).json();
      if (!catalog.success || !catalog.bangumi?.episodes) continue;
      let episodes = catalog.bangumi.episodes;
      if (featureRequest) {
        if (!isFeatureCandidate(item, requestedYear)) continue;
        episodes = episodes.filter(ep => !isEditorialTitle(ep.episodeTitle));
      } else if (/^\d+$/.test(episode)) {
        episodes = selectRequestedEpisodes(episodes, episode, detail?.links);
      }
      if (episodes.length) results.push({ animeItem: item, episodes });
    }
    return results;
  };

  let searchData = await lookup(anime);
  let results = await collect(searchData);
  if (!results.length && originalTitle && originalTitle !== anime) {
    log('info', `[system] [episodes] 补搜 TMDB 原名: ${originalTitle}`);
    searchData = mergeEpisodeSearchResults(searchData, await lookup(originalTitle));
    results = await collect(searchData);
  }
  if (!results.length) {
    const fallbackSources = sourceOrderOverride ? [] : resolveMissingDirectFallbackSources();
    if (fallbackSources.length) {
      log('info', `[system] [episodes] 缺少目标集，补查来源: ${fallbackSources.join(',')}`);
      searchData = mergeEpisodeSearchResults(searchData, await lookup(anime, fallbackSources));
      results = await collect(searchData);
    }
  }
  log('info', `[system] [episodes] 找到 ${results.length} 个含目标集的候选`);
  const animes = results.map(({ animeItem, episodes }) => Episodes.fromJson({
    animeId: animeItem.animeId, animeTitle: animeItem.animeTitle,
    type: animeItem.type, typeDescription: animeItem.typeDescription,
    episodes: episodes.map(ep => ({ episodeId: ep.episodeId, episodeTitle: ep.episodeTitle, url: ep.url || '' })),
  }));
  const data = { errorCode: 0, success: true, errorMessage: animes.length ? '' : getAddAnimeError(details), animes };
  if (!animes.length) data.hasMore = false;
  return jsonResponse(data);
}


// Extracted function for GET /api/v2/bangumi/:animeId
export async function getBangumi(path, detailStore = null, source = null) {
  const idParam = path.split("/").pop();
  const anime =
    resolveAnimeByIdFromDetailStore(idParam, detailStore, source) ||
    resolveAnimeById(idParam);

  if (!anime) {
    log("error", `[system] [bangumi] Anime with ID ${idParam} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  return jsonResponse(buildBangumiData(anime, idParam));
}

function buildBangumiData(anime, idParam = "") {
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
      episodeNumber: `${extractEpisodeNumberFromTitle(link.title)
        ?? ([link.episodeNumber, link.sort].map(Number).find(number => Number.isFinite(number) && number > 0))
        ?? i + 1}`,
      airDate: anime.startDate,
      url: link.url || ""
    });
  }

  // 如果启用了集标题过滤，则应用过滤
  if (globals.enableAnimeEpisodeFilter) {
    episodesList = filterEpisodesByTitle(episodesList);
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

    // 过滤只删除条目，保留原集号，不能用剩余列表的位置改写分集身份。
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
