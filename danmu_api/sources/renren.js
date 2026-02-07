import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { getPathname, httpGet, sortedQueryString, updateQueryString } from "../utils/http-util.js";
import { autoDecode, createHmacSha256, generateSign } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取人人视频弹幕
// =====================


// 模块级状态管理 (Instance Level State)
// 缓存当前的 AliID (全局共享，跨请求持久化，模拟设备指纹)
let CACHED_ALI_ID = null;
// 当前 AliID 已请求次数
let REQUEST_COUNT = 0;
// 触发轮换的阈值 (将在 30-60 之间随机生成)
let ROTATION_THRESHOLD = 0;

/**
 * 人人视频弹幕源
 * 集成 TV 端 API 协议，保留网页版接口作为降级容灾策略。
 * 兼容处理 SeriesId-EpisodeId 复合主键，确保弹幕与剧集详情的关联正确性。
 */
export default class RenrenSource extends BaseSource {
  constructor() {
    super();
    // 实例级标记：当前是否处于批量请求模式
    // 在此模式下（例如处理 handleAnimes 列表遍历），内部的 AliID 获取请求暂时不增加计数
    // 直到批量操作结束（finally 块）时，才统一结算一次计数
    this.isBatchMode = false;
  }

  // API 配置常量
  API_CONFIG = {
    SECRET_KEY: "cf65GPholnICgyw1xbrpA79XVkizOdMq",
    
    // TV 端接口配置
    TV_HOST: "api.gorafie.com",
    TV_DANMU_HOST: "static-dm.qwdjapp.com",
    TV_VERSION: "1.2.2",
    TV_USER_AGENT: 'okhttp/3.12.13',
    TV_CLIENT_TYPE: 'android_qwtv_RRSP',
    TV_PKT: 'rrmj',

    // 网页版/旧版接口配置 (降级备用)
    WEB_HOST: "api.rrmj.plus",
    WEB_DANMU_HOST: "static-dm.rrmj.plus"
  };

