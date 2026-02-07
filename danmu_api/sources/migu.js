import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, httpPost } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { hexToInt } from "../utils/danmu-util.js";
import { generateValidStartDate, time_to_second } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { decrypt } from "../utils/migu-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取咪咕视频弹幕
// =====================
class MiguSource extends BaseSource {
  async search(keyword) {
    try {
      const searchUrl = `https://jadeite.migu.cn/search/v3/open-search`;

      const payload = {
        appVersion: "6.1.1.00",
        ct: 101,
        isCorrectWord: 1,
        k: keyword,
        mediaSource: 9000000,
        packId: "1002581,1002601,1003861,1003862,1003863,1003864,1003865,1003866,1004041,1004121,1004261,1004262,1004281,1004321,1004262,1004281,1004322,1004261,1004421,1004422,1002781,1004301,1004641,1004761,1005061,1005261,1005301,1005321,1005361,1005362,1005341,1005342,1005521,1005722,1005721,1015749,1015761,1015760,1015762,1015763,1015768,1015786,1015790,1015812,1015813,1015814,1015815,1015816,1015817,1015820,1015819,1015821",
        pageIdx: 1,
        pageSize: 20,
        sid: "1X4A395AL3XS3UV5MT8PQ1L5JUYK6KFM8VKDSDD48S5Y7YX5WY1MOUHRT6512988",
        copyrightTerminal: 3,
        searchScene: 2,
        uiVersion: "A3.26.0"
      };

      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Connection": "keep-alive",
        "Content-Type": "application/json",
        "Origin": "https://www.miguvideo.com",
        "Referer": "https://www.miguvideo.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "appId": "miguvideo",
        "sec-ch-ua": 'Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "Windows",
        "terminalId": "www"
      };

      const response = await httpPost(searchUrl, JSON.stringify(payload), {
        headers: headers
      });

      if (!response || !response.data) {
        log("info", "[Migu] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      const contentInfoList = data?.body?.contentInfoList;

      const animes = [];
      contentInfoList.forEach(contentInfo => {
        const shortMediaAsset = contentInfo?.shortMediaAsset;

        if (shortMediaAsset && shortMediaAsset.isLong) {
          let epId;
          if (shortMediaAsset?.extraData) {
            epId = shortMediaAsset?.extraData?.episodes?.[0];
          } else {
            epId = shortMediaAsset?.pID;
          }
          
          animes.push({
            name: shortMediaAsset.name,
            type: shortMediaAsset.contDisplayName,
            year: shortMediaAsset.year.trim(),
            img: shortMediaAsset.h5pics?.highResolutionV,
            url: `https://v3-sc.miguvideo.com/program/v4/cont/content-info/${epId}/1`,
            epsId: epId
          });
        }
      });

      // 正常情况下输出 JSON 字符串
      log("info", `[Migu] 搜索找到 ${animes.length} 个有效结果`);
      return animes;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMiguAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  extractEpId(url) {
    // 先去除 ? 及其后的所有字符
    const baseUrl = url.split('?')[0];
    
    // 分割路径，获取最后一个 / 后的部分（非空）
    const segments = baseUrl.split('/').filter(segment => segment !== '');
    return segments[segments.length - 1] || '';
  }

  async getDetail(id) {
    try {
      const resp = await httpGet(`https://v3-sc.miguvideo.com/program/v4/cont/content-info/${id}/1`, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
        }
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getMiguDetail: 请求失败或无数据返回");
        return { duration: 0, epsID: null };
      }

      const duration = resp.data?.body?.data?.playing?.duration || 0;
      const epsID = resp.data?.body?.data?.epsID || null;

      return { duration, epsID };
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMiguDetail error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return { duration: 0, epsID: null };
    }
  }

  async getEpisodes(id) {
    try {
      const detailResp = await httpGet(id, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
        }
      });

      // 判断 resp 和 resp.data 是否存在
      if (!detailResp || !detailResp.data) {
        log("info", "getMiguEposides: 请求失败或无数据返回");
        return [];
      }

      const eps = detailResp.data?.body?.data?.datas;

      if (eps) {
        return eps;
      } else {
        // datas不存在，找playing/pID
        const name = detailResp.data?.body?.data?.name;
        const pID = detailResp.data?.body?.data?.playing?.pID;
        if (pID) {
          return [{
            name,
            pID 
          }];
        }
        log("info", "getMiguEposides: eps 不存在");
        return [];
      }
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getMiguEposides error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Migu] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processMiguAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.name || s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.url || anime.mediaId);
          let links = [];
          for (const ep of eps) {
            links.push({
              "name": ep.name,
              "url": `https://webapi.miguvideo.com/gateway/live_barrage/videox/barrage/v2/list/${anime.epsId ?? ep.pID}/${ep.pID}`,
              "title": `【migu】 ${ep.name}`
            });
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: convertToAsciiSum(anime.epsId ?? eps[0]?.pID),
              bangumiId: String(anime.epsId ?? eps[0]?.pID),
              animeTitle: `${anime.name || anime.title}(${anime.year})【${anime.type}】from migu`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.img ?? anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "migu",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Migu] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processMiguAnimes;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求咪咕视频弹幕...", id);
    
    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 并发请求所有弹幕段，限制并发数量为50
    const MAX_CONCURRENT = 100;
    const allComments = [];
    
