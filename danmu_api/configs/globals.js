import { Envs } from './envs.js';

/**
 * 全局变量管理模块
 * 集中管理项目中的静态常量和运行时共享变量
 * ⚠️不是持久化存储，每次冷启动会丢失
 */
export const Globals = {
  // 缓存环境变量
  env: {},
  envs: {},
  originalEnvVars: {},
  accessedEnvVars: {},

  // 静态常量
  VERSION: '1.12.2',
  MAX_LOGS: 500, // 日志存储，最多保存 500 行
  MAX_ANIMES: 100,

  // 运行时状态
  animes: [],
  episodeIds: [],
  episodeNum: 10001, // 全局变量，用于自增 ID
  logBuffer: [],
  requestHistory: new Map(), // 记录每个 IP 地址的请求历史
  localCacheValid: false, // 本地缓存是否生效
  localCacheInitialized: false, // 本地缓存是否已初始化
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
  deployPlatform: '', // 部署平台配置
  currentToken: '', // 标识当前可用token

  /**
   * 初始化全局变量，加载环境变量依赖
   * @param {Object} env 环境对象
   * @returns {Object} 全局配置对象
   */
  init(env = {}) {
    this.env = env;
    this.envs = Envs.load(this.env);
    this.originalEnvVars = Object.fromEntries(Envs.getOriginalEnvVars());
    this.accessedEnvVars = Object.fromEntries(Envs.getAccessedEnvVars());
    return this.getConfig();
  },

  /**
   * 重新初始化全局变量，加载环境变量依赖
   * @returns {Object} 全局配置对象
   */
  reInit() {
    this.envs = Envs.load(this.env);
    this.originalEnvVars = Object.fromEntries(Envs.getOriginalEnvVars());
    this.accessedEnvVars = Object.fromEntries(Envs.getAccessedEnvVars());
    return this.getConfig();
  },

  /**
   * 智能构建代理URL
   * 逻辑：专用反代/万能反代直接替换/拼接URL（无视平台）；正向代理走5321端口（仅本地Node有效）
   * @param {string} targetUrl 原始目标URL
   * @returns {string} 处理后的URL
   */
  makeProxyUrl(targetUrl) {
    const proxyConfig = this.envs.proxyUrl || '';
    
    if (!proxyConfig || !targetUrl) return targetUrl;

    const configs = proxyConfig.split(',').map(s => s.trim()).filter(s => s);
    let forwardProxy = null;
    let specificProxy = null;
    let universalProxy = null;

    let targetObj;
    try {
      targetObj = new URL(targetUrl);
    } catch (e) {
      return targetUrl;
    }

    const hostname = targetObj.hostname;

    // 解析配置优先级
    for (const conf of configs) {
      if (conf.startsWith('bahamut@') && hostname.includes('gamer.com.tw')) {
         specificProxy = conf.substring(8);
         break;
      } else if (conf.startsWith('tmdb@') && hostname.includes('tmdb')) {
         specificProxy = conf.substring(5);
         break;
      } else if (conf.startsWith('bilibili@') && hostname.includes('bilibili')) {
         specificProxy = conf.substring(9);
         break;
      } else if (conf.startsWith('@') && !universalProxy) {
         universalProxy = conf.substring(1);
      } else if (!conf.includes('@') && !forwardProxy) {
         forwardProxy = conf;
      }
    }

    // 1. 专用反代 (直接替换 Protocol + Host + Port + PathPrefix)
    if (specificProxy) {
        try {
          const proxyObj = new URL(specificProxy);
          targetObj.protocol = proxyObj.protocol;
          targetObj.host = proxyObj.host;
          targetObj.port = proxyObj.port;
          // 如果反代URL包含路径前缀，则拼接到前面
          if (proxyObj.pathname !== '/') {
             targetObj.pathname = proxyObj.pathname.replace(/\/$/, '') + targetObj.pathname;
          }
          return targetObj.toString();
        } catch (e) {
          return targetUrl;
        }
    }

    // 2. 万能反代 (拼接: ProxyURL + TargetURL)
    if (universalProxy) {
        const cleanProxy = universalProxy.replace(/\/$/, '');
        return `${cleanProxy}/${targetUrl}`;
    }

    // 3. 正向代理 (仅本地环境回退到 5321 中转)
    if (forwardProxy) {
        return `http://127.0.0.1:5321/proxy?url=${encodeURIComponent(targetUrl)}`;
    }

    return targetUrl;
  },

  /**
   * 获取全局配置快照
   * @returns {Object} 当前全局配置
   */
  /**
   * 获取全局配置对象（单例，可修改）
   * @returns {Object} 全局配置对象本身
   */
  getConfig() {
    // 使用 Proxy 保持接口兼容性
    const self = this;
    return new Proxy({}, {
      get(target, prop) {
        // 优先返回 envs 中的属性（保持原有的平铺效果）
        if (prop in self.envs) {
          return self.envs[prop];
        }
        // 映射大写常量到小写
        if (prop === 'version') return self.VERSION;
        if (prop === 'maxLogs') return self.MAX_LOGS;
        if (prop === 'maxAnimes') return self.MAX_ANIMES;
        if (prop === 'maxLastSelectMap') return self.MAX_LAST_SELECT_MAP;

        // 暴露方法
        if (prop === 'makeProxyUrl') return self.makeProxyUrl.bind(self);

        // 其他属性直接返回
        return self[prop];
      },
      set(target, prop, value) {
        // 写操作同步到 Globals
        if (prop in self.envs) {
          self.envs[prop] = value;
        } else {
          self[prop] = value;
        }
        return true;
      }
    });
  },
};

/**
 * 全局配置代理对象
 * 自动转发所有属性访问到 Globals.getConfig()
 * 使用示例：
 *   import { globals } from './globals.js';
 *   console.log(globals.version);  // 直接访问，无需调用 getConfig()
 */
export const globals = new Proxy({}, {
  get(target, prop) {
    return Globals.getConfig()[prop];
  },
  set(target, prop, value) {
    Globals.getConfig()[prop] = value;
    return true;
  },
  has(target, prop) {
    return prop in Globals.getConfig();
  },
  ownKeys(target) {
    return Reflect.ownKeys(Globals.getConfig());
  },
  getOwnPropertyDescriptor(target, prop) {
    return Object.getOwnPropertyDescriptor(Globals.getConfig(), prop);
  }
});
