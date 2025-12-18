import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet} from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { globals } from '../configs/globals.js';
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取爱奇艺弹幕
// =====================
export default class IqiyiSource extends BaseSource {
  // 爱奇艺 API 签名相关常量
  static XOR_KEY = 0x75706971676c;
  static SECRET_KEY = "howcuteitis";
  static KEY_NAME = "secret_key";

  /**
   * 搜索爱奇艺内容
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Array>} 搜索结果数组
   */
  async search(keyword) {
    try {
      log("info", `[iQiyi] 开始搜索: ${keyword}`);

      // 使用桌面版 API 搜索
      const params = {
        key: keyword,
        current_page: '1',
        mode: '1',
        source: 'input',
        suggest: '',
        pcv: '13.074.22699',
        version: '13.074.22699',
        pageNum: '1',
        pageSize: '25',
        pu: '',
        u: 'f6440fc5d919dca1aea12b6aff56e1c7',
        scale: '200',
        token: '',
        userVip: '0',
        conduit: '',
        vipType: '-1',
        os: '',
        osShortName: 'win10',
        dataType: '',
        appMode: '',
        ad: JSON.stringify({"lm":3,"azd":1000000000951,"azt":733,"position":"feed"}),
        adExt: JSON.stringify({"r":"2.1.5-ares6-pure"})
      };

      // 手动构建 URL（httpGet 不支持 params 选项）
      const queryString = buildQueryString(params);
      const url = `https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?${queryString}`;

      const response = await httpGet(url, {
        headers: {
          'accept': '*/*',
          'origin': 'https://www.iqiyi.com',
          'referer': 'https://www.iqiyi.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response || !response.data) {
        log("info", "[iQiyi] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.templates) {
        log("info", "[iQiyi] 搜索无结果");
        return [];
      }

      // 处理搜索结果
      const results = [];
      const templates = data.data.templates;

      for (const template of templates) {
        let albumsToProcess = [];

        // 优先处理意图卡片 (template 112)
        if (template.template === 112 && template.intentAlbumInfos) {
          log("debug", `[iQiyi] 找到意图卡片 (template 112)，处理 ${template.intentAlbumInfos.length} 个结果`);
          albumsToProcess = template.intentAlbumInfos;
        }
        // 然后处理普通结果卡片
        else if ([101, 102, 103].includes(template.template) && template.albumInfo) {
          log("debug", `[iQiyi] 找到普通结果卡片 (template ${template.template})`);
          albumsToProcess = [template.albumInfo];
        }

        for (const album of albumsToProcess) {
          const filtered = this._filterIqiyiSearchItem(album, keyword);
          if (filtered) {
            results.push(filtered);
          }
        }
      }

      log("info", `[iQiyi] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[iQiyi] 搜索出错:", error.message);
      return [];
    }
  }

  /**
   * 过滤爱奇艺搜索项
   * @param {Object} album - 搜索结果专辑信息
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  _filterIqiyiSearchItem(album, keyword) {
    if (!album.title) {
      return null;
    }

    // 过滤外站付费播放
    if (album.btnText === '外站付费播放') {
      log("debug", `[iQiyi] 过滤掉外站付费播放内容: ${album.title}`);
      return null;
    }

    // 提取媒体类型
    const channel = album.channel || "";
    let mediaType = "电视剧"; // 默认类型

    if (channel.includes("电影")) {
      mediaType = "电影";
    } else if (channel.includes("动漫")) {
      mediaType = "动漫";
    } else if (channel.includes("综艺")) {
      mediaType = "综艺";
    } else if (channel.includes("纪录片")) {
      mediaType = "纪录片";
    } else if (channel.includes("电视剧")) {
      mediaType = "电视剧";
    } else {
      // 只保留支持的类型：电影、电视剧、动漫、综艺、纪录片
      return null;
    }

    // 电影类型：使用 qipuId 作为 mediaId
    if (mediaType === "电影") {
      const qipuId = album.qipuId || album.playQipuId;
      if (!qipuId) {
        log("debug", `[iQiyi] 电影缺少 qipuId: ${album.title}`);
        return null;
      }

      // 提取年份
      let year = null;
      if (album.year) {
        const yearStr = album.year.value || album.year.name;
        if (yearStr && typeof yearStr === 'string' && yearStr.length === 4 && /^\d{4}$/.test(yearStr)) {
          year = parseInt(yearStr);
        }
      }

      // 清理标题
      const cleanedTitle = album.title.replace(/<[^>]+>/g, '').replace(/:/g, '：');

      return {
        provider: "iqiyi",
        mediaId: `movie_${qipuId}`, // 使用特殊前缀标识电影
        title: cleanedTitle,
        type: mediaType,
        year: year,
        imageUrl: album.img || album.imgH,
        episodeCount: 1, // 电影只有1集
        _qipuId: qipuId // 保存原始 qipuId 供后续使用
      };
    }

    // 非电影类型：从 pageUrl 提取 link_id
    const url = album.pageUrl;
    if (!url) {
      log("debug", `[iQiyi] 非电影内容缺少 pageUrl: ${album.title}`);
      return null;
    }

    const linkIdMatch = url.match(/v_(\w+?)\.html/);
    if (!linkIdMatch) {
      log("debug", `[iQiyi] 无法从 pageUrl 提取 link_id: ${url}`);
      return null;
    }
    const linkId = linkIdMatch[1];

    // 提取年份
    let year = null;
    if (album.year) {
      const yearStr = album.year.value || album.year.name;
      if (yearStr && typeof yearStr === 'string' && yearStr.length === 4 && /^\d{4}$/.test(yearStr)) {
        year = parseInt(yearStr);
      }
    }

    // 提取分集数
    let episodeCount = null;
    if (album.videos && album.videos.length > 0) {
      episodeCount = album.videos.length;
    } else if (album.subscriptContent) {
      // 从 subscriptContent 中提取集数
      const countMatch = album.subscriptContent.match(/(?:更新至|全|共)\s*(\d+)\s*(?:集|话|期)/);
      if (countMatch) {
        episodeCount = parseInt(countMatch[1]);
      } else {
        const simpleMatch = album.subscriptContent.trim().match(/^(\d+)$/);
        if (simpleMatch) {
          episodeCount = parseInt(simpleMatch[1]);
        }
      }
    }

    // 清理标题
    const cleanedTitle = album.title.replace(/<[^>]+>/g, '').replace(/:/g, '：');

    return {
      provider: "iqiyi",
      mediaId: linkId,
      title: cleanedTitle,
      type: mediaType,
      year: year,
      imageUrl: album.img || album.imgH,
      episodeCount: episodeCount
    };
  }

  /**
   * 获取分集列表
   * @param {string} id - 视频 ID (link_id 或 movie_qipuId)
   * @returns {Promise<Array>} 分集列表
   */
  async getEpisodes(id) {
    try {
      log("info", `[iQiyi] 获取分集列表: media_id=${id}`);

      // 检查是否是电影类型（以 movie_ 开头）
      if (id.startsWith('movie_')) {
        const qipuId = id.substring(6); // 移除 "movie_" 前缀
        log("info", `[iQiyi] 电影类型，调用 base_info API 获取视频ID: qipuId=${qipuId}`);

        // 调用 base_info API 获取电影详情
        const videoId = await this._getMovieVideoId(qipuId);
        if (!videoId) {
          log("error", `[iQiyi] 无法获取电影的视频ID: qipuId=${qipuId}`);
          return [];
        }

        log("info", `[iQiyi] 电影视频ID: ${videoId}`);
        return [{
          id: videoId,
          title: "正片",
          order: 1,
          link: `https://www.iqiyi.com/v_${videoId}.html`
        }];
      }

      // 第一步：将 video_id 转换为 entity_id
      const entityId = /^\d+$/.test(id) ? id : this._videoIdToEntityId(id);
      if (!entityId) {
        log("error", `[iQiyi] 无法将 media_id '${id}' 转换为 entity_id`);
        return [];
      }

      // 第二步：构建 API 请求参数
      const params = {
        entity_id: entityId,
        device_id: 'qd5fwuaj4hunxxdgzwkcqmefeb3ww5hx',
        auth_cookie: '',
        user_id: '0',
        vip_type: '-1',
        vip_status: '0',
        conduit_id: '',
        pcv: '13.082.22866',
        app_version: '13.082.22866',
        ext: '',
        app_mode: 'standard',
        scale: '100',
        timestamp: String(Date.now()),
        src: 'pca_tvg',
        os: '',
        ad_ext: '{"r":"2.2.0-ares6-pure"}'
      };

      // 生成签名
      params.sign = this._createSign(params);

      // 第三步：请求 API
      const queryString = buildQueryString(params);
      const url = `https://www.iqiyi.com/prelw/tvg/v2/lw/base_info?${queryString}`;

      const response = await httpGet(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.iqiyi.com/'
        }
      });

      if (!response || !response.data) {
        log("error", "[iQiyi] 获取分集响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.status_code !== 0 || !data.data || !data.data.template) {
        log("error", `[iQiyi] API 返回错误，status_code: ${data.status_code}`);
        return [];
      }

      // 第四步：解析分集数据
      const allEpisodes = [];
      const tabs = data.data.template.tabs || [];

      if (tabs.length === 0) {
        log("info", "[iQiyi] 未找到分集标签页");
        return [];
      }

      const blocks = tabs[0].blocks || [];
      let foundEpisodes = false;

      for (const block of blocks) {
        // 查找 video_list 类型的块（新版API）
        if (block.bk_type === "video_list" && block.data?.data) {
          log("debug", `[iQiyi] 找到 video_list 类型的分集数据块, bk_id: ${block.bk_id}`);

          // 检查是否是分集选择器块
          if (!block.tag || !block.tag.includes("episodes")) {
            log("debug", `[iQiyi] 跳过非分集块: ${block.bk_id}`);
            continue;
          }

          foundEpisodes = true;

          const dataGroups = block.data.data;
          if (!Array.isArray(dataGroups)) {
            log("warn", "[iQiyi] data.data 不是数组，跳过此块");
            continue;
          }

          for (const group of dataGroups) {
            if (!group.videos || !Array.isArray(group.videos)) continue;

            // 遍历每个年份/季度分组
            for (const videoGroup of group.videos) {
              if (!videoGroup.data || !Array.isArray(videoGroup.data)) continue;

              // 处理每个分集
              for (const epData of videoGroup.data) {
                // 只处理正片内容 (content_type === 1)
                if (epData.content_type !== 1) continue;

                const playUrl = epData.play_url || "";
                const tvidMatch = playUrl.match(/tvid=(\d+)/);
                if (!tvidMatch) continue;

                const tvid = tvidMatch[1];
                let title = epData.short_display_name || epData.title || "未知分集";
                const subtitle = epData.subtitle;
                if (subtitle && !title.includes(subtitle)) {
                  title = `${title} ${subtitle}`;
                }

                const order = epData.album_order;
                const pageUrl = epData.page_url;

                if (tvid && title && pageUrl) {
                  allEpisodes.push({
                    id: tvid,
                    title: title,
                    order: order !== undefined ? order : allEpisodes.length,
                    link: pageUrl
                  });
                }
              }
            }
          }
        }
        // 兼容旧版 API 的 album_episodes 类型
        else if (block.bk_type === "album_episodes" && block.data?.data) {
          log("debug", "[iQiyi] 找到 album_episodes 类型的分集数据块");
          foundEpisodes = true;

          const episodeGroups = block.data.data;
          for (const group of episodeGroups) {
            let videosData = group.videos;

            // 如果 videos 是 URL，需要额外请求
            if (typeof videosData === 'string') {
              log("info", `[iQiyi] 发现分季URL，正在获取: ${videosData}`);
              try {
                const seasonResponse = await httpGet(videosData);
                videosData = typeof seasonResponse.data === "string" ? JSON.parse(seasonResponse.data) : seasonResponse.data;
              } catch (error) {
                log("error", `[iQiyi] 获取分季数据失败: ${error.message}`);
                continue;
              }
            }

            // 处理分页数据
            if (videosData && typeof videosData === 'object' && videosData.feature_paged) {
              for (const pageKey in videosData.feature_paged) {
                const pagedList = videosData.feature_paged[pageKey];
                for (const epData of pagedList) {
                  if (epData.content_type !== 1) continue;

                  const playUrl = epData.play_url || "";
                  const tvidMatch = playUrl.match(/tvid=(\d+)/);
                  if (!tvidMatch) continue;

                  const tvid = tvidMatch[1];
                  let title = epData.short_display_name || epData.title || "未知分集";
                  const subtitle = epData.subtitle;
                  if (subtitle && !title.includes(subtitle)) {
                    title = `${title} ${subtitle}`;
                  }

                  const order = epData.album_order;
                  const pageUrl = epData.page_url;

                  if (tvid && title && order && pageUrl) {
                    allEpisodes.push({
                      id: tvid,
                      title: title,
                      order: order,
                      link: pageUrl
                    });
                  }
                }
              }
            }
          }
        }
      }

      if (!foundEpisodes) {
        log("info", "[iQiyi] 未找到分集数据块");
        return [];
      }

      // 去重并排序
      const uniqueEpisodes = Array.from(
        new Map(allEpisodes.map(ep => [ep.id, ep])).values()
      );
      uniqueEpisodes.sort((a, b) => a.order - b.order);

      log("info", `[iQiyi] 成功获取 ${uniqueEpisodes.length} 个分集`);
      return uniqueEpisodes;

    } catch (error) {
      log("error", "[iQiyi] 获取分集出错:", error.message);
      return [];
    }
  }