    // 将segmentList分批处理，每批最多MAX_CONCURRENT个请求
    for (let i = 0; i < segmentList.length; i += MAX_CONCURRENT) {
      const batch = segmentList.slice(i, i + MAX_CONCURRENT);
      
      // 并发处理当前批次的请求
      const batchPromises = batch.map(segment => this.getEpisodeSegmentDanmu(segment));
      const batchResults = await Promise.allSettled(batchPromises);
      
      // 处理结果
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const segment = batch[j];
        const start = segment.segment_start;
        const end = segment.segment_end;
        
        if (result.status === 'fulfilled') {
          const comments = result.value;
          
          if (comments && comments.length > 0) {
            allComments.push(...comments);
          }
        } else {
          log("error", `获取弹幕段失败 (${start}-${end}s):`, result.reason.message);
        }
      }
      
      // 批次之间稍作延迟，避免过于频繁的请求
      if (i + MAX_CONCURRENT < segmentList.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (allComments.length === 0) {
      log("info", `咪咕视频: 该视频暂无弹幕数据 (vid=${id})`);
      return [];
    }

    printFirst200Chars(allComments);

    return allComments;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取咪咕视频弹幕分段列表...", id);

    const itemId = this.extractEpId(id);
    const detail = await this.getDetail(itemId);
    const durationSec = time_to_second(detail.duration);
    log("info", "itemId:", itemId);
    log("info", "durationSec:", durationSec);
    log("info", "epsID:", detail.epsID);

    const segmentDuration = 30; // 每个分片30秒钟
    const segmentList = [];

    for (let i = 0; i < durationSec; i += segmentDuration) {
      const segmentStart = i; // 转换为毫秒
      const segmentEnd = Math.min(i + segmentDuration, durationSec); // 不超过总时长

      const danmuUrl = `https://webapi.miguvideo.com/gateway/live_barrage/videox/barrage/v2/list/${detail.epsID ?? itemId}/${itemId}/${segmentStart}/${segmentEnd}/020`;
      
      segmentList.push({
        "type": "migu",
        "segment_start": segmentStart,
        "segment_end": segmentEnd,
        "url": danmuUrl
      });
    }

    return new SegmentListResponse({
      "type": "migu",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
          "appCode": "miguvideo_default_h5"
        },
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const decodeData = await decrypt(response.data);
        const parsedData = typeof response.data === "string" ? JSON.parse(decodeData) : decodeData;
        const danmakuList = parsedData?.body?.result ?? [];
        contents.push(...danmakuList);
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return []; // 返回空数组而不是抛出错误，保持与getEpisodeDanmu一致的行为
    }
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.cid),
      p: `${c.playtime},1,${hexToInt(c.textcolor)},[migu]`,
      m: c.msg,
      t: c.playtime
    }));
  }

}

export default MiguSource;
