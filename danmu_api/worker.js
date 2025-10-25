import { Globals } from './configs/globals.js';
import {
    httpGet, httpPost, getPageTitle, jsonResponse, buildQueryString, sortedQueryString, getPathname, updateQueryString
} from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import {
    pingRedis, getRedisKey, setRedisKey, setRedisKeyWithExpiry, getRedisCaches, updateRedisCaches,
    judgeRedisValid
} from "./utils/redis-util.js";
import {
    isSearchCacheValid, setCommentCache, addAnime, cleanupExpiredIPs, findAnimeIdByCommentId, findTitleById,
    findUrlById, getCommentCache, getPreferAnimeId, getSearchCache, isCommentCacheValid, removeEarliestAnime,
    setPreferByAnimeId, setSearchCache, storeAnimeIdsToMap
} from "./utils/cache-util.js";
import { traditionalized, simplized } from "./utils/zh-util.js";
import { convertToDanmakuJson, rgbToInt, formatDanmuResponse } from "./utils/danmu-util.js";
import { generateValidStartDate, time_to_second } from "./utils/time-util.js";
import { printFirst200Chars, extractTitle, extractYear, convertChineseNumber } from "./utils/common-util.js";
import { md5, parseDanmakuBase64, convertToAsciiSum, autoDecode, createHmacSha256 } from "./utils/codec-util.js";
import { getTmdbJaOriginalTitle } from "./utils/tmdb-util.js";

let globals;

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
    log("info", `360kan response: ${JSON.stringify(data)}`);

    let tmpAnimes = [];
    if ('rows' in data.data.longData) {
      tmpAnimes = data.data.longData.rows;
    }

    log("info", `360kan animes.length: ${tmpAnimes.length}`);

    return tmpAnimes;
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
      log("info", `360kan zongyi response: ${JSON.stringify(data)}`);

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
            "title": `【${site}】 ${episodeInfo.name} ${episodeInfo.period}`,
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

  // 根据 vodReturnMode 决定查询策略
  if (globals.vodReturnMode === "fastest") {
    return await getVodAnimesFromFastestServer(title, servers);
  } else {
    return await getVodAnimesFromAllServersImpl(title, servers);
  }
}

// 查询所有vod站点影片信息（返回所有结果）
async function getVodAnimesFromAllServersImpl(title, servers) {
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

// 查询vod站点影片信息（返回最快的结果）
async function getVodAnimesFromFastestServer(title, servers) {
  if (!servers || servers.length === 0) {
    return [];
  }

  // 使用 Promise.race 获取最快响应的服务器
  const promises = servers.map(server =>
    getVodAnimes(title, server.url, server.name)
  );

  try {
    // race 会返回第一个成功的结果
    const result = await Promise.race(promises);

    // 检查结果是否有效（有数据）
    if (result && result.list && result.list.length > 0) {
      log("info", `[VOD fastest mode] 使用最快的服务器: ${result.serverName}`);
      return [result];
    }

    // 如果最快的服务器没有数据，继续尝试其他服务器
    log("info", `[VOD fastest mode] 最快的服务器 ${result.serverName} 无数据，尝试其他服务器`);
    const allResults = await Promise.allSettled(promises);
    const validResults = allResults
      .filter(r => r.status === 'fulfilled' && r.value && r.value.list && r.value.list.length > 0)
      .map(r => r.value);

    return validResults.length > 0 ? [validResults[0]] : [];
  } catch (error) {
    log("error", `[VOD fastest mode] 所有服务器查询失败:`, error.message);
    return [];
  }
}

// =====================
// 工具方法
// =====================

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
  if (globals.allowedPlatforms.includes(input)) {
    return input;
  }

  // 如果输入的平台名称无效，返回空字符串
  return '';
}

