import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, buildQueryString } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';
import { searchDoubanTitles } from '../utils/douban-util.js';

// =====================
// 获取西瓜视频弹幕
// =====================
class XiguaSource extends BaseSource {
  static get DEFAULT_PARAMS() {
    return {
      aid: '6383',
      browser_language: 'zh-CN',
      browser_name: 'Chrome',
      browser_online: 'true',
      browser_platform: 'Win32',
      browser_version: '143.0.0.0',
      channel: 'channel_pc_web',
      cookie_enabled: 'true',
      count: '5',
      cpu_core_num: '8',
      device_memory: '8',
      device_platform: 'webapp',
      disable_rs: '0',
      downlink: '10',
      effective_type: '4g',
      enable_history: '1',
      engine_name: 'Blink',
      engine_version: '143.0.0.0',
      from_group_id: '',
      is_filter_search: '0',
      keyword: '',
      list_type: '',
      need_filter_settings: '1',
      offset: '0',
      os_name: 'Windows',
      os_version: '10',
      pc_client_type: '1',
      pc_libra_divert: 'Windows',
      pc_search_top_1_params: '{"enable_ai_search_top_1":1}',
      platform: 'PC',
      query_correct_type: '1',
      round_trip_time: '50',
      screen_height: '1000',
      screen_width: '1500',
      search_channel: 'aweme_general',
      search_source: 'search_history',
      support_dash: '1',
      support_h265: '1',
      uifid: '5bdad390e71fd6e6e69e3cafe6018169c2447c8bc0b8484cc0f203a274f99fdb768a8c316d9404279513fcca88f12e4acf3daf31b4c0934dcd4d46cd5920c9d89bf45649141617920d4cdb2f3fdda79ac60881104f74e9b14137002479d35d2fd5e856ea254237dc0354a8b6ace97e28f2691a588ec6473fa26738653822bf3d5351084975e04ed4a489cf56fe39c626b0a45ade1ab50aeb053a0dd5bc5c8de1',
      update_version_code: '0',
      version_code: '190600',
      version_name: '19.6.0',
      webid: '7596462376888731182',
      msToken: '0l5NrxqxQknMMk-jYG9YLxmAGb2EuNqXAR6hI6PBKHT900nrwhVgUr2Qsx34KjMmSRbr0SovUrGe_ZsMGOd9h9COVa_sX-L9prlQ2gbXTiN5IM8OZrLz244mGWcsGN1MrAwlEf_yZGJdAhqM3dHgY-IzlCvb6pt-d0R3F6al1BE72jxhrgnJoQ==',
      a_bogus: 'xjURkz77ddR5FdFtmKO6HIQlwe2MNB8y0qT2W9VP7OYycHea7YPQ/NtDnoLtJVVU0mpzhedHBdBAGnxc0tXTZq9pzmkfuEwbFUQ99uvLMqNgTFkmLr8LewszKw0F0cTwl5cREARRIs0r2d5AVrIYlpIae5FqQYYdbrq6dZzbb9AxdSjH9xdXtBLAYqg='
    };
  }

