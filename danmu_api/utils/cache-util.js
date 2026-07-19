import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { Anime } from "../models/dandan-model.js";
import { simpleHash } from "./codec-util.js";
let fs, path;

// =====================
// cache数据结构处理函数
// =====================

// 用于存储最后一次搜索的上下文 (IP -> Context)
const lastSearchMap = new Map();

export function setLastSearch(ip, data) {
    lastSearchMap.set(ip, { ...data, timestamp: Date.now() });
    // 简单的清理逻辑：如果map太大，清理一半
    if (lastSearchMap.size > 200) {
        for (const [key, value] of lastSearchMap) {
            if (Date.now() - value.timestamp > 3600 * 1000) { // 清理超过1小时的
                lastSearchMap.delete(key);
            }
        }
    }
}

export function getLastSearch(ip) {
    return lastSearchMap.get(ip);
}

function getAnimeIdentityKey(anime) {
    if (!anime || typeof anime !== "object") {
        return "";
    }

    const sourcePrefix = anime.source ? String(anime.source) + ":" : "";

    if (anime.bangumiId !== undefined && anime.bangumiId !== null && String(anime.bangumiId) !== "") {
        return "bangumi:" + sourcePrefix + String(anime.bangumiId);
    }

    if (anime.animeId !== undefined && anime.animeId !== null && String(anime.animeId) !== "") {
        return "anime:" + sourcePrefix + String(anime.animeId);
    }

    return "";
}

function storeAnimeDetail(detailStore, anime) {
    if (!(detailStore instanceof Map) || !anime) {
        return;
    }

    const identityKey = getAnimeIdentityKey(anime);
    if (!identityKey) {
        return;
    }

    detailStore.set(identityKey, anime);
}

function* iterateDetailStore(detailStore) {
    if (!(detailStore instanceof Map)) {
        return;
    }

    const seen = new Set();
    for (const anime of detailStore.values()) {
        const identityKey = getAnimeIdentityKey(anime);
        if (identityKey && seen.has(identityKey)) {
            continue;
        }
        if (identityKey) {
            seen.add(identityKey);
        }
        yield anime;
    }
}

function collectUniqueAnimeDetails(detailStore) {
    const details = [];
    for (const anime of iterateDetailStore(detailStore)) {
        details.push(anime);
    }
    return details;
}

function getActiveSearchCacheEntries() {
    const now = Date.now();
    const activeEntries = [];

    for (const [keyword, cached] of globals.searchCache.entries()) {
        const cacheAgeMinutes = (now - cached.timestamp) / (1000 * 60);

        if (cacheAgeMinutes > globals.searchCacheMinutes) {
            globals.searchCache.delete(keyword);
            log("info", `[cache] Search cache for "${keyword}" expired after ${cacheAgeMinutes.toFixed(2)} minutes`);
            continue;
        }

        activeEntries.push(cached);
    }

    activeEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return activeEntries;
}

// 清除 Map 中所有已超过 TTL 的过期条目
// 使用 Map 自身的迭代器遍历并删除，不依赖 getActiveSearchCacheEntries 的返回值
function sweepExpiredCache(cacheMap, cacheMinutes, cacheName) {
    const now = Date.now();
    let sweptCount = 0;

    for (const [key, entry] of cacheMap.entries()) {
        const ageMinutes = (now - entry.timestamp) / (1000 * 60);
        if (ageMinutes > cacheMinutes) {
            cacheMap.delete(key);
            sweptCount++;
        }
    }

    if (sweptCount > 0) {
        log("info", `[cache] ${cacheName} TTL 扫描完毕，已移除 ${sweptCount} 个过期条目，剩余 ${cacheMap.size} 个`);
    }
}

function matchesAnimeId(anime, idStr) {
    return String(anime?.animeId) === idStr || String(anime?.bangumiId) === idStr;
}

