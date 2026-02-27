import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache, getLocalCaches, judgeLocalCacheValid } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import AIClient from './utils/ai-util.js';
import { getBangumi, getComment, getCommentByUrl, getSegmentComment, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";
import { handleConfig, handleUI, handleLogs, handleClearLogs, handleDeploy, handleClearCache, handleReqRecords } from "./apis/system-api.js";
import { handleSetEnv, handleAddEnv, handleDelEnv, handleAiVerify } from "./apis/env-api.js";
import { Segment } from "./models/dandan-model.js"
import {
    handleCookieStatus,
    handleCookieVerify,
    handleQRGenerate,
    handleQRCheck,
    handleCookieSave
} from "./utils/cookie-util.js";

let globals;

async function handleRequest(req, env, deployPlatform, clientIp) {
  // 加载全局变量和环境变量配置
  globals = Globals.init(env);

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

  globals.deployPlatform = deployPlatform;
  if (deployPlatform === "node") {
    await judgeLocalCacheValid(path, deployPlatform);
  }
  await judgeRedisValid(path);
  if (!globals.aiValid && globals.aiBaseUrl && globals.aiModel && globals.aiApiKey && path !== "/favicon.ico" && path !== "/robots.txt") {
    const ai = new AIClient({
      baseURL: globals.aiBaseUrl,
      model: globals.aiModel,
      apiKey: globals.aiApiKey,
      systemPrompt: '回答尽量简洁',
    })

    const status = await ai.verify()
    if (status.ok) {
      globals.aiValid = true;
    }
  }

  log("info", `request url: ${JSON.stringify(url)}`);
  log("info", `request path: ${path}`);
  log("info", `client ip: ${clientIp}`);

  // --- 校验 token ---
  const parts = path.split("/").filter(Boolean); // 去掉空段

  const knownApiPaths = ["api", "v1", "v2", "search", "match", "bangumi", "comment"];

  const firstPart = parts[0] || "";
  const isDefaultToken = globals.token === "87654321";
  const isValidToken = firstPart === globals.token || firstPart === globals.adminToken;

  globals.currentToken = 
    isValidToken ? firstPart :
    isDefaultToken && (firstPart === "87654321" || knownApiPaths.includes(firstPart)) ? 
      (firstPart === "87654321" ? firstPart : "87654321") :
    "";

  if (deployPlatform === "node" && globals.localCacheValid && path !== "/favicon.ico" && path !== "/robots.txt") {
    await getLocalCaches();
  }
  if (globals.redisValid && path !== "/favicon.ico" && path !== "/robots.txt") {
    await getRedisCaches();
  }

  // 检查路径是否包含指定的接口关键字
  const targetPaths = [
    '/api/v2/search/anime',
    '/api/v2/match',
    '/api/v2/search/episodes',
    '/api/v2/bangumi',
    '/api/v2/comment',
    '/api/v2/segmentcomment'
  ];
  
  // 只有当path包含指定接口关键字时才添加到请求记录数组
  if (targetPaths.some(targetPath => path.includes(targetPath))) {
    // 更新今日请求计数
    // 从 reqRecords 最后一个元素获取上一个请求的时间
    const lastRecord = globals.reqRecords.length > 0 ? globals.reqRecords[globals.reqRecords.length - 1] : null;
    const currentDate = new Date().toDateString();
    
    if (lastRecord) {
      const lastDate = new Date(lastRecord.timestamp).toDateString();
      console.log("currentDate: ", currentDate);
      console.log("lastDate: ", lastDate);
      if (lastDate !== currentDate) {
        // 新的一天，重置计数
        globals.todayReqNum = 1;
      } else {
        // 同一天，计数加1
        globals.todayReqNum++;
      }
    } else {
      // 没有历史记录，重置为1
      globals.todayReqNum = 1;
    }

    // 处理路径，只保留从/api/v2开始的部分
    let normalizedPath = req.url;
    const apiV2Index = normalizedPath.indexOf('/api/v2');
    if (apiV2Index !== -1) {
      normalizedPath = normalizedPath.substring(apiV2Index);
    }

    // 获取请求体JSON（如果是POST/PUT/PATCH请求）
    let requestBody = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        const clonedReq = req.clone();
        const contentType = clonedReq.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          requestBody = await clonedReq.json();
        } else {
          // 尝试解析为JSON，即使content-type不匹配
          const text = await clonedReq.text();
          if (text) {
            requestBody = JSON.parse(text);
          }
        }
      } catch (e) {
        // JSON解析失败，保持为null
        requestBody = null;
      }
    }

    // 记录请求历史，包括接口/参数/请求时间
    const requestRecord = {
      interface: normalizedPath,
      params: requestBody, // 请求体JSON
      timestamp: new Date().toISOString(), // 请求时间
      method: method, // HTTP方法
      clientIp: clientIp // 客户端IP
    };

    globals.reqRecords.push(requestRecord);

    // 限制记录数量不超过 MAX_RECORDS
    if (globals.reqRecords.length > globals.MAX_RECORDS) {
      globals.reqRecords = globals.reqRecords.slice(-globals.MAX_RECORDS);
    }
  }

  // GET /
  if (path === "/" && method === "GET") {
    return handleUI();
  }

  if (path === "/favicon.ico" || path === "/robots.txt" || method === "OPTIONS") {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, User-Agent"
        }
    });
  }

  // 如果 token 是默认值 87654321
  if (globals.token === "87654321") {
    if (parts.length > 0) {
      // 如果第一段是正确的默认 token
      if (parts[0] === "87654321" || parts[0] === globals.adminToken) {
        // 移除 token，继续处理
        path = "/" + parts.slice(1).join("/");
      } else if (!knownApiPaths.includes(parts[0])) {
        // 对于 /api/config 路径，我们允许无 token 访问，但返回有限信息
        if (path === "/api/config" && method === "GET") {
          return handleConfig(false); // 无权限
        }
        // 第一段不是已知的 API 路径，可能是错误的 token
        // 返回 401
        log("error", `Invalid token in path: ${path}`);
        return jsonResponse(
          { errorCode: 401, success: false, errorMessage: "Unauthorized" },
          401
        );
      }
      // 如果第一段是已知的 API 路径（如 "api"），允许直接访问
    }
  } else {
    // token 不是默认值，必须严格校验
    if (parts.length < 1 || (parts[0] !== globals.token && parts[0] !== globals.adminToken)) {
      // 对于 /api/config 路径，如果使用默认 token，我们允许无 token 访问，但返回有限信息
      if (path === "/api/config" && method === "GET") {
        return handleConfig(false); // 无权限
      }
      log("error", `Invalid or missing token in path: ${path}`);
      return jsonResponse(
        { errorCode: 401, success: false, errorMessage: "Unauthorized" },
        401
      );
    }
    // 移除 token 部分，剩下的才是真正的路径
    path = "/" + parts.slice(1).join("/");
  }

  // GET /api/config - 获取配置信息 (需要 token)
  if (path === "/api/config" && method === "GET") {
    return handleConfig(true); // 有权限
  }

  // GET /api/reqrecords - 获取请求记录 (需要 token)
  if (path === "/api/reqrecords" && method === "GET") {
    return handleReqRecords();
  }

  log("info", path);

  // 智能处理API路径前缀，确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/api/logs" && !path.startsWith('/api/env') 
    && !path.startsWith('/api/deploy') && !path.startsWith('/api/cache')
    && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
    && !path.startsWith('/api/ai')) {
      log("info", `[Path Check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改
      
      // 1. 清理：应对"用户填写/api/v2"+"客户端添加/api/v2"导致的重复前缀
      while (path.startsWith('/api/v2/api/v2/')) {
          log("info", `[Path Check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取，相当于移除第一个
          path = path.substring('/api/v2'.length);
      }
      
      // 打印日志：只有在发生清理时才显示清理后的路径，否则显示"无需清理"
      if (path !== pathBeforeCleanup) {
          log("info", `[Path Check] Path after cleanup: "${path}"`);
      } else {
          log("info", `[Path Check] Path after cleanup: No cleanup needed.`);
      }
      
      // 2. 补全：如果路径缺少前缀（例如请求原始路径为 /search/anime），则补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs') 
        && !path.startsWith('/api/env') && !path.startsWith('/api/cache')
        && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
        && !path.startsWith('/api/ai')) {
          log("info", `[Path Check] Path is missing /api/v2 prefix. Adding...`);
          path = '/api/v2' + path;
      }
        
      // 打印日志：只有在发生添加前缀时才显示添加后的路径，否则显示"无需补全"
      if (path === pathBeforePrefixCheck) {
          log("info", `[Path Check] Prefix Check: No prefix addition needed.`);
      }
      
      log("info", `[Path Check] Final normalized path: "${path}"`);
  }
  
  // GET /
  if (path === "/" && method === "GET") {
    return handleUI();
  }

  // GET /api/v2/search/anime
  if (path === "/api/v2/search/anime" && method === "GET") {
    return searchAnime(url);
  }

  // GET /api/v2/search/episodes
  if (path === "/api/v2/search/episodes" && method === "GET") {
    return searchEpisodes(url);
  }

  // GET /api/v2/match
  if (path === "/api/v2/match" && method === "POST") {
    return matchAnime(url, req);
  }

  // GET /api/v2/bangumi/:animeId
  if (path.startsWith("/api/v2/bangumi/") && method === "GET") {
    return getBangumi(path);
  }

  // GET /api/v2/comment/:commentId or /api/v2/comment?url=xxx
  if (path.startsWith("/api/v2/comment") && method === "GET") {
    const queryFormat = url.searchParams.get('format');
    const videoUrl = url.searchParams.get('url');
    const segmentFlagParam = url.searchParams.get('segmentflag');
    const segmentFlag = segmentFlagParam === 'true' || segmentFlagParam === '1';

    // ⚠️ 限流设计说明：
    // 1. 先检查缓存，缓存命中时直接返回，不计入限流次数
    // 2. 只有缓存未命中时才执行限流检查和网络请求
    // 3. 这样可以避免频繁访问同一弹幕时被限流，提高用户体验

    // 如果有url参数，则通过URL获取弹幕
    if (videoUrl) {
      // 先检查缓存
      const cachedComments = getCommentCache(videoUrl);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${videoUrl}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }

      // 缓存未命中，执行限流检查（如果 rateLimitMaxRequests > 0 则启用限流）
      if (globals.rateLimitMaxRequests > 0) {
        const currentTime = Date.now();
        const oneMinute = 60 * 1000;

        // 清理所有过期的 IP 记录
        cleanupExpiredIPs(currentTime);

        // 检查该 IP 地址的历史请求
        if (!globals.requestHistory.has(clientIp)) {
          globals.requestHistory.set(clientIp, []);
        }

        const history = globals.requestHistory.get(clientIp);
        const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

        // 如果最近 1 分钟内的请求次数超过限制，返回 429 错误
        if (recentRequests.length >= globals.rateLimitMaxRequests) {
          log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
          return jsonResponse(
            { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
            429
          );
        }

        // 记录本次请求时间戳
        recentRequests.push(currentTime);
        globals.requestHistory.set(clientIp, recentRequests);
        log("info", `[Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
      }

      // 通过URL获取弹幕
      return getCommentByUrl(videoUrl, queryFormat, segmentFlag);
    }

    // 否则通过commentId获取弹幕
    if (!path.startsWith("/api/v2/comment/")) {
      log("error", "Missing commentId or url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing commentId or url parameter" },
        400
      );
    }

    const commentId = parseInt(path.split("/").pop());
    let urlForComment = findUrlById(commentId);

    if (urlForComment) {
      // 检查弹幕缓存 - 缓存命中时直接返回，不计入限流
      const cachedComments = getCommentCache(urlForComment);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${urlForComment}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }
    }

    // 缓存未命中，执行限流检查（如果 rateLimitMaxRequests > 0 则启用限流）
    if (globals.rateLimitMaxRequests > 0) {
      // 获取当前时间戳（单位：毫秒）
      const currentTime = Date.now();
      const oneMinute = 60 * 1000;  // 1分钟 = 60000 毫秒

      // 清理所有过期的 IP 记录
      cleanupExpiredIPs(currentTime);

      // 检查该 IP 地址的历史请求
      if (!globals.requestHistory.has(clientIp)) {
        // 如果该 IP 地址没有请求历史，初始化一个空队列
        globals.requestHistory.set(clientIp, []);
      }

      const history = globals.requestHistory.get(clientIp);

      // 过滤掉已经超出 1 分钟的请求
      const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

      // 如果最近的请求数量大于等于配置的限制次数，则限制请求
      if (recentRequests.length >= globals.rateLimitMaxRequests) {
        log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
        return jsonResponse(
          { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
          429
        );
      }

      // 记录本次请求时间戳
      recentRequests.push(currentTime);
      globals.requestHistory.set(clientIp, recentRequests);
      log("info", `[Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
    }

    return getComment(path, queryFormat, segmentFlag);
  }

  // POST /api/v2/segmentcomment - 接收segment类的JSON请求体
 if (path.startsWith("/api/v2/segmentcomment") && method === "POST") {
    try {
      const queryFormat = url.searchParams.get('format');
      // 从请求体获取segment数据
      const requestBody = await req.json();
      let segment;
      
      // 尝试解析JSON
      try {
        segment = Segment.fromJson(requestBody);
      } catch (e) {
        log("error", "Invalid JSON in request body for segment");
        return jsonResponse(
          { errorCode: 400, success: false, errorMessage: "Invalid JSON in request body" },
          400
        );
      }

      // 通过URL和平台获取分段弹幕
      return getSegmentComment(segment, queryFormat);
    } catch (error) {
      log("error", `Error processing segmentcomment request: ${error.message}`);
      return jsonResponse(
        { errorCode: 500, success: false, errorMessage: "Internal server error" },
        500
      );
    }
  }

  // GET /api/logs
  if (path === "/api/logs" && method === "GET") {
    return handleLogs();
  }

  // POST /api/logs/clear
  if (path === "/api/logs/clear" && method === "POST") {
    return handleClearLogs();
  }

  // POST /api/env/set - 设置环境变量
  if (path === "/api/env/set" && method === "POST") {
    return handleSetEnv(req);
  }

  // POST /api/env/add - 添加环境变量
  if (path === "/api/env/add" && method === "POST") {
    return handleAddEnv(req);
  }

  // POST /api/env/del - 删除环境变量
  if (path === "/api/env/del" && method === "POST") {
    return handleDelEnv(req);
  }

  // POST /api/deploy - 重新部署
  if (path === "/api/deploy" && method === "POST") {
    return handleDeploy();
  }

  // POST /api/cache/clear - 清理缓存
  if (path === "/api/cache/clear" && method === "POST") {
    return handleClearCache();
  }

  // ========== Cookie 管理 API ==========
  
  // GET /api/cookie/status - 获取Cookie状态
  if (path === "/api/cookie/status" && method === "GET") {
    return handleCookieStatus();
  }

  // POST /api/cookie/qr/generate - 生成登录二维码
  if (path === "/api/cookie/qr/generate" && method === "POST") {
    return handleQRGenerate();
  }

  // POST /api/cookie/qr/check - 检查二维码扫描状态
  if (path === "/api/cookie/qr/check" && method === "POST") {
    return handleQRCheck(req);
  }

  // POST /api/cookie/verify - 校验指定Cookie（用于前端实时检测）
  if (path === "/api/cookie/verify" && method === "POST") {
    return handleCookieVerify(req);
  }

  // POST /api/cookie/save - 保存Cookie
  if (path === "/api/cookie/save" && method === "POST") {
    return handleCookieSave(req);
  }

  // POST /api/ai/verify - 验证AI连通性
  if (path === "/api/ai/verify" && method === "POST") {
    return handleAiVerify(req);
  }

  return jsonResponse({ message: "Not found" }, 404);
}

function isRunningOnVercel() {
  if (typeof process === 'undefined' || !process.env) {
    return false;
  }
  return !!(
    process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.VERCEL_URL
  );
}

// --- Cloudflare Workers 入口 ---
export default {
  async fetch(request, env, ctx) {
    // 获取客户端的真实 IP
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    return handleRequest(request, env, isRunningOnVercel() ? "vercel" : "cloudflare", clientIp);
  },
};

// --- Vercel 入口 ---
export async function vercelHandler(req, res) {
  // 从请求头获取真实 IP
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

  const cfReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body:
      req.method === "POST" || req.method === "PUT"
        ? JSON.stringify(req.body)
        : undefined,
  });

  const response = await handleRequest(cfReq, process.env, "vercel", clientIp);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await response.text();
  res.send(text);
}

// --- Netlify 入口 ---
export async function netlifyHandler(event, context) {
  // 获取客户端 IP
  const clientIp = event.headers['x-nf-client-connection-ip'] ||
                   event.headers['x-forwarded-for'] ||
                   context.ip ||
                   'unknown';

  // 构造标准 Request 对象
  const url = event.rawUrl || `https://${event.headers.host}${event.path}`;

  const request = new Request(url, {
    method: event.httpMethod,
    headers: new Headers(event.headers),
    body: event.body ? event.body : undefined,
  });

  // 调用核心处理函数
  const response = await handleRequest(request, process.env, "netlify", clientIp);

  // 转换为 Netlify 响应格式
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}

// 为了测试导出 handleRequest
export { handleRequest};