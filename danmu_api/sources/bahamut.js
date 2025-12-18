import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { simplized, traditionalized } from "../utils/zh-util.js";
import { getTmdbJaOriginalTitle } from "../utils/tmdb-util.js";
import { strictTitleMatch, normalizeSpaces } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取巴哈姆特弹幕
// =====================

// 具体搜索部分
export default class BahamutSource extends BaseSource {
  async search(keyword) {
    try {
      // 在函数内部进行简转繁
      const traditionalizedKeyword = traditionalized(keyword);
      const tmdbSearchKeyword = keyword;
      const encodedKeyword = encodeURIComponent(traditionalizedKeyword);
      
      log("info", `[Bahamut] 原始搜索词: ${keyword}`);
      log("info", `[Bahamut] 巴哈使用搜索词: ${traditionalizedKeyword}`);

      // 创建一个 AbortController 用于取消 TMDB 流程
      const tmdbAbortController = new AbortController();

      // 第一次搜索：繁体词搜索
      const originalSearchPromise = (async () => {
        try {
          const targetUrl = `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedKeyword}`;
          const url = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
          
          const originalResp = await httpGet(url, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
            },
          });

          // 如果原始搜索有结果，中断 TMDB 流程
          if (
            originalResp &&
            originalResp.data &&
            originalResp.data.anime &&
            originalResp.data.anime.length > 0
          ) {
            tmdbAbortController.abort(); 
            const anime = originalResp.data.anime;
            for (const a of anime) {
              try {
                a._originalQuery = keyword;
                a._searchUsedTitle = traditionalizedKeyword;
              } catch (e) {}
            }
            log("info", `bahamutSearchresp (original): ${JSON.stringify(anime)}`);
            log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: original)`);
            return { success: true, data: anime, source: 'original' };
          }
          
          log("info", `[Bahamut] 原始搜索成功，但未返回任何结果 (source: original)`);
          return { success: false, source: 'original' };
        } catch (error) {
          // ️捕获原始搜索错误，但不阻塞 TMDB 搜索
          log("error", "[Bahamut] 原始搜索失败:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
          });
          return { success: false, source: 'original' };
        }
      })();

      // 第二次搜索：TMDB转换后搜索（并行执行）
      const tmdbSearchPromise = (async () => {
        try {
          // 延迟100毫秒，避免与原始搜索争抢同一连接池
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // 内部中断检查 (点1)
          if (tmdbAbortController.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          // 如果类型不符合会返回null,自然跳过后续搜索
          const tmdbTitle = await getTmdbJaOriginalTitle(tmdbSearchKeyword, tmdbAbortController.signal);

          // 检查 getTmdbJaOriginalTitle 执行期间是否被中断
          if (tmdbAbortController.signal.aborted) {
            log("info", "[Bahamut] 原始搜索成功，取消TMDB日语原名获取");
            throw new DOMException('Aborted', 'AbortError');
          }

          if (!tmdbTitle) {
            log("info", "[Bahamut] TMDB转换未返回结果，取消日语原名搜索");
            return { success: false, source: 'tmdb' };
          }

          // 内部中断检查 (点2)
          if (tmdbAbortController.signal.aborted) {
            log("info", "[Bahamut] 原始搜索成功，取消日语原名搜索");
            throw new DOMException('Aborted', 'AbortError');
          }

          log("info", `[Bahamut] 使用日语原名进行搜索: ${tmdbTitle}`);
          const encodedTmdbTitle = encodeURIComponent(tmdbTitle);
          const targetUrl = `https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw=${encodedTmdbTitle}`;
          const tmdbSearchUrl = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
          
          const tmdbResp = await httpGet(tmdbSearchUrl, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
            },
          });

          if (tmdbResp && tmdbResp.data && tmdbResp.data.anime && tmdbResp.data.anime.length > 0) {
            const anime = tmdbResp.data.anime;
            for (const a of anime) {
              try {
                a._originalQuery = keyword;
                a._searchUsedTitle = tmdbTitle;
              } catch (e) {}
            }
            log("info", `bahamutSearchresp (TMDB): ${JSON.stringify(anime)}`);
            log("info", `[Bahamut] 返回 ${anime.length} 条结果 (source: tmdb)`);
            return { success: true, data: anime, source: 'tmdb' };
          }
          log("info", `[Bahamut] 日语原名搜索成功，但未返回任何结果 (source: tmdb)`);
          return { success: false, source: 'tmdb' };
        } catch (error) {
          // 捕获被中断的错误
          if (error.name === 'AbortError') {
            log("info", "[Bahamut] 原始搜索成功，中断日语原名搜索");
            return { success: false, source: 'tmdb', aborted: true };
          }
          // 抛出其他错误（例如 httpGet 超时）
          throw error;
        }
      })();

      // 如果两个搜索同时完成，优先采用原始搜索结果
      const [originalResult, tmdbResult] = await Promise.all([
        originalSearchPromise,
        tmdbSearchPromise
      ]);

      // 优先返回原始搜索结果
      if (originalResult.success) {
        return originalResult.data;
      }

      // 原始搜索无结果，返回TMDB搜索结果
      if (tmdbResult.success) {
        return tmdbResult.data;
      }

      log("info", "[Bahamut] 原始搜索和基于TMDB的搜索均未返回任何结果");
      return [];
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getBahamutAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      // 构建剧集信息 URL
      const targetUrl = `https://api.gamer.com.tw/anime/v1/video.php?videoSn=${id}`;
      const url = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
      const resp = await httpGet(url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
        },
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getBahamutEposides: 请求失败或无数据返回");
        return [];
      }

      // 判断 seriesData 是否存在
      if (!resp.data.data || !resp.data.data.video || !resp.data.data.anime) {
        log("info", "getBahamutEposides: video 或 anime 不存在");
        return [];
      }

      // 正常情况下输出 JSON 字符串
      log("info", `getBahamutEposides: ${JSON.stringify(resp.data.data)}`);

      return resp.data.data;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getBahamutEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    queryTitle = traditionalized(queryTitle);

    // 巴哈姆特搜索辅助函数
    function bahamutTitleMatches(itemTitle, queryTitle, searchUsedTitle) {
      if (!itemTitle) return false;

      // 统一输入格式
      const tItem = String(itemTitle);
      const q = String(queryTitle || "");
      const used = String(searchUsedTitle || "");

      // 如果启用严格匹配模式
      if (globals.strictTitleMatch) {
        // 检查原始查询词
        if (strictTitleMatch(tItem, q)) return true;
        if (used && strictTitleMatch(tItem, used)) return true;

        // 尝试繁体/简体互转后的严格匹配
        try {
          if (strictTitleMatch(tItem, traditionalized(q))) return true;
          if (strictTitleMatch(tItem, simplized(q))) return true;
          if (used) {
            if (strictTitleMatch(tItem, traditionalized(used))) return true;
            if (strictTitleMatch(tItem, simplized(used))) return true;
          }
        } catch (e) {
          // 转换过程中可能会因为异常输入而抛错；忽略继续
        }

        return false;
      }

      // 宽松模糊匹配模式（默认）
      // 规范化空格后进行直接包含检查
      const normalizedItem = normalizeSpaces(tItem);
      const normalizedQ = normalizeSpaces(q);
      const normalizedUsed = used ? normalizeSpaces(used) : '';

      if (normalizedItem.includes(normalizedQ)) return true;
      if (normalizedUsed && normalizedItem.includes(normalizedUsed)) return true;

      // 尝试繁体/简体互转（双向匹配）
      try {
        if (normalizedItem.includes(normalizeSpaces(traditionalized(q)))) return true;
        if (normalizedItem.includes(normalizeSpaces(simplized(q)))) return true;
        if (normalizedUsed) {
          if (normalizedItem.includes(normalizeSpaces(traditionalized(used)))) return true;
          if (normalizedItem.includes(normalizeSpaces(simplized(used)))) return true;
        }
      } catch (e) {
        // 转换过程中可能会因为异常输入而抛错；忽略继续
      }

      // 尝试不区分大小写的拉丁字母匹配
      try {
        if (normalizedItem.toLowerCase().includes(normalizedQ.toLowerCase())) return true;
        if (normalizedUsed && normalizedItem.toLowerCase().includes(normalizedUsed.toLowerCase())) return true;
      } catch (e) { }

      return false;
    }

    // 安全措施:确保一定是数组类型
    const arr = Array.isArray(sourceAnimes) ? sourceAnimes : [];

    // 使用稳健匹配器过滤项目,同时利用之前注入的 _searchUsedTitle 字段
    const filtered = arr.filter(item => {
      const itemTitle = item.title || "";
      const usedSearchTitle = item._searchUsedTitle || item._originalQuery || "";

      // 如果有 _searchUsedTitle 字段(表示是TMDB搜索结果),则跳过标题匹配,直接保留
      if (item._searchUsedTitle && item._searchUsedTitle !== queryTitle) {
        log("info", `[Bahamut] TMDB结果直接保留: ${itemTitle}`);
        return true;
      }

      return bahamutTitleMatches(itemTitle, queryTitle, usedSearchTitle);
    });

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processBahamutAnimes = await Promise.all(filtered.map(async (anime) => {
      try {
        const epData = await this.getEpisodes(anime.video_sn);
        const detail = epData.video;

        // 处理 episodes 对象中的多个键（"0", "1", "2" 等）
        // 某些内容（如电影）可能在不同的键中
        let eps = null;
        if (epData.anime.episodes) {
          // 优先使用 "0" 键，如果不存在则使用第一个可用的键
          eps = epData.anime.episodes["0"] || Object.values(epData.anime.episodes)[0];
        }

        let links = [];
        if (eps && Array.isArray(eps)) {
          for (const ep of eps) {
            const epTitle = `第${ep.episode}集`;
            links.push({
              "name": ep.episode.toString(),
              "url": ep.videoSn.toString(),
              "title": `【bahamut】 ${epTitle}`
            });
          }
        }

        if (links.length > 0) {
          let yearMatch = (anime.info || "").match(/(\d{4})/);
          let transformedAnime = {
            animeId: anime.video_sn,
            bangumiId: String(anime.video_sn),
            animeTitle: `${simplized(anime.title)}(${(anime.info.match(/(\d{4})/) || [null])[0]})【动漫】from bahamut`,
            type: "动漫",
            typeDescription: "动漫",
            imageUrl: anime.cover,
            startDate: generateValidStartDate(new Date(epData.anime.seasonStart).getFullYear()),
            episodeCount: links.length,
            rating: detail.rating,
            isFavorited: true,
            source: "bahamut",
          };

          tmpAnimes.push(transformedAnime);

          addAnime({...transformedAnime, links: links});

          if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
        }
      } catch (error) {
        log("error", `[Bahamut] Error processing anime: ${error.message}`);
      }
    }));

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processBahamutAnimes;
  }

  async getEpisodeDanmu(id) {
    let danmus = [];

    try {
      // 构建弹幕 URL
      const targetUrl = `https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn=${id}`;
      const url = globals.proxyUrl ? `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
      const resp = await httpGet(url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Anime/2.29.2 (7N5749MM3F.tw.com.gamer.anime; build:972; iOS 26.0.0) Alamofire/5.6.4",
        },
        retries: 1,
      });

      // 将当前请求的 episodes 拼接到总数组
      if (resp.data && resp.data.data && resp.data.data.danmu) {
        danmus = resp.data.data.danmu;
      }

      return danmus;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "fetchBahamutEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return danmus; // 返回已收集的 episodes
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取巴哈姆特弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "bahamut",
      "segmentList": [{
        "type": "bahamut",
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
    const positionToMode = { 0: 1, 1: 5, 2: 4 };
    return comments.map(c => ({
      cid: Number(c.sn),
      p: `${Math.round(c.time / 10).toFixed(2)},${positionToMode[c.position] || c.tp},${parseInt(c.color.slice(1), 16)},[bahamut]`,
      // 根据 globals.danmuSimplified 控制是否繁转简
      m: globals.danmuSimplified ? simplized(c.text) : c.text,
      t: Math.round(c.time / 10)
    }));
  }
}