function findAnimeByIdInIterator(iterator, idStr, source = null) {
    let fallback = null;

    for (const anime of iterator) {
        if (!matchesAnimeId(anime, idStr)) {
            continue;
        }

        if (source && anime?.source === source) {
            return anime;
        }

        if (!fallback) {
            fallback = anime;
        }
    }

    return fallback;
}

function* iterateSearchCacheDetails() {
    const seen = new Set();

    for (const cached of getActiveSearchCacheEntries()) {
        if (!Array.isArray(cached.details)) {
            continue;
        }

        for (const anime of cached.details) {
            const identityKey = getAnimeIdentityKey(anime);
            if (identityKey && seen.has(identityKey)) {
                continue;
            }
            if (identityKey) {
                seen.add(identityKey);
            }
            yield anime;
        }
    }
}

export function resolveAnimeById(id, detailStore = null, source = null) {
    const idStr = String(id);

    let anime = findAnimeByIdInIterator(globals.animes, idStr, source);
    if (anime) {
        return anime;
    }

    anime = findAnimeByIdInIterator(iterateDetailStore(detailStore), idStr, source);
    if (anime) {
        return anime;
    }

    return findAnimeByIdInIterator(iterateSearchCacheDetails(), idStr, source);
}

export function resolveAnimeByIdFromDetailStore(id, detailStore = null, source = null) {
    const idStr = String(id);
    return findAnimeByIdInIterator(iterateDetailStore(detailStore), idStr, source);
}

export function resolveEpisodeContextById(id, detailStore = null) {
    const commentId = Number(id);
    if (!Number.isFinite(commentId)) {
        return null;
    }

    const matchEpisode = (anime) => {
        if (!anime?.links || !Array.isArray(anime.links)) {
            return null;
        }

        const index = anime.links.findIndex(link => link.id === commentId);
        if (index === -1) {
            return null;
        }

        return {
            anime,
            link: anime.links[index],
            index
        };
    };

    for (const anime of globals.animes) {
        const result = matchEpisode(anime);
        if (result) {
            return result;
        }
    }

    for (const anime of iterateDetailStore(detailStore)) {
        const result = matchEpisode(anime);
        if (result) {
            return result;
        }
    }

    const seen = new Set();
    for (const anime of globals.animes) {
        const identityKey = getAnimeIdentityKey(anime);
        if (identityKey) {
            seen.add(identityKey);
        }
    }
    for (const anime of iterateDetailStore(detailStore)) {
        const identityKey = getAnimeIdentityKey(anime);
        if (identityKey) {
            seen.add(identityKey);
        }
    }

    for (const anime of iterateSearchCacheDetails()) {
        const identityKey = getAnimeIdentityKey(anime);
        if (identityKey && seen.has(identityKey)) {
            continue;
        }
        if (identityKey) {
            seen.add(identityKey);
        }

        const result = matchEpisode(anime);
        if (result) {
            return result;
        }
    }

    return null;
}
// 检查搜索缓存是否有效（未过期）
export function isSearchCacheValid(keyword) {
    if (!globals.searchCache.has(keyword)) {
        return false;
    }

    const cached = globals.searchCache.get(keyword);
    const now = Date.now();
    const cacheAgeMinutes = (now - cached.timestamp) / (1000 * 60);

    if (cacheAgeMinutes > globals.searchCacheMinutes) {
        // 缓存已过期，删除它
        globals.searchCache.delete(keyword);
        log("info", `[cache] Search cache for "${keyword}" expired after ${cacheAgeMinutes.toFixed(2)} minutes`);
        return false;
    }

    return true;
}

// 获取搜索缓存
export function getSearchCache(keyword, detailsMap = null) {
    if (isSearchCacheValid(keyword)) {
        log("info", `[cache] Using search cache for "${keyword}"`);
        const cached = globals.searchCache.get(keyword);

        if (detailsMap instanceof Map && Array.isArray(cached.details)) {
            cached.details.forEach(anime => {
                storeAnimeDetail(detailsMap, anime);
            });
        }

        return cached.results;
    }
    return null;
}

