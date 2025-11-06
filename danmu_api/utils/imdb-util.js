import { log } from './log-util.js'
import { httpGet } from "./http-util.js";

// ---------------------
// IMDB API 工具方法
// ---------------------

// IMDB API 请求
async function imdbApiGet(url) {
  const imdbApi = "https://api.imdbapi.dev";

  try {
    const response = await httpGet(`${imdbApi}${url}`, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    log("error", "[IMDB] API error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

// 使用 IMDB API 查询片名
export async function searchImdbTitles(query, limit = 10) {
  const url = `/search/titles?query=${query}&limit=${limit}`;
  return await imdbApiGet(url);
}

// 使用 IMDB API 查询season
export async function getImdbSeasons(imdbId) {
  const url = `/titles/${imdbId}/seasons`;
  return await imdbApiGet(url);
}

// 使用 IMDB API 查询season
export async function getImdbepisodes(imdbId, season) {
  const url = `/titles/${imdbId}/episodes?season=${season}`;
  return await imdbApiGet(url);
}
