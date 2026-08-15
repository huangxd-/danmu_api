import { globals } from '../configs/globals.js';
import { getSearchCache, updateLocalCaches } from '../utils/cache-util.js';
import { jsonResponse } from '../utils/http-util.js';
import { log } from '../utils/log-util.js';
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

  if (globals.titleMappingTable && globals.titleMappingTable.size > 0) {
    title = globals.titleMappingTable.get(title) || title;
  }
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
  try {
    const body = await req.json();
    const requestedKeyword = String(body?.keyword || '').trim();
    const fileName = String(body?.fileName || '').trim();
    if (!requestedKeyword && !fileName) {
      return jsonResponse({ success: false, message: '缺少 keyword 或 fileName 参数' }, 400);
    }

    let title;
    let season = null;
    let episode = null;
    if (requestedKeyword) {
      title = requestedKeyword;
      if (globals.animeTitleSimplified) title = simplized(title);
      if (globals.titleNoiseFilter) title = title.replace(globals.titleNoiseFilter, '').trim();
    } else {
      ({ title, season, episode } = await resolveTitleForFavorite(fileName));
    }
    if (!title) return jsonResponse({ success: false, message: '无法解析剧名' }, 400);

    const cacheKey = cacheKeyFor(title, season);
    const entry = await findSearchEntry(cacheKey, title, season, episode, url);
    if (!entry?.results?.length) {
      return jsonResponse({ success: false, message: '未找到该剧集搜索结果，无法收藏' }, 404);
    }

    const favoriteName = requestedKeyword || stripSeasonSuffix(cacheKey);
    addFavorite(favoriteName, entry.results, entry.details);
    await persistFavorites();
    return jsonResponse({
      success: true,
      message: `已收藏「${favoriteName}」`,
      keyword: favoriteName,
      animeTitle: favoriteName,
      imageUrl: entry.results[0]?.imageUrl || '',
      isFavorite: true
    });
  } catch (error) {
    log('error', `[favorite] add failed: ${error.message}`);
    return jsonResponse({ success: false, message: `收藏失败: ${error.message}` }, 500);
  }
}

export function handleFavoriteList() {
  return jsonResponse({
    success: true,
    scheduledRefreshSupported: globals.deployPlatform === 'node',
    favorites: listFavorites()
  });
}

export async function handleFavoriteSchedule(req) {
  if (globals.deployPlatform !== 'node') {
    return jsonResponse({ success: false, message: '定时刷新仅支持 Node/Docker 部署' }, 501);
  }

  try {
    const body = await req.json();
    const keyword = String(body?.keyword || '').trim();
    if (!keyword) return jsonResponse({ success: false, message: '缺少 keyword 参数' }, 400);

    const resolved = resolveFavoriteForKeyword(keyword);
    if (!resolved) return jsonResponse({ success: false, message: '未找到该收藏' }, 404);

    if (body.schedule === null) {
      resolved.entry.refreshSchedule = null;
      await persistFavorites();
      return jsonResponse({ success: true, message: '已关闭定时刷新', refreshSchedule: null });
    }

    const created = createFavoriteSchedule(body.schedule);
    if (!created.valid) return jsonResponse({ success: false, message: created.message }, 400);
    resolved.entry.refreshSchedule = created.value;
    await persistFavorites();
    return jsonResponse({
      success: true,
      message: '定时刷新设置成功',
      refreshSchedule: created.value
    });
  } catch (error) {
    log('error', `[favorite] schedule failed: ${error.message}`);
    return jsonResponse({ success: false, message: `设置定时刷新失败: ${error.message}` }, 500);
  }
}

export async function handleFavoriteRemove(req) {
  try {
    const body = await req.json();
    let keyword = String(body?.keyword || body?.title || body?.fileName || '').trim();
    if (!keyword) return jsonResponse({ success: false, message: '缺少 keyword 参数' }, 400);

    if (body?.fileName && !body?.keyword && !body?.title) {
      const parsed = await resolveTitleForFavorite(keyword);
      keyword = cacheKeyFor(parsed.title, parsed.season);
    }

    const resolved = resolveFavoriteForKeyword(keyword);
    if (!resolved || !removeFavorite(resolved.keyword)) {
      return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
    }

    removeRelatedSearchCaches(resolved.keyword);
    await persistFavorites();
    return jsonResponse({ success: true, message: '已删除收藏' });
  } catch (error) {
    log('error', `[favorite] remove failed: ${error.message}`);
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
  try {
    const body = await req.json();
    const fileName = String(body?.fileName || '').trim();
    const requestedKeyword = String(body?.keyword || '').trim();
    if (!fileName && !requestedKeyword) {
      return jsonResponse({ success: false, message: '缺少 fileName 或 keyword 参数' }, 400);
    }

    let result;
    if (requestedKeyword) {
      result = await refreshFavoriteByKeyword(requestedKeyword, url);
    } else {
      const parsed = await resolveTitleForFavorite(fileName);
      const lockKey = resolveFavoriteForKeyword(cacheKeyFor(parsed.title, parsed.season))?.keyword;
      if (!lockKey) return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
      if (favoriteRefreshLocks.has(lockKey)) {
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
    return jsonResponse({ success: true, message: `已刷新收藏「${result.animeTitle}」` });
  } catch (error) {
    log('error', `[favorite] refresh failed: ${error.message}`);
    return jsonResponse({ success: false, message: `刷新收藏失败: ${error.message}` }, error.status || 500);
  }
}