// 设置搜索缓存
export function setSearchCache(keyword, results, detailsMap = null) {
    const details = collectUniqueAnimeDetails(detailsMap);

    // 写入前先清理所有过期条目
    sweepExpiredCache(globals.searchCache, globals.searchCacheMinutes, 'searchCache');

    globals.searchCache.set(keyword, {
        results: results,
        details: details,
        timestamp: Date.now()
    });

    // TTL 清理后仍未降回上限，则按插入顺序移除最早条目作为安全兜底
    if (globals.searchCache.size > 500) {
        const oldestKey = globals.searchCache.keys().next().value;
        globals.searchCache.delete(oldestKey);
        log("info", `[cache] searchCache TTL清理后仍达上限，已移除最早条目: ${oldestKey}`);
    }

    log("info", `[cache] Cached search results for "${keyword}" (${results.length} animes)`);
}

// 检查弹幕缓存是否有效（未过期）
export function isCommentCacheValid(videoUrl) {
    if (!globals.commentCache.has(videoUrl)) {
        return false;
    }

    const cached = globals.commentCache.get(videoUrl);
    const now = Date.now();
    const cacheAgeMinutes = (now - cached.timestamp) / (1000 * 60);

    if (cacheAgeMinutes > globals.commentCacheMinutes) {
        // 缓存已过期，删除它
        globals.commentCache.delete(videoUrl);
        log("info", `[cache] Comment cache for "${videoUrl}" expired after ${cacheAgeMinutes.toFixed(2)} minutes`);
        return false;
    }

    return true;
}

// 获取弹幕缓存
export function getCommentCache(videoUrl) {
    if (isCommentCacheValid(videoUrl)) {
        log("info", `[cache] Using comment cache for "${videoUrl}"`);
        return globals.commentCache.get(videoUrl).comments;
    }
    return null;
}

// 设置弹幕缓存
export function setCommentCache(videoUrl, comments) {
    // 写入前先清理所有过期条目
    sweepExpiredCache(globals.commentCache, globals.commentCacheMinutes, 'commentCache');

    globals.commentCache.set(videoUrl, {
        comments: comments,
        timestamp: Date.now()
    });

    // TTL 清理后仍未降回上限，则按插入顺序移除最早条目作为安全兜底
    if (globals.commentCache.size > 500) {
        const oldestKey = globals.commentCache.keys().next().value;
        globals.commentCache.delete(oldestKey);
        log("info", `[cache] commentCache TTL清理后仍达上限，已移除最早条目: ${oldestKey}`);
    }

    log("info", `[cache] Cached comments for "${videoUrl}" (${comments.length} comments)`);
}

// 添加元素到 episodeIds：检查 url 是否存在，若不存在则以自增 id 添加
export function addEpisode(url, title) {
    // 检查是否已存在相同的 url 和 title
    const existingEpisode = globals.episodeIds.find(episode => episode.url === url && episode.title === title);
    if (existingEpisode) {
        log("info", `[cache] Episode with URL ${url} and title ${title} already exists in episodeIds, returning existing episode.`);
        return existingEpisode; // 返回已存在的 episode
    }

    // 自增 episodeNum 并使用作为 id
    globals.episodeNum++;
    const newEpisode = { id: globals.episodeNum, url: url, title: title };

    // 添加新对象
    globals.episodeIds.push(newEpisode);

    log("info", `[cache] Added to episodeIds: ${JSON.stringify(newEpisode)}`);
    return newEpisode; // 返回新添加的对象
}

// 删除指定 URL 的对象从 episodeIds
export function removeEpisodeByUrl(url) {
    const initialLength = globals.episodeIds.length;
    globals.episodeIds = globals.episodeIds.filter(episode => episode.url !== url);
    const removedCount = initialLength - globals.episodeIds.length;
    if (removedCount > 0) {
        log("info", `[cache] Removed ${removedCount} episode(s) from episodeIds with URL: ${url}`);
        return true;
    }
    log("error", `[cache] No episode found in episodeIds with URL: ${url}`);
    return false;
}

