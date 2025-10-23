import { Envs } from './envs.js';

/**
 * 全局变量管理模块
 * 集中管理项目中的静态常量和运行时共享变量
 * ⚠️不是持久化存储，每次冷启动会丢失
 */
export const Globals = {
  // 静态常量
  VERSION: '1.4.5',
  MAX_LOGS: 500, // 日志存储，最多保存 500 行
  MAX_ANIMES: 100,
  MAX_LAST_SELECT_MAP: 100,
  VOD_ALLOWED_PLATFORMS: ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq'],
  ALLOWED_PLATFORMS: ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'renren', 'hanjutv', 'bahamut'],

  // 运行时状态
  animes: [],
  episodeIds: [],
  episodeNum: 10001, // 全局变量，用于自增 ID
  logBuffer: [],
  requestHistory: new Map(), // 记录每个 IP 地址的请求历史
  redisValid: false, // redis是否生效
  redisCacheInitialized: false, // redis 缓存是否已初始化
  lastSelectMap: new Map(), // 存储查询关键字上次选择的animeId，用于下次match自动匹配时优先选择该anime
  lastHashes: { // 存储上一次各变量哈希值
    animes: null,
    episodeIds: null,
    episodeNum: null,
    lastSelectMap: null
  },
  searchCache: new Map(), // 搜索结果缓存，存储格式：{ keyword: { results, timestamp } }
  commentCache: new Map(), // 弹幕缓存，存储格式：{ videoUrl: { comments, timestamp } }

  /**
   * 初始化全局变量，加载环境变量依赖
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 全局配置对象
   */
  init(env = {}, deployPlatform = 'node') {
    const config = Envs.load(env, deployPlatform);
    return {
      version: this.VERSION,
      maxLogs: this.MAX_LOGS,
      maxAnimes: this.MAX_ANIMES,
      maxLastSelectMap: this.MAX_LAST_SELECT_MAP,
      vodAllowedPlatforms: this.VOD_ALLOWED_PLATFORMS,
      allowedPlatforms: this.ALLOWED_PLATFORMS,
      animes: this.animes,
      episodeIds: this.episodeIds,
      episodeNum: this.episodeNum,
      logBuffer: this.logBuffer,
      requestHistory: this.requestHistory,
      redisValid: this.redisValid,
      redisCacheInitialized: this.redisCacheInitialized,
      lastSelectMap: this.lastSelectMap,
      lastHashes: this.lastHashes,
      searchCache: this.searchCache,
      commentCache: this.commentCache,
      accessedEnvVars: Object.fromEntries(Envs.getAccessedEnvVars()),
      ...config,
    };
  },

  /**
   * 获取全局配置快照
   * @returns {Object} 当前全局配置
   */
  getConfig() {
    return {
      version: this.VERSION,
      maxLogs: this.MAX_LOGS,
      maxAnimes: this.MAX_ANIMES,
      maxLastSelectMap: this.MAX_LAST_SELECT_MAP,
      vodAllowedPlatforms: this.VOD_ALLOWED_PLATFORMS,
      allowedPlatforms: this.ALLOWED_PLATFORMS,
      animes: this.animes,
      episodeIds: this.episodeIds,
      episodeNum: this.episodeNum,
      logBuffer: this.logBuffer,
      requestHistory: this.requestHistory,
      redisValid: this.redisValid,
      redisCacheInitialized: this.redisCacheInitialized,
      lastSelectMap: this.lastSelectMap,
      lastHashes: this.lastHashes,
      searchCache: this.searchCache,
      commentCache: this.commentCache
    };
  }
};