  static get DEFAULT_HEADERS() {
    return {
      "accept": "*/*",
      "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "priority": "u=1, i",
      "referer": "https://www.douyin.com/",
      "sec-ch-ua": `"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"Windows"`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0 Safari/537.36",
      "cookie": "hevc_supported=true; theme=%22light%22; enter_pc_once=1; UIFID_TEMP=5bdad390e71fd6e6e69e3cafe6018169c2447c8bc0b8484cc0f203a274f99fdb326bf4acda898300593c7e1f623bbba6500fe7dcbd7580d07a0e68fae95833a2f13084b12c6516e48ba9dd9ac43afcbe; douyin.com; device_web_cpu_core=8; device_web_memory_size=8; architecture=amd64; dy_swidth=1500; dy_sheight=1000; s_v_web_id=verify_mkivx1g8_9KjTnLMj_TDJH_4fz2_8ToU_y8BzctbKlL1r; odin_tt=41ae383e3bd114cabe012357d66de720f737aa8e393883e9d4b2c99ced2439c5a7b54adc3acaa44b77a6433841f9ad26c4b81619621774ab36f28a176791898336ffb503984b2cf1c9c7f6b4459ea044; strategyABtestKey=%221768689261.175%22; passport_csrf_token=ed476f2b5f5e931e1e17614c5cde4d9f; passport_csrf_token_default=ed476f2b5f5e931e1e17614c5cde4d9f; fpk1=U2FsdGVkX1/JAy5WNCrhFBjMkHT7B/7RlpR7d+vVcwXZczWmM9lcMBs5CwLEsScBe7Dsatiu6TIin3dMn36ujA==; fpk2=89db729cfcdc129111f017b0e7ac324a; __security_mc_1_s_sdk_crypt_sdk=edb86c34-4aca-ac4b; bd_ticket_guard_client_web_domain=2; is_dash_user=1; __ac_nonce=0696c0e7100ef6667155b; __ac_signature=_02B4Z6wo00f01VLtuUQAAIDC30UAzY-BQSlSzb3AAD3b83; UIFID=5bdad390e71fd6e6e69e3cafe6018169c2447c8bc0b8484cc0f203a274f99fdb768a8c316d9404279513fcca88f12e4acf3daf31b4c0934dcd4d46cd5920c9d89bf45649141617920d4cdb2f3fdda79ac60881104f74e9b14137002479d35d2fd5e856ea254237dc0354a8b6ace97e28f2691a588ec6473fa26738653822bf3d5351084975e04ed4a489cf56fe39c626b0a45ade1ab50aeb053a0dd5bc5c8de1; download_guide=%221%2F20260118%2F0%22; IsDouyinActive=true; stream_recommend_feed_params=%22%7B%5C%22cookie_enabled%5C%22%3Atrue%2C%5C%22screen_width%5C%22%3A1500%2C%5C%22screen_height%5C%22%3A1000%2C%5C%22browser_online%5C%22%3Atrue%2C%5C%22cpu_core_num%5C%22%3A8%2C%5C%22device_memory%5C%22%3A8%2C%5C%22downlink%5C%22%3A10%2C%5C%22effective_type%5C%22%3A%5C%224g%5C%22%2C%5C%22round_trip_time%5C%22%3A50%7D%22; bd_ticket_guard_client_data=eyJiZC10aWNrZXQtZ3VhcmQtdmVyc2lvbiI6MiwiYmQtdGlja2V0LWd1YXJkLWl0ZXJhdGlvbi12ZXJzaW9uIjoxLCJiZC10aWNrZXQtZ3VhcmQtcmVlLXB1YmxpYy1rZXkiOiJCT29LQnc3cGI1UDA3SXVjSGF3Q1VzdWJIbTNKQW9iRzBoc3JkUmEyVTZ3d3NSbXhaTm1hL0c0N0JpSTQyc0JDaW0xQXBValJWZVBCV0RralIzRm5rd3M9IiwiYmQtdGlja2V0LWd1YXJkLXdlYi12ZXJzaW9uIjoyfQ%3D%3D; bd_ticket_guard_client_data_v2=eyJyZWVfcHVibGljX2tleSI6IkJPb0tCdzdwYjVQMDdJdWNIYXdDVXN1YkhtM0pBb2JHMGhzcmRSYTJVNnd3c1JteFpObWEvRzQ3QmlJNDJzQkNpbTFBcFVqUlZlUEJXRGtqUjNGbmt3cz0iLCJyZXFfY29udGVudCI6InNlY190cyIsInJlcV9zaWduIjoiaUZHdTNQNWhVM1p4bTE3cTlkUmJVbllZVUpjSGJGb2E2eHR6RnZNOVBYOD0iLCJzZWNfdHMiOiIjSHhKR3JqV1k5Q0tDVUdnL0M4b1d1ZGlYaVRxdHQxRDAxRmw4cDQ2T1lMVXkxWHp6a0tDeVBkRGVGV3NxIn0%3D; ttwid=1%7CFWlhAsF-KoGxsgQ9EqefnyQvtJIYKld-ph__Q9cOo1s%7C1768689835%7C35d17bdcfb25121d74d9ab3c196dbbf8c4b018635513ea702dae85eee8ab6ebc; biz_trace_id=5228a940; sdk_source_info=7e276470716a68645a606960273f276364697660272927676c715a6d6069756077273f276364697660272927666d776a68605a607d71606b766c6a6b5a7666776c7571273f275e5927666d776a686028607d71606b766c6a6b3f2a2a6a6f646363756d67636861646c66616e646d6b686c6d6c7566696860756a6e2a767164716c662a6f762a726a776e6077762b686c6b2b6f765927295927666d776a686028607d71606b766c6a6b3f2a2a6a6b607568647563676f6a6d6b60626168636d6b617560636f6e7575676f6e682a76682b6706b6169602b6f76592758272927666a6b766a69605a696c6061273f27636469766027292762696a6764695a7364776c6467696076273f275e582729277672715a646971273f2763646976602729277f6b5a666475273f2763646976602729276d6a6e5a6b6a716c273f2763646976602729276c6b6f5a7f6367273f27636469766027292771273f2733323531313d3c3d333d33234272927676c715a75776a716a666a69273f2763646976602778; bit_env=fhHsgC-D59fxwo1htOX9PqtjoLeQTGMPs2xSgYg3wgjDYNIPeyod0n9nJjPeUCICSQo38bu_1StrlP84kRKr27KShE047uVirtsW_9dyC7WalmzVk515ngDsuKgRvMry5oMQBd__NcymHfpIupKQeULTWwmserVKe-FaoX_nKu95PXEaxodj84i13Z7zaMPwjw5P558BGuTNiwYXBGeB7vbu4joQzz6o8LV-wimw_E-GgYi1W-9b01g9p9UV4wLh3ifbqyXmat3Uiub2d9T9PWFnQe2HEWdNjD3dGqXbi4D59lI4UopPnF99x4uJ_BNQF_-jY_eT6aML11ViPnTrZgGrhfq62UxsMWdj3MtrPGyK1C0MvWd4O-SqKUOMpImcAmqI2UGj1RCiX6q1_YCxTUP0SnqZcAYccCHWKEgdxVvmKIhjXBXtGFaCUd9nCPhXlaASWXPtw1pcim1RVIZLGngLSGnOYF4lhcQ0qFpRXAeWgwHSBEHGXPxglAJb6IxW; gulu_source_res=eyJwX2luIjoiMzRlYjBiNWI5YTNlY2RkMjY3ZGQzOTBkNjhjMjk1MGIzMjY2YmUyMDc3MWViYmZlMTIzNDM4ZDMxZmNkYTVjOCJ9; passport_auth_mix_state=sf4nq687herp6h2dofu6564iq8n4yc6kkgsnkhk53xivv6ux; home_can_add_dy_2_desktop=%221%22"
    };
  }

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
      const detailQueryString = buildQueryString({...XiguaSource.DEFAULT_PARAMS, episode_id: '6551333775446376974'});
      const detailUrl = `https://www.douyin.com/aweme/v1/web/long/video/detail/?${detailQueryString}`;
      
