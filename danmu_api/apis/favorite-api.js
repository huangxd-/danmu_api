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

async function persistFavorites() {
  if (globals.localCacheValid) await updateLocalCaches();
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
  return jsonResponse({ success: true, favorites: listFavorites() });
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

export async function handleFavoriteRefresh(req, url) {
  try {
    const body = await req.json();
    const fileName = String(body?.fileName || '').trim();
    const requestedKeyword = String(body?.keyword || '').trim();
    if (!fileName && !requestedKeyword) {
      return jsonResponse({ success: false, message: '缺少 fileName 或 keyword 参数' }, 400);
    }

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
      return jsonResponse({ success: false, message: '未找到该收藏' }, 404);
    }

    const detailsMap = new Map();
    const searchUrl = buildFavoriteSearchUrl(url, title, season, episode);
    const searchResponse = await searchAnime(searchUrl, null, null, detailsMap, null, true);
    const searchData = await searchResponse.json();
    if (!searchData?.success || !Array.isArray(searchData.animes) || searchData.animes.length === 0) {
      return jsonResponse({ success: false, message: '刷新失败：未找到该剧集搜索结果' }, 404);
    }

    const stored = globals.searchCache instanceof Map ? globals.searchCache.get(cacheKey) : null;
    refreshFavorite(cacheKey, stored?.results || searchData.animes, stored?.details || detailsFromMap(detailsMap));
    await persistFavorites();
    const animeTitle = searchData.animes[0]?.animeTitle || title;
    return jsonResponse({ success: true, message: `已刷新收藏「${animeTitle}」` });
  } catch (error) {
    log('error', `[favorite] refresh failed: ${error.message}`);
    return jsonResponse({ success: false, message: `刷新收藏失败: ${error.message}` }, 500);
  }
}