// 根据指定平台创建动态平台顺序
function createDynamicPlatformOrder(preferredPlatform) {
  if (!preferredPlatform) {
    return [...globals.platformOrderArr]; // 返回默认顺序的副本
  }

  // 验证平台是否有效
  if (!globals.allowedPlatforms.includes(preferredPlatform)) {
    log("warn", `Invalid platform: ${preferredPlatform}, using default order`);
    return [...globals.platformOrderArr];
  }

  // 创建新的平台顺序，将指定平台放在最前面
  const dynamicOrder = [preferredPlatform];

  // 添加其他平台（排除已指定的平台）
  for (const platform of globals.platformOrderArr) {
    if (platform !== preferredPlatform && platform !== null) {
      dynamicOrder.push(platform);
    }
  }

  // 最后添加 null（用于回退逻辑）
  dynamicOrder.push(null);

  return dynamicOrder;
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

    // 获取所有分页的分集
    const allEpisodes = [];

    if (tabs.length === 0) {
      log("info", "[Tencent] 未找到分页信息,尝试从初始响应中提取分集");

      // 尝试直接从第一次响应中提取分集(单页情况)
      if (data.data && data.data.module_list_datas) {
        for (const moduleListData of data.data.module_list_datas) {
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

      if (allEpisodes.length === 0) {
        log("info", "[Tencent] 初始响应中也未找到分集信息");
        return [];
      }

      log("info", `[Tencent] 从初始响应中提取到 ${allEpisodes.length} 集`);
    } else {
      log("info", `[Tencent] 找到 ${tabs.length} 个分页`);

      // 获取所有分页的分集
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

  log("info", `vid: ${vid}`);

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
  log("info", `标题: ${title}`);

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

  log("info", `弹幕分段数量: ${promises.length}`);

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
    log("info", `tvid: ${tvid}`);

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
    log("info", `解码后 tvid: ${tvid}`);
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
    log("info", `标题: ${title}, 时长: ${duration}`);
  } catch (error) {
    log("error", "请求视频基础信息失败:", error);
    return [];
  }

  // 计算弹幕分段数量（每5分钟一个分段）
  const page = Math.ceil(duration / (60 * 5));
  log("info", `弹幕分段数量: ${page}`);

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
  const api_ctl_barrage = "https://galaxy.bz.mgtv.com/getctlbarrage";

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

  log("info", `cid: ${cid}, vid: ${vid}`);

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
    log("error", "请求视频信息失败:", error);
    return [];
  }

  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const title = data.data.info.videoName;
  const time = data.data.info.time;
  log("info", `标题: ${title}`);

  // 计算弹幕分段请求
  const promises = [];
  try {
    const ctlBarrageUrl = `${api_ctl_barrage}?version=8.1.39&abroad=0&uuid=&os=10.15.7&platform=0&mac=&vid=${vid}&pid=&cid=${cid}&ticket=`;
    const res = await httpGet(ctlBarrageUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    const ctlBarrage = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

    // 每1分钟一个分段
    for (let i = 0; i < Math.ceil(time_to_second(time) / 60); i += 1) {
      const danmakuUrl = `https://${ctlBarrage.data?.cdn_list.split(',')[0]}/${ctlBarrage.data?.cdn_version}/${i}.json`;
      promises.push(
        httpGet(danmakuUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        })
      );
    }
  } catch (error) {
    log("error", "请求弹幕分片失败:", error);
    return [];
  }

  log("info", `弹幕分段数量: ${promises.length}`);

  // 默认颜色值
  const DEFAULT_COLOR_INT = -1;

  // 处理 v2_color 对象的转换逻辑
  function transformV2Color(v2_color) {
    // 如果 v2_color 不存在，返回默认值
    if (!v2_color) {
      return DEFAULT_COLOR_INT;
    }
    // 计算左右颜色的整数值
    const leftColor = rgbToInt(v2_color.color_left);
    const rightColor = rgbToInt(v2_color.color_right);
    // 如果左右颜色均为 -1，返回默认值
    if (leftColor === -1 && rightColor === -1) {
      return DEFAULT_COLOR_INT;
    }
    // 如果左颜色无效，返回右颜色
    if (leftColor === -1) {
      return rightColor;
    }
    // 如果右颜色无效，返回左颜色
    if (rightColor === -1) {
      return leftColor;
    }
    // 返回左右颜色的平均值
    return Math.floor((leftColor + rightColor) / 2);
  }

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
        if (item?.v2_color) {
          content.color = transformV2Color(item?.v2_color);
        }
        if (item?.v2_position) {
          if (item?.v2_position === 1) {
            content.ct = 5;
          } else if (item?.v2_position === 2) {
            content.ct = 4;
          }
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
// 解析 b23.tv 短链接
// =====================

async function resolveB23Link(shortUrl) {
  try {
    log("info", `正在解析 b23.tv 短链接: ${shortUrl}`);

    // 设置超时时间（默认5秒）
    const timeout = parseInt(globals.vodRequestTimeout);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 使用原生 fetch 获取重定向后的 URL
    // fetch 默认会自动跟踪重定向，response.url 会是最终的 URL
    const response = await fetch(shortUrl, {
      method: 'GET',
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeoutId);

    // 获取最终的 URL（重定向后的 URL）
    const finalUrl = response.url;
    if (finalUrl && finalUrl !== shortUrl) {
      log("info", `b23.tv 短链接已解析为: ${finalUrl}`);
      return finalUrl;
    }

    log("error", "无法解析 b23.tv 短链接");
    return shortUrl; // 如果解析失败，返回原 URL
  } catch (error) {
    log("error", "解析 b23.tv 短链接失败:", error);
    return shortUrl; // 如果出错，返回原 URL
  }
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
      log("info", `p: ${p}`);

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

  // 番剧 - ep格式
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

  // 番剧 - ss格式
  } else if (inputUrl.includes("bangumi/") && inputUrl.includes("ss")) {
    try {
      const ssid = path.slice(-1)[0].slice(2).split('?')[0]; // 移除可能的查询参数
      const ssInfoUrl = `${api_epid_cid}?season_id=${ssid}`;

      log("info", `获取番剧信息: season_id=${ssid}`);

      const res = await httpGet(ssInfoUrl, {
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

      // 检查是否有episodes数据
      if (!data.result.episodes || data.result.episodes.length === 0) {
        log("error", "番剧没有可用的集数");
        return [];
      }

      // 默认获取第一集的弹幕
      const firstEpisode = data.result.episodes[0];
      title = firstEpisode.share_copy;
      cid = firstEpisode.cid;
      duration = firstEpisode.duration / 1000;
      danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;

      log("info", `使用第一集: ${title}, cid=${cid}`);

    } catch (error) {
      log("error", "请求番剧视频信息失败:", error);
      return [];
    }

  } else {
    log("error", "不支持的B站视频网址，仅支持普通视频(av,bv)、剧集视频(ep,ss)");
    return [];
  }
  log("info", danmakuUrl, cid, aid, duration);

  // 计算视频的分片数量
  const maxLen = Math.floor(duration / 360) + 1;
  log("info", `maxLen: ${maxLen}`);

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
              "Cookie": globals.bilibliCookie
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

  log("info", `video_id: ${video_id}`);

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
  log("info", `标题: ${title}, 时长: ${duration}`);

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
    log("info", `cnaRes: ${JSON.stringify(cnaRes)}`);
    log("info", `cnaRes.headers: ${JSON.stringify(cnaRes.headers)}`);
    const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
    log("info", `etag: ${etag}`);
    // const match = cnaRes.headers["set-cookie"].match(/cna=([^;]+)/);
    // cna = match ? match[1] : null;
    cna = etag.replace(/^"|"$/g, '');
    log("info", `cna: ${cna}`);

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
    log("info", `tkEncRes: ${JSON.stringify(tkEncRes)}`);
    log("info", `tkEncRes.headers: ${JSON.stringify(tkEncRes.headers)}`);
    const tkEncSetCookie = tkEncRes.headers["set-cookie"] || tkEncRes.headers["Set-Cookie"];
    log("info", `tkEncSetCookie: ${tkEncSetCookie}`);

    // 获取 _m_h5_tk_enc
    const tkEncMatch = tkEncSetCookie.match(/_m_h5_tk_enc=([^;]+)/);
    _m_h5_tk_enc = tkEncMatch ? tkEncMatch[1] : null;

    // 获取 _m_h5_tkh
    const tkH5Match = tkEncSetCookie.match(/_m_h5_tk=([^;]+)/);
    _m_h5_tk = tkH5Match ? tkH5Match[1] : null;

    log("info", `_m_h5_tk_enc: ${_m_h5_tk_enc}`);
    log("info", `_m_h5_tk: ${_m_h5_tk}`);
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
    log("info", `piece_url: ${url}`);

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
  const concurrency = globals.youkuConcurrency;
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
      `${globals.otherServer}/?url=${inputUrl}&ac=dm`,
      {
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      }
    );

    log("info", `danmu response from ${globals.otherServer}: ↓↓↓`);
    printFirst200Chars(response.data);

    return convertToDanmakuJson(response.data, "other_server");
  } catch (error) {
    log("error", `请求 ${globals.otherServer} 失败:`, error);
    return [];
  }
}

// =====================
// 人人视频 配置 & 工具
// =====================
// ---------------------
// 通用工具
// ---------------------


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
    // 在函数内部进行简转繁
    const traditionalizedKeyword = traditionalized(keyword);

    // TMDB 搜索直接使用传入的原始 keyword
    const tmdbSearchKeyword = keyword;

    // 使用 traditionalizedKeyword 进行巴哈姆特搜索
	const encodedKeyword = encodeURIComponent(traditionalizedKeyword);
    const url = globals.proxyUrl
      ? `http://127.0.0.1:5321/proxy?url=https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedKeyword}`
      : `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedKeyword}`;
    
    log("info", `[Bahamut] 传入原始搜索词: ${keyword}`);
    log("info", `[Bahamut] 使用巴哈搜索词: ${traditionalizedKeyword}`);

    const originalResp = await httpGet(url, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
      },
    });

    // 如果原始搜索有结果，直接返回（并在结果上标注实际用于搜索的字符串）
    if (
      originalResp &&
      originalResp.data &&
      originalResp.data.anime &&
      originalResp.data.anime.length > 0
    ) {
      const anime = originalResp.data.anime;
      // 实际用于 bahamut 搜索的关键字（用于后续匹配参考）
      for (const a of anime) {
        try {
          a._originalQuery = keyword;
          a._searchUsedTitle = traditionalizedKeyword;
        } catch (e) {}
      }
      log("info", `bahamutSearchresp (original): ${JSON.stringify(anime)}`);
      log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: original)`);
      return anime;
    }

    // 原始搜索没有结果时，才调用 TMDB 转换（顺序执行）
    log("info", "[Bahamut] 原始搜索未返回结果，尝试转换TMDB标题...");
    const tmdbTitle = await getTmdbJaOriginalTitle(tmdbSearchKeyword);  // 使用原始 keyword (tmdbSearchKeyword)

    if (!tmdbTitle) {
      log("info", "[Bahamut] TMDB转换未返回标题，中止搜索并转入备用方案.");
      return [];
    }

    log("info", `[Bahamut] 使用TMDB标题进行搜索: ${tmdbTitle}`);
    // 确保 TMDB 标题也被编码
    const encodedTmdbTitle = encodeURIComponent(tmdbTitle); 
    const tmdbSearchUrl = globals.proxyUrl
      ? `http://127.0.0.1:5321/proxy?url=https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedTmdbTitle}`
      : `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedTmdbTitle}`;
    const tmdbResp = await httpGet(tmdbSearchUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
      },
    });

    if (tmdbResp && tmdbResp.data && tmdbResp.data.anime && tmdbResp.data.anime.length > 0) {
      const anime = tmdbResp.data.anime;
      // 保留 original query 与 实际用于 bahamut 搜索的标题（TMDB 的标题）
      for (const a of anime) {
        try {
          a._originalQuery = keyword;
          a._searchUsedTitle = tmdbTitle;
        } catch (e) {}
      }
      log("info", `bahamutSearchresp (TMDB): ${JSON.stringify(anime)}`);
      log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: tmdb)`);
      return anime;
    }

    log("info", "[Bahamut] 原始搜索和基于TMDB的搜索均未返回任何结果");
    return [];
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
    const targetUrl = `https://api.gamer.com.tw/anime/v1/video.php?videoSn=${videoSn}`;
    const url = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
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
    const targetUrl = `https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn=${videoSn}`;
    const url = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
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
    p: `${Math.round(c.time / 10).toFixed(2)},${positionToMode[c.position] || c.tp},${parseInt(c.color.slice(1), 16)},[bahamut]`,
    m: simplized(c.text),
    t: Math.round(c.time / 10)
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
  return convertToDanmakuJson(formatted, "bahamut");
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

