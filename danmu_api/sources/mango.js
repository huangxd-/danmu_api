import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet} from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { time_to_second, generateValidStartDate } from "../utils/time-util.js";
import { rgbToInt } from "../utils/danmu-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取芒果TV弹幕
// =====================
export default class MangoSource extends BaseSource {
  // 处理 v2_color 对象的转换逻辑
  transformV2Color(v2_color) {
    // 默认颜色值
    const DEFAULT_COLOR_INT = -1;

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

  /**
   * 从类型字符串中提取标准化的媒体类型
   * @param {string} typeStr - API 返回的类型字符串
   * @returns {string} 标准化的媒体类型
   */
  _extractMediaType(typeStr) {
    const type = (typeStr || "").toLowerCase();
    
    // 电影类型
    if (type.includes("电影") || type.includes("movie")) {
      return "电影";
    }
    
    // 动漫类型
    if (type.includes("动漫") || type.includes("动画") || type.includes("anime")) {
      return "动漫";
    }
    
    // 综艺类型
    if (type.includes("综艺") || type.includes("真人秀") || type.includes("variety")) {
      return "综艺";
    }
    
    // 纪录片类型
    if (type.includes("纪录片") || type.includes("documentary")) {
      return "纪录片";
    }
    
    // 电视剧类型
    if (type.includes("电视剧") || type.includes("剧集") || type.includes("drama") || type.includes("tv")) {
      return "电视剧";
    }
    
    // 默认返回电视剧（最常见的类型）
    return "电视剧";
  }

  async search(keyword) {
    try {
      log("info", `[Mango] 开始搜索: ${keyword}`);

      const encodedKeyword = encodeURIComponent(keyword);
      const searchUrl = `https://mobileso.bz.mgtv.com/msite/search/v2?q=${encodedKeyword}&pc=30&pn=1&sort=-99&ty=0&du=0&pt=0&corr=1&abroad=0&_support=10000000000000000`;

      const response = await httpGet(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

      // 处理搜索结果
      const results = [];
      for (const content of data.data.contents) {
        if (content.type !== "media") {
          continue;
        }

        for (const item of content.data) {
          // 只处理芒果TV自有内容 (source为'imgo')
          if (item.source !== "imgo") {
            continue;
          }

          // 从URL中提取 collection_id
          const urlMatch = item.url ? item.url.match(/\/b\/(\d+)/) : null;
          if (!urlMatch) {
            continue;
          }

          const mediaId = urlMatch[1];

          // 清理标题 (移除HTML标签)
          const cleanedTitle = item.title ? item.title.replace(/<[^>]+>/g, '').replace(/:/g, '：') : '';

          // 提取年份
          const yearMatch = item.desc && item.desc[0] ? item.desc[0].match(/[12][890][0-9][0-9]/) : null;
          const year = yearMatch ? parseInt(yearMatch[0]) : null;

          // 提取媒体类型（参考优化后的 youku.js 和 bilibili.js）
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

      // 分页获取所有分集（按月份分页）
      while (pageIndex < totalPages) {
        const url = `https://pcweb.api.mgtv.com/variety/showlist?allowedRC=1&collection_id=${id}&month=${month}&page=1&_support=10000000`;

        const response = await httpGet(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

        // 添加当前页的分集
        if (data.data.list && data.data.list.length > 0) {
          allEpisodes.push(...data.data.list.filter(ep => ep.src_clip_id === id));
        }

        // 第一次请求时获取总页数
        if (pageIndex === 0) {
          totalPages = data.data.tab_m && data.data.tab_m.length > 0 ? data.data.tab_m.length : 1;
          log("info", `[Mango] 检测到 ${totalPages} 个月份分页`);
        }

        // 准备下一页
        pageIndex++;
        if (pageIndex < totalPages && data.data.tab_m && data.data.tab_m[pageIndex]) {
          month = data.data.tab_m[pageIndex].m;
        }
      }

      // 芒果TV专属黑名单正则
      const mangoBlacklist = /^(.*?)(抢先(看|版)|加更(版)?|花絮|预告|特辑|(特别|惊喜|纳凉)?企划|彩蛋|专访|幕后(花絮)?|直播|纯享|未播|衍生|番外|合伙人手记|会员(专享|加长)|片花|精华|看点|速看|解读|reaction|超前营业|超前(vlog)?|陪看(记)?|.{3,}篇|影评)(.*?)$/i;

      // 过滤掉预告片等非正片内容
      const episodes = allEpisodes.filter(ep => {
        const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();

        // 过滤掉预告片 (isnew === "2")
        if (ep.isnew === "2") {
          log("debug", `[Mango] 过滤预告片: ${fullTitle}`);
          return false;
        }

        // 使用专属黑名单过滤
        if (mangoBlacklist.test(fullTitle)) {
          log("debug", `[Mango] 黑名单过滤: ${fullTitle}`);
          return false;
        }

        // 优先保留正片 (isIntact === "1")，或者没有标记的内容
        return true;
      });

      // 综艺节目智能处理
      const processedEpisodes = this._processVarietyEpisodes(episodes);

      log("info", `[Mango] 共获取 ${processedEpisodes.length} 集`);
      return processedEpisodes;

    } catch (error) {
      log("error", "[Mango] 获取分集出错:", error.message);
      return [];
    }
  }

  /**
   * 获取电影正片
   * @param {string} mediaId - 媒体ID
   * @returns {Object|null} 电影正片信息
   */
  async _getMovieEpisode(mediaId) {
    try {
      log("info", `[Mango] 获取电影正片: collection_id=${mediaId}`);

      const url = `https://pcweb.api.mgtv.com/variety/showlist?allowedRC=1&collection_id=${mediaId}&month=&page=1&_support=10000000`;

      const response = await httpGet(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

      // 智能寻找正片：
      // 1. 优先寻找 isIntact === "1" 的条目
      let mainFeature = data.data.list.find(ep => ep.isIntact === "1");

      // 2. 如果找不到，寻找第一个不是预告片的条目
      if (!mainFeature) {
        mainFeature = data.data.list.find(ep => ep.isnew !== "2");
      }

      // 3. 最后备用方案，使用第一个条目
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

  /**
   * 处理综艺分集，智能过滤和排序
   * @param {Array} rawEpisodes - 原始分集数据
   * @returns {Array} 处理后的分集列表
   */
  _processVarietyEpisodes(rawEpisodes) {
    if (!rawEpisodes || rawEpisodes.length === 0) {
      return [];
    }

    log("debug", `[Mango] 综艺处理开始，原始分集数: ${rawEpisodes.length}`);

    // 检查是否有"第N期"格式
    const hasQiFormat = rawEpisodes.some(ep => {
      const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();
      return /第\d+期/.test(fullTitle);
    });

    log("debug", `[Mango] 综艺格式分析: 有期数格式=${hasQiFormat}`);

    const episodeInfos = [];
    const qiInfoMap = new Map(); // 存储期数信息的映射

    for (const ep of rawEpisodes) {
      const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();

      if (hasQiFormat) {
        // 有"第N期"格式时：只保留纯粹的"第N期"和"第N期上/中/下"
        const qiUpMidDownMatch = fullTitle.match(/第(\d+)期([上中下])/);
        const qiPureMatch = fullTitle.match(/第(\d+)期/);
        const hasUpMidDown = /第\d+期[上中下]/.test(fullTitle);

        if (qiUpMidDownMatch) {
          // 检查是否包含无效后缀
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
          // 匹配纯粹的"第N期"格式
          const qiNum = qiPureMatch[1];
          qiInfoMap.set(ep, [parseInt(qiNum), '']);
          episodeInfos.push(ep);
          log("debug", `[Mango] 综艺保留标准期数: ${fullTitle}`);
        } else {
          log("debug", `[Mango] 综艺过滤非标准期数格式: ${fullTitle}`);
        }
      } else {
        // 没有任何"第N期"格式时：全部保留（除了明显的广告）
        if (fullTitle.includes('广告') || fullTitle.includes('推广')) {
          log("debug", `[Mango] 跳过广告内容: ${fullTitle}`);
          continue;
        }

        episodeInfos.push(ep);
        log("debug", `[Mango] 综艺保留原始标题: ${fullTitle}`);
      }
    }

    // 排序逻辑
    if (hasQiFormat) {
      // 有期数格式时，按期数和上中下排序
      episodeInfos.sort((a, b) => {
        const infoA = qiInfoMap.get(a) || [0, ''];
        const infoB = qiInfoMap.get(b) || [0, ''];

        // 先按期数排序
        if (infoA[0] !== infoB[0]) {
          return infoA[0] - infoB[0];
        }

        // 期数相同时，按上中下排序
        const orderMap = {'': 0, '上': 1, '中': 2, '下': 3};
        return (orderMap[infoA[1]] || 0) - (orderMap[infoB[1]] || 0);
      });
    } else {
      // 没有期数格式时，按集数排序
      episodeInfos.sort((a, b) => {
        const getEpisodeNumber = (ep) => {
          const fullTitle = `${ep.t2 || ''} ${ep.t1 || ''}`.trim();
          const match = fullTitle.match(/第(\d+)集/);
          return match ? parseInt(match[1]) : 999999;
        };

        const numA = getEpisodeNumber(a);
        const numB = getEpisodeNumber(b);

        // 如果都没有集数，按时间戳排序
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

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Mango] sourceAnimes is not a valid array");
      return [];
    }

    const processMangoAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          // 电影类型专门处理
          if (anime.type === "电影") {
            const movieEpisode = await this._getMovieEpisode(anime.mediaId);
            if (!movieEpisode) {
              return;
            }

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

        // 电视剧/综艺类型处理
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

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求芒果TV弹幕...", id);

    // 获取弹幕分段列表
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 创建请求Promise数组
    const promises = [];
    for (const segment of segmentList) {
      promises.push(
        httpGet(segment.url, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          retries: 1,
        })
      );
    }

    // 解析弹幕数据
    let contents = [];
    try {
      const results = await Promise.allSettled(promises);
      const datas = results
        .filter(result => result.status === "fulfilled")
        .map(result => {
          // 检查result是否包含响应数据
          if (result.value && result.value.data) {
            return result.value.data;
          }
          return null;
        })
        .filter(data => data !== null); // 过滤掉null值

      datas.forEach(data => {
        data = typeof data === "string" ? JSON.parse(data) : data;
        if (data.data?.items) {
          contents.push(...data.data.items);
        }
      });
    } catch (error) {
      log("error", "解析弹幕数据失败:", error);
      return [];
    }

    printFirst200Chars(contents);

    return contents;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取芒果TV弹幕分段列表...", id);

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://pcweb.api.mgtv.com/video/info";
    const api_ctl_barrage = "https://galaxy.bz.mgtv.com/getctlbarrage";
    const api_rd_barrage = "https://galaxy.bz.mgtv.com/rdbarrage";

    // 解析 URL 获取 cid 和 vid
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
    } else {
      log("error", 'Invalid URL');
      return new SegmentListResponse({
        "type": "imgo",
        "segmentList": []
      });
    }
    const cid = path[path.length - 2];
    const vid = path[path.length - 1].split(".")[0];

    log("info", `获取弹幕分段列表 - cid: ${cid}, vid: ${vid}`);

    // 获取视频信息
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
      if (error.response?.status === 404) {
        return new SegmentListResponse({
          "type": "imgo",
          "segmentList": []
        });
      }
      log("error", "请求视频信息失败:", error);
      return new SegmentListResponse({
        "type": "imgo",
        "segmentList": []
      });
    }

    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const time = data.data.info.time;

    let useNewApi = true;
    try {
      // 尝试使用新API（支持彩色弹幕）获取分段列表
      const ctlBarrageUrl = `${api_ctl_barrage}?version=8.1.39&abroad=0&uuid=&os=10.15.7&platform=0&mac=&vid=${vid}&pid=&cid=${cid}&ticket=`;
      const res = await httpGet(ctlBarrageUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const ctlBarrage = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

      // 检查数据结构
      if (!ctlBarrage.data || !ctlBarrage.data.cdn_list || !ctlBarrage.data.cdn_version) {
        log("warn", `新API缺少必要字段，返回空分段列表`);
        useNewApi = false;
      }

      // 构建分段列表
      const segmentList = [];
      if (!useNewApi) {
        const step = 60; // 每60秒一个分段
        const end_time = time_to_second(time);
        for (let i = 0; i < end_time; i += step) {
          segmentList.push({
            "type": "imgo",
            "segment_start": i,  // 每段开始时间（秒）
            "segment_end": Math.min((i + step), time_to_second(time)), // 每段结束时间（秒）
            "url": `${api_rd_barrage}?vid=${vid}&cid=${cid}&time=${i * 1000}`  // 每段弹幕URL
          });
        }
      } else {
        const totalSegments = Math.ceil(time_to_second(time) / 60); // 每1分钟一个分段
        const cdnList = ctlBarrage.data.cdn_list.split(',')[0];
        const cdnVersion = ctlBarrage.data.cdn_version;

        for (let i = 0; i < totalSegments; i++) {
          segmentList.push({
            "type": "imgo",
            "segment_start": i * 60,  // 每段开始时间（秒）
            "segment_end": Math.min((i + 1) * 60, time_to_second(time)), // 每段结束时间（秒）
            "url": `https://${cdnList}/${cdnVersion}/${i}.json`  // 每段弹幕URL
          });
        }
      }

      return new SegmentListResponse({
        "type": "imgo",
        "segmentList": segmentList
      });
    } catch (error) {
      log("error", "请求弹幕分段数据失败:", error);
      return new SegmentListResponse({
        "type": "imgo",
        "segmentList": []
      });
    }
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const parsedData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        if (parsedData.data?.items) {
          contents.push(...parsedData.data.items);
        }
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return []; // 返回空数组而不是抛出错误，保持与getEpisodeDanmu一致的行为
    }
  }

  formatComments(comments) {
    return comments.map(item => {
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
        content.color = this.transformV2Color(item?.v2_color);
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
      return content;
    });
  }
}
