import { resolveSourceLocation } from '../sources/location.js';
import { isSupportedSource, sourceForUrl } from '../sources/policy.js';
import { canonicalPlatformName } from '../utils/platform-util.js';
import { runWithMatchTrace } from '../utils/match-trace-util.js';
import { globals } from '../configs/globals.js';
import { runWithCommentTransform, getCommentTransformConfig } from '../utils/comment-context.js';
import { buildUgcContext, createUgcLogger, ugcSupplement } from '../utils/bilibili-ugc-util.js';
import { jsonResponse, sourceLogContext } from '../utils/http-util.js';
import { log } from '../utils/log-util.js';
import { logEvent } from '../utils/log-util.js';

import { setLocalRedisKey } from "../utils/local-redis-util.js";
import { setCommentCache, findAnimeIdByCommentId, findTitleById, findUrlById, getCommentCache, setPreferByAnimeId, setPreferForTitle, writeCacheToFile, getLastSearch, findAnimeTitleById, findIndexById, resolveEpisodeContextById } from "../utils/cache-util.js";

import { formatDanmuResponse, convertToDanmakuJson, renderDanmakuComments, filterDanmusByBlockedWords, filterDanmusByBlockedNames } from "../utils/danmu-util.js";
import { resolveOffsetRule, applyOffset, stripLinkOffset, offsetDuration } from "../utils/offset-util.js";
import { extractEpisodeTitle, titleMatches, extractAnimeInfo } from "../utils/common-util.js";
import { getDomesticPersonMetadataForTitle, mergePersonMetadata } from "../utils/tmdb-util.js";
import { shouldBlockDomesticCelebrities, getCurrentWorkFilterTitles } from '../utils/person-filter-exclusion-util.js';
import { mergeDanmakuList, MERGE_DELIMITER, sanitizeUrl, normalizeMergedSourceUrl } from "../utils/merge-util.js";


import { getSourceByKey, getLogNameByKey } from "../sources/registry.js";
import { getHanjutvSourceLabel } from '../utils/hanjutv-util.js';


const PENDING_DANMAKU_REQUESTS = new Map();
// 弹幕过滤只等第一批人名：冷缓存下拿到 TMDB 演员表就立刻拦截，剩余来源（别名、百科）继续补齐缓存。
const PERSON_FILTER_METADATA_OPTIONS = { awaitNames: true, budgetMs: 4000 };

function latestCommentTime(comments) {
  return comments.reduce((max, item) => Math.max(max, parseFloat(item.p) || 0), 0);
}

const normalizedFilterUrl = value => stripLinkOffset(sanitizeUrl(String(value || ''))).cleanUrl;
async function resolveFilterTitle(videoUrl, hint = '') {

  const target = normalizedFilterUrl(videoUrl);
  const matches = new Set();
  for (const anime of globals.animes) {
    if (anime.links?.some(link => link.url === videoUrl || String(link.url).split(MERGE_DELIMITER)
      .some(part => normalizedFilterUrl(part) === target))) matches.add(anime.animeTitle);
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) {
    log('warn', '[system] [danmu] [person-filter] URL 对应多个作品，跳过人物名单，仍执行地区和日期时间规则');
    return '';
  }
  return String(hint || '');
}
const segmentFilterContexts = new Map();
function attachFilterContext(value, animeTitle, sourceUrl) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.segmentList)) value.segmentList = value.segmentList.map(segment => {
    const key = `${segment.type}:${String(segment.url).trim()}`;
    const previous = segmentFilterContexts.get(key);
    // Older players may send only the original segment fields. Never reuse an ambiguous work identity.
    segmentFilterContexts.set(key, previous && previous.animeTitle !== animeTitle
      ? { animeTitle: '', sourceUrl: '' } : { animeTitle, sourceUrl });
    while (segmentFilterContexts.size > 500) segmentFilterContexts.delete(segmentFilterContexts.keys().next().value);
    return Object.assign(Object.create(Object.getPrototypeOf(segment)), segment, { animeTitle, sourceUrl });
  });
  if (Array.isArray(value)) return value.map(item => attachFilterContext(item, animeTitle, sourceUrl));
  return value;
}

const renderedComments = new WeakMap();
async function applyDomesticCelebrityFilter(danmus, animeTitle, pendingMetadata = null) {
  const filtered = await filterDomesticComments(danmus, animeTitle, pendingMetadata);
  return renderFilteredComments(danmus, filtered);
}

