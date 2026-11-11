import { globals } from "../configs/globals.js";
import { getEpisodeIdFloor, queryCacheKeys } from "../utils/cache-util.js";
import { jsonResponse } from "../utils/http-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";
import { formatLogMessage, log } from "../utils/log-util.js";
import { getRemoteMappingLogText, refreshRemoteTitleMappingNow } from "../utils/title-mapping-url-util.js";
import { refreshRemoteAutoMatchMappingNow } from "../utils/auto-match-mapping-url-util.js";

import { clearBangumiDataCache, initBangumiData } from "../utils/bangumi-data-util.js";
import { ugcSupplement } from '../utils/bilibili-ugc-util.js';

const UI_THEMES = new Set([
  'lavender', 'shinyo', 'sakura', 'tianyi', 'hatsune', 'sakuragi', 'violet', 'amber'
]);

function resolveUiTheme(theme) {
  const normalizedTheme = String(theme || '').toLowerCase();
  return UI_THEMES.has(normalizedTheme) ? normalizedTheme : 'lavender';
}

export function handleUI() {
  // 页头「当前版本」：优先显示发布流程注入的自用版本（xdanmu-v0.N），未注入时回退上游版本号。
  const selfVersion = String(globals.selfVersion || '').trim();
  const currentVersion = `v${selfVersion ? selfVersion.replace(/^xdanmu-v/i, '') : globals.version}`;

  const html = HTML_TEMPLATE
    .replace("'globals.currentToken'", () => JSON.stringify(globals.currentToken).replaceAll('<', '\\u003c'))
    .replace("globals.uiTheme", resolveUiTheme(globals.uiTheme))
    .replace("globals.currentVersion", () => currentVersion);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function handleConfig() {
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
    localRedisValid: globals.localRedisValid,
    deployPlatform: globals.deployPlatform
  };
  delete previewEnvVars.BILIBILI_UGC_BUDGET_MS;
  delete previewEnvVars.XDANMU_VERSION;

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

  const originalEnvVars = { ...globals.originalEnvVars };
  delete originalEnvVars.BILIBILI_UGC_BUDGET_MS;
  delete originalEnvVars.XDANMU_VERSION;

  return jsonResponse({
    message: "Welcome to the Xdanmu Danmu API server",
    version: globals.VERSION,
    envs: previewEnvVars, // 配置预览使用
    categorizedEnvVars: categorizedVars,
    envVarConfig: envVarConfig,
    originalEnvVars: originalEnvVars, // 通过 TOKEN 验证后提供完整配置供编辑。
    description: "基于上游 danmu_api 的个人自用弹幕 API，保留自用映射、过滤与日志功能，兼容弹弹play接口；仅维护 NAS Docker Compose 部署，镜像由本仓库 GitHub Actions 发布到 GHCR。"
  });
}

/**
 * 处理重新部署请求
 * @returns {Response} 部署操作结果
 */


/**
 * 处理获取日志的请求
 * @returns {Response} 包含日志文本的响应
 */
