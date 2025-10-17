// 全局状态（Cloudflare 和 Vercel 都可能重用实例）
// ⚠️ 不是持久化存储，每次冷启动会丢失
const VERSION = "1.3.4";
let animes = [];
let episodeIds = [];
let episodeNum = 10001; // 全局变量，用于自增 ID

// 日志存储，最多保存 500 行
let logBuffer = [];
const MAX_LOGS = 500;
const MAX_ANIMES = 100;
const MAX_LAST_SELECT_MAP = 100;
const vodAllowedPlatforms = ["qiyi", "bilibili1", "imgo", "youku", "qq"];
const allowedPlatforms = ["qiyi", "bilibili1", "imgo", "youku", "qq", "renren", "hanjutv", "bahamut"];
let envs = {};
// 定义一个全局变量来记录每个 IP 地址的请求历史
const requestHistory = new Map();
// redis是否生效
let redisValid = false;
// 存储查询关键字上次选择的animeId，用于下次match自动匹配时优先选择该anime
let lastSelectMap = new Map();

// =====================
// 环境变量处理
// =====================

const DEFAULT_TOKEN = "87654321"; // 默认 token
let token = DEFAULT_TOKEN;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveToken(env) {
  if (env && env.TOKEN) return env.TOKEN;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.TOKEN) return process.env.TOKEN; // Vercel / Node
  return DEFAULT_TOKEN;
}

const DEFAULT_OTHER_SERVER = "https://api.danmu.icu"; // 默认 第三方弹幕服务器
let otherServer = DEFAULT_OTHER_SERVER;

function resolveOtherServer(env) {
  if (env && env.OTHER_SERVER) return env.OTHER_SERVER;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.OTHER_SERVER) return process.env.OTHER_SERVER; // Vercel / Node
  return DEFAULT_OTHER_SERVER;
}

const DEFAULT_VOD_SERVERS = "vod@https://www.caiji.cyou"; // 默认 vod站点配置，格式：名称@URL,名称@URL
let vodServers = [];

function resolveVodServers(env) {
  // 获取配置字符串
  let vodServersConfig = DEFAULT_VOD_SERVERS;
  if (env && env.VOD_SERVERS) {
    vodServersConfig = env.VOD_SERVERS;  // Cloudflare Workers
  } else if (typeof process !== "undefined" && process.env?.VOD_SERVERS) {
    vodServersConfig = process.env.VOD_SERVERS;  // Vercel / Node
  }

  // 解析配置：支持 "名称@URL,名称@URL" 格式
  if (!vodServersConfig || vodServersConfig.trim() === "") {
    return [];
  }

  const servers = vodServersConfig
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map((item, index) => {
      if (item.includes('@')) {
        const [name, url] = item.split('@').map(s => s.trim());
        return { name: name || `vod-${index + 1}`, url };
      } else {
        // 没有 @ 符号，自动生成名称
        return { name: `vod-${index + 1}`, url: item };
      }
    })
    .filter(server => server.url && server.url.length > 0);  // 过滤掉空 URL

  return servers;
}

const DEFAULT_BILIBILI_COOKIE = ""; // 默认 bilibili cookie
let bilibliCookie = DEFAULT_BILIBILI_COOKIE;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveBilibiliCookie(env) {
  if (env && env.BILIBILI_COOKIE) return env.BILIBILI_COOKIE;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.BILIBILI_COOKIE) return process.env.BILIBILI_COOKIE; // Vercel / Node
  return DEFAULT_BILIBILI_COOKIE;
}

// 优酷并发配置（默认 8）
const DEFAULT_YOUKU_CONCURRENCY = 8;
let youkuConcurrency = DEFAULT_YOUKU_CONCURRENCY;

function resolveYoukuConcurrency(env) {
  if (env && env.YOUKU_CONCURRENCY) {
    const n = parseInt(env.YOUKU_CONCURRENCY, 10);
    if (!Number.isNaN(n) && n > 0) return Math.min(n, 16);
  }
  if (typeof process !== "undefined" && process.env?.YOUKU_CONCURRENCY) {
    const n = parseInt(process.env.YOUKU_CONCURRENCY, 10);
    if (!Number.isNaN(n) && n > 0) return Math.min(n, 16);
  }
  return Math.min(DEFAULT_YOUKU_CONCURRENCY, 16);
}

const DEFAULT_SOURCE_ORDER = "360,vod,renren,hanjutv"; // 默认 源排序（不包含tencent，需要时请通过SOURCE_ORDER环境变量添加）
let sourceOrderArr = [];

function resolveSourceOrder(env, deployPlatform) {
  // 获取环境变量中的 SOURCE_ORDER 配置
  let sourceOrder = DEFAULT_SOURCE_ORDER;
  if (deployPlatform === "cloudflare" || deployPlatform === "vercel") {
      sourceOrder += ",bahamut";
  }

  if (env && env.SOURCE_ORDER) {
    sourceOrder = env.SOURCE_ORDER;  // Cloudflare Workers
  } else if (typeof process !== "undefined" && process.env?.SOURCE_ORDER) {
    sourceOrder = process.env.SOURCE_ORDER;  // Vercel / Node
  }

  // 解析并校验 sourceOrder（移除 vod2，因为已合并到 vod）
  const allowedSources = ['360', 'vod', "tencent", 'renren', "hanjutv", "bahamut"];

  // 转换为数组并去除空格，过滤无效项
  const orderArr = sourceOrder
    .split(',')
    .map(s => s.trim())  // 去除空格
    .filter(s => allowedSources.includes(s));  // 只保留有效来源

  // 如果没有有效的来源，使用默认顺序
  if (orderArr.length === 0) {
    return DEFAULT_SOURCE_ORDER.split(',').map(s => s.trim());
  }

  return orderArr;
}

const DEFAULT_PLATFORM_ORDER = ""; // 默认 自动匹配优选平台
let platformOrderArr = [];

function resolvePlatformOrder(env) {
  // 获取环境变量中的 PLATFORM_ORDER 配置
  let platformOrder = DEFAULT_PLATFORM_ORDER;

  if (env && env.PLATFORM_ORDER) {
    platformOrder = env.PLATFORM_ORDER;  // Cloudflare Workers
  } else if (typeof process !== "undefined" && process.env?.PLATFORM_ORDER) {
    platformOrder = process.env.PLATFORM_ORDER;  // Vercel / Node
  }

  // 转换为数组并去除空格，过滤无效项
  const orderArr = platformOrder
    .split(',')
    .map(s => s.trim())  // 去除空格
    .filter(s => allowedPlatforms.includes(s));  // 只保留有效来源

  // 如果没有有效的来源，使用默认顺序
  if (orderArr.length === 0) {
    return DEFAULT_PLATFORM_ORDER.split(',').map(s => s.trim());
  }

  orderArr.push(null);

  return orderArr;
}

const DEFAULT_EPISODE_TITLE_FILTER = "(特别|惊喜|纳凉)?企划|合伙人手记|超前|速览|vlog|reaction|纯享|加更|抢先|抢鲜|预告|花絮|" +
  "特辑|彩蛋|专访|幕后|直播|未播|衍生|番外|会员|片花|精华|看点|速看|解读|影评|解说|吐槽|盘点|拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|" +
  "花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|番外彩蛋|精彩片段|精彩看点|精彩回顾|精彩集锦|看点解析|看点预告|" +
  "NG镜头|NG花絮|番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|插曲|高光回顾|背景音乐|OST|音乐MV|歌曲MV|前季回顾|" +
  "剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|抢先看|抢先版|" +
  "试看版|短剧|精编|会员版|Plus|独家版|特别版|短片|陪看|高清正片|发布会|.{2,}篇|(?!.*(入局|破冰局|做局)).{2,}局|观察室|上班那点事儿|" +
  "周top|赛段|直拍|REACTION|VLOG|全纪录|开播|先导|总宣|展演|集锦|旅行日记"; // 默认 剧集标题正则过滤
let episodeTitleFilter;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveEpisodeTitleFilter(env) {
  // 获取默认关键字
  let keywords = DEFAULT_EPISODE_TITLE_FILTER;

  // 检查环境变量并扩展关键字
  if (env && env.EPISODE_TITLE_FILTER) {
    const customFilter = env.EPISODE_TITLE_FILTER.replace(/^\|+|\|+$/g, ''); // 去除前后 | 字符
    if (customFilter) {
      keywords = `${keywords}|${customFilter}`; // Cloudflare Workers
    }
  } else if (typeof process !== "undefined" && process.env?.EPISODE_TITLE_FILTER) {
    const customFilter = process.env.EPISODE_TITLE_FILTER.replace(/^\|+|\|+$/g, ''); // 去除前后 | 字符
    if (customFilter) {
      keywords = `${keywords}|${customFilter}`; // Vercel / Node
    }
  }

  try {
    // 尝试构建正则表达式，若失败则抛出异常
    new RegExp(keywords);
  } catch (error) {
    // 若正则构建失败，回退使用默认值
    log("warn", "Invalid EPISODE_TITLE_FILTER format, using default.");
    keywords = DEFAULT_EPISODE_TITLE_FILTER;
  }

  // 返回由过滤后的关键字生成的正则表达式
  return new RegExp(
    "^" +
    "(.*?)" +
    "(" + keywords + ")" + // 将关键字加入正则表达式中
    "(.*?)$"
  );
}

const DEFAULT_BLOCKED_WORDS = ""; // 默认 屏蔽词列表
let blockedWords = DEFAULT_BLOCKED_WORDS;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveBlockedWords(env) {
  if (env && env.BLOCKED_WORDS) return env.BLOCKED_WORDS;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.BLOCKED_WORDS) return process.env.BLOCKED_WORDS; // Vercel / Node
  return DEFAULT_BLOCKED_WORDS;
}

// 分钟内合并去重（默认 1，最大值30，0表示不去重）
const DEFAULT_GROUP_MINUTE = 1;
let groupMinute = DEFAULT_GROUP_MINUTE;

function resolveGroupMinute(env) {
  if (env && env.GROUP_MINUTE) {
    const n = parseInt(env.GROUP_MINUTE, 10);
    if (!Number.isNaN(n) && n >= 0) return Math.min(n, 30);
  }
  if (typeof process !== "undefined" && process.env?.GROUP_MINUTE) {
    const n = parseInt(process.env.GROUP_MINUTE, 10);
    if (!Number.isNaN(n) && n >= 0) return Math.min(n, 30);
  }
  return Math.min(DEFAULT_GROUP_MINUTE, 30);
}

const DEFAULT_PROXY_URL = ""; // 默认 代理地址
let proxyUrl = DEFAULT_PROXY_URL;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveProxyUrl(env) {
  if (env && env.PROXY_URL) return env.PROXY_URL;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.PROXY_URL) return process.env.PROXY_URL; // Vercel / Node
  return DEFAULT_PROXY_URL;
}

const DEFAULT_UPSTASH_REDIS_REST_URL = ""; // 默认 upstash redis url
let redisUrl = DEFAULT_UPSTASH_REDIS_REST_URL;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveRedisUrl(env) {
  if (env && env.UPSTASH_REDIS_REST_URL) return env.UPSTASH_REDIS_REST_URL;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.UPSTASH_REDIS_REST_URL) return process.env.UPSTASH_REDIS_REST_URL; // Vercel / Node
  return DEFAULT_UPSTASH_REDIS_REST_URL;
}

const DEFAULT_UPSTASH_REDIS_REST_TOKEN = ""; // 默认 upstash redis url
let redisToken = DEFAULT_UPSTASH_REDIS_REST_TOKEN;

// 这里既支持 Cloudflare env，也支持 Node process.env
function resolveRedisToken(env) {
  if (env && env.UPSTASH_REDIS_REST_TOKEN) return env.UPSTASH_REDIS_REST_TOKEN;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.UPSTASH_REDIS_REST_TOKEN) return process.env.UPSTASH_REDIS_REST_TOKEN; // Vercel / Node
  return DEFAULT_UPSTASH_REDIS_REST_TOKEN;
}

// 限流配置：时间窗口内最大请求次数（默认 3，0表示不限流）
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 3;
let rateLimitMaxRequests = DEFAULT_RATE_LIMIT_MAX_REQUESTS;

function resolveRateLimitMaxRequests(env) {
  if (env && env.RATE_LIMIT_MAX_REQUESTS) {
    const n = parseInt(env.RATE_LIMIT_MAX_REQUESTS, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  if (typeof process !== "undefined" && process.env?.RATE_LIMIT_MAX_REQUESTS) {
    const n = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return DEFAULT_RATE_LIMIT_MAX_REQUESTS;
}

// =====================
// 数据结构处理函数
// =====================

// 添加元素到 episodeIds：检查 url 是否存在，若不存在则以自增 id 添加
function addEpisode(url, title) {
    // 检查是否已存在相同的 url 和 title
    const existingEpisode = episodeIds.find(episode => episode.url === url && episode.title === title);
    if (existingEpisode) {
        log("info", `Episode with URL ${url} and title ${title} already exists in episodeIds, returning existing episode.`);
        return existingEpisode; // 返回已存在的 episode
    }

    // 自增 episodeNum 并使用作为 id
    episodeNum++;
    const newEpisode = { id: episodeNum, url: url, title: title };

    // 添加新对象
    episodeIds.push(newEpisode);
    log("info", `Added to episodeIds: ${JSON.stringify(newEpisode)}`);
    return newEpisode; // 返回新添加的对象
}

// 删除指定 URL 的对象从 episodeIds
function removeEpisodeByUrl(url) {
    const initialLength = episodeIds.length;
    episodeIds = episodeIds.filter(episode => episode.url !== url);
    const removedCount = initialLength - episodeIds.length;
    if (removedCount > 0) {
        log("info", `Removed ${removedCount} episode(s) from episodeIds with URL: ${url}`);
        return true;
    }
    log("error", `No episode found in episodeIds with URL: ${url}`);
    return false;
}

// 根据 ID 查找 URL
function findUrlById(id) {
    const episode = episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `Found URL for ID ${id}: ${episode.url}`);
        return episode.url;
    }
    log("error", `No URL found for ID: ${id}`);
    return null;
}

// 根据 ID 查找 TITLE
function findTitleById(id) {
    const episode = episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `Found TITLE for ID ${id}: ${episode.title}`);
        return episode.title;
    }
    log("error", `No TITLE found for ID: ${id}`);
    return null;
}

// 添加 anime 对象到 animes，并将其 links 添加到 episodeIds
function addAnime(anime) {
    // 确保 anime 有 links 属性且是数组
    if (!anime.links || !Array.isArray(anime.links)) {
        log("error", `Invalid or missing links in anime: ${JSON.stringify(anime)}`);
        return false;
    }

    // 创建 anime 的副本以避免修改原始对象
    const animeCopy = { ...anime, links: [] }; // 初始化 links 为空数组

    // 遍历 links，调用 addEpisode，并收集返回的对象
    const newLinks = [];
    anime.links.forEach(link => {
        if (link.url) {
            const episode = addEpisode(link.url, link.title);
            if (episode) {
                newLinks.push(episode); // 仅添加成功添加的 episode
            }
        } else {
            log("error", `Invalid link in anime, missing url: ${JSON.stringify(link)}`);
        }
    });

    // 替换 animeCopy 的 links
    animeCopy.links = newLinks;

    // 添加到 animes
    animes.push(animeCopy);
    log("info", `Added anime: ${JSON.stringify(animeCopy)}`);

    // 检查是否超过 MAX_ANIMES，超过则删除最早的
    if (animes.length > MAX_ANIMES) {
        removeEarliestAnime();
    }

    return true;
}

// 删除最早添加的 anime，并从 episodeIds 删除其 links 中的 url
function removeEarliestAnime() {
    if (animes.length === 0) {
        log("error", "No animes to remove.");
        return false;
    }

    // 移除最早的 anime（第一个元素）
    const removedAnime = animes.shift();
    log("info", `Removed earliest anime: ${JSON.stringify(removedAnime)}`);

    // 从 episodeIds 删除该 anime 的所有 links 中的 url
    if (removedAnime.links && Array.isArray(removedAnime.links)) {
        removedAnime.links.forEach(link => {
            if (link.url) {
                removeEpisodeByUrl(link.url);
            }
        });
    }

    return true;
}

// 将所有动漫的 animeId 存入 lastSelectMap 的 animeIds 数组中
function storeAnimeIdsToMap(curAnimes, key) {
    const uniqueAnimeIds = new Set();
    for (const anime of curAnimes) {
        uniqueAnimeIds.add(anime.animeId);
    }

    // 保存旧的prefer值
    const oldPrefer = lastSelectMap[key]?.prefer;

    // 如果key已存在，先删除它（为了更新顺序）
    if (lastSelectMap[key]) {
        delete lastSelectMap[key];
    }

    // 添加新记录，保留prefer字段
    lastSelectMap[key] = {
        animeIds: [...uniqueAnimeIds],
        ...(oldPrefer !== undefined && { prefer: oldPrefer })
    };

    // 检查大小限制
    const keys = Object.keys(lastSelectMap);
    if (keys.length > MAX_LAST_SELECT_MAP) {
        // 删除最早的记录（第一个key）
        delete lastSelectMap[keys[0]];
    }
}

// 根据给定的 commentId 查找对应的 animeId
function findAnimeIdByCommentId(commentId) {
  for (const anime of animes) {
    for (const link of anime.links) {
      if (link.id === commentId) {
        return anime.animeId;
      }
    }
  }
  return null;
}

// 通过 animeId 查找 lastSelectMap 中 animeIds 包含该 animeId 的 key，并设置其 prefer 为 animeId
function setPreferByAnimeId(animeId) {
  for (const key in lastSelectMap) {
    if (lastSelectMap[key].animeIds.includes(animeId)) {
      lastSelectMap[key].prefer = animeId;
      return key; // 返回被修改的 key
    }
  }
  return null; // 如果没有找到匹配的 key，返回 null
}

// 通过title查询优选animeId
function getPreferAnimeId(title) {
  if (!lastSelectMap[title] || !lastSelectMap[title]["prefer"]) {
    return null;
  }
  return lastSelectMap[title]["prefer"];
}

// =====================
// 请求工具方法
// =====================

