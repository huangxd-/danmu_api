import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet, httpPost } from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取优酷弹幕
// =====================
export default class YoukuSource extends BaseSource {
  convertYoukuUrl(url) {
    // 使用正则表达式提取 vid 参数
    const vidMatch = url.match(/vid=([^&]+)/);
    if (!vidMatch || !vidMatch[1]) {
      return null; // 如果没有找到 vid 参数，返回 null
    }

    const vid = vidMatch[1];
    // 构造新的 URL
    return `https://v.youku.com/v_show/id_${vid}.html`;
  }

  /**
   * 过滤优酷搜索项
   * @param {Object} component - 搜索组件
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  filterYoukuSearchItem(component, keyword) {
    const commonData = component.commonData;
    if (!commonData || !commonData.titleDTO) {
      return null;
    }

    // 过滤非优酷内容
    if (commonData.isYouku !== 1 && commonData.hasYouku !== 1) {
      return null;
    }

    const title = commonData.titleDTO.displayName;

    // 过滤不相关内容
    const skipKeywords = ["中配版", "抢先看", "非正片", "解读", "揭秘", "赏析", "《"];
    if (skipKeywords.some(kw => title.includes(kw))) {
      return null;
    }

    // 提取年份
    const yearMatch = commonData.feature.match(/[12][890][0-9][0-9]/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;

    // 清理标题 (移除HTML标签和特殊符号)
    let cleanedTitle = title.replace(/<[^>]+>/g, '').replace(/【.+?】/g, '').trim().replace(/:/g, '：');

    // 提取媒体类型（参考 Python 版本的 _extract_media_type_from_response）
    let mediaType = "电视剧"; // 默认类型
    const cats = (commonData.cats || "").toLowerCase();
    const feature = (commonData.feature || "").toLowerCase();
    
    // 优先使用 cats 字段
    if (cats.includes("动漫") || cats.includes("anime")) {
      mediaType = "动漫";
    } else if (cats.includes("电影") || cats.includes("movie")) {
      mediaType = "电影";
    } else if (cats.includes("电视剧") || cats.includes("drama")) {
      mediaType = "电视剧";
    } else if (cats.includes("综艺") || cats.includes("variety")) {
      mediaType = "综艺";
    }
    // 备用：从 feature 字段提取
    else if (feature.includes("动漫")) {
      mediaType = "动漫";
    } else if (feature.includes("电影")) {
      mediaType = "电影";
    } else if (feature.includes("电视剧")) {
      mediaType = "电视剧";
    } else if (feature.includes("综艺")) {
      mediaType = "综艺";
    }

    return {
      provider: "youku",
      mediaId: commonData.showId,
      title: cleanedTitle,
      type: mediaType,
      year: year,
      imageUrl: commonData.posterDTO ? commonData.posterDTO.vThumbUrl : null,
      episodeCount: commonData.episodeTotal,
      cats: commonData.cats // 保存分类信息用于后续判断
    };
  }

  async search(keyword) {
    try {
      log("info", `[Youku] 开始搜索: ${keyword}`);

      const encodedKeyword = encodeURIComponent(keyword);
      const encodedUA = encodeURIComponent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");
      const searchUrl = `https://search.youku.com/api/search?keyword=${encodedKeyword}&userAgent=${encodedUA}&site=1&categories=0&ftype=0&ob=0&pg=1`;

      const response = await httpGet(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.youku.com/'
        }
      });

      if (!response || !response.data) {
        log("info", "[Youku] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.pageComponentList) {
        log("info", "[Youku] 搜索无结果");
        return [];
      }

      // 过滤和处理搜索结果
      const results = [];
      for (const component of data.pageComponentList) {
        const filtered = this.filterYoukuSearchItem(component, keyword);
        if (filtered) {
          results.push(filtered);
        }
      }

      log("info", `[Youku] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Youku] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Youku] 获取分集列表: show_id=${id}`);

      // 第一步：获取第一页以确定总数
      const pageSize = 100;
      const firstPage = await this._getEpisodesPage(id, 1, pageSize);

      if (!firstPage || !firstPage.videos || firstPage.videos.length === 0) {
        log("info", "[Youku] 未找到分集信息");
        return [];
      }

      let allEpisodes = [...firstPage.videos];
      const totalCount = firstPage.total;

      // 第二步：如果有多页，并发获取剩余页面
      if (totalCount > pageSize) {
        const totalPages = Math.ceil(totalCount / pageSize);
        log("info", `[Youku] 检测到 ${totalCount} 个分集，将并发请求 ${totalPages} 页`);

        const pagePromises = [];
        for (let page = 2; page <= totalPages; page++) {
          pagePromises.push(this._getEpisodesPage(id, page, pageSize));
        }

        const results = await Promise.allSettled(pagePromises);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'fulfilled' && result.value && result.value.videos) {
            allEpisodes.push(...result.value.videos);
          } else if (result.status === 'rejected') {
            log("error", `[Youku] 获取分集页面 ${i + 2} 失败:`, result.reason);
          }
        }

        log("info", `[Youku] 并发获取完成，共获取 ${allEpisodes.length} 个分集`);
      }

      log("info", `[Youku] 共获取 ${allEpisodes.length} 集`);
      return allEpisodes;

    } catch (error) {
      log("error", "[Youku] 获取分集出错:", error.message);
      return [];
    }
  }

  async _getEpisodesPage(showId, page, pageSize) {
    const url = `https://openapi.youku.com/v2/shows/videos.json?client_id=53e6cc67237fc59a&package=com.huawei.hwvplayer.youku&ext=show&show_id=${showId}&page=${page}&count=${pageSize}`;

    const response = await httpGet(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response || !response.data) {
      return null;
    }

    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    return data;
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Youku] sourceAnimes is not a valid array");
      return [];
    }

    const processYoukuAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);

          // 提取媒体类型
          const mediaType = this._extractMediaType(anime.cats, anime.type);

          // 处理和格式化分集
          const formattedEps = this._processAndFormatEpisodes(eps, mediaType);

          let links = [];
          for (const ep of formattedEps) {
            const fullUrl = ep.link || `https://v.youku.com/v_show/id_${ep.vid}.html`;
            links.push({
              "name": ep.episodeIndex.toString(),
              "url": fullUrl,
              "title": `【youku】 ${ep.title}`
            });
          }

          if (links.length > 0) {
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from youku`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "youku",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Youku] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processYoukuAnimes;
  }

  /**
   * 处理和格式化分集列表
   * @param {Array} rawEpisodes - 原始分集数据
   * @param {string} mediaType - 媒体类型 (variety/movie/drama/anime)
   * @returns {Array} 格式化后的分集列表
   */
  _processAndFormatEpisodes(rawEpisodes, mediaType = 'variety') {
    let filteredEpisodes = [...rawEpisodes];

    // 格式化分集标题
    const formattedEpisodes = filteredEpisodes.map((ep, index) => {
      const episodeIndex = index + 1;
      const title = this._formatEpisodeTitle(ep, episodeIndex, mediaType);

      return {
        vid: ep.id,
        title: title,
        episodeIndex: episodeIndex,
        link: ep.link
      };
    });

    return formattedEpisodes;
  }

