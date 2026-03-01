import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { simpleHash, serializeValue } from "./codec-util.js";
import { createClient } from 'redis';

// =====================
// 本地 Redis 读写请求
// =====================

// 本地 Redis 客户端实例
let localRedisClient = null;

// 创建本地 Redis 客户端
async function createLocalRedisClient() {
  // 如果已经存在客户端实例，直接返回
  if (localRedisClient) {
    return localRedisClient;
  }

  // 从环境变量获取本地 Redis 配置，默认使用本地连接
  const localRedisUrl = globals.localRedisUrl;

  try {
    log("info", `[local-redis] 正在连接本地 Redis`);
    
    localRedisClient = createClient({
      url: localRedisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries >= 0) {
            return new Error('已达到最大重试次数，停止重连');
          }
          return 1000; // 重试间隔 ms
        }
      }
    });

    // 连接错误处理
    localRedisClient.on('error', (err) => {
      log("error", `[local-redis] 连接错误`);
      globals.localRedisValid = false;
    });

    // 连接成功处理
    localRedisClient.on('connect', () => {
      log("info", `[local-redis] 连接成功`);
    });

    await localRedisClient.connect();
    globals.localRedisValid = true;
    log("info", `[local-redis] Redis 客户端初始化完成`);
    
    return localRedisClient;
  } catch (error) {
    log("error", `[local-redis] 初始化失败:`, error.message);
    globals.localRedisValid = false;
    return null;
  }
}

// 检查本地 Redis 是否已连接且可用
async function checkLocalRedisConnection() {
  if (!localRedisClient) {
    return false;
  }

  try {
    // 发送 PING 命令检查连接状态
    const result = await localRedisClient.ping();
    return result === 'PONG';
  } catch (error) {
    log("error", `[local-redis] 连接检查失败:`, error.message);
    globals.localRedisValid = false;
    return false;
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

    const result = await localRedisClient.get(key);
    return result;
  } catch (error) {
    log("error", `[local-redis] GET 请求失败:`, error.message);
    return null;
  }
}

// 设置本地 Redis 键值
export async function setLocalRedisKey(key, value) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.lastHashes[key] === currentHash) {
    log("info", `[local-redis] 键 ${key} 无变化，跳过 SET 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  try {
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const result = await localRedisClient.set(key, serializedValue);
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[local-redis] 键 ${key} 更新成功`);
    return { result };
  } catch (error) {
    log("error", `[local-redis] SET 请求失败:`, error.message);
    return { result: "ERROR" };
  }
}

// 设置带过期时间的本地 Redis 键值
export async function setLocalRedisKeyWithExpiry(key, value, expirySeconds) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.lastHashes[key] === currentHash) {
    log("info", `[local-redis] 键 ${key} 无变化，跳过 SETEX 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  try {
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

    const result = await localRedisClient.setEx(key, expirySeconds, serializedValue);
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[local-redis] 键 ${key} 更新成功（带过期时间 ${expirySeconds}s）`);
    return { result };
  } catch (error) {
    log("error", `[local-redis] SETEX 请求失败:`, error.message);
    return { result: "ERROR" };
  }
}