async function httpGet(url, options) {
  log("info", `[iOS模拟] HTTP GET: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...options.headers,
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    let data;

    if (options.base64Data) {
      log("info", "base64模式");

      // 先拿二进制
      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 转换为 Base64
      let binary = '';
      const chunkSize = 0x8000; // 分块防止大文件卡死
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        let chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      data = btoa(binary); // 得到 base64 字符串

    } else if (options.zlibMode) {
      log("info", "zlib模式")

      // 获取 ArrayBuffer
      const arrayBuffer = await response.arrayBuffer();

      // 使用 DecompressionStream 进行解压
      // "deflate" 对应 zlib 的 inflate
      const decompressionStream = new DecompressionStream("deflate");
      const decompressedStream = new Response(
        new Blob([arrayBuffer]).stream().pipeThrough(decompressionStream)
      );

      // 读取解压后的文本
      let decodedData;
      try {
        decodedData = await decompressedStream.text();
      } catch (e) {
        log("error", "[iOS模拟] 解压缩失败", e);
        throw e;
      }

      data = decodedData; // 更新解压后的数据
    } else {
      data = await response.text();
    }

    let parsedData;
    try {
      parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
    } catch (e) {
      parsedData = data;  // 如果解析失败，保留原始文本
    }

    // 获取所有 headers，但特别处理 set-cookie
    const headers = {};
    let setCookieValues = [];

    // 遍历 headers 条目
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        setCookieValues.push(value);
      } else {
        headers[key] = value;
      }
    }

    // 如果存在 set-cookie 头，将其合并为分号分隔的字符串
    if (setCookieValues.length > 0) {
      headers['set-cookie'] = setCookieValues.join(';');
    }
    // 模拟 iOS 环境：返回 { data: ... } 结构
    return {
      data: parsedData,
      status: response.status,
      headers: headers
    };

  } catch (error) {
    log("error", `[iOS模拟] 请求失败:`, error.message);
    log("error", '详细诊断:');
    log("error", '- URL:', url);
    log("error", '- 错误类型:', error.name);
    log("error", '- 消息:', error.message);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
    throw error;
  }
}

async function httpPost(url, body, options = {}) {
  log("info", `[iOS模拟] HTTP POST: ${url}`);

  // 处理请求头、body 和其他参数
  const { headers = {}, params, allow_redirects = true } = options;
  const fetchOptions = {
    method: 'POST',
    headers: {
      ...headers,
    },
    body: body
  };

  if (!allow_redirects) {
    fetchOptions.redirect = 'manual';  // 禁止重定向
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    let parsedData;
    try {
      parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
    } catch (e) {
      parsedData = data;  // 如果解析失败，保留原始文本
    }

    // 模拟 iOS 环境：返回 { data: ... } 结构
    return {
      data: parsedData,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    };

  } catch (error) {
    log("error", `[iOS模拟] 请求失败:`, error.message);
    log("error", '详细诊断:');
    log("error", '- URL:', url);
    log("error", '- 错误类型:', error.name);
    log("error", '- 消息:', error.message);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
    throw error;
  }
}

// =====================
// upstash redis 读写请求 （先简单实现，不加锁）
// =====================

// 使用 GET 发送简单命令（如 PING 检查连接）
async function pingRedis() {
  const url = `${redisUrl}/ping`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${redisToken}`
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
async function getRedisKey(key) {
  const url = `${redisUrl}/get/${key}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${redisToken}`
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

// 使用 POST 发送 SET 命令（写入键值，值在请求体中）
async function setRedisKey(key, value) {
  const url = `${redisUrl}/set/${key}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${redisToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)  // 值作为 body 发送，支持 JSON 或字符串
    });
    return await response.json();  // 预期: ["OK"]
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 复杂命令，如 SETEX（设置键值并过期，使用查询参数）
async function setRedisKeyWithExpiry(key, value, expirySeconds) {
  const url = `${redisUrl}/set/${key}?EX=${expirySeconds}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${redisToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return await response.json();
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 从redis获取变量数据
async function getCaches() {
    if (animes.length === 0) {
        log("info", 'getCaches start.');
        const [kv_animes, kv_episodeIds, kv_episodeNum, kv_logBuffer, kv_lastSelectMap] = await Promise.all([
          getRedisKey('animes'),
          getRedisKey('episodeIds'),
          getRedisKey('episodeNum'),
          getRedisKey('logBuffer'),
          getRedisKey('lastSelectMap'),
        ]);

        animes = kv_animes.result ? JSON.parse(kv_animes.result) : animes;
        episodeIds = kv_episodeIds.result ? JSON.parse(kv_episodeIds.result) : episodeIds;
        episodeNum = kv_episodeNum.result ? JSON.parse(kv_episodeNum.result) : episodeNum;
        logBuffer = kv_logBuffer.result ? JSON.parse(kv_logBuffer.result) : logBuffer;
        lastSelectMap = kv_lastSelectMap.result ? JSON.parse(kv_lastSelectMap.result) : lastSelectMap;
    }
}

// 存储更新后的变量到redis
async function updateCaches() {
    log("info", 'updateCaches start.');
    await Promise.all([
      setRedisKey('animes', animes),
      setRedisKey('episodeIds', episodeIds),
      setRedisKey('episodeNum', episodeNum),
      setRedisKey('logBuffer', logBuffer),
      setRedisKey('lastSelectMap', lastSelectMap)
    ]);
}

// =====================
// 中文繁简转化
// =====================

function charPYStr(){
    return '锕皑蔼碍爱嗳嫒瑷暧霭谙铵鹌肮袄奥媪骜鳌坝罢钯摆败呗颁办绊钣帮绑镑谤剥饱宝报鲍鸨龅辈贝钡狈备惫鹎贲锛绷笔毕毙币闭荜哔滗铋筚跸边编贬变辩辫苄缏笾标骠飑飙镖镳鳔鳖别瘪濒滨宾摈傧缤槟殡膑镔髌鬓饼禀拨钵铂驳饽钹鹁补钸财参蚕残惭惨灿骖黪苍舱仓沧厕侧册测恻层诧锸侪钗搀掺蝉馋谗缠铲产阐颤冁谄谶蒇忏婵骣觇禅镡场尝长偿肠厂畅伥苌怅阊鲳钞车彻砗尘陈衬伧谌榇碜龀撑称惩诚骋枨柽铖铛痴迟驰耻齿炽饬鸱冲冲虫宠铳畴踌筹绸俦帱雠橱厨锄雏础储触处刍绌蹰传钏疮闯创怆锤缍纯鹑绰辍龊辞词赐鹚聪葱囱从丛苁骢枞凑辏蹿窜撺错锉鹾达哒鞑带贷骀绐担单郸掸胆惮诞弹殚赕瘅箪当挡党荡档谠砀裆捣岛祷导盗焘灯邓镫敌涤递缔籴诋谛绨觌镝颠点垫电巅钿癫钓调铫鲷谍叠鲽钉顶锭订铤丢铥东动栋冻岽鸫窦犊独读赌镀渎椟牍笃黩锻断缎簖兑队对怼镦吨顿钝炖趸夺堕铎鹅额讹恶饿谔垩阏轭锇锷鹗颚颛鳄诶儿尔饵贰迩铒鸸鲕发罚阀珐矾钒烦贩饭访纺钫鲂飞诽废费绯镄鲱纷坟奋愤粪偾丰枫锋风疯冯缝讽凤沣肤辐抚辅赋复负讣妇缚凫驸绂绋赙麸鲋鳆钆该钙盖赅杆赶秆赣尴擀绀冈刚钢纲岗戆镐睾诰缟锆搁鸽阁铬个纥镉颍给亘赓绠鲠龚宫巩贡钩沟苟构购够诟缑觏蛊顾诂毂钴锢鸪鹄鹘剐挂鸹掴关观馆惯贯诖掼鹳鳏广犷规归龟闺轨诡贵刽匦刿妫桧鲑鳜辊滚衮绲鲧锅国过埚呙帼椁蝈铪骇韩汉阚绗颉号灏颢阂鹤贺诃阖蛎横轰鸿红黉讧荭闳鲎壶护沪户浒鹕哗华画划话骅桦铧怀坏欢环还缓换唤痪焕涣奂缳锾鲩黄谎鳇挥辉毁贿秽会烩汇讳诲绘诙荟哕浍缋珲晖荤浑诨馄阍获货祸钬镬击机积饥迹讥鸡绩缉极辑级挤几蓟剂济计记际继纪讦诘荠叽哜骥玑觊齑矶羁虿跻霁鲚鲫夹荚颊贾钾价驾郏浃铗镓蛲歼监坚笺间艰缄茧检碱硷拣捡简俭减荐槛鉴践贱见键舰剑饯渐溅涧谏缣戋戬睑鹣笕鲣鞯将浆蒋桨奖讲酱绛缰胶浇骄娇搅铰矫侥脚饺缴绞轿较挢峤鹪鲛阶节洁结诫届疖颌鲒紧锦仅谨进晋烬尽劲荆茎卺荩馑缙赆觐鲸惊经颈静镜径痉竞净刭泾迳弪胫靓纠厩旧阄鸠鹫驹举据锯惧剧讵屦榉飓钜锔窭龃鹃绢锩镌隽觉决绝谲珏钧军骏皲开凯剀垲忾恺铠锴龛闶钪铐颗壳课骒缂轲钶锞颔垦恳龈铿抠库裤喾块侩郐哙脍宽狯髋矿旷况诓诳邝圹纩贶亏岿窥馈溃匮蒉愦聩篑阃锟鲲扩阔蛴蜡腊莱来赖崃徕涞濑赉睐铼癞籁蓝栏拦篮阑兰澜谰揽览懒缆烂滥岚榄斓镧褴琅阆锒捞劳涝唠崂铑铹痨乐鳓镭垒类泪诔缧篱狸离鲤礼丽厉励砾历沥隶俪郦坜苈莅蓠呖逦骊缡枥栎轹砺锂鹂疠粝跞雳鲡鳢俩联莲连镰怜涟帘敛脸链恋炼练蔹奁潋琏殓裢裣鲢粮凉两辆谅魉疗辽镣缭钌鹩猎临邻鳞凛赁蔺廪檩辚躏龄铃灵岭领绫棂蛏鲮馏刘浏骝绺镏鹨龙聋咙笼垄拢陇茏泷珑栊胧砻楼娄搂篓偻蒌喽嵝镂瘘耧蝼髅芦卢颅庐炉掳卤虏鲁赂禄录陆垆撸噜闾泸渌栌橹轳辂辘氇胪鸬鹭舻鲈峦挛孪滦乱脔娈栾鸾銮抡轮伦仑沦纶论囵萝罗逻锣箩骡骆络荦猡泺椤脶镙驴吕铝侣屡缕虑滤绿榈褛锊呒妈玛码蚂马骂吗唛嬷杩买麦卖迈脉劢瞒馒蛮满谩缦镘颡鳗猫锚铆贸麽没镁门闷们扪焖懑钔锰梦眯谜弥觅幂芈谧猕祢绵缅渑腼黾庙缈缪灭悯闽闵缗鸣铭谬谟蓦馍殁镆谋亩钼呐钠纳难挠脑恼闹铙讷馁内拟腻铌鲵撵辇鲶酿鸟茑袅聂啮镊镍陧蘖嗫颟蹑柠狞宁拧泞苎咛聍钮纽脓浓农侬哝驽钕诺傩疟欧鸥殴呕沤讴怄瓯盘蹒庞抛疱赔辔喷鹏纰罴铍骗谝骈飘缥频贫嫔苹凭评泼颇钋扑铺朴谱镤镨栖脐齐骑岂启气弃讫蕲骐绮桤碛颀颃鳍牵钎铅迁签谦钱钳潜浅谴堑佥荨悭骞缱椠钤枪呛墙蔷强抢嫱樯戗炝锖锵镪羟跄锹桥乔侨翘窍诮谯荞缲硗跷窃惬锲箧钦亲寝锓轻氢倾顷请庆揿鲭琼穷茕蛱巯赇虮鳅趋区躯驱龋诎岖阒觑鸲颧权劝诠绻辁铨却鹊确阕阙悫让饶扰绕荛娆桡热韧认纫饪轫荣绒嵘蝾缛铷颦软锐蚬闰润洒萨飒鳃赛伞毵糁丧骚扫缫涩啬铯穑杀刹纱铩鲨筛晒酾删闪陕赡缮讪姗骟钐鳝墒伤赏垧殇觞烧绍赊摄慑设厍滠畲绅审婶肾渗诜谂渖声绳胜师狮湿诗时蚀实识驶势适释饰视试谥埘莳弑轼贳铈鲥寿兽绶枢输书赎属术树竖数摅纾帅闩双谁税顺说硕烁铄丝饲厮驷缌锶鸶耸怂颂讼诵擞薮馊飕锼苏诉肃谡稣虽随绥岁谇孙损笋荪狲缩琐锁唢睃獭挞闼铊鳎台态钛鲐摊贪瘫滩坛谭谈叹昙钽锬顸汤烫傥饧铴镗涛绦讨韬铽腾誊锑题体屉缇鹈阗条粜龆鲦贴铁厅听烃铜统恸头钭秃图钍团抟颓蜕饨脱鸵驮驼椭箨鼍袜娲腽弯湾顽万纨绾网辋韦违围为潍维苇伟伪纬谓卫诿帏闱沩涠玮韪炜鲔温闻纹稳问阌瓮挝蜗涡窝卧莴龌呜钨乌诬无芜吴坞雾务误邬庑怃妩骛鹉鹜锡牺袭习铣戏细饩阋玺觋虾辖峡侠狭厦吓硖鲜纤贤衔闲显险现献县馅羡宪线苋莶藓岘猃娴鹇痫蚝籼跹厢镶乡详响项芗饷骧缃飨萧嚣销晓啸哓潇骁绡枭箫协挟携胁谐写泻谢亵撷绁缬锌衅兴陉荥凶汹锈绣馐鸺虚嘘须许叙绪续诩顼轩悬选癣绚谖铉镟学谑泶鳕勋询寻驯训讯逊埙浔鲟压鸦鸭哑亚讶垭娅桠氩阉烟盐严岩颜阎艳厌砚彦谚验厣赝俨兖谳恹闫酽魇餍鼹鸯杨扬疡阳痒养样炀瑶摇尧遥窑谣药轺鹞鳐爷页业叶靥谒邺晔烨医铱颐遗仪蚁艺亿忆义诣议谊译异绎诒呓峄饴怿驿缢轶贻钇镒镱瘗舣荫阴银饮隐铟瘾樱婴鹰应缨莹萤营荧蝇赢颖茔莺萦蓥撄嘤滢潆璎鹦瘿颏罂哟拥佣痈踊咏镛优忧邮铀犹诱莸铕鱿舆鱼渔娱与屿语狱誉预驭伛俣谀谕蓣嵛饫阈妪纡觎欤钰鹆鹬龉鸳渊辕园员圆缘远橼鸢鼋约跃钥粤悦阅钺郧匀陨运蕴酝晕韵郓芸恽愠纭韫殒氲杂灾载攒暂赞瓒趱錾赃脏驵凿枣责择则泽赜啧帻箦贼谮赠综缯轧铡闸栅诈斋债毡盏斩辗崭栈战绽谵张涨帐账胀赵诏钊蛰辙锗这谪辄鹧贞针侦诊镇阵浈缜桢轸赈祯鸩挣睁狰争帧症郑证诤峥钲铮筝织职执纸挚掷帜质滞骘栉栀轵轾贽鸷蛳絷踬踯觯钟终种肿众锺诌轴皱昼骤纣绉猪诸诛烛瞩嘱贮铸驻伫槠铢专砖转赚啭馔颞桩庄装妆壮状锥赘坠缀骓缒谆准着浊诼镯兹资渍谘缁辎赀眦锱龇鲻踪总纵偬邹诹驺鲰诅组镞钻缵躜鳟翱并卜沉丑淀迭斗范干皋硅柜后伙秸杰诀夸里凌么霉捻凄扦圣尸抬涂洼喂污锨咸蝎彝涌游吁御愿岳云灶扎札筑于志注凋讠谫郄勐凼坂垅垴埯埝苘荬荮莜莼菰藁揸吒吣咔咝咴噘噼嚯幞岙嵴彷徼犸狍馀馇馓馕愣憷懔丬溆滟溷漤潴澹甯纟绔绱珉枧桊桉槔橥轱轷赍肷胨飚煳煅熘愍淼砜磙眍钚钷铘铞锃锍锎锏锘锝锪锫锿镅镎镢镥镩镲稆鹋鹛鹱疬疴痖癯裥襁耢颥螨麴鲅鲆鲇鲞鲴鲺鲼鳊鳋鳘鳙鞒鞴齄';
}
function ftPYStr(){
    return '錒皚藹礙愛噯嬡璦曖靄諳銨鵪骯襖奧媼驁鰲壩罷鈀擺敗唄頒辦絆鈑幫綁鎊謗剝飽寶報鮑鴇齙輩貝鋇狽備憊鵯賁錛繃筆畢斃幣閉蓽嗶潷鉍篳蹕邊編貶變辯辮芐緶籩標驃颮飆鏢鑣鰾鱉別癟瀕濱賓擯儐繽檳殯臏鑌髕鬢餅稟撥缽鉑駁餑鈸鵓補鈽財參蠶殘慚慘燦驂黲蒼艙倉滄廁側冊測惻層詫鍤儕釵攙摻蟬饞讒纏鏟產闡顫囅諂讖蕆懺嬋驏覘禪鐔場嘗長償腸廠暢倀萇悵閶鯧鈔車徹硨塵陳襯傖諶櫬磣齔撐稱懲誠騁棖檉鋮鐺癡遲馳恥齒熾飭鴟沖衝蟲寵銃疇躊籌綢儔幬讎櫥廚鋤雛礎儲觸處芻絀躕傳釧瘡闖創愴錘綞純鶉綽輟齪辭詞賜鶿聰蔥囪從叢蓯驄樅湊輳躥竄攛錯銼鹺達噠韃帶貸駘紿擔單鄲撣膽憚誕彈殫賧癉簞當擋黨蕩檔讜碭襠搗島禱導盜燾燈鄧鐙敵滌遞締糴詆諦綈覿鏑顛點墊電巔鈿癲釣調銚鯛諜疊鰈釘頂錠訂鋌丟銩東動棟凍崠鶇竇犢獨讀賭鍍瀆櫝牘篤黷鍛斷緞籪兌隊對懟鐓噸頓鈍燉躉奪墮鐸鵝額訛惡餓諤堊閼軛鋨鍔鶚顎顓鱷誒兒爾餌貳邇鉺鴯鮞發罰閥琺礬釩煩販飯訪紡鈁魴飛誹廢費緋鐨鯡紛墳奮憤糞僨豐楓鋒風瘋馮縫諷鳳灃膚輻撫輔賦復負訃婦縛鳧駙紱紼賻麩鮒鰒釓該鈣蓋賅桿趕稈贛尷搟紺岡剛鋼綱崗戇鎬睪誥縞鋯擱鴿閣鉻個紇鎘潁給亙賡綆鯁龔宮鞏貢鉤溝茍構購夠詬緱覯蠱顧詁轂鈷錮鴣鵠鶻剮掛鴰摑關觀館慣貫詿摜鸛鰥廣獷規歸龜閨軌詭貴劊匭劌媯檜鮭鱖輥滾袞緄鯀鍋國過堝咼幗槨蟈鉿駭韓漢闞絎頡號灝顥閡鶴賀訶闔蠣橫轟鴻紅黌訌葒閎鱟壺護滬戶滸鶘嘩華畫劃話驊樺鏵懷壞歡環還緩換喚瘓煥渙奐繯鍰鯇黃謊鰉揮輝毀賄穢會燴匯諱誨繪詼薈噦澮繢琿暉葷渾諢餛閽獲貨禍鈥鑊擊機積饑跡譏雞績緝極輯級擠幾薊劑濟計記際繼紀訐詰薺嘰嚌驥璣覬齏磯羈蠆躋霽鱭鯽夾莢頰賈鉀價駕郟浹鋏鎵蟯殲監堅箋間艱緘繭檢堿鹼揀撿簡儉減薦檻鑒踐賤見鍵艦劍餞漸濺澗諫縑戔戩瞼鶼筧鰹韉將漿蔣槳獎講醬絳韁膠澆驕嬌攪鉸矯僥腳餃繳絞轎較撟嶠鷦鮫階節潔結誡屆癤頜鮚緊錦僅謹進晉燼盡勁荊莖巹藎饉縉贐覲鯨驚經頸靜鏡徑痙競凈剄涇逕弳脛靚糾廄舊鬮鳩鷲駒舉據鋸懼劇詎屨櫸颶鉅鋦窶齟鵑絹錈鐫雋覺決絕譎玨鈞軍駿皸開凱剴塏愾愷鎧鍇龕閌鈧銬顆殼課騍緙軻鈳錁頷墾懇齦鏗摳庫褲嚳塊儈鄶噲膾寬獪髖礦曠況誆誑鄺壙纊貺虧巋窺饋潰匱蕢憒聵簣閫錕鯤擴闊蠐蠟臘萊來賴崍徠淶瀨賚睞錸癩籟藍欄攔籃闌蘭瀾讕攬覽懶纜爛濫嵐欖斕鑭襤瑯閬鋃撈勞澇嘮嶗銠鐒癆樂鰳鐳壘類淚誄縲籬貍離鯉禮麗厲勵礫歷瀝隸儷酈壢藶蒞蘺嚦邐驪縭櫪櫟轢礪鋰鸝癘糲躒靂鱺鱧倆聯蓮連鐮憐漣簾斂臉鏈戀煉練蘞奩瀲璉殮褳襝鰱糧涼兩輛諒魎療遼鐐繚釕鷯獵臨鄰鱗凜賃藺廩檁轔躪齡鈴靈嶺領綾欞蟶鯪餾劉瀏騮綹鎦鷚龍聾嚨籠壟攏隴蘢瀧瓏櫳朧礱樓婁摟簍僂蔞嘍嶁鏤瘺耬螻髏蘆盧顱廬爐擄鹵虜魯賂祿錄陸壚擼嚕閭瀘淥櫨櫓轤輅轆氌臚鸕鷺艫鱸巒攣孿灤亂臠孌欒鸞鑾掄輪倫侖淪綸論圇蘿羅邏鑼籮騾駱絡犖玀濼欏腡鏍驢呂鋁侶屢縷慮濾綠櫚褸鋝嘸媽瑪碼螞馬罵嗎嘜嬤榪買麥賣邁脈勱瞞饅蠻滿謾縵鏝顙鰻貓錨鉚貿麼沒鎂門悶們捫燜懣鍆錳夢瞇謎彌覓冪羋謐獼禰綿緬澠靦黽廟緲繆滅憫閩閔緡鳴銘謬謨驀饃歿鏌謀畝鉬吶鈉納難撓腦惱鬧鐃訥餒內擬膩鈮鯢攆輦鯰釀鳥蔦裊聶嚙鑷鎳隉蘗囁顢躡檸獰寧擰濘苧嚀聹鈕紐膿濃農儂噥駑釹諾儺瘧歐鷗毆嘔漚謳慪甌盤蹣龐拋皰賠轡噴鵬紕羆鈹騙諞駢飄縹頻貧嬪蘋憑評潑頗釙撲鋪樸譜鏷鐠棲臍齊騎豈啟氣棄訖蘄騏綺榿磧頎頏鰭牽釬鉛遷簽謙錢鉗潛淺譴塹僉蕁慳騫繾槧鈐槍嗆墻薔強搶嬙檣戧熗錆鏘鏹羥蹌鍬橋喬僑翹竅誚譙蕎繰磽蹺竊愜鍥篋欽親寢鋟輕氫傾頃請慶撳鯖瓊窮煢蛺巰賕蟣鰍趨區軀驅齲詘嶇闃覷鴝顴權勸詮綣輇銓卻鵲確闋闕愨讓饒擾繞蕘嬈橈熱韌認紉飪軔榮絨嶸蠑縟銣顰軟銳蜆閏潤灑薩颯鰓賽傘毿糝喪騷掃繅澀嗇銫穡殺剎紗鎩鯊篩曬釃刪閃陜贍繕訕姍騸釤鱔墑傷賞坰殤觴燒紹賒攝懾設厙灄畬紳審嬸腎滲詵諗瀋聲繩勝師獅濕詩時蝕實識駛勢適釋飾視試謚塒蒔弒軾貰鈰鰣壽獸綬樞輸書贖屬術樹豎數攄紓帥閂雙誰稅順說碩爍鑠絲飼廝駟緦鍶鷥聳慫頌訟誦擻藪餿颼鎪蘇訴肅謖穌雖隨綏歲誶孫損筍蓀猻縮瑣鎖嗩脧獺撻闥鉈鰨臺態鈦鮐攤貪癱灘壇譚談嘆曇鉭錟頇湯燙儻餳鐋鏜濤絳討韜鋱騰謄銻題體屜緹鵜闐條糶齠鰷貼鐵廳聽烴銅統慟頭鈄禿圖釷團摶頹蛻飩脫鴕馱駝橢籜鼉襪媧膃彎灣頑萬紈綰網輞韋違圍為濰維葦偉偽緯謂衛諉幃闈溈潿瑋韙煒鮪溫聞紋穩問閿甕撾蝸渦窩臥萵齷嗚鎢烏誣無蕪吳塢霧務誤鄔廡憮嫵騖鵡鶩錫犧襲習銑戲細餼鬩璽覡蝦轄峽俠狹廈嚇硤鮮纖賢銜閑顯險現獻縣餡羨憲線莧薟蘚峴獫嫻鷴癇蠔秈躚廂鑲鄉詳響項薌餉驤緗饗蕭囂銷曉嘯嘵瀟驍綃梟簫協挾攜脅諧寫瀉謝褻擷紲纈鋅釁興陘滎兇洶銹繡饈鵂虛噓須許敘緒續詡頊軒懸選癬絢諼鉉鏇學謔澩鱈勛詢尋馴訓訊遜塤潯鱘壓鴉鴨啞亞訝埡婭椏氬閹煙鹽嚴巖顏閻艷厭硯彥諺驗厴贗儼兗讞懨閆釅魘饜鼴鴦楊揚瘍陽癢養樣煬瑤搖堯遙窯謠藥軺鷂鰩爺頁業葉靨謁鄴曄燁醫銥頤遺儀蟻藝億憶義詣議誼譯異繹詒囈嶧飴懌驛縊軼貽釔鎰鐿瘞艤蔭陰銀飲隱銦癮櫻嬰鷹應纓瑩螢營熒蠅贏穎塋鶯縈鎣攖嚶瀅瀠瓔鸚癭頦罌喲擁傭癰踴詠鏞優憂郵鈾猶誘蕕銪魷輿魚漁娛與嶼語獄譽預馭傴俁諛諭蕷崳飫閾嫗紆覦歟鈺鵒鷸齬鴛淵轅園員圓緣遠櫞鳶黿約躍鑰粵悅閱鉞鄖勻隕運蘊醞暈韻鄆蕓惲慍紜韞殞氳雜災載攢暫贊瓚趲鏨贓臟駔鑿棗責擇則澤賾嘖幘簀賊譖贈綜繒軋鍘閘柵詐齋債氈盞斬輾嶄棧戰綻譫張漲帳賬脹趙詔釗蟄轍鍺這謫輒鷓貞針偵診鎮陣湞縝楨軫賑禎鴆掙睜猙爭幀癥鄭證諍崢鉦錚箏織職執紙摯擲幟質滯騭櫛梔軹輊贄鷙螄縶躓躑觶鐘終種腫眾鍾謅軸皺晝驟紂縐豬諸誅燭矚囑貯鑄駐佇櫧銖專磚轉賺囀饌顳樁莊裝妝壯狀錐贅墜綴騅縋諄準著濁諑鐲茲資漬諮緇輜貲眥錙齜鯔蹤總縱傯鄒諏騶鯫詛組鏃鉆纘躦鱒翺並蔔沈醜澱叠鬥範幹臯矽櫃後夥稭傑訣誇裏淩麽黴撚淒扡聖屍擡塗窪餵汙鍁鹹蠍彜湧遊籲禦願嶽雲竈紮劄築於誌註雕訁譾郤猛氹阪壟堖垵墊檾蕒葤蓧蒓菇槁摣咤唚哢噝噅撅劈謔襆嶴脊仿僥獁麅餘餷饊饢楞怵懍爿漵灩混濫瀦淡寧糸絝緔瑉梘棬案橰櫫軲軤賫膁腖飈糊煆溜湣渺碸滾瞘鈈鉕鋣銱鋥鋶鐦鐧鍩鍀鍃錇鎄鎇鎿鐝鑥鑹鑔穭鶓鶥鸌癧屙瘂臒襇繈耮顬蟎麯鮁鮃鮎鯗鯝鯴鱝鯿鰠鰵鱅鞽韝齇';
}

function traditionalized(cc){
    var str='';
    for(var i=0;i<cc.length;i++){
        if(charPYStr().indexOf(cc.charAt(i))!=-1)
            str+=ftPYStr().charAt(charPYStr().indexOf(cc.charAt(i)));
        else
            str+=cc.charAt(i);
    }
    return str;
}

function simplized(cc){
    var str='';
    for(var i=0;i<cc.length;i++){
        if(ftPYStr().indexOf(cc.charAt(i))!=-1)
            str+=charPYStr().charAt(ftPYStr().indexOf(cc.charAt(i)));
        else
            str+=cc.charAt(i);
    }
    return str;
}

// =====================
// 获取播放链接
// =====================

// 查询360kan影片信息
async function get360Animes(title) {
  try {
    const response = await httpGet(
      `https://api.so.360kan.com/index?force_v=1&kw=${encodeURIComponent(title)}&from=&pageno=1&v_ap=1&tab=all`,
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      }
    );

    const data = response.data;
    log("info", "360kan response:", data);

    let animes = [];
    if ('rows' in data.data.longData) {
      animes = data.data.longData.rows;
    }

    log("info", `360kan animes.length: ${animes.length}`);

    return animes;
  } catch (error) {
    log("error", "get360Animes error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

// 查询360kan综艺详情
async function get360Zongyi(title, entId, site, year) {
  try {
    let links = [];
    for (let j = 0; j <= 10; j++) {
      const response = await httpGet(
          `https://api.so.360kan.com/episodeszongyi?entid=${entId}&site=${site}&y=${year}&count=20&offset=${j * 20}`,
          {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
          }
      );

      const data = await response.data;
      log("info", "360kan zongyi response:", data);

      const episodeList = data.data.list;
      if (!episodeList) {
        break;
      }
      for (const episodeInfo of episodeList) {
        // Extract episode number from episodeInfo.name (e.g., "第10期下：地球团熟人局大胆开麦，做晚宴超催泪" -> "10")
        const epNumMatch = episodeInfo.name.match(/第(\d+)期([上中下])?/) || episodeInfo.period.match(/第(\d+)期([上中下])?/);
        let epNum = epNumMatch ? epNumMatch[1] : null;
        if (epNum && epNumMatch[2]) {
          epNum = epNumMatch[2] === "上" ? `${epNum}.1` :
                  epNumMatch[2] === "中" ? `${epNum}.2` : `${epNum}.3`;
        }

        links.push({
            "name": episodeInfo.id,
            "url": episodeInfo.url,
            "title": `【${site}】 #${episodeInfo.name} ${episodeInfo.period}#`,
            "sort": epNum || episodeInfo.sort || null
        });
      }

      log("info", `links.length: ${links.length}`);
    }
    // Sort links by pubdate numerically
    links.sort((a, b) => {
      if (!a.sort || !b.sort) return 0;
      const aNum = parseFloat(a.sort);
      const bNum = parseFloat(b.sort);
      return aNum - bNum;
    });

    return links;
  } catch (error) {
    log("error", "get360Animes error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

// 查询vod站点影片信息
async function getVodAnimes(title, server, serverName) {
  try {
    const response = await httpGet(
      `${server}/api.php/provide/vod/?ac=detail&wd=${title}&pg=1`,
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      }
    );
    // 检查 response.data.list 是否存在且长度大于 0
    if (response && response.data && response.data.list && response.data.list.length > 0) {
      log("info", `请求 ${serverName}(${server}) 成功`);
      const data = response.data;
      log("info", `${serverName} response: ↓↓↓`);
      printFirst200Chars(data);
      return { serverName, list: data.list };
    } else {
      log("info", `请求 ${serverName}(${server}) 成功，但 response.data.list 为空`);
      return { serverName, list: [] };
    }
  } catch (error) {
    log("error", `请求 ${serverName}(${server}) 失败:`, {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return { serverName, list: [] };
  }
}

// 查询所有vod站点影片信息（并发查询）
async function getVodAnimesFromAllServers(title, servers) {
  if (!servers || servers.length === 0) {
    return [];
  }

  // 并发查询所有服务器，使用 allSettled 确保单个服务器失败不影响其他服务器
  const promises = servers.map(server =>
    getVodAnimes(title, server.url, server.name)
  );

  const results = await Promise.allSettled(promises);

  // 过滤出成功的结果，即使某些服务器失败也不影响其他服务器
  return results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
}

// =====================
// 工具方法
// =====================

function printFirst200Chars(data) {
  let dataToPrint;

  if (typeof data === 'string') {
    dataToPrint = data;  // 如果是字符串，直接使用
  } else if (Array.isArray(data)) {
    dataToPrint = JSON.stringify(data);  // 如果是数组，转为字符串
  } else if (typeof data === 'object') {
    dataToPrint = JSON.stringify(data);  // 如果是对象，转为字符串
  } else {
    log("error", "Unsupported data type");
    return;
  }

  log("info", dataToPrint.slice(0, 200));  // 打印前200个字符
}

function groupDanmusByMinute(filteredDanmus, n) {
  // 如果 n 为 0，直接返回原始数据
  if (n === 0) {
    return filteredDanmus.map(danmu => ({
      ...danmu,
      t: danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0])
    }));
  }

  // 按 n 分钟分组
  const groupedByMinute = filteredDanmus.reduce((acc, danmu) => {
    // 获取时间：优先使用 t 字段，如果没有则使用 p 的第一个值
    const time = danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0]);
    // 计算分组（每 n 分钟一组，向下取整）
    const group = Math.floor(time / (n * 60));

    // 初始化分组
    if (!acc[group]) {
      acc[group] = [];
    }

    // 添加到对应分组
    acc[group].push({ ...danmu, t: time });
    return acc;
  }, {});

  // 处理每组的弹幕
  const result = Object.keys(groupedByMinute).map(group => {
    const danmus = groupedByMinute[group];

    // 按消息内容分组
    const groupedByMessage = danmus.reduce((acc, danmu) => {
      const message = danmu.m.split(' X')[0]; // 提取原始消息（去除 Xn 后缀）
      if (!acc[message]) {
        acc[message] = {
          count: 0,
          earliestT: danmu.t,
          cid: danmu.cid,
          p: danmu.p
        };
      }
      acc[message].count += 1;
      // 更新最早时间
      acc[message].earliestT = Math.min(acc[message].earliestT, danmu.t);
      return acc;
    }, {});

    // 转换为结果格式
    return Object.keys(groupedByMessage).map(message => {
      const data = groupedByMessage[message];
      return {
        cid: data.cid,
        p: data.p,
        m: data.count > 1 ? `${message} x ${data.count}` : message,
        t: data.earliestT
      };
    });
  });

  // 展平结果并按时间排序
  return result.flat().sort((a, b) => a.t - b.t);
}

function convertToDanmakuJson(contents, platform) {
  let danmus = [];
  let cidCounter = 1;

  // 统一处理输入为数组
  let items = [];
  if (typeof contents === "string") {
    // 处理 XML 字符串
    items = [...contents.matchAll(/<d p="([^"]+)">([^<]+)<\/d>/g)].map(match => ({
      p: match[1],
      m: match[2]
    }));
  } else if (contents && Array.isArray(contents.danmuku)) {
    // 处理 danmuku 数组，映射为对象格式
    const typeMap = { right: 1, top: 4, bottom: 5 };
    const hexToDecimal = (hex) => (hex ? parseInt(hex.replace("#", ""), 16) : 16777215);
    items = contents.danmuku.map(item => ({
      timepoint: item[0],
      ct: typeMap[item[1]] !== undefined ? typeMap[item[1]] : 1,
      color: hexToDecimal(item[2]),
      content: item[4]
    }));
  } else if (Array.isArray(contents)) {
    // 处理标准对象数组
    items = contents;
  }

  if (!items.length) {
    throw new Error("无效输入，需为 XML 字符串或弹幕数组");
  }

  for (const item of items) {
    let attributes, m;

    // 新增：处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      attributes = [
        (item.progress / 1000).toFixed(2), // progress 转换为秒
        item.mode || 1,
        item.color || 16777215,
        `[${platform}]`
      ].join(",");
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      attributes = [
        parseFloat(item.timepoint).toFixed(2),
        item.ct || 0,
        item.color || 16777215,
        `[${platform}]`
      ].join(",");
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      if (pValues.length === 4) {
        attributes = [
          parseFloat(pValues[0]).toFixed(2),
          pValues[1] || 0,
          pValues[2] || 16777215,
          `[${platform}]`
        ].join(",");
      } else {
        attributes = [
          parseFloat(pValues[0]).toFixed(2),
          pValues[1] || 0,
          pValues[3] || 16777215,
          `[${platform}]`
        ].join(",");
      }
      m = item.m;
    }

    danmus.push({ p: attributes, m, cid: cidCounter++ });
  }

  // 切割字符串成正则表达式数组
  const regexArray = blockedWords.split(/(?<=\/),(?=\/)/).map(str => {
    // 去除两端的斜杠并转换为正则对象
    const pattern = str.trim();
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        // 去除两边的 `/` 并转化为正则
        return new RegExp(pattern.slice(1, -1));
      } catch (e) {
        log("error", `无效的正则表达式: ${pattern}`, e);
        return null;
      }
    }
    return null; // 如果不是有效的正则格式则返回 null
  }).filter(regex => regex !== null); // 过滤掉无效的项

  log("info", "原始屏蔽词字符串:", blockedWords);
  const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
  log("info", "屏蔽词列表:", regexArrayToString(regexArray));

  // 过滤列表
  const filteredDanmus = danmus.filter(item => {
    return !regexArray.some(regex => regex.test(item.m)); // 针对 `m` 字段进行匹配
  });

  // 按n分钟内去重
  log("info", "去重分钟数:", groupMinute);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, groupMinute);

  log("info", "danmus_original:", danmus.length);
  log("info", "danmus_filter:", filteredDanmus.length);
  log("info", "danmus_group:", groupedDanmus.length);
  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(groupedDanmus.slice(0, 5), null, 2));
  return groupedDanmus;
}