  /**
   * 生成随机的 aliid
   * 规律：24位长度，以 'aY' 开头，包含字母数字和 Base64 特殊字符
   * 模拟抓包数据：aYN4D0XfSREDAJaw3UAjG33K
   */
  generateRandomAliId() {
    const prefix = "aY";
    const length = 24 - prefix.length;
    // 标准 Base64 字符集
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = prefix;
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 执行 ID 轮换/初始化
   * 生成新的 ID，重置计数器，并随机生成下一次的轮换阈值
   */
  rotateAliId() {
    const oldId = CACHED_ALI_ID;
    CACHED_ALI_ID = this.generateRandomAliId();
    REQUEST_COUNT = 0; // 重置计数
    // 生成 30 到 60 之间的随机整数作为阈值
    ROTATION_THRESHOLD = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
    
    if (oldId) {
        log("info", `[Renren] AliID 轮换完成: ${oldId} -> ${CACHED_ALI_ID}`);
    } else {
        log("info", `[Renren] AliID 初始化完成: ${CACHED_ALI_ID}`);
    }
    log("info", `[Renren] AliID 下次轮换将在 ${ROTATION_THRESHOLD} 次操作后触发`);
  }

  /**
   * 检查并增加计数 (核心逻辑)
   * 负责监控使用次数，达到阈值时触发轮换
   * 并在日志中明确输出 AliID 计数状态
   */
  checkAndIncrementUsage() {
    // 1. 如果 ID 未初始化，强制初始化
    if (!CACHED_ALI_ID) {
      this.rotateAliId();
    }

    // 2. 检查阈值，决定是否轮换
    if (REQUEST_COUNT >= ROTATION_THRESHOLD) {
      log("info", `[Renren] AliID 触发阈值 (${REQUEST_COUNT}/${ROTATION_THRESHOLD})，正在轮换 ID...`);
      this.rotateAliId();
    }

    // 3. 增加计数
    REQUEST_COUNT++;
    // 输出明确的计数日志，方便排查
    log("info", `[Renren] AliID 计数增加: ${REQUEST_COUNT}/${ROTATION_THRESHOLD} (当前ID: ...${CACHED_ALI_ID.slice(-6)})`);
  }

  /**
   * 获取有效的 aliid
   * 根据 isBatchMode 决定是否增加计数
   */
  getAliId() {
    // 兜底：确保 ID 存在
    if (!CACHED_ALI_ID) {
      this.rotateAliId();
    }

    // 如果处于批量模式，直接返回当前 ID，不增加计数
    // 逻辑：批量模式（如详情遍历）会在结束时统一调用一次 checkAndIncrementUsage 进行结算
    // 所以过程中获取 ID 是“免费”的，避免一次搜索消耗几十次计数
    if (this.isBatchMode) {
      return CACHED_ALI_ID;
    }

    // 普通模式（如单独的搜索请求），正常计数（预付费模式）
    this.checkAndIncrementUsage();
    return CACHED_ALI_ID;
  }

  /**
   * 生成 TV 端接口所需的请求头
   * 处理签名、设备标识及版本控制字段
   * @param {number} timestamp 当前时间戳
   * @param {string} sign 接口签名
   * @returns {Object} HTTP Headers
   */
  generateTvHeaders(timestamp, sign) {
    // 获取 aliid (包含动态轮换和批量锁定逻辑)
    const aliId = this.getAliId();

    return {
      'clientVersion': this.API_CONFIG.TV_VERSION,
      'p': 'Android',
      'deviceid': 'tWEtIN7JG2DTDkBBigvj6A%3D%3D', // 固定设备指纹
      'token': '', // 必须为空字符串以通过校验
      'aliid': aliId, // 使用动态aliId
      'umid': '',  // 必须为空字符串以通过校验
      'clienttype': this.API_CONFIG.TV_CLIENT_TYPE,
      'pkt': this.API_CONFIG.TV_PKT,
      't': timestamp.toString(),
      'sign': sign,
      'isAgree': '1',
      'et': '2',
      'Accept-Encoding': 'gzip',
      'User-Agent': this.API_CONFIG.TV_USER_AGENT,
    };
  }

  /**
   * 搜索剧集 (TV API)
   * @param {string} keyword 搜索关键词
   * @param {number} size 分页大小
   * @returns {Array} 统一格式的搜索结果列表
   */
  async searchAppContent(keyword, size = 30) {
    try {
      const timestamp = Date.now();
      const path = "/qwtv/search";
      const queryParams = {
        searchWord: keyword,
        num: size,
        searchNext: "",
        well: "match"
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === null || v === undefined ? "" : String(v))}`)
        .join('&');
      
      const headers = this.generateTvHeaders(timestamp, sign);

      const url = `https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`;
      // log("info", `[Renren] TV搜索请求: ${url}`);

      const resp = await httpGet(url, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data || resp.data.code !== "0000") {
        log("info", `[Renren] TV搜索接口异常: code=${resp?.data?.code}, msg=${resp?.data?.msg}`);
        return [];
      }

      const list = resp.data.data || [];
      log("info", `[Renren] TV搜索返回结果数量: ${list.length}`);

      return list.map((item) => ({
        provider: "renren",
        mediaId: String(item.id),
        title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
        type: "tv_series",
        season: null,
        year: item.year,
        imageUrl: item.cover,
        episodeCount: null, // 列表页不返回总集数
        currentEpisodeIndex: null,
      }));
    } catch (error) {
      log("info", "[Renren] searchAppContent error:", error.message);
      return [];
    }
  }

  /**
   * 获取剧集详情 (TV API)
   * @param {string} dramaId 剧集ID
   * @param {string} episodeSid 单集ID (可选)
   * @returns {Object} 详情数据对象
   */
  async getAppDramaDetail(dramaId, episodeSid = "") {
    try {
      const timestamp = Date.now();
      const path = "/qwtv/drama/details";
      const queryParams = {
        isAgeLimit: "false",
        seriesId: dramaId,
        episodeId: episodeSid,
        clarity: "HD",
        caption: "0",
        hevcOpen: "1"
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      
      const headers = this.generateTvHeaders(timestamp, sign);

      const resp = await httpGet(`https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`, {
        headers: headers,
        retries: 1,
      });

      // 1. 基础网络或数据校验
      if (!resp || !resp.data) {
        log("info", `[Renren] TV详情接口网络无响应或数据为空: ID=${dramaId}`);
        return null;
      }
      
      const resData = resp.data;
      const msg = resData.msg || resData.message || "";

      // 2. 检测特定维护信息 "该剧暂不可播"
      // 这通常意味着 App 接口正在维护或该资源被下架，必须降级到 Web 版
      if (msg.includes("该剧暂不可播")) {
          log("info", `[Renren] TV接口提示'该剧暂不可播' (ID=${dramaId})，视为维护中，触发Web降级`);
          return null; // 触发降级
      }

      // 3. 检测错误码
      if (resData.code !== "0000") {
        log("info", `[Renren] TV详情接口返回错误码: ${resData.code}, msg=${msg} (ID=${dramaId})`);
        return null;
      }

      // 4. 检测分集数据完整性 (关键修改：如果详情成功但没分集，也视为失败)
      if (!resData.data || !resData.data.episodeList || resData.data.episodeList.length === 0) {
        log("info", `[Renren] TV详情接口返回数据缺失分集列表 (ID=${dramaId})，尝试Web降级`);
        return null; // 触发降级
      }

      log("info", `[Renren] TV详情获取成功: ID=${dramaId}, 包含集数=${resData.data.episodeList.length}`);
      return resData;
    } catch (error) {
      log("info", "[Renren] getAppDramaDetail error:", error.message);
      return null;
    }
  }

  /**
   * 获取单集弹幕 (TV API)
   * 请求 static-dm.qwdjapp.com 获取全量弹幕数据
   * @param {string} episodeSid 单集ID (支持复合ID自动解包)
   * @returns {Array} 原始弹幕数据列表
   */
  async getAppDanmu(episodeSid) {
    try {
      const timestamp = Date.now();
      
      // 处理复合ID (SeriesId-EpisodeId)，提取真实的 EpisodeId
      let realEpisodeId = episodeSid;
      if (String(episodeSid).includes("-")) {
        realEpisodeId = String(episodeSid).split("-")[1];
      }

      // 构造请求路径 (注意：此处使用 EPISODE 路径，不包含 emo)
      const path = `/v1/produce/danmu/EPISODE/${realEpisodeId}`;
      const queryParams = {}; // 该接口无查询参数
      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const headers = this.generateTvHeaders(timestamp, sign);

      // 请求旧域名 static-dm.qwdjapp.com
      const url = `https://${this.API_CONFIG.TV_DANMU_HOST}${path}`;

      const resp = await httpGet(url, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data) return null;
      
      const data = autoDecode(resp.data);
      
      // 兼容直接返回数组或包装在 data 字段中的情况
      if (Array.isArray(data)) return data;
      if (data && data.data && Array.isArray(data.data)) return data.data;

      return [];
    } catch (error) {
      log("info", "[Renren] getAppDanmu error:", error.message);
      return null;
    }
  }

