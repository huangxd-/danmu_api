// 全局状态（Cloudflare 和 Vercel 都可能重用实例）
// ⚠️ 不是持久化存储，每次冷启动会丢失
const VERSION = "1.2.2";
let animes = [];
let episodeIds = [];
let episodeNum = 10001; // 全局变量，用于自增 ID

// 日志存储，最多保存 500 行
const logBuffer = [];
const MAX_LOGS = 500;
const MAX_ANIMES = 100;
const allowedPlatforms = ["qiyi", "bilibili1", "imgo", "youku", "qq"];
// 👇 新增代码开始
// 新增：用户选择的弹幕源存储（key: 会话ID, value: { platform, expire }）
const userPlatformSelections = new Map();
// 新增：清理间隔（2小时）
const CLEAN_INTERVAL = 2 * 60 * 60 * 1000; // 毫秒
// 新增：会话有效期（2小时）
const SESSION_EXPIRE = 2 * 60 * 60 * 1000;

// 新增：定期清理过期会话
function startCleanupTimer() {
  setInterval(() => {
    const now = Date.now();
    let count = 0;
    for (const [sessionId, data] of userPlatformSelections) {
      if (now > data.expire) {
        userPlatformSelections.delete(sessionId);
        count++;
      }
    }
    if (count > 0) {
      log("log", `Cleaned up ${count} expired platform selections`);
    }
  }, CLEAN_INTERVAL);
}

// 启动清理定时器
startCleanupTimer();
// 👆 新增代码结束

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

const DEFAULT_VOD_SERVER = "https://www.caiji.cyou"; // 默认 vod站点
let vodServer = DEFAULT_VOD_SERVER;

