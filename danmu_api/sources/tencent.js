import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, httpPost } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取腾讯视频弹幕
// =====================
export default class TencentSource extends BaseSource {
  /**
   * 过滤腾讯视频搜索项
   * @param {Object} item - 搜索项
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  filterTencentSearchItem(item, keyword) {
    if (!item.videoInfo || !item.doc) {
      return null;
    }

    const videoInfo = item.videoInfo;
    const mediaId = item.doc.id; // cid

    // 过滤无年份信息
    if (!videoInfo.year || videoInfo.year === 0) {
      return null;
    }

    // 过滤"全网搜"结果
    if (videoInfo.subTitle === "全网搜" || videoInfo.playFlag === 2) {
      return null;
    }

    // 清理标题(移除HTML标签)
    let title = videoInfo.title.replace(/<em>/g, '').replace(/<\/em>/g, '');

    if (!title || !mediaId) {
      return null;
    }

    // 内容类型过滤
    const contentType = videoInfo.typeName;
    if (contentType.includes("短剧")) {
      return null;
    }

    // 类型白名单(与360/vod保持一致,使用中文类型)
    const allowedTypes = ["电视剧", "动漫", "电影", "纪录片", "综艺", "综艺节目"];
    if (!allowedTypes.includes(contentType)) {
      return null;
    }

    // 过滤非腾讯视频内容
    const allSites = (videoInfo.playSites || []).concat(videoInfo.episodeSites || []);
    if (allSites.length > 0 && !allSites.some(site => site.enName === 'qq')) {
      return null;
    }

    // 电影非正片内容过滤
    if (contentType === "电影") {
      const nonFormalKeywords = ["花絮", "彩蛋", "幕后", "独家", "解说", "特辑", "探班", "拍摄", "制作", "导演", "记录", "回顾", "盘点", "混剪", "解析", "抢先"];
      if (nonFormalKeywords.some(kw => title.includes(kw))) {
        return null;
      }
    }

    const episodeCount = contentType === '电影' ? 1 : (videoInfo.subjectDoc ? videoInfo.subjectDoc.videoNum : 0);

    return {
      provider: "tencent",
      mediaId: mediaId,
      title: title,
      type: contentType,  // 使用中文类型,与360/vod保持一致
      year: videoInfo.year,
      imageUrl: videoInfo.imgUrl,
      episodeCount: episodeCount
    };
  }

  async search(keyword) {
    try {
      log("info", `[Tencent] 开始搜索: ${keyword}`);

      const searchUrl = "https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2";
      const payload = {
        version: "25071701",
        clientType: 1,
        filterValue: "",
        uuid: "0379274D-05A0-4EB6-A89C-878C9A460426",
        query: keyword,
        retry: 0,
        pagenum: 0,
        isPrefetch: true,
        pagesize: 30,
        queryFrom: 0,
        searchDatakey: "",
        transInfo: "",
        isneedQc: true,
        preQid: "",
        adClientInfo: "",
        extraInfo: {
          multi_terminal_pc: "1",
          themeType: "1",
          sugRelatedIds: "{}",
          appVersion: ""
        }
      };

      const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://v.qq.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': `https://v.qq.com/x/search/?q=${encodeURIComponent(keyword)}&stag=&smartbox_ab=`,
        'H38': '220496a1fb1498325e9be6d938',
        'H42': '335a00a80ab9bbbef56793d8e7a97e87b9341dee34ebd83d61afc0cdb303214caaece3',
        'Uk': '8e91af25d3af99d0f0640327e7307666',
        'Cookie': 'tvfe_boss_uuid=ee8f05103d59226f; pgv_pvid=3155633511; video_platform=2; ptag=v_qq_com; main_login=qq'
      };

      const response = await httpPost(searchUrl, JSON.stringify(payload), { headers });

      if (!response || !response.data) {
        log("info", "[Tencent] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.ret !== 0) {
        log("error", `[Tencent] API返回错误: ${data.msg} (ret: ${data.ret})`);
        return [];
      }

      let itemList = [];

      // 优先从 MainNeed box 获取结果
      if (data.data && data.data.areaBoxList) {
        for (const box of data.data.areaBoxList) {
          if (box.boxId === "MainNeed" && box.itemList) {
            log("info", `[Tencent] 从 MainNeed box 找到 ${box.itemList.length} 个项目`);
            itemList = box.itemList;
            break;
          }
        }
      }

      // 回退到 normalList
      if (itemList.length === 0 && data.data && data.data.normalList && data.data.normalList.itemList) {
        log("info", "[Tencent] MainNeed box 未找到，使用 normalList");
        itemList = data.data.normalList.itemList;
      }

      if (itemList.length === 0) {
        log("info", "[Tencent] 搜索无结果");
        return [];
      }

      // 过滤和处理搜索结果
      const results = [];
      for (const item of itemList) {
        const filtered = this.filterTencentSearchItem(item, keyword);
        if (filtered) {
          results.push(filtered);
        }
      }

      log("info", `[Tencent] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Tencent] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Tencent] 获取分集列表: cid=${id}`);

      const episodesUrl = "https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vversion_name=8.2.96&vversion_platform=2";

      // 先获取分页信息
      const payload = {
        has_cache: 1,
        page_params: {
          req_from: "web_vsite",
          page_id: "vsite_episode_list",
          page_type: "detail_operation",
          id_type: "1",
          page_size: "",
          cid: id,
          vid: "",
          lid: "",
          page_num: "",
          page_context: `cid=${id}&detail_page_type=1&req_from=web_vsite&req_from_second_type=&req_type=0`,
          detail_page_type: "1"
        }
      };

      const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://v.qq.com',
        'Referer': `https://v.qq.com/x/cover/${id}.html`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      };

      const response = await httpPost(episodesUrl, JSON.stringify(payload), { headers });

      if (!response || !response.data) {
        log("info", "[Tencent] 分集响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (data.ret !== 0) {
        log("error", `[Tencent] 分集API返回错误: ret=${data.ret}`);
        return [];
      }

      // 解析分页tabs
      let tabs = [];
      if (data.data && data.data.module_list_datas) {
        for (const moduleListData of data.data.module_list_datas) {
          for (const moduleData of moduleListData.module_datas) {
            if (moduleData.module_params && moduleData.module_params.tabs) {
              try {
                tabs = JSON.parse(moduleData.module_params.tabs);
                break;
              } catch (e) {
                log("error", "[Tencent] 解析tabs失败:", e.message);
              }
            }
          }
          if (tabs.length > 0) break;
        }
      }

      // 获取所有分页的分集
      const allEpisodes = [];

      if (tabs.length === 0) {
        log("info", "[Tencent] 未找到分页信息,尝试从初始响应中提取分集");

        // 尝试直接从第一次响应中提取分集(单页情况)
        if (data.data && data.data.module_list_datas) {
          for (const moduleListData of data.data.module_list_datas) {
            for (const moduleData of moduleListData.module_datas) {
              if (moduleData.item_data_lists && moduleData.item_data_lists.item_datas) {
                for (const item of moduleData.item_data_lists.item_datas) {
                  if (item.item_params && item.item_params.vid && item.item_params.is_trailer !== "1") {
                    allEpisodes.push({
                      vid: item.item_params.vid,
                      title: item.item_params.title,
                      unionTitle: item.item_params.union_title || item.item_params.title
                    });
                  }
                }
              }
            }
          }
        }

        if (allEpisodes.length === 0) {
          log("info", "[Tencent] 初始响应中也未找到分集信息");
          return [];
        }

        log("info", `[Tencent] 从初始响应中提取到 ${allEpisodes.length} 集`);
      } else {
        log("info", `[Tencent] 找到 ${tabs.length} 个分页`);

        // 获取所有分页的分集
        for (const tab of tabs) {
          if (!tab.page_context) continue;

          const tabPayload = {
            has_cache: 1,
            page_params: {
              req_from: "web_vsite",
              page_id: "vsite_episode_list",
              page_type: "detail_operation",
              id_type: "1",
              page_size: "",
              cid: id,
              vid: "",
              lid: "",
              page_num: "",
              page_context: tab.page_context,
              detail_page_type: "1"
            }
          };

          const tabResponse = await httpPost(episodesUrl, JSON.stringify(tabPayload), { headers });

          if (!tabResponse || !tabResponse.data) continue;

          const tabData = typeof tabResponse.data === "string" ? JSON.parse(tabResponse.data) : tabResponse.data;

          if (tabData.ret !== 0 || !tabData.data) continue;

          // 提取分集
          if (tabData.data.module_list_datas) {
            for (const moduleListData of tabData.data.module_list_datas) {
              for (const moduleData of moduleListData.module_datas) {
                if (moduleData.item_data_lists && moduleData.item_data_lists.item_datas) {
                  for (const item of moduleData.item_data_lists.item_datas) {
                    if (item.item_params && item.item_params.vid && item.item_params.is_trailer !== "1") {
                      allEpisodes.push({
                        vid: item.item_params.vid,
                        title: item.item_params.title,
                        unionTitle: item.item_params.union_title || item.item_params.title
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      log("info", `[Tencent] 共获取 ${allEpisodes.length} 集`);
      return allEpisodes;

    } catch (error) {
      log("error", "[Tencent] 获取分集出错:", error.message);
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Tencent] sourceAnimes is not a valid array");
      return [];
    }

    // 使用 map 和 async 时需要返回 Promise 数组，并等待所有 Promise 完成
    const processTencentAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          let links = [];

          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const epTitle = ep.unionTitle || ep.title || `第${i + 1}集`;
            // 构建完整URL: https://v.qq.com/x/cover/{cid}/{vid}.html
            const fullUrl = `https://v.qq.com/x/cover/${anime.mediaId}/${ep.vid}.html`;
            links.push({
              "name": (i + 1).toString(),
              "url": fullUrl,
              "title": `【qq】 ${epTitle}`
            });
          }

          if (links.length > 0) {
            // 将字符串mediaId转换为数字ID (使用哈希函数)
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year})【${anime.type}】from tencent`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "tencent",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Tencent] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processTencentAnimes;
  }

  // 提取vid的公共函数
  extractVid(id) {
    let vid = id;
    // 如果传入的是完整URL，则从中提取vid
    if (typeof id === 'string' && (id.startsWith('http') || id.includes('vid='))) {
      // 1. 尝试从查询参数中提取 vid
      const queryMatch = id.match(/[?&]vid=([^&]+)/);
      if (queryMatch) {
        vid = queryMatch[1]; // 获取 vid 参数值
      } else {
        // 2. 从路径末尾提取 vid
        const pathParts = id.split('/');
        const lastPart = pathParts[pathParts.length - 1];
        vid = lastPart.split('.')[0]; // 去除文件扩展名
      }
    }
    return vid;
  }

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求腾讯视频弹幕...", id);

    // 解析 URL 获取 vid
    let vid = this.extractVid(id);

    log("info", `vid: ${vid}`);

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
      promises.push(
        httpGet(segment.url, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          retries: 1,
        })
      );
    }

    // 解析弹幕数据
    let contents = [];
    try {
      const results = await Promise.allSettled(promises);
      const datas = results
        .filter(result => result.status === "fulfilled")
        .map(result => {
          // 检查result是否包含响应数据
          if (result.value && result.value.data) {
            return result.value.data;
          }
          return null;
        })
        .filter(data => data !== null); // 过滤掉null值

      datas.forEach(data => {
        data = typeof data === "string" ? JSON.parse(data) : data;
        contents.push(...data.barrage_list);
      });
    } catch (error) {
      log("error", "解析弹幕数据失败:", error);
      return [];
    }

    printFirst200Chars(contents);

    return contents;
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取腾讯视频弹幕分段列表...", id);

    // 弹幕 API 基础地址
    const api_danmaku_base = "https://dm.video.qq.com/barrage/base/";
    const api_danmaku_segment = "https://dm.video.qq.com/barrage/segment/";

    let vid = this.extractVid(id);

    log("info", `获取弹幕分段列表 - vid: ${vid}`);

    // 获取弹幕基础数据
    let res;
    try {
      res = await httpGet(api_danmaku_base + vid, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
    } catch (error) {
      if (error.response?.status === 404) {
        return new SegmentListResponse({
          "type": "qq",
          "segmentList": []
        });
      }
      log("error", "请求弹幕基础数据失败:", error);
      return new SegmentListResponse({
        "type": "qq",
        "segmentList": []
      });
    }

    // 先把 res.data 转成 JSON
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

    // 构建分段列表
    const segmentList = [];
    const segmentItems = Object.values(data.segment_index);
    for (const item of segmentItems) {
      segmentList.push({
        "type": "qq",
        "segment_start": (() => {
          const start = Number(item.segment_start) || 0;
          return start / 1000;
        })(),
        "segment_end": (() => {
          const end = Number(item.segment_name.split('/').pop()) || 0;
          return end / 1000;
        })(),
        "url": `${api_danmaku_segment}${vid}/${item.segment_name}`
      });
    }

    return new SegmentListResponse({
      "type": "qq",
      "segmentList": segmentList
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
        contents.push(...parsedData.barrage_list);
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
        timepoint: item.time_offset / 1000,
        ct: 1,
        size: 25,
        color: 16777215,
        unixtime: Math.floor(Date.now() / 1000),
        uid: 0,
        content: item.content,
      };

      if (item.content_style && item.content_style !== "") {
        try {
          const content_style = JSON.parse(item.content_style);

          if (content_style.gradient_colors && content_style.gradient_colors.length > 0) {
            content.color = parseInt(content_style.gradient_colors[0].replace("#", ""), 16);
          } else if (content_style.color && content_style.color !== "ffffff") {
            content.color = parseInt(content_style.color.replace("#", ""), 16);
          }

          if (content_style.position === 2) {
            content.ct = 5;
          } else if (content_style.position === 3) {
            content.ct = 4;
          }
        } catch (e) {
          // JSON 解析失败，使用默认值
        }
      }

      return content;
    });
  }
}
