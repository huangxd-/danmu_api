import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getFavoriteCachesFromRedis, judgeRedisValid, initializePersistentCaches } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache, judgeLocalCacheValid } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import AIClient from './utils/ai-util.js';
import { getBangumi, getComment, getCommentByUrl, getSegmentComment, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";
import { handleFavoriteAdd, handleFavoriteList, handleFavoriteRefresh, handleFavoriteRemove, handleFavoriteSchedule } from "./apis/favorite-api.js";
import { getFongmiDanmaku } from "./apis/clients/fongmi-api.js";
import { handleConfig, handleUI, handleLogs, handleClearLogs, handleDeploy, handleClearCache, handleReqRecords, handleInterfaceDetail, handleCacheAnimes, handleRemoteMappingRefresh, handleRemoteAutoMatchMappingRefresh } from "./apis/system-api.js";
import { handleForwardTrace } from "./apis/forward-trace-api.js";
import { handleSetEnv, handleAddEnv, handleDelEnv, handleAiVerify, handleDandanplayVerify } from "./apis/env-api.js";
import { handleLocalDanmuUpload, handleLocalDanmuList, handleLocalDanmuGet, handleLocalDanmuDelete, handleLocalDanmuUpdate } from "./apis/local-danmu-api.js";
import { extendBangumiDownloadLifecycle } from "./utils/bangumi-data-util.js";
import { Segment } from "./models/dandan-model.js"
import {
    handleCookieStatus,
    handleCookieVerify,
    handleQRGenerate,
    handleQRCheck,
    handleCookieSave
} from "./utils/cookie-util.js";
import { ensureRemoteTitleMapping } from './utils/remote-title-mapping-util.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTrace, currentTrace, finishTrace, markHandlerStart, maskTraceQueryString, runWithTrace, setTracePersistHook, traceStep, useAsyncLocalStorage } from './utils/pipeline-trace.js';

// 注入异步上下文实现，使追踪状态按请求隔离
useAsyncLocalStorage(AsyncLocalStorage);

let globals;

const FONGMI_DANMAKU_PATHS = new Set([
  "/danmaku",
  "/api/v2/fongmi/danmaku"
]);

const TITLE_MAPPING_PATHS = new Set([
  "/api/v2/match",
  "/api/v2/favorite/add",
  "/api/favorite/add",
  "/api/v2/favorite/refresh",
  "/api/favorite/refresh",
  "/api/v2/favorite/remove",
  "/api/favorite/remove",
]);

// 限流检查：超过阈值时记录拦截步骤并返回 true，调用方据此返回 429；
// 未超限则登记本次请求时间并返回 false。缓存命中的请求不进入此函数。
function isRateLimited(clientIp) {
  if (globals.rateLimitMaxRequests <= 0) return false;
  const currentTime = Date.now();
  const oneMinute = 60 * 1000;
  cleanupExpiredIPs(currentTime);
  if (!globals.requestHistory.has(clientIp)) globals.requestHistory.set(clientIp, []);
  const recentRequests = globals.requestHistory.get(clientIp)
    .filter(timestamp => currentTime - timestamp <= oneMinute);
  if (recentRequests.length >= globals.rateLimitMaxRequests) {
    log("warn", `[system] [Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
    // 拦截发生在业务步骤之前，单独留痕，使详情能说明本次请求为何没有结果
    traceStep('弹幕·限流拦截', currentTime, {
      status: 'skip',
      reason: `超过限流阈值（1 分钟内 ${recentRequests.length}/${globals.rateLimitMaxRequests} 次）`,
      inputs: { 限制次数: globals.rateLimitMaxRequests, 近一分钟请求数: recentRequests.length },
    });
    return true;
  }
  recentRequests.push(currentTime);
  globals.requestHistory.set(clientIp, recentRequests);
  log("info", `[system] [Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
  return false;
}

function isFongmiDanmakuRequest(path, method, url) {
  if (method !== "GET" && method !== "POST") return false;
  if (path === "/") {
    return method === "POST" || (method === "GET" && url.searchParams.has("name"));
  }
  return FONGMI_DANMAKU_PATHS.has(path);
}

// 系统管理接口：必须显式携带 ADMIN_TOKEN，默认 TOKEN=87654321 的免 token 兼容不适用于这些路径
const ADMIN_ONLY_PATH_PATTERNS = [
  /^\/api\/env\/(?:set|add|del)\/?$/,
  /^\/api\/deploy\/?$/,
  /^\/api\/cache\/(?:clear|animes)\/?$/,
  /^\/api\/logs\/clear\/?$/,
  /^\/api\/cookie\/(?:status|save|verify|qr\/generate|qr\/check)\/?$/,
  /^\/api\/ai\/verify\/?$/,
  /^\/api\/nipaplay\/verify\/?$/,
  /^\/api\/title-mapping\/refresh\/?$/,
  /^\/api\/auto-match-mapping\/refresh\/?$/,
];

async function handleRequest(req, env, deployPlatform, clientIp) {
  // 加载全局变量和环境变量配置
  globals = Globals.init(env);

  const url = new URL(req.url);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const method = req.method;

  globals.deployPlatform = deployPlatform;
  if (deployPlatform === "node") {
    await judgeLocalCacheValid(path, deployPlatform);
    const { judgeLocalRedisValid } = await import("./utils/local-redis-util.js");
    await judgeLocalRedisValid(path);
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

  log("info", `[system] [server] request url: ${JSON.stringify(url)}`);
  log("info", `[system] [server] request path: ${path}`);
  log("info", `[system] [server] client ip: ${clientIp}`);

  // --- IP 黑名单拦截 ---
  if (globals.ipBlacklist?.length) {
    const isBlocked = globals.ipBlacklist.some(rule => matchIpBlacklistRule(rule, clientIp));
    if (isBlocked) {
      log("warn", `[system] [IP Blacklist] Blocked request from IP: ${clientIp}`);
      return jsonResponse(
        { errorCode: 403, success: false, errorMessage: "Forbidden" },
        403
      );
    }
  }

  // --- 校验 token ---
  const parts = path.split("/").filter(Boolean); // 去掉空段

  const knownApiPaths = ["api", "v1", "v2", "search", "match", "favorite", "bangumi", "comment", "danmaku", "local-danmu"];

  const firstPart = parts[0] || "";
  const isDefaultToken = globals.token === "87654321";
  const isValidToken = firstPart === globals.token || firstPart === globals.adminToken;
  const explicitToken = firstPart === globals.token || (globals.adminToken && firstPart === globals.adminToken)
    ? firstPart
    : "";

  globals.currentToken = 
    isValidToken ? firstPart :
    isDefaultToken && (firstPart === "87654321" || knownApiPaths.includes(firstPart)) ? 
      (firstPart === "87654321" ? firstPart : "87654321") :
    "";

  // 自定义 TOKEN 时收藏接口必须显式携带 token；默认 TOKEN=87654321 时保持无 token 兼容。
  // FAVORITE_REQUIRE_ADMIN 开启后，无论 TOKEN 是否为默认值，都只能使用 ADMIN_TOKEN。
  const tokenlessPath = explicitToken ? "/" + parts.slice(1).join("/") : path;
  const requestTrace = currentTrace();
  if (requestTrace) {
    requestTrace.path = tokenlessPath;
    requestTrace.query = maskTraceQueryString(url.search);
  }
  const isFavoriteRequest = /(?:^|\/)favorite(?:\/|$)/.test(tokenlessPath);
  const isFavoriteListRequest = method === "GET"
    && /^\/(?:api\/v2\/|api\/|v2\/)?favorite\/list$/.test(tokenlessPath);
  if (method !== "OPTIONS" && isFavoriteRequest && !isFavoriteListRequest) {
    if (!explicitToken && !isDefaultToken) {
      return jsonResponse(
        { errorCode: 401, success: false, errorMessage: "Favorite API requires an explicit token" },
        401
      );
    }
    if (globals.favoriteRequireAdmin && (!globals.adminToken || explicitToken !== globals.adminToken)) {
      return jsonResponse(
        { errorCode: 403, success: false, message: "权限不足", errorMessage: "Favorite API requires ADMIN_TOKEN" },
        403
      );
    }
  }

  if (path !== '/favicon.ico' && path !== '/robots.txt' && method !== 'OPTIONS') {
    const persistentCachesReady = await initializePersistentCaches(deployPlatform);
    let favoriteReadSucceeded = true;
    if (globals.redisValid && deployPlatform !== 'node' && isFavoriteRequest) {
      favoriteReadSucceeded = await getFavoriteCachesFromRedis();
    }
    if (isFavoriteRequest && !isFavoriteListRequest && (
      !persistentCachesReady || !favoriteReadSucceeded || (globals.redisUrl && globals.redisToken && globals.favoriteCacheWritable.upstash === false)
      || (globals.localCacheValid && globals.favoriteCacheWritable.file === false)
      || (deployPlatform !== 'node' && globals.redisUrl && globals.redisToken && !globals.redisValid)
    )) {
      return jsonResponse({ success: false, message: '收藏缓存暂时无法读取，本次修改未执行，请稍后重试' }, 503);
    }
  }

  // 检查路径是否包含指定的接口关键字
  const targetPaths = [
    '/api/v2/search/anime',
    '/api/v2/match',
    '/api/v2/favorite',
    '/api/v2/search/episodes',
    '/api/v2/fongmi/danmaku',
    '/danmaku',
    '/api/v2/bangumi',
    '/api/v2/comment',
    '/api/v2/segmentcomment'
  ];

  // 识别 FongMi 根地址或指定业务接口，记录请求历史和今日请求数。
  if (isFongmiDanmakuRequest(tokenlessPath, method, url) || targetPaths.some(targetPath => path.includes(targetPath))) {
    // 更新今日请求计数
    // 从 reqRecords 最后一个元素获取上一个请求的时间
    const lastRecord = globals.reqRecords.length > 0 ? globals.reqRecords[globals.reqRecords.length - 1] : null;
    const currentDate = new Date().toDateString();

    if (lastRecord) {
      const lastDate = new Date(lastRecord.timestamp).toDateString();
      log("info", `[system] [server] currentDate: ${currentDate}`);
      log("info", `[system] [server] lastDate: ${lastDate}`);
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
      requestId: currentTrace()?.id ?? null,
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
  if (path === "/" && method === "GET" && !isFongmiDanmakuRequest(path, method, url)) {
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
        log("error", `[system] [server] Invalid token in path: ${path}`);
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
      // 收藏列表是公开只读接口；其他接口仍需严格校验 token
      if (!isFavoriteListRequest) {
        log("error", `[system] [server] Invalid or missing token in path: ${path}`);
        return jsonResponse(
          { errorCode: 401, success: false, errorMessage: "Unauthorized" },
          401
        );
      }
    } else {
      // 移除 token 部分，剩下的才是真正的路径
      path = "/" + parts.slice(1).join("/");
    }
  }

  // 系统管理接口鉴权：只看请求实际携带的 token（explicitToken），避免默认 token 兼容垫片被用来自我授权
  if (ADMIN_ONLY_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    const isAdminRequest = Boolean(globals.adminToken) && explicitToken === globals.adminToken;
    if (!isAdminRequest) {
      const errorMessage = globals.adminToken
        ? "Unauthorized: 系统管理接口需要 ADMIN_TOKEN"
        : "Unauthorized: 系统管理接口需要先设置 ADMIN_TOKEN";
      log("warn", `[system] [server] Admin-only endpoint denied: ${path} - ${errorMessage}`);
      return jsonResponse({ errorCode: 401, success: false, errorMessage }, 401);
    }
  }

  const prepareTrace = currentTrace();
  if (prepareTrace) markHandlerStart(prepareTrace.startedAt);

  // 兼容部分客户端将自定义弹幕短地址再次拼接官方完整路径的情况
  // 例如: /danmaku/api/v2/fongmi/danmaku?name=...&episode=...
  if (path.endsWith("/danmaku/api/v2/fongmi/danmaku")) {
    log("info", `[system] [path fix] Collapsed nested danmaku path: "${path}" -> "/danmaku"`);
    path = "/danmaku";
  }

  // GET /api/config - 获取配置信息 (需要 token)
  if (path === "/api/config" && method === "GET") {
    return handleConfig(true); // 有权限
  }

  const isLocalDanmuUpload = (path === '/api/local-danmu/upload' || path === '/api/v2/local-danmu/upload') && method === 'POST';
  const isLocalDanmuList = (path === '/api/local-danmu/list' || path === '/api/v2/local-danmu/list') && method === 'GET';
  const localResourceMatch = path.match(/^\/api(?:\/v2)?\/local-danmu\/([^/]+)$/);
  if (isLocalDanmuUpload || isLocalDanmuList || (localResourceMatch && (method === 'GET' || method === 'DELETE' || method === 'PATCH'))) {
    const isAdmin = !!globals.adminToken && globals.currentToken === globals.adminToken;
    const isUser = !!globals.token && globals.currentToken === globals.token;
    if (!isAdmin && !isUser) return jsonResponse({ errorCode: 401, success: false, errorMessage: 'Unauthorized' }, 401);
    if ((isLocalDanmuUpload || method === 'DELETE' || method === 'PATCH') && !isAdmin && !globals.localDanmuNotRequireAdmin) {
      return jsonResponse({ errorCode: 403, success: false, errorMessage: 'Local danmu upload and deletion require ADMIN_TOKEN or LOCAL_DANMU_NOT_REQUIRE_ADMIN=true' }, 403);
    }
    if (isLocalDanmuUpload) return handleLocalDanmuUpload(req);
    if (isLocalDanmuList) return handleLocalDanmuList();
    const key = decodeURIComponent(localResourceMatch[1]);
    if (method === 'GET') return handleLocalDanmuGet(key);
    if (method === 'PATCH') return handleLocalDanmuUpdate(req, key);
    return handleLocalDanmuDelete(key);
  }

  // GET /api/reqrecords - 获取请求记录 (需要 token)
  if (path === "/api/reqrecords" && method === "GET") {
    return handleReqRecords();
  }

  // GET /api/interface-detail/:id - 获取单条请求的处理详情（接口详情）
  const interfaceDetailMatch = path.match(/^\/api\/interface-detail\/([^/]+)\/?$/);
  if (interfaceDetailMatch && method === 'GET') {
    return handleInterfaceDetail(interfaceDetailMatch[1]);
  }

  log("info", `[system] [server] ${path}`);

  // 智能处理API路径前缀，确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/danmaku" && path !== "/api/logs" && !path.startsWith('/api/env') 
    && !path.startsWith('/api/deploy') && !path.startsWith('/api/cache')
    && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
    && !path.startsWith('/api/favorite')
    && !path.startsWith('/api/ai') && !path.startsWith('/api/nipaplay')
    && !path.startsWith('/api/debug') && !path.startsWith('/api/title-mapping')
    && !path.startsWith('/api/auto-match-mapping')
    && !path.startsWith('/api/local-danmu')) {
      log("info", `[system] [path check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改

      // 清理：应对"用户填写/api/v2"+"客户端添加/api/v2"导致的重复前缀
      path = path.replace(/\/+/g, '/');
      while (path.startsWith('/api/v2/api/v2/')) {
          log("info", `[system] [path check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取，相当于移除第一个
          path = path.substring('/api/v2'.length);
      }

      // 打印日志：只有在发生清理时才显示清理后的路径，否则显示"无需清理"
      if (path !== pathBeforeCleanup) {
          log("info", `[system] [path check] Path after cleanup: "${path}"`);
      } else {
          log("info", `[system] [path check] Path after cleanup: No cleanup needed.`);
      }

      // 补全：如果路径缺少前缀（例如请求原始路径为 /search/anime 或 /v2/search/anime），则智能补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs') 
        && !path.startsWith('/api/env') && !path.startsWith('/api/cache')
        && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
        && !path.startsWith('/api/favorite')
        && !path.startsWith('/api/ai') && !path.startsWith('/api/nipaplay')
        && !path.startsWith('/api/debug') && !path.startsWith('/api/title-mapping')
        && !path.startsWith('/api/auto-match-mapping')
        && !path.startsWith('/api/local-danmu')) {
          if (path.startsWith('/v2/') || path === '/v2') {
              log("info", `[system] [path check] Path is missing /api prefix. Adding /api...`);
              path = '/api' + path;
          } else if (path.startsWith('/api/') || path === '/api') {
              log("info", `[system] [path check] Path is missing /v2 prefix. Adding /v2...`);
              path = '/api/v2' + path.substring(4);
          } else {
              log("info", `[system] [path check] Path is missing /api/v2 prefix. Adding /api/v2...`);
              path = '/api/v2' + (path.startsWith('/') ? path : '/' + path);
          }
      }

      // 打印日志：只有在发生添加前缀时才显示添加后的路径，否则显示"无需补全"
      if (path === pathBeforePrefixCheck) {
          log("info", `[system] [path check] Prefix Check: No prefix addition needed.`);
      }

      log("info", `[system] [path check] Final normalized path: "${path}"`);
  }

  // GET /
  if (path === "/" && method === "GET" && !isFongmiDanmakuRequest(path, method, url)) {
    return handleUI();
  }

  const needsTitleMapping = isFongmiDanmakuRequest(path, method, url)
    || TITLE_MAPPING_PATHS.has(path);
  if (needsTitleMapping) await ensureRemoteTitleMapping();

  // GET /api/v2/search/anime
  if (path === "/api/v2/search/anime" && method === "GET") {
    return searchAnime(url);
  }

  // GET /api/v2/search/episodes
  if (path === "/api/v2/search/episodes" && method === "GET") {
    return searchEpisodes(url);
  }

  // GET|POST /、/danmaku 或 /api/v2/fongmi/danmaku
  if (isFongmiDanmakuRequest(path, method, url)) {
    return getFongmiDanmaku(url, req);
  }

  // GET /api/v2/match
  if (path === "/api/v2/match" && method === "POST") {
    return matchAnime(url, req, clientIp);
  }
  // POST /api/v2/favorite/add - 收藏剧集（永久缓存）
  if ((path === "/api/v2/favorite/add" || path === "/api/favorite/add") && method === "POST") {
    return handleFavoriteAdd(req, url);
  }

  // POST /api/v2/favorite/refresh - 刷新收藏缓存
  if ((path === "/api/v2/favorite/refresh" || path === "/api/favorite/refresh") && method === "POST") {
    return handleFavoriteRefresh(req, url);
  }

  // POST /api/v2/favorite/schedule - 设置或关闭定时刷新
  if ((path === "/api/v2/favorite/schedule" || path === "/api/favorite/schedule") && method === "POST") {
    return handleFavoriteSchedule(req);
  }

  // POST /api/v2/favorite/remove - 删除收藏
  if ((path === "/api/v2/favorite/remove" || path === "/api/favorite/remove") && method === "POST") {
    return handleFavoriteRemove(req);
  }

  // GET /api/v2/favorite/list - 收藏列表
  if ((path === "/api/v2/favorite/list" || path === "/api/favorite/list") && method === "GET") {
    return handleFavoriteList();
  }


  // GET /api/v2/bangumi/:animeId
  if (path.startsWith("/api/v2/bangumi/") && method === "GET") {
    return getBangumi(path);
  }

  // GET /api/v2/comment/:commentId or /api/v2/comment?url=xxx or /api/v2/extcomment?url=xxx
  if ((path.startsWith("/api/v2/comment") || path.startsWith("/api/v2/extcomment")) && method === "GET") {
    const queryFormat = url.searchParams.get('format');
    const videoUrl = url.searchParams.get('url');
    const segmentFlagParam = url.searchParams.get('segmentflag');
    const durationParam = url.searchParams.get('duration');
    const segmentFlag = segmentFlagParam === 'true' || segmentFlagParam === '1';
    const includeDuration = durationParam === 'true' || durationParam === '1';

    // ⚠️ 限流设计说明：
    // 1. 先检查缓存，缓存命中时直接返回，不计入限流次数
    // 2. 只有缓存未命中时才执行限流检查和网络请求
    // 3. 这样可以避免频繁访问同一弹幕时被限流，提高用户体验

    // 如果有url参数，则通过URL获取弹幕
    if (videoUrl) {
      // 先检查缓存
      const cachedComments = getCommentCache(videoUrl);
      if (cachedComments !== null) {
        log("info", `[system] [Rate Limit] Cache hit for URL: ${videoUrl}, skipping rate limit check`);
        return getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration);
      }

      // 缓存未命中，执行限流检查
      if (isRateLimited(clientIp)) {
        return jsonResponse(
          { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
          429
        );
      }

      // 通过URL获取弹幕
      return getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration);
    }

    // 否则通过commentId获取弹幕
    if (!path.startsWith("/api/v2/comment/")) {
      log("error", "[system] [server] Missing commentId or url parameter");
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
        log("info", `[system] [Rate Limit] Cache hit for URL: ${urlForComment}, skipping rate limit check`);
        return getComment(path, queryFormat, segmentFlag, clientIp, includeDuration);
      }
    }

    // 缓存未命中，执行限流检查
    if (isRateLimited(clientIp)) {
      return jsonResponse(
        { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
        429
      );
    }

    return getComment(path, queryFormat, segmentFlag, clientIp, includeDuration);
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
        log("error", "[system] [server] Invalid JSON in request body for segment");
        return jsonResponse(
          { errorCode: 400, success: false, errorMessage: "Invalid JSON in request body" },
          400
        );
      }

      // 通过URL和平台获取分段弹幕
      return getSegmentComment(segment, queryFormat);
    } catch (error) {
      log("error", `[system] [server] Error processing segmentcomment request: ${error.message}`);
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

  // POST /api/title-mapping/refresh - 管理员手动刷新远程映射表
  if (path === "/api/title-mapping/refresh" && method === "POST") {
    return handleRemoteMappingRefresh();
  }

  // POST /api/auto-match-mapping/refresh - 管理员手动刷新远程季集映射表
  if (path === "/api/auto-match-mapping/refresh" && method === "POST") {
    return handleRemoteAutoMatchMappingRefresh();
  }

  if (path === '/api/debug/forward-trace') {
    if (!isValidToken) {
      return jsonResponse({ success: false, errorMessage: 'Explicit token required for Forward traces' }, 401);
    }
    if (method === 'POST') {
      return handleForwardTrace(req);
    }
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

  // GET /api/cache/animes - 获取最近 animes 缓存
  if (path === "/api/cache/animes" && method === "GET") {
    return handleCacheAnimes();
  }

  // POST /api/cache/clear - 清理缓存
  if (path === "/api/cache/clear" && method === "POST") {
    return handleClearCache(req);
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

  // POST /api/nipaplay/verify - 验证弹弹play账号连通性
  if (path === "/api/nipaplay/verify" && method === "POST") {
    return handleDandanplayVerify(req);
  }

  return jsonResponse({ message: "Not found" }, 404);
}

function matchIpBlacklistRule(rule, clientIp) {
  if (!rule || !clientIp || clientIp === 'unknown') return false;

  if (rule.type === 'exact') {
    return rule.value === clientIp;
  }

  if (rule.type === 'regex') {
    return rule.value.test(clientIp);
  }

  if (rule.type === 'cidr') {
    return isIpInCidr(clientIp, rule.ip, rule.prefix);
  }

  return false;
}

function isIpInCidr(ip, cidrIp, prefix) {
  const isIpv6 = ip.includes(':') || cidrIp.includes(':');
  if (isIpv6) {
    const ipBytes = ipv6ToBytes(ip);
    const cidrBytes = ipv6ToBytes(cidrIp);
    if (!ipBytes || !cidrBytes || prefix < 0 || prefix > 128) return false;
    const fullBytes = Math.floor(prefix / 8);
    const remainingBits = prefix % 8;

    for (let i = 0; i < fullBytes; i++) {
      if (ipBytes[i] !== cidrBytes[i]) return false;
    }

    if (remainingBits > 0) {
      const mask = (0xff << (8 - remainingBits)) & 0xff;
      return (ipBytes[fullBytes] & mask) === (cidrBytes[fullBytes] & mask);
    }

    return true;
  }

  const ipInt = ipv4ToInt(ip);
  const cidrInt = ipv4ToInt(cidrIp);
  if (ipInt === null || cidrInt === null || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (cidrInt & mask);
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(num => Number.isNaN(num) || num < 0 || num > 255)) return null;
  return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
}

function ipv6ToBytes(ip) {
  if (!ip || typeof ip !== 'string' || !ip.includes(':')) return null;
  const normalized = ip.trim();
  const segments = normalized.split('::');
  if (segments.length > 2) return null;

  let leftParts = segments[0] ? segments[0].split(':').filter(Boolean) : [];
  let rightParts = segments[1] ? segments[1].split(':').filter(Boolean) : [];

  const expandIpv4Part = (parts) => {
    if (parts.length === 0) return parts;
    const last = parts[parts.length - 1];
    if (!last.includes('.')) return parts;
    const ipv4Int = ipv4ToInt(last);
    if (ipv4Int === null) return null;
    const high = ((ipv4Int >>> 16) & 0xffff).toString(16);
    const low = (ipv4Int & 0xffff).toString(16);
    return [...parts.slice(0, -1), high, low];
  };

  leftParts = expandIpv4Part(leftParts);
  rightParts = expandIpv4Part(rightParts);
  if (!leftParts || !rightParts) return null;

  if (segments.length === 1) {
    if (leftParts.length !== 8) return null;
  } else {
    const totalParts = leftParts.length + rightParts.length;
    if (totalParts > 8) return null;
    const missing = 8 - totalParts;
    rightParts = new Array(missing).fill('0').concat(rightParts);
  }

  const parts = leftParts.concat(rightParts);
  if (parts.length !== 8) return null;

  const bytes = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    const value = parseInt(part, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return bytes;
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

function detectDeployPlatform(env) {
  if (env?.SPACE_ID || (typeof process !== 'undefined' && process.env?.SPACE_ID)) {
    return "huggingface";
  }
  return isRunningOnVercel() ? "vercel" : "cloudflare";
}

// 请求记录与详情必须同批落盘，避免重启后出现有详情但无请求记录；失败不影响请求结果
const REQUEST_RECORD_PERSIST_KEYS = { keys: ['reqRecords', 'todayReqNum', 'pipelineTraces'] };
let tracePersistTimer = null;
let tracePersistPromise = null;
let tracePersistRequested = false;

async function persistRequestSnapshot() {
  const backends = [
    ['file', globals.localCacheValid, './utils/cache-util.js', 'updateLocalCaches'],
    ['upstash', globals.redisValid, './utils/redis-util.js', 'updateRedisCaches'],
    ['localRedis', globals.localRedisValid, './utils/local-redis-util.js', 'updateLocalRedisCaches'],
  ];
  for (const [backend, enabled, modulePath, method] of backends) {
    if (!enabled) continue;
    try {
      const module = await import(modulePath);
      const result = await module[method](REQUEST_RECORD_PERSIST_KEYS);
      if (result === false) log('warn', `[system] [trace] ${backend} 详情落盘未执行`);
    } catch (error) {
      log('warn', `[system] [trace] ${backend} 详情落盘失败: ${error.message}`);
    }
  }
}

function startTracePersist() {
  if (tracePersistPromise) return tracePersistPromise;
  tracePersistPromise = (async () => {
    try {
      while (tracePersistRequested) {
        tracePersistRequested = false;
        await persistRequestSnapshot();
      }
    } finally {
      tracePersistPromise = null;
    }
  })();
  return tracePersistPromise;
}

function scheduleTracePersist() {
  // 合并短时间内的多次落盘，写穿仍保持与请求记录同批可见
  tracePersistRequested = true;
  if (tracePersistTimer || tracePersistPromise) return;
  tracePersistTimer = setTimeout(() => {
    tracePersistTimer = null;
    startTracePersist().catch(error => log('warn', `[system] [trace] 详情落盘失败: ${error.message}`));
  }, 500);
}

function flushTracePersistence() {
  if (tracePersistTimer) {
    clearTimeout(tracePersistTimer);
    tracePersistTimer = null;
  }
  tracePersistRequested = true;
  return startTracePersist();
}

const SERVERLESS_PLATFORMS = new Set(['cloudflare', 'vercel', 'netlify', 'edgeone']);

// 在追踪作用域内处理一次请求，结束时留存该请求的接口详情
export async function handleRequestWithTrace(req, env, deployPlatform, clientIp, lifecycleContext) {
  // 接口路径由 handleRequest 写入不含凭据的路径，此处不记录 URL 中可能携带的 token
  const trace = createTrace(req.method, '', clientIp);
  let retained = false;
  return runWithTrace(trace, async () => {
    try {
      const response = await handleRequest(req, env, deployPlatform, clientIp);
      trace.statusCode = response?.status ?? null;
      // 列表据此直接区分成败，不必逐条打开详情
      const record = globals.reqRecords.find(item => item.requestId === trace.id);
      if (record) record.statusCode = trace.statusCode;
      return response;
    } finally {
      // 只有写入请求记录的请求才留存详情，两者一一对应
      retained = globals.reqRecords.some(record => record.requestId === trace.id);
      finishTrace(trace, retained);
      // 异常同样要落盘；边缘/Serverless 可能在响应后冻结 timer，优先注册 waitUntil
      if (retained && SERVERLESS_PLATFORMS.has(deployPlatform)) {
        const pending = flushTracePersistence();
        if (typeof lifecycleContext?.waitUntil === 'function') lifecycleContext.waitUntil(pending);
        else await pending;
      }
    }
  });
}

// 详情随请求记录同批落盘；模块加载时注册一次
function initTracePersistence() {
  setTracePersistHook(scheduleTracePersist);
}

initTracePersistence();

// --- Cloudflare Workers 入口 ---
export default {
  async fetch(request, env, ctx) {
    // 获取客户端的真实 IP
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    const response = await handleRequestWithTrace(request, env, detectDeployPlatform(env), clientIp, ctx);
    // 边缘运行时在响应返回后延长生命周期，容纳可能在途的 Bangumi Data 后台静默下载
    extendBangumiDownloadLifecycle(ctx);
    return response;
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

  const response = await handleRequestWithTrace(cfReq, process.env, "vercel", clientIp);

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
  const response = await handleRequestWithTrace(request, process.env, "netlify", clientIp, context);

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