function renderFilteredComments(danmus, filtered) {
  const config = getCommentTransformConfig();
  const previous = renderedComments.get(danmus);
  if (previous?.revision === config.revision && previous.input.length === filtered.length &&
      previous.input.every((comment, index) => comment === filtered[index])) return previous.output;
  const output = renderDanmakuComments(filtered, { ...config, blockedWords: '' });
  renderedComments.set(danmus, { revision: config.revision, input: filtered, output });
  return output;
}

async function filterDomesticComments(danmus, animeTitle, pendingMetadata = null) {
  danmus = filterDanmusByBlockedWords(danmus);
  const blockCelebrities = await shouldBlockDomesticCelebrities(animeTitle);
  if (!blockCelebrities || !Array.isArray(danmus) || danmus.length === 0) return danmus;
  let metadata = { actorNames: [], characterNames: [], names: [], status: 'unavailable' };
  if (blockCelebrities && animeTitle) {
    metadata = await (pendingMetadata || getDomesticPersonMetadataForTitle(animeTitle, PERSON_FILTER_METADATA_OPTIONS));
    // 下载/补充弹幕期间名单可能已更新；这里只读最新快照，不再次等待网络。
    metadata = mergePersonMetadata(metadata, await getDomesticPersonMetadataForTitle(animeTitle, { cachedOnly: true }));
  }

  const blockedNames = blockCelebrities ? metadata.names : [];
  const workTitles = [...getCurrentWorkFilterTitles(animeTitle), ...(metadata.workTitles || [])];
  if (blockCelebrities) log(metadata.names.length ? 'info' : 'warn', `[system] [danmu] [person-filter] 演员 ${metadata.actorNames.length} 个，角色 ${metadata.characterNames.length} 个，状态 ${metadata.status}${animeTitle ? '' : '（此请求无作品标题）'}`);
  const result = filterDanmusByBlockedNames(danmus, blockedNames, {
    actorNames: blockCelebrities ? metadata.actorNames : [],
    characterNames: blockCelebrities ? metadata.characterNames : [],
    surnameNames: blockCelebrities ? metadata.actorNames : [],
    workTitles,
    surnameMatcherOptions: { bareSurname: false }
  });
  if (blockCelebrities) {
    const personHits = result.hits;
    log('info', `[system] [danmu] [person-filter] 已拦截 ${personHits.reduce((sum, hit) => sum + hit.count, 0)} 条，命中 ${personHits.map(hit => `${hit.name} ×${hit.count}`).join('、') || '无'}`);
  }
  if (result.removedCount > 0) {
    log('info', `[system] [danmu] [domestic-filter] 已拦截 ${result.removedCount}/${danmus.length} 条弹幕，命中 ${result.hits.length} 条规则`);
  } else {
    log('info', `[system] [danmu] [domestic-filter] 已加载演员/角色 ${blockedNames.length} 个、作品名称 ${workTitles.length} 个，本集无命中`);
  }
  return result.danmus;
}

export function resolveCommentCacheKey(url, commentId = null) {
  const value = String(url || '').includes(MERGE_DELIMITER) ? normalizeMergedSourceUrl(url) : String(url || '').trim();
  const containsHongguo = value.includes('hongguo:') || sourceForUrl(stripLinkOffset(value).cleanUrl) === 'hongguo';
  const key = containsHongguo && globals.hongguoMergeAllEpisodes ? `${value}::hongguo-all-episodes` : value;
  // Episode rules depend on work/season/episode; direct URL requests do not apply them.
  return commentId != null && getCommentTransformConfig().danmuOffsetRules?.length
    ? JSON.stringify(['episode', key, commentId]) : key;
}