  /**
   * 执行网页版网络搜索 (降级逻辑)
   */
  async performNetworkSearch(keyword, { lockRef = null, lastRequestTimeRef = { value: 0 }, minInterval = 500 } = {}) {
    try {
      log("info", `[Renren] 尝试执行网页版搜索: ${keyword}`);
      const url = `https://${this.API_CONFIG.WEB_HOST}/m-station/search/drama`;
      const params = { 
        keywords: keyword, 
        size: 20, 
        order: "match", 
        search_after: "", 
        isExecuteVipActivity: true 
      };

      if (lockRef) {
        while (lockRef.value) await new Promise(r => setTimeout(r, 50));
        lockRef.value = true;
      }

      const now = Date.now();
      const dt = now - lastRequestTimeRef.value;
      if (dt < minInterval) await new Promise(r => setTimeout(r, minInterval - dt));

      const resp = await this.renrenRequest("GET", url, params);
      lastRequestTimeRef.value = Date.now();

      if (lockRef) lockRef.value = false;

      if (!resp.data) {
        log("info", "[Renren] 网页版搜索无响应数据");
        return [];
      }

      const decoded = autoDecode(resp.data);
      const list = decoded?.data?.searchDramaList || [];
      log("info", `[Renren] 网页版搜索结果数量: ${list.length}`);
      
      return list.map((item) => ({
        provider: "renren",
        mediaId: String(item.id),
        title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
        type: "tv_series",
        season: null,
        year: item.year,
        imageUrl: item.cover,
        episodeCount: item.episodeTotal,
        currentEpisodeIndex: null,
      }));
    } catch (error) {
      log("info", "[Renren] performNetworkSearch error:", error.message);
      return [];
    }
  }