// 按年份降序排序并添加到curAnimes
function sortAndPushAnimesByYear(processedAnimes, curAnimes) {
  processedAnimes
    .filter(anime => anime !== null)
    .sort((a, b) => {
      const yearA = extractYear(a.animeTitle);
      const yearB = extractYear(b.animeTitle);

      // 如果都有年份，按年份降序排列
      if (yearA !== null && yearA !== undefined && yearB !== null && yearB !== undefined) {
        return yearB - yearA;
      }
      // 如果只有a有年份，a排在前面
      if ((yearA !== null && yearA !== undefined) && (yearB === null || yearB === undefined)) {
        return -1;
      }
      // 如果只有b有年份，b排在前面
      if ((yearA === null || yearA === undefined) && (yearB !== null && yearB !== undefined)) {
        return 1;
      }
      // 如果都没有年份，保持原顺序
      return 0;
    })
    .forEach(anime => {
      curAnimes.push(anime);
    });
}

async function handleVodAnimes(animesVod, curAnimes, key) {
  const tmpAnimes = [];

  const processVodAnimes = await Promise.all(animesVod.map(async (anime) => {
    let vodPlayFromList = anime.vod_play_from.split("$$$");
    vodPlayFromList = vodPlayFromList.map(item => {
      if (item === "mgtv") return "imgo";
      if (item === "bilibili") return "bilibili1";
      return item;
    });

    const vodPlayUrlList = anime.vod_play_url.split("$$$");
    const validIndices = vodPlayFromList
        .map((item, index) => globals.vodAllowedPlatforms.includes(item) ? index : -1)
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
          "title": `【${platform}】 ${epInfo[0]}`
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
        startDate: generateValidStartDate(anime.vod_year),
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
      };

      tmpAnimes.push(transformedAnime);
      addAnime({...transformedAnime, links: links});
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }
  }));

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return processVodAnimes;
}

