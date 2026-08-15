import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { normalizeFavoriteSchedule } from './favorite-schedule-util.js';

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const timestamp = Number(entry.timestamp) || Date.now();
  return {
    results: Array.isArray(entry.results) ? entry.results : [],
    details: Array.isArray(entry.details) ? entry.details : [],
    timestamp,
    // 旧缓存只有 timestamp；将其作为最近一次生成收藏快照的时间兼容恢复。
    lastRefreshAt: Number(entry.lastRefreshAt) || timestamp,
    refreshSchedule: normalizeFavoriteSchedule(entry.refreshSchedule)
  };
}

function toFavoriteMap(value) {
  if (value instanceof Map) return new Map(value);

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Map();
  }

  const entries = Object.entries(parsed)
    .map(([keyword, entry]) => [String(keyword).trim(), normalizeEntry(entry)])
    .filter(([keyword, entry]) => keyword && entry);
  return new Map(entries);
}

// 从持久化快照恢复收藏。serverless 环境可不调用，继续使用实例内存。
export function loadFavorites(value = {}) {
  globals.favoriteCache = toFavoriteMap(value);
  log('info', `[favorite] Restored ${globals.favoriteCache.size} favorite entries`);
  return globals.favoriteCache;
}

// 返回可由 cache-util 持久化的普通对象快照。
export function saveFavorites() {
  if (!(globals.favoriteCache instanceof Map)) globals.favoriteCache = new Map();
  return Object.fromEntries(globals.favoriteCache.entries());
}

// 去掉关键词末尾的季节后缀 _S{n}，得到用于兜底匹配的剧名。
export function stripSeasonSuffix(keyword) {
  return String(keyword || '').replace(/_S\d+$/i, '').trim();
}

function getEntryTitles(keyword, entry) {
  const titles = new Set([stripSeasonSuffix(keyword)]);
  for (const anime of Array.isArray(entry?.results) ? entry.results : []) {
    const title = stripSeasonSuffix(anime?.animeTitle);
    if (title) titles.add(title);
  }
  return [...titles].filter(title => title.length >= 2);
}

// 搜索只能用完整标题命中收藏，避免短关键词误复用更长标题的收藏结果。
// 季度缓存键和收藏结果中的完整标题仍视为同一部剧。
export function resolveFavoriteForSearchKeyword(keyword) {
  const key = String(keyword || '').trim();
  if (!key || !(globals.favoriteCache instanceof Map) || globals.favoriteCache.size === 0) return null;

  if (globals.favoriteCache.has(key)) {
    return { keyword: key, entry: globals.favoriteCache.get(key) };
  }

  const queryTitle = stripSeasonSuffix(key);
  if (!queryTitle) return null;

  for (const [favoriteKeyword, entry] of globals.favoriteCache.entries()) {
    if (stripSeasonSuffix(favoriteKeyword) === queryTitle || getEntryTitles(favoriteKeyword, entry).includes(queryTitle)) {
      return { keyword: favoriteKeyword, entry };
    }
  }
  return null;
}

// 先精确匹配关键词，再按收藏键和收藏结果中的剧名做包含兜底。
export function resolveFavoriteForKeyword(keyword) {
  const key = String(keyword || '').trim();
  if (!key || !(globals.favoriteCache instanceof Map) || globals.favoriteCache.size === 0) return null;

  if (globals.favoriteCache.has(key)) {
    return { keyword: key, entry: globals.favoriteCache.get(key) };
  }

  const queryTitle = stripSeasonSuffix(key);
  if (queryTitle.length < 2) return null;

  for (const [favoriteKeyword, entry] of globals.favoriteCache.entries()) {
    const matched = getEntryTitles(favoriteKeyword, entry).some(title =>
      queryTitle.includes(title) || title.includes(queryTitle)
    );
    if (matched) return { keyword: favoriteKeyword, entry };
  }
  return null;
}

export function addFavorite(keyword, results, details = []) {
  const key = String(keyword || '').trim();
  if (!key) return null;
  if (!(globals.favoriteCache instanceof Map)) globals.favoriteCache = new Map();

  const now = Date.now();
  const entry = normalizeEntry({ results, details, timestamp: now, lastRefreshAt: now });
  globals.favoriteCache.set(key, entry);
  log('info', `[favorite] Added favorite "${key}" with ${entry.results.length} results`);
  return entry;
}

export function removeFavorite(keyword) {
  const resolved = resolveFavoriteForKeyword(keyword);
  if (!resolved) return false;

  globals.favoriteCache.delete(resolved.keyword);
  log('info', `[favorite] Removed favorite "${resolved.keyword}"`);
  return true;
}

// 用强制搜索得到的新快照覆盖收藏，保留原收藏键以避免刷新时产生重复项。
export function refreshFavorite(keyword, results, details = []) {
  const resolved = resolveFavoriteForKeyword(keyword);
  const key = resolved?.keyword || stripSeasonSuffix(keyword);
  if (!key) return null;

  const now = Date.now();
  const entry = normalizeEntry({
    results,
    details,
    timestamp: Number(resolved?.entry?.timestamp) || now,
    lastRefreshAt: now,
    refreshSchedule: resolved?.entry?.refreshSchedule || null
  });
  if (!(globals.favoriteCache instanceof Map)) globals.favoriteCache = new Map();
  globals.favoriteCache.set(key, entry);
  log('info', `[favorite] Refreshed favorite "${key}" with ${entry.results.length} results`);
  return entry;
}

export function listFavorites() {
  if (!(globals.favoriteCache instanceof Map)) return [];

  const items = [];
  for (const [keyword, entry] of globals.favoriteCache.entries()) {
    const results = Array.isArray(entry?.results) ? entry.results : [];
    const primary = results[0] || {};
    const sources = [...new Set(results.map(anime => anime?.source).filter(Boolean))];
    const episodeCount = results.reduce((sum, anime) => sum + (Number(anime?.episodeCount) || 0), 0);

    items.push({
      keyword,
      animeTitle: keyword,
      source: sources.join('、'),
      sources,
      imageUrl: primary.imageUrl || '',
      episodeCount,
      resultsCount: results.length,
      timestamp: Number(entry?.timestamp) || 0,
      lastRefreshAt: Number(entry?.lastRefreshAt) || Number(entry?.timestamp) || 0,
      refreshSchedule: normalizeFavoriteSchedule(entry?.refreshSchedule)
    });
  }

  return items.sort((a, b) => b.lastRefreshAt - a.lastRefreshAt);
}

// 兼容内部旧调用名称。
export function getFavoriteEntry(keyword) {
  return globals.favoriteCache instanceof Map ? globals.favoriteCache.get(String(keyword || '').trim()) || null : null;
}

export function getFavoriteEntryForKeyword(keyword) {
  return resolveFavoriteForKeyword(keyword)?.entry || null;
}
