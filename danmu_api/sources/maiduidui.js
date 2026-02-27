import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpPost, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum, md5 } from "../utils/codec-util.js";
import { hexToInt } from "../utils/danmu-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取埋堆堆弹幕
// =====================
class MaiduiduiSource extends BaseSource {
  constructor() {
    super();
    
    this.domain = "https://mob.mddcloud.com.cn";
    this.headers = {
      "user-agent": "Mdd/5.8.00 (Android+32+)",
      "Content-Type": "application/json",
      "version": "5.8.00",
      "Referer": "mdd"
    }
  }

  getPlayload(urlSuffix, dataBody) {
    const time = Date.now();
    const queryStr = buildQueryString(dataBody, false);

    const rawInput = (
      `os:Android|version:5.8.00|action:${urlSuffix}` +
      `|time:${time}|appToken:|privateKey:e1be6b4cf4021b3d181170d1879a530a9e4130b69032144d5568abfd6cd6c1c2` +
      `|data:${queryStr}&`
    );

    return {
      "channel": "1000",
      "data": dataBody,
      "deviceNum": "853BDD7A1DC011F1C341455071C03AEB",
      "deviceType": 0,
      "jsonSign": 0,
      "os": "Android",
      "sign": md5(rawInput),
      "sourceVersion": 0,
      "terminalType": "APP",
      "thirdStatus": 0,
      "time": time,
      "version": "5.8.00",
      "visitorStatus": 0
    }
  }

  extractByRegex(url) {
    const vodUuidMatch = url.match(/\/video\/([a-f0-9]+)\.html/i);
    const uuidMatch = url.match(/[?&]uuid=([a-f0-9]+)/i);
    
    return {
        vodUuid: vodUuidMatch ? vodUuidMatch[1] : null,
        uuid: uuidMatch ? uuidMatch[1] : null,
        success: !!(vodUuidMatch && uuidMatch)
    };
  }