  // =====================
  // 标准接口实现 (BaseSource 抽象方法)
  // =====================

  async search(keyword) {
    log("info", `[Renren] 开始搜索: ${keyword}`);
    const parsedKeyword = { title: keyword, season: null };
    const searchTitle = parsedKeyword.title;
    const searchSeason = parsedKeyword.season;

    let allResults = [];
    
    // 1. 优先使用 TV 接口
    allResults = await this.searchAppContent(searchTitle);
    
    // 2. 降级策略: 若 TV 接口无结果，尝试网页接口
    if (allResults.length === 0) {
      log("info", "[Renren] TV 搜索无结果，降级到网页接口");
      const lock = { value: false };
      const lastRequestTime = { value: 0 };
      allResults = await this.performNetworkSearch(searchTitle, { 
        lockRef: lock, 
        lastRequestTimeRef: lastRequestTime, 
        minInterval: 400 
      });
    }

    if (searchSeason == null) return allResults;

    return allResults.filter(r => r.season === searchSeason);
  }

  async getDetail(id) {
    // 1. 优先使用 TV 接口
    const resp = await this.getAppDramaDetail(String(id));
    if (resp && resp.data) {
      return resp.data;
    }
    
    // 2. 降级策略: 尝试网页接口
    log("info", `[Renren] TV详情不可用，尝试请求网页版接口 (ID=${id})`); 
    const url = `https://${this.API_CONFIG.WEB_HOST}/m-station/drama/page`;
    const params = { hsdrOpen: 0, isAgeLimit: 0, dramaId: String(id), hevcOpen: 1 };
    
    try {
      const fallbackResp = await this.renrenRequest("GET", url, params);
      if (!fallbackResp.data) return null;
      
      const decoded = autoDecode(fallbackResp.data);
      if (decoded && decoded.data) {
         log("info", `[Renren] 网页版详情获取成功: 包含集数=${decoded.data.episodeList ? decoded.data.episodeList.length : 0}`);
         return decoded.data;
      }
      return null;
    } catch (e) {
      log("info", `[Renren] 网页版详情请求失败: ${e.message}`);
      return null;
    }
  }

  async getEpisodes(id) {
    log("info", `[Renren] 正在获取分集信息: ID=${id}`);
    const detail = await this.getDetail(id);
    
    if (!detail) {
      log("info", `[Renren] 获取分集失败: 详情对象为空 ID=${id}`);
      return [];
    }
    
    if (!detail.episodeList || !Array.isArray(detail.episodeList)) {
       log("info", `[Renren] 获取分集失败: episodeList 字段缺失或非数组 ID=${id}`);
       return [];
    }

    let episodes = [];
    const seriesId = String(id); 

    detail.episodeList.forEach((ep, idx) => {
      const epSid = String(ep.sid || "").trim();
      if (!epSid) return;
      
      const showTitle = ep.title ? String(ep.title) : `第${String(ep.episodeNo || idx + 1).padStart(2, "0")}集`;
      
      // 构建复合ID (SeriesId-EpisodeId)
      // TV弹幕接口需要EpisodeId，搜索可能需要SeriesId，保留此结构确保上下文完整
      const compositeId = `${seriesId}-${epSid}`;

      episodes.push({ sid: compositeId, order: ep.episodeNo || idx + 1, title: showTitle });
    });

    log("info", `[Renren] 成功解析分集数量: ${episodes.length} (ID=${id})`);

    return episodes.map(e => ({
      provider: "renren",
      episodeId: e.sid,
      title: e.title,
      episodeIndex: e.order,
      url: null
    }));
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("info", "[Renren] sourceAnimes is not a valid array");
      return [];
    }