// 根据 ID 查找 URL
export function findUrlById(id) {
    const episode = globals.episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `[cache] Found URL for ID ${id}: ${episode.url}`);
        return episode.url;
    }

    const resolved = resolveEpisodeContextById(id);
    if (resolved?.link?.url) {
        log("info", `[cache] Found URL for ID ${id} via cached anime details: ${resolved.link.url}`);
        return resolved.link.url;
    }

    log("error", `[cache] No URL found for ID: ${id}`);
    return null;
}

// 根据 ID 查找 episodeIds 数组下标
export function findIndexById(id) {
    const index = globals.episodeIds.findIndex(episode => episode.id === id);
    if (index !== -1) {
        log("info", `[cache] Found index for ID ${id}: ${index}`);
        return index;
    }

    const resolved = resolveEpisodeContextById(id);
    if (resolved) {
        log("info", `[cache] Found index for ID ${id} via cached anime details: ${resolved.index}`);
        return resolved.index;
    }

    log("error", `[cache] No index found for ID: ${id}`);
    return -1;
}

// 根据 ID 查找 TITLE
export function findTitleById(id) {
    const episode = globals.episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `[cache] Found TITLE for ID ${id}: ${episode.title}`);
        return episode.title;
    }

    const resolved = resolveEpisodeContextById(id);
    if (resolved?.link?.title) {
        log("info", `[cache] Found TITLE for ID ${id} via cached anime details: ${resolved.link.title}`);
        return resolved.link.title;
    }

    log("error", `[cache] No TITLE found for ID: ${id}`);
    return null;
}

// 根据 ID 查找 animeTitle
export function findAnimeTitleById(id) {
    const resolved = resolveEpisodeContextById(id);
    if (resolved?.anime?.animeTitle) {
        log("info", `[cache] Found animeTitle for ID ${id}: ${resolved.anime.animeTitle}`);
        return resolved.anime.animeTitle;
    }

    log("error", `[cache] No animeTitle found for ID: ${id}`);
    return null;
}

// 添加 anime 对象到 animes，并将其 links 添加到 episodeIds
export function addAnime(anime, detailStore = null) {
    anime = Anime.fromJson(anime);
    try {
        // 确保 anime 有 links 属性且是数组
        if (!anime.links || !Array.isArray(anime.links)) {
            log("error", `[cache] Invalid or missing links in anime: ${JSON.stringify(anime)}`);
            return false;
        }

        // 遍历 links，调用 addEpisode，并收集返回的对象
        const newLinks = [];
        anime.links.forEach(link => {
            if (link.url) {
                const episode = addEpisode(link.url, link.title);
                if (episode) {
                    newLinks.push(episode); // 仅添加成功添加的 episode
                }
            } else {
                log("error", `[cache] Invalid link in anime, missing url: ${JSON.stringify(link)}`);
            }
        });

        // 创建新的 anime 副本
        const animeCopy = Anime.fromJson({ ...anime, links: newLinks });

        // 当前请求内额外保留一份详情，避免被全局数量上限裁剪后丢失
        storeAnimeDetail(detailStore, animeCopy);

        // 检查是否已存在相同 animeId 的 anime
        const existingAnimeIndex = globals.animes.findIndex(a => a.animeId === anime.animeId);

        if (existingAnimeIndex !== -1) {
            // 如果存在，先删除旧的
            globals.animes.splice(existingAnimeIndex, 1);
            log("info", `[cache] Removed old anime at index: ${existingAnimeIndex}`);
        }

        // 将新的添加到数组末尾（最新位置）
        globals.animes.push(animeCopy);
        log("info", `[cache] Added anime to latest position: ${anime.animeId}`);

        // 检查是否超过 MAX_ANIMES，超过则删除最早的
        if (globals.animes.length > globals.MAX_ANIMES) {
            const removeSuccess = removeEarliestAnime();
            if (!removeSuccess) {
                log("error", "[cache] Failed to remove earliest anime, but continuing");
            }
        }

        log("info", `[cache] animes: ${JSON.stringify(
          globals.animes.map(anime => ({
            links: anime.links,
            animeId: anime.animeId,
            bangumiId: anime.bangumiId,
            animeTitle: anime.animeTitle
          })),
          (key, value) => key === "links" ? value.length : value
        )}`);

        return true;
    } catch (error) {
        log("error", `[cache] addAnime failed: ${error.message}`);
        return false;
    }
}
// 删除最早添加的 anime，并从 episodeIds 删除其 links 中的 url
export function removeEarliestAnime() {
    if (globals.animes.length === 0) {
        log("error", "[cache] No animes to remove.");
        return false;
    }

    // 移除最早的 anime（第一个元素）
    const removedAnime = globals.animes.shift();
    log("info", `[cache] Removed earliest anime: ${JSON.stringify(removedAnime)}`);

    // 从 episodeIds 删除该 anime 的所有 links 中的 url
    if (removedAnime.links && Array.isArray(removedAnime.links)) {
        removedAnime.links.forEach(link => {
            if (link.url) {
                removeEpisodeByUrl(link.url);
            }
        });
    }

    return true;
}

