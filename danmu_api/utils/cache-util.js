import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { Anime } from "../models/dandan-model.js";
import { simpleHash } from "./codec-util.js";
import { loadFavorites, resolveFavoriteForSearchKeyword, saveFavorites } from "./favorite-util.js";
let fs, path;
let nodeModulesPromise;
async function loadFileCacheModules() {
  nodeModulesPromise ||= Promise.all([import('fs'), import('path')]).catch(error => {
    nodeModulesPromise = null;
    throw error;
  });
  [fs, path] = await nodeModulesPromise;
}

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
        if (cacheMap === globals.searchCache && globals.favoriteCache instanceof Map && globals.favoriteCache.has(key)) {
            continue;
        }
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

    // 收藏剧集的详情也纳入解析范围（永久缓存）
    if (globals.favoriteCache instanceof Map) {
        for (const cached of globals.favoriteCache.values()) {
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
    if (resolveFavoriteForSearchKeyword(keyword)) {
        return true;
    }

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
    // 收藏剧集永久缓存优先命中（无 TTL、无数量上限）
    const favorite = resolveFavoriteForSearchKeyword(keyword);
    if (favorite) {
        const favoriteEntry = favorite.entry;
        log("info", `[cache] Using favorite cache for "${keyword}"`);
        if (detailsMap instanceof Map && Array.isArray(favoriteEntry.details)) {
            favoriteEntry.details.forEach(anime => {
                storeAnimeDetail(detailsMap, anime);
            });
        }
        return favoriteEntry.results;
    }

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
    const commentCount = Array.isArray(cached.comments) ? cached.comments.length : 0;
    const minCount = Math.max(0, globals.commentCacheMinCount || 0);

    if (minCount > 0 && commentCount < minCount) {
        globals.commentCache.delete(videoUrl);
        log("info", `[cache] Comment cache for "${videoUrl}" has only ${commentCount} comments (minimum ${minCount}), refreshing`);
        return false;
    }

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

// 清理计数器时也要保留仍被索引或详情引用的 ID 上界。
export function getEpisodeIdFloor() {
    let maxId = 10001;
    const include = episode => {
        if (Number.isSafeInteger(episode?.id) && episode.id >= 0) maxId = Math.max(maxId, episode.id);
    };
    const includeDetails = details => {
        if (!Array.isArray(details)) return;
        for (const anime of details) {
            if (Array.isArray(anime?.links)) anime.links.forEach(include);
        }
    };
    globals.episodeIds.forEach(include);
    includeDetails(globals.animes);
    if (globals.favoriteCache instanceof Map) {
        for (const cached of globals.favoriteCache.values()) includeDetails(cached?.details);
    }
    const now = Date.now();
    if (globals.searchCache instanceof Map) {
        for (const cached of globals.searchCache.values()) {
            if ((now - cached?.timestamp) / 60000 > globals.searchCacheMinutes) continue;
            includeDetails(cached?.details);
        }
    }
    return maxId;
}

// 对外单集调用独立校正；addAnime 的同步批次只需校正一次。
export function addEpisode(url, title) {
    globals.episodeNum = Math.max(globals.episodeNum, getEpisodeIdFloor());
    return allocateEpisode(url, title);
}

// 添加元素到 episodeIds：检查 url 是否存在，若不存在则以自增 id 添加
function allocateEpisode(url, title) {
    // 检查是否已存在相同的 url 和 title
    const existingEpisode = globals.episodeIds.find(episode => episode.url === url && episode.title === title);
    if (existingEpisode) {
        if (!Number.isSafeInteger(existingEpisode.id) || existingEpisode.id < 0
          || globals.episodeIds.some(episode => episode.id === existingEpisode.id && episode.url !== url)) {
            throw new Error('剧集 ID 映射无效，请清理剧集缓存后重试');
        }
        log("info", `[cache] Episode with URL ${url} and title ${title} already exists in episodeIds, returning existing episode.`);
        return existingEpisode; // 返回已存在的 episode
    }

    const nextId = globals.episodeNum + 1;
    if (!Number.isSafeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER) throw new Error('剧集 ID 超出安全范围，请清理剧集缓存后重试');
    globals.episodeNum = nextId;
    const newEpisode = { id: nextId, url: url, title: title };

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

// addAnime 失败时除日志外，把可操作原因记录在请求级 detailStore 上（Map 对象上的自有属性，
// 不是 Map 条目，因此不会被 collectUniqueAnimeDetails 收进全局搜索缓存），供响应层提示用户。
export function getAddAnimeError(detailStore) {
    return detailStore instanceof Map ? (detailStore.__addAnimeError || '') : '';
}

// 逐源隔离的详情存储也要把失败原因合并到请求级存储；先到先得，只保留第一条。
export function mergeAddAnimeError(target, source) {
    if (source instanceof Map && target instanceof Map && !getAddAnimeError(target)) {
        const message = getAddAnimeError(source);
        if (message) target.__addAnimeError = message;
    }
    return target;
}

// 添加 anime 对象到 animes，并将其 links 添加到 episodeIds
export function addAnime(anime, detailStore = null) {
    anime = Anime.fromJson(anime);
    const previousEpisodeCount = globals.episodeIds.length;
    let previousEpisodeNum = globals.episodeNum;
    let allocationComplete = false;
    try {
        // 确保 anime 有 links 属性且是数组
        if (!anime.links || !Array.isArray(anime.links)) {
            log("error", `[cache] Invalid or missing links in anime: ${JSON.stringify(anime)}`);
            return false;
        }

        globals.episodeNum = Math.max(globals.episodeNum, getEpisodeIdFloor());
        previousEpisodeNum = globals.episodeNum; // 分配失败不能回退到既有引用上界以下。
        // 同步批次内部自增，避免每集重复扫描全部引用。
        const newLinks = [];
        anime.links.forEach(link => {
            if (link.url) {
                const episode = allocateEpisode(link.url, link.title);
                if (episode) {
                    newLinks.push(episode); // 仅添加成功添加的 episode
                }
            } else {
                log("error", `[cache] Invalid link in anime, missing url: ${JSON.stringify(link)}`);
            }
        });

        // 创建新的 anime 副本
        const animeCopy = Anime.fromJson({ ...anime, links: newLinks });
        allocationComplete = true;

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

        return true;
    } catch (error) {
        if (!allocationComplete) {
            // 分配过程同步执行，尚未发布详情；只回滚本次追加的 ID，保留既有映射。
            globals.episodeIds.length = previousEpisodeCount;
            globals.episodeNum = previousEpisodeNum;
        }
        log("error", `[cache] addAnime failed: ${error.message}`);
        if (detailStore instanceof Map) detailStore.__addAnimeError = error.message;
        return false;
    } finally {
        // 诊断日志只用于排查，不能反过来把已经写入成功的 anime 判成失败：
        // 外部恢复的历史快照里可能残留 links 为 null 的条目，序列化会抛错。
        try {
            log("info", `[cache] animes: ${JSON.stringify(
              globals.animes.map(anime => ({
                links: anime.links,
                animeId: anime.animeId,
                bangumiId: anime.bangumiId,
                animeTitle: anime.animeTitle
              })),
              (key, value) => key === "links" ? (Array.isArray(value) ? value.length : 0) : value
            )}`);
        } catch (error) {
            log("warn", `[cache] animes 诊断序列化失败: ${error.message}`);
        }
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

    // 保存旧的 prefer/source/offsets/explicitBySeason（兼容旧结构）
    const oldPrefer = oldValue?.prefer;
    const oldSource = oldValue?.source;
    const oldPreferBySeason = oldValue?.preferBySeason;
    const oldSourceBySeason = oldValue?.sourceBySeason;
    const oldOffsets = oldValue?.offsets;
    const oldExplicitBySeason = oldValue?.explicitBySeason;

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
        ...(oldOffsets !== undefined && { offsets: oldOffsets }),
        ...(oldExplicitBySeason !== undefined && { explicitBySeason: { ...oldExplicitBySeason } })
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
      value.explicitBySeason = value.explicitBySeason || {};
      value.explicitBySeason[seasonKey] = true;
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

export function setPreferForTitle(title, animeId, source, season = null, offset = null) {
  const key = String(title || '').trim();
  if (!key || animeId === null || animeId === undefined) return null;

  const oldValue = globals.lastSelectMap.get(key) || {};
  const animeIds = new Set(Array.isArray(oldValue.animeIds) ? oldValue.animeIds : []);
  animeIds.add(animeId);
  const seasonKey = season === null ? 'default' : String(season);
  const preferBySeason = { ...(oldValue.preferBySeason || {}), [seasonKey]: animeId };
  const sourceBySeason = { ...(oldValue.sourceBySeason || {}), [seasonKey]: source };
  const explicitBySeason = { ...(oldValue.explicitBySeason || {}), [seasonKey]: true };
  const offsets = { ...(oldValue.offsets || {}) };
  if (season !== null && offset !== null) offsets[seasonKey] = offset;

  if (globals.lastSelectMap.has(key)) globals.lastSelectMap.delete(key);
  globals.lastSelectMap.set(key, {
    animeIds: [...animeIds],
    preferBySeason,
    sourceBySeason,
    explicitBySeason,
    ...(Object.keys(offsets).length > 0 && { offsets })
  });

  if (globals.lastSelectMap.size > globals.MAX_LAST_SELECT_MAP) {
    globals.lastSelectMap.delete(globals.lastSelectMap.keys().next().value);
  }
  return key;
}

export function hasSeasonSpecificPreference(title, season) {
  if (season === null || season === undefined) return false;
  const value = globals.lastSelectMap.get(String(title || '').trim());
  if (!value) return false;
  const seasonKey = String(season);
  return value.explicitBySeason?.[seasonKey] === true;
}

export function hasLegacySeasonPreference(title, season) {
  if (season === null || season === undefined) return false;
  const value = globals.lastSelectMap.get(String(title || '').trim());
  if (!value) return false;
  const seasonKey = String(season);
  const hasOwn = object => object && Object.prototype.hasOwnProperty.call(object, seasonKey);
  const hasRecord = hasOwn(value.preferBySeason) || hasOwn(value.sourceBySeason) || hasOwn(value.offsets);
  return Boolean(hasRecord && value.explicitBySeason?.[seasonKey] !== true);
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

export const queryCacheKeys = [
  'animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum'
];

// 业务可以降级到内存；未成功读取的后端在本进程内保持只读，避免覆盖未知快照。
export function canPersistCacheKey(key, backend) {
  if (key === 'favoriteCache' || key === 'favoritesCache') return globals.favoriteCacheWritable[backend] !== false;
  return !queryCacheKeys.includes(key)
    || (globals.queryCacheInitialized && globals.queryCacheWritable[backend] === true);
}

// 只在启动时选择一次内存快照；各后端仍独立确认自身数据与写入资格。
export async function restoreQueryCache(backend, read, hashes, restored = {}, isCurrent = () => true) {
  if (globals.queryCacheWritable[backend] !== undefined) return;
  globals.queryCacheWritable[backend] = false;
  const values = await read(queryCacheKeys);
  if (!isCurrent()) throw new Error('缓存连接已切换');
  if (!Array.isArray(values) || values.length !== queryCacheKeys.length) {
    throw new Error('查询缓存响应不完整');
  }
  let damaged = false;
  const snapshot = values.map((raw, index) => {
    const key = queryCacheKeys[index];
    try {
      if (raw instanceof Error) throw raw;
      if (raw === null) return { key };
      if (typeof raw !== 'string') throw new Error('响应无效');
      const value = JSON.parse(raw);
      const valid = ['animes', 'episodeIds', 'reqRecords'].includes(key)
        ? Array.isArray(value)
        : ['episodeNum', 'todayReqNum'].includes(key)
          ? Number.isSafeInteger(value) && value >= 0 && (key !== 'episodeNum' || value < Number.MAX_SAFE_INTEGER)
          : value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!valid) throw new Error('数据类型无效');
      return { key, value, hash: simpleHash(raw) };
    } catch (error) {
      if (backend !== 'file') throw error;
      // 先保留原文件，备份失败则不允许写回这个后端。
      if (!backupQueryCacheFile(key)) throw new Error(`无法备份损坏缓存 ${key}`);
      damaged ||= ['animes', 'episodeIds', 'episodeNum'].includes(key);
      log('warn', `[cache] ${key} 损坏，已保留备份并跳过: ${error.message}`);
      return { key };
    }
  });
  const data = Object.fromEntries(snapshot.filter(item => item.value !== undefined).map(item => [item.key, item.value]));
  // 已知计数器和 ID 上界跨后端取最大值，不能随快照优先级回退。
  let maxId = Math.max(10001, globals.episodeNum, data.episodeNum || 0);
  const links = (data.animes || []).flatMap(anime => Array.isArray(anime?.links) ? anime.links : []);
  for (const episode of [...(data.episodeIds || []), ...links]) {
    if (Number.isSafeInteger(episode?.id)) maxId = Math.max(maxId, episode.id);
  }
  // 同一快照内也可能有部分写入；冲突映射不能拼接，更不能写回其他后端。
  const episodes = new Map();
  for (const episode of [...(data.episodeIds || []), ...links]) {
    if (!Number.isSafeInteger(episode?.id) || episode.id < 0 || episode.id >= Number.MAX_SAFE_INTEGER || typeof episode.url !== 'string'
      || (episodes.has(episode.id) && episodes.get(episode.id).url !== episode.url)) {
      log('warn', `[cache] ${backend} 剧集 ID 映射无效或冲突，已保留该后端，尝试其他快照`);
      return;
    }
    episodes.set(episode.id, episode);
  }
  // 校验整个后端后才提交计数器和 hash；无效快照不能先污染全局状态。
  globals.episodeNum = maxId;
  restored.idFloorKnown ||= data.episodeNum !== undefined || episodes.size > 0;
  restored.damagedIds ||= damaged;
  for (const { key, hash } of snapshot) {
    delete hashes[key];
    if (hash !== undefined) hashes[key] = hash;
  }
  globals.queryCacheWritable[backend] = true;
  if (globals.queryCacheInitialized) return;
  // 有详情和链接的快照优先于只有索引/残缺详情的快照；不跨后端拼接这两个关联键。
  const rank = data.animes?.length && links.length ? 2 : data.animes?.length || episodes.size ? 1 : 0;
  if (rank > (restored.episodes || 0)) {
    globals.animes = data.animes || [];
    globals.episodeIds = [...episodes.values()];
    restored.episodes = rank;
  }
  // 偏好和辅助记录可分别回退；空数组/对象和计数器本身不抢占整组恢复。
  for (const key of ['lastSelectMap', 'reqRecords', 'todayReqNum']) {
    const value = data[key];
    const hasData = key === 'lastSelectMap' ? value && Object.keys(value).length > 0
      : key === 'reqRecords' ? value?.length > 0 : value > 0;
    if (!restored[key] && hasData) {
      globals[key] = key === 'lastSelectMap' ? new Map(Object.entries(value)) : value;
      restored[key] = true;
    }
  }
}

const backedUpCacheFiles = new Set();
const backupRetryAfter = new Map();
let cacheFileSequence = 0;
function backupQueryCacheFile(key) {
  const cacheFilePath = path.join(getDirname(), '..', '..', '.cache', key);
  if (backedUpCacheFiles.has(cacheFilePath) || !fs.existsSync(cacheFilePath)) return true;
  if (Date.now() < (backupRetryAfter.get(cacheFilePath) || 0)) return false;
  const backup = `${cacheFilePath}.bak-${Date.now()}-${process.pid}-${++cacheFileSequence}`;
  const temporary = `${backup}.tmp`;
  try {
    fs.copyFileSync(cacheFilePath, temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, backup);
    // 只轮换程序生成的备份；新备份确认成功后才删除旧文件，跨重启最多保留两份。
    const directory = path.dirname(cacheFilePath);
    const backups = fs.readdirSync(directory)
      .filter(name => name.startsWith(`${key}.bak-`) && /^\d+-\d+(?:-\d+)?$/.test(name.slice(`${key}.bak-`.length)))
      .map(name => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const old of backups.slice(2)) fs.unlinkSync(path.join(directory, old.name));
    backedUpCacheFiles.add(cacheFilePath);
    backupRetryAfter.delete(cacheFilePath);
    if (backedUpCacheFiles.size === 1) log('info', `[cache] 已保留覆盖前的查询缓存: ${backup}`);
    return true;
  } catch (error) {
    // 不放行覆盖；短暂磁盘故障冷却后可重试，不随每次请求重复打印堆栈。
    for (const target of [temporary, backup]) {
      try { fs.unlinkSync(target); } catch {}
    }
    backupRetryAfter.set(cacheFilePath, Date.now() + 30000);
    log('warn', `[cache] ${key} 备份失败，30 秒后重试，原文件保持不变: ${error.message}`);
    return false;
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
  try {
    const fileContent = fs.readFileSync(cacheFilePath, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 将缓存数据写入本地缓存文件
export function writeCacheToFile(key, value, { force = false } = {}) {
  if (globals.localCacheEnabled === false || (!force && !canPersistCacheKey(key, 'file'))) return false;
  const cacheFilePath = path.join(getDirname(), '..', '..', '.cache', `${key}`);
  if (queryCacheKeys.includes(key) && !backupQueryCacheFile(key)) return false;
  const temporaryPath = `${cacheFilePath}.tmp-${process.pid}-${++cacheFileSequence}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, cacheFilePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return true;
}

// 从本地获取缓存
export async function getLocalCaches(restored = {}) {
  if (globals.localCacheEnabled === false) return true;
  let success = true;
  try {
    await loadFileCacheModules();
    await restoreQueryCache('file', keys => keys.map(key => {
      try {
        const raw = readCacheFromFile(key);
        return raw == null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (error) {
        return error;
      }
    }), globals.localFileHashes, restored);
  } catch (error) {
    log('error', `[cache] 查询缓存恢复失败: ${error.message}`);
    success = false;
  }
  if (!globals.localCacheInitialized) {
    globals.favoriteCacheWritable.file = false;
    try {
      await loadFileCacheModules();
      const raw = readCacheFromFile('favoritesCache');
      if (raw !== null) {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('收藏缓存数据类型无效');
        loadFavorites(value);
        globals.localFileHashes.favoriteCache = simpleHash(JSON.stringify(saveFavorites()));
      }
      globals.favoriteCacheWritable.file = true;
    } catch (error) {
      log('error', `[cache] 收藏缓存恢复失败，暂停文件收藏写入至重启: ${error.message}`);
      success = false;
    } finally {
      globals.localCacheInitialized = true;
    }
  }
  return success;
}

// 更新本地缓存
export async function updateLocalCaches({ keys, force = false } = {}) {
  if (globals.localCacheEnabled === false) return true;
  try {
    await loadFileCacheModules();
    log("info", '[cache] updateLocalCaches start.');
    const updates = [];
    let saved = true;

    // 检查每个变量的哈希值
    const variables = [
      { key: 'animes', value: globals.animes },
      { key: 'episodeIds', value: globals.episodeIds },
      { key: 'episodeNum', value: globals.episodeNum },
      { key: 'reqRecords', value: globals.reqRecords },
      { key: 'lastSelectMap', value: globals.lastSelectMap },
      { key: 'todayReqNum', value: globals.todayReqNum },
      { key: 'favoritesCache', value: globals.favoriteCache }
    ];

    for (const { key, value } of variables) {
      if (keys && !keys.includes(key)) continue;
      if (!force && !canPersistCacheKey(key, 'file')) { saved = false; continue; }
      // 对于 lastSelectMap（Map 对象），需要转换为普通对象后再序列化
      const serializedValue = key === 'lastSelectMap'
        ? JSON.stringify(Object.fromEntries(value))
        : key === 'favoritesCache'
          ? JSON.stringify(saveFavorites())
          : JSON.stringify(value);
      const currentHash = simpleHash(serializedValue);
      const hashKey = key === 'favoritesCache' ? 'favoriteCache' : key;
      if (force || currentHash !== globals.localFileHashes[hashKey]) {
        if (!writeCacheToFile(key, serializedValue, { force })) { saved = false; continue; }
        globals.localFileHashes[hashKey] = currentHash;
        updates.push({ key });
      }
    }

    // 输出更新日志
    if (updates.length > 0) {
      log("info", `[cache] Updated local caches for keys: ${updates.map(u => u.key).join(', ')}`);
    } else {
      log("info", '[cache] No changes detected, skipping local cache update.');
    }

    return saved;
  } catch (error) {
    log("error", `[cache] updateLocalCaches failed: ${error.message}`, error.stack);
    log("error", `[cache] Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
    return false;
  }
}

// 判断是否有效的本地缓存目录
export async function judgeLocalCacheValid(urlPath, deployPlatform) {
  if (globals.localCacheEnabled === false) {
    globals.localCacheValid = false;
    return;
  }
  if (deployPlatform === 'node') {
    try {
      await loadFileCacheModules();

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