function buildQueryString(params) {
  let queryString = '';

  // 遍历 params 对象的每个属性
  for (let key in params) {
    if (params.hasOwnProperty(key)) {
      // 如果 queryString 已经有参数了，则添加 '&'
      if (queryString.length > 0) {
        queryString += '&';
      }

      // 将 key 和 value 使用 encodeURIComponent 编码，并拼接成查询字符串
      queryString += encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }
  }

  return queryString;
}

function time_to_second(time) {
  const parts = time.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else {
    seconds = parts[0];
  }
  return seconds;
}

// md5.js 本地版本
function md5(message) {
  // --- UTF-8 转换 ---
  function toUtf8(str) {
    let utf8 = "";
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      if (charCode < 0x80) {
        utf8 += String.fromCharCode(charCode);
      } else if (charCode < 0x800) {
        utf8 += String.fromCharCode(0xc0 | (charCode >> 6));
        utf8 += String.fromCharCode(0x80 | (charCode & 0x3f));
      } else {
        utf8 += String.fromCharCode(0xe0 | (charCode >> 12));
        utf8 += String.fromCharCode(0x80 | ((charCode >> 6) & 0x3f));
        utf8 += String.fromCharCode(0x80 | (charCode & 0x3f));
      }
    }
    return utf8;
  }

  message = toUtf8(message);

  function rotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }

  function addUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
      else return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    } else return lResult ^ lX8 ^ lY8;
  }

  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }

  function FF(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function GG(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function HH(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function II(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function convertToWordArray(str) {
    const lMessageLength = str.length;
    const lNumberOfWords = (((lMessageLength + 8) >>> 6) + 1) * 16;
    const lWordArray = new Array(lNumberOfWords).fill(0);
    for (let i = 0; i < lMessageLength; i++) {
      lWordArray[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    }
    lWordArray[lMessageLength >> 2] |= 0x80 << ((lMessageLength % 4) * 8);
    lWordArray[lNumberOfWords - 2] = lMessageLength * 8;
    return lWordArray;
  }

  function wordToHex(lValue) {
    let wordToHexValue = "";
    for (let lCount = 0; lCount <= 3; lCount++) {
      const lByte = (lValue >>> (lCount * 8)) & 255;
      let wordToHexValueTemp = "0" + lByte.toString(16);
      wordToHexValue += wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
    }
    return wordToHexValue;
  }

  let x = convertToWordArray(message);
  let a = 0x67452301;
  let b = 0xEFCDAB89;
  let c = 0x98BADCFE;
  let d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    let AA = a, BB = b, CC = c, DD = d;

    // --- Round 1 ---
    a = FF(a, b, c, d, x[k + 0], 7, 0xD76AA478);
    d = FF(d, a, b, c, x[k + 1], 12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k + 2], 17, 0x242070DB);
    b = FF(b, c, d, a, x[k + 3], 22, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], 7, 0xF57C0FAF);
    d = FF(d, a, b, c, x[k + 5], 12, 0x4787C62A);
    c = FF(c, d, a, b, x[k + 6], 17, 0xA8304613);
    b = FF(b, c, d, a, x[k + 7], 22, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], 7, 0x698098D8);
    d = FF(d, a, b, c, x[k + 9], 12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k + 10], 17, 0xFFFF5BB1);
    b = FF(b, c, d, a, x[k + 11], 22, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], 7, 0x6B901122);
    d = FF(d, a, b, c, x[k + 13], 12, 0xFD987193);
    c = FF(c, d, a, b, x[k + 14], 17, 0xA679438E);
    b = FF(b, c, d, a, x[k + 15], 22, 0x49B40821);

    // --- Round 2 ---
    a = GG(a, b, c, d, x[k + 1], 5, 0xF61E2562);
    d = GG(d, a, b, c, x[k + 6], 9, 0xC040B340);
    c = GG(c, d, a, b, x[k + 11], 14, 0x265E5A51);
    b = GG(b, c, d, a, x[k + 0], 20, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], 5, 0xD62F105D);
    d = GG(d, a, b, c, x[k + 10], 9, 0x02441453);
    c = GG(c, d, a, b, x[k + 15], 14, 0xD8A1E681);
    b = GG(b, c, d, a, x[k + 4], 20, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], 5, 0x21E1CDE6);
    d = GG(d, a, b, c, x[k + 14], 9, 0xC33707D6);
    c = GG(c, d, a, b, x[k + 3], 14, 0xF4D50D87);
    b = GG(b, c, d, a, x[k + 8], 20, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], 5, 0xA9E3E905);
    d = GG(d, a, b, c, x[k + 2], 9, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k + 7], 14, 0x676F02D9);
    b = GG(b, c, d, a, x[k + 12], 20, 0x8D2A4C8A);

    // --- Round 3 ---
    a = HH(a, b, c, d, x[k + 5], 4, 0xFFFA3942);
    d = HH(d, a, b, c, x[k + 8], 11, 0x8771F681);
    c = HH(c, d, a, b, x[k + 11], 16, 0x6D9D6122);
    b = HH(b, c, d, a, x[k + 14], 23, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], 4, 0xA4BEEA44);
    d = HH(d, a, b, c, x[k + 4], 11, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k + 7], 16, 0xF6BB4B60);
    b = HH(b, c, d, a, x[k + 10], 23, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], 4, 0x289B7EC6);
    d = HH(d, a, b, c, x[k + 0], 11, 0xEAA127FA);
    c = HH(c, d, a, b, x[k + 3], 16, 0xD4EF3085);
    b = HH(b, c, d, a, x[k + 6], 23, 0x04881D05);
    a = HH(a, b, c, d, x[k + 9], 4, 0xD9D4D039);
    d = HH(d, a, b, c, x[k + 12], 11, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k + 15], 16, 0x1FA27CF8);
    b = HH(b, c, d, a, x[k + 2], 23, 0xC4AC5665);

    // --- Round 4 ---
    a = II(a, b, c, d, x[k + 0], 6, 0xF4292244);
    d = II(d, a, b, c, x[k + 7], 10, 0x432AFF97);
    c = II(c, d, a, b, x[k + 14], 15, 0xAB9423A7);
    b = II(b, c, d, a, x[k + 5], 21, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], 6, 0x655B59C3);
    d = II(d, a, b, c, x[k + 3], 10, 0x8F0CCC92);
    c = II(c, d, a, b, x[k + 10], 15, 0xFFEFF47D);
    b = II(b, c, d, a, x[k + 1], 21, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], 6, 0x6FA87E4F);
    d = II(d, a, b, c, x[k + 15], 10, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k + 6], 15, 0xA3014314);
    b = II(b, c, d, a, x[k + 13], 21, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], 6, 0xF7537E82);
    d = II(d, a, b, c, x[k + 11], 10, 0xBD3AF235);
    c = II(c, d, a, b, x[k + 2], 15, 0x2AD7D2BB);
    b = II(b, c, d, a, x[k + 9], 21, 0xEB86D391);

    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

