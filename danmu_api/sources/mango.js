import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { time_to_second, generateValidStartDate } from "../utils/time-util.js";
import { rgbToInt } from "../utils/danmu-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取芒果TV弹幕（移动端APP接口优化版）
// =====================
export default class MangoSource extends BaseSource {
  constructor() {
    super();
    // 移动端User-Agent（从抓包数据中提取）
    this.mobileUA = "Dalvik/2.1.0 (Linux; U; Android 16; 23127PN0CC Build/BP2A.250605.031.A3) imgotv-aphone-9.1.4";
    // PC端User-Agent
    this.pcUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    
    // APP通用参数（从抓包数据中提取）
    this.appParams = {
      "_support": "10100001",
      "device": "23127PN0CC",
      "osVersion": "16",
      "appVersion": "9.1.4",
      "androidPatch": "9.1.4",
      "osType": "android",
      "channel": "xiaomi",
      "uuid": "e0b4ede4ee9f4c16ac7462624dacb9fa",
      "endType": "mgtvapp",
      "oaid": "a5bfd047b9aba489",
      "ageMode": "0",
      "version": "5.2",
      "type": "10",
      "abroad": "0",
      "src": "mgtv",
      "phonetype": "23127PN0CC",
      "allowedRC": "1",
      "mf": "Xiaomi",
      "brand": "Xiaomi"
    };
  }

  // 处理 v2_color 对象的转换逻辑
  transformV2Color(v2_color) {
    const DEFAULT_COLOR_INT = -1;
    if (!v2_color) return DEFAULT_COLOR_INT;
    
    const leftColor = rgbToInt(v2_color.color_left);
    const rightColor = rgbToInt(v2_color.color_right);
    
    if (leftColor === -1 && rightColor === -1) return DEFAULT_COLOR_INT;
    if (leftColor === -1) return rightColor;
    if (rightColor === -1) return leftColor;
    
    return Math.floor((leftColor + rightColor) / 2);
  }

  /**
   * 从类型字符串中提取标准化的媒体类型
   */
  _extractMediaType(typeStr) {
    const type = (typeStr || "").toLowerCase();
    
    if (type.includes("电影") || type.includes("movie")) return "电影";
    if (type.includes("动漫") || type.includes("动画") || type.includes("anime")) return "动漫";
    if (type.includes("综艺") || type.includes("真人秀") || type.includes("variety")) return "综艺";
    if (type.includes("纪录片") || type.includes("documentary")) return "纪录片";
    if (type.includes("电视剧") || type.includes("剧集") || type.includes("drama") || type.includes("tv")) return "电视剧";
    
    return "电视剧";
  }