// 将所有动漫的 animeId 存入 lastSelectMap 的 animeIds 数组中
export function storeAnimeIdsToMap(curAnimes, key) {
    const uniqueAnimeIds = new Set();
    
    const oldValue = globals.lastSelectMap.get(key);
    
    // 保留旧的 animeIds，确保包含全量季度的 ID 列表不被单季度搜索结果覆盖
    if (oldValue && Array.isArray(oldValue.animeIds)) {
        for (const id of oldValue.animeIds) {
            uniqueAnimeIds.add(id);
        }
    }

    for (const anime of curAnimes) {
        uniqueAnimeIds.add(anime.animeId);
    }

    // 保存旧的 prefer/source/offsets（兼容旧结构）
    const oldPrefer = oldValue?.prefer;
    const oldSource = oldValue?.source;
    const oldPreferBySeason = oldValue?.preferBySeason;
    const oldSourceBySeason = oldValue?.sourceBySeason;
    const oldOffsets = oldValue?.offsets;

    const preferBySeason = oldPreferBySeason ? { ...oldPreferBySeason } : {};
    const sourceBySeason = oldSourceBySeason ? { ...oldSourceBySeason } : {};

    if (oldPrefer !== undefined) {
        preferBySeason.default = oldPrefer;
    }
    if (oldSource !== undefined) {
        sourceBySeason.default = oldSource;
    }

    // 如果key已存在，先删除它（为了更新顺序，保证 FIFO）
    if (globals.lastSelectMap.has(key)) {
        globals.lastSelectMap.delete(key);
    }

    // 添加新记录，保留prefer字段
    globals.lastSelectMap.set(key, {
        animeIds: [...uniqueAnimeIds],
        ...(Object.keys(preferBySeason).length > 0 && { preferBySeason }),
        ...(Object.keys(sourceBySeason).length > 0 && { sourceBySeason }),
        ...(oldOffsets !== undefined && { offsets: oldOffsets })
    });

    // 检查是否超过 MAX_LAST_SELECT_MAP，超过则删除最早的
    if (globals.lastSelectMap.size > globals.MAX_LAST_SELECT_MAP) {
        const firstKey = globals.lastSelectMap.keys().next().value;
        globals.lastSelectMap.delete(firstKey);
        log("info", `[cache] Removed earliest entry from lastSelectMap: ${firstKey}`);
    }
}

// 根据给定的 commentId 查找对应的 animeId
export function findAnimeIdByCommentId(commentId) {
  const resolved = resolveEpisodeContextById(commentId);
  if (resolved) {
    // 返回别名列表以支持跨源标题差异的偏好记录校验
    return [resolved.anime.animeId, resolved.anime.source, resolved.link.title, resolved.anime.aliases || []];
  }
  return [null, null, null, []];
}

