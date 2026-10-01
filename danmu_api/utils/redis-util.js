import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { simpleHash, serializeValue } from "./codec-util.js";
import { loadFavorites } from './favorite-util.js';
import { queryCacheKeys, canPersistCacheKey, restoreQueryCache, getLocalCaches, judgeLocalCacheValid } from './cache-util.js';

let initializing = null;
let persistentCachesInitializing = null;
let redisRetryAfter = 0;
let redisConnectionKey = null;
let redisConnectionVersion = 0;
let replaceMissingFavorites = false;

const currentRedisConnectionKey = () => globals.redisUrl && globals.redisToken
  ? JSON.stringify([globals.redisUrl, globals.redisToken]) : null;
const isCurrentConnection = (version, key) => version === redisConnectionVersion && key === currentRedisConnectionKey();

function resetRedisConnection() {
  globals.redisValid = false;
  delete globals.queryCacheWritable.upstash;
  globals.redisCacheInitialized = false;
  globals.favoriteCacheWritable.upstash = false;
  globals.upstashHashes = {};
  initializing = persistentCachesInitializing = null;
  replaceMissingFavorites = true;
}

function restoreRedisFavorites(raw) {
  if (raw !== null) {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('收藏缓存数据类型无效');
    loadFavorites(value);
    globals.upstashHashes.favoriteCache = simpleHash(serializeValue('favoriteCache', globals.favoriteCache));
  } else if (replaceMissingFavorites) {
    // 首次启动仍允许文件收藏回退；切换目标库后不能把旧库收藏带过去。
    loadFavorites({});
  }
  replaceMissingFavorites = false;
  globals.favoriteCacheWritable.upstash = true;
}

// 初始化单独使用短超时；业务请求也有总时限，大弹幕资源允许更长传输时间。
const requestTimeout = key => String(key).startsWith('localDanmu:') ? 60000 : 30000;

// =====================
// upstash redis 读写请求 （先简单实现，不加锁）
// =====================

// 使用 GET 发送简单命令（如 PING 检查连接）
export async function pingRedis() {
  const url = `${globals.redisUrl}/ping`;
  log("info", `[system] [redis] 开始发送 PING 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["PONG"]
  } catch (error) {
    log("error", `[system] [redis] 请求失败:`, error.message);
    log("error", '- [system] [redis] 错误类型:', error.name);
    if (error.cause) {
      log("error", '- [system] [redis] 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- [system] [redis] 原因:', error.cause.message);
    }
  }
}

// 使用 GET 发送 GET 命令（读取键值）
export async function getRedisKey(key) {
  const url = `${globals.redisUrl}/get/${key}`;
  log("info", `[system] [redis] 开始发送 GET 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(requestTimeout(key)),
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["value"] 或 null
  } catch (error) {
    log("error", `[system] [redis] 请求失败:`, error.message);
    log("error", '- [system] [redis] 错误类型:', error.name);
    if (error.cause) {
      log("error", '- [system] [redis] 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- [system] [redis] 原因:', error.cause.message);
    }
  }
}

// 使用 POST 发送 SET 命令，仅在值变化时更新
export async function setRedisKey(key, value) {
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  if (!canPersistCacheKey(key, 'upstash')) return { result: 'ERROR' };
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.upstashHashes[key] === currentHash) {
    log("info", `[system] [redis] 键 ${key} 无变化，跳过 SET 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}`;
  log("info", `[system] [redis] 开始发送 SET 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeout(key)),
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    if (!response.ok || result?.result !== 'OK') throw new Error(`SET 未成功: ${JSON.stringify(result)}`);
    if (!isCurrentConnection(version, connectionKey)) throw new Error('Redis 连接已切换');
    globals.upstashHashes[key] = currentHash;
    log("info", `[system] [redis] 键 ${key} 更新成功`);
    return result; // 预期: ["OK"]
  } catch (error) {
    log("error", `[system] [redis] SET 请求失败:`, error.message);
    log("error", '- [system] [redis] 错误类型:', error.name);
    if (error.cause) {
      log("error", '- [system] [redis] 码:', error.cause.code);
      log("error", '- [system] [redis] 原因:', error.cause.message);
    }
    return { result: 'ERROR' };
  }
}

// 使用 POST 发送 SETEX 命令，仅在值变化时更新
export async function setRedisKeyWithExpiry(key, value, expirySeconds) {
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  if (!canPersistCacheKey(key, 'upstash')) return { result: 'ERROR' };
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.upstashHashes[key] === currentHash) {
    log("info", `[system] [redis] 键 ${key} 无变化，跳过 SETEX 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}?EX=${expirySeconds}`;
  log("info", `[system] [redis] 开始发送 SETEX 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeout(key)),
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    if (!response.ok || result?.result !== 'OK') throw new Error(`SETEX 未成功: ${JSON.stringify(result)}`);
    if (!isCurrentConnection(version, connectionKey)) throw new Error('Redis 连接已切换');
    globals.upstashHashes[key] = currentHash;
    log("info", `[system] [redis] 键 ${key} 更新成功（带过期时间 ${expirySeconds}s）`);
    return result;
  } catch (error) {
    log("error", `[system] [redis] SETEX 请求失败:`, error.message);
    log("error", '- [system] [redis] 错误类型:', error.name);
    if (error.cause) {
      log("error", '- [system] [redis] 码:', error.cause.code);
      log("error", '- [system] [redis] 原因:', error.cause.message);
    }
    return { result: 'ERROR' };
  }
}

