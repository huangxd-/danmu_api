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
// 获取搜狐视频弹幕
// =====================
export default class SohuSource extends BaseSource {
  constructor() {
    super();
    
    // 弹幕位置映射：
    this.positionMap = {
      1: 1,  // 滚动弹幕
      4: 5,  // 顶部弹幕
      5: 4,  // 底部弹幕
    };
  }

  /**
   * 过滤搜狐视频搜索项
   * @param {Object} item - 搜索项
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  filterSohuSearchItem(item, keyword) {
    if (!item.aid || !item.album_name) {
      return null;
    }

    // 过滤仅预告片结果 通过 is_trailer 字段判断 (1 为预告片)
    if (item.is_trailer === 1) {
      return null;
    }

    // 过滤仅预告片结果 通过角标文字判断 (corner_mark.text 为 "预告")
    if (item.corner_mark && item.corner_mark.text === '预告') {
      return null;
    }

    // 清理标题中的高亮标记
    let title = item.album_name.replace('<<<', '').replace('>>>', '');

    // 从meta中提取类型信息
    // meta格式: ["20集全", "电视剧 | 内地 | 2018年", "主演：..."]
    let categoryName = null;
    if (item.meta && Array.isArray(item.meta)) {
      // 遍历 meta 数组，寻找包含 "|" 的条目 (例如: "电视剧 | 美国 | 2018年")
      for (const metaData of item.meta) {
        if (metaData.txt && metaData.txt.includes('|')) {
          const parts = metaData.txt.split('|');
          if (parts.length > 0) {
            const firstPart = parts[0].trim();
            // 额外处理：如果第一部分是 "别名：XXX"，则取第二部分
            // (例如 "别名：铁面无私包公 | 电影 | ...")
            if (firstPart.includes('别名') && parts.length > 1) {
               categoryName = parts[1].trim();
            } else {
               categoryName = firstPart;
            }
            break; // 找到后立即停止
          }
        }
      }
    }

    return {
      mediaId: String(item.aid),
      title: title,
      type: categoryName,
      year: item.year || null,
      imageUrl: item.ver_big_pic || null,
      episodeCount: item.total_video_count || 0
    };
  }

  async search(keyword) {
    try {
      log("info", `[Sohu] 开始搜索: ${keyword}`);

      // 构造搜索URL
      const params = {
        'key': keyword,
        'type': '1',
        'page': '1',
        'page_size': '20',
        'user_id': '',
        'tabsChosen': '0',
        'poster': '4',
        'tuple': '6',
        'extSource': '1',
        'show_star_detail': '3',
        'pay': '1',
        'hl': '3',
        'uid': String(Math.floor(Date.now() * 1000)),
        'passport': '',
        'plat': '-1',
        'ssl': '0'
      };

      // 设置请求头
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://so.tv.sohu.com/',
        'Origin': 'https://so.tv.sohu.com'
      };

      const searchUrl = `https://m.so.tv.sohu.com/search/pc/keyword?${buildQueryString(params)}`;

      const response = await httpGet(searchUrl, { headers });

      if (!response || !response.data) {
        log("info", "[Sohu] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.items) {
        log("info", "[Sohu] 搜索响应中无数据");
        return [];
      }

      // 过滤和处理搜索结果
      const results = [];
      for (const item of data.data.items) {
        const filtered = this.filterSohuSearchItem(item, keyword);
        if (filtered) {
          results.push(filtered);
        }
      }

      log("info", `[Sohu] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Sohu] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Sohu] 获取分集列表: media_id=${id}`);

      let videosData = null;

      const params = {
        'playlistid': id,
        'api_key': "f351515304020cad28c92f70f002261c"
      };

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://tv.sohu.com/'
      };

      const playlistUrl = `https://pl.hd.sohu.com/videolist?${buildQueryString(params)}`;

      const response = await httpGet(playlistUrl, { headers, timeout: 15000 });

      if (!response || !response.data) {
        log("info", "[Sohu] 分集响应为空");
        return [];
      }

      let data = response.data;

      // 解析JSONP响应
      if (typeof data === "string" && data.startsWith('jsonp')) {
        // 提取括号内的JSON
        const start = data.indexOf('(') + 1;
        const end = data.lastIndexOf(')');
        if (start > 0 && end > start) {
          const jsonStr = data.substring(start, end);
          data = JSON.parse(jsonStr);
        } else {
          log("error", "搜狐视频: 无法解析JSONP响应");
          return [];
        }
      } else if (typeof data === "string") {
        data = JSON.parse(data);
      }

      // 提取视频列表
      videosData = data.videos || [];

      if (!videosData || videosData.length === 0) {
        log("warning", `搜狐视频: 未找到分集列表 (media_id=${id})`);
        return [];
      }

      // 转换为标准格式
      const episodes = [];
      for (let i = 0; i < videosData.length; i++) {
        const video = videosData[i];
        
        let vid, title, url;
        
        // 处理SohuVideo对象或字典
        if (typeof video === 'object') {
          vid = String(video.vid || '');
          title = video.video_name || `第${i+1}集`;
          url = video.url_html5 || '';
        } else {
          vid = String(video.vid || video.vid || '');
          title = video.name || video.video_name || `第${i+1}集`;
          url = video.pageUrl || video.url_html5 || '';
        }

        // 转换为HTTPS
        if (url && url.startsWith('http://')) {
          url = url.replace('http://', 'https://');
        }

        const episode = {
          vid: vid,
          title: title,
          url: url,
          episodeId: `${vid}:${id}`  // vid:aid
        };
        episodes.push(episode);
      }

      log("info", `[Sohu] 成功获取 ${episodes.length} 个分集 (media_id=${id})`);
      return episodes;

    } catch (error) {
      log("error", "[Sohu] 获取分集出错:", error.message);
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Sohu] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processSohuAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          let links = [];

          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const epTitle = ep.title || `第${i + 1}集`;
            // 构建完整URL: https://tv.sohu.com/item/{mediaId}.html
            const fullUrl = `https://tv.sohu.com/item/${anime.mediaId}.html`;
            links.push({
              "name": (i + 1).toString(),
              "url": `${ep.url}`,
              "title": `【sohu】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            // 将字符串mediaId转换为数字ID (使用哈希函数)
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || new Date().getFullYear()})【${anime.type}】from sohu`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year || new Date().getFullYear()),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "sohu",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Sohu] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processSohuAnimes;
  }

  // 提取vid和aid的公共函数
  async extractVidAndAid(id) {
    let vid;
    let aid = '0';

    const resp = await httpGet(id, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    const match = resp.data.match(/vid="(\d+)"/);

    if (match) {
      vid = match[1];
    }

    // 1. 优先从 <input id="aid" ...> 获取
    aid = resp.data.match(/id="aid"[^>]*value=['"](\d+)['"]/)?.[1];
    // 2. 如果没拿到，再从 playlistId="..." 获取
    if (!aid) {
      aid = resp.data.match(/playlistId="(\d+)"/)?.[1];
    }
    
    return { vid, aid };
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求搜狐视频弹幕...", id);

    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 并发请求所有弹幕段，限制并发数量为5
    const MAX_CONCURRENT = 10;
    const allComments = [];
    
    // 将segmentList分批处理，每批最多MAX_CONCURRENT个请求
    for (let i = 0; i < segmentList.length; i += MAX_CONCURRENT) {
      const batch = segmentList.slice(i, i + MAX_CONCURRENT);
      
      // 并发处理当前批次的请求
      const batchPromises = batch.map(segment => this.getDanmuSegment(segment));
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
          } else if (start > 600) {  // 10分钟后无数据可能到末尾
            // 如果某个分段超过10分钟且没有数据，可以提前结束
            // 但需要确保当前批次的所有请求都完成
            break;
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
      log("info", `搜狐视频: 该视频暂无弹幕数据 (vid=${id})`);
      return [];
    }

    printFirst200Chars(allComments);

    return allComments;
  }

  async getDanmuSegment(segment) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Referer': "https://tv.sohu.com/"
      };

      const response = await httpGet(segment.url, { headers, timeout: 10000 });

      if (!response || !response.data) {
        log("error", `搜狐视频: 弹幕段响应为空 (${segment.segment_start}-${segment.segment_end}s)`);
        return [];
      }

      try {
        const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        const comments = data.info?.comments || [];

        if (comments && comments.length > 0) {
          log("info", `搜狐视频: 获取到 ${comments.length} 条弹幕 (${segment.segment_start}-${segment.segment_end}s)`);
        }

        return comments || [];
      } catch (error) {
        log("error", `搜狐视频: 解析弹幕响应失败: ${error.message}`);
        return [];
      }
    } catch (error) {
      log("error", `搜狐视频: 获取弹幕段失败 (vid=${vid}, ${start}-${end}s): ${error.message}`);
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取搜狐视频弹幕分段列表...", id);

    // 解析 episode_id
    const { vid, aid } = await this.extractVidAndAid(id);

    // 搜狐视频的弹幕分段逻辑，使用固定的最大时间
    const maxTime = 10800;
    const segmentDuration = 300; // 300秒一段
    const segments = [];

    for (let start = 0; start < maxTime; start += segmentDuration) {
      const end = start + segmentDuration;
      segments.push({
        "type": "sohu",
        "segment_start": start,
        "segment_end": end,
        "url": `https://api.danmu.tv.sohu.com/dmh5/dmListAll?act=dmlist_v2&vid=${vid}&aid=${aid}&pct=2&time_begin=${start}&time_end=${end}&dct=1&request_from=h5_js`
      });
    }

    return new SegmentListResponse({
      "type": "sohu",
      "segmentList": segments
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        retries: 1,
      });

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const parsedData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        contents.push(...(parsedData.info?.comments || []));
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return [];
    }
  }

  formatComments(comments) {
    return comments.map(comment => {
      try {
        // 解析颜色
        let color = 16777215; // 默认白色
        if (comment.t && comment.t.c) {
          const colorValue = comment.t.c;
          if (typeof colorValue === 'string' && colorValue.startsWith('#')) {
            color = parseInt(colorValue.substring(1), 16);
          } else {
            color = parseInt(String(colorValue), 16);
          }
        }

        // 时间（秒）
        const vtime = comment.v || 0;

        // 时间戳
        const timestamp = Math.floor(parseFloat(comment.created || Date.now() / 1000));

        // 用户ID和弹幕ID
        const uid = comment.uid || '';
        const danmuId = comment.i || '';

        // 弹幕位置映射
        let position = 1; // 默认滚动弹幕
        if (comment.t && comment.t.p) {
          position = this.positionMap[comment.t.p] || 1;
        }

        // 构造p属性：时间,模式,字体大小,颜色,时间戳,池,用户ID,弹幕ID
        const pString = `${vtime},1,25,${color},${timestamp},0,${uid},${danmuId}`;

        return {
          cid: String(danmuId),
          p: pString,
          m: comment.c || '',
          t: parseFloat(vtime),
          like: comment.fcount
        };
      } catch (error) {
        log("error", `格式化弹幕失败: ${error.message}, 弹幕数据:`, comment);
        return null;
      }
    }).filter(comment => comment !== null);
  }
}
