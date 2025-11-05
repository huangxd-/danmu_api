import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { getDoubanInfoByImdbId } from "../utils/douban-util.js";
import { getTmdbExternalIds, searchTmdbTitles} from "../utils/tmdb-util.js";
import { getImdbepisodes, getImdbSeasons } from "../utils/imdb-util.js";

// =====================
// 获取TMDB源播放链接
// =====================
export default class TmdbSource extends BaseSource {
  constructor(doubanSource) {
    super('BaseSource');
    this.doubanSource = doubanSource;
  }

  async getDoubanIdByTmdbId(mediaType, tmdbId) {
    try {
      const doubanIds = [];

      const response = await getTmdbExternalIds(mediaType, tmdbId);

      const imdbId = response.data?.imdb_id;

      if (!imdbId) return null;

      const seasons = await getImdbSeasons(imdbId);
      const episodes = await getImdbepisodes(imdbId);
      for (const season of seasons.data?.seasons ?? []) {
        let finalImdbId = imdbId;
        if (Number(season.season) !== 1) {
          finalImdbId = episodes.data?.episodes.find((ep) => ep.episodeNumber === 1)?.id ?? "";
        }
        const doubanInfo = await getDoubanInfoByImdbId(finalImdbId);
        const url = doubanInfo.data?.id; // "https://api.douban.com/movie/1299131"
        if (!url) continue;
        const parts = url.split("/"); // ["https:", "", "api.douban.com", "movie", "1299131"]
        const doubanId  = parts.pop(); // 最后一个就是 ID
        const typeName = mediaType === 'movie' ? '电影' : '电视剧';
        if (doubanId) {
          doubanIds.push({
              layout: "subject", target_id: doubanId, type_name: typeName,
              target: { cover_url: doubanInfo.data?.image, title: doubanInfo.data?.alt_title }
          });
        }
      }

      return doubanIds;
    } catch (error) {
      log("error", "getTmdbIds error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async search(keyword) {
    try {
      const response = await searchTmdbTitles(keyword);

      const data = response.data;

      let tmpAnimes = [];

      let tmdbItems = [];
      if (data?.results?.length > 0) {
        tmdbItems = data.results.filter(item => item.name === keyword);
      }

      log("info", `tmdb items.length: ${tmdbItems.length}`);

      for (const tmdbItem of tmdbItems) {
        const doubanIds = await this.getDoubanIdByTmdbId(tmdbItem.media_type, tmdbItem.id);
        tmpAnimes = [...tmpAnimes, ...doubanIds];
      }

      return tmpAnimes;
    } catch (error) {
      log("error", "getTmdbAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, vodName) {
    return this.doubanSource.handleAnimes(sourceAnimes, queryTitle, curAnimes, vodName);
  }

  async getEpisodeDanmu(id) {}

  formatComments(comments) {}
}