import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { getPathname, httpGet, sortedQueryString, updateQueryString } from "../utils/http-util.js";
import { autoDecode, createHmacSha256, generateSign } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from "../utils/common-util.js";
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

// 接口健康状态缓存 (全局共享，跨请求持久化，实现业务级智能路由)
// Search: WIN -> TV -> MAC -> WEB
// Detail/Danmu: TV -> MAC -> WIN -> WEB
const API_HEALTH = {
  search: 'WIN',
  detail: 'TV',
  danmu: 'TV'
};

/**
 * 人人视频弹幕源
 * 集成 TV, Mac, Win 端 API 协议，保留网页版接口作为降级容灾策略。
 * 详情接口使用跨协议网关穿透技术绕过未知客户端密钥验证。
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

  // =====================
  // 1. API 综合配置常量
  // =====================

  API_CONFIG = {
    // 跨端通用核心加密密钥 (用于网关穿透等严格验签场景)
    TV_SECRET_KEY: "cf65GPholnICgyw1xbrpA79XVkizOdMq",

    // TV 端特征配置
    TV_HOST: "api.gorafie.com",
    TV_DANMU_HOST: "static-dm.qwdjapp.com",
    TV_VERSION: "1.2.2",
    TV_USER_AGENT: 'okhttp/3.12.13',
    TV_CLIENT_TYPE: 'android_qwtv_RRSP',
    TV_PKT: 'rrmj',

    // Mac 端特征配置
    MAC_HOST: "api.cluuid.cn",
    MAC_DANMU_HOST: "static-dm.lequkeji.com",
    MAC_VERSION: "1.2.3",
    MAC_USER_AGENT: '%E4%BA%BA%E4%BA%BA%E8%A7%86%E9%A2%91%20for%20Mac/1.0 CFNetwork/3860.600.21 Darwin/25.5.0',
    MAC_CLIENT_TYPE: 'mac_rrsp',

    // Win 端特征配置
    WIN_HOST: "api.pleasfun.com",
    WIN_DANMU_HOST: "static-dm.lequkeji.com",
    WIN_VERSION: "1.24.2",
    WIN_USER_AGENT: 'Boost.Beast/351',
    WIN_CLIENT_TYPE: 'win_rrsp_gw',

    // 网页版/旧版接口特征配置 (终极降级备用)
    WEB_HOST: "api.rrmj.plus",
    WEB_DANMU_HOST: "static-dm.rrmj.plus"
  };

  // =====================
  // 2. 身份指纹与轮换管控
  // =====================

  /**
   * 生成随机的 aliid (兼容 TV 端验证算法)
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
   * 生成 Mac 端格式的 UUID 设备指纹
   */
  generateMacAliId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16).toUpperCase();
    });
  }

  /**
   * 生成 Win 端格式的 32 位十六进制设备指纹
   */
  generateWinAliId() {
    return Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
  }

  /**
   * 动态生成一次性使用的网页版 DeviceId
   */
  generateDeviceId() {
    return (Math.random().toString(36).slice(2)).toUpperCase();
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

  // =====================
  // 3. 协议头构建与业务签名机制
  // =====================

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
   * 构建 Mac 端请求头
   */
  buildMacHeaders() {
    return {
      'aliId': this.generateMacAliId(),
      'ct': this.API_CONFIG.MAC_CLIENT_TYPE,
      'cv': this.API_CONFIG.MAC_VERSION,
      'token': '',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'User-Agent': this.API_CONFIG.MAC_USER_AGENT
    };
  }

  /**
   * 构建 Win 端请求头
   */
  buildWinHeaders() {
    return {
      'aliId': this.generateWinAliId(),
      'ct': this.API_CONFIG.WIN_CLIENT_TYPE,
      'cv': this.API_CONFIG.WIN_VERSION,
      'token': '',
      'Content-Type': 'application/json',
      'User-Agent': this.API_CONFIG.WIN_USER_AGENT
    };
  }

  /**
   * 生成网页版 API 业务校验字符串
   * 负责拼装各项客户端属性与业务参数结构，以供底层哈希算法加密使用
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

  // =====================
  // 4. 底层网络请求代理
  // =====================

  /**
   * 通用结构处理方法，用于接管无严密签名的独立节点弹幕响应
   * @param {string} url 目标请求地址
   * @param {Object} headers 携带端特征的请求头
   * @param {string} tierName 平台标识
   * @returns {Array} 弹幕列表或空
   */
  async fetchStandardDanmu(url, headers, tierName) {
    try {
      // 中间节点执行快速失败策略，移除 retries 控制
      const resp = await httpGet(url, { headers, validStatusCodes: [404] });

      // 校验 404 特征：若返回特定错误文本，说明服务器正常响应但该集确实无弹幕数据
      if (resp.status === 404) {
          if (resp.data && resp.data.error === "Document not found") {
              return []; 
          }
          log("info", `[Renren] ${tierName} 弹幕接口返回未知 404 响应，疑似接口失效`);
          return null; 
      }

      if (!resp.data) return null;

      const data = resp.data;
      if (Array.isArray(data)) return data;
      if (data && data.data && Array.isArray(data.data)) return data.data;

      return [];
    } catch (error) {
       log("info", `[Renren] ${tierName} 端弹幕拉取异常: ${error.message}`);
       return null;
    }
  }

  async renrenHttpGet(url, { params = {}, headers = {}, validStatusCodes = [] } = {}) {
    const u = updateQueryString(url, params);
    const resp = await httpGet(u, {
      headers: headers,
      retries: 1, // 网页端为终极兜底链路，保留重试容错机制
      validStatusCodes
    });
    return resp;
  }

  async renrenRequest(method, url, params = {}) {
    const deviceId = this.generateDeviceId();
    const headers = this.buildSignedHeaders({ method, url, params, deviceId });
    const resp = await httpGet(url + "?" + sortedQueryString(params), {
      headers: headers,
      retries: 1, // 网页端为终极兜底链路，保留重试容错机制
    });
    return resp;
  }

  // =====================
  // 5. 搜索业务层 (TV/MAC/WIN/WEB)
  // =====================

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

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.TV_SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === null || v === undefined ? "" : String(v))}`)
        .join('&');

      const headers = this.generateTvHeaders(timestamp, sign);

      const url = `https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`;

      const resp = await httpGet(url, { headers });

      if (!resp.data || resp.data.code !== "0000") {
        log("info", `[Renren] TV搜索接口异常: code=${resp?.data?.code}, msg=${resp?.data?.msg}`);
        return null;
      }

      const list = resp.data.data || [];

      return list.map((item) => {
        let aliases = [];
        if (item.highlights && item.highlights.alias) {
          aliases = item.highlights.alias.split(',').map(s => s.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
        }
        return {
          provider: "renren",
          mediaId: String(item.id),
          title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
          aliases: aliases,
          type: item.classify || "Renren",
          season: null,
          year: item.year,
          imageUrl: item.cover,
          episodeCount: null, // 列表页不返回总集数
          currentEpisodeIndex: null,
        };
      });
    } catch (error) {
      log("info", "[Renren] searchAppContent error:", error.message);
      return null;
    }
  }

  /**
   * 搜索剧集 (Mac API)
   * 返回独立扁平的剧集列表结果集
   */
  async performMacSearch(keyword, size = 20) {
    try {
      const path = "/search/v5/season";
      const params = { keywords: keyword, order: "match", search_after: "", size: size };
      const headers = this.buildMacHeaders();
      const queryString = sortedQueryString(params);
      const url = `https://${this.API_CONFIG.MAC_HOST}${path}?${queryString}`;

      const resp = await httpGet(url, { headers });
      if (!resp.data || resp.data.code !== "0000") {
        log("info", `[Renren] Mac端搜索接口异常: code=${resp?.data?.code}`);
        return null;
      }

      const list = resp.data.data || [];

      return list.map(item => {
        let aliases = [];
        if (item.highlights && item.highlights.alias) {
          aliases = item.highlights.alias.split(',').map(s => s.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
        }
        return {
          provider: "renren",
          mediaId: String(item.id),
          title: String(item.title || item.name || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
          aliases: aliases,
          type: item.classify || item.cat || "Renren",
          season: null,
          year: item.year || null,
          imageUrl: item.cover || item.cover3 || "",
          episodeCount: null,
          currentEpisodeIndex: null,
        };
      });
    } catch (error) {
       log("info", "[Renren] performMacSearch error:", error.message);
       return null;
    }
  }

  /**
   * 搜索剧集 (Win API)
   * 深度展平提取模糊查询项与独立合集项
   */
  async performWinSearch(keyword, size = 30) {
    try {
      const url = `https://${this.API_CONFIG.WIN_HOST}/search/comprehensive/precise-mixed`;
      const params = { keywords: keyword, searchAfter: "", size: size };
      const queryString = sortedQueryString(params);
      const headers = this.buildWinHeaders();

      const resp = await httpGet(`${url}?${queryString}`, { headers });
      if (!resp.data || resp.data.code !== "0000") {
        log("info", `[Renren] Win端搜索接口异常: code=${resp?.data?.code}`);
        return null;
      }

      const data = resp.data.data || {};
      let results = [];

      // 数据域提取
      const seasonList = data.seasonList || [];
      const fuzzySeasonList = data.fuzzySeasonList || [];
      const seriesList = data.seriesList || [];
      
      // 数据模型装载器
      const processItem = (item) => {
        let aliases = [];
        if (item.highlights && item.highlights.alias) {
          aliases = item.highlights.alias.split(',').map(s => s.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
        }
        return {
          provider: "renren",
          mediaId: String(item.id),
          title: String(item.title || item.alias || item.name || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
          aliases: aliases,
          type: item.classify || item.cat || "Renren",
          season: null,
          year: item.year || null,
          imageUrl: item.cover || item.coverUrl,
          episodeCount: null,
          currentEpisodeIndex: null,
        };
      };

      seasonList.forEach(item => results.push(processItem(item)));
      fuzzySeasonList.forEach(item => results.push(processItem(item)));
      
      seriesList.forEach(series => {
          if (series.seasonList && Array.isArray(series.seasonList)) {
              series.seasonList.forEach(seasonItem => {
                  results.push(processItem(seasonItem));
              });
          }
      });

      return results;
    } catch (error) {
       log("info", "[Renren] performWinSearch error:", error.message);
       return null;
    }
  }

  /**
   * 执行网页版网络搜索 (终极降级逻辑)
   */
  async performNetworkSearch(keyword, { lockRef = null, lastRequestTimeRef = { value: 0 }, minInterval = 500 } = {}) {
    try {
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
        return null;
      }

      const decoded = autoDecode(resp.data);
      const list = decoded?.data?.searchDramaList || [];

      return list.map((item) => {
        let aliases = [];
        if (item.highlights && item.highlights.alias) {
          aliases = item.highlights.alias.split(',').map(s => s.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
        }
        return {
          provider: "renren",
          mediaId: String(item.id),
          title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
          aliases: aliases,
          type: item.classify || "Renren",
          season: null,
          year: item.year,
          imageUrl: item.cover,
          episodeCount: item.episodeTotal,
          currentEpisodeIndex: null,
        };
      });
    } catch (error) {
      log("info", "[Renren] performNetworkSearch error:", error.message);
      return null;
    }
  }

  async search(keyword) {
    log("info", `[Renren] 开始搜索: ${keyword}`);

    let allResults = [];
    let hasValidResponse = false;

    const tiers = ['WIN', 'TV', 'MAC', 'WEB'];
    let currentTierIndex = tiers.indexOf(API_HEALTH.search);
    if (currentTierIndex === -1) currentTierIndex = 0;

    // 智能路由检测与降级回路
    for (let i = currentTierIndex; i < tiers.length; i++) {
        const tier = tiers[i];
        log("info", `[Renren] 尝试使用 ${tier} 端接口搜索`);

        try {
            let tierResults = null;
            if (tier === 'TV') {
                tierResults = await this.searchAppContent(keyword);
            } else if (tier === 'MAC') {
                tierResults = await this.performMacSearch(keyword);
            } else if (tier === 'WIN') {
                tierResults = await this.performWinSearch(keyword);
            } else if (tier === 'WEB') {
                const lock = { value: false };
                const lastRequestTime = { value: 0 };
                tierResults = await this.performNetworkSearch(keyword, { 
                    lockRef: lock, 
                    lastRequestTimeRef: lastRequestTime, 
                    minInterval: 400 
                });
            }

            // 区分「请求异常(null)」与「正常但无数据([])」
            if (tierResults !== null && Array.isArray(tierResults)) {
                hasValidResponse = true;
                allResults = tierResults;

                // 记录当前健康的接口层级
                if (API_HEALTH.search !== tier) {
                    log("info", `[Renren] 搜索域接口健康状态更新: ${API_HEALTH.search} -> ${tier}`);
                    API_HEALTH.search = tier;
                }

                break;
            } else {
                log("info", `[Renren] ${tier} 端搜索接口异常或请求失败，触发降级`);
            }
        } catch (e) {
            log("info", `[Renren] ${tier} 端搜索异常，触发降级: ${e.message}`);
        }
    }

    // 所有降级接口全部“异常报错”时，重置健康状态
    if (!hasValidResponse) {
        log("info", `[Renren] 搜索域所有降级接口均异常失败，重置健康状态至 WIN 端`);
        API_HEALTH.search = 'WIN';
    }

    return allResults;
  }

  // =====================
  // 6. 详情业务层 (TV/MAC/WIN/WEB)
  // =====================

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
        seriesId: String(dramaId),
        episodeId: String(episodeSid),
        clarity: "HD",
        caption: "0",
        hevcOpen: "1"
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.TV_SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      const headers = this.generateTvHeaders(timestamp, sign);

      const resp = await httpGet(`https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`, {
        headers: headers
      });

      // 1. 基础网络或数据校验
      if (!resp || !resp.data) {
        log("info", `[Renren] TV详情接口网络无响应或数据为空: ID=${dramaId}`);
        return null;
      }

      const resData = resp.data;
      const msg = resData.msg || resData.message || "";

      // 2. 检测特定维护信息 "该剧暂不可播"
      if (msg.includes("该剧暂不可播")) {
          log("info", `[Renren] TV接口提示'该剧暂不可播' (ID=${dramaId})，视为维护中，触发降级`);
          return null; 
      }

      // 3. 检测错误码
      if (resData.code !== "0000") {
        log("info", `[Renren] TV详情接口返回错误码: ${resData.code}, msg=${msg} (ID=${dramaId})`);
        return null;
      }

      // 4. 检测分集数据完整性，过滤“即将开播”
      if (!resData.data || !resData.data.episodeList || resData.data.episodeList.length === 0) {
        if (resData.data?.dramaInfo?.playStatus?.includes("即将开播")) {
            log("info", `[Renren] TV详情接口提示'即将开播' (ID=${dramaId})，视为空结果`);
            if (!resData.data.episodeList) resData.data.episodeList = [];
            return resData.data; 
        }
        log("info", `[Renren] TV详情接口返回数据缺失分集列表 (ID=${dramaId})，尝试降级`);
        return null; 
      }

      log("info", `[Renren] TV端详情获取与分集解析成功: ID=${dramaId}, 包含集数=${resData.data.episodeList.length}`);
      return resData.data;
    } catch (error) {
      log("info", "[Renren] getAppDramaDetail error:", error.message);
      return null;
    }
  }

  /**
   * 跨协议网关穿透获取详情数据
   * 将 TV 端的路径特征、加密参数与合法签名下发至目标 API 域名执行穿透请求，以绕过客户端独立密钥验证
   * @param {string} targetHost 目标网关域名 (Mac 或 Win)
   * @param {string} dramaId 剧集ID
   * @param {string} episodeSid 单集ID (可选)
   * @returns {Object} 详情数据对象
   */
  async getGatewayDramaDetail(targetHost, dramaId, episodeSid = "") {
    try {
      const timestamp = Date.now();
      // 使用 TV 端的接口路径，避开对目标端独立签名的依赖
      const path = "/qwtv/drama/details";
      const queryParams = {
        isAgeLimit: "false",
        seriesId: String(dramaId),
        episodeId: String(episodeSid),
        clarity: "HD",
        caption: "0",
        hevcOpen: "1"
      };

      // 使用 TV 端的私钥生成合法签名
      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.TV_SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      // 复用 TV 端特征的 Headers
      const headers = this.generateTvHeaders(timestamp, sign);

      // 请求发往目标网关
      const url = `https://${targetHost}${path}?${queryString}`;

      const resp = await httpGet(url, { headers });

      // 1. 基础网络或数据校验
      if (!resp || !resp.data) {
        log("info", `[Renren] 详情接口网络无响应或数据为空 (${targetHost}): ID=${dramaId}`);
        return null;
      }

      const resData = resp.data;
      const msg = resData.msg || resData.message || "";

      // 2. 检测特定维护信息 "该剧暂不可播"
      if (msg.includes("该剧暂不可播")) {
          log("info", `[Renren] 接口提示'该剧暂不可播' (${targetHost}) (ID=${dramaId})，视为维护中，触发降级`);
          return null;
      }

      // 3. 检测错误码
      if (resData.code !== "0000") {
        log("info", `[Renren] 详情接口返回错误码: ${resData.code}, msg=${msg} (${targetHost}) (ID=${dramaId})`);
        return null;
      }

      // 4. 检测分集数据完整性，过滤“即将开播”
      if (!resData.data || !resData.data.episodeList || resData.data.episodeList.length === 0) {
        if (resData.data?.dramaInfo?.playStatus?.includes("即将开播")) {
            log("info", `[Renren] 详情接口提示'即将开播' (${targetHost}) (ID=${dramaId})，视为空结果`);
            if (!resData.data.episodeList) resData.data.episodeList = [];
            return resData.data;
        }
        log("info", `[Renren] 详情接口返回数据缺失分集列表 (${targetHost}) (ID=${dramaId})，尝试降级`);
        return null;
      }

      log("info", `[Renren] 跨协议详情获取与分集解析成功 (${targetHost}): ID=${dramaId}, 包含集数=${resData.data.episodeList.length}`);
      return resData.data;
    } catch (error) {
      log("info", `[Renren] getGatewayDramaDetail error (${targetHost}):`, error.message);
      return null;
    }
  }

  /**
   * 详情获取 (网页端降级)
   */
  async getWebDramaDetailFallback(dramaId) {
    const url = `https://${this.API_CONFIG.WEB_HOST}/m-station/drama/page`;
    const params = { hsdrOpen: 0, isAgeLimit: 0, dramaId: String(dramaId), hevcOpen: 1 };

    try {
      const resp = await this.renrenRequest("GET", url, params);
      if (!resp.data) return null;

      const decoded = autoDecode(resp.data);
      if (decoded && decoded.data && decoded.data.episodeList && decoded.data.episodeList.length > 0) {
         log("info", `[Renren] 网页版详情获取与分集解析成功: ID=${dramaId}, 包含集数=${decoded.data.episodeList.length}`);
         return decoded.data;
      }
      return null;
    } catch (e) {
      log("info", `[Renren] 网页版详情请求失败: ${e.message}`);
      return null;
    }
  }

  async getDetail(id, episodeSid = "") {
    let detail = null;
    const tiers = ['TV', 'MAC', 'WIN', 'WEB'];

    let currentTierIndex = tiers.indexOf(API_HEALTH.detail);
    if (currentTierIndex === -1) currentTierIndex = 0;

    // 智能路由检测与降级回路
    for (let i = currentTierIndex; i < tiers.length; i++) {
        const tier = tiers[i];
        log("info", `[Renren] 尝试使用 ${tier} 端接口获取详情分集 (ID=${id})`);

        try {
            if (tier === 'TV') {
                detail = await this.getAppDramaDetail(String(id), String(episodeSid));
            } else if (tier === 'MAC') {
                detail = await this.getGatewayDramaDetail(this.API_CONFIG.MAC_HOST, String(id), String(episodeSid));
            } else if (tier === 'WIN') {
                detail = await this.getGatewayDramaDetail(this.API_CONFIG.WIN_HOST, String(id), String(episodeSid));
            } else if (tier === 'WEB') {
                detail = await this.getWebDramaDetailFallback(String(id));
            }

            if (detail) {
                // 记录当前健康的接口层级
                if (API_HEALTH.detail !== tier) {
                    log("info", `[Renren] 详情域接口健康状态更新: ${API_HEALTH.detail} -> ${tier}`);
                    API_HEALTH.detail = tier;
                }
                return detail;
            } else {
                log("info", `[Renren] ${tier} 详情接口失败或无数据，触发降级`);
            }
        } catch (e) {
            log("info", `[Renren] ${tier} 详情接口异常，触发降级: ${e.message}`);
        }
    }

    // 所有端点轮换完毕仍未获取到数据，重置健康状态
    log("info", `[Renren] 详情域所有降级接口均失败，重置健康状态至 TV 端`);
    API_HEALTH.detail = 'TV';
    return null;
  }

  async getEpisodes(id) {
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

    const resultEpisodes = episodes.map(e => ({
      provider: "renren",
      episodeId: e.sid,
      title: e.title,
      episodeIndex: e.order,
      url: null
    }));

    // 挂载详情页的原名、年份及类型属性，以供信息不全的搜索接口自动补全
    if (detail.dramaInfo) {
        if (detail.dramaInfo.enName) {
            resultEpisodes.enName = detail.dramaInfo.enName;
        }
        if (detail.dramaInfo.year) {
            resultEpisodes.year = detail.dramaInfo.year;
        }
        if (detail.dramaInfo.dramaType) {
            let dType = detail.dramaInfo.dramaType;
            let pType = detail.dramaInfo.plotType || "";
            
            if (dType === "TV") {
                dType = "电视剧";
            } else if (dType === "MOVIE") {
                // 特殊判定：如果是电影类型且剧情包含"动画"，则划分为剧场版
                if (pType.includes("动画")) {
                    dType = "剧场版";
                } else {
                    dType = "电影";
                }
            } else if (dType === "COMIC") {
                dType = "动画";
            } else if (dType === "VARIETY") {
                dType = "综艺";
            } else if (dType === "DOCUMENTARY") {
                dType = "纪录片";
            }
            
            resultEpisodes.type = dType;
        }
    }

    return resultEpisodes;
  }

  /**
   * 处理搜索结果
   * @param {Array} sourceAnimes 原始数据
   * @param {string} queryTitle 关键词
   * @param {Array} curAnimes 结果池
   * @param {Map} detailStore 详情缓存
   * @param {number|null} querySeason 目标季度
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("info", "[Renren] sourceAnimes is not a valid array");
      return [];
    }

    // 基础标题与季度匹配过滤 (增加别名匹配)
    let filteredAnimes = sourceAnimes.filter(s => {
      if (titleMatches(s.title, queryTitle, querySeason)) return true;
      if (s.aliases && Array.isArray(s.aliases)) {
          return s.aliases.some(alias => titleMatches(alias, queryTitle, querySeason));
      }
      return false;
    });

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
        log("info", `[Renren] 结果已命中目标季(第${resolvedQuerySeason}季)，跳过非目标季相关请求`);
      }
    }

    // 打印过滤合并后的结果日志
    const tierNameMap = { 'TV': 'TV', 'MAC': 'Mac', 'WIN': 'Win', 'WEB': '网页' };
    const currentTierName = tierNameMap[API_HEALTH.search] || '未知';
    log("info", `[Renren] ${currentTierName}端搜索提取结果数量: ${sourceAnimes.length} 有效结果数量：${filteredAnimes.length}`);

    // [标记开始] 进入批量处理模式
    // 注意：此处不再输出冗余日志，也不扣费。开启静默模式。
    this.isBatchMode = true;

    try {
      await Promise.all(filteredAnimes.map(async (anime) => {
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
              let aliases = anime.aliases || [];
              if (eps.enName && !aliases.includes(eps.enName)) {
                  aliases.push(eps.enName);
              }

              // 优先使用详情接口(eps)补全的精确年份，其次使用搜索结果的年份
              let finalYear = eps.year || anime.year || "";
              let finalType = eps.type || ((anime.type && anime.type !== "Renren") ? anime.type : "Renren");

              let transformedAnime = {
                animeId: Number(anime.mediaId),
                bangumiId: String(anime.mediaId),
                animeTitle: `${anime.title}(${finalYear})【${finalType}】from renren`,
                aliases: aliases,
                type: finalType,
                typeDescription: finalType,
                imageUrl: anime.imageUrl,
                startDate: generateValidStartDate(finalYear),
                episodeCount: links.length,
                rating: 0,
                isFavorited: true,
                source: "renren",
              };

              tmpAnimes.push(transformedAnime);
              addAnime({ ...transformedAnime, links: links }, detailStore);

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
      this.checkAndIncrementUsage();
    }

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  // =====================
  // 7. 弹幕业务层 (TV/MAC/WIN/WEB)
  // =====================

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
      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.TV_SECRET_KEY);
      const headers = this.generateTvHeaders(timestamp, sign);

      const url = `https://${this.API_CONFIG.TV_DANMU_HOST}${path}`;

      const resp = await httpGet(url, {
        headers: headers,
        validStatusCodes: [404] 
      });

      // 校验 404 特征：若返回特定错误文本，说明服务器正常响应但该集确实无弹幕数据
      if (resp.status === 404) {
          if (resp.data && resp.data.error === "Document not found") {
              return []; 
          }
          log("info", `[Renren] TV 弹幕接口返回未知 404 响应，疑似接口失效`);
          return null; 
      }

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
   * 获取单集弹幕 (Mac API)
   */
  async getMacDanmu(episodeSid) {
    const realEpisodeId = String(episodeSid).includes("-") ? String(episodeSid).split("-")[1] : episodeSid;
    const url = `https://${this.API_CONFIG.MAC_DANMU_HOST}/v1/produce/danmu/EPISODE/${realEpisodeId}`;
    const headers = { 'User-Agent': this.API_CONFIG.MAC_USER_AGENT, 'Accept': '*/*' };
    return this.fetchStandardDanmu(url, headers, 'MAC');
  }

  /**
   * 获取单集弹幕 (Win API)
   */
  async getWinDanmu(episodeSid) {
    const realEpisodeId = String(episodeSid).includes("-") ? String(episodeSid).split("-")[1] : episodeSid;
    const url = `https://${this.API_CONFIG.WIN_DANMU_HOST}/v1/produce/danmu/EPISODE/${realEpisodeId}`;
    const headers = { 'User-Agent': this.API_CONFIG.WIN_USER_AGENT };
    return this.fetchStandardDanmu(url, headers, 'WIN');
  }

  /**
   * 获取网页版弹幕 (终极降级方法)
   * 自动处理复合 ID 的解包
   */
  async getWebDanmuFallback(id) {
    let realEpisodeId = id;
    if (String(id).includes("-")) {
      realEpisodeId = String(id).split("-")[1];
    }

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
      const fallbackResp = await this.renrenHttpGet(url, { headers, validStatusCodes: [404] });

      // 校验 404 特征：若返回特定错误文本，说明服务器正常响应但该集确实无弹幕数据
      if (fallbackResp.status === 404) {
          if (fallbackResp.data && fallbackResp.data.error === "Document not found") {
              return []; 
          }
          log("info", `[Renren] WEB 弹幕接口返回未知 404 响应，疑似接口失效`);
          return null; 
      }

      if (!fallbackResp.data) return null;

      const data = autoDecode(fallbackResp.data);
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data?.data && Array.isArray(data.data)) list = data.data;

      return list;
    } catch (e) {
      log("info", `[Renren] 网页版弹幕降级失败: ${e.message}`);
      return null;
    }
  }

  async getEpisodeDanmu(id) {
    // 智能获取广告/片头时长以便偏移弹幕
    let adDurationMs = 0;
    if (String(id).includes("-")) {
        const [seriesId, realEpisodeId] = String(id).split("-");
        const detail = await this.getDetail(seriesId, realEpisodeId);
        if (detail && detail.watchInfo) {
            const playInfo = detail.watchInfo.m3u8 || detail.watchInfo.tria4kPlayInfo || {};
            const startingLength = parseInt(playInfo.startingLength) || 0;
            const openingLength = parseInt(playInfo.openingLength) || 0;
            // 综合判断：优先使用 startingLength（通常为前置广告时长），若为0则降级使用 openingLength
            adDurationMs = startingLength > 0 ? startingLength : (openingLength > 0 ? openingLength : 0);
        }
    }

    let danmuList = null;
    const tiers = ['TV', 'MAC', 'WIN', 'WEB'];
    
    let currentTierIndex = tiers.indexOf(API_HEALTH.danmu);
    if (currentTierIndex === -1) currentTierIndex = 0;

    // 智能路由检测与降级回路
    for (let i = currentTierIndex; i < tiers.length; i++) {
        const tier = tiers[i];
        log("info", `[Renren] 尝试使用 ${tier} 端接口获取弹幕`);

        try {
            if (tier === 'TV') {
                danmuList = await this.getAppDanmu(id);
            } else if (tier === 'MAC') {
                danmuList = await this.getMacDanmu(id);
            } else if (tier === 'WIN') {
                danmuList = await this.getWinDanmu(id);
            } else if (tier === 'WEB') {
                danmuList = await this.getWebDanmuFallback(id);
            }

            // 区分「请求异常(null)」与「正常但无数据([])」
            if (danmuList !== null && Array.isArray(danmuList)) {
                // 记录当前健康的接口层级
                if (API_HEALTH.danmu !== tier) {
                    log("info", `[Renren] 弹幕域接口健康状态更新: ${API_HEALTH.danmu} -> ${tier}`);
                    API_HEALTH.danmu = tier;
                }

                if (danmuList.length > 0) {
                    log("info", `[Renren] 成功获取 ${danmuList.length} 条弹幕 (${tier}端)`);
                } else {
                    log("info", `[Renren] 该剧集暂无弹幕 (${tier}端)`);
                }

                // 将时长与ID附带在返回的数组对象上供格式化时使用
                danmuList.adDurationMs = adDurationMs;
                danmuList.episodeId = id;
                return danmuList;
            } else {
                log("info", `[Renren] ${tier} 弹幕接口失败，触发降级`);
            }
        } catch (e) {
            log("info", `[Renren] ${tier} 弹幕接口异常，触发降级: ${e.message}`);
        }
    }

    // 所有端点轮换完毕仍未获取到数据，重置健康状态
    log("info", `[Renren] 弹幕域所有降级接口均失败，重置健康状态至 TV 端`);
    API_HEALTH.danmu = 'TV';
    
    const emptyDanmuList = [];
    emptyDanmuList.adDurationMs = adDurationMs;
    emptyDanmuList.episodeId = id;
    return emptyDanmuList;
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
  // 8. 数据解析与处理工具
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
   * 兼容处理 item.d 和 item.content 内容字段，支持内嵌广告自动前移偏移补偿
   */
  formatComments(comments) {
    const adDurationMs = comments.adDurationMs || 0;
    const episodeId = comments.episodeId || "未知";
    const offsetSec = adDurationMs / 1000;
    // 剔除统计器
    let droppedCount = 0;

    const formattedList = comments.map(item => {
      // 提取内容 (优先 d，兼容 content)
      let text = String(item.d || "");
      if (!text && item.content) text = String(item.content);

      if (!text) return null;

      // 提取属性 (p)
      if (item.p) {
        const meta = this.parseRRSPPFields(item.p);

        // 弹幕前置偏移，去除广告导致的延后影响
        let t = meta.timestamp - offsetSec;
        if (t < 0) {
            droppedCount++;
            return null; 
        }

        return {
          cid: Number(meta.contentId) || 0,
          p: `${t.toFixed(2)},${meta.mode},${meta.color},[renren]`,
          m: text,
          t: t
        };
      }
      return null;
    }).filter(Boolean);
    if (adDurationMs > 0) {
        log("info", `[Renren] 识别到前置广告(${adDurationMs}ms)，已自动偏移时间轴。成功转换 ${formattedList.length} 条，剔除无效弹幕 ${droppedCount} 条 (ID=${episodeId})`);
    }
    return formattedList;
  }
}