// 通过 animeId 查找 lastSelectMap 中 animeIds 包含该 animeId 的 key，并设置其 prefer 为 animeId
export function setPreferByAnimeId(animeId, source, season = null, offset = null) {
  for (const [key, value] of globals.lastSelectMap.entries()) {
    if (value.animeIds && value.animeIds.includes(animeId)) {
      const seasonKey = season === null ? 'default' : String(season);
      value.preferBySeason = value.preferBySeason || {};
      value.sourceBySeason = value.sourceBySeason || {};
      value.preferBySeason[seasonKey] = animeId;
      value.sourceBySeason[seasonKey] = source;
      if (season !== null && offset !== null) {
        value.offsets = value.offsets || {};
        value.offsets[seasonKey] = offset;
      }
      globals.lastSelectMap.set(key, value); // 确保更新被保存
      return key; // 返回被修改的 key
    }
  }
  return null; // 如果没有找到匹配的 key，返回 null
}

// 通过 title 查询优选 animeId（按 season 维度）
export function getPreferAnimeId(title, season = null) {
  const value = globals.lastSelectMap.get(title);
  if (!value) {
    return [null, null, null];
  }

  const seasonKey = season === null ? 'default' : String(season);
  const preferBySeason = value.preferBySeason || {};
  const sourceBySeason = value.sourceBySeason || {};

  const prefer = preferBySeason[seasonKey] ?? preferBySeason.default ?? value.prefer ?? null;
  const source = sourceBySeason[seasonKey] ?? sourceBySeason.default ?? value.source ?? null;
  const offsets = value.offsets || null;

  return [prefer, source, offsets];
}

// 清理所有过期的 IP 记录（超过 1 分钟没有请求的 IP）
export function cleanupExpiredIPs(currentTime) {
  const oneMinute = 60 * 1000;
  let cleanedCount = 0;

  for (const [ip, timestamps] of globals.requestHistory.entries()) {
    const validTimestamps = timestamps.filter(ts => currentTime - ts <= oneMinute);
    if (validTimestamps.length === 0) {
      globals.requestHistory.delete(ip);
      cleanedCount++;
      log("info", `[system] [Rate Limit] Cleaned up expired IP record: ${ip}`);
    } else if (validTimestamps.length < timestamps.length) {
      globals.requestHistory.set(ip, validTimestamps);
    }
  }

  if (cleanedCount > 0) {
    log("info", `[system] [Rate Limit] Cleanup completed: removed ${cleanedCount} expired IP records`);
  }
}

// 获取当前文件目录的兼容方式
export function getDirname() {
  if (typeof __dirname !== 'undefined') {
    // CommonJS 环境 (Vercel)
    return __dirname;
  }
  // ES Module 环境 (本地)
  // 假设 cache-util.js 在 danmu_api/utils/ 目录下
  return path.join(process.cwd(), 'danmu_api', 'utils');
}

// 从本地缓存目录读取缓存数据
export function readCacheFromFile(key) {
  const cacheFilePath = path.join(getDirname(), '..', '..', '.cache', `${key}`);
  if (fs.existsSync(cacheFilePath)) {
    const fileContent = fs.readFileSync(cacheFilePath, 'utf8');
    return JSON.parse(fileContent);
  }
  return null;
}

// 将缓存数据写入本地缓存文件
export function writeCacheToFile(key, value) {
  const cacheFilePath = path.join(getDirname(), '..', '..', '.cache', `${key}`);
  fs.writeFileSync(cacheFilePath, JSON.stringify(value), 'utf8');
}