function parseDanmakuBase64(base64) {
  const bytes = base64ToBytes(base64);
  const elems = [];

  let offset = 0;
  while (offset < bytes.length) {
    // 每个 DanmakuElem 在 elems 列表里是 length-delimited
    const key = bytes[offset++];
    if (key !== 0x0a) break; // field=1 (elems), wire=2
    const [msgBytes, nextOffset] = readLengthDelimited(bytes, offset);
    offset = nextOffset;

    let innerOffset = 0;
    const elem = {};

    while (innerOffset < msgBytes.length) {
      const tag = msgBytes[innerOffset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        // varint
        const [val, innerNext] = readVarint(msgBytes, innerOffset);
        innerOffset = innerNext;
        switch (fieldNumber) {
          case 1: elem.id = val; break;
          case 2: elem.progress = val; break;
          case 3: elem.mode = val; break;
          case 4: elem.fontsize = val; break;
          case 5: elem.color = val; break;
          case 8: elem.ctime = val; break;
          case 9: elem.weight = val; break;
          case 11: elem.pool = val; break;
          case 13: elem.attr = val; break;
          case 15: elem.like_num = val; break;
          case 17: elem.dm_type_v2 = val; break;
        }
      } else if (wireType === 2) {
        // length-delimited
        const [valBytes, innerNext] = readLengthDelimited(msgBytes, innerOffset);
        innerOffset = innerNext;
        switch (fieldNumber) {
          case 6: elem.midHash = utf8BytesToString(valBytes); break;
          case 7: elem.content = utf8BytesToString(valBytes); break;
          case 10: elem.action = utf8BytesToString(valBytes); break;
          case 12: elem.idStr = utf8BytesToString(valBytes); break;
          case 14: elem.animation = utf8BytesToString(valBytes); break;
          case 16: elem.color_v2 = utf8BytesToString(valBytes); break;
        }
      } else {
        // 其他类型不常用，忽略
        const [_, innerNext] = readVarint(msgBytes, innerOffset);
        innerOffset = innerNext;
      }
    }

    elems.push(elem);
  }

  return elems;
}

function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (true) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [Number(result), pos];
}

function readLengthDelimited(bytes, offset) {
  const [length, newOffset] = readVarint(bytes, offset);
  const start = newOffset;
  const end = start + length;
  const slice = bytes.slice(start, end);
  return [slice, end];
}

// 正则表达式：提取【】中的内容
const extractTitle = (title) => {
  const match = title.match(/【(.*?)】/);  // 匹配【】中的内容
  return match ? match[1] : null;  // 返回方括号中的内容，若没有匹配到，则返回null
};

// 提取##中的内容并进行匹配
const extractEpTitle = (title) => {
  const match = title.match(/#(.*?)#/);  // 提取#号之间的内容
  return match ? match[1] : null;  // 返回#号中的内容，若没有则返回null
};

// 解析fileName，提取动漫名称和平台偏好
function parseFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return { cleanFileName: '', preferredPlatform: '' };
  }

  const atIndex = fileName.indexOf('@');
  if (atIndex === -1) {
    // 没有@符号，直接返回原文件名
    return { cleanFileName: fileName.trim(), preferredPlatform: '' };
  }

  // 找到@符号，需要分离平台标识
  const beforeAt = fileName.substring(0, atIndex).trim();
  const afterAt = fileName.substring(atIndex + 1).trim();

  // 检查@符号后面是否有季集信息（如 S01E01）
  const seasonEpisodeMatch = afterAt.match(/^(\w+)\s+(S\d+E\d+)$/);
  if (seasonEpisodeMatch) {
    // 格式：动漫名称@平台 S01E01
    const platform = seasonEpisodeMatch[1];
    const seasonEpisode = seasonEpisodeMatch[2];
    return {
      cleanFileName: `${beforeAt} ${seasonEpisode}`,
      preferredPlatform: normalizePlatformName(platform)
    };
  } else {
    // 检查@符号前面是否有季集信息
    const beforeAtMatch = beforeAt.match(/^(.+?)\s+(S\d+E\d+)$/);
    if (beforeAtMatch) {
      // 格式：动漫名称 S01E01@平台
      const title = beforeAtMatch[1];
      const seasonEpisode = beforeAtMatch[2];
      return {
        cleanFileName: `${title} ${seasonEpisode}`,
        preferredPlatform: normalizePlatformName(afterAt)
      };
    } else {
      // 格式：动漫名称@平台（没有季集信息）
      return {
        cleanFileName: beforeAt,
        preferredPlatform: normalizePlatformName(afterAt)
      };
    }
  }
}

// 将用户输入的平台名称映射为标准平台名称
function normalizePlatformName(inputPlatform) {
  if (!inputPlatform || typeof inputPlatform !== 'string') {
    return '';
  }

  const input = inputPlatform.trim();

  // 直接返回输入的平台名称（如果有效）
  if (allowedPlatforms.includes(input)) {
    return input;
  }

  // 如果输入的平台名称无效，返回空字符串
  return '';
}

// 根据指定平台创建动态平台顺序
function createDynamicPlatformOrder(preferredPlatform) {
  if (!preferredPlatform) {
    return [...platformOrderArr]; // 返回默认顺序的副本
  }

  // 验证平台是否有效
  if (!allowedPlatforms.includes(preferredPlatform)) {
    log("warn", `Invalid platform: ${preferredPlatform}, using default order`);
    return [...platformOrderArr];
  }

  // 创建新的平台顺序，将指定平台放在最前面
  const dynamicOrder = [preferredPlatform];

  // 添加其他平台（排除已指定的平台）
  for (const platform of platformOrderArr) {
    if (platform !== preferredPlatform && platform !== null) {
      dynamicOrder.push(platform);
    }
  }

  // 最后添加 null（用于回退逻辑）
  dynamicOrder.push(null);

  return dynamicOrder;
}

// djb2 哈希算法将string转成id
function convertToAsciiSum(sid) {
  let hash = 5381;
  for (let i = 0; i < sid.length; i++) {
    hash = (hash * 33) ^ sid.charCodeAt(i);
  }
  hash = (hash >>> 0) % 9999999;
  // 确保至少 5 位
  return hash < 10000 ? hash + 10000 : hash;
}

// 基础加密函数 - 将字符串转换为星号
function encryptStr(str) {
  return '*'.repeat(str.length);
}

// =====================
// 腾讯视频搜索和分集
// =====================

/**
 * 搜索腾讯视频
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<Array>} 搜索结果数组
 */
