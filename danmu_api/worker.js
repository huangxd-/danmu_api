import { Globals } from './configs/globals.js';
import { httpGet, httpPost, getPageTitle, jsonResponse } from './utils/http-util.js';
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
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { extractTitle, convertChineseNumber, parseFileName, createDynamicPlatformOrder } from "./utils/common-util.js";
import Kan360Source from "./sources/kan360.js";
import VodSource from "./sources/vod.js";
import RenrenSource from "./sources/renren.js";
import HanjutvSource from "./sources/hanjutv.js";
import BahamutSource from "./sources/bahamut.js";
import TencentSource from "./sources/tencent.js";
import IqiyiSource from "./sources/iqiyi.js";
import MangoSource from "./sources/mango.js";
import BilibiliSource from "./sources/bilibili.js";
import YoukuSource from "./sources/youku.js";
import OtherSource from "./sources/other.js";

let globals;

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

// Extracted function for GET /api/v2/search/anime
async function searchAnime(url) {
  const kan360Source = new Kan360Source();
  const vodSource = new VodSource();
  const renrenSource = new RenrenSource();
  const hanjutvSource = new HanjutvSource();
  const bahamutSource = new BahamutSource();
  const tencentSource = new TencentSource();

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
      if (source === "360") return kan360Source.search(queryTitle);
      if (source === "vod") return vodSource.search(queryTitle);
      if (source === "renren") return renrenSource.search(queryTitle);
      if (source === "hanjutv") return hanjutvSource.search(queryTitle);
      if (source === "bahamut") return bahamutSource.search(queryTitle);
      if (source === "tencent") return tencentSource.search(queryTitle);
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
        await kan360Source.handleAnimes(animes360, queryTitle, curAnimes);
      } else if (key === 'vod') {
        // 等待处理Vod来源（遍历所有VOD服务器的结果）
        if (animesVodResults && Array.isArray(animesVodResults)) {
          for (const vodResult of animesVodResults) {
            if (vodResult && vodResult.list && vodResult.list.length > 0) {
              await vodSource.handleAnimes(vodResult.list, queryTitle, curAnimes, vodResult.serverName);
            }
          }
        }
      } else if (key === 'renren') {
        // 等待处理Renren来源
        await renrenSource.handleAnimes(animesRenren, queryTitle, curAnimes);
      } else if (key === 'hanjutv') {
        // 等待处理Hanjutv来源
        await hanjutvSource.handleAnimes(animesHanjutv, queryTitle, curAnimes);
      } else if (key === 'bahamut') {
        // 等待处理Bahamut来源
        await bahamutSource.handleAnimes(animesBahamut, queryTitle, curAnimes);
      } else if (key === 'tencent') {
        // 等待处理Tencent来源
        await tencentSource.handleAnimes(animesTencent, queryTitle, curAnimes);
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
  const renrenSource = new RenrenSource();
  const hanjutvSource = new HanjutvSource();
  const bahamutSource = new BahamutSource();
  const tencentSource = new TencentSource();
  const iqiyiSource = new IqiyiSource();
  const mangoSource = new MangoSource();
  const bilibiliSource = new BilibiliSource();
  const youkuSource = new YoukuSource();
  const otherSource = new OtherSource();

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

  // 检查弹幕缓存
  const cachedComments = getCommentCache(url);
  if (cachedComments !== null) {
    const responseData = { count: cachedComments.length, comments: cachedComments };
    return formatDanmuResponse(responseData, queryFormat);
  }

  log("info", "开始从本地请求弹幕...", url);
  let danmus = [];
  if (url.includes('.qq.com')) {
    danmus = await tencentSource.getComments(url, plat);
  } else if (url.includes('.iqiyi.com')) {
    danmus = await iqiyiSource.getComments(url, plat);
  } else if (url.includes('.mgtv.com')) {
    danmus = await mangoSource.getComments(url, plat);
  } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
    // 如果是 b23.tv 短链接，先解析为完整 URL
    if (url.includes('b23.tv')) {
      url = await bilibiliSource.resolveB23Link(url);
    }
    danmus = await bilibiliSource.getComments(url, plat);
  } else if (url.includes('.youku.com')) {
    danmus = await youkuSource.getComments(url, plat);
  }

  // 请求其他平台弹幕
  const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
  if (!urlPattern.test(url)) {
    if (plat === "renren") {
      danmus = await renrenSource.getComments(url, plat);
    } else if (plat === "hanjutv") {
      danmus = await hanjutvSource.getComments(url, plat);
    } else if (plat === "bahamut") {
      danmus = await bahamutSource.getComments(url, plat);
    }
  }

  // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
  if (danmus.length === 0 && urlPattern.test(url)) {
    danmus = await otherSource.getComments(url, "other_server");
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
  const tencentSource = new TencentSource();
  const iqiyiSource = new IqiyiSource();
  const mangoSource = new MangoSource();
  const bilibiliSource = new BilibiliSource();
  const youkuSource = new YoukuSource();
  const otherSource = new OtherSource();

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

    let url = videoUrl;
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
      danmus = await tencentSource.getComments(url, "qq");
    } else if (url.includes('.iqiyi.com')) {
      danmus = await iqiyiSource.getComments(url, "qiyi");
    } else if (url.includes('.mgtv.com')) {
      danmus = await mangoSource.getComments(url, "imgo");
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      if (url.includes('b23.tv')) {
        url = await bilibiliSource.resolveB23Link(url);
      }
      danmus = await bilibiliSource.getComments(url, "bilibili1");
    } else if (url.includes('.youku.com')) {
      danmus = await youkuSource(url, "youku");
    } else {
      // 如果不是已知平台，尝试第三方弹幕服务器
      const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
      if (urlPattern.test(url)) {
        danmus = await otherSource.getComments(url, "other_server");
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
export { handleRequest, searchAnime, searchEpisodes, matchAnime, getBangumi, getComment, getCommentByUrl, httpGet, httpPost,
  pingRedis, getRedisKey, setRedisKey, setRedisKeyWithExpiry, getSearchCache, setSearchCache, isSearchCacheValid,
  getCommentCache, setCommentCache, isCommentCacheValid};
