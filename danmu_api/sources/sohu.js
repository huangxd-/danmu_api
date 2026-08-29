import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

const SOHU_SEARCH_SECRET = 'vxWaXm3C5SA9&fpc';

// 纯 JavaScript MD5，兼容 Node 与 ForwardWidget 浏览器运行时。
function md5(value) {
  const data = new TextEncoder().encode(String(value));
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) * 64);
  padded.set(data); padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = Array.from({length:64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));
  const rol = (x,n) => (x << n) | (x >>> (32-n));
  for (let off=0; off<padded.length; off+=64) {
    const M = Array.from({length:16}, (_,i) => dv.getUint32(off+i*4,true));
    let A=a0,B=b0,C=c0,D=d0;
    for (let i=0;i<64;i++) {
      let F,g;
      if(i<16){F=(B&C)|((~B)&D);g=i;} else if(i<32){F=(D&B)|((~D)&C);g=(5*i+1)%16;} else if(i<48){F=B^C^D;g=(3*i+5)%16;} else {F=C^(B|(~D));g=(7*i)%16;}
      const t=D; D=C; C=B; B=(B + rol((A+F+K[i]+M[g])|0,s[i]))|0; A=t;
    }
    a0=(a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
  }
  return [a0,b0,c0,d0].map(n => Array.from({length:4},(_,i)=>((n >>> (i*8))&255).toString(16).padStart(2,'0')).join('')).join('');
}

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
    // 搜索接口同时返回专辑项和视频项；视频项可能只有 video_name/vid。
    const mediaId = item.aid || item.vid;
    const albumName = item.album_name || item.video_name;
    if (!mediaId || !albumName) {
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
    let title = String(albumName).replace(/<<<|>>>/g, '');

    // 从meta中提取类型信息
    // meta格式: ["20集全", "电视剧 | 内地 | 2018年", "主演：..."]
    let categoryName = null;
    if (item.meta && Array.isArray(item.meta)) {
      // 遍历 meta 数组，寻找包含 "|" 的条目 (例如: "电视剧 | 美国 | 2018年")
      for (const metaData of item.meta) {
        const metaText = typeof metaData === 'string' ? metaData : metaData?.txt;
        if (metaText && metaText.includes('|')) {
          const parts = metaText.split('|');
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

    const metaYear = Array.isArray(item.meta)
      ? item.meta.map(v => typeof v === 'string' ? v : v?.txt || '').join(' ').match(/((?:19|20)\d{2})年?/)?.[1]
      : null;
    return {
      mediaId: String(mediaId),
      title: title,
      type: categoryName || item.type_name || item.type || '剧集',
      year: item.year || item.year_name || metaYear || null,
      imageUrl: item.ver_big_pic || item.album_pic || item.poster || null,
      episodeCount: item.total_video_count || 0
    };
  }

  async search(keyword) {
    try {
      log("info", `[sohu] 开始搜索: ${keyword}`);

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

      // 搜狐新版接口要求 fpc、timeStamp、code 三个签名参数。
      // fpc 不需要与真实浏览器指纹一致，但 code 必须由同一 fpc 和时间戳计算。
      const fpc = md5(`sohu-${Math.random()}${Date.now()}`);
      const timeStamp = Date.now().toString();
      params.fpc = fpc;
      params.timeStamp = timeStamp;
      params.code = md5(`${timeStamp}${fpc}${SOHU_SEARCH_SECRET}`);

      // 设置请求头
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://tv.sohu.com/',
        'Origin': 'https://tv.sohu.com'
      };

      const searchUrl = `https://m.so.tv.sohu.com/search/pc/keyword?${buildQueryString(params)}`;

      const response = await httpGet(searchUrl, { headers });

      if (!response || !response.data) {
        log("info", "[sohu] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.items) {
        log("info", "[sohu] 搜索响应中无数据");
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

      log("info", `[sohu] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[sohu] 搜索出错:", error.message);
      return [];
    }
  }

  async getPlaylistData(id) {
    const params = {
      'playlistid': id,
      'api_key': "f351515304020cad28c92f70f002261c"
    };

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://tv.sohu.com/'
    };

    const playlistUrl = `https://pl.hd.sohu.com/videolist?${buildQueryString(params)}`;
    // videolist 历史接口常以 GBK 返回中文标题，显式指定编码避免出现“���”。
    const response = await httpGet(playlistUrl, { headers, timeout: 15000, encoding: 'gbk' });

    if (!response || !response.data) {
      return null;
    }

    let data = response.data;
    if (typeof data === "string" && data.startsWith('jsonp')) {
      const start = data.indexOf('(') + 1;
      const end = data.lastIndexOf(')');
      if (start > 0 && end > start) {
        data = JSON.parse(data.substring(start, end));
      } else {
        log("error", "[sohu] 搜狐视频: 无法解析JSONP响应");
        return null;
      }
    } else if (typeof data === "string") {
      data = JSON.parse(data);
    }

    return data;
  }

  async getEpisodes(id) {
    try {
      log("info", `[sohu] 获取分集列表: media_id=${id}`);

      const data = await this.getPlaylistData(id);
      if (!data) {
        log("info", "[sohu] 分集响应为空");
        return [];
      }

      const videosData = data.videos || [];

      if (!videosData || videosData.length === 0) {
        log("warn", `[sohu] 搜狐视频: 未找到分集列表 (media_id=${id})`);
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
          title = video.video_name || video.name || `第${i+1}集`;
          url = video.url_html5 || video.pageUrl || '';
        } else {
          vid = String(video.vid || '');
          title = video.name || video.video_name || `第${i+1}集`;
          url = video.pageUrl || video.url_html5 || '';
        }

        if (!url && vid) {
          url = `https://tv.sohu.com/v/${vid}.html`;
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

      log("info", `[sohu] 成功获取 ${episodes.length} 个分集 (media_id=${id})`);
      return episodes;

    } catch (error) {
      log("error", "[sohu] 获取分集出错:", error.message);
      return [];
    }
  }

  /**
   * 处理搜索结果
   * @param {Array} sourceAnimes 原始数据
   * @param {string} queryTitle 关键词
   * @param {Array} curAnimes 结果池
   * @param {Map|null} detailStore 详情缓存
   * @param {number|null} querySeason 目标季度
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[sohu] sourceAnimes is not a valid array");
      return [];
    }

    // 基础标题与季度匹配过滤
    let filteredAnimes = sourceAnimes.filter(s => titleMatches(s.title, queryTitle, querySeason));

    // 提取搜索词中的明确季度信息或使用传入的季度参数
    const resolvedQuerySeason = querySeason !== null ? querySeason : getExplicitSeasonNumber(queryTitle);

    // 初始列表预过滤机制：若用户指定了季度，优先检查结果中是否已包含匹配项
    if (resolvedQuerySeason !== null) {
      const seasonFiltered = filteredAnimes.filter(anime => {
        const s = extractSeasonNumberFromAnimeTitle(anime.title).season;
        return s === resolvedQuerySeason || (resolvedQuerySeason === 1 && s === null);
      });

      // 如果已命中目标，减少详情请求量
      if (seasonFiltered.length > 0) {
        filteredAnimes = seasonFiltered;
        log("info", `[sohu] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processSohuAnimes = await Promise.all(filteredAnimes.map(async (anime) => {
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

            addAnime({...transformedAnime, links: links}, detailStore);

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[sohu] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processSohuAnimes;
  }

  async getEpisodeDuration(aid, vid) {
    if (!aid) return 0;

    try {
      const data = await this.getPlaylistData(aid);
      const videos = Array.isArray(data?.videos) ? data.videos : [];
      if (!videos.length) return 0;

      const matchedVideo = videos.find(video => String(video?.vid || '') === String(vid || '')) || (videos.length === 1 ? videos[0] : null);
      const duration = Number(matchedVideo?.playLength || 0);
      return Number.isFinite(duration) && duration > 0 ? duration : 0;
    } catch (error) {
      log("warn", `[sohu] 获取真实时长失败: ${error.message}`);
      return 0;
    }
  }

  // 提取vid和aid的公共函数
  async extractVidAndAid(id) {
    let vid;
    let aid = '0';

    if (!id) return { vid, aid };

    // 允许直接传入 vid:aid，或从播放 URL 查询参数中提取，避免不必要的页面请求。
    const rawId = String(id);
    const pair = rawId.match(/(?:^|[/:])([0-9]{4,}):([0-9]+)$/);
    if (pair) return { vid: pair[1], aid: pair[2] };
    try {
      const parsed = new URL(rawId);
      vid = parsed.searchParams.get('vid') || parsed.searchParams.get('videoId') || undefined;
      aid = parsed.searchParams.get('aid') || parsed.searchParams.get('albumId') || aid;
      if (aid === '0') {
        const albumMatch = parsed.pathname.match(/(?:album|playlist|show)[/_-]?(\d+)/i);
        if (albumMatch) aid = albumMatch[1];
      }
      if (vid && aid !== '0') return { vid, aid };
    } catch {
      // id 也可能只是一个页面片段，继续走页面解析逻辑。
    }

    const resp = await httpGet(rawId, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    const html = typeof resp?.data === 'string' ? resp.data : '';
    const match = html.match(/(?:vid|videoId)\s*["']?\s*[:=]\s*["']?(\d+)/i)
      || html.match(/vid="(\d+)"/i);

    if (match) {
      vid = match[1];
    }

    // 1. 优先从 <input id="aid" ...> 获取
    aid = html.match(/id="aid"[^>]*value=['"](\d+)['"]/i)?.[1];
    // 2. 如果没拿到，再从 playlistId="..." 获取
    if (!aid) {
      aid = html.match(/playlistId\s*=\s*["'](\d+)["']/i)?.[1];
    }
    
    return { vid, aid };
  }

  async getEpisodeDanmu(id) {
    log("info", "[sohu] 开始从本地请求搜狐视频弹幕...", id);

    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `[sohu] 弹幕分段数量: ${segmentList.length}`);

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
          log("error", `[sohu] 获取弹幕段失败 (${start}-${end}s):`, result.reason.message);
        }
      }
      
      // 批次之间稍作延迟，避免过于频繁的请求
      if (i + MAX_CONCURRENT < segmentList.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (allComments.length === 0) {
      log("info", `[sohu] 搜狐视频: 该视频暂无弹幕数据 (vid=${id})`);
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
        log("error", `[sohu] 搜狐视频: 弹幕段响应为空 (${segment.segment_start}-${segment.segment_end}s)`);
        return [];
      }

      try {
        const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        const comments = data.info?.comments || [];

        if (comments && comments.length > 0) {
          log("info", `[sohu] 搜狐视频: 获取到 ${comments.length} 条弹幕 (${segment.segment_start}-${segment.segment_end}s)`);
        }

        return comments || [];
      } catch (error) {
        log("error", `[sohu] 搜狐视频: 解析弹幕响应失败: ${error.message}`);
        return [];
      }
    } catch (error) {
      log("error", `[sohu] 搜狐视频: 获取弹幕段失败 (${segment?.segment_start}-${segment?.segment_end}s): ${error.message}`);
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "[sohu] 获取搜狐视频弹幕分段列表...", id);

    // 解析 episode_id
    const { vid, aid } = await this.extractVidAndAid(id);
    if (!vid) {
      log("warn", `[sohu] 无法从视频页面提取 vid: ${id}`);
      return new SegmentListResponse({ type: "sohu", duration: 0, segmentList: [] });
    }

    const duration = await this.getEpisodeDuration(aid, vid);
    const maxTime = duration > 0 ? Math.ceil(duration) : 10800;
    const segmentDuration = 300; // 300秒一段
    const segments = [];

    for (let start = 0; start < maxTime; start += segmentDuration) {
      const end = Math.min(start + segmentDuration, maxTime);
      segments.push({
        "type": "sohu",
        "segment_start": start,
        "segment_end": end,
        "url": `https://api.danmu.tv.sohu.com/dmh5/dmListAll?act=dmlist_v2&vid=${vid}&aid=${aid}&pct=2&time_begin=${start}&time_end=${end}&dct=1&request_from=h5_js`
      });
    }

    return new SegmentListResponse({
      "type": "sohu",
      "duration": duration > 0 ? duration : 0,
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
      log("error", "[sohu] 请求分片弹幕失败:", error);
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
        log("error", `[sohu] 格式化弹幕失败: ${error.message}, 弹幕数据:`, comment);
        return null;
      }
    }).filter(comment => comment !== null);
  }
}