async function handle360Animes(animes360, curAnimes) {
  const tmpAnimes = [];

  const process360Animes = await Promise.all(animes360.map(async (anime) => {
    let links = [];
    if (anime.cat_name === "电影") {
      for (const key of Object.keys(anime.playlinks)) {
        if (globals.vodAllowedPlatforms.includes(key)) {
          links.push({
            "name": key,
            "url": anime.playlinks[key],
            "title": `【${key}】 ${anime.titleTxt}(${anime.year})`
          });
        }
      }
    } else if (anime.cat_name === "电视剧" || anime.cat_name === "动漫") {
      if (globals.vodAllowedPlatforms.includes(anime.seriesSite)) {
        for (let i = 0; i < anime.seriesPlaylinks.length; i++) {
          const item = anime.seriesPlaylinks[i];
          links.push({
            "name": i + 1,
            "url": item.url,
            "title": `【${anime.seriesSite}】 第${i + 1}集`
          });
        }
      }
    } else if (anime.cat_name === "综艺") {
      const zongyiLinks = await Promise.all(
          Object.keys(anime.playlinks_year).map(async (site) => {
            if (globals.vodAllowedPlatforms.includes(site)) {
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
        startDate: generateValidStartDate(anime.year),
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
      };

      tmpAnimes.push(transformedAnime);
      addAnime({...transformedAnime, links: links});
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }
  }));

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return process360Animes;
}

async function handleRenrenAnimes(animesRenren, queryTitle, curAnimes) {
  const tmpAnimes = [];

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
          "title": `【${ep.provider}】 ${ep.title}`
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
          startDate: generateValidStartDate(anime.year),
          episodeCount: links.length,
          rating: 0,
          isFavorited: true,
        };

        tmpAnimes.push(transformedAnime);

        addAnime({...transformedAnime, links: links});

        if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return processRenrenAnimes;
}

async function handleHanjutvAnimes(animesHanjutv, queryTitle, curAnimes) {
  const cateMap = {1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧"}

  function getCategory(key) {
    return cateMap[key] || "其他";
  }

  const tmpAnimes = [];

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
          "title": `【hanjutv】 ${epTitle}`
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
          startDate: generateValidStartDate(new Date(anime.updateTime).getFullYear()),
          episodeCount: links.length,
          rating: detail.rank,
          isFavorited: true,
        };

        tmpAnimes.push(transformedAnime);

        addAnime({...transformedAnime, links: links});

        if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return processHanjutvAnimes;
}

async function handleBahamutAnimes(animesBahamut, queryTitle, curAnimes) {
  const tmpAnimes = [];

  // 巴哈姆特搜索辅助函数
  function bahamutTitleMatches(itemTitle, queryTitle, searchUsedTitle) {
    if (!itemTitle) return false;

    // 统一输入格式
    const tItem = String(itemTitle);
    const q = String(queryTitle || "");
    const used = String(searchUsedTitle || "");

    // 直接包含检查
    if (tItem.includes(q)) return true;
    if (used && tItem.includes(used)) return true;

    // 尝试繁体/简体互转（双向匹配）
    try {
      if (tItem.includes(traditionalized(q))) return true;
      if (tItem.includes(simplized(q))) return true;
      if (used) {
        if (tItem.includes(traditionalized(used))) return true;
        if (tItem.includes(simplized(used))) return true;
      }
    } catch (e) {
      // 转换过程中可能会因为异常输入而抛错；忽略继续
    }

    // 尝试不区分大小写的拉丁字母匹配
    try {
      if (tItem.toLowerCase().includes(q.toLowerCase())) return true;
      if (used && tItem.toLowerCase().includes(used.toLowerCase())) return true;
    } catch (e) { }

    return false;
  }

  // 安全措施:确保一定是数组类型
  const arr = Array.isArray(animesBahamut) ? animesBahamut : [];

  // 使用稳健匹配器过滤项目,同时利用之前注入的 _searchUsedTitle 字段
  const filtered = arr.filter(item => {
    const itemTitle = item.title || "";
    const usedSearchTitle = item._searchUsedTitle || item._originalQuery || "";
    
    // 如果有 _searchUsedTitle 字段(表示是TMDB搜索结果),则跳过标题匹配,直接保留
    if (item._searchUsedTitle && item._searchUsedTitle !== queryTitle) {
      log("info", `[Bahamut] TMDB结果直接保留: ${itemTitle}`);
      return true;
    }
    
    return bahamutTitleMatches(itemTitle, queryTitle, usedSearchTitle);
  });

  // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
  const processBahamutAnimes = await Promise.all(filtered.map(async (anime) => {
    const epData = await getBahamutEpisodes(anime.video_sn);
    const detail = epData.video;

    // 处理 episodes 对象中的多个键（"0", "1", "2" 等）
    // 某些内容（如电影）可能在不同的键中
    let eps = null;
    if (epData.anime.episodes) {
      // 优先使用 "0" 键，如果不存在则使用第一个可用的键
      eps = epData.anime.episodes["0"] || Object.values(epData.anime.episodes)[0];
    }

    let links = [];
    if (eps && Array.isArray(eps)) {
      for (const ep of eps) {
        const epTitle = `第${ep.episode}集`;
        links.push({
          "name": ep.episode,
          "url": ep.videoSn.toString(),
          "title": `【bahamut】 ${epTitle}`
        });
      }
    }

    if (links.length > 0) {
      let yearMatch = (anime.info || "").match(/(\d{4})/);
      let yearStr = yearMatch ? yearMatch[1] : (epData.anime.seasonStart ? new Date(epData.anime.seasonStart).getFullYear() : (new Date().getFullYear()));
      let transformedAnime = {
        animeId: anime.video_sn,
        bangumiId: String(anime.video_sn),
        animeTitle: `${simplized(anime.title)}(${(anime.info.match(/(\d{4})/) || [null])[0]})【动漫】from bahamut`,
        type: "动漫",
        typeDescription: "动漫",
        imageUrl: anime.cover,
        startDate: generateValidStartDate(new Date(epData.anime.seasonStart).getFullYear()),
        episodeCount: links.length,
        rating: detail.rating,
        isFavorited: true,
      };

      tmpAnimes.push(transformedAnime);

      addAnime({...transformedAnime, links: links});

      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }
  }));

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return processBahamutAnimes;
}

async function handleTencentAnimes(animesTencent, queryTitle, curAnimes) {
  const tmpAnimes = [];

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
          "title": `【qq】 ${epTitle}`
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
          startDate: generateValidStartDate(anime.year),
          episodeCount: links.length,
          rating: 0,
          isFavorited: true,
        };

        tmpAnimes.push(transformedAnime);

        addAnime({...transformedAnime, links: links});

        if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
      }
    })
  );

  sortAndPushAnimesByYear(tmpAnimes, curAnimes);

  return processTencentAnimes;
}

