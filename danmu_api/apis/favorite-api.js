import { globals } from '../configs/globals.js';
import { getSearchCache, updateLocalCaches } from '../utils/cache-util.js';
import { jsonResponse } from '../utils/http-util.js';
import { log } from '../utils/log-util.js';
import { createPhaseTimer, markStepActive, recordConfigEffect, traceStep } from '../utils/pipeline-trace.js';
import { simplized } from '../utils/zh-util.js';
import { parseFileName } from '../utils/common-util.js';
import {
  addFavorite,
  listFavorites,
  refreshFavorite,
  removeFavorite,
  resolveFavoriteForKeyword,
  stripSeasonSuffix
} from '../utils/favorite-util.js';
import { extractTitleSeasonEpisode, searchAnime } from './dandan-api.js';
import { createFavoriteSchedule } from '../utils/favorite-schedule-util.js';

const favoriteRefreshLocks = new Set();

async function resolveTitleForFavorite(fileName) {
  const { cleanFileName } = parseFileName(fileName);
  let { title, season, episode, year } = await extractTitleSeasonEpisode(cleanFileName);

  title = globals.resolveTitleMapping(title) || title;
  if (globals.animeTitleSimplified) title = simplized(title);
  if (globals.titleNoiseFilter) title = title.replace(globals.titleNoiseFilter, '').trim();

  return { title, season, episode, year };
}

function buildFavoriteSearchUrl(baseUrl, keyword, season, episode) {
  const searchUrl = new URL(baseUrl);
  searchUrl.pathname = searchUrl.pathname.replace(/\/api\/v2\/.*$/, '/api/v2/search/anime');
  searchUrl.search = '';
  searchUrl.searchParams.set('keyword', keyword || '');
  if (season !== undefined && season !== null) searchUrl.searchParams.set('season', String(season));
  if (episode !== undefined && episode !== null) searchUrl.searchParams.set('episode', String(episode));
  return searchUrl;
}

function cacheKeyFor(title, season) {
  return season !== null && season !== undefined ? `${title}_S${season}` : title;
}

function detailsFromMap(detailsMap) {
  return [...new Set(detailsMap instanceof Map ? detailsMap.values() : [])];
}

export async function persistFavorites() {
  if (globals.localCacheValid) await updateLocalCaches();
  if (globals.redisValid) {
    const { updateRedisCaches } = await import('../utils/redis-util.js');
    await updateRedisCaches();
  }
}

function removeRelatedSearchCaches(keyword) {
  if (!(globals.searchCache instanceof Map)) return;
  const baseTitle = stripSeasonSuffix(keyword);
  for (const key of globals.searchCache.keys()) {
    if (stripSeasonSuffix(key) === baseTitle) globals.searchCache.delete(key);
  }
}

async function findSearchEntry(cacheKey, title, season, episode, url) {
  const detailsMap = new Map();
  const cachedResults = getSearchCache(cacheKey, detailsMap);
  if (cachedResults !== null) {
    return { results: cachedResults, details: detailsFromMap(detailsMap) };
  }

  const searchUrl = buildFavoriteSearchUrl(url, title, season, episode);
  const searchResponse = await searchAnime(searchUrl, null, null, detailsMap);
  const searchData = await searchResponse.json();
  if (!searchData?.success || !Array.isArray(searchData.animes) || searchData.animes.length === 0) return null;

  const stored = globals.searchCache instanceof Map ? globals.searchCache.get(cacheKey) : null;
  return {
    results: stored?.results || searchData.animes,
    details: stored?.details || detailsFromMap(detailsMap)
  };
}

