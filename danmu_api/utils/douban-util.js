import { log } from './log-util.js'
import {httpGet, httpPost} from "./http-util.js";

// ---------------------
// 豆瓣 API 工具方法
// ---------------------

// 豆瓣 API GET 请求
async function doubanApiGet(url) {
  const doubanApi = "https://m.douban.com/rexxar/api/v2";

  try {
    const response = await httpGet(`${doubanApi}${url}`, {
      method: 'GET',
      headers: {
        "Referer": "https://m.douban.com/movie/",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    log("error", "[DOUBAN] GET API error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

// 豆瓣 API POST 请求
async function doubanApiPost(url, data={}) {
  const doubanApi = "https://api.douban.com/v2";

  try {
    const response = await httpPost(`${doubanApi}${url}`,
        JSON.stringify({...data, apikey: "0ac44ae016490db2204ce0a042db2916"}), {
      method: 'GET',
      headers: {
        "Referer": "https://api.douban.com",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    log("error", "[DOUBAN] POST API error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

// 使用 豆瓣 API 查询片名
export async function searchDoubanTitles(keyword, count = 20) {
  const url = `/search?q=${keyword}&start=0&count=${count}&type=movie`;
  return await doubanApiGet(url);
}

// 使用 豆瓣 API 查询详情
export async function getDoubanDetail(doubanId) {
  const url = `/movie/${doubanId}?for_mobile=1`;
  return await doubanApiGet(url);
}

// 通过 imdbId 使用 豆瓣 API 查询 doubanInfo
export async function getDoubanInfoByImdbId(imdbId) {
  const url = `/movie/imdb/${imdbId}`;
  return await doubanApiPost(url);
}
