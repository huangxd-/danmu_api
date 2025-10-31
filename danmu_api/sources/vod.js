import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";

// =====================
// 获取vod源播放链接
// =====================
export default class VodSource extends BaseSource {
  // 查询vod站点影片信息
  async getVodAnimes(title, server, serverName) {
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

  // 查询所有vod站点影片信息（返回所有结果）
  async getVodAnimesFromAllServersImpl(title, servers) {
    // 并发查询所有服务器，使用 allSettled 确保单个服务器失败不影响其他服务器
    const promises = servers.map(server =>
      this.getVodAnimes(title, server.url, server.name)
    );

    const results = await Promise.allSettled(promises);

    // 过滤出成功的结果，即使某些服务器失败也不影响其他服务器
    return results
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
  }

  // 查询vod站点影片信息（返回最快的结果）
  async getVodAnimesFromFastestServer(title, servers) {
    if (!servers || servers.length === 0) {
      return [];
    }

    // 使用 Promise.race 获取最快响应的服务器
    const promises = servers.map(server =>
      this.getVodAnimes(title, server.url, server.name)
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

  async search(keyword) {
    if (!globals.vodServers || globals.vodServers.length === 0) {
      return [];
    }

    // 根据 vodReturnMode 决定查询策略
    if (globals.vodReturnMode === "fastest") {
      return await this.getVodAnimesFromFastestServer(keyword, globals.vodServers);
    } else {
      return await this.getVodAnimesFromAllServersImpl(keyword, globals.vodServers);
    }
  }

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, vodName) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[VOD] sourceAnimes is not a valid array");
      return [];
    }

    const processVodAnimes = await Promise.all(sourceAnimes
      .filter(anime => titleMatches(anime.vod_name, queryTitle))
      .map(async (anime) => {
        try {
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
                "name": count.toString(),
                "url": epInfo[1],
                "title": `【${platform}】 ${epInfo[0]}`
              });
            }
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: Number(anime.vod_id),
              bangumiId: String(anime.vod_id),
              animeTitle: `${anime.vod_name}(${anime.vod_year})【${anime.type_name}】from ${vodName}`,
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
        } catch (error) {
          log("error", `[VOD] Error processing anime: ${error.message}`);
        }
      }));

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processVodAnimes;
  }

  async getEpisodeDanmu(id) {}

  formatComments(comments) {}
}