async function tencentSearch(keyword) {
  try {
    log("info", `[Tencent] 开始搜索: ${keyword}`);

    const searchUrl = "https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2";
    const payload = {
      version: "25071701",
      clientType: 1,
      filterValue: "",
      uuid: "0379274D-05A0-4EB6-A89C-878C9A460426",
      query: keyword,
      retry: 0,
      pagenum: 0,
      isPrefetch: true,
      pagesize: 30,
      queryFrom: 0,
      searchDatakey: "",
      transInfo: "",
      isneedQc: true,
      preQid: "",
      adClientInfo: "",
      extraInfo: {
        multi_terminal_pc: "1",
        themeType: "1",
        sugRelatedIds: "{}",
        appVersion: ""
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'Origin': 'https://v.qq.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': `https://v.qq.com/x/search/?q=${encodeURIComponent(keyword)}&stag=&smartbox_ab=`,
      'H38': '220496a1fb1498325e9be6d938',
      'H42': '335a00a80ab9bbbef56793d8e7a97e87b9341dee34ebd83d61afc0cdb303214caaece3',
      'Uk': '8e91af25d3af99d0f0640327e7307666',
      'Cookie': 'tvfe_boss_uuid=ee8f05103d59226f; pgv_pvid=3155633511; video_platform=2; ptag=v_qq_com; main_login=qq'
    };

    const response = await httpPost(searchUrl, JSON.stringify(payload), { headers });

    if (!response || !response.data) {
      log("info", "[Tencent] 搜索响应为空");
      return [];
    }

    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    if (data.ret !== 0) {
      log("error", `[Tencent] API返回错误: ${data.msg} (ret: ${data.ret})`);
      return [];
    }

    let itemList = [];

    // 优先从 MainNeed box 获取结果
    if (data.data && data.data.areaBoxList) {
      for (const box of data.data.areaBoxList) {
        if (box.boxId === "MainNeed" && box.itemList) {
          log("info", `[Tencent] 从 MainNeed box 找到 ${box.itemList.length} 个项目`);
          itemList = box.itemList;
          break;
        }
      }
    }

    // 回退到 normalList
    if (itemList.length === 0 && data.data && data.data.normalList && data.data.normalList.itemList) {
      log("info", "[Tencent] MainNeed box 未找到，使用 normalList");
      itemList = data.data.normalList.itemList;
    }

    if (itemList.length === 0) {
      log("info", "[Tencent] 搜索无结果");
      return [];
    }

    // 过滤和处理搜索结果
    const results = [];
    for (const item of itemList) {
      const filtered = filterTencentSearchItem(item, keyword);
      if (filtered) {
        results.push(filtered);
      }
    }

    log("info", `[Tencent] 搜索找到 ${results.length} 个有效结果`);
    return results;

  } catch (error) {
    log("error", "[Tencent] 搜索出错:", error.message);
    return [];
  }
}

/**
 * 过滤腾讯视频搜索项
 * @param {Object} item - 搜索项
 * @param {string} keyword - 搜索关键词
 * @returns {Object|null} 过滤后的结果
 */
function filterTencentSearchItem(item, keyword) {
  if (!item.videoInfo || !item.doc) {
    return null;
  }

  const videoInfo = item.videoInfo;
  const mediaId = item.doc.id; // cid

  // 过滤无年份信息
  if (!videoInfo.year || videoInfo.year === 0) {
    return null;
  }

  // 过滤"全网搜"结果
  if (videoInfo.subTitle === "全网搜" || videoInfo.playFlag === 2) {
    return null;
  }

  // 清理标题(移除HTML标签)
  let title = videoInfo.title.replace(/<em>/g, '').replace(/<\/em>/g, '');

  if (!title || !mediaId) {
    return null;
  }

  // 内容类型过滤
  const contentType = videoInfo.typeName;
  if (contentType.includes("短剧")) {
    return null;
  }

  // 类型白名单(与360/vod保持一致,使用中文类型)
  const allowedTypes = ["电视剧", "动漫", "电影", "纪录片", "综艺", "综艺节目"];
  if (!allowedTypes.includes(contentType)) {
    return null;
  }

  // 过滤非腾讯视频内容
  const allSites = (videoInfo.playSites || []).concat(videoInfo.episodeSites || []);
  if (allSites.length > 0 && !allSites.some(site => site.enName === 'qq')) {
    return null;
  }

  // 电影非正片内容过滤
  if (contentType === "电影") {
    const nonFormalKeywords = ["花絮", "彩蛋", "幕后", "独家", "解说", "特辑", "探班", "拍摄", "制作", "导演", "记录", "回顾", "盘点", "混剪", "解析", "抢先"];
    if (nonFormalKeywords.some(kw => title.includes(kw))) {
      return null;
    }
  }

  const episodeCount = contentType === '电影' ? 1 : (videoInfo.subjectDoc ? videoInfo.subjectDoc.videoNum : 0);

  return {
    provider: "tencent",
    mediaId: mediaId,
    title: title,
    type: contentType,  // 使用中文类型,与360/vod保持一致
    year: videoInfo.year,
    imageUrl: videoInfo.imgUrl,
    episodeCount: episodeCount
  };
}

/**
 * 获取腾讯视频分集列表
 * @param {string} cid - 作品ID
 * @returns {Promise<Array>} 分集数组
 */
async function getTencentEpisodes(cid) {
  try {
    log("info", `[Tencent] 获取分集列表: cid=${cid}`);

    const episodesUrl = "https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vversion_name=8.2.96&vversion_platform=2";

    // 先获取分页信息
    const payload = {
      has_cache: 1,
      page_params: {
        req_from: "web_vsite",
        page_id: "vsite_episode_list",
        page_type: "detail_operation",
        id_type: "1",
        page_size: "",
        cid: cid,
        vid: "",
        lid: "",
        page_num: "",
        page_context: `cid=${cid}&detail_page_type=1&req_from=web_vsite&req_from_second_type=&req_type=0`,
        detail_page_type: "1"
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'Origin': 'https://v.qq.com',
      'Referer': `https://v.qq.com/x/cover/${cid}.html`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };

    const response = await httpPost(episodesUrl, JSON.stringify(payload), { headers });

    if (!response || !response.data) {
      log("info", "[Tencent] 分集响应为空");
      return [];
    }

    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    if (data.ret !== 0) {
      log("error", `[Tencent] 分集API返回错误: ret=${data.ret}`);
      return [];
    }

    // 解析分页tabs
    let tabs = [];
    if (data.data && data.data.module_list_datas) {
      for (const moduleListData of data.data.module_list_datas) {
        for (const moduleData of moduleListData.module_datas) {
          if (moduleData.module_params && moduleData.module_params.tabs) {
            try {
              tabs = JSON.parse(moduleData.module_params.tabs);
              break;
            } catch (e) {
              log("error", "[Tencent] 解析tabs失败:", e.message);
            }
          }
        }
        if (tabs.length > 0) break;
      }
    }

    if (tabs.length === 0) {
      log("info", "[Tencent] 未找到分页信息");
      return [];
    }

    log("info", `[Tencent] 找到 ${tabs.length} 个分页`);

    // 获取所有分页的分集
    const allEpisodes = [];
    for (const tab of tabs) {
      if (!tab.page_context) continue;

      const tabPayload = {
        has_cache: 1,
        page_params: {
          req_from: "web_vsite",
          page_id: "vsite_episode_list",
          page_type: "detail_operation",
          id_type: "1",
          page_size: "",
          cid: cid,
          vid: "",
          lid: "",
          page_num: "",
          page_context: tab.page_context,
          detail_page_type: "1"
        }
      };

      const tabResponse = await httpPost(episodesUrl, JSON.stringify(tabPayload), { headers });

      if (!tabResponse || !tabResponse.data) continue;

      const tabData = typeof tabResponse.data === "string" ? JSON.parse(tabResponse.data) : tabResponse.data;

      if (tabData.ret !== 0 || !tabData.data) continue;

      // 提取分集
      if (tabData.data.module_list_datas) {
        for (const moduleListData of tabData.data.module_list_datas) {
          for (const moduleData of moduleListData.module_datas) {
            if (moduleData.item_data_lists && moduleData.item_data_lists.item_datas) {
              for (const item of moduleData.item_data_lists.item_datas) {
                if (item.item_params && item.item_params.vid && item.item_params.is_trailer !== "1") {
                  allEpisodes.push({
                    vid: item.item_params.vid,
                    title: item.item_params.title,
                    unionTitle: item.item_params.union_title || item.item_params.title
                  });
                }
              }
            }
          }
        }
      }
    }

    log("info", `[Tencent] 共获取 ${allEpisodes.length} 集`);
    return allEpisodes;

  } catch (error) {
    log("error", "[Tencent] 获取分集出错:", error.message);
    return [];
  }
}

// =====================
// 获取腾讯弹幕
// =====================

async function fetchTencentVideo(inputUrl) {
  log("info", "开始从本地请求腾讯视频弹幕...", inputUrl);

  // 弹幕 API 基础地址
  const api_danmaku_base = "https://dm.video.qq.com/barrage/base/";
  const api_danmaku_segment = "https://dm.video.qq.com/barrage/segment/";

  // 解析 URL 获取 vid
  let vid;
  // 1. 尝试从查询参数中提取 vid
  const queryMatch = inputUrl.match(/[?&]vid=([^&]+)/);
  if (queryMatch) {
    vid = queryMatch[1]; // 获取 vid 参数值
  } else {
    // 2. 从路径末尾提取 vid
    const pathParts = inputUrl.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    vid = lastPart.split('.')[0]; // 去除文件扩展名
  }

  log("info", "vid:", vid);

  // 获取页面标题
  let res;
  try {
    res = await httpGet(inputUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
  } catch (error) {
    log("error", "请求页面失败:", error);
    return [];
  }

  // 使用正则表达式提取 <title> 标签内容
  const titleMatch = res.data.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].split("_")[0] : "未知标题";
  log("info", "标题:", title);

  // 获取弹幕基础数据
  try {
    res = await httpGet(api_danmaku_base + vid, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }
    log("error", "请求弹幕基础数据失败:", error);
    return [];
  }

  // 先把 res.data 转成 JSON
  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

  // 获取弹幕分段数据
  const promises = [];
  const segmentList = Object.values(data.segment_index);
  for (const item of segmentList) {
    promises.push(
      httpGet(`${api_danmaku_segment}${vid}/${item.segment_name}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      })
    );
  }

  log("info", "弹幕分段数量:", promises.length);

  // 解析弹幕数据
  let contents = [];
  try {
    const results = await Promise.allSettled(promises);
    const datas = results
      .filter(result => result.status === "fulfilled")
      .map(result => result.value.data);

    for (let data of datas) {
      data = typeof data === "string" ? JSON.parse(data) : data;
      for (const item of data.barrage_list) {
        const content = {
            timepoint: 0,	// 弹幕发送时间（秒）
            ct: 1,	// 弹幕类型，1-3 为滚动弹幕、4 为底部、5 为顶端、6 为逆向、7 为精确、8 为高级
            size: 25,	//字体大小，25 为中，18 为小
            color: 16777215,	//弹幕颜色，RGB 颜色转为十进制后的值，16777215 为白色
            unixtime: Math.floor(Date.now() / 1000),	//Unix 时间戳格式
            uid: 0,		//发送人的 id
            content: "",
        };
        content.timepoint = item.time_offset / 1000;
        if (item.content_style && item.content_style !== "") {
          try {
            const content_style = JSON.parse(item.content_style);
            // 优先使用渐变色的第一个颜色，否则使用基础色
            if (content_style.gradient_colors && content_style.gradient_colors.length > 0) {
              content.color = parseInt(content_style.gradient_colors[0].replace("#", ""), 16);
            } else if (content_style.color && content_style.color !== "ffffff") {
              content.color = parseInt(content_style.color.replace("#", ""), 16);
            }

            if (content_style.position) {
              if (content_style.position === 2) {
                content.ct = 5;
              } else if (content_style.position === 3) {
                content.ct = 4;
              }
            }
          } catch (e) {
            // JSON 解析失败，使用默认白色
          }
        }
        content.content = item.content;
        contents.push(content);
      }
    }
  } catch (error) {
    log("error", "解析弹幕数据失败:", error);
    return [];
  }

  printFirst200Chars(contents);

  // 返回结果
  return convertToDanmakuJson(contents, "tecent");
}

// =====================
// 获取爱奇艺弹幕
// =====================

async function fetchIqiyi(inputUrl) {
  log("info", "开始从本地请求爱奇艺弹幕...", inputUrl);

  // 弹幕 API 基础地址
  const api_decode_base = "https://pcw-api.iq.com/api/decode/";
  const api_video_info = "https://pcw-api.iqiyi.com/video/video/baseinfo/";
  const api_danmaku_base = "https://cmts.iqiyi.com/bullet/";

  // 解析 URL 获取 tvid
  let tvid;
  try {
    const idMatch = inputUrl.match(/v_(\w+)/);
    if (!idMatch) {
      log("error", "无法从 URL 中提取 tvid");
      return [];
    }
    tvid = idMatch[1];
    log("info", "tvid:", tvid);

    // 获取 tvid 的解码信息
    const decodeUrl = `${api_decode_base}${tvid}?platformId=3&modeCode=intl&langCode=sg`;
    let res = await httpGet(decodeUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    tvid = data.data.toString();
    log("info", "解码后 tvid:", tvid);
  } catch (error) {
    log("error", "请求解码信息失败:", error);
    return [];
  }

  // 获取视频基础信息
  let title, duration, albumid, categoryid;
  try {
    const videoInfoUrl = `${api_video_info}${tvid}`;
    const res = await httpGet(videoInfoUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const videoInfo = data.data;
    title = videoInfo.name || videoInfo.tvName || "未知标题";
    duration = videoInfo.durationSec;
    albumid = videoInfo.albumId;
    categoryid = videoInfo.channelId || videoInfo.categoryId;
    log("info", "标题:", title, "时长:", duration);
  } catch (error) {
    log("error", "请求视频基础信息失败:", error);
    return [];
  }

  // 计算弹幕分段数量（每5分钟一个分段）
  const page = Math.ceil(duration / (60 * 5));
  log("info", "弹幕分段数量:", page);

  // 构建弹幕请求
  const promises = [];
  for (let i = 0; i < page; i++) {
    const params = {
        rn: "0.0123456789123456",
        business: "danmu",
        is_iqiyi: "true",
        is_video_page: "true",
        tvid: tvid,
        albumid: albumid,
        categoryid: categoryid,
        qypid: "01010021010000000000",
    };
    let queryParams = buildQueryString(params);
    const api_url = `${api_danmaku_base}${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_${i + 1}.z?${queryParams.toString()}`;
    promises.push(
        httpGet(api_url, {
          headers: {
            "Accpet-Encoding": "gzip",
            "Content-Type": "application/xml",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          zlibMode: true
        })
    );
  }

  // 提取 XML 标签内容的辅助函数
  function extract(xml, tag) {
      const reg = new RegExp(`<${tag}>(.*?)</${tag}>`, "g");
      const res = xml.match(reg)?.map((x) => x.substring(tag.length + 2, x.length - tag.length - 3));
      return res || [];
  }

  // 解析弹幕数据
  let contents = [];
  try {
    const results = await Promise.allSettled(promises);
    const datas = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);

    for (let data of datas) {
        let xml = data.data;

        // 解析 XML 数据
        const danmaku = extract(xml, "content");
        const showTime = extract(xml, "showTime");
        const color = extract(xml, "color");
        const step = 1;

        for (let i = 0; i < danmaku.length; i += step) {
            const content = {
                timepoint: 0,	// 弹幕发送时间（秒）
                ct: 1,	// 弹幕类型，1-3 为滚动弹幕、4 为底部、5 为顶端、6 为逆向、7 为精确、8 为高级
                size: 25,	//字体大小，25 为中，18 为小
                color: 16777215,	//弹幕颜色，RGB 颜色转为十进制后的值，16777215 为白色
                unixtime: Math.floor(Date.now() / 1000),	//Unix 时间戳格式
                uid: 0,		//发送人的 id
                content: "",
            };
            content.timepoint = parseFloat(showTime[i]);
            content.color = parseInt(color[i], 16);
            content.content = danmaku[i];
            content.size = 25;
            contents.push(content);
        }
    }
  } catch (error) {
      log("error", "解析弹幕数据失败:", error);
      return [];
  }

  printFirst200Chars(contents);

  // 返回结果
  return convertToDanmakuJson(contents, "iqiyi");
}

// =====================
// 获取芒果TV弹幕
// =====================

async function fetchMangoTV(inputUrl) {
  log("info", "开始从本地请求芒果TV弹幕...", inputUrl);

  // 弹幕和视频信息 API 基础地址
  const api_video_info = "https://pcweb.api.mgtv.com/video/info";
  const api_danmaku = "https://galaxy.bz.mgtv.com/rdbarrage";

  // 解析 URL 获取 cid 和 vid
  // 手动解析 URL（没有 URL 对象的情况下）
  const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
  const match = inputUrl.match(regex);

  let path;
  if (match) {
    path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
    log("info", path);
  } else {
    log("error", 'Invalid URL');
    return [];
  }
  const cid = path[path.length - 2];
  const vid = path[path.length - 1].split(".")[0];

  log("info", "cid:", cid, "vid:", vid);

  // 获取页面标题和视频时长
  let res;
  try {
    const videoInfoUrl = `${api_video_info}?cid=${cid}&vid=${vid}`;
    res = await httpGet(videoInfoUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
  } catch (error) {
    log("info", "请求视频信息失败:", error);
    return [];
  }

  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const title = data.data.info.videoName;
  const time = data.data.info.time;
  log("info", "标题:", title);

  // 计算弹幕分段请求
  const step = 60 * 1000; // 每60秒一个分段
  const end_time = time_to_second(time) * 1000; // 将视频时长转换为毫秒
  const promises = [];
  for (let i = 0; i < end_time; i += step) {
    const danmakuUrl = `${api_danmaku}?vid=${vid}&cid=${cid}&time=${i}`;
    promises.push(
      httpGet(danmakuUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      })
    );
  }

  log("info", "弹幕分段数量:", promises.length);

  // 解析弹幕数据
  let contents = [];
  try {
    const results = await Promise.allSettled(promises);
    const datas = results
      .filter(result => result.status === "fulfilled")
      .map(result => result.value.data);

    for (const data of datas) {
      const dataJson = typeof data === "string" ? JSON.parse(data) : data;
      if (!dataJson.data.items) continue;
      for (const item of dataJson.data.items) {
        const content = {
            timepoint: 0,	// 弹幕发送时间（秒）
            ct: 1,	// 弹幕类型，1-3 为滚动弹幕、4 为底部、5 为顶端、6 为逆向、7 为精确、8 为高级
            size: 25,	//字体大小，25 为中，18 为小
            color: 16777215,	//弹幕颜色，RGB 颜色转为十进制后的值，16777215 为白色
            unixtime: Math.floor(Date.now() / 1000),	//Unix 时间戳格式
            uid: 0,		//发送人的 id
            content: "",
        };
        if (item.type === 1) {
          content.ct = 5;
        } else if (item.type === 2) {
          content.ct = 4;
        }
        content.timepoint = item.time / 1000;
        content.content = item.content;
        content.uid = item.uid;
        contents.push(content);
      }
    }
  } catch (error) {
    log("error", "解析弹幕数据失败:", error);
    return [];
  }

  printFirst200Chars(contents);

  // 返回结果
  return convertToDanmakuJson(contents, "mango");
}

// =====================
// 获取bilibili弹幕
// =====================

async function fetchBilibili(inputUrl) {
  log("info", "开始从本地请求B站弹幕...", inputUrl);

  // 弹幕和视频信息 API 基础地址
  const api_video_info = "https://api.bilibili.com/x/web-interface/view";
  const api_epid_cid = "https://api.bilibili.com/pgc/view/web/season";

  // 解析 URL 获取必要参数
  // 手动解析 URL（没有 URL 对象的情况下）
  const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
  const match = inputUrl.match(regex);

  let path;
  if (match) {
    path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
    path.unshift("");
    log("info", path);
  } else {
    log("error", 'Invalid URL');
    return [];
  }

  let title, danmakuUrl, cid, aid, duration;

  // 普通投稿视频
  if (inputUrl.includes("video/")) {
    try {
      // 获取查询字符串部分（从 `?` 开始的部分）
      const queryString = inputUrl.split('?')[1];

      // 如果查询字符串存在，则查找参数 p
      let p = 1; // 默认值为 1
      if (queryString) {
          const params = queryString.split('&'); // 按 `&` 分割多个参数
          for (let param of params) {
            const [key, value] = param.split('='); // 分割每个参数的键值对
            if (key === 'p') {
              p = value || 1; // 如果找到 p，使用它的值，否则使用默认值
            }
          }
      }
      log("info", "p: ", p);

      let videoInfoUrl;
      if (inputUrl.includes("BV")) {
        videoInfoUrl = `${api_video_info}?bvid=${path[2]}`;
      } else {
        aid = path[2].substring(2)
        videoInfoUrl = `${api_video_info}?aid=${path[2].substring(2)}`;
      }

      const res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      if (data.code !== 0) {
        log("error", "获取普通投稿视频信息失败:", data.message);
        return [];
      }

      duration = data.data.duration;
      cid = data.data.pages[p - 1].cid;
      danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
    } catch (error) {
      log("error", "请求普通投稿视频信息失败:", error);
      return [];
    }

  // 番剧
  } else if (inputUrl.includes("bangumi/") && inputUrl.includes("ep")) {
    try {
      const epid = path.slice(-1)[0].slice(2);
      const epInfoUrl = `${api_epid_cid}?ep_id=${epid}`;

      const res = await httpGet(epInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      if (data.code !== 0) {
        log("error", "获取番剧视频信息失败:", data.message);
        return [];
      }

      for (const episode of data.result.episodes) {
        if (episode.id == epid) {
          title = episode.share_copy;
          cid = episode.cid;
          duration = episode.duration / 1000;
          danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
          break;
        }
      }

      if (!danmakuUrl) {
        log("error", "未找到匹配的番剧集信息");
        return [];
      }

    } catch (error) {
      log("error", "请求番剧视频信息失败:", error);
      return [];
    }

  } else {
    log("error", "不支持的B站视频网址，仅支持普通视频(av,bv)、剧集视频(ep)");
    return [];
  }
  log("info", danmakuUrl, cid, aid, duration);

  // 计算视频的分片数量
  const maxLen = Math.floor(duration / 360) + 1;
  log("info", "maxLen: ", maxLen);

  const segmentList = [];
  for (let i = 0; i < maxLen; i += 1) {
    let danmakuUrl;
    if (aid) {
      danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${i + 1}`;
    } else {
      danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${i + 1}`;
    }

    segmentList.push({
      segment_start: i * 360 * 1000,
      segment_end: (i + 1) * 360 * 1000,
      url: danmakuUrl,
    });
  }

  // 使用 Promise.all 并行请求所有分片
  try {
    const allComments = await Promise.all(
      segmentList.map(async (segment) => {
        log("info", "正在请求弹幕数据...", segment.url);
        try {
          // 请求单个分片的弹幕数据
          let res = await httpGet(segment.url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              "Cookie": bilibliCookie
            },
            base64Data: true,
          });

          return parseDanmakuBase64(res.data);
        } catch (error) {
          log("error", "请求弹幕数据失败: ", error);
          return [];
        }
      })
    );

    // 合并所有分片的弹幕数据
    const mergedComments = allComments.flat();
    return convertToDanmakuJson(mergedComments, "bilibili");

  } catch (error) {
    log("error", "获取所有弹幕数据时出错: ", error);
    return [];
  }
}

// =====================
// 获取优酷弹幕
// =====================

function convertYoukuUrl(url) {
  // 使用正则表达式提取 vid 参数
  const vidMatch = url.match(/vid=([^&]+)/);
  if (!vidMatch || !vidMatch[1]) {
    return null; // 如果没有找到 vid 参数，返回 null
  }

  const vid = vidMatch[1];
  // 构造新的 URL
  return `https://v.youku.com/v_show/id_${vid}.html`;
}

async function fetchYouku(inputUrl) {
  log("info", "开始从本地请求优酷弹幕...", inputUrl);

  if (!inputUrl) {
    return [];
  }

  // 弹幕和视频信息 API 基础地址
  const api_video_info = "https://openapi.youku.com/v2/videos/show.json";
  const api_danmaku = "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/";

  // 手动解析 URL（没有 URL 对象的情况下）
  const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
  const match = inputUrl.match(regex);

  let path;
  if (match) {
    path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
    path.unshift("");
    log("info", path);
  } else {
    log("error", 'Invalid URL');
    return [];
  }
  const video_id = path[path.length - 1].split(".")[0].slice(3);

  log("info", "video_id:", video_id);

  // 获取页面标题和视频时长
  let res;
  try {
    const videoInfoUrl = `${api_video_info}?client_id=53e6cc67237fc59a&video_id=${video_id}&package=com.huawei.hwvplayer.youku&ext=show`;
    res = await httpGet(videoInfoUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
      },
      allow_redirects: false
    });
  } catch (error) {
    log("error", "请求视频信息失败:", error);
    return [];
  }

  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const title = data.title;
  const duration = data.duration;
  log("info", "标题:", title, "时长:", duration);

  // 获取 cna 和 tk_enc
  let cna, _m_h5_tk_enc, _m_h5_tk;
  try {
    const cnaUrl = "https://log.mmstat.com/eg.js";
    const tkEncUrl = "https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=24679788";
    const cnaRes = await httpGet(cnaUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
      },
      allow_redirects: false
    });
    log("info", "cnaRes: ", cnaRes);
    log("info", "cnaRes.headers: ", cnaRes.headers);
    const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
    log("info", "etag: ", etag);
    // const match = cnaRes.headers["set-cookie"].match(/cna=([^;]+)/);
    // cna = match ? match[1] : null;
    cna = etag.replace(/^"|"$/g, '');
    log("info", "cna: ", cna);

    let tkEncRes;
    while (!tkEncRes) {
      tkEncRes = await httpGet(tkEncUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });
    }
    log("info", "tkEncRes: ", tkEncRes);
    log("info", "tkEncRes.headers: ", tkEncRes.headers);
    const tkEncSetCookie = tkEncRes.headers["set-cookie"] || tkEncRes.headers["Set-Cookie"];
    log("info", "tkEncSetCookie: ", tkEncSetCookie);

    // 获取 _m_h5_tk_enc
    const tkEncMatch = tkEncSetCookie.match(/_m_h5_tk_enc=([^;]+)/);
    _m_h5_tk_enc = tkEncMatch ? tkEncMatch[1] : null;

    // 获取 _m_h5_tkh
    const tkH5Match = tkEncSetCookie.match(/_m_h5_tk=([^;]+)/);
    _m_h5_tk = tkH5Match ? tkH5Match[1] : null;

    log("info", "_m_h5_tk_enc:", _m_h5_tk_enc);
    log("info", "_m_h5_tk:", _m_h5_tk);
  } catch (error) {
    log("error", "获取 cna 或 tk_enc 失败:", error);
    return [];
  }

  // 计算弹幕分段请求
  const step = 60; // 每60秒一个分段
  const max_mat = Math.floor(duration / step) + 1;
  let contents = [];

  // 将构造请求和解析逻辑封装为函数，返回该分段的弹幕数组
  const requestOneMat = async (mat) => {
    const msg = {
      ctime: Date.now(),
      ctype: 10004,
      cver: "v1.0",
      guid: cna,
      mat: mat,
      mcount: 1,
      pid: 0,
      sver: "3.1.0",
      type: 1,
      vid: video_id,
    };

    const str = JSON.stringify(msg);

    function utf8ToLatin1(str) {
      let result = '';
      for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        if (charCode > 255) {
          result += encodeURIComponent(str[i]);
        } else {
          result += str[i];
        }
      }
      return result;
    }

    function base64Encode(input) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let output = '';
      let buffer = 0;
      let bufferLength = 0;
      for (let i = 0; i < input.length; i++) {
        buffer = (buffer << 8) | input.charCodeAt(i);
        bufferLength += 8;
        while (bufferLength >= 6) {
          output += chars[(buffer >> (bufferLength - 6)) & 0x3F];
          bufferLength -= 6;
        }
      }
      if (bufferLength > 0) {
        output += chars[(buffer << (6 - bufferLength)) & 0x3F];
      }
      while (output.length % 4 !== 0) {
        output += '=';
      }
      return output;
    }

    const msg_b64encode = base64Encode(utf8ToLatin1(str));
    msg.msg = msg_b64encode;
    msg.sign = md5(`${msg_b64encode}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toString().toLowerCase();

    const data = JSON.stringify(msg);
    const t = Date.now();
    const params = {
      jsv: "2.5.6",
      appKey: "24679788",
      t: t,
      sign: md5([_m_h5_tk.slice(0, 32), t, "24679788", data].join("&")).toString().toLowerCase(),
      api: "mopen.youku.danmu.list",
      v: "1.0",
      type: "originaljson",
      dataType: "jsonp",
      timeout: "20000",
      jsonpIncPrefix: "utility",
    };

    const queryString = buildQueryString(params);
    const url = `${api_danmaku}?${queryString}`;
    log("info", "piece_url: ", url);

    const response = await httpPost(url, buildQueryString({ data: data }), {
      headers: {
        "Cookie": `_m_h5_tk=${_m_h5_tk};_m_h5_tk_enc=${_m_h5_tk_enc};`,
        "Referer": "https://v.youku.com",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
      },
      allow_redirects: false
    });

    const results = [];
    if (response.data?.data && response.data.data.result) {
      const result = JSON.parse(response.data.data.result);
      if (result.code !== "-1") {
        const danmus = result.data.result;
        for (const danmu of danmus) {
          const content = {
            timepoint: 0,
            ct: 1,
            size: 25,
            color: 16777215,
            unixtime: Math.floor(Date.now() / 1000),
            uid: 0,
            content: "",
          };
          content.timepoint = danmu.playat / 1000;
          const prop = JSON.parse(danmu.propertis)
          if (prop?.color) {
            content.color = prop.color;
          }
          if (prop?.pos) {
            const pos = prop.pos;
            if (pos === 1) content.ct = 5;
            else if (pos === 2) content.ct = 4;
          }
          content.content = danmu.content;
          results.push(content);
        }
      }
    }
    return results;
  };

  // 并发限制（可通过环境变量 YOUKU_CONCURRENCY 配置，默认 8）
  const concurrency = youkuConcurrency;
  const mats = Array.from({ length: max_mat }, (_, i) => i);
  for (let i = 0; i < mats.length; i += concurrency) {
    const batch = mats.slice(i, i + concurrency).map((m) => requestOneMat(m));
    try {
      const settled = await Promise.allSettled(batch);
      for (const s of settled) {
        if (s.status === "fulfilled" && Array.isArray(s.value)) {
          contents = contents.concat(s.value);
        }
      }
    } catch (e) {
      log("error", "优酷分段批量请求失败:", e.message);
    }
  }

  printFirst200Chars(contents);

  // 返回结果
  return convertToDanmakuJson(contents, "youku");
}

// =====================
// 获取第三方弹幕服务器弹幕
// =====================

async function fetchOtherServer(inputUrl) {
  try {
    const response = await httpGet(
      `${otherServer}/?url=${inputUrl}&ac=dm`,
      {
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      }
    );

    log("info", `danmu response from ${otherServer}: ↓↓↓`);
    printFirst200Chars(response.data);

    return convertToDanmakuJson(response.data, "other_server");
  } catch (error) {
    log("error", `请求 ${otherServer} 失败:`, error);
    return [];
  }
}

// =====================
// 人人视频 配置 & 工具
// =====================
// ---------------------
// 通用工具
// ---------------------
function sortedQueryString(params = {}) {
  const normalized = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "boolean") normalized[k] = v ? "true" : "false";
    else if (v == null) normalized[k] = "";
    else normalized[k] = String(v);
  }

  // 获取对象的所有键并排序
  const keys = [];
  for (const key in normalized) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      keys.push(key);
    }
  }
  keys.sort();

  // 构建键值对数组
  const pairs = [];
  for (const key of keys) {
    // 对键和值进行 URL 编码
    const encodedKey = encodeURIComponent(key);
    const encodedValue = encodeURIComponent(normalized[key]);
    pairs.push(`${encodedKey}=${encodedValue}`);
  }

  // 用 & 连接所有键值对
  return pairs.join('&');
}

function updateQueryString(url, params) {
  // 解析 URL
  let baseUrl = url;
  let queryString = '';
  const hashIndex = url.indexOf('#');
  let hash = '';
  if (hashIndex !== -1) {
    baseUrl = url.substring(0, hashIndex);
    hash = url.substring(hashIndex);
  }
  const queryIndex = baseUrl.indexOf('?');
  if (queryIndex !== -1) {
    queryString = baseUrl.substring(queryIndex + 1);
    baseUrl = baseUrl.substring(0, queryIndex);
  }

  // 解析现有查询字符串为对象
  const queryParams = {};
  if (queryString) {
    const pairs = queryString.split('&');
    for (const pair of pairs) {
      if (pair) {
        const [key, value = ''] = pair.split('=').map(decodeURIComponent);
        queryParams[key] = value;
      }
    }
  }

  // 更新参数
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      queryParams[key] = params[key];
    }
  }

  // 构建新的查询字符串
  const newQuery = [];
  for (const key in queryParams) {
    if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
      newQuery.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`
      );
    }
  }

  // 拼接最终 URL
  return baseUrl + (newQuery.length ? '?' + newQuery.join('&') : '') + hash;
}

function getPathname(url) {
  // 查找路径的起始位置（跳过协议和主机部分）
  let pathnameStart = url.indexOf('//') + 2;
  if (pathnameStart === 1) pathnameStart = 0; // 如果没有协议部分
  const pathStart = url.indexOf('/', pathnameStart);
  if (pathStart === -1) return '/'; // 如果没有路径，返回默认根路径
  const queryStart = url.indexOf('?', pathStart);
  const hashStart = url.indexOf('#', pathStart);
  // 确定路径的结束位置（查询字符串或片段之前）
  let pathEnd = queryStart !== -1 ? queryStart : (hashStart !== -1 ? hashStart : url.length);
  const pathname = url.substring(pathStart, pathEnd);
  return pathname || '/';
}

function generateSignature(method, aliId, ct, cv, timestamp, path, sortedQuery, secret) {
  const signStr = `${method.toUpperCase()}\naliId:${aliId}\nct:${ct}\ncv:${cv}\nt:${timestamp}\n${path}?${sortedQuery}`;
  return createHmacSha256(secret, signStr);
}

function buildSignedHeaders({ method, url, params = {}, deviceId, token }) {
  const ClientProfile = {
    client_type: "web_pc",
    client_version: "1.0.0",
    user_agent: "Mozilla/5.0",
    origin: "https://rrsp.com.cn",
    referer: "https://rrsp.com.cn/",
  };
  const pathname = getPathname(url);
  const qs = sortedQueryString(params);
  const nowMs = Date.now();
  const SIGN_SECRET = "ES513W0B1CsdUrR13Qk5EgDAKPeeKZY";
  const xCaSign = generateSignature(
    method, deviceId, ClientProfile.client_type, ClientProfile.client_version,
    nowMs, pathname, qs, SIGN_SECRET
  );
  return {
    clientVersion: ClientProfile.client_version,
    deviceId,
    clientType: ClientProfile.client_type,
    t: String(nowMs),
    aliId: deviceId,
    umid: deviceId,
    token: token || "",
    cv: ClientProfile.client_version,
    ct: ClientProfile.client_type,
    uet: "9",
    "x-ca-sign": xCaSign,
    Accept: "application/json",
    "User-Agent": ClientProfile.user_agent,
    Origin: ClientProfile.origin,
    Referer: ClientProfile.referer,
  };
}

