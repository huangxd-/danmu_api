import { globals } from "../configs/globals.js";
import { jsonResponse } from "../utils/http-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";
import { formatLogMessage, log } from "../utils/log-util.js";
import { HandlerFactory } from "../configs/handlers/handler-factory.js";

export function handleUI() {
  return new Response(HTML_TEMPLATE.replace("globals.currentToken", globals.currentToken), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function handleConfig(hasPermission = false) {
  // 获取环境变量配置
  const envVarConfig = globals.envVarConfig;
  
  // 分类环境变量
  const categorizedVars = {
    api: [],
    source: [],
    match: [],
    danmu: [],
    cache: [],
    system: []
  };
  
  // 获取所有环境变量 - 这是用于配置预览的
  const previewEnvVars = {
    ...globals.accessedEnvVars,
    localCacheValid: globals.localCacheValid,
    redisValid: globals.redisValid,
    localRedisValid: globals.localRedisValid,
    aiValid: globals.aiValid,
    deployPlatform: globals.deployPlatform
  };
  
  // 将环境变量按分类组织 - 使用原始环境变量进行分类，但保持预览格式
  Object.keys(previewEnvVars).forEach(key => {
    const varConfig = envVarConfig[key] || { category: 'system', type: 'text', description: '未分类配置项' };
    const category = varConfig.category || 'system';
    
    categorizedVars[category].push({
      key: key,
      value: previewEnvVars[key].value || previewEnvVars[key], // 如果是新格式则取value字段，否则直接使用原值
      type: previewEnvVars[key].type || varConfig.type || 'text', // 如果是新格式则取type字段，否则使用配置中的type或默认text
      description: varConfig.description || '无描述',
      options: previewEnvVars[key].options || varConfig.options // 如果是新格式则取options字段
    });
  });
  
  // 检查是否配置了ADMIN_TOKEN
  const adminToken = globals.adminToken || '';
  const hasAdminToken = adminToken.trim() !== '';
  
  // 准备原始环境变量，无权限时也需要脱敏
  let originalEnvVars = { ...globals.originalEnvVars };
  if (!hasPermission || globals.currentToken !== globals.adminToken) {
    Object.keys(originalEnvVars).forEach(key => {
      if (globals.currentToken !== globals.token || key !== "TOKEN") {
        if (key in previewEnvVars && /^\*+$/.test(previewEnvVars[key])) {
          originalEnvVars[key] = previewEnvVars[key];
        }
      }
    });
  }
  
  return jsonResponse({
    message: "Welcome to the LogVar Danmu API server",
    version: globals.VERSION,
    envs: previewEnvVars, // 配置预览使用
    categorizedEnvVars: categorizedVars,
    envVarConfig: envVarConfig,
    originalEnvVars: originalEnvVars, // 系统设置使用原始环境变量（已脱敏）
    hasAdminToken: hasAdminToken, // 添加admin token配置状态
    repository: "https://github.com/huangxd-/danmu_api.git",
    description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔咪人韩巴狐乐西埋弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
    notice: "本项目仅为个人学习爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok，TG MSG ROBOT: [https://t.me/ddjdd_bot]; 推荐加互助群咨询，TG GROUP: [https://t.me/logvar_danmu_group]; 关注频道获取最新更新内容，TG CHANNEL: [https://t.me/logvar_danmu_channel]。"
  });
}

/**
 * 处理重新部署请求
 * @returns {Response} 部署操作结果
 */
export async function handleDeploy() {
  try {
    const deployPlatform = globals.deployPlatform;
    log("info", `[server] Deployment request received for platform: ${deployPlatform}`);
    
    // 如果是 Node 部署，直接返回成功，因为 Node 环境不需要重新部署
    if (deployPlatform.toLowerCase() === 'node') {
      log("info", `[server] Node/Docker deployment - no redeployment needed, config changes take effect automatically`);
      return jsonResponse({ success: true, message: "Node/Docker deployment - configuration changes take effect automatically" }, 200);
    }
    
    // 对于其他平台（如 Cloudflare、Vercel、Netlify 等），使用相应的 Handler 触发部署
    const handler = await HandlerFactory.getHandler(deployPlatform);
    if (!handler) {
      log("error", `[server] No handler found for platform: ${deployPlatform}`);
      return jsonResponse({ success: false, message: `No handler found for platform: ${deployPlatform}` }, 400);
    }
    
    // 调用 handler 的 deploy 方法
    const deployResult = await handler.deploy();
    if (deployResult) {
      log("info", `[server] Deployment triggered successfully for platform: ${deployPlatform}`);
      return jsonResponse({ success: true, message: "Deployment triggered successfully" }, 200);
    } else {
      log("error", `[server] Failed to trigger deployment for platform: ${deployPlatform}`);
      return jsonResponse({ success: false, message: "Failed to trigger deployment" }, 500);
    }
  } catch (error) {
    log("error", `[server] Deployment error: ${error.message}`);
    return jsonResponse({ success: false, message: `Deployment failed: ${error.message}` }, 500);
  }
}

/**
 * 处理获取日志的请求
 * @returns {Response} 包含日志文本的响应
 */
export function handleLogs() {
  const logText = globals.logBuffer
    .map(
      (log) =>
        `[${log.timestamp}] ${log.level}: ${formatLogMessage(log.message)}`
    )
    .join("\n");
    
  // 检查当前 token 是否为 admin_token
  let processedLogText = logText;
  if (globals.currentToken !== globals.adminToken) {
    // 隐藏 client ip 地址，将 "client ip: 127.0.0.1" 中的 IP 地址部分替换为相同长度的 *，但保留 .
    processedLogText = logText.replace(/(client\s+ip:\s*)([^\n\r]*)/gi, (match, prefix, ipPart) => {
      // 将 IP 地址中的每个字符（除了 . 和空格）替换为 *
      const maskedIp = ipPart.replace(/[^.\s\n\r]/g, '*');
      return prefix + maskedIp;
    });
  }
  
  return new Response(processedLogText, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * 处理清除日志的请求
 * @returns {Response} 表示操作成功的响应
 */
export function handleClearLogs() {
  globals.logBuffer = [];
  return jsonResponse({ success: true, message: "Logs cleared" }, 200);
}

/**
 * 处理清理缓存的请求
 * @returns {Response} 表示操作成功的响应
 */
export async function handleClearCache() {
 try {
    // 清理 globals 中的缓存数据
    globals.animes = [];
    globals.episodeIds = [];
    globals.episodeNum = 10001; // 重置为初始值
    globals.lastSelectMap = new Map(); // 重新创建 Map 对象
    globals.reqRecords = []; // 清空请求记录
    globals.todayReqNum = 0; // 重置今日请求次数
    
    // 清理搜索和弹幕缓存
    globals.searchCache = new Map();
    globals.commentCache = new Map();
    globals.requestHistory = new Map();
    
    log("info", `[server] Memory cache cleared successfully`);
    
    // 同步清理本地缓存和Redis缓存
    try {
      // 如果本地缓存有效，更新本地缓存
      if (globals.localCacheValid) {
        const { updateLocalCaches } = await import("../utils/cache-util.js");
        await updateLocalCaches();
        log("info", `[server] Local cache cleared successfully`);
      }
    } catch (localError) {
      log("warn", `[server] Local cache may not be available: ${localError.message}`);
    }
    
    try {
      // 如果Redis有效，更新Redis缓存
      if (globals.redisValid) {
        const { updateRedisCaches } = await import("../utils/redis-util.js");
        await updateRedisCaches();
        log("info", `[server] Redis cache cleared successfully`);
      }
    } catch (redisError) {
      log("warn", `[server] Redis may not be available: ${redisError.message}`);
    }

    try {
      // 如果本地Redis有效，更新本地Redis缓存
      if (globals.localRedisValid) {
        const { updateLocalRedisCaches } = await import("../utils/local-redis-util.js");
        await updateLocalRedisCaches();
        log("info", `[server] LocalRedis cache cleared successfully`);
      }
    } catch (redisError) {
      log("warn", `[server] LocalRedis may not be available: ${redisError.message}`);
    }
    
    log("info", `[server] All caches cleared successfully`);
    return jsonResponse({ success: true, message: "Cache cleared successfully", clearedItems: {
      animes: 0,
      episodeIds: 0,
      episodeNum: 10001,
      lastSelectMap: 0,
      searchCache: 0,
      commentCache: 0,
      requestHistory: 0,
      reqRecords: 0,
      todayReqNum: 0
    }}, 200);
  } catch (error) {
    log("error", `[server] Cache clear failed: ${error.message}`);
    return jsonResponse({ success: false, message: `Cache clear failed: ${error.message}` }, 500);
  }
}

/**
 * 处理获取请求记录的请求
 * @returns {Response} 包含请求记录的响应
 */
export function handleReqRecords() {
  // 返回请求记录，按时间倒序排列（最新的在前）
  let records = [...globals.reqRecords].reverse();
  const todayReqNum = globals.todayReqNum || 0;
  
  // 检查当前 token 是否为 admin_token，如果不是则隐藏 IP 地址
  if (globals.currentToken !== globals.adminToken) {
    // 隐藏请求记录中的 IP 地址，将 IP 地址部分替换为相同长度的 *，但保留 .
    records = records.map(record => {
      if (record.clientIp) {
        // 将 IP 地址中的每个字符（除了 .）替换为 *
        const maskedIp = record.clientIp.replace(/[^.]/g, '*');
        return { ...record, clientIp: maskedIp };
      }
      return record;
    });
  }
  
  return jsonResponse({ records, todayReqNum }, 200);
}

