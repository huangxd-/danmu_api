import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { simpleHash, serializeValue } from "./codec-util.js";
import { queryCacheKeys, canPersistCacheKey, restoreQueryCache } from "./cache-util.js";

// =====================
// 本地 Redis 读写请求
// =====================

// 并发请求共享连接；失败实例不能阻止同进程的后续重连。
let localRedisClient = null;
let connecting = null;
let initializing = null;
let retryAfter = 0;
let connectionUrl = null;

async function createLocalRedisClient() {
  if (connectionUrl !== globals.localRedisUrl) {
    if (localRedisClient?.isOpen) localRedisClient.destroy();
    localRedisClient = null;
    if (connectionUrl !== null) {
      delete globals.queryCacheWritable.localRedis;
      globals.localRedisHashes = {};
      globals.localRedisCacheInitialized = false;
    }
    connectionUrl = globals.localRedisUrl;
    retryAfter = 0;
  }
  if (localRedisClient?.isReady) return localRedisClient;
  if (connecting) return connecting;
  if (Date.now() < retryAfter) return null;
  connecting = (async () => {
    let client;
    let timeout;
    try {
      if (localRedisClient?.isOpen) localRedisClient.destroy();
      localRedisClient = null;
      const { createClient } = await import('redis');
      client = createClient({
        url: globals.localRedisUrl,
        socket: { connectTimeout: 5000, reconnectStrategy: false },
        disableOfflineQueue: true,
        commandOptions: { timeout: 5000 }
      });
      client.on('error', error => {
        if (localRedisClient === client) globals.localRedisValid = false;
        log('error', `[system] [Local-Redis] 连接错误: ${error.message}`);
      });
      // connectTimeout 只覆盖 TCP 建连；握手不响应也必须在同一预算内退出。
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('本地 Redis 连接或握手超时')), 5000);
        })
      ]);
      localRedisClient = client;
      globals.localRedisValid = true;
      retryAfter = 0;
      return client;
    } catch (error) {
      if (client?.isOpen) client.destroy();
      globals.localRedisValid = false;
      retryAfter = Date.now() + 30000;
      log('error', `[system] [Local-Redis] 初始化失败: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function checkLocalRedisConnection() {
  return localRedisClient?.isReady === true;
}

// commandOptions.timeout 不覆盖命令发出后等待响应；超时要关闭原连接，释放全部在途命令。
async function withLocalRedisTimeout(client, command, timeoutMs = 30000) {
  let timeout;
  try {
    return await Promise.race([
      command,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          if (localRedisClient === client) {
            localRedisClient = null;
            globals.localRedisValid = false;
            retryAfter = Date.now() + 30000;
          }
          reject(new Error('本地 Redis 命令响应超时'));
          if (client.isOpen) client.destroy();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// 获取本地 Redis 键值
export async function getLocalRedisKey(key) {
  try {
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const result = await withLocalRedisTimeout(localRedisClient, localRedisClient.get(key));
    return result;
  } catch (error) {
    log("error", `[system] [Local-Redis] GET 请求失败:`, error.message);
    throw error;
  }
}

// 设置本地 Redis 键值
export async function setLocalRedisKey(key, value, { force = false, timeoutMs } = {}) {
  if (!force && !canPersistCacheKey(key, 'localRedis')) return { result: 'ERROR' };
  const serializedValue = serializeValue(key, value);
  return setSerializedLocalRedisKey(key, serializedValue, simpleHash(serializedValue), { force, timeoutMs });
}

// 批量更新复用同一份序列化快照和 hash，收到成功响应后才确认保存。
async function setSerializedLocalRedisKey(key, serializedValue, currentHash, { force = false, timeoutMs } = {}) {
  if (!force && !canPersistCacheKey(key, 'localRedis')) return { result: 'ERROR' };
  // 检查值是否变化
  if (!force && globals.localRedisHashes[key] === currentHash) {
    log("info", `[system] [Local-Redis] 键 ${key} 无变化，跳过 SET 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  try {
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const result = await withLocalRedisTimeout(localRedisClient, localRedisClient.set(key, serializedValue), timeoutMs);
    if (result !== 'OK') throw new Error(`SET 未成功: ${result}`);
    globals.localRedisHashes[key] = currentHash; // 更新哈希值
    log("info", `[system] [Local-Redis] 键 ${key} 更新成功`);
    return { result };
  } catch (error) {
    log("error", `[system] [Local-Redis] SET 请求失败:`, error.message);
    return { result: "ERROR" };
  }
}

// 设置带过期时间的本地 Redis 键值
export async function setLocalRedisKeyWithExpiry(key, value, expirySeconds) {
  if (!canPersistCacheKey(key, 'localRedis')) return { result: 'ERROR' };
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.localRedisHashes[key] === currentHash) {
    log("info", `[system] [Local-Redis] 键 ${key} 无变化，跳过 SETEX 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  try {
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const result = await withLocalRedisTimeout(localRedisClient, localRedisClient.setEx(key, expirySeconds, serializedValue));
    if (result !== 'OK') throw new Error(`SETEX 未成功: ${result}`);
    globals.localRedisHashes[key] = currentHash; // 更新哈希值
    log("info", `[system] [Local-Redis] 键 ${key} 更新成功（带过期时间 ${expirySeconds}s）`);
    return { result };
  } catch (error) {
    log("error", `[system] [Local-Redis] SETEX 请求失败:`, error.message);
    return { result: "ERROR" };
  }
}

// 优化后的 getLocalRedisCaches，批量获取所有键
export async function getLocalRedisCaches(restored = {}) {
  if (globals.localRedisCacheInitialized) return true;
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      await restoreQueryCache('localRedis', async keys => {
        const client = await createLocalRedisClient();
        if (!client) throw new Error('本地 Redis 客户端未就绪');
        // GET 异常不能当成键不存在，也不能更新任何恢复状态。
        return withLocalRedisTimeout(client, Promise.all(keys.map(key => client.get(key))), 5000);
      }, globals.localRedisHashes, restored);
      globals.localRedisCacheInitialized = true;
      return true;
    } catch (error) {
      log('error', `[system] [Local-Redis] 恢复失败，保留远端查询数据至下次启动: ${error.message}`);
      return false;
    }
  })();
  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

// 优化后的 updateLocalRedisCaches，仅更新有变化的变量
export async function updateLocalRedisCaches({ keys, force = false, timeoutMs } = {}) {
  if (!force && !canPersistCacheKey('animes', 'localRedis')) return false;
  const started = performance.now();
  try {
    log("info", '[system] [Local-Redis] updateLocalRedisCaches start.');
    
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const updates = [];

    // 检查每个变量的哈希值
    const variables = queryCacheKeys.filter(key => !keys || keys.includes(key)).map(key => ({ key, value: globals[key] }));

    for (const { key, value } of variables) {
      // 对于 lastSelectMap（Map 对象），需要转换为普通对象后再序列化
      const serializedValue = serializeValue(key, value);
      const currentHash = simpleHash(serializedValue);
      if (force || currentHash !== globals.localRedisHashes[key]) {
        updates.push({ key, serializedValue, hash: currentHash });
      }
    }

    // 如果有需要更新的键，执行批量更新
    if (updates.length > 0) {
      log("info", `[system] [Local-Redis] Updating ${updates.length} changed keys: ${updates.map(u => u.key).join(', ')}`);

      const promises = updates.map(async ({ key, serializedValue, hash }) => {
        // 清理路径的短预算包含已消耗的连接时间；正常业务仍沿用默认命令超时。
        const remaining = timeoutMs === undefined ? undefined : timeoutMs - (performance.now() - started);
        if (remaining <= 0) return { result: 'ERROR' };
        return setSerializedLocalRedisKey(key, serializedValue, hash, { force, timeoutMs: remaining });
      });

      const results = await Promise.all(promises);

      // 检查每个操作的结果
      let successCount = 0;
      let failureCount = 0;

      results.forEach((result, index) => {
        if (result && result.result === 'OK') {
          successCount++;
        } else {
          failureCount++;
          log("warn", `[system] [Local-Redis] Failed to update Local Redis key: ${updates[index]?.key}, result: ${JSON.stringify(result)}`);
        }
      });

      // 每个成功键的哈希已由 setLocalRedisKey 更新，失败键保留原状态以便重试。
      if (failureCount === 0) {
        log("info", `[system] [Local-Redis] Local Redis update completed successfully: ${successCount} keys updated`);
      } else {
        log("warn", `[system] [Local-Redis] Local Redis update partially failed: ${successCount} succeeded, ${failureCount} failed`);
      }
      return failureCount === 0;
    } else {
      log("info", '[system] [Local-Redis] No changes detected, skipping Local Redis update.');
      return true;
    }
  } catch (error) {
    log("error", `[system] [Local-Redis] updateLocalRedisCaches failed: ${error.message}`, error.stack);
    log("error", `[system] [Local-Redis] Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
    return false;
  }
}

// 判断本地 Redis 是否可用
export async function judgeLocalRedisValid(path) {
  if (globals.localRedisUrl && path !== '/favicon.ico' && path !== '/robots.txt') {
    globals.localRedisValid = Boolean(await createLocalRedisClient());
  }
}

// 关闭连接不清空已恢复标记，临时断线后不能用旧快照覆盖当前内存。
export async function closeLocalRedisConnection() {
  const client = localRedisClient;
  localRedisClient = null;
  globals.localRedisValid = false;
  retryAfter = 0;
  if (client?.isReady) await client.quit();
  else if (client?.isOpen) client.destroy();
}