export function handleLogs(format = 'text') {
  if (format === 'json') {
    // 所有字段均取自已脱敏缓冲区。
    const entries = globals.logBuffer.map(entry => ({ ...entry }));
    const raw = JSON.stringify({ entries, capacity: globals.MAX_LOGS, logLevel: globals.logLevel });
    return new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const logText = globals.logBuffer
    .map(
      (log) =>
        `[${log.timestamp}] ${log.level}: ${formatLogMessage(log.message)}`
    )
    .join("\n");

  return new Response(logText, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * 处理远程映射表日志请求：独立缓冲区（最近 5000 条），不被源站日志冲掉
 * @returns {Response} 远程映射日志文本
 */
export function handleRemoteMappingLogs() {
  return new Response(getRemoteMappingLogText(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** 手动刷新远程映射表 */
export async function handleRemoteMappingRefresh() {
  const result = await refreshRemoteTitleMappingNow();
  return jsonResponse(result, result.success ? 200 : 502);
}

/** 手动刷新远程季集映射表 */
export async function handleRemoteAutoMatchMappingRefresh() {
  const result = await refreshRemoteAutoMatchMappingNow();
  return jsonResponse(result, result.success ? 200 : 502);
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
 * @param {Request} [req] 可选请求体 { items: string[] }，用于指定待清理项；未提供时清理全部已知项
 * @returns {Response} 表示操作结果的响应
 */
export async function handleClearCache(req) {
  const clearActions = {
    animes: () => { globals.animes = []; },
    episodeIds: () => { globals.episodeIds = []; },
    episodeNum: () => {}, // 在所有选中项清理完毕后，按剩余引用重置
    lastSelectMap: () => { globals.lastSelectMap = new Map(); }, // 重新创建 Map 对象
    // 清理搜索和弹幕缓存
    searchCache: () => { globals.searchCache = new Map(); },
    commentCache: () => { globals.commentCache = new Map(); ugcSupplement.clear(); },
    requestHistory: () => { globals.requestHistory = new Map(); },
    bangumiData: () => {
      try {
        clearBangumiDataCache(true); // 清理 Bangumi-Data 内存与磁盘缓存
        if (globals.useBangumiData) {
          // 触发异步数据重载
          initBangumiData(globals.deployPlatform, false).catch(e => {
            log("warn", `[system] [server] Bangumi-Data background reload failed: ${e.message}`);
          });
        }
      } catch (e) {
        log("error", `[system] [server] Failed to clear Bangumi-Data cache: ${e.message}`);
      }
    },
    personSources: async () => {
      try {
        const { clearPersonSourceCache } = await import('../utils/person-source-cache.js');
        await clearPersonSourceCache();
      } catch (e) {
        log("error", `[system] [person-metadata] Failed to clear person source cache: ${e.message}`);
      }
    }
  };
  const allItems = Object.keys(clearActions);

  let effectiveItems;
  if (req) {
    let parsed = null;
    try {
      parsed = await req.json();
    } catch (e) {
      parsed = null;
    }
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    // 仅保留自身属性键，排除 __proto__ 等原型链键，避免误放行导致整次清理失败
    effectiveItems = items ? items.filter(key => Object.prototype.hasOwnProperty.call(clearActions, key)) : allItems;
  } else {
    effectiveItems = allItems;
  }

  try {
    for (const key of effectiveItems) {
      await clearActions[key]();
    }
    if (effectiveItems.includes('searchCache') && !effectiveItems.includes('personSources')) {
      await clearActions.personSources();
    }

    if (effectiveItems.includes('episodeNum')) globals.episodeNum = getEpisodeIdFloor();
    log("info", `[system] [server] Memory cache cleared successfully`);

    const keys = queryCacheKeys.filter(key => effectiveItems.includes(key));
    const failedBackends = [];
    const restartBackends = [];
    if (keys.length) {
      const targets = [
        ['file', globals.localCacheValid && globals.localCacheEnabled !== false, async () => (await import('../utils/cache-util.js')).updateLocalCaches({ keys, force: true })],
        ['localRedis', globals.deployPlatform === 'node' && globals.localRedisUrl, async () => (await import('../utils/local-redis-util.js')).updateLocalRedisCaches({ keys, force: true, timeoutMs: 5000 })]
      ];
      // 各后端独立清理，网络等待不串行累加；按固定顺序汇总部分失败。
      const results = await Promise.allSettled(targets.map(([, enabled, update]) => enabled ? update() : true));
      for (const [index, [backend, enabled]] of targets.entries()) {
        if (!enabled) continue;
        try {
          const result = results[index];
          if (result.status === 'rejected') throw result.reason;
          if (!result.value) throw new Error('保存未成功');
          // 只有完整清除查询快照才可直接解除保护；部分清除后需重启重读剩余键。
          if (keys.length === queryCacheKeys.length) globals.queryCacheWritable[backend] = true;
          else if (globals.queryCacheWritable[backend] === false) restartBackends.push(backend);
        } catch (error) {
          failedBackends.push(backend);
          log('warn', `[system] ${backend} 缓存清理保存失败: ${error.message}`);
        }
      }
    }

    const clearedItems = {};
    for (const key of effectiveItems) {
      if (key === "episodeNum") {
        clearedItems.episodeNum = globals.episodeNum;
      } else {
        clearedItems[key] = 0;
      }
    }

    if (failedBackends.length) {
      return jsonResponse({ success: false, message: `内存已清理，但 ${failedBackends.join(', ')} 保存失败；未保存的后端仍保留清理前数据，重启后会重新加载，请重试`, clearedItems, failedBackends }, 500);
    }
    const message = restartBackends.length
      ? `选中项已清理；${restartBackends.join(', ')} 仍保护未恢复的其他缓存，重启后重新读取，或清理全部查询缓存解除保护`
      : 'Cache cleared successfully';
    log('info', `[system] ${message}`);
    return jsonResponse({ success: true, message, clearedItems, restartRequired: restartBackends.length > 0 }, 200);
  } catch (error) {
    log("error", `[system] [server] Cache clear failed: ${error.message}`);
    return jsonResponse({ success: false, message: `Cache clear failed: ${error.message}` }, 500);
  }
}







/**
 * 处理获取最近 animes 缓存列表的请求
 * @returns {Response} 包含格式化后番剧及子源集数的 JSON 响应
 */
export function handleCacheAnimes() {
  try {
    const localAnimes = [...(globals.animes || [])].reverse();

    // 1. 预构建一个全局映射字典，提升查找效率
    const fullAnimeMap = new Map();
    localAnimes.forEach(a => {
      if (a?.source && a?.animeId) {
        fullAnimeMap.set(`${a.source}_${a.animeId}`, a);
      }
    });

    // 2. 视图层数据适配
    const formattedData = localAnimes
      .filter(anime => !anime.isHiddenChild)
      .map(anime => {
        // 兼容实体类与普通对象
        const animeJson = typeof anime.toJson === 'function' ? anime.toJson() : { ...anime };
        const { links = [], mergedChildren = [], ...rest } = animeJson;

        return {
          ...rest,
          episodes: rest.episodeCount || rest.episodes || 1,
          links,
          mergedChildren: mergedChildren.map(child => {
            const fullChild = fullAnimeMap.get(`${child.source}_${child.animeId}`);
            const fullChildJson = typeof fullChild?.toJson === 'function' ? fullChild.toJson() : fullChild;
            const fullLinks = (fullChildJson?.links?.length > 0) ? fullChildJson.links : (child.links || []);

            return {
              ...child,
              episodes: child.episodeCount || child.episodes || 1,
              links: fullLinks
            };
          })
        };
      });

    return jsonResponse({ success: true, data: formattedData }, 200);
  } catch (error) {
    log("error", `[system] [server] Fetch cache animes failed: ${error.message}`);
    return jsonResponse({ success: false, message: `获取缓存失败: ${error.message}` }, 500);
  }
}
