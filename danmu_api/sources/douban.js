import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";

// =====================
// 获取豆瓣源播放链接
// =====================
export default class DoubanSource extends BaseSource {
  constructor(tencentSource, iqiyiSource, youkuSource, bilibiliSource) {
    super('BaseSource');
    this.tencentSource = tencentSource;
    this.iqiyiSource = iqiyiSource;
    this.youkuSource = youkuSource;
    this.bilibiliSource = bilibiliSource;
  }

  async search(keyword) {
    try {
      const response = await httpGet(
        `https://m.douban.com/rexxar/api/v2/search?q=${keyword}&start=0&count=20&type=movie`,
        {
          headers: {
            "Referer": "https://m.douban.com/movie/",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        }
      );

      const data = response.data;

      let tmpAnimes = [];
      if (data?.subjects?.items?.length > 0) {
        tmpAnimes = [...tmpAnimes, ...data.subjects.items];
      }

      if (data?.smart_box?.length > 0) {
        tmpAnimes = [...tmpAnimes, ...data.smart_box];
      }

      log("info", `douban animes.length: ${tmpAnimes.length}`);

      return tmpAnimes;
    } catch (error) {
      log("error", "getDoubanAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, vodName) {
    const doubanAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Douban] sourceAnimes is not a valid array");
      return [];
    }

    const processDoubanAnimes = await Promise.allSettled(sourceAnimes.map(async (anime) => {
      try {
        const doubanId = anime.target_id;
        log("info", "doubanId: ", doubanId);

        // 获取平台详情页面url
        const response = await httpGet(
          `https://m.douban.com/rexxar/api/v2/movie/${doubanId}?for_mobile=1`,
          {
            headers: {
              "Referer": `https://m.douban.com/movie/subject/${doubanId}/?dt_dapp=1`,
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
          }
        );

        const results = [];

        for (const vendor of response.data?.vendors ?? []) {
          if (!vendor) {
            continue;
          }
          log("info", "vendor uri: ", vendor.uri);
          const tmpAnimes = [{
            title: response.data?.title,
            year: response.data?.year,
            type: anime?.type_name,
            imageUrl: anime?.target?.cover_url,
          }];
          switch (vendor.id) {
            case "qq": {
              const cid = new URL(vendor.uri).searchParams.get('cid');
              if (cid) {
                tmpAnimes[0].provider = "tencent";
                tmpAnimes[0].mediaId = cid;
                await this.tencentSource.handleAnimes(tmpAnimes, queryTitle, doubanAnimes)
              }
              break;
            }
            case "iqiyi": {
              const tvid = new URL(vendor.uri).searchParams.get('tvid');
              if (tvid) {
                tmpAnimes[0].provider = "iqiyi";
                tmpAnimes[0].mediaId = anime?.type_name === '电影' ? `movie_${tvid}` : tvid;
                await this.iqiyiSource.handleAnimes(tmpAnimes, queryTitle, doubanAnimes)
              }
              break;
            }
            case "youku": {
              const showId = new URL(vendor.uri).searchParams.get('showid');
              if (showId) {
                tmpAnimes[0].provider = "youku";
                tmpAnimes[0].mediaId = showId;
                await this.youkuSource.handleAnimes(tmpAnimes, queryTitle, doubanAnimes)
              }
              break;
            }
            case "bilibili": {
              const seasonId = new URL(vendor.uri).pathname.split('/').pop();
              if (seasonId) {
                tmpAnimes[0].provider = "bilibili";
                tmpAnimes[0].mediaId = `ss${seasonId}`;
                await this.bilibiliSource.handleAnimes(tmpAnimes, queryTitle, doubanAnimes)
              }
              break;
            }
          }
        }
        return results;
      } catch (error) {
        log("error", `[Douban] Error processing anime: ${error.message}`);
        return [];
      }
    }));

    this.sortAndPushAnimesByYear(doubanAnimes, curAnimes);
    return processDoubanAnimes;
  }

  async getEpisodeDanmu(id) {}

  formatComments(comments) {}
}