      const resp = await httpGet(detailUrl, {
        headers: XiguaSource.DEFAULT_HEADERS
      });

      // 判断 resp 和 resp.data 是否存在
      if (!resp || !resp.data) {
        log("info", "getXiguaDetail: 请求失败或无数据返回");
        return [];
      }

      // 判断 aweme_detail 是否存在
      if (!resp.data.aweme_detail) {
        log("info", "getXiguaDetail: aweme_detail 不存在");
        return [];
      }

      // 正常情况下输出 JSON 字符串
      log("info", `getXiguaDetail: ${JSON.stringify(resp.data.aweme_detail)}`);
      console.log(resp.data?.aweme_detail?.aweme_id);

      return resp.data.aweme_detail;
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
      // const metaQueryString = buildQueryString({
      //   ...XiguaSource.DEFAULT_PARAMS, 
      //   album_id: "6551332131417620995", 
      //   aweme_id_current: "7129807005509815588",
      //   episode_id_current: "6551333775349907981",
      // });
      // const metaUrl = `https://www.douyin.com/aweme/v1/web/long/video/meta/?${metaQueryString}`;
      
      // const metaResp = await httpGet(metaUrl, {
      //   headers: XiguaSource.DEFAULT_HEADERS
      // });

      // console.log(metaResp.data);

      const detailUrl = `https://m.ixigua.com/video/${id}`;
      console.log(detailUrl);

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
    let allDanmus = [];
    let fromAxis = 0;
    const maxAxis = 100000000;

    try {
      while (fromAxis < maxAxis) {
        const resp = await httpGet(`https://hxqapi.zmdcq.com/api/danmu/playItem/list?fromAxis=${fromAxis}&pid=${id}&toAxis=${maxAxis}`, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          retries: 1,
        });

        // 将当前请求的 episodes 拼接到总数组
        if (resp.data && resp.data.danmus) {
          allDanmus = allDanmus.concat(resp.data.danmus);
        }

        // 获取 nextAxis，更新 fromAxis
        const nextAxis = resp.data.nextAxis || maxAxis;
        if (nextAxis >= maxAxis) {
          break; // 如果 nextAxis 达到或超过最大值，退出循环
        }
        fromAxis = nextAxis;
      }

      return allDanmus;
    } catch (error) {
      // 捕获请求中的错误
      log("error", "fetchHanjutvEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return allDanmus; // 返回已收集的 episodes
    }
  }

  async getEpisodeDanmuSegments(id) {
    log("info", "获取西瓜视频弹幕分段列表...", id);

    return new SegmentListResponse({
      "type": "hanjutv",
      "segmentList": [{
        "type": "hanjutv",
        "segment_start": 0,
        "segment_end": 30000,
        "url": id
      }]
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    const danmuQueryString = buildQueryString({
      ...XiguaSource.DEFAULT_PARAMS, 
      group_id: "7129808463454113054", 
      item_id: "7129808463454113054",
      start_time: 32000,
    });
    const danmuUrl = `https://www.douyin.com/aweme/v1/web/danmaku/get_v2/?${danmuQueryString}`;
    
    const danmunResp = await httpGet(danmuUrl, {
      headers: XiguaSource.DEFAULT_HEADERS
    });

    console.log(danmunResp.data);
    return danmunResp.data;
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.did),
      p: `${(c.t / 1000).toFixed(2)},${c.tp === 2 ? 5 : c.tp},${Number(c.sc)},[hanjutv]`,
      m: c.con,
      t: Math.round(c.t / 1000)
    }));
  }

}

export default XiguaSource;