// 优化后的 getLocalRedisCaches，批量获取所有键
export async function getLocalRedisCaches() {
  if (!globals.localCacheInitialized) {
    try {
      log("info", 'getLocalRedisCaches start.');
      
      if (!(await checkLocalRedisConnection())) {
        await createLocalRedisClient();
      }

      if (!localRedisClient) {
        throw new Error('本地 Redis 客户端未初始化');
      }

      const keys = ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum'];
      const results = await Promise.all(keys.map(key => getLocalRedisKey(key)));

      // 解析结果，按顺序赋值
      globals.animes = results[0] ? JSON.parse(results[0]) : globals.animes;
      globals.episodeIds = results[1] ? JSON.parse(results[1]) : globals.episodeIds;
      globals.episodeNum = results[2] ? JSON.parse(results[2]) : globals.episodeNum;
      globals.reqRecords = results[3] ? JSON.parse(results[3]) : globals.reqRecords;

      // 恢复 lastSelectMap 并转换为 Map 对象
      const lastSelectMapData = results[4] ? JSON.parse(results[4]) : null;
      if (lastSelectMapData && typeof lastSelectMapData === 'object') {
        globals.lastSelectMap = new Map(Object.entries(lastSelectMapData));
        log("info", `Restored lastSelectMap from Local Redis with ${globals.lastSelectMap.size} entries`);
      }
      globals.todayReqNum = results[5] ? parseInt(results[5], 10) : globals.todayReqNum;

      // 更新哈希值
      globals.lastHashes.animes = simpleHash(JSON.stringify(globals.animes));
      globals.lastHashes.episodeIds = simpleHash(JSON.stringify(globals.episodeIds));
      globals.lastHashes.episodeNum = simpleHash(JSON.stringify(globals.episodeNum));
      globals.lastHashes.reqRecords = simpleHash(JSON.stringify(globals.reqRecords));
      globals.lastHashes.lastSelectMap = simpleHash(JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
      globals.lastHashes.todayReqNum = simpleHash(JSON.stringify(globals.todayReqNum));

      globals.localCacheInitialized = true;
      log("info", 'getLocalRedisCaches completed successfully.');
    } catch (error) {
      log("error", `getLocalRedisCaches failed: ${error.message}`, error.stack);
      globals.localCacheInitialized = true; // 标记为已初始化，避免重复尝试
    }
  }
}

// 优化后的 updateLocalRedisCaches，仅更新有变化的变量
export async function updateLocalRedisCaches() {
  try {
    log("info", 'updateLocalRedisCaches start.');
    
    if (!(await checkLocalRedisConnection())) {
      await createLocalRedisClient();
    }

    if (!localRedisClient) {
      throw new Error('本地 Redis 客户端未初始化');
    }

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
        updates.push({ key, value, hash: currentHash });
      }
    }

    // 如果有需要更新的键，执行批量更新
    if (updates.length > 0) {
      log("info", `Updating ${updates.length} changed keys: ${updates.map(u => u.key).join(', ')}`);

      const promises = updates.map(async ({ key, value }) => {
        return setLocalRedisKey(key, value);
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
          log("warn", `Failed to update Local Redis key: ${updates[index]?.key}, result: ${JSON.stringify(result)}`);
        }
      });

      // 只有在所有操作都成功时才更新哈希值
      if (failureCount === 0) {
        updates.forEach(({ key, hash }) => {
          globals.lastHashes[key] = hash;
        });
        log("info", `Local Redis update completed successfully: ${successCount} keys updated`);
      } else {
        log("warn", `Local Redis update partially failed: ${successCount} succeeded, ${failureCount} failed`);
      }
    } else {
      log("info", 'No changes detected, skipping Local Redis update.');
    }
  } catch (error) {
    log("error", `updateLocalRedisCaches failed: ${error.message}`, error.stack);
    log("error", `Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
  }
}

// 判断本地 Redis 是否可用
export async function judgeLocalRedisValid(path) {
  if (!globals.localRedisValid && globals.localRedisUrl && path !== "/favicon.ico" && path !== "/robots.txt") {
    try {
      if (!(await checkLocalRedisConnection())) {
        await createLocalRedisClient();
      }
      
      if (localRedisClient) {
        const result = await localRedisClient.ping();
        if (result === 'PONG') {
          globals.localRedisValid = true;
        }
      }
    } catch (error) {
      log("error", `[local-redis] 连接检查失败:`, error.message);
      globals.localRedisValid = false;
    }
  }
}

// 关闭本地 Redis 连接
export async function closeLocalRedisConnection() {
  if (localRedisClient) {
    try {
      await localRedisClient.quit();
      localRedisClient = null;
      globals.localRedisValid = false;
      log("info", '[local-redis] 连接已关闭');
    } catch (error) {
      log("error", `[local-redis] 关闭连接失败:`, error.message);
    }
  }
}