// ====================== AES-128-ECB 完整实现 ======================

// S盒
const SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
];

// 轮常量
const RCON = [
  0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36
];

// 字节异或
function xor(a,b) {
  const out = new Uint8Array(a.length);
  for(let i=0;i<a.length;i++) out[i]=a[i]^b[i];
  return out;
}

// 字循环左移
function rotWord(word){
  return Uint8Array.from([word[1],word[2],word[3],word[0]]);
}

// 字节代换
function subWord(word){
  return Uint8Array.from(word.map(b=>SBOX[b]));
}

// 扩展密钥 16 字节 -> 176 字节
function keyExpansion(key) {
  const Nk = 4, Nb=4, Nr=10;
  const w = new Array(Nb*(Nr+1));
  for(let i=0;i<Nk;i++){
    w[i] = key.slice(4*i,4*i+4);
  }
  for(let i=Nk;i<Nb*(Nr+1);i++){
    let temp = w[i-1];
    if(i%Nk===0) temp = xor(subWord(rotWord(temp)), Uint8Array.from([RCON[i/Nk],0,0,0]));
    w[i]=xor(w[i-Nk],temp);
  }
  return w;
}

// AES-128 解密单块 (16 字节)
function aesDecryptBlock(input, w) {
  const Nb=4, Nr=10;
  let state = new Uint8Array(input);
  state = addRoundKey(state, w.slice(Nr*Nb,(Nr+1)*Nb));
  for(let round=Nr-1;round>=1;round--){
    state = invShiftRows(state);
    state = invSubBytes(state);
    state = addRoundKey(state, w.slice(round*Nb,(round+1)*Nb));
    state = invMixColumns(state);
  }
  state = invShiftRows(state);
  state = invSubBytes(state);
  state = addRoundKey(state, w.slice(0,Nb));
  return state;
}

// AES 辅助函数
function addRoundKey(state, w){
  const out = new Uint8Array(16);
  for(let c=0;c<4;c++)
    for(let r=0;r<4;r++)
      out[r+4*c]=state[r+4*c]^w[c][r];
  return out;
}

function invSubBytes(state){
  const INV_SBOX = new Array(256);
  for(let i=0;i<256;i++) INV_SBOX[SBOX[i]]=i;
  return Uint8Array.from(state.map(b=>INV_SBOX[b]));
}

function invShiftRows(state){
  const out = new Uint8Array(16);
  for(let r=0;r<4;r++)
    for(let c=0;c<4;c++)
      out[r+4*c]=state[r+4*((c-r+4)%4)];
  return out;
}

function invMixColumns(state){
  function mul(a,b){
    let p=0;
    for(let i=0;i<8;i++){
      if(b&1) p^=a;
      let hi=(a&0x80);
      a=(a<<1)&0xFF;
      if(hi) a^=0x1b;
      b>>=1;
    }
    return p;
  }
  const out = new Uint8Array(16);
  for(let c=0;c<4;c++){
    const col = state.slice(4*c,4*c+4);
    out[4*c+0]=mul(col[0],0x0e)^mul(col[1],0x0b)^mul(col[2],0x0d)^mul(col[3],0x09);
    out[4*c+1]=mul(col[0],0x09)^mul(col[1],0x0e)^mul(col[2],0x0b)^mul(col[3],0x0d);
    out[4*c+2]=mul(col[0],0x0d)^mul(col[1],0x09)^mul(col[2],0x0e)^mul(col[3],0x0b);
    out[4*c+3]=mul(col[0],0x0b)^mul(col[1],0x0d)^mul(col[2],0x09)^mul(col[3],0x0e);
  }
  return out;
}

// ====================== ECB 模式解密 ======================
function aesDecryptECB(cipherBytes, keyBytes){
  const w = keyExpansion(keyBytes);
  const blockSize = 16;
  const result = new Uint8Array(cipherBytes.length);
  for(let i=0;i<cipherBytes.length;i+=blockSize){
    const block = cipherBytes.slice(i,i+blockSize);
    const decrypted = aesDecryptBlock(block,w);
    result.set(decrypted,i);
  }
  return result;
}

// ====================== PKCS#7 去填充 ======================
function pkcs7Unpad(data){
  const pad = data[data.length-1];
  return data.slice(0,data.length-pad);
}

// ====================== Base64 解码 ======================
function base64ToBytes(b64) {
  // 先把 Base64 字符串转换成普通字符
  const binaryString = (typeof atob === 'function')
    ? atob(b64) // 浏览器环境
    : BufferBase64Decode(b64); // Node / React Native 自定义

  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// 自定义 Base64 解码函数
function BufferBase64Decode(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let str = '';
  let buffer = 0, bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charAt(i);
    if (c === '=') break;
    const val = chars.indexOf(c);
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      str += String.fromCharCode((buffer >> bits) & 0xFF);
    }
  }
  return str;
}

// ====================== 主函数 ======================
// Uint8Array UTF-8 解码成字符串，替代 TextDecoder
function utf8BytesToString(bytes) {
  let str = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      str += String.fromCharCode(b1);
    } else if (b1 >= 0xc0 && b1 < 0xe0) {
      const b2 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 >= 0xe0 && b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if (b1 >= 0xf0) {
      // surrogate pair
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const codepoint = ((b1 & 0x07) << 18) |
                        ((b2 & 0x3f) << 12) |
                        ((b3 & 0x3f) << 6) |
                        (b4 & 0x3f);
      const cp = codepoint - 0x10000;
      str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return str;
}

// 同时替换 TextEncoder
function stringToUtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6));
      bytes.push(0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(0xe0 | (code >> 12));
      bytes.push(0x80 | ((code >> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    } else {
      // surrogate pair
      i++;
      const code2 = str.charCodeAt(i);
      const codePoint = 0x10000 + (((code & 0x3ff) << 10) | (code2 & 0x3ff));
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

// 修改后的 aesDecryptBase64
function aesDecryptBase64(cipherB64, keyStr) {
  try {
    const cipherBytes = base64ToBytes(cipherB64);
    const keyBytes = stringToUtf8Bytes(keyStr);
    const decryptedBytes = aesDecryptECB(cipherBytes, keyBytes);
    const unpadded = pkcs7Unpad(decryptedBytes);
    return utf8BytesToString(unpadded);
  } catch (e) {
    log("error", e);
    return null;
  }
}

function autoDecode(anything) {
  const text = typeof anything === "string" ? anything.trim() : JSON.stringify(anything ?? "");
  try {
    return JSON.parse(text);
  } catch {}

  const AES_KEY = "3b744389882a4067"; // 直接传字符串
  const dec = aesDecryptBase64(text, AES_KEY); // aesDecryptBase64 内会 TextEncoder.encode
  if (dec != null) {
    try {
      return JSON.parse(dec);
    } catch {
      return dec;
    }
  }
  return text;
}

function str2bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6));
            bytes.push(0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12));
            bytes.push(0x80 | ((code >> 6) & 0x3f));
            bytes.push(0x80 | (code & 0x3f));
        }
    }
    return bytes;
}

// ===================== Base64 编码 =====================
function bytesToBase64(bytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
        result += chars[bytes[i] >> 2];
        result += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
        result += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
        result += chars[bytes[i + 2] & 63];
    }
    if (i < bytes.length) {
        result += chars[bytes[i] >> 2];
        if (i + 1 < bytes.length) {
            result += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
            result += chars[(bytes[i + 1] & 15) << 2];
            result += '=';
        } else {
            result += chars[(bytes[i] & 3) << 4];
            result += '==';
        }
    }
    return result;
}

// ===================== SHA256 算法 =====================
// 纯 JS SHA256，返回字节数组
function sha256(ascii) {
    function rightRotate(n, x) { return (x >>> n) | (x << (32 - n)); }

    let maxWord = Math.pow(2, 32);
    let words = [], asciiBitLength = ascii.length * 8;

    for (let i = 0; i < ascii.length; i++) {
        words[i >> 2] |= ascii.charCodeAt(i) << ((3 - i) % 4 * 8);
    }

    words[ascii.length >> 2] |= 0x80 << ((3 - ascii.length % 4) * 8);
    words[((ascii.length + 8) >> 6) * 16 + 15] = asciiBitLength;

    let w = new Array(64), hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    const k = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];

    for (let j = 0; j < words.length; j += 16) {
        let a = hash[0], b = hash[1], c = hash[2], d = hash[3],
            e = hash[4], f = hash[5], g = hash[6], h = hash[7];

        for (let i = 0; i < 64; i++) {
            if (i < 16) w[i] = words[j + i] | 0;
            else {
                const s0 = rightRotate(7, w[i-15]) ^ rightRotate(18, w[i-15]) ^ (w[i-15]>>>3);
                const s1 = rightRotate(17, w[i-2]) ^ rightRotate(19, w[i-2]) ^ (w[i-2]>>>10);
                w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
            }
            const S1 = rightRotate(6, e) ^ rightRotate(11, e) ^ rightRotate(25, e);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + k[i] + w[i]) | 0;
            const S0 = rightRotate(2, a) ^ rightRotate(13, a) ^ rightRotate(22, a);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }

        hash[0] = (hash[0] + a) | 0;
        hash[1] = (hash[1] + b) | 0;
        hash[2] = (hash[2] + c) | 0;
        hash[3] = (hash[3] + d) | 0;
        hash[4] = (hash[4] + e) | 0;
        hash[5] = (hash[5] + f) | 0;
        hash[6] = (hash[6] + g) | 0;
        hash[7] = (hash[7] + h) | 0;
    }

    // 转为字节数组
    const bytes = [];
    for (let h of hash) {
        bytes.push((h >> 24) & 0xFF);
        bytes.push((h >> 16) & 0xFF);
        bytes.push((h >> 8) & 0xFF);
        bytes.push(h & 0xFF);
    }
    return bytes;
}

// ===================== HMAC-SHA256 =====================
function createHmacSha256(key, message) {
    const blockSize = 64; // 512 bit
    let keyBytes = str2bytes(key);
    if (keyBytes.length > blockSize) keyBytes = sha256(key);
    if (keyBytes.length < blockSize) keyBytes = keyBytes.concat(Array(blockSize - keyBytes.length).fill(0));

    const oKeyPad = keyBytes.map(b => b ^ 0x5c);
    const iKeyPad = keyBytes.map(b => b ^ 0x36);

    const innerHash = sha256(String.fromCharCode(...iKeyPad) + message);
    const hmacBytes = sha256(String.fromCharCode(...oKeyPad) + String.fromCharCode(...innerHash));

    return bytesToBase64(hmacBytes);
}

async function renrenHttpGet(url, { params = {}, headers = {} } = {}) {
  const u = updateQueryString(url, params)
  const resp = await httpGet(u, {
      headers: headers,
  });
  return resp;
}

function generateDeviceId() {
  return (Math.random().toString(36).slice(2)).toUpperCase();
}

async function renrenRequest(method, url, params = {}) {
  const deviceId = generateDeviceId();
  const headers = buildSignedHeaders({ method, url, params, deviceId });
  const resp = await httpGet(url + "?" + sortedQueryString(params), {
      headers: headers,
  });
  return resp;
}

// ---------------------
// 人人视频搜索
// ---------------------
async function renrenSearch(keyword, episodeInfo = null) {
  const parsedKeyword = { title: keyword, season: null }; // 简化 parse_search_keyword
  const searchTitle = parsedKeyword.title;
  const searchSeason = parsedKeyword.season;

  const lock = { value: false };
  const lastRequestTime = { value: 0 };
  let allResults = await performNetworkSearch(searchTitle, episodeInfo, { lockRef: lock, lastRequestTimeRef: lastRequestTime, minInterval: 400 });

  if (searchSeason == null) return allResults;

  // 按 season 过滤
  return allResults.filter(r => r.season === searchSeason);
}