  /**
   * 根据媒体类型格式化分集标题
   * @param {Object} ep - 分集对象
   * @param {number} episodeIndex - 分集索引
   * @param {string} mediaType - 媒体类型
   * @returns {string} 格式化后的标题
   */
  _formatEpisodeTitle(ep, episodeIndex, mediaType) {
    // 清理 displayName (移除日期前缀)
    let cleanDisplayName = ep.displayName || ep.title;
    const datePattern = /^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*(?=(?:第\d+期))|^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*:\s*/;
    cleanDisplayName = cleanDisplayName.replace(datePattern, '').trim();

    // 电影：直接使用原始标题
    if (mediaType === 'movie') {
      return cleanDisplayName;
    }

    // 综艺：使用 "第N期" 格式
    if (mediaType === 'variety') {
      const periodMatch = cleanDisplayName.match(/第(\d+)期/);
      if (periodMatch) {
        return `第${periodMatch[1]}期 ${ep.published?.split(' ')[0] ?? ''} ${cleanDisplayName}`;
      } else {
        return `第${episodeIndex}期 ${ep.published?.split(' ')[0] ?? ''} ${cleanDisplayName}`;
      }
    }

    // 电视剧/动漫：使用 "第N集" 格式 + 原始标题
    if (/^第\d+集/.test(cleanDisplayName)) {
      return cleanDisplayName;
    } else {
      return `第${episodeIndex}集 ${cleanDisplayName}`;
    }
  }

  /**
   * 从分类信息中提取媒体类型（参考 Python 版本的 _extract_media_type_from_response）
   * @param {string} cats - 分类字符串
   * @param {string} feature - 特征字符串
   * @returns {string} 媒体类型 (variety/movie/anime/drama)
   */
  _extractMediaType(cats, feature) {
    const catsLower = (cats || '').toLowerCase();
    const featureLower = (feature || '').toLowerCase();

    // 优先使用 cats 字段
    if (catsLower.includes('综艺') || catsLower.includes('variety')) {
      return 'variety';
    } else if (catsLower.includes('电影') || catsLower.includes('movie')) {
      return 'movie';
    } else if (catsLower.includes('动漫') || catsLower.includes('anime')) {
      return 'anime';
    } else if (catsLower.includes('电视剧') || catsLower.includes('drama')) {
      return 'drama';
    }
    
    // 备用：从 feature 字段提取
    if (featureLower.includes('综艺')) {
      return 'variety';
    } else if (featureLower.includes('电影')) {
      return 'movie';
    } else if (featureLower.includes('动漫')) {
      return 'anime';
    } else if (featureLower.includes('电视剧')) {
      return 'drama';
    }

    // 默认返回电视剧类型
    return 'drama';
  }