// 通用的 pipeline 请求函数
export async function runPipeline(commands, { timeoutMs = Math.max(30000, ...commands.map(([, key]) => requestTimeout(key))) } = {}) {
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  const url = `${globals.redisUrl}/pipeline`;
  log("info", `[system] [redis] 开始发送 PIPELINE 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands) // commands 是一个数组，包含多个 Redis 命令
    });
    if (!response.ok) throw new Error(`Pipeline HTTP ${response.status}`);
    const result = await response.json();
    if (!isCurrentConnection(version, connectionKey)) throw new Error('Redis 连接已切换');
    return result; // 返回结果数组，按命令顺序
  } catch (error) {
    log("error", `[system] [redis] Pipeline 请求失败:`, error.message);
    log("error", '- [system] [redis] 错误类型:', error.name);
    if (error.cause) {
      log("error", '- [system] [redis] 码:', error.cause.code);
      log("error", '- [system] [redis] 原因:', error.cause.message);
    }
  }
}

// 查询数据优先恢复 Local Redis；文件和 Upstash 的收藏仍按原顺序加载。
export async function initializePersistentCaches(deployPlatform) {
  if (persistentCachesInitializing) return persistentCachesInitializing;
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  const pending = persistentCachesInitializing = (async () => {
    const restored = {}; // 仅在本次串行恢复中共享，不保留为进程全局状态。
    globals.deployPlatform = deployPlatform;
    if (deployPlatform === 'node' && globals.localRedisUrl) {
      const { getLocalRedisCaches } = await import('./local-redis-util.js');
      await getLocalRedisCaches(restored);
      if (!isCurrentConnection(version, connectionKey)) return false;
    }
    if (globals.redisValid) await getRedisCaches({ queriesOnly: true, restored });
    else if (globals.redisUrl && globals.redisToken && globals.queryCacheWritable.upstash === undefined) globals.queryCacheWritable.upstash = false;
    if (!isCurrentConnection(version, connectionKey)) return false;
    if (deployPlatform === 'node') {
      await judgeLocalCacheValid('/api/v2/favorite/list', deployPlatform);
      if (globals.localCacheValid) await getLocalCaches(restored);
      else globals.localCacheInitialized = true;
    }
    if (!isCurrentConnection(version, connectionKey)) return false;
    if (!globals.queryCacheInitialized) {
      globals.queryCacheInitialized = true;
      if (!restored.idFloorKnown && (restored.damagedIds || Object.values(globals.queryCacheWritable).includes(false))) {
        // 所有后端均未提供有效计数器或 ID 时才兜底，避免损坏副本抬高健康快照的编号。
        globals.episodeNum = Math.max(globals.episodeNum, Date.now());
        log('warn', '[cache] 持久化恢复不完整，使用进程内存；失败后端的查询数据写入暂停至重启');
      }
    }
    if (globals.redisValid) await getRedisCaches();
    return isCurrentConnection(version, connectionKey) && globals.queryCacheInitialized;
  })();
  try {
    return await pending;
  } finally {
    if (persistentCachesInitializing === pending) persistentCachesInitializing = null;
  }
}

// 查询数据从选定后端恢复；收藏保留原有的单次初始化。
export async function getRedisCaches({ queriesOnly = false, restored = {} } = {}) {
  if (initializing) return initializing;
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  const pending = initializing = (async () => {
    let success = true;
    try {
      await restoreQueryCache('upstash', async keys => {
        const results = await runPipeline(keys.map(key => ['GET', key]), { timeoutMs: 5000 });
        if (!isCurrentConnection(version, connectionKey)) throw new Error('Redis 连接已切换');
        const values = readPipelineValues(results, keys.length);
        globals.redisValid = true;
        return values;
      }, globals.upstashHashes, restored, () => isCurrentConnection(version, connectionKey));
    } catch (error) {
      log('error', `[system] [redis] 查询缓存恢复失败: ${error.message}`);
      success = false;
    }
    if (!isCurrentConnection(version, connectionKey)) return false;
    if (queriesOnly) return success;
    if (!globals.redisCacheInitialized) {
      globals.favoriteCacheWritable.upstash = false;
      try {
        const results = await runPipeline([['GET', 'favoriteCache']], { timeoutMs: 5000 });
        if (!isCurrentConnection(version, connectionKey)) return false;
        const [raw] = readPipelineValues(results, 1);
        restoreRedisFavorites(raw);
      } catch (error) {
        log('error', `[system] [redis] 收藏恢复失败，暂停该后端收藏写入至重启: ${error.message}`);
        success = false;
      } finally {
        if (isCurrentConnection(version, connectionKey)) globals.redisCacheInitialized = true;
      }
    }
    return success;
  })();
  try {
    return await pending;
  } finally {
    if (initializing === pending) initializing = null;
  }
}

function readPipelineValues(results, count) {
  if (!Array.isArray(results) || results.length !== count) throw new Error('Redis GET 响应不完整');
  return results.map(result => {
    if (!result || result.error || !Object.prototype.hasOwnProperty.call(result, 'result')) {
      throw new Error('Redis GET 失败');
    }
    return result.result;
  });
}

// serverless 多实例场景下单独刷新收藏缓存。
// Redis 中的收藏是跨实例的持久数据，但实例内存中的 favoriteCache 只在首次初始化时加载，
// 预热实例可能错过其他实例新增的收藏，这里在收藏相关请求时直接从 Redis 重新读取。
export async function getFavoriteCachesFromRedis() {
  if (!globals.redisValid) return false;
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  try {
    const results = await runPipeline([['GET', 'favoriteCache']]);
    if (!isCurrentConnection(version, connectionKey)) return false;
    const [raw] = readPipelineValues(results, 1);
    restoreRedisFavorites(raw);
    return true;
  } catch (error) {
    if (isCurrentConnection(version, connectionKey)) globals.favoriteCacheWritable.upstash = false;
    log("error", `[system] [redis] getFavoriteCachesFromRedis failed: ${error.message}`);
    return false;
  }
}

// 优化后的 updateRedisCaches，仅更新有变化的变量
export async function updateRedisCaches({ keys, force = false, timeoutMs } = {}) {
  const version = redisConnectionVersion;
  const connectionKey = currentRedisConnectionKey();
  try {
    log("info", '[system] [redis] updateCaches start.');
    const commands = [];
    const updates = [];

    // 检查每个变量的哈希值
    const variables = [...queryCacheKeys, 'favoriteCache'].filter(key => (!keys || keys.includes(key)) && (force || canPersistCacheKey(key, 'upstash'))).map(key => ({ key, value: globals[key] }));

    for (const { key, value } of variables) {
      const serializedValue = serializeValue(key, value);
      const currentHash = simpleHash(serializedValue);
      if (force || currentHash !== globals.upstashHashes[key]) {
        commands.push(['SET', key, serializedValue]);
        updates.push({ key, hash: currentHash });
      }
    }

    // 如果有需要更新的键，执行 pipeline
    if (commands.length > 0) {
      log("info", `[system] [redis] Updating ${commands.length} changed keys: ${updates.map(u => u.key).join(', ')}`);
      const results = await runPipeline(commands, { timeoutMs });
      if (!isCurrentConnection(version, connectionKey)) return false;

      // 检查每个操作的结果
      let successCount = 0;
      let failureCount = 0;

      // 按发出的命令逐项确认，空响应、缺项和错误响应都不能标记为已保存。
      updates.forEach(({ key, hash }, index) => {
        const result = Array.isArray(results) ? results[index] : null;
        if (result?.result === 'OK' && !result.error) {
          globals.upstashHashes[key] = hash;
          successCount++;
        } else {
          failureCount++;
          log("warn", `[system] [redis] Failed to update Redis key: ${key}, result: ${JSON.stringify(result)}`);
        }
      });

      if (failureCount === 0) {
        log("info", `[system] [redis] Redis update completed successfully: ${successCount} keys updated`);
      } else {
        log("warn", `[system] [redis] Redis update partially failed: ${successCount} succeeded, ${failureCount} failed`);
      }
      return failureCount === 0;
    } else {
      log("info", '[system] [redis] No changes detected, skipping Redis update.');
      return true;
    }
  } catch (error) {
    log("error", `[system] [redis] updateRedisCaches failed: ${error.message}`, error.stack);
    log("error", `[system] [redis] Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
    return false;
  }
}

// 判断redis是否可用
export async function judgeRedisValid(path) {
  if (path === "/favicon.ico" || path === "/robots.txt") return;
  const connectionKey = currentRedisConnectionKey();
  if (redisConnectionKey !== connectionKey) {
    if (redisConnectionVersion > 0) resetRedisConnection();
    redisConnectionKey = connectionKey;
    redisConnectionVersion++;
    redisRetryAfter = 0;
  }
  if (connectionKey) {
    if (globals.redisValid || Date.now() < redisRetryAfter) return;
    const version = redisConnectionVersion;
    const res = await pingRedis();
    if (!isCurrentConnection(version, connectionKey)) return;
    if (res && res.result && res.result === "PONG") {
      globals.redisValid = true;
      redisRetryAfter = 0;
    } else {
      redisRetryAfter = Date.now() + 30000;
    }
  }
}