export async function handleFavoriteAdd(req, url) {
  const phase = createPhaseTimer();
  markStepActive('收藏·参数解析');
  try {
    const body = await req.json();
    const requestedKeyword = String(body?.keyword || '').trim();
    const fileName = String(body?.fileName || '').trim();
    if (!requestedKeyword && !fileName) {
      phase('收藏·参数解析', { status: 'fail', reason: '缺少 keyword 或 fileName 参数' });
      return jsonResponse({ success: false, message: '缺少 keyword 或 fileName 参数' }, 400);
    }

    let title;
    let season = null;
    let episode = null;
    if (requestedKeyword) {
      title = requestedKeyword;
      if (globals.animeTitleSimplified) {
        const simplified = simplized(title);
        if (simplified !== title) {
          recordConfigEffect('ANIME_TITLE_SIMPLIFIED', {
            label: '剧名繁转简', hit: true, before: { title }, after: { title: simplified },
          });
          title = simplified;
        }
      }
      if (globals.titleNoiseFilter) {
        const cleaned = title.replace(globals.titleNoiseFilter, '').trim();
        if (cleaned !== title) {
          recordConfigEffect('TITLE_NOISE_FILTER', {
            label: '剧名杂音清理', hit: true, before: { title }, after: { title: cleaned },
          });
          title = cleaned;
        }
      }
    } else {
      ({ title, season, episode } = await resolveTitleForFavorite(fileName));
    }
    if (!title) {
      phase('收藏·参数解析', { status: 'fail', reason: '无法从文件名解析出剧名', inputs: { fileName } });
      return jsonResponse({ success: false, message: '无法解析剧名' }, 400);
    }

    phase('收藏·参数解析', {
      status: 'ok',
      inputs: { keyword: requestedKeyword, fileName },
      outputs: { title, season, episode },
    });

    markStepActive('收藏·缓存查找');
    const cacheKey = cacheKeyFor(title, season);
    const entry = await findSearchEntry(cacheKey, title, season, episode, url);
    if (!entry?.results?.length) {
      phase('收藏·缓存查找', {
        status: 'miss', reason: '未找到该剧集的搜索结果，无法收藏',
        inputs: { cacheKey }, outputs: { count: 0 },
      });
      return jsonResponse({ success: false, message: '未找到该剧集搜索结果，无法收藏' }, 404);
    }

    phase('收藏·缓存查找', {
      status: 'hit', reason: '命中搜索缓存，可用于收藏',
      inputs: { cacheKey },
      // 该数量是可供收藏的候选数，不用 count 以免诊断按收藏条数表述
      outputs: { 可用候选数: entry.results.length },
    });

    const favoriteName = requestedKeyword || stripSeasonSuffix(cacheKey);
    addFavorite(favoriteName, entry.results, entry.details);
    await persistFavorites();
    markStepActive('收藏·写入');
    phase('收藏·写入', {
      status: 'ok',
      reason: '已收藏',
      inputs: { favoriteName },
      // 写入步骤的 count 是候选剧集数而非收藏条数，用明确字段名避免诊断误读为「返回 N 条收藏」
      outputs: { 写入剧集数: entry.results.length },
    });
    return jsonResponse({
      success: true,
      message: `已收藏「${favoriteName}」`,
      keyword: favoriteName,
      animeTitle: favoriteName,
      imageUrl: entry.results[0]?.imageUrl || '',
      isFavorite: true
    });
  } catch (error) {
    log('error', `[system] [favorite] add failed: ${error.message}`);
    phase('收藏·新增', { status: 'fail', reason: '收藏失败', error: error.message });
    return jsonResponse({ success: false, message: `收藏失败: ${error.message}` }, 500);
  }
}

export function handleFavoriteList() {
  const listStartedAt = Date.now();
  // Node/Docker 可以使用本地文件缓存；无持久化存储的 serverless 实例
  // 会在冷启动或实例切换后丢失收藏，因此不向前端开放收藏写入按钮。
  const favoriteSupported = globals.deployPlatform === 'node' || globals.redisValid === true;
  const favorites = listFavorites();
  traceStep('收藏·列表', listStartedAt, {
    status: 'ok',
    inputs: { favoriteSupported },
    outputs: { count: favorites.length },
  });
  return jsonResponse({
    success: true,
    favoriteSupported,
    favoriteSupportMessage: favoriteSupported
      ? ''
      : '当前云部署未配置 Redis，收藏功能不可用。请配置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN 后重新部署。',
    scheduledRefreshSupported: globals.deployPlatform === 'node',
    favorites
  });
}

