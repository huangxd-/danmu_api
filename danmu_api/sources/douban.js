import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { getDoubanDetail, searchDoubanTitles, searchDoubanTitlesByPublic } from "../utils/douban-util.js";
import { titleMatches, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";

// =====================
// 获取豆瓣源播放链接
// =====================
export default class DoubanSource extends BaseSource {
  constructor(tencentSource, iqiyiSource, youkuSource, bilibiliSource, miguSource) {
    super('BaseSource');
    this.tencentSource = tencentSource;
    this.iqiyiSource = iqiyiSource;
    this.youkuSource = youkuSource;
    this.bilibiliSource = bilibiliSource;
    this.miguSource = miguSource;
  }

  async search(keyword) {
    try {
      let response = await searchDoubanTitles(keyword);
      let data = response?.data;

      // 兜底策略：如果 searchDoubanTitles 失败或返回空结果，使用 searchDoubanTitlesByPublic
      if (!data || (!data?.subjects?.items?.length && !data?.smart_box?.length)) {
        log("info", "searchDoubanTitles failed or empty, trying searchDoubanTitlesByPublic");
        const fallbackResponse = await searchDoubanTitlesByPublic(keyword);
        const fallbackData = fallbackResponse?.data;

        if (fallbackData?.subjects?.length > 0) {
          // 将 searchDoubanTitlesByPublic 返回的数据转换为原格式
          data = {
            subjects: {
              items: fallbackData.subjects.map(item => this.convertToOriginalFormat(item)),
            }
          };
        }
      }

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

  // 将 searchDoubanTitlesByPublic 返回的数据格式转换为原格式
  convertToOriginalFormat(item) {
    // subtype: "movie" -> "电影", "tv" -> "电视剧"
    const typeMap = {
      'movie': '电影',
      'tv': '电视剧'
    };
    const typeName = typeMap[item.subtype] || item.subtype;

    // 构建 cover_url：从原始图片URL中提取图片ID，然后构造固定格式的URL
    const originalImageUrl = item.images?.large || item.images?.medium || item.images?.small || '';
    let coverUrl = '';
    if (originalImageUrl) {
      // 从类似 https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2887095203.jpg 的URL中提取 p2887095203
      const match = originalImageUrl.match(/\/(p\d+)\.jpg/);
      if (match && match[1]) {
        const imageId = match[1]; // 例如 p2887095203
        coverUrl = `https://qnmob3.doubanio.com/view/photo/large/public/${imageId}.jpg?imageView2/0/q/80/w/9999/h/120/format/jpg`;
      }
    }

    // 构建 card_subtitle，包含地区、类型、导演、演员等信息
    const directors = item.directors?.map(d => d.name).join(' ') || '';
    const casts = item.casts?.slice(0, 3).map(c => c.name).join(' ') || '';
    const cardSubtitle = `${item.year} / ${item.genres?.join(' / ') || ''} / ${directors}${casts ? ' / ' + casts : ''}`;

    return {
      layout: 'subject',
      type_name: typeName,
      target_id: String(item.id),
      target: {
        rating: {
          count: item.collect_count || 0,
          max: item.rating?.max || 10,
          star_count: item.rating?.stars ? parseInt(item.rating.stars) / 10 : 0,
          value: item.rating?.average || 0
        },
        controversy_reason: '',
        title: item.title,
        abstract: '',
        has_linewatch: false,
        uri: `douban://douban.com/${item.subtype === 'movie' ? 'movie' : 'tv'}/${item.id}`,
        cover_url: coverUrl,
        year: String(item.year || ''),
        card_subtitle: cardSubtitle,
        id: String(item.id),
        null_rating_reason: ''
      },
      target_type: item.subtype === 'movie' ? 'movie' : 'tv'
    };
  }

  async getEpisodes(id) {}

  /**
   * 处理搜索结果
   * @param {Array} sourceAnimes 原始数据
   * @param {string} queryTitle 关键词
   * @param {Array} curAnimes 结果池
   * @param {Map} detailStore 详情缓存
   * @param {number|null} querySeason 目标季度
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    const doubanAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Douban] sourceAnimes is not a valid array");
      return [];
    }

    // 基础标题与季度匹配过滤
    let filteredAnimes = sourceAnimes.filter(anime => {
      const titleToCheck = anime?.target?.title || "";
      return titleMatches(titleToCheck, queryTitle, querySeason);
    });

    // 提取搜索词中的明确季度信息或使用传入的季度参数
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    // 初始列表预过滤机制：若用户指定了季度，优先检查结果中是否已包含匹配项
    if (resolvedQuerySeason !== null) {
      const seasonFiltered = filteredAnimes.filter(anime => {
        const titleToCheck = anime?.target?.title || "";
        const s = extractSeasonNumberFromAnimeTitle(titleToCheck).season;
        return s === resolvedQuerySeason || (resolvedQuerySeason === 1 && s === null);
      });

      // 如果已命中目标，减少详情请求量
      if (seasonFiltered.length > 0) {
        filteredAnimes = seasonFiltered;
        log("info", `[Douban] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    const processDoubanAnimes = await Promise.allSettled(filteredAnimes.map(async (anime) => {
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
                await this.tencentSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes, detailStore, querySeason)
              }
              break;
            }
            case "iqiyi": {
              const tvid = new URL(vendor.uri).searchParams.get('tvid');
              if (tvid) {
                tmpAnimes[0].provider = "iqiyi";
                tmpAnimes[0].mediaId = anime?.type_name === '电影' ? `movie_${tvid}` : tvid;
                await this.iqiyiSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes, detailStore, querySeason)
              }
              break;
            }
            case "youku": {
              const showId = new URL(vendor.uri).searchParams.get('showid');
              if (showId) {
                tmpAnimes[0].provider = "youku";
                tmpAnimes[0].mediaId = showId;
                await this.youkuSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes, detailStore, querySeason)
              }
              break;
            }
            case "bilibili": {
              const seasonId = new URL(vendor.uri).pathname.split('/').pop();
              if (seasonId) {
                tmpAnimes[0].provider = "bilibili";
                tmpAnimes[0].mediaId = `ss${seasonId}`;
                await this.bilibiliSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes, detailStore, querySeason)
              }
              break;
            }
            case "miguvideo": {
              let epId = null;
              const decodeUrl = decodeURIComponent(vendor.uri);
              const contentIdMatch = decodeUrl.match(/"contentID":"([^"]+)"/);
              if (contentIdMatch && contentIdMatch[1]) {
                epId = contentIdMatch[1];
              }
              if (epId) {
                tmpAnimes[0].provider = "migu";
                tmpAnimes[0].mediaId = `https://v3-sc.miguvideo.com/program/v4/cont/content-info/${epId}/1`;
                await this.miguSource.handleAnimes(tmpAnimes, response.data?.title, doubanAnimes, detailStore, querySeason)
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