  async search(keyword) {
    try {
      log("info", `[Mango] 开始搜索: ${keyword}`);

      const encodedKeyword = encodeURIComponent(keyword);
      const searchUrl = `https://mobileso.bz.mgtv.com/msite/search/v2?q=${encodedKeyword}&pc=30&pn=1&sort=-99&ty=0&du=0&pt=0&corr=1&abroad=0&_support=10000000000000000`;

      const response = await httpGet(searchUrl, {
        headers: {
          'User-Agent': this.pcUA,
          'Accept': 'application/json',
          'Referer': 'https://www.mgtv.com/'
        }
      });

      if (!response || !response.data) {
        log("info", "[Mango] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.contents) {
        log("info", "[Mango] 搜索无结果");
        return [];
      }

      const results = [];
      for (const content of data.data.contents) {
        if (content.type !== "media") continue;

        for (const item of content.data) {
          if (item.source !== "imgo") continue;

          const urlMatch = item.url ? item.url.match(/\/b\/(\d+)/) : null;
          if (!urlMatch) continue;

          const mediaId = urlMatch[1];
          const cleanedTitle = item.title ? item.title.replace(/<[^>]+>/g, '').replace(/:/g, '：') : '';
          const yearMatch = item.desc && item.desc[0] ? item.desc[0].match(/[12][890][0-9][0-9]/) : null;
          const year = yearMatch ? parseInt(yearMatch[0]) : null;
          const typeMatch = item.desc && item.desc[0] ? item.desc[0].split('/')[0].replace("类型:", "").trim() : '';
          const mediaType = this._extractMediaType(typeMatch);

          results.push({
            provider: "imgo",
            mediaId: mediaId,
            title: cleanedTitle,
            type: mediaType,
            year: year,
            imageUrl: item.img || null,
            episodeCount: item.videoCount || null
          });
        }
      }

      log("info", `[Mango] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Mango] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Mango] 获取分集列表: collection_id=${id}`);

      let allEpisodes = [];
      let month = "";
      let pageIndex = 0;
      let totalPages = 1;

      while (pageIndex < totalPages) {
        const url = `https://pcweb.api.mgtv.com/variety/showlist?allowedRC=1&collection_id=${id}&month=${month}&page=1&_support=10000000`;

        const response = await httpGet(url, {
          headers: {
            'User-Agent': this.pcUA,
            'Referer': 'https://www.mgtv.com/'
          }
        });

        if (!response || !response.data) {
          log("info", "[Mango] 未找到分集信息");
          break;
        }

        const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

        if (!data.data || !data.data.list) {
          log("info", "[Mango] 分集列表为空");
          break;
        }

        if (data.data.list && data.data.list.length > 0) {
          allEpisodes.push(...data.data.list.filter(ep => ep.src_clip_id === id));
        }

        if (pageIndex === 0) {
          totalPages = data.data.tab_m && data.data.tab_m.length > 0 ? data.data.tab_m.length : 1;
          log("info", `[Mango] 检测到 ${totalPages} 个月份分页`);
        }

        pageIndex++;
        if (pageIndex < totalPages && data.data.tab_m && data.data.tab_m[pageIndex]) {
          month = data.data.tab_m[pageIndex].m;
        }
      }

      const mangoBlacklist = /^(.*?)(抢先(看|版)|加更(版)?|花絮|预告|特辑|(特别|惊喜|纳凉)?企划|彩蛋|专访|幕后(花絮)?|直播|纯享|未播|衍生|番外|合伙人手记|会员(专享|加长)|片花|精华|看点|速看|解读|reaction|超前营业|超前(vlog)?|陪看(记)?|.{3,}篇|影评)(.*?)$/i;

      const episodes = allEpisodes.filter(ep => {
        const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();

        if (ep.isnew === "2") {
          log("debug", `[Mango] 过滤预告片: ${fullTitle}`);
          return false;
        }

        if (mangoBlacklist.test(fullTitle)) {
          log("debug", `[Mango] 黑名单过滤: ${fullTitle}`);
          return false;
        }

        return true;
      });

      const processedEpisodes = this._processVarietyEpisodes(episodes);

      log("info", `[Mango] 共获取 ${processedEpisodes.length} 集`);
      return processedEpisodes;

    } catch (error) {
      log("error", "[Mango] 获取分集出错:", error.message);
      return [];
    }
  }

  async _getMovieEpisode(mediaId) {
    try {
      log("info", `[Mango] 获取电影正片: collection_id=${mediaId}`);

      const url = `https://pcweb.api.mgtv.com/variety/showlist?allowedRC=1&collection_id=${mediaId}&month=&page=1&_support=10000000`;

      const response = await httpGet(url, {
        headers: {
          'User-Agent': this.pcUA,
          'Referer': 'https://www.mgtv.com/'
        }
      });

      if (!response || !response.data) {
        log("info", "[Mango] 未找到电影信息");
        return null;
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.list || data.data.list.length === 0) {
        log("info", "[Mango] 电影列表为空");
        return null;
      }

      let mainFeature = data.data.list.find(ep => ep.isIntact === "1");
      if (!mainFeature) {
        mainFeature = data.data.list.find(ep => ep.isnew !== "2");
      }
      if (!mainFeature) {
        mainFeature = data.data.list[0];
      }

      log("info", `[Mango] 找到电影正片: ${mainFeature.t3 || mainFeature.t1 || '正片'}`);
      return mainFeature;

    } catch (error) {
      log("error", "[Mango] 获取电影正片出错:", error.message);
      return null;
    }
  }

  _processVarietyEpisodes(rawEpisodes) {
    if (!rawEpisodes || rawEpisodes.length === 0) return [];

    log("debug", `[Mango] 综艺处理开始，原始分集数: ${rawEpisodes.length}`);

    const hasQiFormat = rawEpisodes.some(ep => {
      const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();
      return /第\d+期/.test(fullTitle);
    });

    log("debug", `[Mango] 综艺格式分析: 有期数格式=${hasQiFormat}`);

    const episodeInfos = [];
    const qiInfoMap = new Map();

    for (const ep of rawEpisodes) {
      const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();

      if (hasQiFormat) {
        const qiUpMidDownMatch = fullTitle.match(/第(\d+)期([上中下])/);
        const qiPureMatch = fullTitle.match(/第(\d+)期/);
        const hasUpMidDown = /第\d+期[上中下]/.test(fullTitle);

        if (qiUpMidDownMatch) {
          const qiNum = qiUpMidDownMatch[1];
          const upMidDown = qiUpMidDownMatch[2];
          const qiUpMidDownText = `第${qiNum}期${upMidDown}`;
          const afterUpMidDown = fullTitle.substring(fullTitle.indexOf(qiUpMidDownText) + qiUpMidDownText.length);
          const hasInvalidSuffix = /^(加更|会员版|纯享版|特别版|独家版|Plus|\+|花絮|预告|彩蛋|抢先|精选|未播|回顾|特辑|幕后)/.test(afterUpMidDown);

          if (!hasInvalidSuffix) {
            qiInfoMap.set(ep, [parseInt(qiNum), upMidDown]);
            episodeInfos.push(ep);
            log("debug", `[Mango] 综艺保留上中下格式: ${fullTitle}`);
          } else {
            log("debug", `[Mango] 综艺过滤上中下格式+后缀: ${fullTitle}`);
          }
        } else if (qiPureMatch && !hasUpMidDown && !/会员版|纯享版|特别版|独家版|加更|Plus|\+|花絮|预告|彩蛋|抢先|精选|未播|回顾|特辑|幕后|访谈|采访|混剪|合集|盘点|总结|删减|未播放|NG|番外|片段|看点|精彩|制作|导演|演员|拍摄|片尾曲|插曲|主题曲|背景音乐|OST|音乐|歌曲/.test(fullTitle)) {
          const qiNum = qiPureMatch[1];
          qiInfoMap.set(ep, [parseInt(qiNum), '']);
          episodeInfos.push(ep);
          log("debug", `[Mango] 综艺保留标准期数: ${fullTitle}`);
        } else {
          log("debug", `[Mango] 综艺过滤非标准期数格式: ${fullTitle}`);
        }
      } else {
        if (fullTitle.includes('广告') || fullTitle.includes('推广')) {
          log("debug", `[Mango] 跳过广告内容: ${fullTitle}`);
          continue;
        }

        episodeInfos.push(ep);
        log("debug", `[Mango] 综艺保留原始标题: ${fullTitle}`);
      }
    }

    if (hasQiFormat) {
      episodeInfos.sort((a, b) => {
        const infoA = qiInfoMap.get(a) || [0, ''];
        const infoB = qiInfoMap.get(b) || [0, ''];

        if (infoA[0] !== infoB[0]) {
          return infoA[0] - infoB[0];
        }

        const orderMap = {'': 0, '上': 1, '中': 2, '下': 3};
        return (orderMap[infoA[1]] || 0) - (orderMap[infoB[1]] || 0);
      });
    } else {
      episodeInfos.sort((a, b) => {
        const getEpisodeNumber = (ep) => {
          const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();
          const match = fullTitle.match(/第(\d+)集/);
          return match ? parseInt(match[1]) : 999999;
        };

        const numA = getEpisodeNumber(a);
        const numB = getEpisodeNumber(b);

        if (numA === 999999 && numB === 999999) {
          const timeA = a.ts || "0";
          const timeB = b.ts || "0";
          return timeA.localeCompare(timeB);
        }

        return numA - numB;
      });
    }

    log("debug", `[Mango] 综艺处理完成，过滤后分集数: ${episodeInfos.length}`);
    return episodeInfos;
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Mango] sourceAnimes is not a valid array");
      return [];
    }