export async function handleFavoriteSchedule(req) {
  const scheduleStartedAt = Date.now();
  if (globals.deployPlatform !== 'node') {
    traceStep('收藏·定时刷新', scheduleStartedAt, { status: 'skip', reason: '定时刷新仅支持 Node/Docker 部署' });
    return jsonResponse({ success: false, message: '定时刷新仅支持 Node/Docker 部署' }, 501);
  }

  try {
    const body = await req.json();
    const keyword = String(body?.keyword || '').trim();
    if (!keyword) {
      traceStep('收藏·定时刷新', scheduleStartedAt, { status: 'fail', reason: '缺少 keyword 参数' });
      return jsonResponse({ success: false, message: '缺少 keyword 参数' }, 400);
    }

    const resolved = resolveFavoriteForKeyword(keyword);
    if (!resolved) {
      traceStep('收藏·定时刷新', scheduleStartedAt, { status: 'miss', reason: '未找到该收藏', inputs: { keyword } });
      return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
    }

    if (body.schedule === null) {
      resolved.entry.refreshSchedule = null;
      await persistFavorites();
      traceStep('收藏·定时刷新', scheduleStartedAt, {
        status: 'ok', reason: '关闭定时刷新',
        inputs: { keyword, schedule: null },
        outputs: { refreshSchedule: null },
      });
      return jsonResponse({ success: true, message: '已关闭定时刷新', refreshSchedule: null });
    }

    const created = createFavoriteSchedule(body.schedule);
    if (!created.valid) {
      traceStep('收藏·定时刷新', scheduleStartedAt, { status: 'fail', reason: created.message, inputs: { keyword, schedule: body.schedule } });
      return jsonResponse({ success: false, message: created.message }, 400);
    }
    resolved.entry.refreshSchedule = created.value;
    await persistFavorites();
    traceStep('收藏·定时刷新', scheduleStartedAt, {
      status: 'ok', reason: '设置定时刷新',
      inputs: { keyword, schedule: body.schedule },
      outputs: { refreshSchedule: created.value },
    });
    return jsonResponse({
      success: true,
      message: '定时刷新设置成功',
      refreshSchedule: created.value
    });
  } catch (error) {
    log('error', `[system] [favorite] schedule failed: ${error.message}`);
    traceStep('收藏·定时刷新', scheduleStartedAt, {
      status: 'fail', reason: '设置定时刷新失败', error: error.message,
    });
    return jsonResponse({ success: false, message: `设置定时刷新失败: ${error.message}` }, 500);
  }
}

export async function handleFavoriteRemove(req) {
  const phase = createPhaseTimer();
  markStepActive('收藏·删除');
  try {
    const body = await req.json();
    let keyword = String(body?.keyword || body?.title || body?.fileName || '').trim();
    if (!keyword) {
      phase('收藏·删除', { status: 'fail', reason: '缺少 keyword 参数' });
      return jsonResponse({ success: false, message: '缺少 keyword 参数' }, 400);
    }

    if (body?.fileName && !body?.keyword && !body?.title) {
      const parsed = await resolveTitleForFavorite(keyword);
      keyword = cacheKeyFor(parsed.title, parsed.season);
    }

    const resolved = resolveFavoriteForKeyword(keyword);
    if (!resolved || !removeFavorite(resolved.keyword)) {
      phase('收藏·删除', { status: 'miss', reason: '未找到该收藏', inputs: { keyword } });
      return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
    }

    removeRelatedSearchCaches(resolved.keyword);
    await persistFavorites();
    phase('收藏·删除', {
      status: 'ok',
      reason: '已删除收藏',
      inputs: { keyword },
      outputs: { removed: resolved.keyword },
    });
    return jsonResponse({ success: true, message: '已删除收藏' });
  } catch (error) {
    log('error', `[system] [favorite] remove failed: ${error.message}`);
    phase('收藏·删除', { status: 'fail', reason: '删除收藏失败', error: error.message });
    return jsonResponse({ success: false, message: `删除收藏失败: ${error.message}` }, 500);
  }
}