async function performNetworkSearch(
  keyword,
  episodeInfo = null,
  {
    lockRef = null,
    lastRequestTimeRef = { value: 0 },  // 调用方传引用
    minInterval = 500                   // 默认节流间隔（毫秒）
  } = {}
) {
  try {
    const url = `https://api.rrmj.plus/m-station/search/drama`;
    const params = { keywords: keyword, size: 20, order: "match", search_after: "", isExecuteVipActivity: true };

    // 🔒 锁逻辑（可选）
    if (lockRef) {
      while (lockRef.value) await new Promise(r => setTimeout(r, 50));
      lockRef.value = true;
    }

    // ⏱️ 节流逻辑（依赖 lastRequestTimeRef）
    const now = Date.now();
    const dt = now - lastRequestTimeRef.value;
    if (dt < minInterval) await new Promise(r => setTimeout(r, minInterval - dt));

    const resp = await renrenRequest("GET", url, params);
    lastRequestTimeRef.value = Date.now(); // 更新引用

    if (lockRef) lockRef.value = false;

    if (!resp.data) return [];

    const decoded = autoDecode(resp.data);
    const list = decoded?.data?.searchDramaList || [];
    return list.map((item, idx) => ({
      provider: "renren",
      mediaId: String(item.id),
      title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
      type: "tv_series",
      season: null,
      year: item.year,
      imageUrl: item.cover,
      episodeCount: item.episodeTotal,
      currentEpisodeIndex: episodeInfo?.episode ?? null,
    }));
  } catch (error) {
    log("error", "getRenrenAnimes error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

// ---------------------
// 人人视频URL信息提取
// ---------------------
async function fetchDramaDetail(dramaId) {
  const url = `https://api.rrmj.plus/m-station/drama/page`;
  const params = { hsdrOpen:0,isAgeLimit:0,dramaId:String(dramaId),hevcOpen:1 };
  const resp = await renrenRequest("GET", url, params);
  if (!resp.data) return null;
  const decoded = autoDecode(resp.data);
  return decoded?.data || null;
}

async function getEpisodes(mediaId, targetEpisodeIndex=null, dbMediaType=null) {
  const detail = await fetchDramaDetail(mediaId);
  if (!detail || !detail.episodeList) return [];

  let episodes = [];
  detail.episodeList.forEach((ep, idx)=>{
    const sid = String(ep.sid || "").trim();
    if(!sid) return;
    const title = String(ep.title || `第${idx+1}`.padStart(2,"0")+"集");
    episodes.push({ sid, order: idx+1, title });
  });

  if(targetEpisodeIndex) episodes = episodes.filter(e=>e.order===targetEpisodeIndex);

  return episodes.map(e=>({
    provider: "renren",
    episodeId: e.sid,
    title: e.title,
    episodeIndex: e.order,
    url: null
  }));
}

// ---------------------
// 人人视频弹幕
// ---------------------
async function fetchEpisodeDanmu(sid) {
  const ClientProfile = {
    user_agent: "Mozilla/5.0",
    origin: "https://rrsp.com.cn",
    referer: "https://rrsp.com.cn/",
  };
  const url = `https://static-dm.rrmj.plus/v1/produce/danmu/EPISODE/${sid}`;
  const headers = {
    "Accept": "application/json",
    "User-Agent": ClientProfile.user_agent,
    "Origin": ClientProfile.origin,
    "Referer": ClientProfile.referer,
  };
  const resp = await renrenHttpGet(url, { headers });
  if (!resp.data) return null;
  const data = autoDecode(resp.data);
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  return null;
}

function parseRRSPPFields(pField) {
  const parts = String(pField).split(",");
  const num = (i, cast, dft) => { try { return cast(parts[i]); } catch { return dft; } };
  const timestamp = num(0, parseFloat, 0);
  const mode = num(1, x=>parseInt(x,10),1);
  const size = num(2, x=>parseInt(x,10),25);
  const color = num(3, x=>parseInt(x,10),16777215);
  const userId = parts[6] || "";
  const contentId = parts[7] || `${timestamp}:${userId}`;
  return { timestamp, mode, size, color, userId, contentId };
}

function formatRenrenComments(items) {
  return items.map(item => {
    const text = String(item.d || "");
    const meta = parseRRSPPFields(item.p);
    return {
      cid: Number(meta.contentId),
      p: `${meta.timestamp.toFixed(2)},${meta.mode},${meta.color},[renren]`,
      m: text,
      t: meta.timestamp
    };
  });
}

async function getRenRenComments(episodeId, progressCallback=null){
  if(progressCallback) await progressCallback(5,"开始获取弹幕人人弹幕");
  log("info", "开始获取弹幕人人弹幕");
  const raw = await fetchEpisodeDanmu(episodeId);
  if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
  log("info", `原始弹幕 ${raw.length} 条，正在规范化`);
  const formatted = formatRenrenComments(raw);
  if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
  log("info", `弹幕处理完成，共 ${formatted.length} 条`);
  return convertToDanmakuJson(formatted, "renren");
}

// ---------------------
// hanjutv视频弹幕
// ---------------------
async function hanjutvSearch(keyword) {
  try {
    const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/search/aggregate/search?keyword=${keyword}&scope=101&page=1`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    // 判断 resp 和 resp.data 是否存在
    if (!resp || !resp.data) {
      log("info", "hanjutvSearchresp: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.seriesData || !resp.data.seriesData.seriesList) {
      log("info", "hanjutvSearchresp: seriesData 或 seriesList 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("info", `hanjutvSearchresp: ${JSON.stringify(resp.data.seriesData.seriesList)}`);

    let resList = [];
    for (const anime of resp.data.seriesData.seriesList) {
      const animeId = convertToAsciiSum(anime.sid);
      resList.push({ ...anime, animeId });
    }
    return resList;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "getHanjutvAnimes error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

async function getHanjutvDetail(sid) {
  try {
    const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/series/series/detail?sid=${sid}`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    // 判断 resp 和 resp.data 是否存在
    if (!resp || !resp.data) {
      log("info", "getHanjutvDetail: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.series) {
      log("info", "getHanjutvDetail: series 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("info", `getHanjutvDetail: ${JSON.stringify(resp.data.series)}`);

    return resp.data.series;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "getHanjutvDetail error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

async function getHanjutvEpisodes(sid) {
  try {
    const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/series/series/detail?sid=${sid}`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    // 判断 resp 和 resp.data 是否存在
    if (!resp || !resp.data) {
      log("info", "getHanjutvEposides: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.episodes) {
      log("info", "getHanjutvEposides: episodes 不存在");
      return [];
    }

    const sortedEpisodes = resp.data.episodes.sort((a, b) => a.serialNo - b.serialNo);

    // 正常情况下输出 JSON 字符串
    log("info", `getHanjutvEposides: ${JSON.stringify(sortedEpisodes)}`);

    return sortedEpisodes;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "getHanjutvEposides error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

async function fetchHanjutvEpisodeDanmu(sid) {
  let allDanmus = [];
  let fromAxis = 0;
  const maxAxis = 100000000;

  try {
    while (fromAxis < maxAxis) {
      const resp = await httpGet(`https://hxqapi.zmdcq.com/api/danmu/playItem/list?fromAxis=${fromAxis}&pid=${sid}&toAxis=${maxAxis}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      // 将当前请求的 episodes 拼接到总数组
      if (resp.data && resp.data.danmus) {
        allDanmus = allDanmus.concat(resp.data.danmus);
      }

      // 获取 nextAxis，更新 fromAxis
      const nextAxis = resp.data.nextAxis || maxAxis;
      if (nextAxis >= maxAxis) {
        break; // 如果 nextAxis 达到或超过最大值，退出循环
      }
      fromAxis = nextAxis;
    }

    return allDanmus;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "fetchHanjutvEpisodeDanmu error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return allDanmus; // 返回已收集的 episodes
  }
}

function formatHanjutvComments(items) {
  return items.map(c => ({
    cid: Number(c.did),
    p: `${(c.t / 1000).toFixed(2)},${c.tp},${Number(c.sc)},[hanjutv]`,
    m: c.con,
    t: Math.round(c.t / 1000)
  }));
}

async function getHanjutvComments(pid, progressCallback=null){
  if(progressCallback) await progressCallback(5,"开始获取弹幕韩剧TV弹幕");
  log("info", "开始获取弹幕韩剧TV弹幕");
  const raw = await fetchHanjutvEpisodeDanmu(pid);
  if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
  log("info", `原始弹幕 ${raw.length} 条，正在规范化`);
  const formatted = formatHanjutvComments(raw);
  if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
  log("info", `弹幕处理完成，共 ${formatted.length} 条`);
  return convertToDanmakuJson(formatted, "hanjutv");
}

// ---------------------
// bahamut视频弹幕
// ---------------------
async function bahamutSearch(keyword) {
  try {
    const url = proxyUrl ? `http://127.0.0.1:5321/proxy?url=https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${keyword}` : `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${keyword}`;
    const resp = await httpGet(url, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
      },
    });

    // 判断 resp 和 resp.data 是否存在
    if (!resp || !resp.data) {
      log("info", "bahamutSearchresp: 请求失败或无数据返回");
      return [];
    }

    // 判断 anime 是否存在
    if (!resp.data.anime) {
      log("info", "bahamutSearchresp: anime 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("info", `bahamutSearchresp: ${JSON.stringify(resp.data.anime)}`);

    return resp.data.anime;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "getBahamutAnimes error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

async function getBahamutEpisodes(videoSn) {
  try {
    const url = proxyUrl ? `http://127.0.0.1:5321/proxy?url=https://api.gamer.com.tw/anime/v1/video.php?videoSn=${videoSn}` : `https://api.gamer.com.tw/anime/v1/video.php?videoSn=${videoSn}`;
    const resp = await httpGet(url, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
      },
    });

    // 判断 resp 和 resp.data 是否存在
    if (!resp || !resp.data) {
      log("info", "getBahamutEposides: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.data || !resp.data.data.video || !resp.data.data.anime) {
      log("info", "getBahamutEposides: video 或 anime 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("info", `getBahamutEposides: ${JSON.stringify(resp.data.data)}`);

    return resp.data.data;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "getBahamutEposides error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
}

async function fetchBahamutEpisodeDanmu(videoSn) {
  let danmus = [];

  try {
    const url = proxyUrl ? `http://127.0.0.1:5321/proxy?url=https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn=${videoSn}` : `https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn=${videoSn}`;
    const resp = await httpGet(url, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
      },
    });

    // 将当前请求的 episodes 拼接到总数组
    if (resp.data && resp.data.data && resp.data.data.danmu) {
      danmus = resp.data.data.danmu;
    }

    return danmus;
  } catch (error) {
    // 捕获请求中的错误
    log("error", "fetchBahamutEpisodeDanmu error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return danmus; // 返回已收集的 episodes
  }
}

function formatBahamutComments(items) {
  const positionToMode = { 0: 1, 1: 5, 2: 4 };
  return items.map(c => ({
    cid: Number(c.sn),
    p: `${c.time.toFixed(2)},${positionToMode[c.position] || c.tp},${parseInt(c.color.slice(1), 16)},[bahamut]`,
    m: simplized(c.text),
    t: c.time
  }));
}

async function getBahamutComments(pid, progressCallback=null){
  if(progressCallback) await progressCallback(5,"开始获取弹幕巴哈姆特弹幕");
  log("info", "开始获取弹幕巴哈姆特弹幕");
  const raw = await fetchBahamutEpisodeDanmu(pid);
  if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
  log("info", `原始弹幕 ${raw.length} 条，正在规范化`);
  const formatted = formatBahamutComments(raw);
  if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
  log("info", `弹幕处理完成，共 ${formatted.length} 条`);
  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(formatted.slice(0, 5), null, 2));
  return formatted;
}

// =====================
// 路由请求相关
// =====================

function log(level, ...args) {
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");

  // 获取上海时区时间(UTC+8)
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timestamp = shanghaiTime.toISOString().replace('Z', '+08:00');

  logBuffer.push({ timestamp, level, message });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  console[level](...args);
}

function formatLogMessage(message) {
  try {
    const parsed = JSON.parse(message);
    return JSON.stringify(parsed, null, 2).replace(/\n/g, "\n    ");
  } catch {
    return message;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function xmlResponse(data, status = 200) {
  // 确保 data 是字符串且以 <?xml 开头
  if (typeof data !== 'string' || !data.trim().startsWith('<?xml')) {
    throw new Error('Expected data to be an XML string starting with <?xml');
  }

  // 直接返回 XML 字符串作为 Response 的 body
  return new Response(data, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function convertChineseNumber(chineseNumber) {
  // 如果是阿拉伯数字，直接转换
  if (/^\d+$/.test(chineseNumber)) {
    return Number(chineseNumber);
  }

  // 中文数字映射（简体+繁体）
  const digits = {
    // 简体
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9,
    // 繁体
    '壹': 1, '貳': 2, '參': 3, '肆': 4, '伍': 5,
    '陸': 6, '柒': 7, '捌': 8, '玖': 9
  };

  // 单位映射（简体+繁体）
  const units = {
    // 简体
    '十': 10, '百': 100, '千': 1000,
    // 繁体
    '拾': 10, '佰': 100, '仟': 1000
  };

  let result = 0;
  let current = 0;
  let lastUnit = 1;

  for (let i = 0; i < chineseNumber.length; i++) {
    const char = chineseNumber[i];

    if (digits[char] !== undefined) {
      // 数字
      current = digits[char];
    } else if (units[char] !== undefined) {
      // 单位
      const unit = units[char];

      if (current === 0) current = 1;

      if (unit >= lastUnit) {
        // 更大的单位，重置结果
        result = current * unit;
      } else {
        // 更小的单位，累加到结果
        result += current * unit;
      }

      lastUnit = unit;
      current = 0;
    }
  }

  // 处理最后的个位数
  if (current > 0) {
    result += current;
  }

  return result;
}

function matchSeason(anime, queryTitle, season) {
  if (anime.animeTitle.includes(queryTitle)) {
    const title = anime.animeTitle.split("(")[0].trim();
    if (title.startsWith(queryTitle)) {
      const afterTitle = title.substring(queryTitle.length).trim();
      if (afterTitle === '' && season === 1) {
        return true;
      }
      // match number from afterTitle
      const seasonIndex = afterTitle.match(/\d+/);
      if (seasonIndex && seasonIndex[0] === season.toString()) {
        return true;
      }
      // match chinese number
      const chineseNumber = afterTitle.match(/[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+/);
      if (chineseNumber && convertChineseNumber(chineseNumber[0]) === season) {
        return true;
      }
    }
    return false;
  } else {
    return false;
  }
}

async function handleVodAnimes(animesVod, curAnimes, key) {
  const processVodAnimes = await Promise.all(animesVod.map(async (anime) => {
    let vodPlayFromList = anime.vod_play_from.split("$$$");
    vodPlayFromList = vodPlayFromList.map(item => {
      if (item === "mgtv") return "imgo";
      if (item === "bilibili") return "bilibili1";
      return item;
    });

    const vodPlayUrlList = anime.vod_play_url.split("$$$");
    const validIndices = vodPlayFromList
        .map((item, index) => vodAllowedPlatforms.includes(item) ? index : -1)
        .filter(index => index !== -1);

    let links = [];
    let count = 0;
    for (const num of validIndices) {
      const platform = vodPlayFromList[num];
      const eps = vodPlayUrlList[num].split("#");
      for (const ep of eps) {
        const epInfo = ep.split("$");
        count++;
        links.push({
          "name": count,
          "url": epInfo[1],
          "title": `【${platform}】 #${epInfo[0]}#`
        });
      }
    }

    if (links.length > 0) {
      let transformedAnime = {
        animeId: Number(anime.vod_id),
        bangumiId: String(anime.vod_id),
        animeTitle: `${anime.vod_name}(${anime.vod_year})【${anime.type_name}】from ${key}`,
        type: anime.type_name,
        typeDescription: anime.type_name,
        imageUrl: anime.vod_pic,
        startDate: `${anime.vod_year}-01-01T00:00:00`,
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
      };

      curAnimes.push(transformedAnime);
      const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
      if (!exists) {
        const transformedAnimeCopy = {...transformedAnime, links: links};
        addAnime(transformedAnimeCopy);
      }
      if (animes.length > MAX_ANIMES) removeEarliestAnime();
    }
  }));

  return processVodAnimes;
}

async function handle360Animes(animes360, curAnimes) {
  const process360Animes = await Promise.all(animes360.map(async (anime) => {
    let links = [];
    if (anime.cat_name === "电影") {
      for (const key of Object.keys(anime.playlinks)) {
        if (vodAllowedPlatforms.includes(key)) {
          links.push({
            "name": key,
            "url": anime.playlinks[key],
            "title": `【${key}】${anime.titleTxt}(${anime.year})`
          });
        }
      }
    } else if (anime.cat_name === "电视剧" || anime.cat_name === "动漫") {
      if (vodAllowedPlatforms.includes(anime.seriesSite)) {
        for (let i = 0; i < anime.seriesPlaylinks.length; i++) {
          const item = anime.seriesPlaylinks[i];
          links.push({
            "name": i + 1,
            "url": item.url,
            "title": `【${anime.seriesSite}】 #${i + 1}#`
          });
        }
      }
    } else if (anime.cat_name === "综艺") {
      const zongyiLinks = await Promise.all(
          Object.keys(anime.playlinks_year).map(async (site) => {
            if (vodAllowedPlatforms.includes(site)) {
              const yearLinks = await Promise.all(
                  anime.playlinks_year[site].map(async (year) => {
                    return await get360Zongyi(anime.titleTxt, anime.id, site, year);
                  })
              );
              return yearLinks.flat(); // 将每个年份的子链接合并到一个数组
            }
            return [];
          })
      );
      links = zongyiLinks.flat(); // 扁平化所有返回的子链接
    }

    if (links.length > 0) {
      let transformedAnime = {
        animeId: Number(anime.id),
        bangumiId: String(anime.id),
        animeTitle: `${anime.titleTxt}(${anime.year})【${anime.cat_name}】from 360`,
        type: anime.cat_name,
        typeDescription: anime.cat_name,
        imageUrl: anime.cover,
        startDate: `${anime.year}-01-01T00:00:00`,
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
      };

      curAnimes.push(transformedAnime);
      const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
      if (!exists) {
        const transformedAnimeCopy = {...transformedAnime, links: links};
        addAnime(transformedAnimeCopy);
      }
      if (animes.length > MAX_ANIMES) removeEarliestAnime();
    }
  }));

  return process360Animes;
}

async function handleRenrenAnimes(animesRenren, queryTitle, curAnimes) {
  // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
  const processRenrenAnimes = await Promise.all(animesRenren
    .filter(s => s.title.includes(queryTitle))
    .map(async (anime) => {
      const eps = await getEpisodes(anime.mediaId);
      let links = [];
      for (const ep of eps) {
        links.push({
          "name": ep.episodeIndex,
          "url": ep.episodeId,
          "title": `【${ep.provider}】 #${ep.title}#`
        });
      }

      if (links.length > 0) {
        let transformedAnime = {
          animeId: Number(anime.mediaId),
          bangumiId: String(anime.mediaId),
          animeTitle: `${anime.title}(${anime.year})【${anime.type}】from renren`,
          type: anime.type,
          typeDescription: anime.type,
          imageUrl: anime.imageUrl,
          startDate: `${anime.year}-01-01T00:00:00`,
          episodeCount: links.length,
          rating: 0,
          isFavorited: true,
        };

        curAnimes.push(transformedAnime);

        const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
        if (!exists) {
          const transformedAnimeCopy = {...transformedAnime, links: links};
          addAnime(transformedAnimeCopy);
        }

        if (animes.length > MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  return processRenrenAnimes;
}

async function handleHanjutvAnimes(animesHanjutv, queryTitle, curAnimes) {
  const cateMap = {1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧"}

  function getCategory(key) {
    return cateMap[key] || "其他";
  }

  // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
  const processHanjutvAnimes = await Promise.all(animesHanjutv
    .filter(s => s.name.includes(queryTitle))
    .map(async (anime) => {
      const detail = await getHanjutvDetail(anime.sid);
      const eps = await getHanjutvEpisodes(anime.sid);
      let links = [];
      for (const ep of eps) {
        const epTitle = ep.title && ep.title.trim() !== "" ? `第${ep.serialNo}集：${ep.title}` : `第${ep.serialNo}集`;
        links.push({
          "name": ep.title,
          "url": ep.pid,
          "title": `【hanjutv】 #${epTitle}#`
        });
      }

      if (links.length > 0) {
        let transformedAnime = {
          animeId: anime.animeId,
          bangumiId: String(anime.animeId),
          animeTitle: `${anime.name}(${new Date(anime.updateTime).getFullYear()})【${getCategory(detail.category)}】from hanjutv`,
          type: getCategory(detail.category),
          typeDescription: getCategory(detail.category),
          imageUrl: anime.image.thumb,
          startDate: `${new Date(anime.updateTime).getFullYear()}-01-01T00:00:00`,
          episodeCount: links.length,
          rating: detail.rank,
          isFavorited: true,
        };

        curAnimes.push(transformedAnime);

        const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
        if (!exists) {
          const transformedAnimeCopy = {...transformedAnime, links: links};
          addAnime(transformedAnimeCopy);
        }

        if (animes.length > MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  return processHanjutvAnimes;
}

async function handleBahamutAnimes(animesBahamut, queryTitle, curAnimes) {
  // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
  const processBahamutAnimes = await Promise.all(animesBahamut
    .filter(s => s.title.includes(queryTitle))
    .map(async (anime) => {
      const epData = await getBahamutEpisodes(anime.video_sn);
      const detail = epData.video;
      const eps = epData.anime.episodes["0"]
      let links = [];
      for (const ep of eps) {
        const epTitle = `第${ep.episode}集`;
        links.push({
          "name": ep.episode,
          "url": ep.videoSn.toString(),
          "title": `【bahamut】 #${epTitle}#`
        });
      }

      if (links.length > 0) {
        let transformedAnime = {
          animeId: anime.video_sn,
          bangumiId: String(anime.video_sn),
          animeTitle: `${simplized(anime.title)}(${(anime.info.match(/(\d{4})/) || [null])[0]})【动漫】from bahamut`,
          type: "动漫",
          typeDescription: "动漫",
          imageUrl: anime.cover,
          startDate: `${new Date(epData.anime.seasonStart).getFullYear()}-01-01T00:00:00`,
          episodeCount: links.length,
          rating: detail.rating,
          isFavorited: true,
        };

        curAnimes.push(transformedAnime);

        const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
        if (!exists) {
          const transformedAnimeCopy = {...transformedAnime, links: links};
          addAnime(transformedAnimeCopy);
        }

        if (animes.length > MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  return processBahamutAnimes;
}

async function handleTencentAnimes(animesTencent, queryTitle, curAnimes) {
  // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
  const processTencentAnimes = await Promise.all(animesTencent
    .filter(s => s.title.includes(queryTitle))
    .map(async (anime) => {
      const eps = await getTencentEpisodes(anime.mediaId);
      let links = [];

      for (let i = 0; i < eps.length; i++) {
        const ep = eps[i];
        const epTitle = ep.unionTitle || ep.title || `第${i + 1}集`;
        // 构建完整URL: https://v.qq.com/x/cover/{cid}/{vid}.html
        const fullUrl = `https://v.qq.com/x/cover/${anime.mediaId}/${ep.vid}.html`;
        links.push({
          "name": i + 1,
          "url": fullUrl,
          "title": `【tencent】 #${epTitle}#`
        });
      }

      if (links.length > 0) {
        // 将字符串mediaId转换为数字ID (使用哈希函数)
        const numericAnimeId = convertToAsciiSum(anime.mediaId);
        let transformedAnime = {
          animeId: numericAnimeId,
          bangumiId: anime.mediaId,
          animeTitle: `${anime.title}(${anime.year})【${anime.type}】from tencent`,
          type: anime.type,
          typeDescription: anime.type,
          imageUrl: anime.imageUrl,
          startDate: `${anime.year}-01-01T00:00:00`,
          episodeCount: links.length,
          rating: 0,
          isFavorited: true,
        };

        curAnimes.push(transformedAnime);

        const exists = animes.some(existingAnime => existingAnime.animeId.toString() === transformedAnime.animeId.toString());
        if (!exists) {
          const transformedAnimeCopy = {...transformedAnime, links: links};
          addAnime(transformedAnimeCopy);
        }

        if (animes.length > MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  return processTencentAnimes;
}

// Extracted function for GET /api/v2/search/anime
async function searchAnime(url) {
  const queryTitle = url.searchParams.get("keyword");
  log("info", `Search anime with keyword: ${queryTitle}`);

  const curAnimes = [];

  // 链接弹幕解析
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
  if (urlRegex.test(queryTitle)) {
    const tmpAnime = {
      "animeId": 111,
      "bangumiId": "string",
      "animeTitle": queryTitle,
      "type": "type",
      "typeDescription": "string",
      "imageUrl": "string",
      "startDate": "2025-08-08T13:25:11.189Z",
      "episodeCount": 1,
      "rating": 0,
      "isFavorited": true
    };

    let platform = "all";
    if (queryTitle.includes(".qq.com")) {
      platform = "qq";
    } else if (queryTitle.includes(".iqiyi.com")) {
      platform = "qiyi";
    } else if (queryTitle.includes(".mgtv.com")) {
      platform = "imgo";
    } else if (queryTitle.includes(".youku.com")) {
      platform = "youku";
    } else if (queryTitle.includes(".bilibili.com")) {
      platform = "bilibili1";
    }

    const links = [{
      "name": "手动解析链接弹幕",
      "url": queryTitle,
      "title": `【${platform}】 #${queryTitle}#`
    }];
    curAnimes.push(tmpAnime);
    const exists = animes.some(existingAnime => existingAnime.animeId === tmpAnime.animeId);
    if (!exists) {
      const transformedAnimeCopy = {...tmpAnime, links: links};
      addAnime(transformedAnimeCopy);
    }
    if (animes.length > MAX_ANIMES) removeEarliestAnime();

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: curAnimes,
    });
  }

  try {
    // 根据 sourceOrderArr 动态构建请求数组
    log("info", `Search sourceOrderArr: ${sourceOrderArr}`);
    const requestPromises = sourceOrderArr.map(source => {
      if (source === "360") return get360Animes(queryTitle);
      if (source === "vod") return getVodAnimesFromAllServers(queryTitle, vodServers);
      if (source === "renren") return renrenSearch(queryTitle);
      if (source === "hanjutv") return hanjutvSearch(queryTitle);
      if (source === "bahamut") return bahamutSearch(traditionalized(queryTitle));
      if (source === "tencent") return tencentSearch(queryTitle);
    });

    // 执行所有请求并等待结果
    const results = await Promise.all(requestPromises);

    // 创建一个对象来存储返回的结果
    const resultData = {};

    // 动态根据 sourceOrderArr 顺序将结果赋值给对应的来源
    sourceOrderArr.forEach((source, index) => {
      resultData[source] = results[index];  // 根据顺序赋值
    });

    // 解构出返回的结果
    const { vod: animesVodResults, 360: animes360, renren: animesRenren, hanjutv: animesHanjutv, bahamut: animesBahamut, tencent: animesTencent } = resultData;

    // 按顺序处理每个来源的结果
    for (const key of sourceOrderArr) {
      if (key === '360') {
        // 等待处理360来源
        await handle360Animes(animes360, curAnimes);
      } else if (key === 'vod') {
        // 等待处理Vod来源（遍历所有VOD服务器的结果）
        if (animesVodResults && Array.isArray(animesVodResults)) {
          for (const vodResult of animesVodResults) {
            if (vodResult && vodResult.list && vodResult.list.length > 0) {
              await handleVodAnimes(vodResult.list, curAnimes, vodResult.serverName);
            }
          }
        }
      } else if (key === 'renren') {
        // 等待处理Renren来源
        await handleRenrenAnimes(animesRenren, queryTitle, curAnimes);
      } else if (key === 'hanjutv') {
        // 等待处理Hanjutv来源
        await handleHanjutvAnimes(animesHanjutv, queryTitle, curAnimes);
      } else if (key === 'bahamut') {
        // 等待处理Bahamut来源
        await handleBahamutAnimes(animesBahamut, traditionalized(queryTitle), curAnimes);
      } else if (key === 'tencent') {
        // 等待处理Tencent来源
        await handleTencentAnimes(animesTencent, queryTitle, curAnimes);
      }
    }
  } catch (error) {
    log("error", "发生错误:", error);
  }

  storeAnimeIdsToMap(curAnimes, queryTitle);

  // 如果有新的anime获取到，则更新redis
  if (redisValid && curAnimes.length !== 0) {
      await updateCaches();
  }

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: curAnimes,
  });
}

function filterSameEpisodeTitle(filteredTmpEpisodes) {
    const filteredEpisodes = filteredTmpEpisodes.filter((episode, index, episodes) => {
        const filterEp = extractEpTitle(episode.episodeTitle);
        // 如果没有提取到标题，返回 true 保留该 episode
        if (!filterEp) return true;
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            const prevFilterEp = extractEpTitle(prevEpisode.episodeTitle);
            return prevFilterEp === filterEp;
        });
    });
    return filteredEpisodes;
}

async function matchAniAndEp(season, episode, searchData, title, req, platform, preferAnimeId) {
  let resAnime;
  let resEpisode;
  if (season && episode) {
    // 判断剧集
    for (const anime of searchData.animes) {
      if (preferAnimeId && anime.bangumiId.toString() !== preferAnimeId.toString()) continue;
      if (anime.animeTitle.includes(title)) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", "判断剧集", bangumiData);

        // 过滤集标题正则条件的 episode
        const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
          const filterEp = extractEpTitle(episode.episodeTitle);
          return filterEp && !episodeTitleFilter.test(filterEp);  // 如果##中的内容匹配正则表达式
        });

        // 过滤集标题一致的 episode，且保留首次出现的集标题的 episode
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);
        log("info", "过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        if (platform) {
          const firstIndex = filteredEpisodes.findIndex(episode => extractTitle(episode.episodeTitle) === platform);
          const indexCount = filteredEpisodes.filter(episode => extractTitle(episode.episodeTitle) === platform).length;
          if (indexCount > 0 && indexCount >= episode) {
            // 先判断season
            if (matchSeason(anime, title, season)) {
              resEpisode = filteredEpisodes[firstIndex + episode - 1];
              resAnime = anime;
              break;
            }
          }
        } else {
          if (filteredEpisodes.length >= episode) {
            // 先判断season
            if (matchSeason(anime, title, season)) {
              resEpisode = filteredEpisodes[episode - 1];
              resAnime = anime;
              break;
            }
          }
        }
      }
    }
  } else {
    // 判断电影
    for (const anime of searchData.animes) {
      if (preferAnimeId && anime.bangumiId.toString() !== preferAnimeId.toString()) continue;
      const animeTitle = anime.animeTitle.split("(")[0].trim();
      if (animeTitle === title) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", bangumiData);

        if (platform) {
          const firstIndex = bangumiData.bangumi.episodes.findIndex(episode => extractTitle(episode.episodeTitle) === platform);
          const indexCount = bangumiData.bangumi.episodes.filter(episode => extractTitle(episode.episodeTitle) === platform).length;
          if (indexCount > 0) {
            resEpisode = bangumiData.bangumi.episodes[firstIndex];
            resAnime = anime;
            break;
          }
        } else {
          if (bangumiData.bangumi.episodes.length > 0) {
            resEpisode = bangumiData.bangumi.episodes[0];
            resAnime = anime;
            break;
          }
        }
      }
    }
  }
  return {resEpisode, resAnime};
}

async function fallbackMatchAniAndEp(searchData, req, season, episode, resEpisode, resAnime) {
  for (const anime of searchData.animes) {
    let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
    const bangumiRes = await getBangumi(originBangumiUrl.pathname);
    const bangumiData = await bangumiRes.json();
    log("info", bangumiData);
    if (season && episode) {
      // 过滤集标题正则条件的 episode
      const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
        const filterEp = extractEpTitle(episode.episodeTitle);
        return filterEp && !episodeTitleFilter.test(filterEp);  // 如果##中的内容匹配正则表达式
      });

      // 过滤集标题一致的 episode，且保留首次出现的集标题的 episode
      const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);

      if (filteredEpisodes.length >= episode) {
        resEpisode = filteredEpisodes[episode - 1];
        resAnime = anime;
        break;
      }
    } else {
      if (bangumiData.bangumi.episodes.length > 0) {
        resEpisode = bangumiData.bangumi.episodes[0];
        resAnime = anime;
        break;
      }
    }
  }
  return {resEpisode, resAnime};
}

// Extracted function for POST /api/v2/match
async function matchAnime(url, req) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body) {
      log("error", "Request body is empty");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Empty request body" },
        400
      );
    }

    // 处理请求体中的数据
    // 假设请求体包含一个字段，比如 { query: "anime name" }
    const { fileName } = body;
    if (!fileName) {
      log("error", "Missing fileName parameter in request body");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing fileName parameter" },
        400
      );
    }

    // 解析fileName，提取平台偏好
    const { cleanFileName, preferredPlatform } = parseFileName(fileName);
    log("info", `Processing anime match for query: ${fileName}`);
    log("info", `Parsed cleanFileName: ${cleanFileName}, preferredPlatform: ${preferredPlatform}`);

    const regex = /^(.+?)[.\s]+S(\d+)E(\d+)/i;
    const match = cleanFileName.match(regex);

    let title = match ? match[1].trim() : cleanFileName;
    let season = match ? parseInt(match[2]) : null;
    let episode = match ? parseInt(match[3]) : null;

    log("info", "Parsed title, season, episode", { title, season, episode });

    let originSearchUrl = new URL(req.url.replace("/match", `/search/anime?keyword=${title}`));
    const searchRes = await searchAnime(originSearchUrl);
    const searchData = await searchRes.json();
    log("info", `searchData: ${searchData.animes}`);

    // 获取prefer animeId
    const preferAnimeId = getPreferAnimeId(title);
    log("info", `prefer animeId: ${preferAnimeId}`);

    let resAnime;
    let resEpisode;

    // 根据指定平台创建动态平台顺序
    const dynamicPlatformOrder = createDynamicPlatformOrder(preferredPlatform);
    log("info", `Original platformOrderArr: ${platformOrderArr}`);
    log("info", `Dynamic platformOrder: ${dynamicPlatformOrder}`);
    log("info", `Preferred platform: ${preferredPlatform || 'none'}`);

    for (const platform of dynamicPlatformOrder) {
      const __ret = await matchAniAndEp(season, episode, searchData, title, req, platform, preferAnimeId);
      resEpisode = __ret.resEpisode;
      resAnime = __ret.resAnime;

      if (resAnime) {
        log("info", `Found match with platform: ${platform || 'default'}`);
        break;
      }
    }

    // 如果都没有找到则返回第一个满足剧集数的剧集
    if (!resAnime) {
      const __ret = await fallbackMatchAniAndEp(searchData, req, season, episode, resEpisode, resAnime);
      resEpisode = __ret.resEpisode;
      resAnime = __ret.resAnime;
    }

    let resData = {
      "errorCode": 0,
      "success": true,
      "errorMessage": "",
      "isMatched": false,
      "matches": []
    };

    if (resEpisode) {
      resData["isMatched"] = true;
      resData["matches"] = [
        {
          "episodeId": resEpisode.episodeId,
          "animeId": resAnime.animeId,
          "animeTitle": resAnime.animeTitle,
          "episodeTitle": resEpisode.episodeTitle,
          "type": resAnime.type,
          "typeDescription": resAnime.typeDescription,
          "shift": 0,
          "imageUrl": resAnime.imageUrl
        }
      ]
    }

    log("info", `resMatchData: ${resData}`);

    // 示例返回
    return jsonResponse(resData);
  } catch (error) {
    // 处理 JSON 解析错误或其他异常
    log("error", `Failed to parse request body: ${error.message}`);
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Invalid JSON body" },
      400
    );
  }
}

// Extracted function for GET /api/v2/search/episodes
async function searchEpisodes(url) {
  const anime = url.searchParams.get("anime");
  const episode = url.searchParams.get("episode") || "";
  
  log("info", `Search episodes with anime: ${anime}, episode: ${episode}`);

  if (!anime) {
    log("error", "Missing anime parameter");
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Missing anime parameter" },
      400
    );
  }

  // 先搜索动漫
  let searchUrl = new URL(`/search/anime?keyword=${anime}`, url.origin);
  const searchRes = await searchAnime(searchUrl);
  const searchData = await searchRes.json();
  
  if (!searchData.success || !searchData.animes || searchData.animes.length === 0) {
    log("info", "No anime found for the given title");
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      hasMore: false,
      animes: []
    });
  }

  let resultAnimes = [];

  // 遍历所有找到的动漫，获取它们的集数信息
  for (const animeItem of searchData.animes) {
    const bangumiUrl = new URL(`/bangumi/${animeItem.bangumiId}`, url.origin);
    const bangumiRes = await getBangumi(bangumiUrl.pathname);
    const bangumiData = await bangumiRes.json();
    
    if (bangumiData.success && bangumiData.bangumi && bangumiData.bangumi.episodes) {
      let filteredEpisodes = bangumiData.bangumi.episodes;

      // 根据 episode 参数过滤集数
      if (episode) {
        if (episode === "movie") {
          // 仅保留剧场版结果
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep => 
            animeItem.typeDescription && (
              animeItem.typeDescription.includes("电影") || 
              animeItem.typeDescription.includes("剧场版") ||
              ep.episodeTitle.toLowerCase().includes("movie") ||
              ep.episodeTitle.includes("剧场版")
            )
          );
        } else if (/^\d+$/.test(episode)) {
          // 纯数字，仅保留指定集数
          const targetEpisode = parseInt(episode);
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep => 
            parseInt(ep.episodeNumber) === targetEpisode
          );
        }
      }

      // 只有当过滤后还有集数时才添加到结果中
      if (filteredEpisodes.length > 0) {
        resultAnimes.push({
          animeId: animeItem.animeId,
          animeTitle: animeItem.animeTitle,
          type: animeItem.type,
          typeDescription: animeItem.typeDescription,
          episodes: filteredEpisodes.map(ep => ({
            episodeId: ep.episodeId,
            episodeTitle: ep.episodeTitle
          }))
        });
      }
    }
  }

  log("info", `Found ${resultAnimes.length} animes with filtered episodes`);

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: resultAnimes
  });
}

// Extracted function for GET /api/v2/bangumi/:animeId
async function getBangumi(path) {
  const idParam = path.split("/").pop();
  const animeId = parseInt(idParam);

  // 尝试通过 animeId(数字) 或 bangumiId(字符串) 查找
  let anime;
  if (!isNaN(animeId)) {
    // 如果是有效数字,先尝试通过 animeId 查找
    anime = animes.find((a) => a.animeId.toString() === animeId.toString());
  }

  // 如果通过 animeId 未找到,尝试通过 bangumiId 查找
  if (!anime) {
    anime = animes.find((a) => a.bangumiId === idParam);
  }

  if (!anime) {
    log("error", `Anime with ID ${idParam} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  log("info", `Fetched details for anime ID: ${idParam}`);

  let resData = {
    errorCode: 0,
    success: true,
    errorMessage: "",
    bangumi: {
      animeId: anime.animeId,
      bangumiId: anime.bangumiId,
      animeTitle: anime.animeTitle,
      imageUrl: anime.imageUrl,
      isOnAir: true,
      airDay: 1,
      isFavorited: anime.isFavorited,
      rating: anime.rating,
      type: anime.type,
      typeDescription: anime.typeDescription,
      seasons: [
        {
          id: `season-${anime.animeId}`,
          airDate: anime.startDate,
          name: "Season 1",
          episodeCount: anime.episodeCount,
        },
      ],
      episodes: [],
    },
  };

  for (let i = 0; i < anime.links.length; i++) {
    const link = anime.links[i];
    resData["bangumi"]["episodes"].push({
          seasonId: `season-${anime.animeId}`,
          episodeId: link.id,
          episodeTitle: `${link.title}`,
          episodeNumber: `${i+1}`,
          airDate: anime.startDate,
        });
  }

  return jsonResponse(resData);
}

// Extracted function for GET /api/v2/comment/:commentId
async function getComment(path) {
  const commentId = parseInt(path.split("/").pop());
  let url = findUrlById(commentId);
  let title = findTitleById(commentId);
  let plat = title ? (title.match(/【(.*?)】/) || [null])[0]?.replace(/[【】]/g, '') : null;
  log("info", "comment url...", url);
  log("info", "comment title...", title);
  log("info", "comment platform...", plat);
  if (!url) {
    log("error", `Comment with ID ${commentId} not found`);
    return jsonResponse({ count: 0, comments: [] }, 404);
  }
  log("info", `Fetched comment ID: ${commentId}`);

  // 处理302场景
  // https://v.youku.com/video?vid=XNjQ4MTIwOTE2NA==&tpa=dW5pb25faWQ9MTAyMjEzXzEwMDAwNl8wMV8wMQ需要转成https://v.youku.com/v_show/id_XNjQ4MTIwOTE2NA==.html
  if (url.includes("youku.com/video?vid")) {
      url = convertYoukuUrl(url);
  }

  log("info", "开始从本地请求弹幕...", url);
  let danmus = [];
  if (url.includes('.qq.com')) {
    danmus = await fetchTencentVideo(url);
  } else if (url.includes('.iqiyi.com')) {
    danmus = await fetchIqiyi(url);
  } else if (url.includes('.mgtv.com')) {
    danmus = await fetchMangoTV(url);
  } else if (url.includes('.bilibili.com')) {
    danmus = await fetchBilibili(url);
  } else if (url.includes('.youku.com')) {
    danmus = await fetchYouku(url);
  }

  // 请求其他平台弹幕
  const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
  if (!urlPattern.test(url)) {
    if (plat === "renren") {
      danmus = await getRenRenComments(url);
    } else if (plat === "hanjutv") {
      danmus = await getHanjutvComments(url);
    } else if (plat === "bahamut") {
      danmus = await getBahamutComments(url);
    }
  }

  // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
  if (danmus.length === 0 && urlPattern.test(url)) {
    danmus = await fetchOtherServer(url);
  }

  const animeId = findAnimeIdByCommentId(commentId);
  setPreferByAnimeId(animeId);
  if (redisValid && animeId) {
    await setRedisKey('lastSelectMap', lastSelectMap);
  }

  return jsonResponse({ count: danmus.length, comments: danmus });
}

// Extracted function for POST /api/v2/comment/by-url
async function getCommentByUrl(req) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body || !body.videoUrl) {
      log("error", "Missing videoUrl parameter in request body");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing videoUrl parameter", count: 0, comments: [] },
        400
      );
    }

    const videoUrl = body.videoUrl.trim();

    // 验证URL格式
    if (!videoUrl.startsWith('http')) {
      log("error", "Invalid videoUrl format");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Invalid videoUrl format", count: 0, comments: [] },
        400
      );
    }

    log("info", `Processing comment request for URL: ${videoUrl}`);

    // 处理优酷302场景
    let url = videoUrl;
    if (url.includes("youku.com/video?vid")) {
      url = convertYoukuUrl(url);
    }

    log("info", "开始从本地请求弹幕...", url);
    let danmus = [];

    // 根据URL域名判断平台并获取弹幕
    if (url.includes('.qq.com')) {
      danmus = await fetchTencentVideo(url);
    } else if (url.includes('.iqiyi.com')) {
      danmus = await fetchIqiyi(url);
    } else if (url.includes('.mgtv.com')) {
      danmus = await fetchMangoTV(url);
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      danmus = await fetchBilibili(url);
    } else if (url.includes('.youku.com')) {
      danmus = await fetchYouku(url);
    } else {
      // 如果不是已知平台，尝试第三方弹幕服务器
      const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
      if (urlPattern.test(url)) {
        danmus = await fetchOtherServer(url);
      }
    }

    log("info", `Successfully fetched ${danmus.length} comments from URL`);

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    });
  } catch (error) {
    // 处理 JSON 解析错误或其他异常
    log("error", `Failed to process comment by URL request: ${error.message}`);
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}

async function handleRequest(req, env, deployPlatform, clientIp) {
  token = resolveToken(env);  // 每次请求动态获取，确保热更新环境变量后也能生效
  envs["token"] = encryptStr(token);
  otherServer = resolveOtherServer(env);
  envs["otherServer"] = otherServer;
  vodServers = resolveVodServers(env);
  envs["vodServers"] = vodServers.map(s => `${s.name}@${s.url}`).join(',');
  bilibliCookie = resolveBilibiliCookie(env);
  envs["bilibliCookie"] = encryptStr(bilibliCookie);
  youkuConcurrency = resolveYoukuConcurrency(env);
  envs["youkuConcurrency"] = youkuConcurrency;
  sourceOrderArr = resolveSourceOrder(env, deployPlatform);
  envs["sourceOrderArr"] = sourceOrderArr;
  platformOrderArr = resolvePlatformOrder(env);
  envs["platformOrderArr"] = platformOrderArr;
  episodeTitleFilter = resolveEpisodeTitleFilter(env);
  envs["episodeTitleFilter"] = episodeTitleFilter.toString();
  blockedWords = resolveBlockedWords(env);
  envs["blockedWords"] = blockedWords;
  groupMinute = resolveGroupMinute(env);
  envs["groupMinute"] = groupMinute;
  rateLimitMaxRequests = resolveRateLimitMaxRequests(env);
  envs["rateLimitMaxRequests"] = rateLimitMaxRequests;
  proxyUrl = resolveProxyUrl(env);
  envs["proxyUrl"] = proxyUrl;
  redisUrl = resolveRedisUrl(env);
  envs["redisUrl"] = encryptStr(redisUrl);
  redisToken = resolveRedisToken(env);
  envs["redisToken"] = encryptStr(redisToken);
  envs["redisValid"] = redisValid;

  // 测试redis是否可用
  if (!redisValid && redisUrl && redisToken) {
    const res = await pingRedis();
    if (res && res.result && res.result === "PONG") {
      redisValid = true;
      envs["redisValid"] = redisValid;
    }
  }

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

  log("info", `request url: ${JSON.stringify(url)}`);
  log("info", `client ip: ${clientIp}`);

  if (redisValid && path !== "/favicon.ico" && path !== "/robots.txt") {
    await getCaches();
  }

  function handleHomepage() {
    log("info", "Accessed homepage with repository information");
    return jsonResponse({
      message: "Welcome to the LogVar Danmu API server",
      version: VERSION,
      envs: envs,
      repository: "https://github.com/huangxd-/danmu_api.git",
      description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口，并提供日志记录，支持vercel/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
      notice: "本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok。https://t.me/ddjdd_bot"
    });
  }

  // GET /
  if (path === "/" && method === "GET") {
    return handleHomepage();
  }

  if (path === "/favicon.ico" || path === "/robots.txt") {
    return new Response(null, { status: 204 });
  }

  // --- 校验 token ---
  const parts = path.split("/").filter(Boolean); // 去掉空段
  if (parts.length < 1 || parts[0] !== token) {
    log("error", `Invalid or missing token in path: ${path}`);
    return jsonResponse(
      { errorCode: 401, success: false, errorMessage: "Unauthorized" },
      401
    );
  }
  // 移除 token 部分，剩下的才是真正的路径
  path = "/" + parts.slice(1).join("/");

  log("info", path);

  // 智能处理API路径前缀，确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/api/logs") {
      log("info", `[Path Check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改
      
      // 1. 清理：应对“用户填写/api/v2”+“客户端添加/api/v2”导致的重复前缀
      while (path.startsWith('/api/v2/api/v2/')) {
          log("info", `[Path Check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取，相当于移除第一个
          path = path.substring('/api/v2'.length);
      }
      
      // 打印日志：只有在发生清理时才显示清理后的路径，否则显示“无需清理”
      if (path !== pathBeforeCleanup) {
          log("info", `[Path Check] Path after cleanup: "${path}"`);
      } else {
          log("info", `[Path Check] Path after cleanup: No cleanup needed.`);
      }
      
      // 2. 补全：如果路径缺少前缀（例如请求原始路径为 /search/anime），则补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs')) {
          log("info", `[Path Check] Path is missing /api/v2 prefix. Adding...`);
          path = '/api/v2' + path;
      }
        
      // 打印日志：只有在发生添加前缀时才显示添加后的路径，否则显示“无需补全”
      if (path === pathBeforePrefixCheck) {
          log("info", `[Path Check] Prefix Check: No prefix addition needed.`);
      }
      
      log("info", `[Path Check] Final normalized path: "${path}"`);
  }
  
  // GET /
  if (path === "/" && method === "GET") {
    return handleHomepage();
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

  // POST /api/v2/comment/by-url
  if (path === "/api/v2/comment/by-url" && method === "POST") {
    return getCommentByUrl(req);
  }

  // GET /api/v2/comment/:commentId
  if (path.startsWith("/api/v2/comment/") && method === "GET") {
    // 限流检查（如果 rateLimitMaxRequests > 0 则启用限流）
    if (rateLimitMaxRequests > 0) {
      // 获取当前时间戳（单位：毫秒）
      const currentTime = Date.now();
      const oneMinute = 60 * 1000;  // 1分钟 = 60000 毫秒

      // 检查该 IP 地址的历史请求
      if (!requestHistory.has(clientIp)) {
        // 如果该 IP 地址没有请求历史，初始化一个空队列
        requestHistory.set(clientIp, []);
      }

      const history = requestHistory.get(clientIp);

      // 过滤掉已经超出 1 分钟的请求
      const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

      // 如果最近的请求数量大于等于配置的限制次数，则限制请求
      if (recentRequests.length >= rateLimitMaxRequests) {
        // 清理过期记录（如果为空则删除键，避免内存泄漏）
        if (recentRequests.length === 0) {
          requestHistory.delete(clientIp);
        } else {
          requestHistory.set(clientIp, recentRequests);
        }

        return jsonResponse({
          status: 429, // HTTP 429 Too Many Requests
          body: `1分钟内同一IP只能请求弹幕${rateLimitMaxRequests}次，请稍后重试`,
        });
      }

      // 将当前请求的时间戳添加到该 IP 地址的请求历史队列中
      recentRequests.push(currentTime);

      // 更新该 IP 地址的请求历史
      requestHistory.set(clientIp, recentRequests);
    }

    return getComment(path);
  }

  // GET /api/logs
  if (path === "/api/logs" && method === "GET") {
    const logText = logBuffer
      .map(
        (log) =>
          `[${log.timestamp}] ${log.level}: ${formatLogMessage(log.message)}`
      )
      .join("\n");
    return new Response(logText, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  return jsonResponse({ message: "Not found" }, 404);
}



// --- Cloudflare Workers 入口 ---
export default {
  async fetch(request, env, ctx) {
    // 获取客户端的真实 IP
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    return handleRequest(request, env, "cloudflare", clientIp);
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

// 为了测试导出 handleRequest
export { handleRequest, searchAnime, searchEpisodes, matchAnime, getBangumi, getComment, getCommentByUrl, fetchTencentVideo, fetchIqiyi,
  fetchMangoTV, fetchBilibili, fetchYouku, fetchOtherServer, httpGet, httpPost, hanjutvSearch, getHanjutvEpisodes,
  getHanjutvComments, getHanjutvDetail, bahamutSearch, getBahamutEpisodes, getBahamutComments, tencentSearch, getTencentEpisodes,
  pingRedis, getRedisKey, setRedisKey, setRedisKeyWithExpiry};
