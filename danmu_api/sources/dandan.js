import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { simplized } from "../utils/zh-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取弹弹play弹幕
// =====================
export default class DandanSource extends BaseSource {
  async search(keyword) {
    try {
      const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/search/anime?keyword=${keyword}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `LogVar Danmu API/${globals.version}`,
        },
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "dandanSearchresp: 请求失败或无数据返回");
        return [];
      }

      // 判断 seriesData 是否存在
      if (!resp.data.animes) {
        log("info", "dandanSearchresp: seriesData 或 seriesList 不存在");
        return [];
      }

      // 正常情况下输出 JSON 字符串
      log("info", `[Dandan] 搜索找到 ${resp.data.animes.length} 个有效结果`);

      return resp.data.animes;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getDandanAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  // 获取番剧详情和剧集列表
  async getEpisodes(id) {
    try {
      const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=/v2/bangumi/${id}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `LogVar Danmu API/${globals.version}`,
        },
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getDandanEposides: 请求失败或无数据返回");
        return { episodes: [], titles: [] };
      }

      // 判断 bangumi 数据是否存在
      if (!resp.data.bangumi) {
        log("info", "getDandanEposides: bangumi 数据不存在");
        return { episodes: [], titles: [] };
      }

      const bangumiData = resp.data.bangumi;
      
      // 提取剧集列表，确保它是数组
      const episodes = Array.isArray(bangumiData.episodes) ? bangumiData.episodes : [];
      
      // 提取标题别名列表
      // 数据源格式: [{"language":"主标题","title":"雨天遇见狸"}, ...]
      const titles = Array.isArray(bangumiData.titles) ? bangumiData.titles.map(t => t.title) : [];

      // 正常情况下输出 JSON 字符串
      log("info", `getDandanEposides: ${JSON.stringify(resp.data.bangumi.episodes)}`);

      // 返回包含剧集和别名的完整对象
      return { episodes, titles };

    } catch (error) {
      // 捕获请求中的错误
      log("error", "getDandanEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return { episodes: [], titles: [] };
    }
  }

  // 处理并转换番剧信息
  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Dandan] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processDandanAnimes = await Promise.all(sourceAnimes
      .map(async (anime) => {
        try {
          // 获取详情数据（包含剧集和别名）
          const details = await this.getEpisodes(anime.animeId);
          const eps = details.episodes; // 提取剧集列表
          const aliases = details.titles; // 提取别名列表

          let links = [];
          for (const ep of eps) {
            // 格式化剧集标题
            const epTitle = ep.episodeTitle && ep.episodeTitle.trim() !== "" ? `${ep.episodeTitle}` : `第${ep.episodeNumber}集`;
            links.push({
              "name": epTitle,
              "url": ep.episodeId.toString(),
              "title": `【dandan】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            // 构造标准番剧对象
            let transformedAnime = {
              animeId: anime.animeId,
              bangumiId: String(anime.animeId),
              animeTitle: `${anime.animeTitle}(${new Date(anime.startDate).getFullYear()})【${anime.typeDescription}】from dandan`,
              aliases: aliases,
              type: anime.type,
              typeDescription: anime.typeDescription,
              imageUrl: anime.imageUrl,
              startDate: anime.startDate,
              episodeCount: links.length,
              rating: anime.rating,
              isFavorited: true,
              source: "dandan",
            };

            tmpAnimes.push(transformedAnime);

            // 添加到全局缓存
            addAnime({...transformedAnime, links: links});

            // 维护缓存大小
            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Dandan] Error processing anime: ${error.message}`);
        }
      })
    );

    // 按年份排序并推入当前列表
    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processDandanAnimes;
  }

  async getEpisodeDanmu(id) {
    let allDanmus = [];

    try {
      const resp = await httpGet(`https://api.danmaku.weeblify.app/ddp/v1?path=%2Fv2%2Fcomment%2F${id}%3Ffrom%3D0%26withRelated%3Dtrue%26chConvert%3D0`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        retries: 1,
      });

      // 将当前请求的 episodes 拼接到总数组
      if (resp.data && resp.data.comments) {
        allDanmus = resp.data.comments;
      }

      return allDanmus;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "fetchDandanEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return allDanmus; // 返回已收集的 episodes
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取弹弹play弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "dandan",
      "segmentList": [{
        "type": "dandan",
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
      cid: c.cid,
      p: `${c.p.replace(/([A-Za-z]+)([0-9a-fA-F]{6})/, (_, platform, hexColor) => {
        // 转换 hexColor 为十进制颜色值
        const r = parseInt(hexColor.substring(0, 2), 16);
        const g = parseInt(hexColor.substring(2, 4), 16);
        const b = parseInt(hexColor.substring(4, 6), 16);
        const decimalColor = r * 256 * 256 + g * 256 + b;
        return `${platform}${decimalColor}`;
      })}`,
      // 根据 globals.danmuSimplifiedTraditional 控制是否繁转简
      m: globals.danmuSimplifiedTraditional === 'simplified' ? simplized(c.m) : c.m,
    }));
  }
}