async function refreshFavoriteResolved(fileName, requestedKeyword, url) {
    let title;
    let season = null;
    let episode = null;
    let cacheKey;
    if (fileName) {
      ({ title, season, episode } = await resolveTitleForFavorite(fileName));
      cacheKey = cacheKeyFor(title, season);
    } else {
      const resolved = resolveFavoriteForKeyword(requestedKeyword);
      cacheKey = resolved?.keyword || requestedKeyword;
      title = stripSeasonSuffix(cacheKey);
    }

    if (!resolveFavoriteForKeyword(cacheKey)) {
      const error = new Error('未找到该收藏');
      error.status = 404;
      throw error;
    }

    const detailsMap = new Map();
    const searchUrl = buildFavoriteSearchUrl(url, title, season, episode);
    const searchResponse = await searchAnime(searchUrl, null, null, detailsMap, null, true);
    const searchData = await searchResponse.json();
    if (!searchData?.success || !Array.isArray(searchData.animes) || searchData.animes.length === 0) {
      const error = new Error('刷新失败：未找到该剧集搜索结果');
      error.status = 404;
      throw error;
    }

    const stored = globals.searchCache instanceof Map ? globals.searchCache.get(cacheKey) : null;
    refreshFavorite(cacheKey, stored?.results || searchData.animes, stored?.details || detailsFromMap(detailsMap));
    const animeTitle = searchData.animes[0]?.animeTitle || title;
    return { cacheKey, animeTitle };
}

export async function refreshFavoriteByKeyword(keyword, url, { persist = true } = {}) {
  const resolved = resolveFavoriteForKeyword(keyword);
  const lockKey = resolved?.keyword || String(keyword || '').trim();
  if (!lockKey) throw Object.assign(new Error('未找到该收藏'), { status: 404 });
  if (favoriteRefreshLocks.has(lockKey)) {
    throw Object.assign(new Error('该收藏正在刷新，请稍后再试'), { status: 409 });
  }

  favoriteRefreshLocks.add(lockKey);
  try {
    const result = await refreshFavoriteResolved('', lockKey, url);
    if (persist) await persistFavorites();
    return result;
  } finally {
    favoriteRefreshLocks.delete(lockKey);
  }
}

export async function handleFavoriteRefresh(req, url) {
  const phase = createPhaseTimer();
  markStepActive('收藏·刷新');
  try {
    const body = await req.json();
    const fileName = String(body?.fileName || '').trim();
    const requestedKeyword = String(body?.keyword || '').trim();
    if (!fileName && !requestedKeyword) {
      phase('收藏·刷新', { status: 'fail', reason: '缺少 fileName 或 keyword 参数' });
      return jsonResponse({ success: false, message: '缺少 fileName 或 keyword 参数' }, 400);
    }

    let result;
    if (requestedKeyword) {
      result = await refreshFavoriteByKeyword(requestedKeyword, url);
    } else {
      const parsed = await resolveTitleForFavorite(fileName);
      const lockKey = resolveFavoriteForKeyword(cacheKeyFor(parsed.title, parsed.season))?.keyword;
      if (!lockKey) {
        phase('收藏·刷新', { status: 'miss', reason: '未找到该收藏', inputs: { fileName } });
        return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
      }
      if (favoriteRefreshLocks.has(lockKey)) {
        phase('收藏·刷新', { status: 'fail', reason: '该收藏正在刷新，请稍后再试', inputs: { keyword: lockKey } });
        return jsonResponse({ success: false, message: '该收藏正在刷新，请稍后再试' }, 409);
      }
      favoriteRefreshLocks.add(lockKey);
      try {
        result = await refreshFavoriteResolved(fileName, '', url);
        await persistFavorites();
      } finally {
        favoriteRefreshLocks.delete(lockKey);
      }
    }
    phase('收藏·刷新', {
      status: 'ok',
      reason: '已刷新收藏',
      inputs: { keyword: requestedKeyword, fileName },
      outputs: { animeTitle: result.animeTitle },
    });
    return jsonResponse({ success: true, message: `已刷新收藏「${result.animeTitle}」` });
  } catch (error) {
    log('error', `[system] [favorite] refresh failed: ${error.message}`);
    // refreshFavoriteByKeyword 以带 status 的错误表达未找到与并发刷新，统一在此留痕
    const reason = error.status === 404
      ? '未找到该收藏'
      : error.status === 409
        ? '该收藏正在刷新，请稍后再试'
        : '刷新收藏失败';
    phase('收藏·刷新', {
      status: error.status === 409 ? 'fail' : 'miss',
      reason,
      error: error.message,
    });
    return jsonResponse({ success: false, message: `刷新收藏失败: ${error.message}` }, error.status || 500);
  }
}