    // [标记开始] 进入批量处理模式
    // 注意：此处不再输出冗余日志，也不扣费。开启静默模式。
    this.isBatchMode = true;
    
    try {
      await Promise.all(sourceAnimes
        .filter(s => titleMatches(s.title, queryTitle))
        .map(async (anime) => {
          try {
            // 在此块中调用的 getEpisodes -> ... -> getAliId
            // 会因为 isBatchMode=true 而直接返回缓存ID，不增加计数
            const eps = await this.getEpisodes(anime.mediaId);
            
            let links = [];
            for (const ep of eps) {
              links.push({
                "name": ep.episodeIndex.toString(),
                "url": ep.episodeId,
                "title": `【${ep.provider}】 ${ep.title}`
              });
            }

            if (links.length > 0) {
              let transformedAnime = {
                animeId: Number(anime.mediaId),
                bangumiId: String(anime.mediaId),
                animeTitle: `${anime.title}(${anime.year})【${anime.type}】from renren`,
                type: anime.type,
                typeDescription: anime.type,
                imageUrl: anime.imageUrl,
                startDate: generateValidStartDate(anime.year),
                episodeCount: links.length,
                rating: 0,
                isFavorited: true,
                source: "renren",
              };

              tmpAnimes.push(transformedAnime);
              addAnime({ ...transformedAnime, links: links });

              if (globals.animes.length > globals.MAX_ANIMES) {
                removeEarliestAnime();
              }
            }
          } catch (error) {
            log("info", `[Renren] Error processing anime: ${error.message}`);
          }
        })
      );
    } finally {
      // [标记结束] 退出批量模式
      this.isBatchMode = false;
      // [结算扣费] 批量操作结束，统一结算一次 AliID 计数
      // 这样日志会出现在所有请求日志的末尾，符合“处理完毕，消耗一次”的直觉
      this.checkAndIncrementUsage();
    }

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  async getEpisodeDanmu(id) {
    // 1. 优先尝试 TV 接口
    let danmuList = await this.getAppDanmu(id);
    
    // 2. 降级策略: TV 接口无数据时，尝试网页版接口
    if (!danmuList || danmuList.length === 0) {
       log("info", "[Renren] TV 弹幕接口失败或无数据，尝试降级网页接口");
       danmuList = await this.getWebDanmuFallback(id);
    }
    
    // 3. 返回原始数据列表，BaseSource 会自动调用本类的 formatComments 进行格式化
    if (danmuList && Array.isArray(danmuList) && danmuList.length > 0) {
      log("info", `[Renren] 成功获取 ${danmuList.length} 条弹幕`);
      return danmuList;
    }

    return [];
  }