// Extracted function for GET /api/v2/search/anime
async function searchAnime(url) {
  const queryTitle = url.searchParams.get("keyword");
  log("info", `Search anime with keyword: ${queryTitle}`);

  // 检查搜索缓存
  const cachedResults = getSearchCache(queryTitle);
  if (cachedResults !== null) {
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: cachedResults,
    });
  }

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

    let platform = "unknown";
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

    const pageTitle = await getPageTitle(queryTitle);

    const links = [{
      "name": "手动解析链接弹幕",
      "url": queryTitle,
      "title": `【${platform}】 ${pageTitle}`
    }];
    curAnimes.push(tmpAnime);
    addAnime({...tmpAnime, links: links});
    if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();

    // 如果有新的anime获取到，则更新redis
    if (globals.redisValid && curAnimes.length !== 0) {
      await updateRedisCaches();
    }

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: curAnimes,
    });
  }

  try {
    // 根据 sourceOrderArr 动态构建请求数组
    log("info", `Search sourceOrderArr: ${globals.sourceOrderArr}`);
    const requestPromises = globals.sourceOrderArr.map(source => {
      if (source === "360") return get360Animes(queryTitle);
      if (source === "vod") return getVodAnimesFromAllServers(queryTitle, globals.vodServers);
      if (source === "renren") return renrenSearch(queryTitle);
      if (source === "hanjutv") return hanjutvSearch(queryTitle);
      if (source === "bahamut") return bahamutSearch(queryTitle); 
      if (source === "tencent") return tencentSearch(queryTitle);
    });

    // 执行所有请求并等待结果
    const results = await Promise.all(requestPromises);

    // 创建一个对象来存储返回的结果
    const resultData = {};

    // 动态根据 sourceOrderArr 顺序将结果赋值给对应的来源
    globals.sourceOrderArr.forEach((source, index) => {
      resultData[source] = results[index];  // 根据顺序赋值
    });

    // 解构出返回的结果
    const { vod: animesVodResults, 360: animes360, renren: animesRenren, hanjutv: animesHanjutv, bahamut: animesBahamut, tencent: animesTencent } = resultData;

    // 按顺序处理每个来源的结果
    for (const key of globals.sourceOrderArr) {
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

  // 如果启用了集标题过滤，则为每个动漫添加过滤后的 episodes
  if (globals.enableEpisodeFilter) {
    const validAnimes = [];
    for (const anime of curAnimes) {
      // 首先检查动漫名称是否包含过滤关键词
      const animeTitle = anime.animeTitle || '';
      if (globals.episodeTitleFilter.test(animeTitle)) {
        log("info", `[searchAnime] Anime ${anime.animeId} filtered by name: ${animeTitle}`);
        continue; // 跳过该动漫
      }

      const animeData = globals.animes.find(a => a.animeId === anime.animeId);
      if (animeData && animeData.links) {
        let episodesList = animeData.links.map((link, index) => ({
          episodeId: link.id,
          episodeTitle: link.title,
          episodeNumber: index + 1
        }));

        // 应用过滤
        episodesList = episodesList.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });

        log("info", `[searchAnime] Anime ${anime.animeId} filtered episodes: ${episodesList.length}/${animeData.links.length}`);

        // 只有当过滤后还有有效剧集时才保留该动漫
        if (episodesList.length > 0) {
          validAnimes.push(anime);
        }
      }
    }
    // 用过滤后的动漫列表替换原列表
    curAnimes.length = 0;
    curAnimes.push(...validAnimes);
  }

  // 如果有新的anime获取到，则更新redis
  if (globals.redisValid && curAnimes.length !== 0) {
      await updateRedisCaches();
  }

  // 缓存搜索结果
  if (curAnimes.length > 0) {
    setSearchCache(queryTitle, curAnimes);
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
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            return prevEpisode.episodeTitle === episode.episodeTitle;
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
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
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
        return !globals.episodeTitleFilter.test(episode.episodeTitle);
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
    log("info", `Original platformOrderArr: ${globals.platformOrderArr}`);
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
    anime = globals.animes.find((a) => a.animeId.toString() === animeId.toString());
  }

  // 如果通过 animeId 未找到,尝试通过 bangumiId 查找
  if (!anime) {
    anime = globals.animes.find((a) => a.bangumiId === idParam);
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

  // 构建 episodes 列表
  let episodesList = [];
  for (let i = 0; i < anime.links.length; i++) {
    const link = anime.links[i];
    episodesList.push({
      seasonId: `season-${anime.animeId}`,
      episodeId: link.id,
      episodeTitle: `${link.title}`,
      episodeNumber: `${i+1}`,
      airDate: anime.startDate,
    });
  }

  // 如果启用了集标题过滤，则应用过滤
  if (globals.enableEpisodeFilter) {
    episodesList = episodesList.filter(episode => {
      return !globals.episodeTitleFilter.test(episode.episodeTitle);
    });
    log("info", `[getBangumi] Episode filter enabled. Filtered episodes: ${episodesList.length}/${anime.links.length}`);

    // 如果过滤后没有有效剧集，返回错误
    if (episodesList.length === 0) {
      log("warn", `[getBangumi] No valid episodes after filtering for anime ID ${idParam}`);
      return jsonResponse(
        { errorCode: 404, success: false, errorMessage: "No valid episodes after filtering", bangumi: null },
        404
      );
    }
  }

  resData["bangumi"]["episodes"] = episodesList;

  return jsonResponse(resData);
}

