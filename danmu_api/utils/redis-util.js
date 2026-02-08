import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { simpleHash, serializeValue } from "./codec-util.js";

// =====================
// upstash redis 读写请求 （先简单实现，不加锁）
// =====================

// 使用 GET 发送简单命令（如 PING 检查连接）
export async function pingRedis() {
  const url = `${globals.redisUrl}/ping`;
  log("info", `[redis] 开始发送 PING 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["PONG"]
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 使用 GET 发送 GET 命令（读取键值）
export async function getRedisKey(key) {
  const url = `${globals.redisUrl}/get/${key}`;
  log("info", `[redis] 开始发送 GET 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["value"] 或 null
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 使用 POST 发送 SET 命令，仅在值变化时更新
export async function setRedisKey(key, value) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.lastHashes[key] === currentHash) {
    log("info", `[redis] 键 ${key} 无变化，跳过 SET 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}`;
  log("info", `[redis] 开始发送 SET 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[redis] 键 ${key} 更新成功`);
    return result; // 预期: ["OK"]
  } catch (error) {
    log("error", `[redis] SET 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 使用 POST 发送 SETEX 命令，仅在值变化时更新
export async function setRedisKeyWithExpiry(key, value, expirySeconds) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.lastHashes[key] === currentHash) {
    log("info", `[redis] 键 ${key} 无变化，跳过 SETEX 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}?EX=${expirySeconds}`;
  log("info", `[redis] 开始发送 SETEX 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[redis] 键 ${key} 更新成功（带过期时间 ${expirySeconds}s）`);
    return result;
  } catch (error) {
    log("error", `[redis] SETEX 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 通用的 pipeline 请求函数
export async function runPipeline(commands) {
  const url = `${globals.redisUrl}/pipeline`;
  log("info", `[redis] 开始发送 PIPELINE 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands) // commands 是一个数组，包含多个 Redis 命令
    });
    const result = await response.json();
    return result; // 返回结果数组，按命令顺序
  } catch (error) {
    log("error", `[redis] Pipeline 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 优化后的 getRedisCaches，单次请求获取所有键
export async function getRedisCaches() {
  if (!globals.redisCacheInitialized) {
    try {
      log("info", 'getRedisCaches start.');
      const keys = ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum'];
      const commands = keys.map(key => ['GET', key]); // 构造 pipeline 命令
      const results = await runPipeline(commands);

      // 解析结果，按顺序赋值
      globals.animes = results[0].result ? JSON.parse(results[0].result) : globals.animes;
      globals.episodeIds = results[1].result ? JSON.parse(results[1].result) : globals.episodeIds;
      globals.episodeNum = results[2].result ? JSON.parse(results[2].result) : globals.episodeNum;
      globals.reqRecords = results[3].result ? JSON.parse(results[3].result) : globals.reqRecords;

      // 恢复 lastSelectMap 并转换为 Map 对象
      const lastSelectMapData = results[4].result ? JSON.parse(results[4].result) : null;
      if (lastSelectMapData && typeof lastSelectMapData === 'object') {
        globals.lastSelectMap = new Map(Object.entries(lastSelectMapData));
        log("info", `Restored lastSelectMap from Redis with ${globals.lastSelectMap.size} entries`);
      }
      globals.todayReqNum = results[5].result ? parseInt(results[5].result, 10) : globals.todayReqNum;

      // 更新哈希值
      globals.lastHashes.animes = simpleHash(JSON.stringify(globals.animes));
      globals.lastHashes.episodeIds = simpleHash(JSON.stringify(globals.episodeIds));
      globals.lastHashes.episodeNum = simpleHash(JSON.stringify(globals.episodeNum));
      globals.lastHashes.reqRecords = simpleHash(JSON.stringify(globals.reqRecords));
      globals.lastHashes.lastSelectMap = simpleHash(JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
      globals.lastHashes.todayReqNum = simpleHash(JSON.stringify(globals.todayReqNum));

      globals.redisCacheInitialized = true;
      log("info", 'getRedisCaches completed successfully.');
    } catch (error) {
      log("error", `getRedisCaches failed: ${error.message}`, error.stack);
      globals.redisCacheInitialized = true; // 标记为已初始化，避免重复尝试
    }
  }
}

// 优化后的 updateRedisCaches，仅更新有变化的变量
export async function updateRedisCaches() {
  try {
    log("info", 'updateCaches start.');
    const commands = [];
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
        commands.push(['SET', key, serializedValue]);
        updates.push({ key, hash: currentHash });
      }
    }

    // 如果有需要更新的键，执行 pipeline
    if (commands.length > 0) {
      log("info", `Updating ${commands.length} changed keys: ${updates.map(u => u.key).join(', ')}`);
      const results = await runPipeline(commands);

      // 检查每个操作的结果
      let successCount = 0;
      let failureCount = 0;

      if (Array.isArray(results)) {
        results.forEach((result, index) => {
          if (result && result.result === 'OK') {
            successCount++;
          } else {
            failureCount++;
            log("warn", `Failed to update Redis key: ${updates[index]?.key}, result: ${JSON.stringify(result)}`);
          }
        });
      }

      // 只有在所有操作都成功时才更新哈希值
      if (failureCount === 0) {
        updates.forEach(({ key, hash }) => {
          globals.lastHashes[key] = hash;
        });
        log("info", `Redis update completed successfully: ${successCount} keys updated`);
      } else {
        log("warn", `Redis update partially failed: ${successCount} succeeded, ${failureCount} failed`);
      }
    } else {
      log("info", 'No changes detected, skipping Redis update.');
    }
  } catch (error) {
    log("error", `updateRedisCaches failed: ${error.message}`, error.stack);
    log("error", `Error details - Name: ${error.name}, Cause: ${error.cause ? error.cause.message : 'N/A'}`);
  }
}

// 判断redis是否可用
export async function judgeRedisValid(path) {
  if (!globals.redisValid && globals.redisUrl && globals.redisToken && path !== "/favicon.ico" && path !== "/robots.txt") {
    const res = await pingRedis();
    if (res && res.result && res.result === "PONG") {
      globals.redisValid = true;
    }
  }
}