   async getEpisodeDanmu(id) {
    log("info", "开始从本地请求优酷弹幕...", id);

    if (!id) {
      return [];
    }

    // 获取分片URL列表
    const segmentListResponse = await this.getEpisodeDanmuSegments(id);
    const segmentList = segmentListResponse.segmentList;

    let contents = [];

    // 并发限制（可通过环境变量 YOUKU_CONCURRENCY 配置，默认 8）
    const concurrency = globals.youkuConcurrency;
    const segments = [...segmentList];

    for (let i = 0; i < segments.length; i += concurrency) {
      const batch = segments.slice(i, i + concurrency).map(async (segment) => {
        const response = await httpPost(segment.url, buildQueryString({ data: segment.data }), {
          headers: {
            "Cookie": `_m_h5_tk=${segment._m_h5_tk};_m_h5_tk_enc=${segment._m_h5_tk_enc};`,
            "Referer": "https://v.youku.com",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
          },
          allow_redirects: false,
          retries: 1,
        });

        const results = [];
        if (response.data?.data && response.data.data.result) {
          const result = JSON.parse(response.data.data.result);
          if (result.code !== "-1") {
            results.push(...result.data.result);
          }
        }
        return results;
      });

      try {
        const settled = await Promise.allSettled(batch);
        for (const s of settled) {
          if (s.status === "fulfilled" && Array.isArray(s.value)) {
            contents = contents.concat(s.value);
          }
        }
      } catch (e) {
        log("error", "优酷分段批量请求失败:", e.message);
      }
    }

    printFirst200Chars(contents);

    return contents;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取优酷弹幕分段列表...", id);

    if (!id) {
      return new SegmentListResponse({
        "type": "youku",
        "segmentList": []
      });
    }

    // 处理302场景
    // https://v.youku.com/video?vid=XNjQ4MTIwOTE2NA==&tpa=dW5pb25faWQ9MTAyMjEzXzEwMDAwNl8wMV8wMQ需要转成https://v.youku.com/v_show/id_XNjQ4MTIwOTE2NA==.html
    if (id.includes("youku.com/video?vid")) {
        id = this.convertYoukuUrl(id);
    }

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://openapi.youku.com/v2/videos/show.json";
    const api_danmaku = "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/";

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
    const video_id = path[path.length - 1].split(".")[0].slice(3);

    log("info", `video_id: ${video_id}`);

    // 获取页面标题和视频时长
    let res;
    try {
      const videoInfoUrl = `${api_video_info}?client_id=53e6cc67237fc59a&video_id=${video_id}&package=com.huawei.hwvplayer.youku&ext=show`;
      res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });
    } catch (error) {
      log("error", "请求视频信息失败:", error);
      return [];
    }

    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const title = data.title;
    const duration = data.duration;
    log("info", `标题: ${title}, 时长: ${duration}`);

    // 获取 cna 和 tk_enc
    let cna, _m_h5_tk_enc, _m_h5_tk;
    try {
      const cnaUrl = "https://log.mmstat.com/eg.js";
      const tkEncUrl = "https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=24679788";
      const cnaRes = await httpGet(cnaUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });
      log("info", `cnaRes: ${JSON.stringify(cnaRes)}`);
      log("info", `cnaRes.headers: ${JSON.stringify(cnaRes.headers)}`);
      const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
      log("info", `etag: ${etag}`);
      // const match = cnaRes.headers["set-cookie"].match(/cna=([^;]+)/);
      // cna = match ? match[1] : null;
      cna = etag.replace(/^"|"$/g, '');
      log("info", `cna: ${cna}`);

      let tkEncRes;
      while (!tkEncRes) {
        tkEncRes = await httpGet(tkEncUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
          },
          allow_redirects: false
        });
      }
      log("info", `tkEncRes: ${JSON.stringify(tkEncRes)}`);
      log("info", `tkEncRes.headers: ${JSON.stringify(tkEncRes.headers)}`);
      const tkEncSetCookie = tkEncRes.headers["set-cookie"] || tkEncRes.headers["Set-Cookie"];
      log("info", `tkEncSetCookie: ${tkEncSetCookie}`);

      // 获取 _m_h5_tk_enc
      const tkEncMatch = tkEncSetCookie.match(/_m_h5_tk_enc=([^;]+)/);
      _m_h5_tk_enc = tkEncMatch ? tkEncMatch[1] : null;

      // 获取 _m_h5_tkh
      const tkH5Match = tkEncSetCookie.match(/_m_h5_tk=([^;]+)/);
      _m_h5_tk = tkH5Match ? tkH5Match[1] : null;

      log("info", `_m_h5_tk_enc: ${_m_h5_tk_enc}`);
      log("info", `_m_h5_tk: ${_m_h5_tk}`);
    } catch (error) {
      log("error", "获取 cna 或 tk_enc 失败:", error);
      return [];
    }

    // 计算弹幕分段请求
    const step = 60; // 每60秒一个分段
    const max_mat = Math.floor(duration / step) + 1;
    let segmentList = [];

    // 将构造请求和解析逻辑封装为函数，返回该分段的弹幕数组
    const requestOneMat = async (mat) => {
      const msg = {
        ctime: Date.now(),
        ctype: 10004,
        cver: "v1.0",
        guid: cna,
        mat: mat,
        mcount: 1,
        pid: 0,
        sver: "3.1.0",
        type: 1,
        vid: video_id,
      };

      const str = JSON.stringify(msg);

      function utf8ToLatin1(str) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
          const charCode = str.charCodeAt(i);
          if (charCode > 255) {
            result += encodeURIComponent(str[i]);
          } else {
            result += str[i];
          }
        }
        return result;
      }

      function base64Encode(input) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let buffer = 0;
        let bufferLength = 0;
        for (let i = 0; i < input.length; i++) {
          buffer = (buffer << 8) | input.charCodeAt(i);
          bufferLength += 8;
          while (bufferLength >= 6) {
            output += chars[(buffer >> (bufferLength - 6)) & 0x3F];
            bufferLength -= 6;
          }
        }
        if (bufferLength > 0) {
          output += chars[(buffer << (6 - bufferLength)) & 0x3F];
        }
        while (output.length % 4 !== 0) {
          output += '=';
        }
        return output;
      }

      const msg_b64encode = base64Encode(utf8ToLatin1(str));
      msg.msg = msg_b64encode;
      msg.sign = md5(`${msg_b64encode}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toString().toLowerCase();

      const data = JSON.stringify(msg);
      const t = Date.now();
      const params = {
        jsv: "2.5.6",
        appKey: "24679788",
        t: t,
        sign: md5([_m_h5_tk.slice(0, 32), t, "24679788", data].join("&")).toString().toLowerCase(),
        api: "mopen.youku.danmu.list",
        v: "1.0",
        type: "originaljson",
        dataType: "jsonp",
        timeout: "20000",
        jsonpIncPrefix: "utility",
      };

      const queryString = buildQueryString(params);
      const url = `${api_danmaku}?${queryString}`;
      log("info", `piece_url: ${url}`);

      return {
        "type": "youku",
        "segment_start": mat * step,
        "segment_end": Math.min((mat + 1) * step, duration),
        "url": url,
        "data": data,
        "_m_h5_tk": _m_h5_tk,
        "_m_h5_tk_enc": _m_h5_tk_enc,
      };
    }

    const mats = Array.from({ length: max_mat }, (_, i) => i);
    for (let i = 0; i < mats.length; i++) {
      const result = await requestOneMat(mats[i]);
      segmentList.push(result);
    }

    return new SegmentListResponse({
      "type": "youku",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    log("info", "开始从本地请求优酷分段弹幕...", segment.url);

    const response = await httpPost(segment.url, buildQueryString({ data: segment.data }), {
      headers: {
        "Cookie": `_m_h5_tk=${segment._m_h5_tk};_m_h5_tk_enc=${segment._m_h5_tk_enc};`,
        "Referer": "https://v.youku.com",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
      },
      allow_redirects: false,
      retries: 1,
    });

    const results = [];
    if (response.data?.data && response.data.data.result) {
      const result = JSON.parse(response.data.data.result);
      if (result.code !== "-1") {
        results.push(...result.data.result);
      }
    }

    return results;
  }

  formatComments(comments) {
    return comments.map(item => {
      const content = {
        timepoint: 0,
        ct: 1,
        size: 25,
        color: 16777215,
        unixtime: Math.floor(Date.now() / 1000),
        uid: 0,
        content: "",
      };
      content.timepoint = item.playat / 1000;
      const prop = JSON.parse(item.propertis)
      if (prop?.color) {
        content.color = typeof prop.color === 'string' 
          ? parseInt(prop.color, 10) 
          : prop.color;
      }
      if (prop?.pos) {
        const pos = prop.pos;
        if (pos === 1) content.ct = 5;
        else if (pos === 2) content.ct = 4;
      }
      content.content = item.content;
      return content;
    });
  }
}