// 从本地获取缓存
export async function getLocalCaches() {
  if (!globals.localCacheInitialized) {
    try {
      log("info", '[cache] getLocalCaches start.');

      // 从本地缓存文件读取数据并恢复到 globals 中
      globals.animes = JSON.parse(readCacheFromFile('animes')) || globals.animes;
      globals.episodeIds = JSON.parse(readCacheFromFile('episodeIds')) || globals.episodeIds;
      globals.episodeNum = JSON.parse(readCacheFromFile('episodeNum')) || globals.episodeNum;
      globals.reqRecords = JSON.parse(readCacheFromFile('reqRecords')) || globals.reqRecords;
      globals.todayReqNum = JSON.parse(readCacheFromFile('todayReqNum')) || globals.todayReqNum;

      // 恢复 lastSelectMap 并转换为 Map 对象
      const lastSelectMapData = readCacheFromFile('lastSelectMap');
      if (lastSelectMapData) {
        globals.lastSelectMap = new Map(Object.entries(JSON.parse(lastSelectMapData)));
        log("info", `[cache] Restored lastSelectMap from local cache with ${globals.lastSelectMap.size} entries`);
      }

      // 更新哈希值
      globals.lastHashes.animes = simpleHash(JSON.stringify(globals.animes));
      globals.lastHashes.episodeIds = simpleHash(JSON.stringify(globals.episodeIds));
      globals.lastHashes.episodeNum = simpleHash(JSON.stringify(globals.episodeNum));
      globals.lastHashes.reqRecords = simpleHash(JSON.stringify(globals.reqRecords));
      globals.lastHashes.todayReqNum = simpleHash(JSON.stringify(globals.todayReqNum));
      globals.lastHashes.lastSelectMap = simpleHash(JSON.stringify(Object.fromEntries(globals.lastSelectMap)));

      globals.localCacheInitialized = true;
      log("info", '[cache] getLocalCaches completed successfully.');
    } catch (error) {
      log("error", `[cache] getLocalCaches failed: ${error.message}`, error.stack);
      globals.localCacheInitialized = true; // 标记为已初始化，避免重复尝试
    }
  }
}

// 更新本地缓存
export async function updateLocalCaches() {
  try {
    log("info", '[cache] updateLocalCaches start.');
    const updates = [];

    // 检查每个变量的哈希值
    const variables = [
      { key: 'animes', value: globals.animes },
      { key: 'episodeIds', value: globals.episodeIds },
      { key: 'episodeNum', value: globals.episodeNum },
      { key: 'reqRecords', value: globals.reqRecords },
      { key: 'lastSelectMap', value: globals.lastSelectMap },
      { key: 'todayReqNum', value: globals.todayReqNum }
    ];

    for (const { key, value } of variables) {
      // 对于 lastSelectMap（Map 对象），需要转换为普通对象后再序列化
      const serializedValue = key === 'lastSelectMap' ? JSON.stringify(Object.fromEntries(value)) : JSON.stringify(value);
      const currentHash = simpleHash(serializedValue);
      if (currentHash !== globals.lastHashes[key]) {
        writeCacheToFile(key, serializedValue);
        updates.push({ key, hash: currentHash });
      }
    }

    // 输出更新日志
    if (updates.length > 0) {
      log("info", `[cache] Updated local caches for keys: ${updates.map(u => u.key).join(', ')}`);
      updates.forEach(({ key, hash }) => {
        globals.lastHashes[key] = hash; // 更新本地哈希
      });
    } else {
      log("info", '[cache] No changes detected, skipping local cache update.');
    }

  } catch (error) {
    log("error", `[cache] updateLocalCaches failed: ${error.message}`, error.stack);
    log("error", `[cache] Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
  }
}

// 判断是否有效的本地缓存目录
export async function judgeLocalCacheValid(urlPath, deployPlatform) {
  if (deployPlatform === 'node') {
    try {
      fs = await import('fs');
      path = await import('path');

      if (!globals.localCacheValid && urlPath !== "/favicon.ico" && urlPath !== "/robots.txt") {
        const cacheDirPath = path.join(getDirname(), '..', '..', '.cache');

        if (fs.existsSync(cacheDirPath)) {
          globals.localCacheValid = true;
        } else {
          globals.localCacheValid = false;
        }
      }
    } catch (error) {
      log("warn", "[cache] Node.js modules not available:", error.message);
      globals.localCacheValid = false;
    }
  }
}