function resolveVodServer(env) {
  if (env && env.VOD_SERVER) return env.VOD_SERVER;         // Cloudflare Workers
  if (typeof process !== "undefined" && process.env?.VOD_SERVER) return process.env.VOD_SERVER; // Vercel / Node
  return DEFAULT_VOD_SERVER;
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

const DEFAULT_SOURCE_ORDER = "vod,360,renren,hanjutv"; // 默认 源排序
let sourceOrderArr = [];

function resolveSourceOrder(env) {
  // 获取环境变量中的 SOURCE_ORDER 配置
  let sourceOrder = DEFAULT_SOURCE_ORDER;

  if (env && env.SOURCE_ORDER) {
    sourceOrder = env.SOURCE_ORDER;  // Cloudflare Workers
  } else if (typeof process !== "undefined" && process.env?.SOURCE_ORDER) {
    sourceOrder = process.env.SOURCE_ORDER;  // Vercel / Node
  }

  // 解析并校验 sourceOrder
  const allowedSources = ['vod', '360', 'renren', "hanjutv"];

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

  // 解析并校验 platformOrder
  const _allowedPlatforms = ["qiyi", "bilibili1", "imgo", "youku", "qq", "renren", "hanjutv"];

  // 转换为数组并去除空格，过滤无效项
  const orderArr = platformOrder
    .split(',')
    .map(s => s.trim())  // 去除空格
    .filter(s => _allowedPlatforms.includes(s));  // 只保留有效来源

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
  "NG镜头|NG花絮|番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|插曲|主题曲|背景音乐|OST|音乐MV|歌曲MV|前季回顾|" +
  "剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|抢先看|抢先版|" +
  "试看版|短剧|精编|会员版|Plus|独家版|特别版|短片|合唱|陪看|MV|高清正片|发布会|.{2,}篇|观察室|上班那点事儿|周top|赛段|直拍|REACTION|" +
  "VLOG|全纪录|开播|先导|总宣|展演"; // 默认 剧集标题正则过滤
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

  log("log", "EPISODE_TITLE_FILTER keywords: ", keywords);

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

// 👇 从这里开始插入新增代码（约186-187行）
// 新增：生成或获取用户会话ID（基于IP+UA哈希，保护隐私）
function getSessionId(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const userAgent = request.headers.get('User-Agent') || 'unknown';
  // 简单哈希避免直接暴露IP和UA
  return Array.from(new TextEncoder().encode(ip + userAgent))
    .reduce((acc, val) => (acc << 5) - acc + val, 0)
    .toString(36);
}

// 新增：处理用户手动设置弹幕源
function handlePlatformSelection(request) {
  const url = new URL(request.url);
  const setPlatform = url.searchParams.get('set_platform');
  if (!setPlatform) return null;

  // 验证平台合法性
  if (!allowedPlatforms.includes(setPlatform)) {
    log("warn", `Invalid platform selection: ${setPlatform}`);
    return null;
  }

  // 生成会话ID并存储选择（带过期时间）
  const sessionId = getSessionId(request);
  userPlatformSelections.set(sessionId, {
    platform: setPlatform,
    expire: Date.now() + SESSION_EXPIRE
  });
  log("log", `User ${sessionId} set platform to ${setPlatform}`);
  return setPlatform;
}
// 👆 新增代码结束

// =====================
// 数据结构处理函数
// =====================


// 添加元素到 episodeIds：检查 url 是否存在，若不存在则以自增 id 添加
function addEpisode(url, title) {
    // 检查是否已存在相同的 url
    const exists = episodeIds.some(episode => episode.url === url);
    if (exists) {
        log("log", `URL ${url} already exists in episodeIds, skipping addition.`);
        return null; // 返回 null 表示未添加
    }

    // 自增 episodeNum 并使用作为 id
    episodeNum++;
    const newEpisode = { id: episodeNum, url: url, title: title };

    // 添加新对象
    episodeIds.push(newEpisode);
    log("log", `Added to episodeIds: ${JSON.stringify(newEpisode)}`);
    return newEpisode; // 返回新添加的对象
}

// 删除指定 URL 的对象从 episodeIds
function removeEpisodeByUrl(url) {
    const initialLength = episodeIds.length;
    episodeIds = episodeIds.filter(episode => episode.url !== url);
    const removedCount = initialLength - episodeIds.length;
    if (removedCount > 0) {
        log("log", `Removed ${removedCount} episode(s) from episodeIds with URL: ${url}`);
        return true;
    }
    log("error", `No episode found in episodeIds with URL: ${url}`);
    return false;
}

// 根据 ID 查找 URL
function findUrlById(id) {
    const episode = episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("log", `Found URL for ID ${id}: ${episode.url}`);
        return episode.url;
    }
    log("error", `No URL found for ID: ${id}`);
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
    log("log", `Added anime: ${JSON.stringify(animeCopy)}`);

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
    log("log", `Removed earliest anime: ${JSON.stringify(removedAnime)}`);

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

// =====================
// 请求工具方法
// =====================

async function httpGet(url, options) {
  log("log", `[iOS模拟] HTTP GET: ${url}`);

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
      log("log", "base64模式");

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
      log("log", "zlib模式")

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
    throw error;
  }
}

async function httpPost(url, body, options = {}) {
  log("log", `[iOS模拟] HTTP POST: ${url}`);

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
    throw error;
  }
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
    log("log", "360kan response:", data);

    let animes = [];
    if ('rows' in data.data.longData) {
      animes = data.data.longData.rows;
    }

    log("log", `360kan animes.length: ${animes.length}`);

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
async function get360Zongyi(entId, site, year) {
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
      log("log", "360kan zongyi response:", data);

      const episodeList = data.data.list;
      if (!episodeList) {
        break;
      }
      for (const episodeInfo of episodeList) {
        links.push({"name": episodeInfo.id, "url": episodeInfo.url, "title": `【${site}】${episodeInfo.name}(${episodeInfo.period})`});
      }

      log("log", `links.length: ${links.length}`);
    }
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
async function getVodAnimes(title) {
  try {
    const response = await httpGet(
      `${vodServer}/api.php/provide/vod/?ac=detail&wd=${title}&pg=1`,
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      }
    );
    // 检查 response.data.list 是否存在且长度大于 0
    if (response && response.data && response.data.list && response.data.list.length > 0) {
      log("log", `请求 ${vodServer} 成功`);
      const data = response.data;
      log("log", "vod response: ↓↓↓");
      printFirst200Chars(data);
      return data.list;
    } else {
      log("log", `请求 ${vodServer} 成功，但 response.data.list 为空`);
      return [];
    }
  } catch (error) {
    log("error", `请求 ${vodServer} 失败:`, {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return [];
  }
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

  log("log", dataToPrint.slice(0, 200));  // 打印前200个字符
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
      attributes = [
        parseFloat(pValues[0]).toFixed(2),
        pValues[1] || 0,
        pValues[3] || 16777215,
        `[${platform}]`
      ].join(",");
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
        console.error(`无效的正则表达式: ${pattern}`, e);
        return null;
      }
    }
    return null; // 如果不是有效的正则格式则返回 null
  }).filter(regex => regex !== null); // 过滤掉无效的项

  log("log", "原始屏蔽词字符串:", blockedWords);
  const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
  log("log", "屏蔽词列表:", regexArrayToString(regexArray));

  // 过滤列表
  const filteredDanmus = danmus.filter(item => {
    return !regexArray.some(regex => regex.test(item.m)); // 针对 `m` 字段进行匹配
  });

  log("log", "danmus_original:", danmus.length);
  log("log", "danmus:", filteredDanmus.length);
  // 输出前五条弹幕
  log("log", "Top 5 danmus:", JSON.stringify(filteredDanmus.slice(0, 5), null, 2));
  return filteredDanmus;
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