  async search(keyword) {
    try {
      const urlSuffix = "/searchApi/search/getAllSearchResult4820.action";
      const searchUrl = `${this.domain}${urlSuffix}`;
      const dataBody = {
        "keyWord": keyword
      };

      const response = await httpPost(searchUrl, JSON.stringify(this.getPlayload(urlSuffix, dataBody)), {
        headers: this.headers
      });

      if (!response || !response.data) {
        log("info", "[Maiduidui] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      const animes = [];
      const typeList = data?.data;
      for (const typeItem of typeList) {
        if (typeItem?.typeName === "剧集" || typeItem?.typeName === "电影" || typeItem?.typeName === "综艺") {
          for (const vodItem of typeItem?.vodList) {
            animes.push({
              name: vodItem.name,
              type: typeItem.typeName,
              year: vodItem.yearName,
              img: vodItem.downImage,
              url: vodItem.uuid
            });
          }
        }
      }

      // 正常情况下输出 JSON 字符串
      log("info", `[Maiduidui] 搜索找到 ${animes.length} 个有效结果`);
      return animes;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMaiduiduiAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getDetail(id) {
    try {
      const idInfo = this.extractByRegex(id);
      const uuid = idInfo.uuid;
      const vodUuid = idInfo.vodUuid;

      const urlSuffix = "/api/vod/listVodSactions.action";
      const searchUrl = `${this.domain}${urlSuffix}`;
      const dataBody = {
        "hasIntroduction": 0,
        "vodUuid": vodUuid
      };

      const response = await httpPost(searchUrl, JSON.stringify(this.getPlayload(urlSuffix, dataBody)), {
        headers: this.headers
      });

      if (!response || !response.data) {
        log("info", "[Maiduidui] 获取详情信息响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      for (const epInfo of data?.data) {
        if (epInfo.uuid === uuid) {
          return epInfo.duration;
        }
      }
      return 0;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMaiduiduiDetail error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return 0;
    }
  }

  async getEpisodes(id) {
    try {
      const urlSuffix = "/api/vod/listVodSactions.action";
      const searchUrl = `${this.domain}${urlSuffix}`;
      const dataBody = {
        "hasIntroduction": 0,
        "vodUuid": id
      };

      const response = await httpPost(searchUrl, JSON.stringify(this.getPlayload(urlSuffix, dataBody)), {
        headers: this.headers
      });

      if (!response || !response.data) {
        log("info", "[Maiduidui] 获取集信息响应为空");
        return [];
      }

      const eps = [];

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      data?.data.forEach(epInfo => {
        eps.push({
          title: epInfo.name,
          episodeId: epInfo.uuid
        });
      });

      return eps;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMaiduiduiEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Maiduidui] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processMaiduiduiAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.name, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.url);
          let links = [];
          for (const ep of eps) {
            const epTitle = ep.title;
            links.push({
              "name": epTitle,
              "url": `https://www.mddcloud.com.cn/video/${anime.url}.html?uuid=${ep.episodeId}`,
              "title": `【maiduidui】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: convertToAsciiSum(anime.url),
              bangumiId: anime.url,
              animeTitle: `${anime.name}(${anime.year})【${anime.type}】from maiduidui`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.img,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "maiduidui",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Maiduidui] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processMaiduiduiAnimes;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求埋堆堆弹幕...", id);
    
    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 并发请求所有弹幕段，限制并发数量为20
    const MAX_CONCURRENT = 20;
    const allComments = [];
    
    // 将segmentList分批处理，每批最多MAX_CONCURRENT个请求
    for (let i = 0; i < segmentList.length; i += MAX_CONCURRENT) {
      const batch = segmentList.slice(i, i + MAX_CONCURRENT);
      
      // 并发处理当前批次的请求
      const batchPromises = batch.map(segment => this.getEpisodeSegmentDanmu(segment));
      const batchResults = await Promise.allSettled(batchPromises);
      
      // 处理结果
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const segment = batch[j];
        const start = segment.segment_start;
        const end = segment.segment_end;
        
        if (result.status === 'fulfilled') {
          const comments = result.value;
          
          if (comments && comments.length > 0) {
            allComments.push(...comments);
          }
        } else {
          log("error", `获取弹幕段失败 (${start}-${end}s):`, result.reason.message);
        }
      }
      
      // 批次之间稍作延迟，避免过于频繁的请求
      if (i + MAX_CONCURRENT < segmentList.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (allComments.length === 0) {
      log("info", `埋堆堆: 该视频暂无弹幕数据 (vid=${id})`);
      return [];
    }

    printFirst200Chars(allComments);

    return allComments;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取埋堆堆弹幕分段列表...", id);

    const idInfo = this.extractByRegex(id);
    const uuid = idInfo.uuid;
    const duration = await this.getDetail(id);
    log("info", "uuid:", uuid);
    log("info", "duration:", duration);

    const segmentDuration = 60; // 每个分片1分钟
    const segmentList = [];

    for (let i = 0; i < duration; i += segmentDuration) {
      const segmentStart = i;
      const segmentEnd = Math.min(i + segmentDuration, duration); // 不超过总时长
      
      segmentList.push({
        "type": "maiduidui",
        "segment_start": segmentStart,
        "segment_end": segmentEnd,
        "url": id
      });
    }

    return new SegmentListResponse({
      "type": "maiduidui",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const idInfo = this.extractByRegex(segment.url);
      const uuid = idInfo.uuid;
      const vodUuid = idInfo.vodUuid;

      const urlSuffix = "/api/barrage/vodBarrage396.action";
      const searchUrl = `${this.domain}${urlSuffix}`;
      const dataBody = {
        "sactionUuid": uuid,
        "times": segment.segment_start,
        "vodUuid": vodUuid
      };

      const response = await httpPost(searchUrl, JSON.stringify(this.getPlayload(urlSuffix, dataBody)), {
        headers: this.headers,
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const parsedData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        const danmakuList = parsedData.data ?? [];
        danmakuList.forEach(danmakuItem => {
          contents.push(...danmakuItem.barrageList);
        });
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return []; // 返回空数组而不是抛出错误，保持与getEpisodeDanmu一致的行为
    }
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.uuid),
      p: `${(c.times).toFixed(2)},1,${hexToInt(c.color.replace("#", ""))},[maiduidui]`,
      m: c.content,
      t: c.times
    }));
  }

}

export default MaiduiduiSource;
