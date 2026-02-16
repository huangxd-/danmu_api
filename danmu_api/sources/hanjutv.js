import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取韩剧TV弹幕
// =====================
export default class HanjutvSource extends BaseSource {
  async search(keyword) {
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
      log("info", `[Hanjutv] 搜索找到 ${resp.data.seriesData.seriesList.length} 个有效结果`);

      let resList = [];
      for (const anime of resp.data.seriesData.seriesList) {
        const animeId = convertToAsciiSum(anime.sid);
        resList.push({...anime, animeId});
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

  async getDetail(id) {
    try {
      const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/series/series/detail?sid=${id}`, {
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

  async getEpisodes(id) {
    try {
      const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/series/series/detail?sid=${id}`, {
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

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const cateMap = {1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧"}

    function getCategory(key) {
      return cateMap[key] || "其他";
    }

    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Hanjutv] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processHanjutvAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.name, queryTitle))
      .map(async (anime) => {
        try {
          const detail = await this.getDetail(anime.sid);
          const eps = await this.getEpisodes(anime.sid);
          let links = [];
          for (const ep of eps) {
            const epTitle = ep.title && ep.title.trim() !== "" ? `第${ep.serialNo}集：${ep.title}` : `第${ep.serialNo}集`;
            links.push({
              "name": epTitle,
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
              source: "hanjutv",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Hanjutv] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processHanjutvAnimes;
  }

  async getEpisodeDanmu(id) {
    let allDanmus = [];
    let fromAxis = 0;
    const maxAxis = 100000000;

    try {
      while (fromAxis < maxAxis) {
        const resp = await httpGet(`https://hxqapi.zmdcq.com/api/danmu/playItem/list?fromAxis=${fromAxis}&pid=${id}&toAxis=${maxAxis}`, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          retries: 1,
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

  async getEpisodeDanmuSegments(id) {
    log("info", "获取韩剧TV弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "hanjutv",
      "segmentList": [{
        "type": "hanjutv",
        "segment_start": 0,
        "segment_end": 30000,
        "url": id
      }]
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getEpisodeDanmu(segment.url);
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.did),
      p: `${(c.t / 1000).toFixed(2)},${c.tp === 2 ? 5 : c.tp},${Number(c.sc)},[hanjutv]`,
      m: c.con,
      t: Math.round(c.t / 1000)
    }));
  }
}