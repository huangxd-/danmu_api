import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { getDoubanDetail, searchDoubanTitles } from "../utils/douban-util.js";

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
      const response = await searchDoubanTitles(keyword);

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
        if (anime?.layout !== "subject") return;
        const doubanId = anime.target_id;
        let animeType = anime?.type_name;
        if (animeType !== "电影" && animeType !== "电视剧") return;
        log("info", "doubanId: ", doubanId, anime?.target?.title, animeType);

        // 获取平台详情页面url
        const response = await getDoubanDetail(doubanId);

        const results = [];

        for (const vendor of response.data?.vendors ?? []) {
          if (!vendor) {
            continue;
          }
          log("info", "vendor uri: ", vendor.uri);

          if (response.data?.genres.includes('真人秀')) {
            animeType = "综艺";
          } else if (response.data?.genres.includes('纪录片')) {
            animeType = "纪录片";
          } else if (animeType === "电视剧" && response.data?.genres.includes('动画')
              && response.data?.countries.some(country => country.includes('中国'))) {
            animeType = "国漫";
          } else if (animeType === "电视剧" && response.data?.genres.includes('动画')
              && response.data?.countries.includes('日本')) {
            animeType = "日番";
          } else if (animeType === "电视剧" && response.data?.genres.includes('动画')) {
            animeType = "动漫";
          } else if (animeType === "电影" && response.data?.genres.includes('动画')) {
            animeType = "动画电影";
          } else if (animeType === "电影" && response.data?.countries.some(country => country.includes('中国'))) {
            animeType = "华语电影";
          } else if (animeType === "电影") {
            animeType = "外语电影";
          } else if (animeType === "电视剧" && response.data?.countries.some(country => country.includes('中国'))) {
            animeType = "国产剧";
          } else if (animeType === "电视剧" && response.data?.countries.some(country => ['日本', '韩国'].includes(country))) {
            animeType = "日韩剧";
          } else if (animeType === "电视剧" && response.data?.countries.some(country =>
            ['美国', '英国', '加拿大', '法国', '德国', '意大利', '西班牙', '澳大利亚'].includes(country)
          )) {
            animeType = "欧美剧";
          }

          const tmpAnimes = [{
            title: response.data?.title,
            year: response.data?.year,
            type: animeType,
            imageUrl: anime?.target?.cover_url,
          }];
          switch (vendor.id) {
            case "qq": {
              const cid = new URL(vendor.uri).searchParams.get('cid');
              if (cid) {
                tmpAnimes[0].provider = "tencent";
                tmpAnimes[0].mediaId = cid;
                await this.tencentSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes)
              }
              break;
            }
            case "iqiyi": {
              const tvid = new URL(vendor.uri).searchParams.get('tvid');
              if (tvid) {
                tmpAnimes[0].provider = "iqiyi";
                tmpAnimes[0].mediaId = anime?.type_name === '电影' ? `movie_${tvid}` : tvid;
                await this.iqiyiSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes)
              }
              break;
            }
            case "youku": {
              const showId = new URL(vendor.uri).searchParams.get('showid');
              if (showId) {
                tmpAnimes[0].provider = "youku";
                tmpAnimes[0].mediaId = showId;
                await this.youkuSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes)
              }
              break;
            }
            case "bilibili": {
              const seasonId = new URL(vendor.uri).pathname.split('/').pop();
              if (seasonId) {
                tmpAnimes[0].provider = "bilibili";
                tmpAnimes[0].mediaId = `ss${seasonId}`;
                await this.bilibiliSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes)
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