    const processMangoAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          if (anime.type === "电影") {
            const movieEpisode = await this._getMovieEpisode(anime.mediaId);
            if (!movieEpisode) return;

            const fullUrl = `https://www.mgtv.com/b/${anime.mediaId}/${movieEpisode.video_id}.html`;
            const episodeTitle = movieEpisode.t3 || movieEpisode.t1 || "正片";

            const links = [{
              "name": "1",
              "url": fullUrl,
              "title": `【imgo】 ${episodeTitle}`
            }];

            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from imgo`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: 1,
              rating: 0,
              isFavorited: true,
              source: "imgo",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
            return;
          }

          const eps = await this.getEpisodes(anime.mediaId);

          let links = [];
          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const fullUrl = `https://www.mgtv.com/b/${anime.mediaId}/${ep.video_id}.html`;
            const episodeTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();

            links.push({
              "name": String(i + 1),
              "url": fullUrl,
              "title": `【imgo】 ${episodeTitle}`
            });
          }

          if (links.length > 0) {
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from imgo`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "imgo",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Mango] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processMangoAnimes;
  }

  /**
   * 获取弹幕（使用移动端APP接口 - 完全基于抓包数据优化）
   */
  async getEpisodeDanmu(id) {
    log("info", "[Mango] 开始获取弹幕（移动端APP接口）...", id);

    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      log("warn", "[Mango] 未获取到弹幕分段列表");
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `[Mango] 弹幕分段数量: ${segmentList.length}`);

    // 批量请求所有分段
    const promises = segmentList.map(segment => 
      httpGet(segment.url, {
        headers: {
          "User-Agent": this.mobileUA,
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "Connection": "Keep-Alive",
          "Host": new URL(segment.url).host
        },
        retries: 2,
        timeout: 10000,
      }).catch(error => {
        log("warn", `[Mango] 分段请求失败: ${segment.url}`, error.message);
        return null;
      })
    );

    const results = await Promise.allSettled(promises);
    
    let allComments = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value && result.value.data) {
        try {
          const data = typeof result.value.data === "string" 
            ? JSON.parse(result.value.data) 
            : result.value.data;
          
          if (data.data && data.data.items && Array.isArray(data.data.items)) {
            allComments.push(...data.data.items);
          }
        } catch (error) {
          log("warn", "[Mango] 解析弹幕数据失败:", error.message);
        }
      }
    }

    log("info", `[Mango] 成功获取 ${allComments.length} 条弹幕`);
    printFirst200Chars(allComments);

    return allComments;
  }

  /**
   * 获取弹幕分段列表（使用移动端API - 完全基于抓包数据）
   */
  async getEpisodeDanmuSegments(id) {
    log("info", "[Mango] 获取弹幕分段列表（移动端APP接口）...", id);

    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    if (!match) {
      log("error", "[Mango] 无效的URL格式");
      return new SegmentListResponse({ "type": "imgo", "segmentList": [] });
    }

    const path = match[2].split('/').filter(Boolean);
    const clipId = path[path.length - 2];
    const videoId = path[path.length - 1].split(".")[0];

    log("info", `[Mango] 解析得到 clipId: ${clipId}, videoId: ${videoId}`);

    try {
      // 1. 使用移动端API获取视频详情（从抓包数据获取）
      const params = new URLSearchParams({
        ...this.appParams,
        "videoId": videoId,
        "clipId": clipId,
        "plId": "0",
        "fromClipId": clipId,
        "fromPlId": "0",
        "fromModuleId": "14",
        "toModuleId": "14",
        "platform": "10",
        "localPlayVideoId": "",
        "localVideoWatchTime": "",
        "keepPlay": "0",
        "cliVodAbConf": "2",
        "seqId": this._generateSeqId(),
        "uid": this.appParams.uuid,
        "userId": "0",
        "ticket": "",
        "did": "db9451efcc36410672ab179feb425f59",
        "mac": "db9451efcc36410672ab179feb425f59",
        "exdef": JSON.stringify({
          "av01": {"hdr": {"bit_depth": "10", "hdr_type": "1", "max_def": "1920x1080", "max_def_fps": "480", "support": "1"}, "sdr": {"max_def": "1920x1080", "max_def_fps": "480"}, "support": "1"},
          "h264": {"hdr": {"bit_depth": "10", "hdr_type": "0", "max_def": "0x0", "max_def_fps": "0", "support": "0"}, "sdr": {"max_def": "1920x1080", "max_def_fps": "480"}, "support": "1"},
          "h265": {"hdr": {"bit_depth": "10", "hdr_type": "2", "max_def": "1920x1080", "max_def_fps": "480", "support": "1"}, "sdr": {"max_def": "1920x1080", "max_def_fps": "480"}, "support": "1"},
          "sceen_fps": "120", "sceen_ppi": "460", "sceen_size": "1200x2670", "screen_hdr_type": "1", "support": "1", "support_3da": "1", "support_wanos": "0", "version": "4"
        })
      });

      const videoInfoUrl = `https://mobile-thor.api.mgtv.com/v1/vod/info?${params.toString()}`;
      
      const videoInfoRes = await httpGet(videoInfoUrl, {
        headers: {
          "User-Agent": this.mobileUA,
          "Host": "mobile-thor.api.mgtv.com",
          "Connection": "Keep-Alive",
          "Accept-Encoding": "gzip"
        }
      });

      if (!videoInfoRes || !videoInfoRes.data) {
        log("error", "[Mango] 获取视频信息失败");
        return this._buildFallbackSegments(videoId, clipId, 3600);
      }

      const videoData = typeof videoInfoRes.data === "string" 
        ? JSON.parse(videoInfoRes.data) 
        : videoInfoRes.data;

      // 从返回数据中提取时长
      const videoDuration = videoData.data?.info?.video?.partName;
      let durationSeconds = 3600; // 默认1小时
      
      if (videoDuration) {
        durationSeconds = time_to_second(videoDuration);
      }

      log("info", `[Mango] 视频时长: ${durationSeconds}秒`);

      // 2. 使用移动端API获取弹幕配置
      const danmuParams = new URLSearchParams({
        ...this.appParams,
        "videoId": videoId,
        "clipId": clipId,
        "fstlvlId": "2",
        "plId": "0",
        "needOnlyHighlight": "1",
        "vid": videoId,
        "seqId": this._generateSeqId(),
        "uid": this.appParams.uuid,
        "userId": "0",
        "ticket": "",
        "did": "db9451efcc36410672ab179feb425f59",
        "mac": "db9451efcc36410672ab179feb425f59"
      });

      const highlightUrl = `https://mobile-thor.api.mgtv.com/v1/vod/highlight/list?${danmuParams.toString()}`;
      
      await httpGet(highlightUrl, {
        headers: {
          "User-Agent": this.mobileUA,
          "Host": "mobile-thor.api.mgtv.com",
          "Connection": "Keep-Alive",
          "Accept-Encoding": "gzip"
        }
      });

      // 3. 构建弹幕分段URL（使用galaxy.bz.mgtv.com接口）
      return this._buildGalaxySegments(videoId, clipId, durationSeconds);

    } catch (error) {
      log("error", "[Mango] 获取弹幕分段列表出错:", error.message);
      return new SegmentListResponse({ "type": "imgo", "segmentList": [] });
    }
  }

  /**
   * 构建Galaxy弹幕分段（基于抓包数据的移动端接口）
   */
  _buildGalaxySegments(vid, cid, durationSeconds) {
    log("info", "[Mango] 使用Galaxy移动端接口构建弹幕分段");
    
    const segmentList = [];
    const step = 60; // 每60秒一个分段

    for (let i = 0; i < durationSeconds; i += step) {
      const segmentStart = i;
      const segmentEnd = Math.min(i + step, durationSeconds);
      
      const params = new URLSearchParams({
        ...this.appParams,
        "vid": vid,
        "time": String(i * 1000), // 毫秒
        "pid": "0",
        "cid": cid,
        "seqId": this._generateSeqId(),
        "uid": this.appParams.uuid,
        "userId": "0",
        "ticket": "",
        "did": "db9451efcc36410672ab179feb425f59",
        "mac": "db9451efcc36410672ab179feb425f59",
        "platform": "2"
      });
      
      segmentList.push({
        "type": "imgo",
        "segment_start": segmentStart,
        "segment_end": segmentEnd,
        "url": `https://galaxy.bz.mgtv.com/cdn/opbarrage?${params.toString()}`
      });
    }

    log("info", `[Mango] 构建 ${segmentList.length} 个弹幕分段（Galaxy移动端接口）`);
    return new SegmentListResponse({
      "type": "imgo",
      "segmentList": segmentList
    });
  }

  /**
   * 降级弹幕分段（使用移动端接口）
   */
  _buildFallbackSegments(vid, cid, durationSeconds) {
    log("info", "[Mango] 使用移动端接口降级方案");
    return this._buildGalaxySegments(vid, cid, durationSeconds);
  }

  /**
   * 生成随机seqId（32位十六进制）
   */
  _generateSeqId() {
    return Array.from({length: 32}, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }

  /**
   * 获取单个分段的弹幕
   */
  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "User-Agent": this.mobileUA,
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "Connection": "Keep-Alive",
          "Host": new URL(segment.url).host
        },
        retries: 2,
        timeout: 10000,
      });

      if (!response || !response.data) {
        log("warn", "[Mango] 分段弹幕响应为空");
        return [];
      }

      const data = typeof response.data === "string" 
        ? JSON.parse(response.data) 
        : response.data;

      if (data.data && data.data.items && Array.isArray(data.data.items)) {
        return data.data.items;
      }

      return [];
    } catch (error) {
      log("error", "[Mango] 获取分段弹幕失败:", error.message);
      return [];
    }
  }

  /**
   * 格式化弹幕数据
   */
  formatComments(comments) {
    return comments.map(item => {
      const content = {
        timepoint: 0,
        ct: 1,
        size: 25,
        color: 16777215,
        unixtime: Math.floor(Date.now() / 1000),
        uid: 0,
        content: "",
      };

      if (item?.v2_color) {
        content.color = this.transformV2Color(item.v2_color);
      }

      if (item?.v2_position) {
        if (item.v2_position === 1) {
          content.ct = 5; // 顶部
        } else if (item.v2_position === 2) {
          content.ct = 4; // 底部
        }
      }

      content.timepoint = item.time / 1000;
      content.content = item.content || "";
      content.uid = item.uid || 0;

      return content;
    });
  }
}