export function resolveSegmentCacheKey(segment) {
  return JSON.stringify(['segment', canonicalPlatformName(segment.type), segment.url.trim(),
    segment.segment_start, segment.segment_end, segment.data || '']);
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

async function fetchSourceComments(location, segmentFlag = false) {
  const instance = getSourceByKey(location.source);
  return sourceLogContext.run(getLogNameByKey(location.source), async () => {
    let id = location.realId;
    if (location.source === 'bilibili' && sourceForUrl(id) === 'bilibili' && new URL(id).hostname === 'b23.tv') {
      id = await instance.resolveB23Link(id);
    }
    return instance.getComments(id, location.source, segmentFlag);
  });
}

async function resolveUrlDuration(url, cache = null, source = '') {
  const location = resolveSourceLocation(url, source);
  if (!location) return 0;
  if (cache) {
    const key = JSON.stringify([location.source, location.realId]);
    if (!cache.has(key)) cache.set(key, resolveUrlDuration(url, null, source));
    return cache.get(key);
  }
  try {
    return extractDurationFromSegments(await fetchSourceComments(location, true));
  } catch (error) {
    log('warn', `[system] [duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

// Resolve the same rule for comment transformation and reported duration.
function resolveCommentOffsetRule(animeTitle, episodeTitle, commentId, source) {
  if (!animeTitle || !episodeTitle || !getCommentTransformConfig().danmuOffsetRules?.length) return null;
  const { baseTitle, fullTitle, season, episode } = extractAnimeInfo(animeTitle, episodeTitle);
  return resolveOffsetRule(getCommentTransformConfig().danmuOffsetRules, {
    anime: baseTitle, fullTitle,
    season: `S${String(season || 1).padStart(2, '0')}`,
    episode: `E${String(episode || findIndexById(commentId) + 1).padStart(2, '0')}`,
    source
  });
}

async function resolveMergedDuration(url, context = null, durationCache = null) {
  if (!url) return 0;
  try {
    const merged = url.includes(MERGE_DELIMITER);
    const parts = (merged ? url.split(MERGE_DELIMITER) : [url]).map(part =>
      resolveSourceLocation(part, context?.source));
    const durations = await Promise.all(parts.map(part => part
      ? resolveUrlDuration(part.realId, durationCache, part.source) : 0));
    return parts.reduce((longest, part, index) => {
      const original = durations[index];
      if (!(original > 0)) return longest;
      let end = offsetDuration(original, part.offset, part.percent);
      const rule = context && resolveCommentOffsetRule(context.animeTitle, context.episodeTitle, context.commentId, part.source);
      if (rule) end = offsetDuration(end, rule.offset, rule.usePercent, original);
      return Math.max(longest, end);
    }, 0);
  } catch (error) {
    log('warn', `[system] [duration] 获取时长失败: ${error.message}`);
    return 0;
  }
}

/**
 * 处理聚合源弹幕获取
 * @param {string} url 聚合URL
 * @returns {Promise<Array>} 合并后的弹幕列表
 */
export async function fetchMergedComments(url, animeTitle, commentId, durationCache = null) {
  url = normalizeMergedSourceUrl(url);
  const parts = url.split(MERGE_DELIMITER);
  const partMetas = parts.map(part => {
    const location = resolveSourceLocation(part);
    if (!location) throw new Error('不支持的弹幕来源');
    return {
      realId: location.realId, logicalSource: location.source,
      sourceLabel: location.source === 'hanjutv' ? getHanjutvSourceLabel(location.realId) : location.source,
      manualOffset: location.offset, manualOffsetPercent: location.percent,
    };
  });
  const sourceNames = partMetas.map(meta => meta.logicalSource).filter(Boolean);
  const realIds = partMetas.map(meta => meta.realId);
  const sourceTag = partMetas.map(meta => meta.sourceLabel).filter(Boolean).join('＆');

  log("info", `[merge] 开始获取 [${sourceTag}] 聚合弹幕...`);

  // 1. 检查聚合缓存
  const cached = getCommentCache(resolveCommentCacheKey(url, commentId));
  if (cached) {
    log("info", `[merge] 命中缓存 [${sourceTag}]，返回 ${cached.length} 条`);
    return cached;
  }

  const stats = {};

  // 2. 构建任务工厂（延迟启动，到分组后再执行）
  const taskFactories = partMetas.map(meta => async () => {
    const sourceName = meta.logicalSource;
    const sourceLabel = meta.sourceLabel || meta.logicalSource;
    const realId = meta.realId;

    if (!sourceName || !realId) return [];

    // 构建去重Key
    const pendingKey = JSON.stringify([sourceName, realId, sourceName === 'hongguo' && globals.hongguoMergeAllEpisodes]);

    let pending = PENDING_DANMAKU_REQUESTS.get(pendingKey);
    if (!pending) {
      pending = sourceLogContext.run(getLogNameByKey(sourceName), async () => {
        const instance = getSourceByKey(sourceName);
        let resolvedId = realId;
        if (sourceName === 'bilibili' && sourceForUrl(realId) === 'bilibili' && new URL(realId).hostname === 'b23.tv') {
          resolvedId = await instance.resolveB23Link(realId);
        }
        // Only raw source data is shared; offsets, labels and filters belong to the caller.
        return instance.formatComments(await instance.getEpisodeDanmu(resolvedId, parts));
      });
      PENDING_DANMAKU_REQUESTS.set(pendingKey, pending);
    }
    try {
      let formatted = (await pending).map(item => ({ ...item, _sourceLabel: item._sourceLabel || sourceLabel }));
      if (meta.manualOffset) {
        const duration = meta.manualOffsetPercent ? await resolveUrlDuration(realId, durationCache, sourceName) : 0;
        formatted = applyOffset(formatted, meta.manualOffset, {
          usePercent: meta.manualOffsetPercent, videoDuration: duration || latestCommentTime(formatted),
        });
      }
      stats[sourceLabel] = (stats[sourceLabel] || 0) + formatted.length;
      return formatted;
    } catch (error) {
      log('error', `[merge] 获取 ${sourceLabel} 失败: ${error.message}`);
      return [];
    } finally {
      if (PENDING_DANMAKU_REQUESTS.get(pendingKey) === pending) PENDING_DANMAKU_REQUESTS.delete(pendingKey);
    }
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


  const [, , episodeTitle] = findAnimeIdByCommentId(commentId);
  for (let index = 0; index < results.length; index++) {
    const rule = resolveCommentOffsetRule(animeTitle, episodeTitle, commentId, sourceNames[index]);
    if (!rule?.offset) continue;
    const duration = rule.usePercent ? await resolveUrlDuration(realIds[index], durationCache, sourceNames[index]) : 0;
    results[index] = applyOffset(results[index], rule.offset, { usePercent: rule.usePercent, videoDuration: duration });
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
export function getComment(path, queryFormat, segmentFlag, clientIp, includeDuration = false) {
  return runWithMatchTrace(async () => {
    const started = performance.now();
    const commentId = parseInt(path.split('/').pop());
    logEvent('info', 'comment.start', '[system] [comment-timing] 开始获取弹幕', { commentId, segment: Boolean(segmentFlag) });
    try {
      const response = await runWithCommentTransform(() => getCommentResponse(path, queryFormat, segmentFlag, clientIp, includeDuration), { deferProcessing: true });
      logEvent('info', 'comment.return', '[system] [comment-timing] 弹幕请求返回',
        { commentId, status: response.status, durationMs: Math.round(performance.now() - started) });
      return response;
    } catch (error) {
      logEvent('warn', 'comment.failure', '[system] [comment-timing] 弹幕请求失败',
        { commentId, reason: error.message, durationMs: Math.round(performance.now() - started) });
      throw error;
    }
  });
}

export async function supplementUgcForEpisode(commentId, url, comments, segmentFlag, suppliedLogger = null) {
  const context = buildUgcContext(resolveEpisodeContextById(commentId));
  const logger = suppliedLogger || createUgcLogger(context || { title: findAnimeTitleById(commentId) });
  const skip = reason => {
    logger('skip', '跳过UGC补充，原因=' + reason, { commentId, reason, originalCount: Array.isArray(comments) ? comments.length : null });
    return comments;
  };
  if (!globals.bilibiliUgcEnabled) return skip('disabled');
  if (segmentFlag) return skip('segment-request');
  if (!Array.isArray(comments)) return skip('invalid-comments');
  if (!context) return skip('missing-episode-context');
  // Preserve user-selected timing rather than mix aligned UGC with shifted originals.
  if (getCommentTransformConfig().danmuOffsetRules?.length || String(url).split(MERGE_DELIMITER).some(p => stripLinkOffset(p).offset)) return skip('manual-offset');
  const UGC_THIN_THRESHOLD = 1000;
  if (comments.length >= UGC_THIN_THRESHOLD) return skip('sufficient-comments');
  const parts = String(url).split(MERGE_DELIMITER);
  const ref = parts.map(p => p.replace(/^bilibili:/, '')).find(p => /^https:\/\/www\.bilibili\.com\/(video\/BV|bangumi\/play\/ep)/.test(p));
  if (ref) {
    context.referenceUrl = ref;
  }
  logger('trigger', ref ? 'B站单集弹幕不足1000条，触发UGC补充' : '主源单集弹幕不足1000条，触发UGC补充',
    { commentId, reason: ref ? 'thin-bilibili' : 'non-bilibili', originalCount: comments.length, threshold: UGC_THIN_THRESHOLD, referenceMode: ref ? 'primary' : 'candidate' });
  const started = performance.now();
  try {
    const augmented = await ugcSupplement.supplement(context, comments, { budgetMs: globals.bilibiliUgcBudgetMs, logger });
    const original = new Set(comments);
    const originalKeys = new Set(comments.map(c => c.p + '\u0000' + c.m));
    const additions = augmented === comments ? [] : augmented.filter(c => !original.has(c) && !originalKeys.has(c.p + '\u0000' + c.m));
    const filtered = convertToDanmakuJson(additions, 'bilibili');
    // 转换器会为补充弹幕从 1 重新编号 cid，与主源 cid 冲突；弹弹play 协议以 cid 标识单条弹幕，
    // 因此把补充弹幕的 cid 顺延到主源最大值之后，保证合并结果内 cid 唯一。
    let nextCid = comments.reduce((max, c) => Math.max(max, Number(c?.cid) || 0), 0) + 1;
    for (const c of filtered) c.cid = nextCid++;
    logger('return', 'UGC合并结果（人物过滤前）：原弹幕 ' + comments.length + ' 条，实际新增 ' + filtered.length + ' 条，最终 ' + (comments.length + filtered.length) + ' 条，耗时 ' + Math.round(performance.now() - started) + 'ms',
      { commentId, originalCount: comments.length, mergedAddedCount: additions.length, filteredCount: additions.length - filtered.length, addedCount: filtered.length, finalCount: comments.length + filtered.length, durationMs: Math.round(performance.now() - started) });
    if (augmented === comments) return comments;
    return [...comments, ...filtered].sort((a,b) => parseFloat(a.p) - parseFloat(b.p));
  } catch (e) {
    logger('return', 'UGC异常回退，保留原弹幕：' + e.message,
      { commentId, status: 'failed', reason: e.message, originalCount: comments.length, addedCount: 0, finalCount: comments.length, durationMs: Math.round(performance.now() - started) }, 'warn');
    return comments;
  }
}


async function supplementAndFilterForEpisode(commentId, url, comments, animeTitle, pendingMetadata) {
  const context = buildUgcContext(resolveEpisodeContextById(commentId));
  const logger = createUgcLogger(context || { title: animeTitle });
  const started = performance.now();
  const supplemented = await supplementUgcForEpisode(commentId, url, comments, false, logger);
  const filtered = await filterDomesticComments(supplemented, animeTitle, pendingMetadata);
  const originalKeys = new Set(comments.map(c => c.p + '\u0000' + c.m));
  const addedCount = filtered.filter(c => !originalKeys.has(c.p + '\u0000' + c.m)).length;
  const rendered = renderFilteredComments(supplemented, filtered);
  logger('response', '最终弹幕返回 ' + rendered.length + ' 条；去重和显示处理前，UGC新增保留 ' + addedCount + ' 条，合并后过滤 ' + (supplemented.length - filtered.length) + ' 条',
    { commentId, originalCount: comments.length, augmentedCount: supplemented.length, filteredCount: supplemented.length - filtered.length, addedCount, finalCount: rendered.length, durationMs: Math.round(performance.now() - started) });
  return rendered;
}

async function rememberEpisodeSelection(commentId, animeTitle, clientIp) {
  if (!clientIp || !globals.rememberLastSelect) return;
  const search = getLastSearch(clientIp);
  const [animeId, source, episodeTitle, aliases] = findAnimeIdByCommentId(commentId);
  // season 用显式判空：播放器用 S00 表示特别篇，不能用真值判断当成无效季。
  const hasSeason = search?.season !== null && search?.season !== undefined;
  if (!animeId || !source || !episodeTitle || !search?.title || !hasSeason || !search.episode || Date.now() - search.timestamp >= 180000) return;
  if (String(search.episodeId) === String(commentId)) return;
  const titles = [animeTitle, ...aliases];
  const matches = titles.some(title => titleMatches(title, search.title, null, true) ||
    (search.autoMatchMappingApplied && titleMatches(title, search.mappingTargetTitle, null, true)));
  if (!matches) return;
  const offset = `${search.episode}:${episodeTitle}`;
  if (search.autoMatchMappingApplied) setPreferForTitle(search.title, animeId, source, search.season, offset);
  else setPreferByAnimeId(animeId, source, search.season, offset);
  log('info', `[system] [match] 保存明确手选结果: ${search.title} S${search.season} -> ${commentId}`);
  if (globals.localCacheValid) writeCacheToFile('lastSelectMap', JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
  if (globals.localRedisValid) await setLocalRedisKey('lastSelectMap', globals.lastSelectMap);
}

async function getCommentResponse(path, queryFormat, segmentFlag, clientIp, includeDuration) {
  const commentId = parseInt(path.split('/').pop());
  let animeTitle = findAnimeTitleById(commentId);
  let url = findUrlById(commentId);
  if (url?.includes(MERGE_DELIMITER)) url = normalizeMergedSourceUrl(url);
  let title = findTitleById(commentId);
  let plat = title ? extractEpisodeTitle(title) : null;


  const supported = String(url || '').split(MERGE_DELIMITER).every(part => resolveSourceLocation(part, plat));
  if (url && !supported) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',count:0,comments:[]},400);
  const shouldAttachDuration = shouldIncludeVideoDuration(queryFormat, includeDuration);
  log("info", "[system] [LogVar-API] comment url...", url);
  log("info", "[system] [LogVar-API] comment title...", title);
  log("info", "[system] [LogVar-API] comment platform...", plat);
  if (!url) {
    log("error", `[system] [LogVar-API] Comment with ID ${commentId} not found`);
    return jsonResponse({ count: 0, comments: [] }, 404);
  }
  log("info", `[system] [LogVar-API] Fetched comment ID: ${commentId}`);

  if (segmentFlag) createUgcLogger(buildUgcContext(resolveEpisodeContextById(commentId)) || { title: animeTitle })('skip', '分段请求跳过UGC补充', { commentId, reason: 'segment-request' });

  // 提前加载人物资料；最终过滤前读取最新快照，等待预算仍受限。
  const pendingMetadata = !segmentFlag && animeTitle && await shouldBlockDomesticCelebrities(animeTitle)
    ? getDomesticPersonMetadataForTitle(animeTitle, PERSON_FILTER_METADATA_OPTIONS) : null;

  // Duration must use the same per-source rules on cold and cached requests.
  const [, offsetSource, offsetEpisodeTitle] = shouldAttachDuration ? findAnimeIdByCommentId(commentId) : [];
  const durationContext = { animeTitle, episodeTitle: offsetEpisodeTitle, commentId, source: resolveSourceLocation(url, offsetSource)?.source || offsetSource };
  const durationCache = new Map();

  await rememberEpisodeSelection(commentId, animeTitle, clientIp);

  // 检查弹幕缓存
  const cacheKey = resolveCommentCacheKey(url, commentId);
  const cachedComments = segmentFlag ? null : getCommentCache(cacheKey);
  if (cachedComments !== null) {
    logEvent('info', 'comment.base', '[system] [comment-timing] 已有弹幕命中缓存，接下来判断是否补充UGC',
      { commentId, cacheHit: true, count: cachedComments.length, durationMs: 0 });
    const filteredCachedComments = await supplementAndFilterForEpisode(commentId, url, cachedComments, animeTitle, pendingMetadata);
    const responseData = buildDanmuResponse(
      { count: filteredCachedComments.length, comments: filteredCachedComments },
      shouldAttachDuration ? await resolveMergedDuration(url, durationContext, durationCache) : null
    );
    return formatDanmuResponse(responseData, queryFormat);
  }

  log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
  let danmus = [];
  const upstreamStarted = performance.now();
  const durationPromise = shouldAttachDuration ? resolveMergedDuration(url, durationContext, durationCache) : null;

  // 提取单链接偏移值（@秒数 / @%百分比）
  const linkMeta = stripLinkOffset(url);
  const singleUrlOffset = linkMeta.offset;
  const singleUrlOffsetPercent = linkMeta.percent;
  const cleanUrl = linkMeta.cleanUrl;
  if (singleUrlOffset !== 0) {
    log("info", `[system] [LogVar-API] 检测到链接${singleUrlOffsetPercent ? '百分比' : ''}偏移: ${singleUrlOffset}s`);
  }

  if (url && url.includes(MERGE_DELIMITER)) {
    danmus = await fetchMergedComments(url, animeTitle, commentId, durationCache);
  } else {
    const location = resolveSourceLocation(cleanUrl, plat);
    danmus = await fetchSourceComments(location, segmentFlag);
  }

  logEvent('info', 'comment.base', '[system] [comment-timing] 来源弹幕获取完成',
    { commentId, cacheHit: false, segment: Boolean(segmentFlag), count: Array.isArray(danmus) ? danmus.length : null,
      durationMs: Math.round(performance.now() - upstreamStarted) });
  if (segmentFlag) danmus = attachFilterContext(danmus, animeTitle, url);

  // 单链接偏移值应用（合并链接已在 fetchMergedComments 中按来源分别应用，此处仅处理单链接）
  if (!(url && url.includes(MERGE_DELIMITER)) && singleUrlOffset !== 0 && danmus && Array.isArray(danmus) && danmus.length > 0) {
    if (singleUrlOffsetPercent) {
      const maxTime = latestCommentTime(danmus);
      const sourceDuration = await resolveUrlDuration(cleanUrl, durationCache);
      danmus = applyOffset(danmus, singleUrlOffset, { usePercent: true, videoDuration: sourceDuration || maxTime || 1 });
      log("info", `[system] [LogVar-API] 应用链接百分比偏移 ${singleUrlOffset}s (时长=${sourceDuration || maxTime || 1}s)`);
    } else {
      danmus = applyOffset(danmus, singleUrlOffset);
      log("info", `[system] [LogVar-API] 应用链接偏移 ${singleUrlOffset}s`);
    }
  }

  const [, source, episodeTitle] = findAnimeIdByCommentId(commentId);

  if (!url.includes(MERGE_DELIMITER)) {
    const actualSource = resolveSourceLocation(cleanUrl, source)?.source || source;
    const rule = resolveCommentOffsetRule(animeTitle, episodeTitle, commentId, actualSource);
    if (rule?.offset) {
      const duration = rule.usePercent ? await resolveUrlDuration(cleanUrl, durationCache, actualSource) : 0;
      danmus = applyOffset(danmus, rule.offset, { usePercent: rule.usePercent, videoDuration: duration });
    }
  }

  // 缓存弹幕结果
  if (!segmentFlag) {
    if (danmus && danmus.comments) danmus = danmus.comments;
    if (!Array.isArray(danmus)) danmus = [];
    if (danmus.length > 0) {
        setCommentCache(cacheKey, danmus);
    }
    // 缓存原始结果，确保关闭演员屏蔽开关后不会继续返回已过滤的旧缓存。
    danmus = await supplementAndFilterForEpisode(commentId, url, danmus, animeTitle, pendingMetadata);
  }

  const responseData = buildDanmuResponse(
    { count: danmus.length, comments: danmus },
    durationPromise ? await durationPromise : null
  );
  return formatDanmuResponse(responseData, queryFormat);
}

// Extracted function for GET /api/v2/comment?url=xxx or /api/v2/extcomment?url=xxx
export function getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration = false, animeTitleHint = '') {
  return runWithCommentTransform(() => getCommentByUrlResponse(videoUrl, queryFormat, segmentFlag, includeDuration, animeTitleHint), { deferProcessing: true });
}

async function getCommentByUrlResponse(videoUrl, queryFormat, segmentFlag, includeDuration, animeTitleHint) {
  createUgcLogger({ title: animeTitleHint })('skip', '直接URL请求不执行UGC补充，请使用已匹配剧集ID入口', { reason: 'url-request' });
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
    if (!sourceForUrl(stripLinkOffset(videoUrl).cleanUrl)) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',count:0,comments:[]},400);
    const animeTitle = await resolveFilterTitle(videoUrl, animeTitleHint);
    const pendingMetadata = !segmentFlag && animeTitle && await shouldBlockDomesticCelebrities(animeTitle)
      ? getDomesticPersonMetadataForTitle(animeTitle) : null;


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
    const durationCache = new Map();
    const cacheKey = resolveCommentCacheKey(url);
    const cachedComments = segmentFlag ? null : getCommentCache(cacheKey);
    if (cachedComments !== null) {
      const filteredCachedComments = await applyDomesticCelebrityFilter(cachedComments, animeTitle, pendingMetadata);
      const responseData = buildDanmuResponse({
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: filteredCachedComments.length,
        comments: filteredCachedComments
      }, shouldAttachDuration ? await resolveMergedDuration(url, null, durationCache) : null);
      return formatDanmuResponse(responseData, queryFormat);
    }

    log("info", "[system] [LogVar-API] 开始从本地请求弹幕...", url);
    let danmus = [];
    const durationPromise = shouldAttachDuration ? resolveMergedDuration(url, null, durationCache) : null;

    // 提取单链接偏移值（@秒数 / @%百分比）
    const linkMeta = stripLinkOffset(url);
    const singleUrlOffset = linkMeta.offset;
    const singleUrlOffsetPercent = linkMeta.percent;
    const cleanUrl = linkMeta.cleanUrl;
    if (singleUrlOffset !== 0) {
      log("info", `[system] [LogVar-API] 检测到链接${singleUrlOffsetPercent ? '百分比' : ''}偏移: ${singleUrlOffset}s`);
    }

    danmus = await fetchSourceComments(resolveSourceLocation(cleanUrl), segmentFlag);

    if (segmentFlag) return jsonResponse(attachFilterContext(danmus, animeTitle, videoUrl));

    log("info", `[system] [LogVar-API] Successfully fetched ${danmus.length} comments from URL`);

    // 单链接偏移值应用
    if (singleUrlOffset !== 0 && danmus && Array.isArray(danmus) && danmus.length > 0) {
      if (singleUrlOffsetPercent) {
        const maxTime = latestCommentTime(danmus);
        const sourceDuration = await resolveUrlDuration(cleanUrl, durationCache);
        danmus = applyOffset(danmus, singleUrlOffset, { usePercent: true, videoDuration: sourceDuration || maxTime || 1 });
        log("info", `[system] [LogVar-API] 应用链接百分比偏移 ${singleUrlOffset}s (时长=${sourceDuration || maxTime || 1}s)`);
      } else {
        danmus = applyOffset(danmus, singleUrlOffset);
        log("info", `[system] [LogVar-API] 应用链接偏移 ${singleUrlOffset}s`);
      }
    }

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(cacheKey, danmus);
    }
    danmus = await applyDomesticCelebrityFilter(danmus, animeTitle, pendingMetadata);

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
export function getSegmentComment(segment, queryFormat) {
  return runWithCommentTransform(() => getSegmentCommentResponse(segment, queryFormat), { deferProcessing: true });
}

async function getSegmentCommentResponse(segment, queryFormat) {
  createUgcLogger({ title: segment?.animeTitle })('skip', '分段弹幕请求不执行UGC补充', { reason: 'segment-request' });
  try {
    let url = segment.url;
    let platform = canonicalPlatformName(segment.type);
    if (!isSupportedSource(platform)) return jsonResponse({success:false,errorCode:400,errorMessage:'不支持的弹幕来源',count:0,comments:[]},400);

    // 验证URL参数
    if (!url || typeof url !== 'string') {
      log("error", "[system] [segmentcomment] Missing or invalid url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    url = url.trim();
    const context = segmentFilterContexts.get(`${platform}:${url}`);
    const workUrl = segment.sourceUrl || context?.sourceUrl || url;
    const animeTitle = await resolveFilterTitle(workUrl, segment.animeTitle || context?.animeTitle);
    const pendingMetadata = animeTitle && await shouldBlockDomesticCelebrities(animeTitle)
      ? getDomesticPersonMetadataForTitle(animeTitle) : null;

    log("info", `[system] [segmentcomment] Processing segment comment request for URL: ${url}`);

    // 检查弹幕缓存
    const cacheKey = resolveSegmentCacheKey(segment);
    const cachedComments = getCommentCache(cacheKey);
    if (cachedComments !== null) {
      const filteredCachedComments = await applyDomesticCelebrityFilter(cachedComments, animeTitle, pendingMetadata);
      const responseData = {
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: filteredCachedComments.length,
        comments: filteredCachedComments
      };
      return formatDanmuResponse(responseData, queryFormat);
    }

    log("info", `[system] [segmentcomment] 开始从本地请求分段弹幕... URL: ${url}`);
    let danmus = [];

    danmus = await sourceLogContext.run(getLogNameByKey(platform), () =>
      getSourceByKey(platform).getSegmentComments({ ...segment, type: platform, url }));

    log("info", `[system] [segmentcomment] Successfully fetched ${danmus.length} segment comments from URL`);

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(cacheKey, danmus);
    }
    danmus = await applyDomesticCelebrityFilter(danmus, animeTitle, pendingMetadata);

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
    log("error", `[system] [segmentcomment] Failed to process segment comment request: ${error.message}`);
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}
