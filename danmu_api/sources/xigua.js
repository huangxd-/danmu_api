import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取西瓜视频弹幕
// =====================
class XiguaSource extends BaseSource {
  async search(keyword) {
    try {
      const searchUrl = `https://m.ixigua.com/s/${keyword}`;

      const searchResp = await httpGet(searchUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/17.5 Mobile/15A5370a Safari/602.1"
        }
      });

      const html = searchResp.data;
      const animes = [];

      // 首先提取包含"相关视频"的section (注意:s-long-video-card后面可能还有其他内容)
      const sectionRegex = /<section class="search-section">[\s\S]*?<h2 class="search-section-title">[\s\S]*?相关视频[\s\S]*?<\/h2>[\s\S]*?<div class="s-long-video-card">([\s\S]*?)<\/div><\/div><\/div>/;
      const sectionMatch = html.match(sectionRegex);

      if (sectionMatch) {
        const sectionContent = sectionMatch[1]; // 获取s-long-video-card内的内容
        
        // 使用正则表达式匹配每个视频条目
        const videoRegex = /<div class="s-long-video">[\s\S]*?(?=<div class="s-long-video">|$)/g;
        const videoCards = sectionContent.match(videoRegex) || [];

        videoCards.forEach(card => {
          // 提取URL
          const urlMatch = card.match(/href="(\/video\/\d+)"/);
          const url = urlMatch ? `https://m.ixigua.com${urlMatch[1]}` : '';
          
          // 提取标题
          const titleMatch = card.match(/<h3 class="s-long-video-info-title">[\s\S]*?title="([^"]+)"/);
          const title = titleMatch ? titleMatch[1] : '';

          // 提取图片URL
          const imgMatch = card.match(/<img src="([^"]+)"/);
          let img = imgMatch ? imgMatch[1] : '';
          // 如果图片URL是相对路径,补全为完整URL
          if (img && img.startsWith('//')) {
            img = 'https:' + img;
          }
          // 替换HTML实体 &amp; 为 &
          img = img.replace(/&amp;/g, '&');
          
          // 提取类型和年份 (格式: 电视剧/中国大陆/2006)
          const typeYearMatch = card.match(/<p>([^<]+\/[^<]+\/\d{4})<\/p>/);
          let type = '';
          let year = '';
          
          if (typeYearMatch) {
            const parts = typeYearMatch[1].split('/');
            type = parts[0] || ''; // 电视剧
            year = parts[2] || ''; // 2006
          }
          
          if (url && title) {
            animes.push({
              name: title,
              type: type,
              year: year,
              img: img,
              url: url
            });
          }
        });
      } else {
        log("info", "xiguaSearchresp: 相关视频的section 不存在");
        return [];
      }

      // 正常情况下输出 JSON 字符串
      log("info", `xiguaSearchresp: ${JSON.stringify(animes)}`);
      return animes;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getXiguaAnimes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getDetail(id) {
    try {
      // https://www.douyin.com/lvdetail/6551333775337325060
      // https://m.ixigua.com/video/6551333775337325060
      const itemId = id.split('/').pop();
      const detailUrl = `https://m.ixigua.com/video/${itemId}`;
      
      const resp = await httpGet(detailUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/17.5 Mobile/15A5370a Safari/602.1"
        },
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getXiguaDetail: 请求失败或无数据返回");
        return [];
      }

      const match = resp.data.match(/"duration"\s*:\s*([\d.]+)/);
      return match ? parseFloat(match[1]) : 0;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getXiguaDetail error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      const detailUrl = `https://m.ixigua.com/video/${id}`;

      const detailResp = await httpGet(detailUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/17.5 Mobile/15A5370a Safari/602.1"
        }
      });

      // 判断 resp 和 resp.data 是否存在
      if (!detailResp || !detailResp.data) {
        log("info", "getXiguaEposides: 请求失败或无数据返回");
        return [];
      }

      const episodesMatch = detailResp.data.match(/"episodes_list"\s*:\s*(\[[\s\S]*?\})\s*\]/);

      if (episodesMatch) {
        try {
          // 提取并解析JSON数据
          const episodesJsonStr = episodesMatch[0].replace(/"episodes_list"\s*:\s*/, '');
          const episodes = JSON.parse(episodesJsonStr);
          
          // 生成播放链接列表
          const playlistUrls = episodes.map(ep => ({
            seq_num: ep.seq_num,
            title: ep.title || `第${ep.seq_num}集`,
            url: `https://m.ixigua.com/video/${ep.gid}`,
            gid: ep.gid,
            cover_image_url: ep.cover_image_url
          }));
          
          // 如果需要，可以返回或进一步处理这个列表
          return playlistUrls;
          
        } catch (e) {
          log("error", '解析episodes_list失败:', e);
        }
      } else {
        log("info", "getXiguaEposides: episodes_list 不存在");
        return [];
      }
    } catch (error) {
      // 捕获请求中的错误
      log("error", "getXiguaEposides error:", {
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
      log("error", "[Xigua] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processXiguaAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.name, queryTitle))
      .map(async (anime) => {
        try {
          const albumId = anime.url.split('/').pop();
          const eps = await this.getEpisodes(albumId);
          let links = [];
          for (const ep of eps) {
            const epTitle = ep.title;
            links.push({
              "name": epTitle,
              "url": ep.url,
              "title": `【xigua】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: convertToAsciiSum(albumId),
              bangumiId: String(albumId),
              animeTitle: `${anime.name}(${anime.year})【${anime.type}】from xigua`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.img,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "xigua",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Xigua] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processXiguaAnimes;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求西瓜视频弹幕...", id);
    
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
      log("info", `西瓜视频: 该视频暂无弹幕数据 (vid=${id})`);
      return [];
    }

    printFirst200Chars(allComments);

    return allComments;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取西瓜视频弹幕分段列表...", id);

    const itemId = id.split('/').pop();
    const duration = await this.getDetail(id) * 1000;
    log("info", "itemId:", itemId);
    log("info", "duration:", duration);

    const segmentDuration = 300000; // 每个分片5分钟
    const segmentList = [];

    for (let i = 0; i < duration; i += segmentDuration) {
      const segmentStart = i; // 转换为毫秒
      const segmentEnd = Math.min(i + segmentDuration, duration); // 不超过总时长

      const danmuQueryString = buildQueryString({
        item_id: itemId,
        start_time: segmentStart,
        end_time: segmentEnd,
        format: "json"
      });

      const danmuUrl = `https://ib.snssdk.com/vapp/danmaku/list/v1/?${danmuQueryString}`;
      
      segmentList.push({
        "type": "xigua",
        "segment_start": segmentStart,
        "segment_end": segmentEnd,
        "url": danmuUrl
      });
    }

    return new SegmentListResponse({
      "type": "xigua",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/17.5 Mobile/15A5370a Safari/602.1"
        },
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const parsedData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        const danmakuList = parsedData.data ?? [];
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
      cid: Number(c.danmaku_id),
      p: `${(c.offset_time / 1000).toFixed(2)},1,16777215,[xigua]`,
      m: c.text,
      t: Math.round(c.offset_time / 1000)
    }));
  }

}

export default XiguaSource;