// Extracted function for GET /api/v2/comment/:commentId
async function getComment(path, queryFormat) {
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

  // 检查弹幕缓存
  const cachedComments = getCommentCache(url);
  if (cachedComments !== null) {
    const responseData = { count: cachedComments.length, comments: cachedComments };
    return formatDanmuResponse(responseData, queryFormat);
  }

  log("info", "开始从本地请求弹幕...", url);
  let danmus = [];
  if (url.includes('.qq.com')) {
    danmus = await fetchTencentVideo(url);
  } else if (url.includes('.iqiyi.com')) {
    danmus = await fetchIqiyi(url);
  } else if (url.includes('.mgtv.com')) {
    danmus = await fetchMangoTV(url);
  } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
    // 如果是 b23.tv 短链接，先解析为完整 URL
    if (url.includes('b23.tv')) {
      url = await resolveB23Link(url);
    }
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
  if (globals.redisValid && animeId) {
    await setRedisKey('lastSelectMap', globals.lastSelectMap);
  }

  // 缓存弹幕结果
  if (danmus.length > 0) {
    setCommentCache(url, danmus);
  }

  const responseData = { count: danmus.length, comments: danmus };
  return formatDanmuResponse(responseData, queryFormat);
}

// Extracted function for POST /api/v2/comment/by-url
async function getCommentByUrl(req, queryFormat) {
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

    // 检查弹幕缓存
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) {
      const responseData = {
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      };
      return formatDanmuResponse(responseData, queryFormat);
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
      // 如果是 b23.tv 短链接，先解析为完整 URL
      if (url.includes('b23.tv')) {
        url = await resolveB23Link(url);
      }
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

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(url, danmus);
    }

    const responseData = {
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    };
    return formatDanmuResponse(responseData, queryFormat);
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
  // 加载全局变量和环境变量配置
  globals = Globals.init(env, deployPlatform);

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

  await judgeRedisValid(path);

  log("info", `request url: ${JSON.stringify(url)}`);
  log("info", `request path: ${path}`);
  log("info", `client ip: ${clientIp}`);

  if (globals.redisValid && path !== "/favicon.ico" && path !== "/robots.txt") {
    await getRedisCaches();
  }

  function handleHomepage() {
    log("info", "Accessed homepage with repository information");
    return jsonResponse({
      message: "Welcome to the LogVar Danmu API server",
      version: globals.VERSION,
      envs: {
        ...globals.accessedEnvVars,
        redisValid: globals.redisValid
      },
      repository: "https://github.com/huangxd-/danmu_api.git",
      description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
      notice: "本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok，TG MSG ROBOT: [https://t.me/ddjdd_bot]; 推荐加互助群咨询，TG GROUP: [https://t.me/logvar_danmu_group]; 关注频道获取最新更新内容，TG CHANNEL: [https://t.me/logvar_danmu_channel]。"
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
  if (parts.length < 1 || parts[0] !== globals.token) {
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
    const queryFormat = url.searchParams.get('format');
    return getCommentByUrl(req, queryFormat);
  }

  // GET /api/v2/comment/:commentId
  if (path.startsWith("/api/v2/comment/") && method === "GET") {
    // ⚠️ 限流设计说明：
    // 1. 先检查缓存，缓存命中时直接返回，不计入限流次数
    // 2. 只有缓存未命中时才执行限流检查和网络请求
    // 这样可以避免频繁访问同一弹幕时被限流，提高用户体验
    const queryFormat = url.searchParams.get('format');
    const commentId = parseInt(path.split("/").pop());
    let urlForComment = findUrlById(commentId);

    if (urlForComment) {
      // 处理302场景
      if (urlForComment.includes("youku.com/video?vid")) {
        urlForComment = convertYoukuUrl(urlForComment);
      }

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
        // 更新请求历史（清理过期记录）
        if (recentRequests.length === 0) {
          globals.requestHistory.delete(clientIp);
        } else {
          globals.requestHistory.set(clientIp, recentRequests);
        }

        return jsonResponse({
          status: 429, // HTTP 429 Too Many Requests
          body: `1分钟内同一IP只能请求弹幕${globals.rateLimitMaxRequests}次，请稍后重试`,
        });
      }

      // 将当前请求的时间戳添加到该 IP 地址的请求历史队列中
      recentRequests.push(currentTime);

      // 更新该 IP 地址的请求历史
      if (recentRequests.length === 0) {
        // 如果没有最近的请求，删除该 IP 的记录以避免内存泄漏
        globals.requestHistory.delete(clientIp);
      } else {
        globals.requestHistory.set(clientIp, recentRequests);
      }
      log("info", `[Rate Limit] Request counted for IP: ${clientIp}, count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
    }

    return getComment(path, queryFormat);
  }

  // GET /api/logs
  if (path === "/api/logs" && method === "GET") {
    const logText = globals.logBuffer
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
export { handleRequest, searchAnime, searchEpisodes, matchAnime, getBangumi, getComment, getCommentByUrl, fetchTencentVideo, fetchIqiyi,
  fetchMangoTV, fetchBilibili, fetchYouku, fetchOtherServer, httpGet, httpPost, hanjutvSearch, getHanjutvEpisodes,
  getHanjutvComments, getHanjutvDetail, bahamutSearch, getBahamutEpisodes, getBahamutComments, tencentSearch, getTencentEpisodes,
  pingRedis, getRedisKey, setRedisKey, setRedisKeyWithExpiry, getSearchCache, setSearchCache, isSearchCacheValid,
  getCommentCache, setCommentCache, isCommentCacheValid, resolveB23Link};
