import { getComment, getCommentByUrl, getSegmentComment, resolveCommentCacheKey } from './apis/comment-api.js';
import { resolveRequestAuth } from './utils/request-auth.js';
import { handleMappingShare } from './utils/mapping-share-util.js';
import { initializePersistentCaches } from './utils/persistent-cache-util.js';
import { Globals } from './configs/globals.js';
import { runWithRequestContext } from './utils/request-context.js';
import { jsonResponse } from './utils/http-util.js';
import { log } from './utils/log-util.js';

import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";

import { getBangumi, matchAnime, searchAnime, searchEpisodes } from "./apis/player-api.js";

import { getFongmiDanmaku } from "./apis/clients/fongmi-api.js";
import { handleConfig, handleUI, handleLogs, handleClearLogs, handleClearCache, handleCacheAnimes, handleRemoteMappingLogs, handleRemoteMappingRefresh, handleRemoteAutoMatchMappingRefresh } from "./apis/system-api.js";

import { handleSetEnv, handleAddEnv, handleDelEnv } from './apis/env-api.js';


import { Segment } from "./models/player-model.js";
import { handleCookieStatus, handleCookieVerify, handleQRGenerate, handleQRCheck, handleCookieSave } from "./utils/cookie-util.js";

let globals;

async function handleRequest(req, env, deployPlatform, clientIp) {
  return runWithRequestContext(() => handleRequestBody(req, env, deployPlatform, clientIp));
}

