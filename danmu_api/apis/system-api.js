import { Globals, globals } from "../configs/globals.js";
import { getEpisodeIdFloor, queryCacheKeys } from "../utils/cache-util.js";
import { jsonResponse } from "../utils/http-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";
import { formatLogMessage, log } from "../utils/log-util.js";
import { refreshRemoteTitleMappingNow } from "../utils/remote-title-mapping-util.js";
import { refreshRemoteAutoMatchMappingNow } from "../utils/auto-match-mapping-url-util.js";
import { HandlerFactory } from "../configs/handlers/handler-factory.js";
import { clearBangumiDataCache, initBangumiData } from "../utils/bangumi-data-util.js";
import { buildResultDiagnosis, clearTraceRecords, describeConfigValue, getInterfaceDetail, TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS } from "../utils/pipeline-trace.js";

const UI_THEMES = new Set([
  'lavender', 'shinyo', 'sakura', 'tianyi', 'hatsune', 'sakuragi', 'violet', 'amber'
]);

function resolveUiTheme(theme) {
  const normalizedTheme = String(theme || '').toLowerCase();
  return UI_THEMES.has(normalizedTheme) ? normalizedTheme : 'lavender';
}

export function handleUI() {
  const localDanmuCanUpload = globals.localDanmuNotRequireAdmin
    || (!!globals.adminToken && globals.currentToken === globals.adminToken);
  const html = HTML_TEMPLATE
    .replace("globals.currentToken", () => globals.currentToken)
    .replace("globals.uiTheme", resolveUiTheme(globals.uiTheme))
    .replace("globals.localDanmuCanUpload", String(localDanmuCanUpload))
    .replace("globals.localDanmuRedisValid", String(globals.redisValid === true))
    .replace("globals.localDanmuIsCloud", String(Boolean(globals.deployPlatform && globals.deployPlatform.toLowerCase() !== 'node')));

  return new Response(html, {
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
    description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔咪人韩巴狐乐西埋帆红弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/hf等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
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
    log("info", `[system] [server] Deployment request received for platform: ${deployPlatform}`);
    
    // 如果是 Node 部署，直接返回成功，因为 Node 环境不需要重新部署
    if (deployPlatform.toLowerCase() === 'node') {
      log("info", `[system] [server] Node/Docker deployment - no redeployment needed, config changes take effect automatically`);
      return jsonResponse({ success: true, message: "Node/Docker deployment - configuration changes take effect automatically" }, 200);
    }
    
    // 对于其他平台（如 Cloudflare、Vercel、Netlify 等），使用相应的 Handler 触发部署
    const handler = await HandlerFactory.getHandler(deployPlatform);
    if (!handler) {
      log("error", `[system] [server] No handler found for platform: ${deployPlatform}`);
      return jsonResponse({ success: false, message: `No handler found for platform: ${deployPlatform}` }, 400);
    }
    
    // 调用 handler 的 deploy 方法
    const deployResult = await handler.deploy();
    if (deployResult) {
      log("info", `[system] [server] Deployment triggered successfully for platform: ${deployPlatform}`);
      return jsonResponse({ success: true, message: "Deployment triggered successfully" }, 200);
    } else {
      log("error", `[system] [server] Failed to trigger deployment for platform: ${deployPlatform}`);
      return jsonResponse({ success: false, message: "Failed to trigger deployment" }, 500);
    }
  } catch (error) {
    log("error", `[system] [server] Deployment error: ${error.message}`);
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

/** 管理员手动刷新远程映射表 */
export async function handleRemoteMappingRefresh() {
  const result = await refreshRemoteTitleMappingNow();
  const { status, ...body } = result;
  return jsonResponse(body, status);
}

/** 管理员手动刷新远程季集映射表 */
export async function handleRemoteAutoMatchMappingRefresh() {
  const result = await refreshRemoteAutoMatchMappingNow();
  const { status, ...body } = result;
  return jsonResponse(body, status);
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
  // 各清理项对应的重置逻辑；请求记录与今日计数归入「请求历史记录」项
  const clearActions = {
    animes: () => { globals.animes = []; },
    episodeIds: () => { globals.episodeIds = []; },
    episodeNum: () => {}, // 在所有选中项清理完毕后，按剩余引用重置
    lastSelectMap: () => { globals.lastSelectMap = new Map(); }, // 重新创建 Map 对象
    // 清理搜索和弹幕缓存
    searchCache: () => { globals.searchCache = new Map(); },
    commentCache: () => { globals.commentCache = new Map(); },
    requestHistory: () => {
      globals.requestHistory = new Map();
      globals.reqRecords = []; // 清空请求记录
      globals.todayReqNum = 0; // 重置今日请求次数
      clearTraceRecords(); // 详情记录与请求记录同源，一并清空
    },
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
      clearActions[key]();
    }

    if (effectiveItems.includes('episodeNum')) globals.episodeNum = getEpisodeIdFloor();
    log("info", `[system] [server] Memory cache cleared successfully`);

    // 显式清理仅写选中键，不携带默认收藏或未读取的其他查询数据。
    const keys = queryCacheKeys.filter(key => effectiveItems.includes(key)
      || (effectiveItems.includes('requestHistory') && ['reqRecords', 'todayReqNum', 'pipelineTraces'].includes(key)));
    const failedBackends = [];
    const restartBackends = [];
    if (keys.length) {
      const targets = [
        ['file', globals.localCacheValid && globals.localCacheEnabled !== false, async () => (await import('../utils/cache-util.js')).updateLocalCaches({ keys, force: true })],
        ['upstash', globals.redisUrl && globals.redisToken, async () => (await import('../utils/redis-util.js')).updateRedisCaches({ keys, force: true, timeoutMs: 5000 })],
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
      if (key === "requestHistory") {
        clearedItems.requestHistory = 0;
        clearedItems.reqRecords = 0;
        clearedItems.todayReqNum = 0;
        clearedItems.pipelineTraces = 0;
      } else if (key === "episodeNum") {
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

// 判断当前请求是否携带 ADMIN_TOKEN；未配置 ADMIN_TOKEN 时不得把无 token 请求当作 admin
function hasAdminToken() {
  return !!globals.adminToken && globals.currentToken === globals.adminToken;
}

// 隐藏客户端 IP 中除 . 外的字符，保留 IP 结构
function maskClientIp(clientIp) {
  return typeof clientIp === 'string' ? clientIp.replace(/[^.]/g, '*') : clientIp;
}

// 隐藏接口 URL 查询串中的参数值，保留路径与参数名（key=value -> key=***）
function maskInterfaceValues(interfaceStr) {
  const qIndex = interfaceStr.indexOf('?');
  if (qIndex === -1) return interfaceStr; // 无查询串，保持原样
  const path = interfaceStr.slice(0, qIndex);
  const query = interfaceStr.slice(qIndex + 1);
  // 逐个把 key=value 的 value 替换为 ***，保留 key
  const maskedQuery = query.replace(/([^&=]+)=([^&]*)/g, (_, key) => `${key}=***`);
  return `${path}?${maskedQuery}`;
}

// 步骤取值脱敏：数量与布尔不泄露内容可保留，ID 与文本一律打码
// ID 类字段能反推用户请求的具体条目，按字段名识别而非按类型
function maskStepValues(value, key) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => maskStepValues(item, key));
  if (typeof value === 'object') {
    const out = {};
    for (const name of Object.keys(value)) out[name] = maskStepValues(value[name], name);
    return out;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return /[Ii][Dd]$/.test(key || '') ? '***' : value;
  return '***';
}

// 递归隐藏叶子值并保留 key 与数组/对象结构；叶子策略区分请求参数与取值明细
function maskLeaves(value, maskLeaf) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => maskLeaves(item, maskLeaf));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = maskLeaves(value[key], maskLeaf);
    return out;
  }
  return maskLeaf(value);
}

// 请求参数的所有叶子值统一脱敏
function maskParamValues(value) {
  return maskLeaves(value, () => '***');
}

// 取值明细只隐藏文本，保留计数与布尔标记
function maskChangeValues(value) {
  return maskLeaves(value, leaf => typeof leaf === 'string' ? '***' : leaf);
}

// 表格只隐藏单元格文本，保留列名与数值，使非管理员仍能看到结构
function maskTable(table) {
  if (!table || !Array.isArray(table.rows)) return table;
  return { ...table, rows: maskChangeValues(table.rows) };
}

// 请求者信息在请求记录与接口详情中按同一规则脱敏
function maskRequesterFields(record) {
  const masked = { ...record };
  if (masked.clientIp) masked.clientIp = maskClientIp(masked.clientIp);
  if (typeof masked.interface === 'string') masked.interface = maskInterfaceValues(masked.interface);
  for (const key of ['path', 'query']) {
    if (typeof masked[key] === 'string') masked[key] = maskInterfaceValues(masked[key]);
  }
  return masked;
}

// 隐藏追踪记录中的请求者信息与步骤数据，保留字段结构和配置覆盖取值
function maskTraceForNonAdmin(trace) {
  const steps = trace.steps.map(step => {
    const masked = { ...step };
    if (masked.inputs !== undefined) masked.inputs = maskStepValues(masked.inputs);
    if (masked.outputs !== undefined) masked.outputs = maskStepValues(masked.outputs);
    if (masked.error !== undefined) masked.error = maskStepValues(masked.error);
    if (masked.table !== undefined) masked.table = maskTable(masked.table);
    if (masked.changes !== undefined) {
      masked.changes = masked.changes.map(change => ({
        ...change,
        context: maskChangeValues(change.context),
        before: maskChangeValues(change.before),
        after: maskChangeValues(change.after),
        kept: maskChangeValues(change.kept),
        removed: maskChangeValues(change.removed),
        table: maskTable(change.table),
      }));
    }
    return masked;
  });
  return { ...maskRequesterFields(trace), steps };
}

/**
 * 处理获取请求记录的请求
 * @returns {Response} 包含请求记录的响应
 */
export function handleReqRecords() {
  // 返回请求记录，按时间倒序排列（最新的在前）
  let records = [...globals.reqRecords].reverse();
  const todayReqNum = globals.todayReqNum || 0;
  
  // 非 admin token 时，对请求记录脱敏：IP / 接口查询值 / 请求体值
  if (!hasAdminToken()) {
    records = records.map(record => {
      const masked = maskRequesterFields(record);
      if (masked.params != null) masked.params = maskParamValues(masked.params);
      return masked;
    });
  }
  
  return jsonResponse({ records, todayReqNum }, 200);
}

// 从步骤的候选数变化定位结果归零的位置，供弹窗直接给出排查结论
// 归零指候选数量由正数转为 0，且其后各步骤的候选数保持为 0；缓存未命中等瞬时 0 不计入
/**
 * 处理获取单条请求处理详情（接口详情）的请求
 * @param {string} id 追踪记录 id
 * @returns {Response} 包含该请求阶段耗时、全部配置覆盖、结果诊断与处理流水的 JSON 响应
 */
// 取配置当前取值：环境变量直接读 envs，运行态读类字段，两者都不经代理登记读取
function currentConfigValue(accessor) {
  const envs = Globals.envs || {};
  return accessor in envs ? envs[accessor] : Globals[accessor];
}

// 追踪记录里没有的配置按目录补齐为未读取，取值取当前配置
function describeTraceConfig(recorded, accessor) {
  return {
    value: recorded?.value ?? describeConfigValue(accessor, currentConfigValue(accessor)),
    used: recorded?.used ?? false,
    hit: recorded?.hit,
    step: recorded?.step ?? null,
    effectStep: recorded?.effectStep ?? null,
  };
}

export function handleInterfaceDetail(id) {
  const trace = getInterfaceDetail(id);
  if (!trace) {
    return jsonResponse({ success: false, errorCode: 404, errorMessage: '未找到该请求的接口详情' }, 404);
  }
  // 全部配置项按 envVarConfig 的分类与描述整理，运行态归入「运行环境」
  const envVarConfig = globals.envVarConfig || {};
  const configs = [
    ...Object.keys(TRACE_CONFIG_ACCESSORS).map(upName => {
      const accessor = TRACE_CONFIG_ACCESSORS[upName];
      const meta = envVarConfig[upName] || {};
      return {
        name: upName,
        accessor,
        category: meta.category || 'system',
        description: meta.description || '',
        ...describeTraceConfig(trace.configs[accessor], accessor),
      };
    }),
    ...Object.keys(TRACE_RUNTIME_ACCESSORS).map(name => {
      const accessor = TRACE_RUNTIME_ACCESSORS[name];
      return {
        name,
        accessor,
        category: 'runtime',
        description: '请求结束时的运行态，不属于环境变量配置',
        ...describeTraceConfig(trace.configs[accessor], accessor),
      };
    }),
  ];
  const detail = hasAdminToken() ? trace : maskTraceForNonAdmin(trace);
  // startedAt 与 finished 为入口计时与结束标记，不进入详情；其余追踪字段与配置覆盖一并透传
  const { startedAt, finished, ...publicTrace } = detail;
  return jsonResponse({
    trace: {
      ...publicTrace,
      query: publicTrace.query || '',
      configs,
      // 用已脱敏的步骤计算结论：管理员即原始数据，普通用户不会从结论中反推文本取值
      diagnosis: buildResultDiagnosis(detail.steps),
    },
  }, 200);
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