  /**
   * 获取电影的视频ID（从 qipuId 获取正确的 video_id）
   * @param {string} qipuId - 电影的 qipuId
   * @returns {Promise<string|null>} 视频ID
   */
  async _getMovieVideoId(qipuId) {
    try {
      // 构建 base_info API 请求参数
      const params = {
        entity_id: qipuId,
        device_id: 'qd5fwuaj4hunxxdgzwkcqmefeb3ww5hx',
        auth_cookie: '',
        user_id: '0',
        vip_type: '-1',
        vip_status: '0',
        conduit_id: '',
        pcv: '13.103.23529',
        app_version: '13.103.23529',
        ext: '',
        app_mode: 'standard',
        scale: '125',
        timestamp: String(Date.now()),
        src: 'pca_tvg',
        os: '',
        ad_ext: '{"r":"2.5.0-ares6-pure"}'
      };

      // 生成签名（使用与 getEpisodes 相同的方法）
      params.sign = this._createSign(params);

      // 构建 URL
      const queryString = buildQueryString(params);
      const url = `https://mesh.if.iqiyi.com/tvg/v2/lw/base_info?${queryString}`;

      log("debug", `[iQiyi] 请求电影详情: ${url}`);

      const response = await httpGet(url, {
        headers: {
          'accept': '*/*',
          'origin': 'https://www.iqiyi.com',
          'referer': 'https://www.iqiyi.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response || !response.data) {
        log("error", "[iQiyi] base_info API 响应为空");
        return null;
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      // 从响应中提取视频ID
      // 尝试多个可能的路径
      if (data.data && data.data.base_data) {
        const baseData = data.data.base_data;

        // 尝试 1: 从 share_url 中提取（最可靠）
        if (baseData.share_url) {
          const match = baseData.share_url.match(/v_(\w+)\.html/);
          if (match) {
            const videoId = match[1];
            log("info", `[iQiyi] 从 share_url 提取视频ID: ${videoId}`);
            return videoId;
          }
        }

        // 尝试 2: 从 page_url 中提取
        if (baseData.page_url) {
          const match = baseData.page_url.match(/v_(\w+)\.html/);
          if (match) {
            const videoId = match[1];
            log("info", `[iQiyi] 从 page_url 提取视频ID: ${videoId}`);
            return videoId;
          }
        }
      }

      log("error", "[iQiyi] base_info API 响应中未找到视频ID");
      log("debug", `[iQiyi] 响应数据结构: ${JSON.stringify(data).substring(0, 1000)}...`);
      return null;

    } catch (error) {
      log("error", `[iQiyi] 获取电影视频ID时出错: ${error.message}`);
      return null;
    }
  }

  /**
   * 将 video_id 转换为 entity_id
   * @param {string} videoId - 视频 ID
   * @returns {string|null} entity_id
   */
  _videoIdToEntityId(videoId) {
    try {
      const base36Decoded = parseInt(videoId, 36);
      const xorResult = this._xorOperation(base36Decoded);
      const finalResult = xorResult < 900000 ? 100 * (xorResult + 900000) : xorResult;
      return String(finalResult);
    } catch (error) {
      log("error", `[iQiyi] 将 video_id '${videoId}' 转换为 entity_id 时出错: ${error.message}`);
      return null;
    }
  }

  /**
   * 异或运算
   * @param {number} num - 输入数字
   * @returns {number} 异或结果
   */
  _xorOperation(num) {
    const numBinary = num.toString(2);
    const keyBinary = IqiyiSource.XOR_KEY.toString(2);
    const numBits = numBinary.split('').reverse();
    const keyBits = keyBinary.split('').reverse();
    const resultBits = [];
    const maxLen = Math.max(numBits.length, keyBits.length);

    for (let i = 0; i < maxLen; i++) {
      const numBit = i < numBits.length ? numBits[i] : '0';
      const keyBit = i < keyBits.length ? keyBits[i] : '0';
      if (numBit === '1' && keyBit === '1') {
        resultBits.push('0');
      } else if (numBit === '1' || keyBit === '1') {
        resultBits.push('1');
      } else {
        resultBits.push('0');
      }
    }

    const resultBinary = resultBits.reverse().join('');
    return resultBinary ? parseInt(resultBinary, 2) : 0;
  }

  /**
   * 为 API 生成签名
   * @param {Object} params - 请求参数
   * @returns {string} MD5 签名
   */
  _createSign(params) {
    const cleanParams = {};
    for (const key in params) {
      if (key !== 'sign') {
        cleanParams[key] = params[key];
      }
    }

    const sortedKeys = Object.keys(cleanParams).sort();
    const paramParts = [];
    for (const key of sortedKeys) {
      const value = cleanParams[key] === null || cleanParams[key] === undefined ? "" : cleanParams[key];
      paramParts.push(`${key}=${value}`);
    }

    const paramString = paramParts.join("&");
    const signString = `${paramString}&${IqiyiSource.KEY_NAME}=${IqiyiSource.SECRET_KEY}`;
    return md5(signString).toUpperCase();
  }

  /**
   * 处理搜索结果并格式化为 DanDanPlay 格式
   * @param {Array} sourceAnimes - 搜索结果数组
   * @param {string} queryTitle - 搜索关键词
   * @param {Array} curAnimes - 当前动漫列表
   * @returns {Promise<void>}
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[iQiyi] sourceAnimes is not a valid array");
      return [];
    }

    const processIqiyiAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);

          // 格式化分集列表
          const links = [];
          for (const ep of eps) {
            const fullUrl = ep.link || `https://www.iqiyi.com/v_${anime.mediaId}.html`;
            links.push({
              "name": ep.order.toString(),
              "url": fullUrl,
              "title": `【qiyi】 ${ep.title}`
            });
          }

          if (links.length > 0) {
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            const transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from iqiyi`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "iqiyi",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) {
              removeEarliestAnime();
            }
          }
        } catch (error) {
          log("error", `[iQiyi] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processIqiyiAnimes;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求爱奇艺弹幕...", id);

    // 获取页面标题
    let res;
    try {
      res = await httpGet(id, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
    } catch (error) {
      log("error", "请求页面失败:", error);
      return [];
    }

    // 使用正则表达式提取 <title> 标签内容
    const titleMatch = res.data.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].split("_")[0] : "未知标题";
    log("info", `标题: ${title}`);

    // 获取弹幕分段数据
    const segmentResult = await this.getEpisodeDanmuSegments(id);
    if (!segmentResult || !segmentResult.segmentList || segmentResult.segmentList.length === 0) {
      return [];
    }

    const segmentList = segmentResult.segmentList;
    log("info", `弹幕分段数量: ${segmentList.length}`);

    // 创建请求Promise数组
    const promises = [];
    for (const segment of segmentList) {
      promises.push(this.getEpisodeSegmentDanmu(segment));
    }

    // 解析弹幕数据
    let contents = [];
    try {
      const results = await Promise.allSettled(promises);
      const datas = results
        .filter(result => result.status === "fulfilled")
        .map(result => result.value)
        .filter(data => data !== null); // 过滤掉null值

      datas.forEach(data => {
        contents.push(...data);
      });
    } catch (error) {
      log("error", "解析弹幕数据失败:", error);
      return [];
    }

    printFirst200Chars(contents);

    return contents;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取爱奇艺视频弹幕分段列表...", id);

    // 弹幕 API 基础地址
    const api_decode_base = "https://pcw-api.iq.com/api/decode/";
    const api_video_info = "https://pcw-api.iqiyi.com/video/video/baseinfo/";

    // 解析 URL 获取 tvid
    let tvid;
    try {
      const idMatch = id.match(/v_(\w+)/);
      if (!idMatch) {
        log("error", "无法从 URL 中提取 tvid");
        return new SegmentListResponse({
          "type": "qiyi",
          "segmentList": []
        });
      }
      tvid = idMatch[1];
      log("info", `tvid: ${tvid}`);

      // 获取 tvid 的解码信息
      const decodeUrl = `${api_decode_base}${tvid}?platformId=3&modeCode=intl&langCode=sg`;
      let res = await httpGet(decodeUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      tvid = data.data.toString();
      log("info", `解码后 tvid: ${tvid}`);
    } catch (error) {
      log("error", "请求解码信息失败:", error);
      return new SegmentListResponse({
        "type": "qiyi",
        "segmentList": []
      });
    }

    // 获取视频基础信息
    let duration, albumid, categoryid;
    try {
      const videoInfoUrl = `${api_video_info}${tvid}`;
      const res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      const videoInfo = data.data;
      duration = videoInfo.durationSec;
      albumid = videoInfo.albumId;
      categoryid = videoInfo.channelId || videoInfo.categoryId;
      log("info", `时长: ${duration}`);
    } catch (error) {
      log("error", "请求视频基础信息失败:", error);
      return new SegmentListResponse({
        "type": "qiyi",
        "segmentList": []
      });
    }

    // 计算弹幕分段数量（每5分钟一个分段）
    const page = Math.ceil(duration / (60 * 5));
    log("info", `弹幕分段数量: ${page}`);

    // 构建分段列表
    const segmentList = [];
    for (let i = 0; i < page; i++) {
      const params = {
          rn: "0.0123456789123456",
          business: "danmu",
          is_iqiyi: "true",
          is_video_page: "true",
          tvid: tvid,
          albumid: albumid,
          categoryid: categoryid,
          qypid: "010102101000000000",
      };
      let queryParams = buildQueryString(params);
      const api_url = `https://cmts.iqiyi.com/bullet/${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_${i + 1}.z?${queryParams.toString()}`;
      segmentList.push({
        "type": "qiyi",
        "segment_start": i * 5 * 60,  // 每段5分钟
        "segment_end": Math.min((i + 1) * 5 * 60, duration),
        "url": api_url
      });
    }

    return new SegmentListResponse({
      "type": "qiyi",
      "segmentList": segmentList
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const response = await httpGet(segment.url, {
        headers: {
          "Accpet-Encoding": "gzip",
          "Content-Type": "application/xml",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        zlibMode: true,
        retries: 1,
      });

      // 提取 XML 标签内容的辅助函数
      function extract(xml, tag) {
          const reg = new RegExp(`<${tag}>(.*?)</${tag}>`, "g");
          const res = xml.match(reg)?.map((x) => x.substring(tag.length + 2, x.length - tag.length - 3));
          return res || [];
      }

      // 处理响应数据并返回 contents 格式的弹幕
      let contents = [];
      if (response && response.data) {
        const xml = response.data;
        const danmaku = extract(xml, "content");
        const showTime = extract(xml, "showTime");
        const color = extract(xml, "color");

        contents.push(...danmaku.map((content, i) => ({
          content,
          showTime: showTime[i],
          color: color[i],
        })));
      }

      return contents;
    } catch (error) {
      log("error", "请求分片弹幕失败:", error);
      return []; // 返回空数组而不是抛出错误，保持与getEpisodeDanmu一致的行为
    }
  }

  formatComments(comments) {
    return comments.map(item => {
      const content = {
          timepoint: 0,	// 弹幕发送时间（秒）
          ct: 1,	// 弹幕类型，1-3 为滚动弹幕、4 为底部、5 为顶端、6 为逆向、7 为精确、8 为高级
          size: 25,	//字体大小，25 为中，18 为小
          color: 16777215,	//弹幕颜色，RGB 颜色转为十进制后的值，16777215 为白色
          unixtime: Math.floor(Date.now() / 1000),	//Unix 时间戳格式
          uid: 0,		//发送人的 id
          content: "",
      };
      content.timepoint = parseFloat(item["showTime"]);
      content.color = parseInt(item["color"], 16);
      content.content = item["content"];
      content.size = 25;
      return content;
    });
  }
}