function canConvertToNumber(url) {
  const number = Number(url);
  return !isNaN(number) && url === String(number);
}

// =====================
// 获取腾讯弹幕
// =====================

async function fetchTencentVideo(inputUrl) {
  log("log", "开始从本地请求腾讯视频弹幕...", inputUrl);

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

  log("log", "vid:", vid);

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
  log("log", "标题:", title);

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

  log("log", "弹幕分段数量:", promises.length);

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
  log("log", "开始从本地请求爱奇艺弹幕...", inputUrl);

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
    log("log", "tvid:", tvid);

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
    log("log", "解码后 tvid:", tvid);
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
    log("log", "标题:", title, "时长:", duration);
  } catch (error) {
    log("error", "请求视频基础信息失败:", error);
    return [];
  }

  // 计算弹幕分段数量（每5分钟一个分段）
  const page = Math.ceil(duration / (60 * 5));
  log("log", "弹幕分段数量:", page);

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
  log("log", "开始从本地请求芒果TV弹幕...", inputUrl);

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
    log("log", path);
  } else {
    log("error", 'Invalid URL');
    return [];
  }
  const cid = path[path.length - 2];
  const vid = path[path.length - 1].split(".")[0];

  log("log", "cid:", cid, "vid:", vid);

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
    log("log", "请求视频信息失败:", error);
    return [];
  }

  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const title = data.data.info.videoName;
  const time = data.data.info.time;
  log("log", "标题:", title);

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

  log("log", "弹幕分段数量:", promises.length);

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
  log("log", "开始从本地请求B站弹幕...", inputUrl);

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
    log("log", path);
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
      log("log", "p: ", p);

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
  log("log", danmakuUrl, cid, aid, duration);

  // 计算视频的分片数量
  const maxLen = Math.floor(duration / 360) + 1;
  log("log", "maxLen: ", maxLen);

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
        log("log", "正在请求弹幕数据...", segment.url);
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
  log("log", "开始从本地请求优酷弹幕...", inputUrl);

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
    log("log", path);
  } else {
    log("error", 'Invalid URL');
    return [];
  }
  const video_id = path[path.length - 1].split(".")[0].slice(3);

  log("log", "video_id:", video_id);

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
  log("log", "标题:", title, "时长:", duration);

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
    log("log", "cnaRes: ", cnaRes);
    log("log", "cnaRes.headers: ", cnaRes.headers);
    const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
    log("log", "etag: ", etag);
    // const match = cnaRes.headers["set-cookie"].match(/cna=([^;]+)/);
    // cna = match ? match[1] : null;
    cna = etag.replace(/^"|"$/g, '');
    log("log", "cna: ", cna);

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
    log("log", "tkEncRes: ", tkEncRes);
    log("log", "tkEncRes.headers: ", tkEncRes.headers);
    const tkEncSetCookie = tkEncRes.headers["set-cookie"] || tkEncRes.headers["Set-Cookie"];
    log("log", "tkEncSetCookie: ", tkEncSetCookie);

    // 获取 _m_h5_tk_enc
    const tkEncMatch = tkEncSetCookie.match(/_m_h5_tk_enc=([^;]+)/);
    _m_h5_tk_enc = tkEncMatch ? tkEncMatch[1] : null;

    // 获取 _m_h5_tkh
    const tkH5Match = tkEncSetCookie.match(/_m_h5_tk=([^;]+)/);
    _m_h5_tk = tkH5Match ? tkH5Match[1] : null;

    log("log", "_m_h5_tk_enc:", _m_h5_tk_enc);
    log("log", "_m_h5_tk:", _m_h5_tk);
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
    log("log", "piece_url: ", url);

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
          if (danmu.propertis?.color) {
            content.color = JSON.parse(danmu.propertis).color;
          }
          if (danmu.propertis?.pos) {
            const pos = JSON.parse(danmu.propertis).pos;
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

    log("log", `danmu response from ${otherServer}: ↓↓↓`);
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

function formatComments(items) {
  const unique = {};
  for(const it of items){
    const text = String(it.d||"");
    const meta = parseRRSPPFields(it.p);
    if(!unique[meta.contentId]) unique[meta.contentId] = { content: text, ...meta };
  }

  const grouped = {};
  for(const c of Object.values(unique)){
    if(!grouped[c.content]) grouped[c.content] = [];
    grouped[c.content].push(c);
  }

  const processed = [];
  for(const [content, group] of Object.entries(grouped)){
    if(group.length===1) processed.push(group[0]);
    else{
      const first = group.reduce((a,b)=>a.timestamp<b.timestamp?a:b);
      processed.push({...first, content:`${first.content} X${group.length}`});
    }
  }

  return processed.map(c=>({
    cid: Number(c.contentId),
    p: `${c.timestamp.toFixed(2)},${c.mode},${c.color},[renren]`,
    m: c.content,
    t: c.timestamp
  }));
}

async function getRenRenComments(episodeId, progressCallback=null){
  if(progressCallback) await progressCallback(5,"开始获取弹幕人人弹幕");
  log("log", "开始获取弹幕人人弹幕");
  const raw = await fetchEpisodeDanmu(episodeId);
  if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
  log("log", `原始弹幕 ${raw.length} 条，正在规范化`);
  const formatted = formatComments(raw);
  if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
  log("log", `弹幕处理完成，共 ${formatted.length} 条`);
  // 输出前五条弹幕
  log("log", "Top 5 danmus:", JSON.stringify(formatted.slice(0, 5), null, 2));
  return formatted;
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
      log("log", "hanjutvSearchresp: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.seriesData || !resp.data.seriesData.seriesList) {
      log("log", "hanjutvSearchresp: seriesData 或 seriesList 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("log", `hanjutvSearchresp: ${JSON.stringify(resp.data.seriesData.seriesList)}`);

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
      log("log", "getHanjutvDetail: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.series) {
      log("log", "getHanjutvDetail: series 不存在");
      return [];
    }

    // 正常情况下输出 JSON 字符串
    log("log", `getHanjutvDetail: ${JSON.stringify(resp.data.series)}`);

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
      log("log", "getHanjutvEposides: 请求失败或无数据返回");
      return [];
    }

    // 判断 seriesData 是否存在
    if (!resp.data.episodes) {
      log("log", "getHanjutvEposides: episodes 不存在");
      return [];
    }

    const sortedEpisodes = resp.data.episodes.sort((a, b) => a.serialNo - b.serialNo);

    // 正常情况下输出 JSON 字符串
    log("log", `getHanjutvEposides: ${JSON.stringify(sortedEpisodes)}`);

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
  log("log", "开始获取弹幕韩剧TV弹幕");
  const raw = await fetchHanjutvEpisodeDanmu(pid);
  if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
  log("log", `原始弹幕 ${raw.length} 条，正在规范化`);
  const formatted = formatHanjutvComments(raw);
  if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
  log("log", `弹幕处理完成，共 ${formatted.length} 条`);
  // 输出前五条弹幕
  log("log", "Top 5 danmus:", JSON.stringify(formatted.slice(0, 5), null, 2));
  return formatted;
}

// =====================
// 路由请求相关
// =====================

function log(level, ...args) {
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");
  const timestamp = new Date().toISOString();
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

async function handleVodAnimes(animesVod, curAnimes) {
  const processVodAnimes = await Promise.all(animesVod.map(async (anime) => {
    let vodPlayFromList = anime.vod_play_from.split("$$$");
    vodPlayFromList = vodPlayFromList.map(item => {
      if (item === "mgtv") return "imgo";
      if (item === "bilibili") return "bilibili1";
      return item;
    });

    const vodPlayUrlList = anime.vod_play_url.split("$$$");
    const validIndices = vodPlayFromList
        .map((item, index) => allowedPlatforms.includes(item) ? index : -1)
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
          "title": `【${platform}】${anime.vod_name}(${anime.vod_year}) #${epInfo[0]}#`
        });
      }
    }

    if (links.length > 0) {
      let transformedAnime = {
        animeId: Number(anime.vod_id),
        bangumiId: String(anime.vod_id),
        animeTitle: `${anime.vod_name}(${anime.vod_year})【${anime.type_name}】from vod`,
        type: anime.type_name,
        typeDescription: anime.type_name,
        imageUrl: anime.vod_pic,
        startDate: `${anime.vod_year}-01-01T00:00:00`,
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
      };

      curAnimes.push(transformedAnime);
      const exists = animes.some(existingAnime => existingAnime.animeId === transformedAnime.animeId);
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
        if (allowedPlatforms.includes(key)) {
          links.push({
            "name": key,
            "url": anime.playlinks[key],
            "title": `【${key}】${anime.titleTxt}(${anime.year})`
          });
        }
      }
    } else if (anime.cat_name === "电视剧" || anime.cat_name === "动漫") {
      if (allowedPlatforms.includes(anime.seriesSite)) {
        for (let i = 0; i < anime.seriesPlaylinks.length; i++) {
          const item = anime.seriesPlaylinks[i];
          links.push({
            "name": i + 1,
            "url": item.url,
            "title": `【${anime.seriesSite}】${anime.titleTxt}(${anime.year}) #${i + 1}#`
          });
        }
      }
    } else if (anime.cat_name === "综艺") {
      const zongyiLinks = await Promise.all(
          Object.keys(anime.playlinks_year).map(async (site) => {
            if (allowedPlatforms.includes(site)) {
              const yearLinks = await Promise.all(
                  anime.playlinks_year[site].map(async (year) => {
                    return await get360Zongyi(anime.id, site, year);
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
      const exists = animes.some(existingAnime => existingAnime.animeId === transformedAnime.animeId);
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
          "title": `【${ep.provider}】${anime.title}(${anime.year}) #${ep.title}#`
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

        const exists = animes.some(existingAnime => existingAnime.animeId === transformedAnime.animeId);
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
  const cateMap = {1: "韩剧", 2: "综艺", 3: "电影", 5: "美剧"}

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
          "title": `【hanjutv】${anime.name}(${new Date(anime.updateTime).getFullYear()}) #${epTitle}#`
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

        const exists = animes.some(existingAnime => existingAnime.animeId === transformedAnime.animeId);
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

// Extracted function for GET /api/v2/search/anime
async function searchAnime(url) {
  const queryTitle = url.searchParams.get("keyword");
  log("log", `Search anime with keyword: ${queryTitle}`);

  const curAnimes = [];

  try {
    // 根据 sourceOrderArr 动态构建请求数组
    log("log", `Search sourceOrderArr: ${sourceOrderArr}`);
    const requestPromises = sourceOrderArr.map(source => {
      if (source === "vod") return getVodAnimes(queryTitle);
      if (source === "360") return get360Animes(queryTitle);
      if (source === "renren") return renrenSearch(queryTitle);
      if (source === "hanjutv") return hanjutvSearch(queryTitle);
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
    const { vod: animesVod, 360: animes360, renren: animesRenren, hanjutv: animesHanjutv } = resultData;

    // 按顺序处理每个来源的结果
    for (const key of sourceOrderArr) {
      if (key === 'vod') {
        // 等待处理Vod来源
        await handleVodAnimes(animesVod, curAnimes);
      } else if (key === '360') {
        // 等待处理360来源
        await handle360Animes(animes360, curAnimes);
      } else if (key === 'renren') {
        // 等待处理Renren来源
        await handleRenrenAnimes(animesRenren, queryTitle, curAnimes);
      } else if (key === 'hanjutv') {
        // 等待处理Hanjutv来源
        await handleHanjutvAnimes(animesHanjutv, queryTitle, curAnimes);
      }
    }
  } catch (error) {
    log("error", "发生错误:", error);
  }

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: curAnimes,
  });
}

async function matchAniAndEp(season, episode, searchData, title, req, platform) {
  let resAnime;
  let resEpisode;
  if (season && episode) {
    // 判断剧集
    for (const anime of searchData.animes) {
      if (anime.animeTitle.includes(title)) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", "判断剧集", bangumiData);

        // 过滤符合条件的 episodes
        const filteredEpisodes = bangumiData.bangumi.episodes.filter(episode => {
          const filterEp = extractEpTitle(episode.episodeTitle);
          return filterEp && !episodeTitleFilter.test(filterEp);  // 如果##中的内容匹配正则表达式
        });

        log("info", "filteredEpisodes", filteredEpisodes);

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

    // 这里可以继续处理 query，比如调用其他服务或数据库查询
    log("info", `Processing anime match for query: ${fileName}`);

    const regex = /^(.+?)\s+S(\d+)E(\d+)$/;
    const match = fileName.match(regex);

    let title = match ? match[1] : fileName;
    let season = match ? parseInt(match[2]) : null;
    let episode = match ? parseInt(match[3]) : null;

    log("info", "Parsed title, season, episode", { title, season, episode });

    let originSearchUrl = new URL(req.url.replace("/match", `/search/anime?keyword=${title}`));
    const searchRes = await searchAnime(originSearchUrl);
    const searchData = await searchRes.json();
    log("info", `searchData: ${searchData.animes}`);

    let resAnime;
    let resEpisode;

    log("info", `platformOrderArr: ${platformOrderArr}`);
    for (const platform of platformOrderArr) {
      const __ret = await matchAniAndEp(season, episode, searchData, title, req, platform);
      resEpisode = __ret.resEpisode;
      resAnime = __ret.resAnime;

      if (resAnime) {
        break;
      }
    }

    // 如果都没有找到则返回第一个满足剧集数的剧集
    if (!resAnime) {
      for (const anime of searchData.animes) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", bangumiData);
        if (season && episode) {
          // 过滤符合条件的 episodes
          const filteredEpisodes = bangumiData.bangumi.episodes.filter(episode => {
            const filterEp = extractEpTitle(episode.episodeTitle);
            return filterEp && !episodeTitleFilter.test(filterEp);  // 如果##中的内容匹配正则表达式
          });

          if (filteredEpisodes.length >= episode) {
            resEpisode = filteredEpisodes[episode-1];
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
  
  log("log", `Search episodes with anime: ${anime}, episode: ${episode}`);

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
    log("log", "No anime found for the given title");
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

  log("log", `Found ${resultAnimes.length} animes with filtered episodes`);

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: resultAnimes
  });
}

// Extracted function for GET /api/v2/bangumi/:animeId
async function getBangumi(path) {
  const animeId = parseInt(path.split("/").pop());
  const anime = animes.find((a) => a.animeId.toString() === animeId.toString());
  if (!anime) {
    log("error", `Anime with ID ${animeId} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  log("log", `Fetched details for anime ID: ${animeId}`);

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
  if (!url) {
    log("error", `Comment with ID ${commentId} not found`);
    return jsonResponse({ count: 0, comments: [] }, 404);
  }
  log("log", `Fetched comment ID: ${commentId}`);

  // 处理302场景
  // https://v.youku.com/video?vid=XNjQ4MTIwOTE2NA==&tpa=dW5pb25faWQ9MTAyMjEzXzEwMDAwNl8wMV8wMQ需要转成https://v.youku.com/v_show/id_XNjQ4MTIwOTE2NA==.html
  if (url.includes("youku.com/video?vid")) {
      url = convertYoukuUrl(url);
  }

  log("log", "开始从本地请求弹幕...", url);
  let danmus = [];
  if (url.includes('.qq.com')) {
    danmus = await fetchTencentVideo(url);
  }
  if (url.includes('.iqiyi.com')) {
    danmus = await fetchIqiyi(url);
  }
  if (url.includes('.mgtv.com')) {
    danmus = await fetchMangoTV(url);
  }
  if (url.includes('.bilibili.com')) {
    danmus = await fetchBilibili(url);
  }
  if (url.includes('.youku.com')) {
    danmus = await fetchYouku(url);
  }

  // 请求人人弹幕
  const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
  if (!urlPattern.test(url)) {
    if (canConvertToNumber(url)) {
      danmus = await getRenRenComments(url);
    } else {
      danmus = await getHanjutvComments(url);
    }
  }

  // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
  if (danmus.length === 0) {
    danmus = await fetchOtherServer(url);
  }

  return jsonResponse({ count: danmus.length, comments: danmus });
}

async function handleRequest(req, env) {
  token = resolveToken(env);  // 每次请求动态获取，确保热更新环境变量后也能生效
  otherServer = resolveOtherServer(env);
  vodServer = resolveVodServer(env);
  bilibliCookie = resolveBilibiliCookie(env);
  youkuConcurrency = resolveYoukuConcurrency(env);
  sourceOrderArr = resolveSourceOrder(env);
  platformOrderArr = resolvePlatformOrder(env);
  episodeTitleFilter = resolveEpisodeTitleFilter(env);
  blockedWords = resolveBlockedWords(env);

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

  log("info", `request url: ${JSON.stringify(url)}`);

  function handleHomepage() {
    log("log", "Accessed homepage with repository information");
    return jsonResponse({
      message: "Welcome to the LogVar Danmu API server",
      version: VERSION,
      repository: "https://github.com/huangxd-/danmu_api.git",
      description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口，并提供日志记录，支持vercel/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
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

  log("log", path);

  // 智能处理API路径前缀，确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/api/logs") {
      log('log', `[Path Check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改
      
      // 1. 清理：应对“用户填写/api/v2”+“客户端添加/api/v2”导致的重复前缀
      while (path.startsWith('/api/v2/api/v2/')) {
          log('log', `[Path Check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取，相当于移除第一个
          path = path.substring('/api/v2'.length);
      }
      
      // 打印日志：只有在发生清理时才显示清理后的路径，否则显示“无需清理”
      if (path !== pathBeforeCleanup) {
          log('log', `[Path Check] Path after cleanup: "${path}"`);
      } else {
          log('log', `[Path Check] Path after cleanup: No cleanup needed.`);
      }
      
      // 2. 补全：如果路径缺少前缀（例如请求原始路径为 /search/anime），则补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs')) {
          log('log', `[Path Check] Path is missing /api/v2 prefix. Adding...`);
          path = '/api/v2' + path;
      }
        
      // 打印日志：只有在发生添加前缀时才显示添加后的路径，否则显示“无需补全”
      if (path === pathBeforePrefixCheck) {
          log('log', `[Path Check] Prefix Check: No prefix addition needed.`);
      }
      
      log('log', `[Path Check] Final normalized path: "${path}"`);
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

  // GET /api/v2/comment/:commentId
  if (path.startsWith("/api/v2/comment/") && method === "GET") {
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
    return handleRequest(request, env);
  },
};

// --- Vercel 入口 ---
export async function vercelHandler(req, res) {
  const cfReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body:
      req.method === "POST" || req.method === "PUT"
        ? JSON.stringify(req.body)
        : undefined,
  });

  const response = await handleRequest(cfReq, process.env);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await response.text();
  res.send(text);
}

// 为了测试导出 handleRequest
export { handleRequest, searchAnime, searchEpisodes, matchAnime, getBangumi, getComment, fetchTencentVideo, fetchIqiyi,
  fetchMangoTV, fetchBilibili, fetchYouku, fetchOtherServer, httpGet, httpPost, hanjutvSearch, getHanjutvEpisodes,
  getHanjutvComments, getHanjutvDetail};
