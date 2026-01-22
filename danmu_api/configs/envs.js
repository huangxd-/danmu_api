/**
 * 环境变量管理模块
 * 提供获取和设置环境变量的函数，支持 Cloudflare Workers 和 Node.js
 */
export class Envs {
  static env;

  // 记录获取过的环境变量
  static originalEnvVars = new Map();
  static accessedEnvVars = new Map();

  static VOD_ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'sohu', 'leshi']; // vod允许的播放平台
  static ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'animeko', 'custom']; // 全部源允许的播放平台
  static ALLOWED_SOURCES = ['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'animeko', 'custom']; // 允许的源
  static MERGE_ALLOWED_SOURCES = ['tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'animeko']; // 允许的源合并

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
      this.originalEnvVars.set(key, value);
    } else if (typeof process !== 'undefined' && process.env?.[key]) {
      value = process.env[key];
      this.originalEnvVars.set(key, value);
    } else {
      value = defaultValue;
      this.originalEnvVars.set(key, "");
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
   * @returns {Array} 服务器列表
   */
  static resolveVodServers() {
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
   * @returns {Array} 源排序数组
   */
  static resolveSourceOrder() {
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
   * @returns {Array} 平台排序数组
   */
  static resolvePlatformOrder() {
    const orderArr = this.get('PLATFORM_ORDER', '', 'string')
      .split(',')
      .map(s => s.trim())
      .filter(s => this.ALLOWED_PLATFORMS.includes(s));

    this.accessedEnvVars.set('PLATFORM_ORDER', orderArr);

    return orderArr.length > 0 ? [...orderArr, null] : [null];
  }

  /**
   * 解析源合并配置
   * 从环境变量 MERGE_SOURCE_PAIRS 获取配置
   * 支持使用分号或逗号分隔多组配置
   * 支持一主多从配置，第一个为主源，后续为副源
   * 格式示例: bilibili&animeko, dandan&animeko&bahamut
   * @returns {Array} 合并配置数组 [{primary: 'dandan', secondaries: ['animeko', 'bahamut']}, ...]
   */
  static resolveMergeSourcePairs() {
    const config = this.get('MERGE_SOURCE_PAIRS', '', 'string');
    if (!config) return [];
    
    // 使用正则同时支持分号(;)和逗号(,)作为配置组的分隔符
    return config.split(/[,;]/)
      .map(group => {
        // 过滤空字符串
        if (!group || !group.includes('&')) return null;
        
        // 按 & 分割，第一个是主源，剩余的是副源列表
        const parts = group.split('&').map(s => s.trim()).filter(s => s);
        
        if (parts.length < 2) return null;

        const primary = parts[0];
        const secondaries = parts.slice(1);

        // 验证主源是否在允许列表中
        if (!this.MERGE_ALLOWED_SOURCES.includes(primary)) return null;

        // 过滤有效的副源，且排除主源本身（防止自我合并）
        const validSecondaries = secondaries.filter(sec => 
            sec !== primary && this.MERGE_ALLOWED_SOURCES.includes(sec)
        );

        if (validSecondaries.length === 0) return null;

        return { primary, secondaries: validSecondaries };
      })
      .filter(Boolean);
  }

  /**
   * 解析剧集标题过滤正则
   * @returns {RegExp} 过滤正则表达式
   */
  static resolveEpisodeTitleFilter() {
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
   * 获取记录的原始环境变量 JSON
   * @returns {Map<any, any>} JSON 字符串
   */
  static getOriginalEnvVars() {
    return this.originalEnvVars;
  }
  
  /** 解析弹幕转换颜色
   * @returns {string} 弹幕转换颜色
   */
  static resolveConvertColor() {
    // CONVERT_COLOR_TO_WHITE 变量向前兼容处理
    let convertColorToWhite = this.get('CONVERT_COLOR_TO_WHITE', false, 'boolean');
    return this.get('CONVERT_COLOR', convertColorToWhite ? 'white': 'default', 'string');
  }

  /**
   * 解析剧名映射表
   * @returns {Map} 剧名映射表
   */
  static resolveTitleMappingTable() {
    const mappingStr = this.get('TITLE_MAPPING_TABLE', '', 'string').trim();
    const mappingTable = new Map();

    if (!mappingStr) {
      return mappingTable;
    }

    // 解析格式："唐朝诡事录->唐朝诡事录之西行;国色芳华->锦绣芳华"
    const pairs = mappingStr.split(';');
    for (const pair of pairs) {
      if (pair.includes('->')) {
        const [original, mapped] = pair.split('->').map(s => s.trim());
        if (original && mapped) {
          mappingTable.set(original, mapped);
        }
      }
    }

    return mappingTable;
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
  static load(env = {}) {
    this.env = env;
    
    // 环境变量分类和描述映射
    const envVarConfig = {
      // API配置
      'TOKEN': { category: 'api', type: 'text', description: 'API访问令牌' },
      'ADMIN_TOKEN': { category: 'api', type: 'text', description: '系统管理访问令牌' },
      'RATE_LIMIT_MAX_REQUESTS': { category: 'api', type: 'number', description: '限流配置：1分钟内最大请求次数，0表示不限流，默认3', min: 0, max: 50 },

      // 源配置
      'SOURCE_ORDER': { category: 'source', type: 'multi-select', options: this.ALLOWED_SOURCES, description: '源排序配置，默认360,vod,renren,hanjutv' },
      'OTHER_SERVER': { category: 'source', type: 'text', description: '第三方弹幕服务器，默认https://api.danmu.icu' },
      'CUSTOM_SOURCE_API_URL': { category: 'source', type: 'text', description: '自定义弹幕源API地址，默认为空，配置后还需在SOURCE_ORDER添加custom源' },
      'VOD_SERVERS': { category: 'source', type: 'text', description: 'VOD站点配置，格式：名称@URL,名称@URL，默认金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top' },
      'VOD_RETURN_MODE': { category: 'source', type: 'select', options: ['all', 'fastest'], description: 'VOD返回模式：all（所有站点）或 fastest（最快的站点），默认fastest' },
      'VOD_REQUEST_TIMEOUT': { category: 'source', type: 'number', description: 'VOD请求超时时间，默认10000', min: 5000, max: 30000 },
      'BILIBILI_COOKIE': { category: 'source', type: 'text', description: 'B站Cookie' },
      'YOUKU_CONCURRENCY': { category: 'source', type: 'number', description: '优酷并发配置，默认8', min: 1, max: 16 },
	  'MERGE_SOURCE_PAIRS': { category: 'source', type: 'text', description: '源合并配置，配置后将对应源合并同时一起获取弹幕返回，支持多源链式合并，第一个为主源。\n格式：源1&源2&源3，多组用逗号分隔。\n示例：dandan&animeko&bahamut, bilibili&animeko\n目前允许的源：tencent,youku,iqiyi,imgo,bilibili,sohu,leshi,renren,hanjutv,bahamut,dandan,animeko' },
      
      // 匹配配置
      'PLATFORM_ORDER': { category: 'match', type: 'multi-select', options: this.ALLOWED_PLATFORMS, description: '平台排序配置' },
      'EPISODE_TITLE_FILTER': { category: 'match', type: 'text', description: '剧集标题过滤规则' },
      'ENABLE_EPISODE_FILTER': { category: 'match', type: 'boolean', description: '集标题过滤开关' },
      'STRICT_TITLE_MATCH': { category: 'match', type: 'boolean', description: '严格标题匹配模式' },
      'TITLE_TO_CHINESE': { category: 'match', type: 'boolean', description: '外语标题转换中文开关' },
      'TITLE_MAPPING_TABLE': { category: 'match', type: 'map', description: '剧名映射表，用于自动匹配时替换标题进行搜索，格式：原始标题->映射标题;原始标题->映射标题;... ，例如："唐朝诡事录->唐朝诡事录之西行;国色芳华->锦绣芳华"' },

      // 弹幕配置
      'BLOCKED_WORDS': { category: 'danmu', type: 'text', description: '屏蔽词列表' },
      'GROUP_MINUTE': { category: 'danmu', type: 'number', description: '分钟内合并去重（0表示不去重），默认1', min: 0, max: 30 },
      'DANMU_LIMIT': { category: 'danmu', type: 'number', description: '弹幕数量限制，单位为k，即千：默认 0，表示不限制弹幕数', min: 0, max: 100 },
      'DANMU_SIMPLIFIED': { category: 'danmu', type: 'boolean', description: '弹幕繁体转简体开关' },
      'CONVERT_TOP_BOTTOM_TO_SCROLL': { category: 'danmu', type: 'boolean', description: '顶部/底部弹幕转换为浮动弹幕' },
      'CONVERT_COLOR': { category: 'danmu', type: 'select', options: ['default', 'white', 'color'], description: '弹幕转换颜色配置' },
      'DANMU_OUTPUT_FORMAT': { category: 'danmu', type: 'select', options: ['json', 'xml'], description: '弹幕输出格式，默认json' },
      'DANMU_PUSH_URL': { category: 'danmu', type: 'text', description: '弹幕推送地址，示例 http://127.0.0.1:9978/action?do=refresh&type=danmaku&path= ' },

      // 缓存配置
      'SEARCH_CACHE_MINUTES': { category: 'cache', type: 'number', description: '搜索结果缓存时间(分钟)，默认1', min: 1, max: 120 },
      'COMMENT_CACHE_MINUTES': { category: 'cache', type: 'number', description: '弹幕缓存时间(分钟)，默认1', min: 1, max: 120 },
      'REMEMBER_LAST_SELECT': { category: 'cache', type: 'boolean', description: '记住手动选择结果' },
      'MAX_LAST_SELECT_MAP': { category: 'cache', type: 'number', description: '记住上次选择映射缓存大小限制', min: 10, max: 1000 },
      'UPSTASH_REDIS_REST_URL': { category: 'cache', type: 'text', description: 'Upstash Redis请求链接' },
      'UPSTASH_REDIS_REST_TOKEN': { category: 'cache', type: 'text', description: 'Upstash Redis访问令牌' },

      // 系统配置
      'PROXY_URL': { category: 'system', type: 'text', description: '代理/反代地址' },
      'TMDB_API_KEY': { category: 'system', type: 'text', description: 'TMDB API密钥' },
      'LOG_LEVEL': { category: 'system', type: 'select', options: ['debug', 'info', 'warn', 'error'], description: '日志级别配置' },
      'DEPLOY_PLATFROM_ACCOUNT': { category: 'system', type: 'text', description: '部署平台账号ID' },
      'DEPLOY_PLATFROM_PROJECT': { category: 'system', type: 'text', description: '部署平台项目名称' },
      'DEPLOY_PLATFROM_TOKEN': { category: 'system', type: 'text', description: '部署平台访问令牌' },
      'NODE_TLS_REJECT_UNAUTHORIZED': { category: 'system', type: 'number', description: '在建立 HTTPS 连接时是否验证服务器的 SSL/TLS 证书，0表示忽略，默认为1', min: 0, max: 1 },
    };
    
    return {
      vodAllowedPlatforms: this.VOD_ALLOWED_PLATFORMS,
      allowedPlatforms: this.ALLOWED_PLATFORMS,
      token: this.get('TOKEN', '87654321', 'string', true), // token，默认为87654321
      adminToken: this.get('ADMIN_TOKEN', '', 'string', true), // admin token，用于系统管理访问控制
      sourceOrderArr: this.resolveSourceOrder(), // 源排序
      otherServer: this.get('OTHER_SERVER', 'https://api.danmu.icu', 'string'), // 第三方弹幕服务器
      customSourceApiUrl: this.get('CUSTOM_SOURCE_API_URL', '', 'string', true), // 自定义弹幕源API地址，默认为空，配置后还需在SOURCE_ORDER添加custom源
      vodServers: this.resolveVodServers(), // vod站点配置，格式：名称@URL,名称@URL
      vodReturnMode: this.get('VOD_RETURN_MODE', 'fastest', 'string').toLowerCase(), // vod返回模式：all（所有站点）或 fastest（最快的站点）
      vodRequestTimeout: this.get('VOD_REQUEST_TIMEOUT', '10000', 'string'), // vod超时时间（默认10秒）
      bilibliCookie: this.get('BILIBILI_COOKIE', '', 'string', true), // b站cookie
      youkuConcurrency: Math.min(this.get('YOUKU_CONCURRENCY', 8, 'number'), 16), // 优酷并发配置
	  mergeSourcePairs: this.resolveMergeSourcePairs(), // 源合并配置，用于将源合并获取
      platformOrderArr: this.resolvePlatformOrder(), // 自动匹配优选平台
      episodeTitleFilter: this.resolveEpisodeTitleFilter(), // 剧集标题正则过滤
      blockedWords: this.get('BLOCKED_WORDS', '', 'string'), // 屏蔽词列表
      groupMinute: Math.min(this.get('GROUP_MINUTE', 1, 'number'), 30), // 分钟内合并去重（默认 1，最大值30，0表示不去重）
      danmuLimit: this.get('DANMU_LIMIT', 0, 'number'), // 等间隔采样限制弹幕总数，单位为k，即千：默认 0，表示不限制弹幕数，若改为5，弹幕总数在超过5000的情况下会将弹幕数控制在5000
      proxyUrl: this.get('PROXY_URL', '', 'string', true), // 代理/反代地址
      danmuSimplified: this.get('DANMU_SIMPLIFIED', true, 'boolean'), // 弹幕繁体转简体开关
      danmuPushUrl: this.get('DANMU_PUSH_URL', '', 'string'), // 代理/反代地址
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
      titleMappingTable: this.resolveTitleMappingTable(), // 剧名映射表，用于自动匹配时替换标题进行搜索
      rememberLastSelect: this.get('REMEMBER_LAST_SELECT', true, 'boolean'), // 是否记住手动选择结果，用于match自动匹配时优选上次的选择（默认 true，记住）
      MAX_LAST_SELECT_MAP: this.get('MAX_LAST_SELECT_MAP', 100, 'number'), // 记住上次选择映射缓存大小限制（默认 100）
      deployPlatformAccount: this.get('DEPLOY_PLATFROM_ACCOUNT', '', 'string', true), // 部署平台账号ID配置（默认空）
      deployPlatformProject: this.get('DEPLOY_PLATFROM_PROJECT', '', 'string', true), // 部署平台项目名称配置（默认空）
      deployPlatformToken: this.get('DEPLOY_PLATFROM_TOKEN', '', 'string', true), // 部署平台项目名称配置（默认空）
      NODE_TLS_REJECT_UNAUTHORIZED: this.get('NODE_TLS_REJECT_UNAUTHORIZED', 1, 'number'), // 在建立 HTTPS 连接时是否验证服务器的 SSL/TLS 证书，0表示忽略，默认为1
      envVarConfig: envVarConfig // 环境变量分类和描述映射
    };
  }
}