  /**
   * 获取网页版弹幕 (降级方法)
   * 自动处理复合 ID 的解包
   */
  async getWebDanmuFallback(id) {
    let realEpisodeId = id;
    if (String(id).includes("-")) {
      realEpisodeId = String(id).split("-")[1];
    }
    
    // 日志保留
    log("info", `[Renren] 降级网页版弹幕，使用 ID: ${realEpisodeId}`);

    const ClientProfile = {
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    
    const url = `https://${this.API_CONFIG.WEB_DANMU_HOST}/v1/produce/danmu/EPISODE/${realEpisodeId}`;
    const headers = {
      "Accept": "application/json",
      "User-Agent": ClientProfile.user_agent,
      "Origin": ClientProfile.origin,
      "Referer": ClientProfile.referer,
    };
    
    try {
      const fallbackResp = await this.renrenHttpGet(url, { headers });
      if (!fallbackResp.data) return [];
      
      const data = autoDecode(fallbackResp.data);
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data?.data && Array.isArray(data.data)) list = data.data;
      
      return list;
    } catch (e) {
      log("info", `[Renren] 网页版弹幕降级失败: ${e.message}`);
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    return new SegmentListResponse({
      "type": "renren",
      "segmentList": [{
        "type": "renren",
        "segment_start": 0,
        "segment_end": 30000,
        "url": id
      }]
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getEpisodeDanmu(segment.url);
  }

  // =====================
  // 数据解析与签名工具
  // =====================

  /**
   * 解析 RRSP 的 P 字段 (属性字符串)
   * 格式: timestamp,mode,size,color,uid,cid...
   * 使用安全数值转换，防止 NaN 污染导致数据被误去重
   */
  parseRRSPPFields(pField) {
    const parts = String(pField).split(",");
    
    // 安全数值转换工具：若解析结果为 NaN，则返回默认值
    const safeNum = (val, parser, defaultVal) => {
        if (val === undefined || val === null || val === "") return defaultVal;
        const res = parser(val);
        return isNaN(res) ? defaultVal : res;
    };
    
    const timestamp = safeNum(parts[0], parseFloat, 0); 
    const mode = safeNum(parts[1], x => parseInt(x, 10), 1);
    const size = safeNum(parts[2], x => parseInt(x, 10), 25);
    const color = safeNum(parts[3], x => parseInt(x, 10), 16777215); 
    
    const userId = parts[6] || "";
    const contentId = parts[7] || `${timestamp}:${userId}`;
    
    return { timestamp, mode, size, color, userId, contentId };
  }

  /**
   * 格式化弹幕列表为标准模型
   * 将原始 d/p 字段映射为系统内部对象
   * 兼容处理 item.d 和 item.content 内容字段
   */
  formatComments(comments) {
    return comments.map(item => {
      // 提取内容 (优先 d，兼容 content)
      let text = String(item.d || "");
      if (!text && item.content) text = String(item.content);
      
      if (!text) return null;

      // 提取属性 (p)
      if (item.p) {
        const meta = this.parseRRSPPFields(item.p);
        return {
          cid: Number(meta.contentId) || 0,
          p: `${meta.timestamp.toFixed(2)},${meta.mode},${meta.color},[renren]`,
          m: text,
          t: meta.timestamp
        };
      }
      return null;
    }).filter(Boolean);
  }

  /**
   * 生成网页版 API 签名
   */
  generateSignature(method, aliId, ct, cv, timestamp, path, sortedQuery, secret) {
    const signStr = `${method.toUpperCase()}\naliId:${aliId}\nct:${ct}\ncv:${cv}\nt:${timestamp}\n${path}?${sortedQuery}`;
    return createHmacSha256(secret, signStr);
  }

  /**
   * 构建网页版带签名的请求头
   */
  buildSignedHeaders({ method, url, params = {}, deviceId, token }) {
    const ClientProfile = {
      client_type: "web_pc",
      client_version: "1.0.0",
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    const pathname = getPathname(url);
    const qs = sortedQueryString(params);
    const nowMs = Date.now();
    const SIGN_SECRET = "ES513W0B1CsdUrR13Qk5EgDAKPeeKZY";
    const xCaSign = this.generateSignature(
      method, deviceId, ClientProfile.client_type, ClientProfile.client_version,
      nowMs, pathname, qs, SIGN_SECRET
    );
    return {
      clientVersion: ClientProfile.client_version,
      deviceId,
      clientType: ClientProfile.client_type,
      t: String(nowMs),
      aliId: deviceId,
      umid: deviceId,
      token: token || "",
      cv: ClientProfile.client_version,
      ct: ClientProfile.client_type,
      uet: "9",
      "x-ca-sign": xCaSign,
      Accept: "application/json",
      "User-Agent": ClientProfile.user_agent,
      Origin: ClientProfile.origin,
      Referer: ClientProfile.referer,
    };
  }

  async renrenHttpGet(url, { params = {}, headers = {} } = {}) {
    const u = updateQueryString(url, params);
    const resp = await httpGet(u, {
      headers: headers,
      retries: 1,
    });
    return resp;
  }

  generateDeviceId() {
    return (Math.random().toString(36).slice(2)).toUpperCase();
  }

  async renrenRequest(method, url, params = {}) {
    const deviceId = this.generateDeviceId();
    const headers = this.buildSignedHeaders({ method, url, params, deviceId });
    const resp = await httpGet(url + "?" + sortedQueryString(params), {
      headers: headers,
      retries: 1,
    });
    return resp;
  }
}
