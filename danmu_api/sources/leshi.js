import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// 媒体类型映射
const typeMap = {
  'tv': '电视剧',
  'movie': '电影',
  'cartoon': '动漫',
  'comic': '动漫'
};

// =====================
// 获取乐视网弹幕
// =====================
export default class LeshiSource extends BaseSource {
  constructor() {
    super();
    
    // 弹幕位置映射：
    this.positionMap = {
      4: 1,  // 滚动弹幕
      3: 4,  // 底部弹幕
      1: 5,  // 顶部弹幕
      2: 1,  // 其他 -> 滚动
    };
  }

  /**
   * 过滤乐视网搜索项
   * @param {Object} item - 搜索项
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  filterLeshiSearchItem(item, keyword) {
    if (!item.pid || !item.title) {
      return null;
    }

    // 清理标题中的高亮标记
    let title = item.title;

    // 映射类型
    const resultType = typeMap[item.type] || '电视剧';

    return {
      mediaId: String(item.pid),
      title: title,
      type: resultType,
      year: item.year || null,
      imageUrl: item.imageUrl || null,
      episodeCount: item.episodeCount || 0
    };
  }

  async search(keyword) {
    try {
      log("info", `[Leshi] 开始搜索: ${keyword}`);

      // 构造搜索URL
      const params = {
        'wd': keyword,
        'from': 'pc',
        'ref': 'click',
        'click_area': 'search_button',
        'query': keyword,
        'is_default_query': '0',
        'module': 'search_rst_page'
      };

      // 设置请求头，模拟浏览器
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://so.le.com/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
      };

      const searchUrl = `https://so.le.com/s?${buildQueryString(params)}`;

      const response = await httpGet(searchUrl, { headers, timeout: 15000 });

      if (!response || !response.data) {
        log("info", "[Leshi] 搜索响应为空");
        return [];
      }

      const htmlContent = response.data;

      log("debug", `[Leshi] 搜索请求成功，响应长度: ${htmlContent.length} 字符`);

      // 解析HTML，提取data-info属性
      const results = [];

      // 使用正则表达式提取所有 data-info 属性
      // 格式：data-info="{pid:'10026580',type:'tv',...}"
      const pattern = /<div class="So-detail[^"]*"[^>]*data-info="({.*?})"[^>]*>/g;
      let match;
      const matches = [];

      while ((match = pattern.exec(htmlContent)) !== null) {
        matches.push(match);
      }

      log("debug", `[Leshi] 从HTML中找到 ${matches.length} 个 data-info 块`);

      for (const match of matches) {
        try {
          let dataInfoStr = match[1];

          log("debug", `[Leshi] 提取到 data-info 原始字符串: ${dataInfoStr.substring(0, 200)}...`);

          // 解析JavaScript对象字面量为JSON
          // 1. 先将所有单引号替换为双引号
          dataInfoStr = dataInfoStr.replace(/'/g, '"');
          // 2. 然后为没有引号的键添加引号
          dataInfoStr = dataInfoStr.replace(/([{,])(\w+):/g, '$1"$2":');

          const dataInfo = JSON.parse(dataInfoStr);

          log("debug", `[Leshi] 成功解析 data-info，pid=${dataInfo.pid}, type=${dataInfo.type}`);

          // 提取基本信息
          let pid = dataInfo.pid || '';
          const mediaTypeStr = dataInfo.type || '';
          const total = dataInfo.total || '0';

          if (!pid) {
            continue;
          }

          // 从HTML中提取标题和其他信息
          const start_pos = match.index;
          // 查找结束标签，尝试多种可能的结束模式
          const endPatterns = ['</div>\n\t</div>', '</div>\n</div>', '</div></div>'];
          let end_pos = -1;
          for (const endPattern of endPatterns) {
            const pos = htmlContent.indexOf(endPattern, start_pos);
            if (pos !== -1) {
              end_pos = pos;
              break;
            }
          }

          if (end_pos === -1) {
            // 如果找不到结束标签，尝试查找下一个 So-detail
            const nextMatch = htmlContent.indexOf('<div class="So-detail', start_pos + 100);
            if (nextMatch !== -1) {
              end_pos = nextMatch;
            } else {
              continue;
            }
          }

          const htmlBlock = htmlContent.substring(start_pos, end_pos);

          // 提取标题 - 多种方式尝试获取标题
          let title = '';
          
          // 方法1: 尝试从 h1 标签中的链接提取
          const h1TitleMatch = /<h1>[\s\S]*?<a[^>]*title="([^"]*)"[^>]*>/.exec(htmlBlock);
          if (h1TitleMatch && h1TitleMatch[1]) {
            title = h1TitleMatch[1].trim();
          }
          
          // 方法2: 如果 h1 中没有找到，则尝试从 data-info 的 keyWord 字段提取
          if (!title && dataInfo.keyWord) {
            // 从关键词中提取主要标题部分（去掉年份等信息）
            const keywordMatch = /(.*?)(?:\d{4})?(?:电影|电视剧|综艺)?$/.exec(dataInfo.keyWord);
            if (keywordMatch && keywordMatch[1]) {
              title = keywordMatch[1].replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').trim(); // 移除特殊字符
            }
          }
          
          // 方法3: 尝试从链接的 title 属性中提取
          if (!title) {
            const linkTitleMatch = /<a[^>]*title="([^"]*?)[^0-9\u4e00-\u9fa5][^"]*"/.exec(htmlBlock);
            if (linkTitleMatch && linkTitleMatch[1]) {
              title = linkTitleMatch[1].trim();
            }
          }
          
          if (!title) {
            log("info", `[Leshi] 未找到标题，尝试从其他来源获取`);
          }

          // 提取海报
          const imgMatch = /<img[^>]*(?:src|data-src|alt)="([^"]+)"/.exec(htmlBlock);
          let imageUrl = imgMatch ? imgMatch[1] : '';

          // 提取年份 - 支持多种格式
          let year = null;
          // 方法1: 从年份标签中提取 <b>年份：</b><a...>2016</a>
          let yearMatch = /<b>年份：<\/b>.*?>(\d{4})<\/a>/.exec(htmlBlock);
          if (!yearMatch) {
            // 方法2: 从上映时间标签中提取
            yearMatch = /<b>上映时间：<\/b>.*?>(\d{4})<\/a>/.exec(htmlBlock);
          }
          if (!yearMatch) {
            // 方法3: 从年份链接的href中提取 (y2016)
            yearMatch = /_y(\d{4})_/.exec(htmlBlock);
          }
          if (!yearMatch) {
            // 方法4: 从 data-info 的 keyWord 中提取
            yearMatch = /(\d{4})/.exec(dataInfo.keyWord || '');
          }

          if (yearMatch) {
            year = parseInt(yearMatch[1]);
          }

          // 映射媒体类型
          const resultType = typeMap[mediaTypeStr] || '电视剧';

          // 解析集数
          const episodeCount = total && /^\d+$/.test(total) ? parseInt(total) : 0;

          // 创建搜索结果
          const result = {
            mediaId: pid,
            title: title,
            type: resultType,
            year: year,
            imageUrl: imageUrl && imageUrl.startsWith('http') ? imageUrl : imageUrl ? `https:${imageUrl}` : null,
            episodeCount: episodeCount
          };

          results.push(result);
          log("debug", `[Leshi] 解析成功 - ${title} (pid=${pid}, type=${resultType}, episodes=${episodeCount})`);

        } catch (e) {
          log("warning", `[Leshi] 解析搜索结果项失败: ${e}`);
          continue;
        }
      }

      if (results.length > 0) {
        log("info", `[Leshi] 网络搜索 '${keyword}' 完成，找到 ${results.length} 个有效结果。`);
        log("info", `[Leshi] 搜索结果列表:`);
        for (const r of results) {
          log("info", `  - ${r.title} (ID: ${r.mediaId}, 类型: ${r.type}, 年份: ${r.year})`);
        }
      } else {
        log("info", `[Leshi] 网络搜索 '${keyword}' 完成，找到 0 个结果。`);
      }

      return results;

    } catch (error) {
      log("error", "[Leshi] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Leshi] 获取分集列表: media_id=${id}`);

      // 构造作品页面URL（需要根据类型判断）
      const urlsToTry = [
        `https://www.le.com/tv/${id}.html`,
        `https://www.le.com/comic/${id}.html`,
        `https://www.le.com/playlet/${id}.html`,
        `https://www.le.com/movie/${id}.html`
      ];

      let htmlContent = null;
      for (const url of urlsToTry) {
        try {
          const response = await httpGet(url, { timeout: 10000 });
          if (response && response.data && response.status === 200) {
            htmlContent = response.data;
            log("debug", `成功获取页面: ${url}`);
            break;
          }
        } catch (e) {
          log("debug", `尝试URL失败 ${url}: ${e}`);
          continue;
        }
      }

      if (!htmlContent) {
        log("error", `无法获取作品页面: media_id=${id}`);
        return [];
      }

      // 尝试新的解析方式：直接从HTML中解析剧集列表
      // 查找剧集列表容器，根据提供的HTML示例
      
      // 首先尝试匹配图文选集和数字选集两种模式
      const twxjContainerMatch = /<div class="show_cnt twxj-[^"]*">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(htmlContent);
      
      if (twxjContainerMatch) {
        log("debug", `找到图文选集容器`);
        return this.parseEpisodesFromHtml(twxjContainerMatch[0], id);
      }
      
      // 如果没有找到图文选集，尝试数字选集
      const sjxjContainerMatch = /<div class="show_cnt sjxj-[^"]*">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(htmlContent);
      
      if (sjxjContainerMatch) {
        log("debug", `找到数字选集容器`);
        return this.parseEpisodesFromHtml(sjxjContainerMatch[0], id);
      }
      
      // 如果以上都没找到，尝试查找整个剧集区域
      log("debug", `未找到特定选集容器，尝试查找第一集视频列表...`);
      
      const firstVideoListMatch = /<div class="show_play first_videolist[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(htmlContent);
      if (firstVideoListMatch) {
        // 在这个范围内查找所有可能的剧集容器
        const containerHtml = firstVideoListMatch[0];
        return this.parseEpisodesFromHtml(containerHtml, id);
      }
      
      log("error", `无法找到剧集列表容器: media_id=${id}`);
      
      // 从htmlContent直接匹配查找 https://www.le.com/ptv/vplay/77917395.html 形式的链接
      const regex = /https:\/\/www\.le\.com\/ptv\/vplay\/(\d+)\.html/g;
      const matches = htmlContent.matchAll(regex);
      const episodes = [];
      
      for (const match of matches) {
        const videoId = match[1];
        const url = match[0];
        
        // 创建剧集对象
        const episode = {
          vid: videoId,
          title: `第${episodes.length + 1}集`,
          url: url,
          episodeId: `${videoId}:${id}`  // vid:aid
        };
        
        episodes.push(episode);
      }
      
      if (episodes.length > 0) {
        log("info", `[Leshi] 从HTML内容中匹配到 ${episodes.length} 个剧集链接`);
        return episodes;
      }
      
      return [];

    } catch (error) {
      log("error", "[Leshi] 获取分集出错:", error.message);
      return [];
    }
  }

  parseEpisodesFromHtml(htmlContent, mediaId) {
    try {
      // 根据提供的HTML结构，首先查找所有包含剧集的div.col_4元素
      // 每个div.col_4包含一个dl.dl_temp剧集元素
      const episodeContainerRegex = /<div class="col_4"[^>]*>[\s\S]*?<\/div>/g;
      const containerMatches = htmlContent.match(episodeContainerRegex);
      
      if (!containerMatches || containerMatches.length === 0) {
        log("debug", `在HTML中未找到剧集容器div.col_4，尝试查找dl.dl_temp元素`);
        // 如果没找到div.col_4，直接查找dl.dl_temp
        const episodeRegex = /<dl class="dl_temp">[\s\S]*?<\/dl>/g;
        const matches = htmlContent.match(episodeRegex);
        
        if (!matches || matches.length === 0) {
          log("debug", `在HTML中未找到剧集元素，尝试更广泛的选择器`);
          // 尝试更广泛的匹配
          const broaderRegex = /<dl[^>]*class="[^"]*dl_temp[^"]*"[^>]*>[\s\S]*?<\/dl>/g;
          const broaderMatches = htmlContent.match(broaderRegex);
          
          if (!broaderMatches || broaderMatches.length === 0) {
            log("error", `无法从HTML中解析到任何剧集: media_id=${mediaId}`);
            return [];
          }
          
          return this.extractEpisodes(broaderMatches, mediaId);
        }
        
        return this.extractEpisodes(matches, mediaId);
      }
      
      // 从每个div.col_4中提取内部的dl.dl_temp元素
      const dlElements = [];
      for (const container of containerMatches) {
        const dlMatch = /<dl class="dl_temp">[\s\S]*?<\/dl>/.exec(container);
        if (dlMatch) {
          dlElements.push(dlMatch[0]);
        }
      }
      
      if (dlElements.length === 0) {
        log("error", `从容器中未能提取到任何dl.dl_temp元素: media_id=${mediaId}`);
        return [];
      }
      
      return this.extractEpisodes(dlElements, mediaId);
    } catch (error) {
      log("error", `[Leshi] 解析剧集HTML失败: ${error.message}`);
      return [];
    }
  }

  extractEpisodes(episodeElements, mediaId) {
    const episodes = [];
    
    for (const element of episodeElements) {
      try {
        // 提取链接 - 优先匹配 vplay 链接
        const linkMatch = /<a[^>]+href="(\/\/www\.le\.com\/ptv\/vplay\/(\d+)\.html)"[^>]*>/.exec(element);
        if (!linkMatch) {
          log("debug", `跳过无法解析链接的剧集元素`);
          continue;
        }
        
        const fullUrl = linkMatch[1];
        const videoId = linkMatch[2];
        const absoluteUrl = `https:${fullUrl}`;
        
        // 提取标题 - 更精确的匹配
        let title = '';
        
        // 优先从 dt.d_tit 中获取标题
        const titleMatch = /<dt class="d_tit">[\s\n\r]*<a[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(element);
        if (titleMatch && titleMatch[1]) {
          title = titleMatch[1].trim(); // 使用title属性
        } else if (titleMatch && titleMatch[2]) {
          title = titleMatch[2].trim(); // 使用链接文本
        } else {
          // 如果dt.d_tit中没有找到，尝试其他方式
          const altTitleMatch = /<a[^>]*title="([^"]*)"[^>]*>[\s\S]*?<dt class="d_tit">/.exec(element) ||
                               /<dt class="d_tit">[\s\S]*?<a[^>]*title="([^"]*)"/.exec(element);
          if (altTitleMatch && altTitleMatch[1]) {
            title = altTitleMatch[1].trim();
          } else {
            // 再尝试从dd.d_cnt中获取
            const ddMatch = /<dd class="d_cnt"[^>]*>([^<]*)/.exec(element);
            if (ddMatch && ddMatch[1]) {
              title = ddMatch[1].trim();
            } else {
              // 最后尝试从链接本身获取文本
              const linkTextMatch = /<a[^>]*title="[^"]*"[^>]*>([^<]*)/.exec(element);
              if (linkTextMatch && linkTextMatch[1]) {
                title = linkTextMatch[1].trim();
              }
            }
          }
        }
        
        // 如果仍然没有标题，尝试从剧集编号获取
        if (!title) {
          const episodeNumMatch = /第(\d+)集|(\d+)(?:\s*预告)?/.exec(element);
          if (episodeNumMatch) {
            const num = episodeNumMatch[1] || episodeNumMatch[2];
            title = `第${num}集`;
          } else {
            title = `第${episodes.length + 1}集`;
          }
        }
        
        // 过滤掉预告片或其他非正常剧集（可选）
        const isPreview = /预告|Preview|preview/.test(title);
        if (isPreview) {
          log("debug", `跳过预告片: ${title}`);
          continue;
        }
        
        const episode = {
          vid: videoId,
          title: title,
          url: absoluteUrl,
          episodeId: `${videoId}:${mediaId}`  // vid:aid
        };
        
        episodes.push(episode);
        
      } catch (e) {
        log("warning", `[Leshi] 解析单个剧集失败: ${e.message}`);
        continue;
      }
    }
    
    log("info", `[Leshi] 成功解析剧集列表: media_id=${mediaId}, 共 ${episodes.length} 集`);
    return episodes;
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Leshi] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processLeshiAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          let links = [];

          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const epTitle = ep.title || `第${i + 1}集`;
            links.push({
              "name": (i + 1).toString(),
              "url": `${ep.url}`,
              "title": `【leshi】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            // 将字符串mediaId转换为数字ID (使用哈希函数)
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || new Date().getFullYear()})【${anime.type}】from leshi`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year || new Date().getFullYear()),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "leshi",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Leshi] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processLeshiAnimes;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求乐视网弹幕...", id);

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
          } else if (start > 600) { // 10分钟后无数据可能到末尾
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
      log("info", `乐视网: 该视频暂无弹幕数据 (vid=${id})`);
      return [];
    }

    printFirst200Chars(allComments);

    return allComments;
  }

  async getDanmuSegment(segment) {
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
        const data = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        
        // 解析JSONP响应
        const jsonMatch = /vjs_\d+\((.*)\)/.exec(data);
        if (jsonMatch) {
          const jsonData = JSON.parse(jsonMatch[1]);
          if (jsonData.code === 200 && jsonData.data) {
            contents.push(...(jsonData.data.list || []));
          }
        }
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取乐视网弹幕分段列表...", id);

    // 从ID中提取video_id
    let videoId = id;
    const match = id.match(/\/vplay\/(\d+)\.html/);
    if (match) {
      videoId = match[1];
    }

    // 获取视频时长
    const duration = await this.getVideoDuration(videoId);

    // 计算需要请求的时间段（每段5分钟）
    const segments = [];
    for (let i = 0; i < Math.ceil(duration / 300); i++) {
      const startTime = i * 300;
      const endTime = Math.min((i + 1) * 300, duration);
      segments.push({
        "type": "leshi",
        "segment_start": startTime,
        "segment_end": endTime,
        "url": `https://hd-my.le.com/danmu/list?vid=${videoId}&start=${startTime}&end=${endTime}&callback=vjs_${Date.now()}`
      });
    }

    log("info", `乐视网: 视频时长 ${duration}秒，分为 ${segments.length} 个时间段`);

    return new SegmentListResponse({
      "type": "leshi",
      "segmentList": segments
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getDanmuSegment(segment);
  }

  async getVideoDuration(videoId) {
    try {
      const response = await httpGet(`https://www.le.com/ptv/vplay/${videoId}.html`, { timeout: 10000 });
      
      if (!response || !response.data) {
        log("warning", `乐视网: 获取视频时长失败，使用默认值2400秒`);
        return 2400;
      }
      
      // 从页面中提取时长信息 - 支持 HH:MM:SS, MM:SS 或纯数字格式
      // 匹配格式如: duration:'02:23:58', duration: "02:23:58", duration:02:23:58, duration:12345
      const durationMatch = /duration['"]?\s*:\s*['"]?(\d{2}):(\d{2}):(\d{2})['"]?|duration['"]?\s*:\s*['"]?(\d{2}):(\d{2})['"]?|duration['"]?\s*:\s*(\d+)['"]?/.exec(response.data);
      if (durationMatch) {
        // 检查是否匹配到 HH:MM:SS 格式 (第1-3捕获组)
        if (durationMatch[1] && durationMatch[2] && durationMatch[3]) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          return hours * 3600 + minutes * 60 + seconds;
        }
        // 检查是否匹配到 MM:SS 格式 (第4-5捕获组)
        else if (durationMatch[4] && durationMatch[5]) {
          const minutes = parseInt(durationMatch[4]);
          const seconds = parseInt(durationMatch[5]);
          return minutes * 60 + seconds;
        }
        // 检查是否匹配到纯数字格式 (第6捕获组)
        else if (durationMatch[6]) {
          const seconds = parseInt(durationMatch[6]);
          return seconds;
        }
      }
      
      // 默认返回40分钟
      return 2400;
    } catch (e) {
      log("warning", `获取视频时长失败: ${e}，使用默认值2400秒`);
      return 2400;
    }
  }

  formatComments(comments) {
    return comments.map(comment => {
      try {
        // 位置转换
        const position = this.positionMap[parseInt(comment.position)] || 1;

        // 时间（秒）
        const timeVal = parseFloat(comment.start || 0);

        // 颜色（十六进制转十进制）
        const colorHex = comment.color || 'FFFFFF';
        const color = parseInt(colorHex, 16);

        // 弹幕ID
        const danmuId = comment.id || comment._id || '';

        // 弹幕内容
        const content = comment.txt || '';

        // 构造p属性：时间,模式,字体大小,颜色,时间戳,池,用户ID,弹幕ID
        const pString = `${timeVal.toFixed(2)},${position},25,${color},[${this.constructor.name.toLowerCase()}]`;

        return {
          cid: String(danmuId),
          p: pString,
          m: content,
          t: Math.round(timeVal * 100) / 100
        };
      } catch (error) {
        log("error", `格式化弹幕失败: ${error.message}, 弹幕数据:`, comment);
        return null;
      }
    }).filter(comment => comment !== null);
  }
}
