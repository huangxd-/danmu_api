/**
 * 环境变量管理模块
 * 提供获取和设置环境变量的函数，支持 Cloudflare Workers 和 Node.js
 */
export class Envs {
  static env;

  // 记录获取过的环境变量
  static accessedEnvVars = new Map();

  static VOD_ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq']; // vod允许的播放平台
  static ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'renren', 'hanjutv', 'bahamut', 'dandan']; // 全部源允许的播放平台
  static ALLOWED_SOURCES = ['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'renren', 'hanjutv', 'bahamut', 'dandan']; // 允许的源

  /**
   * 获取环境变量
   * @param {string} key 环境变量的键
   * @param {any} defaultValue 默认值
   * @param {'string' | 'number' | 'boolean'} type 类型
   * @returns {any} 转换后的值
   */
  static get(key, defaultValue, type = 'string', encrypt = false) {
    let value;
    if (typeof this.env !== 'undefined' && this.env[key]) {
      value = this.env[key];
    } else if (typeof process !== 'undefined' && process.env?.[key]) {
      value = process.env[key];
    } else {
      value = defaultValue;
    }

    let parsedValue;
    switch (type) {
      case 'number':
        parsedValue = Number(value);
        if (isNaN(parsedValue)) {
          throw new Error(`Environment variable ${key} must be a valid number`);
        }
        break;
      case 'boolean':
        parsedValue = value === true || value === 'true'|| value === 1 || value === '1';
        break;
      case 'string':
      default:
        parsedValue = String(value);
        break;
    }

    const finalValue = encrypt ? this.encryptStr(parsedValue) : parsedValue;
    this.accessedEnvVars.set(key, finalValue);

    return parsedValue;
  }

  /**
   * 设置环境变量
   * @param {string} key 环境变量的键
   * @param {any} value 值
   */
  static set(key, value) {
    if (typeof process !== 'undefined') {
      process.env[key] = String(value);
    }
    this.accessedEnvVars.set(key, value);
  }

  /**
   * 基础加密函数 - 将字符串转换为星号
   * @param {string} str 输入字符串
   * @returns {string} 星号字符串
   */
  static encryptStr(str) {
    return '*'.repeat(str.length);
  }

  /**
   * 解析 VOD 服务器配置
   * @param {Object} env 环境对象
   * @returns {Array} 服务器列表
   */
  static resolveVodServers(env) {
    const defaultVodServers = '金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top';
    let vodServersConfig = this.get('VOD_SERVERS', defaultVodServers, 'string');

    if (!vodServersConfig || vodServersConfig.trim() === '') {
      return [];
    }

    return vodServersConfig
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((item, index) => {
        if (item.includes('@')) {
          const [name, url] = item.split('@').map(s => s.trim());
          return { name: name || `vod-${index + 1}`, url };
        }
        return { name: `vod-${index + 1}`, url: item };
      })
      .filter(server => server.url && server.url.length > 0);
  }

  /**
   * 解析源排序
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Array} 源排序数组
   */
  static resolveSourceOrder(env, deployPlatform) {
    let sourceOrder = this.get('SOURCE_ORDER', '360,vod,renren,hanjutv', 'string');

    const orderArr = sourceOrder
      .split(',')
      .map(s => s.trim())
      .filter(s => this.ALLOWED_SOURCES.includes(s));

    this.accessedEnvVars.set('SOURCE_ORDER', orderArr);

    return orderArr.length > 0 ? orderArr : ['360', 'vod', 'renren', 'hanjutv'];
  }

  /**
   * 解析平台排序
   * @param {Object} env 环境对象
   * @returns {Array} 平台排序数组
   */
  static resolvePlatformOrder(env) {
    const orderArr = this.get('PLATFORM_ORDER', '', 'string')
      .split(',')
      .map(s => s.trim())
      .filter(s => this.ALLOWED_PLATFORMS.includes(s));

    this.accessedEnvVars.set('PLATFORM_ORDER', orderArr);

    return orderArr.length > 0 ? [...orderArr, null] : [null];
  }

  /**
   * 解析剧集标题过滤正则
   * @param {Object} env 环境对象
   * @returns {RegExp} 过滤正则表达式
   */
  static resolveEpisodeTitleFilter(env) {
    const defaultFilter = '(特别|惊喜|纳凉)?企划|合伙人手记|超前(营业|vlog)?|速览|vlog|reaction|纯享|加更(版|篇)?|抢先(看|版|集|篇)?|抢鲜|预告|花絮(独家)?|' +
      '特辑|彩蛋|专访|幕后(故事|花絮|独家)?|直播(陪看|回顾)?|未播(片段)?|衍生|番外|会员(专享|加长|尊享|专属|版)?|片花|精华|看点|速看|解读|影评|解说|吐槽|盘点|拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|' +
      '花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|番外彩蛋|精彩片段|精彩看点|精彩回顾|精彩集锦|看点解析|看点预告|' +
      'NG镜头|NG花絮|番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|插曲|高光回顾|背景音乐|OST|音乐MV|歌曲MV|前季回顾|' +
      '剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|采访|陪看(记)?|' +
      '试看版|短剧|精编|Plus|独家版|特别版|短片|发布会|解忧局|走心局|火锅局|巅峰时刻|坞里都知道|福持目标坞民|观察室|上班那点事儿|' +
      '周top|赛段|直拍|REACTION|VLOG|全纪录|开播|先导|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘';

    // 读取环境变量，如果设置了则完全覆盖默认值
    const customFilter = this.get('EPISODE_TITLE_FILTER', '', 'string', false).trim();
    let keywords = customFilter || defaultFilter;

    this.accessedEnvVars.set('EPISODE_TITLE_FILTER', keywords);

    try {
      return new RegExp(`^(.*?)(?:${keywords})(.*?)$`);
    } catch (error) {
      console.warn(`Invalid EPISODE_TITLE_FILTER format, using default.`);
      return new RegExp(`^(.*?)(?:${defaultFilter})(.*?)$`);
    }
  }

  /**
   * 解析弹幕转换颜色
   * @returns {string} 弹幕转换颜色
   */
  static resolveConvertColor() {
    // CONVERT_COLOR_TO_WHITE 变量向前兼容处理
    let convertColorToWhite = this.get('CONVERT_COLOR_TO_WHITE', false, 'boolean');
    return this.get('CONVERT_COLOR', convertColorToWhite ? 'white': 'default', 'string');
  }

  /**
   * 获取记录的环境变量 JSON
   * @returns {Map<any, any>} JSON 字符串
   */
  static getAccessedEnvVars() {
    return this.accessedEnvVars;
  }

  /**
   * 初始化环境变量
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 配置对象
   */
  static load(env = {}, deployPlatform = 'node') {
    this.env = env;
    return {
      vodAllowedPlatforms: this.VOD_ALLOWED_PLATFORMS,
      allowedPlatforms: this.ALLOWED_PLATFORMS,
      token: this.get('TOKEN', '87654321', 'string', true), // token，默认为87654321
      otherServer: this.get('OTHER_SERVER', 'https://api.danmu.icu', 'string'), // 第三方弹幕服务器
      vodServers: this.resolveVodServers(env), // vod站点配置，格式：名称@URL,名称@URL
      vodReturnMode: this.get('VOD_RETURN_MODE', 'fastest', 'string').toLowerCase(), // vod返回模式：all（所有站点）或 fastest（最快的站点）
      vodRequestTimeout: this.get('VOD_REQUEST_TIMEOUT', '10000', 'string'), // vod超时时间（默认10秒）
      bilibliCookie: this.get('BILIBILI_COOKIE', '', 'string', true), // b站cookie
      youkuConcurrency: Math.min(this.get('YOUKU_CONCURRENCY', 8, 'number'), 16), // 优酷并发配置
      sourceOrderArr: this.resolveSourceOrder(env, deployPlatform), // 源排序
      platformOrderArr: this.resolvePlatformOrder(env), // 自动匹配优选平台
      episodeTitleFilter: this.resolveEpisodeTitleFilter(env), // 剧集标题正则过滤
      blockedWords: this.get('BLOCKED_WORDS', '', 'string'), // 屏蔽词列表
      groupMinute: Math.min(this.get('GROUP_MINUTE', 1, 'number'), 30), // 分钟内合并去重（默认 1，最大值30，0表示不去重）
      danmuLimit: this.get('DANMU_LIMIT', 0, 'number'), // 等间隔采样限制弹幕总数，单位为k，即千：默认 0，表示不限制弹幕数，若改为5，弹幕总数在超过5000的情况下会将弹幕数控制在5000
      proxyUrl: this.get('PROXY_URL', '', 'string', true), // 代理/反代地址
      danmuSimplified: this.get('DANMU_SIMPLIFIED', true, 'boolean'), // 弹幕繁体转简体开关
      tmdbApiKey: this.get('TMDB_API_KEY', '', 'string', true), // TMDB API KEY
      redisUrl: this.get('UPSTASH_REDIS_REST_URL', '', 'string', true), // upstash redis url
      redisToken: this.get('UPSTASH_REDIS_REST_TOKEN', '', 'string', true), // upstash redis url
      rateLimitMaxRequests: this.get('RATE_LIMIT_MAX_REQUESTS', 3, 'number'), // 限流配置：时间窗口内最大请求次数（默认 3，0表示不限流）
      enableEpisodeFilter: this.get('ENABLE_EPISODE_FILTER', false, 'boolean'), // 集标题过滤开关配置（默认 false，禁用过滤）
      logLevel: this.get('LOG_LEVEL', 'info', 'string'), // 日志级别配置（默认 info，可选值：error, warn, info）
      searchCacheMinutes: this.get('SEARCH_CACHE_MINUTES', 1, 'number'), // 搜索结果缓存时间配置（分钟，默认 1）
      commentCacheMinutes: this.get('COMMENT_CACHE_MINUTES', 1, 'number'), // 弹幕缓存时间配置（分钟，默认 1）
      convertTopBottomToScroll: this.get('CONVERT_TOP_BOTTOM_TO_SCROLL', false, 'boolean'), // 顶部/底部弹幕转换为浮动弹幕配置（默认 false，禁用转换）
      convertColor: this.resolveConvertColor(), // 弹幕转换颜色配置，支持 default、white、color（默认 default，禁用转换）
      danmuOutputFormat: this.get('DANMU_OUTPUT_FORMAT', 'json', 'string'), // 弹幕输出格式配置（默认 json，可选值：json, xml）
      strictTitleMatch: this.get('STRICT_TITLE_MATCH', false, 'boolean'), // 严格标题匹配模式配置（默认 false，宽松模糊匹配）
      titleToChinese: this.get('TITLE_TO_CHINESE', false, 'boolean'), // 外语标题转换中文开关
      rememberLastSelect: this.get('REMEMBER_LAST_SELECT', true, 'boolean'), // 是否记住手动选择结果，用于match自动匹配时优选上次的选择（默认 true，记住）
      MAX_LAST_SELECT_MAP: this.get('MAX_LAST_SELECT_MAP', 100, 'number'), // 记住上次选择映射缓存大小限制（默认 100）
    };
  }
}