async function handleRequestBody(req, env, deployPlatform, clientIp) {
  // 加载全局变量和环境变量配置
  globals = Globals.init(env);

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;
  const isLogReadRequest = method === 'GET' && /(?:^|\/)api\/logs(?:\/remote-mapping)?\/?$/.test(path);

  globals.deployPlatform = deployPlatform;

  if (!isLogReadRequest) {
    log("debug", `[system] [server] request url: ${JSON.stringify(url)}`);
    log("debug", `[system] [server] request path: ${path}`);
    log("debug", `[system] [server] client ip: ${clientIp}`);
  }


  const auth = resolveRequestAuth(path, globals.token, globals.tokenAuthDisabled);
  globals.currentToken = auth.currentToken;

  if (path === '/' && method === 'GET') return handleUI();
  if (path === '/favicon.ico' || path === '/robots.txt' || method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, User-Agent',
    } });
  }
  if (!auth.authorized) {
    return jsonResponse({ errorCode: 401, success: false, errorMessage: 'Unauthorized' }, 401);
  }
  path = auth.path;
  await initializePersistentCaches();

  // 兼容部分客户端将自定义弹幕短地址再次拼接官方完整路径的情况
  // 例如: /danmaku/api/v2/fongmi/danmaku?name=...&episode=...
  if (path.endsWith("/danmaku/api/v2/fongmi/danmaku")) {
    log("debug", `[system] [path fix] Collapsed nested danmaku path: "${path}" -> "/danmaku"`);
    path = "/danmaku";
  }

  // GET /api/config - 获取配置信息 (需要 token)
  if (path === "/api/config" && method === "GET") {
    return handleConfig();
  }

  if (!isLogReadRequest) log("debug", `[system] [server] ${path}`);

  // 智能处理API路径前缀，确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/danmaku" && path !== "/api/logs" && !path.startsWith('/api/env') && !path.startsWith('/api/cache')
    && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
    && !path.startsWith('/api/title-mapping') && !path.startsWith('/api/auto-match-mapping')) {
      log("debug", `[system] [path check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改

      // 清理：应对"用户填写/api/v2"+"客户端添加/api/v2"导致的重复前缀
      path = path.replace(/\/+/g, '/');
      while (path.startsWith('/api/v2/api/v2/')) {
          log("debug", `[system] [path check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取，相当于移除第一个
          path = path.substring('/api/v2'.length);
      }

      // 打印日志：只有在发生清理时才显示清理后的路径，否则显示"无需清理"
      if (path !== pathBeforeCleanup) {
          log("debug", `[system] [path check] Path after cleanup: "${path}"`);
      } else {
          log("debug", `[system] [path check] Path after cleanup: No cleanup needed.`);
      }

      // 补全：如果路径缺少前缀（例如请求原始路径为 /search/anime 或 /v2/search/anime），则智能补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs')
        && !path.startsWith('/api/env') && !path.startsWith('/api/cache')
        && !path.startsWith('/api/cookie') && !path.startsWith('/api/config')
        && !path.startsWith('/api/title-mapping') && !path.startsWith('/api/auto-match-mapping')) {
          if (path.startsWith('/v2/') || path === '/v2') {
              log("debug", `[system] [path check] Path is missing /api prefix. Adding /api...`);
              path = '/api' + path;
          } else if (path.startsWith('/api/') || path === '/api') {
              log("debug", `[system] [path check] Path is missing /v2 prefix. Adding /v2...`);
              path = '/api/v2' + path.substring(4);
          } else {
              log("debug", `[system] [path check] Path is missing /api/v2 prefix. Adding /api/v2...`);
              path = '/api/v2' + (path.startsWith('/') ? path : '/' + path);
          }
      }

      // 打印日志：只有在发生添加前缀时才显示添加后的路径，否则显示"无需补全"
      if (path === pathBeforePrefixCheck) {
          log("debug", `[system] [path check] Prefix Check: No prefix addition needed.`);
      }

      log("debug", `[system] [path check] Final normalized path: "${path}"`);
  }

  // GET /
  if (path === "/" && method === "GET") {
    return handleUI();
  }

  // GET /api/v2/search/anime
  if (path === "/api/v2/search/anime" && method === "GET") {
    log('info', '[system] [player-request] ' + JSON.stringify({ method, endpoint: path,
      keyword: url.searchParams.get('keyword'), fileName: url.searchParams.get('fileName'),
      season: url.searchParams.get('season'), episode: url.searchParams.get('episode'),
      userAgent: req.headers.get('user-agent'), clientIp }));
    return searchAnime(url, null, null, null, null, false, null, null, null, clientIp);
  }

  // GET /api/v2/search/episodes
  if (path === "/api/v2/search/episodes" && method === "GET") {
    log('info', '[system] [player-request] ' + JSON.stringify({ method, endpoint: path,
      anime: url.searchParams.get('anime'), episode: url.searchParams.get('episode'),
      userAgent: req.headers.get('user-agent'), clientIp }));
    return searchEpisodes(url, clientIp);
  }

  // GET|POST /api/v2/fongmi/danmaku
  if (path === "/api/v2/fongmi/danmaku" && (method === "GET" || method === "POST")) {
    return getFongmiDanmaku(url, req);
  }

  // GET|POST /danmaku
  if (path === "/danmaku" && (method === "GET" || method === "POST")) {
    return getFongmiDanmaku(url, req);
  }

  // GET /api/v2/match
  if (path === '/api/v2/match' && method !== 'POST') {
    log('info', '[system] [player-request] ' + JSON.stringify({ method, endpoint: path,
      fileName: url.searchParams.get('fileName'), userAgent: req.headers.get('user-agent'), clientIp }));
  }
  if (path === "/api/v2/match" && method === "POST") {
    return matchAnime(url, req, clientIp);
  }

  // GET /api/v2/bangumi/:animeId
  if (path.startsWith("/api/v2/bangumi/") && method === "GET") {
    log('info', '[system] [player-request] ' + JSON.stringify({ method, endpoint: '/api/v2/bangumi/:animeId',
      animeId: path.split('/').pop(), userAgent: req.headers.get('user-agent'), clientIp }));
    return getBangumi(path, null, url.searchParams.get('source'));
  }

  // GET /api/v2/comment/:commentId or /api/v2/comment?url=xxx or /api/v2/extcomment?url=xxx
  if ((path.startsWith("/api/v2/comment") || path.startsWith("/api/v2/extcomment")) && method === "GET") {
    const queryFormat = url.searchParams.get('format');
    const videoUrl = url.searchParams.get('url');
    const segmentFlagParam = url.searchParams.get('segmentflag');
    const durationParam = url.searchParams.get('duration');
    const segmentFlag = segmentFlagParam === 'true' || segmentFlagParam === '1';
    const includeDuration = durationParam === 'true' || durationParam === '1';
    log('info', '[system] [player-request] ' + JSON.stringify({ method, endpoint: '/api/v2/comment',
      commentId: videoUrl ? null : path.split('/').pop(), byUrl: Boolean(videoUrl), format: queryFormat,
      segmentFlag, userAgent: req.headers.get('user-agent'), clientIp }));

    if (!videoUrl && !path.startsWith('/api/v2/comment/')) {
      return jsonResponse({ errorCode: 400, success: false, errorMessage: 'Missing commentId or url parameter' }, 400);
    }
    const commentId = videoUrl ? null : Number(path.split('/').pop());
    const location = videoUrl || findUrlById(commentId);
    const cached = !segmentFlag && location && getCommentCache(resolveCommentCacheKey(location, commentId)) !== null;
    if (!cached && globals.rateLimitMaxRequests > 0) {
      const now = Date.now();
      cleanupExpiredIPs(now);
      const recent = (globals.requestHistory.get(clientIp) || []).filter(time => now - time <= 60000);
      if (recent.length >= globals.rateLimitMaxRequests) {
        return jsonResponse({ errorCode: 429, success: false, errorMessage: 'Too many requests, please try again later' }, 429);
      }
      recent.push(now);
      globals.requestHistory.set(clientIp, recent);
    }
    return videoUrl
      ? getCommentByUrl(videoUrl, queryFormat, segmentFlag, includeDuration, url.searchParams.get('animeTitle') || '')
      : getComment(path, queryFormat, segmentFlag, clientIp, includeDuration);
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
    return handleLogs(url.searchParams.get('format'));
  }

  // GET /api/logs/remote-mapping - 远程映射表专用日志（独立缓冲区，不被源站日志冲掉）
  if (path === "/api/logs/remote-mapping" && method === "GET") {
    return handleRemoteMappingLogs();
  }

  // POST /api/title-mapping/share: uses the same TOKEN as other configuration operations.
  if (path === '/api/title-mapping/share' && method === 'POST') {
    return handleMappingShare(req);
  }

  // POST /api/title-mapping/refresh - 手动刷新远程映射表
  if (path === "/api/title-mapping/refresh" && method === "POST") {
    return handleRemoteMappingRefresh();
  }

  // POST /api/auto-match-mapping/refresh - 手动刷新远程季集映射表
  if (path === "/api/auto-match-mapping/refresh" && method === "POST") {
    return handleRemoteAutoMatchMappingRefresh();
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


  return jsonResponse({ message: "Not found" }, 404);
}

export { handleRequest };
