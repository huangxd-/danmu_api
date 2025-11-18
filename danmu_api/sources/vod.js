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
  async getVodAnimesFromFastestServer(title, servers, preferAnimeId = null, preferSource = null) {
    if (!servers || servers.length === 0) {
      return [];
    }

    const promises = servers.map(server =>
      this.getVodAnimes(title, server.url, server.name)
    );

    let fastest;
    try {
      fastest = await Promise.race(promises);  // 最快完成的一个（无论成功还是失败）
    } catch (err) {
      log("error", `[VOD fastest mode] 所有服务器直接抛错`, err);
      return [];
    }

    // 判断整个 result 字符串是否包含 preferAnimeId（大小写不敏感）
    const stringContainsPreferId = (result) => {
      if (!preferAnimeId || preferSource !== "vod") return true;
      const str = JSON.stringify(result)?.toLowerCase() || "";
      return str.includes(String(preferAnimeId).toLowerCase());
    };

    // 1. 最快返回的这个，字符串里包含 preferAnimeId → 直接用（不管有没有 list 数据）
    if (stringContainsPreferId(fastest) && fastest && fastest.list && fastest.list.length > 0) {
      log("info", `[VOD fastest mode] 最快服务器 ${fastest.serverName}${preferSource === "vod" ?
          " 字符串包含 preferAnimeId → 优先使用" : ""}`);
      return [fastest];
    }

    log("info", `[VOD fastest mode] 最快服务器 ${fastest.serverName} 不含 preferAnimeId，等待其他服务器…`);

    // 2. 等待所有请求完成
    const allSettled = await Promise.allSettled(promises);

    // 先遍历所有 fulfilled 的结果，找第一个字符串包含 preferAnimeId 的
    if (preferAnimeId) {
      for (const settled of allSettled) {
        if (settled.status === "fulfilled" && stringContainsPreferId(settled.value) &&
            settled.value && settled.value.list && settled.value.list.length > 0) {
          log("info", `[VOD fastest mode] 找到包含 preferAnimeId 的服务器: ${settled.value.serverName}`);
          return [settled.value];
        }
      }
      log("info", `[VOD fastest mode] 所有服务器都不包含 preferAnimeId，回退到“真正有数据”的最快服务器`);
    }

    // 3. 兜底：没有任何服务器包含 preferAnimeId，或根本没传 preferAnimeId
    //    → 严格保留你原来的判断：必须 result && result.list && result.list.length > 0
    const validResults = allSettled
      .filter(r => r.status === "fulfilled")
      .map(r => r.value)
      .filter(result => result && result.list && result.list.length > 0);  // ← 严格保留这行！

    if (validResults.length > 0) {
      const chosen = validResults[0];  // 完成顺序最快的一个有数据的
      log("info", `[VOD fastest mode] 使用最快有数据的服务器: ${chosen.serverName}`);
      return [chosen];
    }

    log("error", `[VOD fastest mode] 所有服务器均无有效数据`);
    return [];
  }

  async search(keyword, preferAnimeId = null, preferSource = null) {
    if (!globals.vodServers || globals.vodServers.length === 0) {
      return [];
    }

    // 根据 vodReturnMode 决定查询策略
    if (globals.vodReturnMode === "fastest") {
      return await this.getVodAnimesFromFastestServer(keyword, globals.vodServers, preferAnimeId, preferSource);
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
              source: "vod",
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