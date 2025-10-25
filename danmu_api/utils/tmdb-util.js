import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { httpGet } from "./http-util.js";

// ---------------------
// TMDB API 工具方法
// ---------------------

// 使用TMDB API 查询日语原名搜索bahamut相关函数
export async function getTmdbJaOriginalTitle(title) {
  if (!globals.tmdbApiKey) {
    log("info", "[TMDB] 未配置API密钥，跳过TMDB搜索");
    return null;
  }

  try {
    // ---------------------
    // 相似度函数
    // ---------------------
    function similarity(s1, s2) {
      const longer = s1.length > s2.length ? s1 : s2;
      const shorter = s1.length > s2.length ? s2 : s1;
      if (longer.length === 0) return 1.0;

      const editDistance = (s1, s2) => {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();
        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
          let lastValue = i;
          for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
              costs[j] = j;
            } else if (j > 0) {
              let newValue = costs[j - 1];
              if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
              }
              costs[j - 1] = lastValue;
              lastValue = newValue;
            }
          }
          if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
      };

      return (longer.length - editDistance(longer, shorter)) / longer.length;
    }

    // ---------------------
    // 第一步: 中文搜索
    // ---------------------
    const searchUrlZh = `https://api.tmdb.org/3/search/multi?api_key=${globals.tmdbApiKey}&query=${encodeURIComponent(title)}&language=zh-CN`;

    log("info", `[TMDB] 正在搜索(中文): ${title}`);

    const respZh = await httpGet(searchUrlZh, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!respZh || !respZh.data) {
      log("info", "[TMDB] 中文搜索结果为空");
      return null;
    }

    const dataZh = typeof respZh.data === "string" ? JSON.parse(respZh.data) : respZh.data;

    if (!dataZh.results || dataZh.results.length === 0) {
      log("info", "[TMDB] 中文搜索未找到任何结果");
      return null;
    }

    // 找到最相似的结果(使用中文标题)
    let bestMatch = dataZh.results[0];
    let bestScore = 0;

    for (const result of dataZh.results) {
      const resultTitle = result.name || result.title || "";
      const score = similarity(title, resultTitle);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }

    log("info", `[TMDB] 最佳匹配(中文): ${bestMatch.name || bestMatch.title}, 相似度: ${(bestScore * 100).toFixed(2)}%`);

    // ---------------------
    // 第二步: 使用匹配到的ID,用日语语言查询详情页获取原名
    // ---------------------
    const mediaType = bestMatch.media_type || (bestMatch.name ? "tv" : "movie");
    const detailUrl = `https://api.tmdb.org/3/${mediaType}/${bestMatch.id}?api_key=${globals.tmdbApiKey}&language=ja-JP`;

    const detailResp = await httpGet(detailUrl, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!detailResp || !detailResp.data) {
      // 获取详情失败,返回中文搜索结果标题
      const fallbackTitle = bestMatch.name || bestMatch.title;
      log("info", `[TMDB] 使用中文搜索结果标题: ${fallbackTitle}`);
      return fallbackTitle;
    }

    const detail = typeof detailResp.data === "string" ? JSON.parse(detailResp.data) : detailResp.data;

    // 优先使用日语原名 original_name/original_title
    const jaOriginalTitle = detail.original_name || detail.original_title || detail.name || detail.title;
    log("info", `[TMDB] 找到日语原名: ${jaOriginalTitle} (中文匹配相似度: ${(bestScore * 100).toFixed(2)}%)`);

    return jaOriginalTitle;

  } catch (error) {
    log("error", "[TMDB] Search error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}