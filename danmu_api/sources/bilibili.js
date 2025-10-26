import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet} from "../utils/http-util.js";
import { parseDanmakuBase64 } from "../utils/codec-util.js";

// =====================
// 获取b站弹幕
// =====================
export default class BilibiliSource extends BaseSource {
  // 解析 b23.tv 短链接
  async resolveB23Link(shortUrl) {
    try {
      log("info", `正在解析 b23.tv 短链接: ${shortUrl}`);

      // 设置超时时间（默认5秒）
      const timeout = parseInt(globals.vodRequestTimeout);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // 使用原生 fetch 获取重定向后的 URL
      // fetch 默认会自动跟踪重定向，response.url 会是最终的 URL
      const response = await fetch(shortUrl, {
        method: 'GET',
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        signal: controller.signal,
        redirect: 'follow'
      });

      clearTimeout(timeoutId);

      // 获取最终的 URL（重定向后的 URL）
      const finalUrl = response.url;
      if (finalUrl && finalUrl !== shortUrl) {
        log("info", `b23.tv 短链接已解析为: ${finalUrl}`);
        return finalUrl;
      }

      log("error", "无法解析 b23.tv 短链接");
      return shortUrl; // 如果解析失败，返回原 URL
    } catch (error) {
      log("error", "解析 b23.tv 短链接失败:", error);
      return shortUrl; // 如果出错，返回原 URL
    }
  }

  async search(keyword) {}

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {}

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求B站弹幕...", id);

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://api.bilibili.com/x/web-interface/view";
    const api_epid_cid = "https://api.bilibili.com/pgc/view/web/season";

    // 解析 URL 获取必要参数
    // 手动解析 URL（没有 URL 对象的情况下）
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
      path.unshift("");
      log("info", path);
    } else {
      log("error", 'Invalid URL');
      return [];
    }

    let title, danmakuUrl, cid, aid, duration;

    // 普通投稿视频
    if (id.includes("video/")) {
      try {
        // 获取查询字符串部分（从 `?` 开始的部分）
        const queryString = id.split('?')[1];

        // 如果查询字符串存在，则查找参数 p
        let p = 1; // 默认值为 1
        if (queryString) {
            const params = queryString.split('&'); // 按 `&` 分割多个参数
            for (let param of params) {
              const [key, value] = param.split('='); // 分割每个参数的键值对
              if (key === 'p') {
                p = value || 1; // 如果找到 p，使用它的值，否则使用默认值
              }
            }
        }
        log("info", `p: ${p}`);

        let videoInfoUrl;
        if (id.includes("BV")) {
          videoInfoUrl = `${api_video_info}?bvid=${path[2]}`;
        } else {
          aid = path[2].substring(2)
          videoInfoUrl = `${api_video_info}?aid=${path[2].substring(2)}`;
        }

        const res = await httpGet(videoInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取普通投稿视频信息失败:", data.message);
          return [];
        }

        duration = data.data.duration;
        cid = data.data.pages[p - 1].cid;
        danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
      } catch (error) {
        log("error", "请求普通投稿视频信息失败:", error);
        return [];
      }

    // 番剧 - ep格式
    } else if (id.includes("bangumi/") && id.includes("ep")) {
      try {
        const epid = path.slice(-1)[0].slice(2);
        const epInfoUrl = `${api_epid_cid}?ep_id=${epid}`;

        const res = await httpGet(epInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取番剧视频信息失败:", data.message);
          return [];
        }

        for (const episode of data.result.episodes) {
          if (episode.id == epid) {
            title = episode.share_copy;
            cid = episode.cid;
            duration = episode.duration / 1000;
            danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
            break;
          }
        }

        if (!danmakuUrl) {
          log("error", "未找到匹配的番剧集信息");
          return [];
        }

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return [];
      }

    // 番剧 - ss格式
    } else if (id.includes("bangumi/") && inputUrl.includes("ss")) {
      try {
        const ssid = path.slice(-1)[0].slice(2).split('?')[0]; // 移除可能的查询参数
        const ssInfoUrl = `${api_epid_cid}?season_id=${ssid}`;

        log("info", `获取番剧信息: season_id=${ssid}`);

        const res = await httpGet(ssInfoUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
        if (data.code !== 0) {
          log("error", "获取番剧视频信息失败:", data.message);
          return [];
        }

        // 检查是否有episodes数据
        if (!data.result.episodes || data.result.episodes.length === 0) {
          log("error", "番剧没有可用的集数");
          return [];
        }

        // 默认获取第一集的弹幕
        const firstEpisode = data.result.episodes[0];
        title = firstEpisode.share_copy;
        cid = firstEpisode.cid;
        duration = firstEpisode.duration / 1000;
        danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;

        log("info", `使用第一集: ${title}, cid=${cid}`);

      } catch (error) {
        log("error", "请求番剧视频信息失败:", error);
        return [];
      }

    } else {
      log("error", "不支持的B站视频网址，仅支持普通视频(av,bv)、剧集视频(ep,ss)");
      return [];
    }
    log("info", danmakuUrl, cid, aid, duration);

    // 计算视频的分片数量
    const maxLen = Math.floor(duration / 360) + 1;
    log("info", `maxLen: ${maxLen}`);

    const segmentList = [];
    for (let i = 0; i < maxLen; i += 1) {
      let danmakuUrl;
      if (aid) {
        danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${aid}&segment_index=${i + 1}`;
      } else {
        danmakuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${i + 1}`;
      }

      segmentList.push({
        segment_start: i * 360 * 1000,
        segment_end: (i + 1) * 360 * 1000,
        url: danmakuUrl,
      });
    }

    // 使用 Promise.all 并行请求所有分片
    try {
      const allComments = await Promise.all(
        segmentList.map(async (segment) => {
          log("info", "正在请求弹幕数据...", segment.url);
          try {
            // 请求单个分片的弹幕数据
            let res = await httpGet(segment.url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Cookie": globals.bilibliCookie
              },
              base64Data: true,
            });

            return parseDanmakuBase64(res.data);
          } catch (error) {
            log("error", "请求弹幕数据失败: ", error);
            return [];
          }
        })
      );

      // 合并所有分片的弹幕数据
      const mergedComments = allComments.flat();
      return mergedComments;
    } catch (error) {
      log("error", "获取所有弹幕数据时出错: ", error);
      return [];
    }
  }

  formatComments(comments) {
    return comments;
  }
}