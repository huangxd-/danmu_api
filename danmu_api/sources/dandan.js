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
        return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null };
      }

      // 判断 bangumi 数据是否存在
      if (!resp.data.bangumi) {
        log("info", "getDandanEposides: bangumi 数据不存在");
        return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null };
      }

      const bangumiData = resp.data.bangumi;
      
      // 提取剧集列表，确保它是数组
      const episodes = Array.isArray(bangumiData.episodes) ? bangumiData.episodes : [];
      
      // 提取标题别名列表
      // 数据源格式: [{"language":"主标题","title":"雨天遇见狸"}, ...]
      const titles = Array.isArray(bangumiData.titles) ? bangumiData.titles.map(t => t.title) : [];

      // 提取相关作品列表以供系列扩展搜索
      const relateds = Array.isArray(bangumiData.relateds) ? bangumiData.relateds : [];

      // 提取番剧类型信息，用于相关作品无法从搜索接口获取该字段时的数据补全
      const type = bangumiData.type || null;
      const typeDescription = bangumiData.typeDescription || null;

      // 正常情况下输出 JSON 字符串
      log("info", `getDandanEposides: ${JSON.stringify(resp.data.bangumi.episodes)}`);

      // 返回包含剧集、别名、相关作品及类型信息的完整对象
      return { episodes, titles, relateds, type, typeDescription };

    } catch (error) {
      // 捕获请求中的错误
      log("error", "getDandanEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return { episodes: [], titles: [], relateds: [], type: null, typeDescription: null };
    }
  }

  // 检测标题中是否包含明确的季度或部分特征，用于相关作品开关
  hasSeasonInfo(title) {
    return /(?:^|\s)(?:第[0-9一二三四五六七八九十百千万]+季|S(?:eason)?\s*\d+)(?:\s+|_)/gi.test(title)
      || /^(?:(?:第|S(?:eason)?)\s*\d+(?:季|期|部)?|(?:Part|P|第)\s*\d+(?:部分)?)$/i.test(title)
      || /(第[0-9一二三四五六七八九十百千万\d]+(?:季|期|部)|S(?:eason)?\s*\d+|Part\s*\d+)/i.test(title);
  }

  // 计算两个字符串的文本相似度（字符集交并比算法）
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = new Set(str1.toLowerCase());
    const s2 = new Set(str2.toLowerCase());
    const intersection = [...s1].filter(char => s2.has(char)).length;
    const union = new Set([...s1, ...s2]).size;
    return intersection / union;
  }

  // 处理并转换番剧信息
  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Dandan] sourceAnimes is not a valid array");
      return [];
    }

    // 初始搜索结果数量，用于判断是否展开相关作品搜索
    const initialCount = sourceAnimes.length;

    const existingIds = new Set();
    const queue = [];

    // 初始化任务队列与去重池
    for (const anime of sourceAnimes) {
      existingIds.add(anime.animeId);
      queue.push(anime);
    }

    // 递归获取所有层级关联作品，批次处理避免并发过载
    while (queue.length > 0) {
      const currentBatch = queue.splice(0, queue.length);

      await Promise.all(currentBatch.map(async (anime) => {
        try {
          // 获取详情数据（包含剧集、别名和相关作品）
          const details = await this.getEpisodes(anime.animeId);
          const eps = details.episodes; // 提取剧集列表
          const aliases = details.titles; // 提取别名列表

          // 计算当前作品标题与用户原始搜索词的相似度
          const similarity = this.calculateSimilarity(queryTitle, anime.animeTitle);

          // 相似度高于10%时，对每个关联作品单独判断是否符合展开条件：
          // 关联作品标题含季度信息（避免范围发散），或初始搜索结果不少于25个（API25个结果上限，用相关作品突破）
          if (similarity >= 0.1 && details.relateds && Array.isArray(details.relateds)) {
            for (const rel of details.relateds) {
              if (!existingIds.has(rel.animeId) && (this.hasSeasonInfo(rel.animeTitle) || initialCount >= 25)) {
                existingIds.add(rel.animeId);
                queue.push({
                  animeId: rel.animeId,
                  animeTitle: rel.animeTitle,
                  imageUrl: rel.imageUrl,
                  rating: rel.rating || 0,
                });
              }
            }
          }

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
            // 类型统一从 bangumi 详情接口读取，确保相关作品不会错误继承主作品类型
            const resolvedType = details.type || anime.type || "tvseries";
            const resolvedTypeDescription = details.typeDescription || anime.typeDescription || "TV动画";
            // 年份优先使用搜索接口提供的 startDate，相关作品无此字段时降级到第一话的 airDate
            const resolvedStartDate = anime.startDate || (eps.length > 0 ? eps[0].airDate : null);
            const yearStr = resolvedStartDate ? new Date(resolvedStartDate).getFullYear() : '未知';
            let transformedAnime = {
              animeId: anime.animeId,
              bangumiId: String(anime.animeId),
              animeTitle: `${anime.animeTitle}(${yearStr})【${resolvedTypeDescription}】from dandan`,
              aliases: aliases,
              type: resolvedType,
              typeDescription: resolvedTypeDescription,
              imageUrl: anime.imageUrl,
              startDate: resolvedStartDate,
              episodeCount: links.length,
              rating: anime.rating || 0,
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
      }));
    }

    // 按年份排序并推入当前列表
    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
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
