import { Envs } from './envs.js';
import { describeConfigValue, recordConfigAccess, recordConfigEffect } from '../utils/pipeline-trace.js';

const TRAILING_RELEASE_YEAR_PATTERN = /(?:\s*[（(]\s*(?:19|20)\d{2}\s*[)）]|\s*[\[［]\s*(?:19|20)\d{2}\s*[\]］]|\s*【\s*(?:19|20)\d{2}\s*】)\s*$/;

function stripTrailingReleaseYear(value) {
  return String(value || '').replace(TRAILING_RELEASE_YEAR_PATTERN, '').trim();
}

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
  VERSION: '1.22.0',
  MAX_LOGS: 1000, // 日志存储，最多保存 1000 行
  MAX_RECORDS: 100, // 请求记录最大数量

  // 运行时状态
  animes: [],
  episodeIds: [],
  episodeNum: 10001, // 全局变量，用于自增 ID
  logBuffer: [],
  requestHistory: new Map(), // 记录每个 IP 地址的请求历史
  localCacheValid: false, // 本地缓存是否生效
  localCacheInitialized: false, // 本地缓存是否已初始化
  localRedisCacheInitialized: false, // 本地 Redis 缓存是否已初始化
  queryCacheInitialized: false, // 查询数据只恢复一次，之后以内存为准
  queryCacheWritable: {}, // 后端成功读取后才可写入；失败后本进程保留远端数据
  favoriteCacheWritable: {}, // 收藏读取失败时保护原快照，与查询恢复状态独立
  redisValid: false, // redis是否生效
  localRedisValid: false, // 本地redis是否生效
  aiValid: false, // AI配置是否生效
  redisCacheInitialized: false, // redis 缓存是否已初始化
  lastSelectMap: new Map(), // 存储查询关键字上次选择的animeId，用于下次match自动匹配时优先选择该anime
  reqRecords: [], // 记录请求历史，包括接口/参数/请求时间
  todayReqNum: 0, // 今日请求数量统计
  // 各后端只记录自身已确认持有的数据；缺少哈希表示尚未持久化。
  localFileHashes: {},
  upstashHashes: {},
  localRedisHashes: {},
  searchCache: new Map(), // 搜索结果缓存，存储格式：{ keyword: { results, timestamp } }
  commentCache: new Map(), // 弹幕缓存，存储格式：{ videoUrl: { comments, timestamp } }
  favoriteCache: new Map(), // 收藏剧集永久缓存，存储格式：{ keyword: { results, details, timestamp } }，无 TTL、无数量上限
  remoteTitleMappingTable: new Map(), // 远端剧名映射，查询时由本机映射优先兜底
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
      } else if (conf.startsWith('animeko@') && (hostname.includes('animeko') || hostname.includes('bgm.tv'))) {
         specificProxy = conf.substring(8);
         break;
      } else if (conf.startsWith('aiyifan@') && /(^|\.)(tripdata\.app|yfsp\.tv)$/.test(hostname)) {
         specificProxy = conf.substring(8);
         break;
      } else if (conf.startsWith('@') && !universalProxy) {
         universalProxy = conf.substring(1);
      } else if (/^https?:\/\//i.test(conf) && !forwardProxy) {
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

  resolveTitleMapping(title) {
    const key = String(title ?? '');
    const localMappings = this.envs?.titleMappingTable;
    const remoteMappings = this.remoteTitleMappingTable;
    // 远程映射表仅在配置了地址时才会加载，未配置时不登记该配置项的变换记录
    const remoteConfigured = Boolean(this.envs?.titleMappingTableUrl);
    const keys = [key];
    const withoutYear = stripTrailingReleaseYear(key);
    if (withoutYear && withoutYear !== key) keys.push(withoutYear);

    // 精确键优先；仅当精确键未命中时才忽略尾部年份重试。
    for (const candidate of keys) {
      if (localMappings?.has(candidate)) {
        const mapped = localMappings.get(candidate);
        recordConfigEffect('TITLE_MAPPING_TABLE', {
          label: '本机剧名映射命中', hit: true,
          before: { title: key, matchedKey: candidate },
          after: { title: mapped, origin: 'local', localRules: localMappings.size },
        });
        if (remoteConfigured) {
          recordConfigEffect('TITLE_MAPPING_TABLE_URL', {
            label: '本机规则优先，远程规则未参与', hit: false,
            before: { title: key, url: describeConfigValue('titleMappingTableUrl', this.envs.titleMappingTableUrl) },
            after: { title: mapped, origin: 'local' },
          });
        }
        return mapped;
      }
      if (remoteMappings?.has(candidate)) {
        const mapped = remoteMappings.get(candidate);
        recordConfigEffect('TITLE_MAPPING_TABLE_URL', {
          label: '远程剧名映射命中', hit: true,
          before: {
            title: key,
            matchedKey: candidate,
            url: describeConfigValue('titleMappingTableUrl', this.envs?.titleMappingTableUrl),
          },
          after: { title: mapped, origin: 'remote', remoteRules: remoteMappings.size },
        });
        return mapped;
      }
    }
    recordConfigEffect('TITLE_MAPPING_TABLE', {
      label: '剧名映射未命中', hit: false,
      before: { title: key, triedKeys: keys },
      after: { title: key, localRules: localMappings?.size || 0 },
    });
    if (remoteConfigured) {
      recordConfigEffect('TITLE_MAPPING_TABLE_URL', {
        label: '远程剧名映射未命中', hit: false,
        before: { title: key, url: describeConfigValue('titleMappingTableUrl', this.envs.titleMappingTableUrl) },
        after: { title: key, remoteRules: remoteMappings?.size || 0 },
      });
    }
    return null;
  },

  /**
   * 获取全局配置快照
   * @returns {Object} 当前全局配置
   */
  /**
   * 获取全局配置对象（单例，可修改）
   * 使用 Proxy 保持接口兼容性，实例懒初始化后缓存复用避免每次新建
   * @returns {Object} 全局配置对象本身
   */
  getConfig() {
    if (this._configProxy) return this._configProxy;

    const self = this;
    this._configProxy = new Proxy({}, {
      get(target, prop) {
        // 优先返回 envs 中的属性（保持原有的平铺效果）
        if (prop in self.envs) {
          const value = self.envs[prop];
          // 登记本次请求读到的配置项，供「接口详情」展示
          recordConfigAccess(prop, value);
          return value;
        }
        // 映射大写常量到小写
        if (prop === 'version') return self.VERSION;
        if (prop === 'maxLogs') return self.MAX_LOGS;
        if (prop === 'maxAnimes') return self.envs.MAX_ANIMES;
        if (prop === 'maxRecords') return self.MAX_RECORDS;
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

    return this._configProxy;
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
