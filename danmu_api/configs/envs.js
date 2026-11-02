import { BLOCKED_WORD_PRESETS, migrateLegacyBlockedWords, LEGACY_BLOCKED_WORD_KEYS } from '../utils/blocked-word-presets.js';
import { canonicalPlatformGroup, canonicalPlatformName } from '../utils/platform-util.js';
/**
 * 环境变量管理模块
 * 提供获取和设置环境变量的函数，支持 NAS Node/Docker
 */
import { danAnyFormats } from '../utils/dan-any.js';
import { parseOffsetRules } from '../utils/offset-util.js';
import { parseAutoMatchMappingRules } from '../utils/auto-match-mapping-util.js';

export class Envs {
  static env;

  // 记录获取过的环境变量
  static originalEnvVars = new Map();
  static accessedEnvVars = new Map();

  // Node 本地部署时由 server.js 注入：启动前的真实系统环境变量快照（最高优先级判定依据）与 .env 原始解析结果
  static systemEnvBackup = null;
  static rawEnvValues = null;

  // 按 encrypt 读取的变量（凭据类），随 Envs.get 调用登记，供日志脱敏判定是否为敏感变量
  static sensitiveKeys = new Set();

  // 允许在值中写入 # 等 dotenv 视为注释字符的变量；读取时绕过 dotenv 截断以保留完整内容。加密变量按掩码写入预览集合，原始值仅供运行期使用与日志脱敏。
  static RAW_ENV_KEYS = new Set(['ADMIN_TOKEN', 'ANIME_TITLE_FILTER', 'AUTO_MATCH_MAPPING_TABLE', 'BLOCKED_WORDS', 'BILIBILI_COOKIE', 'COLOR_POOL', 'CUSTOM_MERGE_RULES', 'DANMU_OFFSET', 'EPISODE_TITLE_FILTER', 'LOCAL_REDIS_URL', 'PROXY_URL', 'TITLE_MAPPING_TABLE', 'TITLE_NOISE_FILTER', 'TMDB_API_KEY', 'TOKEN', ]);

  static ALLOWED_PLATFORMS = ["tencent","youku","iqiyi","imgo","bilibili","migu","sohu","leshi","hongguo","hanjutv","renren","bahamut"];
  static ALLOWED_SOURCES = ["tencent","youku","iqiyi","imgo","bilibili","migu","sohu","leshi","hongguo","hanjutv","renren","bahamut"];
  static MERGE_ALLOWED_SOURCES = ["tencent","youku","iqiyi","imgo","bilibili","migu","sohu","leshi","hongguo","hanjutv","renren","bahamut"];


  /**
   * 获取环境变量
   * @param {string} key 环境变量的键
   * @param {any} defaultValue 默认值
   * @param {'string' | 'number' | 'boolean'} type 类型
   * @param {boolean} [encrypt] 是否按加密变量读取，其值按掩码写入预览集合
   * @returns {any} 转换后的值
   */
  static get(key, defaultValue, type = 'string', encrypt = false) {
    if (encrypt) Envs.sensitiveKeys.add(key);
    // 文本类变量绕过 dotenv 注释截断，保留 # 等字符；加密变量读取后按掩码写入预览集合
    if (type === 'string' && Envs.RAW_ENV_KEYS.has(key)) {
      return this.getRawEnv(key, defaultValue, encrypt);
    }
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
   * 解析 .env 原始内容：跳过整行 # 注释、保留行内 #，并剥除整体双引号包裹（与 node-handler 引号写入一致）。
   * @param {string} text .env 文件原始内容
   * @returns {Object} 键值映射
   */
  static parseRawEnvText(text) {
    const result = {};
    if (typeof text !== 'string') return result;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  }

  /**
   * 读取文本类变量，绕过 dotenv 截断保留 #：系统环境变量 > .env 原始值 > 默认值；非 Node 部署退化为普通取值。
   * @param {string} key 环境变量键
   * @param {string} defaultValue 默认值
   * @param {boolean} encrypt 是否按掩码写入预览集合
   * @returns {string} 原始值（含 #）
   */
  static getRawEnv(key, defaultValue = '', encrypt = false) {
    const finalize = (v) => {
      this.originalEnvVars.set(key, v);
      this.accessedEnvVars.set(key, encrypt ? this.encryptStr(v) : v);
      return v;
    };

    // 非 Node 运行时（测试 / Workers）：不做文件读取，等价于普通取值，保证测试隔离与平台兼容
    if (!Envs.systemEnvBackup) {
      if (this.env && this.env[key]) return finalize(this.env[key]);
      if (typeof process !== 'undefined' && process.env?.[key]) return finalize(process.env[key]);
      return finalize(defaultValue);
    }

    // Node 运行时：系统环境变量始终最高优先级
    if (Object.prototype.hasOwnProperty.call(Envs.systemEnvBackup, key)) {
      return finalize(Envs.systemEnvBackup[key]);
    }

    // 否则读取 .env 原始行（保留 #），未配置该键时回退 process.env 或默认值
    if (Envs.rawEnvValues && Object.prototype.hasOwnProperty.call(Envs.rawEnvValues, key)) {
      return finalize(Envs.rawEnvValues[key]);
    }
    if (typeof process !== 'undefined' && process.env?.[key]) return finalize(process.env[key]);
    return finalize(defaultValue);
  }

  /**
   * 解析 VOD 服务器配置
   * @returns {Array} 服务器列表
   */


  /**
   * 解析源排序
   * @returns {Array} 源排序数组
   */
  static resolveSourceOrder() {
    let sourceOrder = this.get('SOURCE_ORDER', 'tencent,iqiyi,youku,imgo,bilibili', 'string');

    const orderArr = sourceOrder
      .split(',')
      .map(s => s.trim())
      .filter(s => this.ALLOWED_SOURCES.includes(s));

    this.accessedEnvVars.set('SOURCE_ORDER', orderArr);

    return orderArr.length > 0 ? orderArr : ['tencent', 'iqiyi', 'youku', 'imgo', 'bilibili'];
  }

  /**
   * 解析平台排序
   * 支持单个平台或通过&连接的组合平台（如 bilibili&youku）
   * @returns {Array} 平台排序数组
   */
  static resolvePlatformOrder() {
    const rawOrder = this.get('PLATFORM_ORDER', '', 'string');

    const orderArr = rawOrder
      .split(',')
      .map(canonicalPlatformGroup)
      // 旧配置中已移除的平台只剔除自身，不能连带丢掉同组有效平台的优先级。
      .map(group => group.split('&').filter(platform => this.ALLOWED_PLATFORMS.includes(platform)).join('&'))
      .filter(Boolean);

    this.accessedEnvVars.set('PLATFORM_ORDER', orderArr);

    return orderArr.length > 0 ? [...orderArr, null] : [null];
  }

  /**
   * 解析源合并配置
   * 从环境变量 MERGE_SOURCE_PAIRS 获取配置
   * 支持使用分号或逗号分隔多组配置
   * 支持一主多从配置，第一个为主源，后续为副源
   * 允许单源配置（用于保留特定源的原始结果，不被合并消耗）
   * 格式示例: tencent&iqiyi,youku&bilibili
   * @returns {Array} 合并配置数组 [{primary: 'tencent', secondaries: ['iqiyi']}, {primary: 'bilibili', secondaries: []}]
   */
  static resolveMergeSourcePairs() {
    const config = this.get('MERGE_SOURCE_PAIRS', '', 'string');
    if (!config) return [];

    // 使用正则同时支持分号(;)和逗号(,)作为配置组的分隔符
    return config.split(/[,;]/)
      .map(group => {
        // 过滤空字符串
        if (!group) return null;

        // 按 & 分割，第一个是主源，剩余的是副源列表
        const parts = group.split('&').map(canonicalPlatformName).filter(s => s);

        // 允许单源配置 (length >= 1)
        if (parts.length < 1) return null;

        const primary = parts[0];
        const secondaries = parts.slice(1);

        // 验证主源是否在允许列表中
        if (!this.MERGE_ALLOWED_SOURCES.includes(primary)) return null;

        // 过滤有效的副源，且排除主源本身（防止自我合并）
        const validSecondaries = secondaries.filter(sec =>
            sec !== primary && this.MERGE_ALLOWED_SOURCES.includes(sec)
        );

        return { primary, secondaries: validSecondaries };
      })
      .filter(Boolean);
  }

  /**
   * 解析合并映射表
   * 用于解析用户自定义的剧集/季度级别合并与乱序重排规则，以及阻断特定合并。
   * 支持从全局强制合并到精确单集的路由干预，解决跨源集数错位问题。
   * 格式:
   * 合并: 副源实体 -> 主源实体 | 路由规则
   * 阻断: 副源实体 × 主源实体
   * @returns {Array} 解析后的规则对象列表
   */
  static resolveCustomMergeRules() {
    const raw = this.get('CUSTOM_MERGE_RULES', '', 'string').trim();
    if (!raw) return [];

    const rules = [];
    const ruleStrs = raw.split(';');

    for (const rStr of ruleStrs) {
      if (!rStr.trim()) continue;
      try {
        const parts = rStr.split('|');
        const entities = parts[0];
        const routesStr = parts[1] || '';

        let secStr, primStr;
        let action = 'merge';

        if (entities.includes('->')) {
          [secStr, primStr] = entities.split('->').map(s => s.trim());
        } else if (entities.includes('×')) {
          [secStr, primStr] = entities.split('×').map(s => s.trim());
          action = 'block';
        } else {
          continue;
        }

        if (!secStr || !primStr) continue;

        // 解析实体信息：提取标题、季数、来源平台
        const parseEntity = (str) => {
          const match = str.match(/^(.+?)(?:\/S(\d+))?@([a-zA-Z0-9_&]+)$/i);
          if (match) {
            return {
              title: match[1].trim(),
              season: match[2] ? parseInt(match[2], 10) : null,
              source: match[3].toLowerCase()
            };
          }
          return null;
        };

        const secEntity = parseEntity(secStr);
        const primEntity = parseEntity(primStr);
        if (!secEntity || !primEntity) continue;

        // 解析路由规则：提取对应的单集或区间映射
        const routes = [];
        let hasRoutes = false;

        if (action === 'merge' && routesStr.trim()) {
          hasRoutes = true;
          const routeParts = routesStr.split(',');
          for (const rp of routeParts) {
            if (!rp.trim()) continue;
            const [sPart, pPart] = rp.split('>').map(s => s.trim());
            if (!sPart || !pPart) continue;

            const parseRange = (r) => {
              const match = r.match(/^E(\d+)(?:~E(\d+))?$/i);
              if (match) {
                return {
                  start: parseInt(match[1], 10),
                  end: match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10)
                };
              }
              return null;
            };

            const sRange = parseRange(sPart);
            const pRange = parseRange(pPart);

            if (sRange && pRange) {
              routes.push({ sec: sRange, prim: pRange });
            }
          }
        }

        rules.push({ action, secondary: secEntity, primary: primEntity, routes, hasRoutes });
      } catch (e) {
        console.warn(`[Envs] 解析合并映射表规则失败: ${rStr}`, e);
      }
    }

    return rules;
  }

  /**
   * 解析剧集标题过滤正则
   * @description 过滤非正片内容，同时内置白名单防止误杀正片
   * @returns {RegExp} 过滤正则表达式
   */
  static resolveEpisodeTitleFilter() {
    const defaultFilter =
      // [1] 基础物料与口语词防御，保护: 企划书, 预告犯, 被抢先了, 抢先一步, 化学反应, 一直拍, 单纯享
      '(特别|惊喜|纳凉)?企划(?!(书|案|部))|合伙人手记|超前(营业|vlog)?|速览|vlog|' +
      '(?<!(Chain|Chemical|Nuclear|连锁|化学|核|生化|生理|应激))reaction|' +
      '(?<!(单))纯享|加更(版|篇)?|抢先(看|版|集|篇)?|(?<!(被|争|谁))抢[先鲜](?!(一步|手|攻|了|告|言|机|话))|抢鲜|' +
      '预告(?!(函|信|书|犯))|(?<!(死亡|恐怖|灵异|怪谈))花絮(独家)?|(?<!(一|直))直拍|' +

      // [2] 影像特辑与PV防御，保护: 行动彩蛋, 采访吸血鬼, HPV/MPV, 鸦片花
      '(制作|拍摄|幕后|花絮|未播|独家|演员|导演|主创|杀青|探班|收官|开播|先导|彩蛋|NG|回顾|高光|个人|主创)特辑|' +
      '(?<!(行动|计划|游戏|任务|危机|神秘|黄金))彩蛋|(?<!(嫌疑人|证人|家属|律师|警方|凶手|死者))专访|' +
      '(?<!(证人))采访(?!(吸血鬼|鬼))|(正式|角色|先导|概念|首曝|定档|剧情|动画|宣传|主题曲|印象)[\\s\\.]*[PpＰｐ][VvＶｖ]|' +
      '(?<!(鸦|雪|纸|相|照|图|名|大))片花|' +

      // [3] 幕后/衍生/直播防御，保护: 幕后主谋, 番外地, 直播杀人/犯罪
      '(?<!(退居|回归|走向|转战|隐身|藏身|的))幕后(?!(主谋|主使|黑手|真凶|玩家|老板|金主|英雄|功臣|推手|大佬|操纵|交易|策划|博弈|BOSS|真相))(故事|花絮|独家)?|' +
      '衍生(?!(品|物|兽))|番外(?!(地|人))|直播(陪看|回顾)|' +
      '未播(片段)?|会员(专享|加长|尊享|专属|版)?|' +

      // [4] 解读/回顾/盘点防御，保护: 生命精华, 案情回顾, 财务盘点, 新闻发布会
      '(?<!(提取|吸收|生命|魔法|修护|美白))精华|看点|速看|解读(?!.*(密文|密码|密电|电报|档案|书信|遗书|碑文|代码|信号|暗号|讯息|谜题|人心|唇语|真相|谜团|梦境))|' +
      '(?<!(案情|人生|死前|历史|世纪))回顾|影评|解说|(?<!(更|会|能|来|的|比|适合|擅长|比起))吐槽(?!.*(艺人|役|大会|担当))|(?<!(年终|季度|库存|资产|物资|财务|收获|战利))盘点|' +
      '拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|' +
      '番外彩蛋|精彩片段|精彩看点|精彩集锦|看点解析|看点预告|NG镜头|NG花絮|' +

      // [5] 音乐/访谈/版本标识防御，保护: 生活插曲, Love Plus, 导演特别版, 独家记忆
      '番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|(?<!(生命|生活|情感|爱情|一段|小|意外))插曲|' +
      '高光回顾|背景音乐|OST|音乐MV|歌曲MV|前季回顾|剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|' +
      '独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|陪看(记)?|试看版|短剧|精编|' +
      '(?<!(Love|Disney|One|C|Note|S\\d+|\\+|&|\\s))Plus|独家版|(?<!(导演|加长|周年))特别版(?!(图|画))|短片|' +
      '(?<!(新闻|紧急|临时|召开|破坏|大闹|澄清|道歉|新品|产品|事故))发布会|解忧局|走心局|火锅局|巅峰时刻|坞里都知道|福持目标坞民|' +
      '福利(?!(院|会|主义|课))篇|(福利|加更|番外|彩蛋|衍生|特别|收官|游戏|整蛊|日常)篇|独家(?!(记忆|试爱|报道|秘方|占有|宠爱|恩宠))|' +

      // [6] “局”字深度逻辑防御，保护: 公安/警察/税务/教育/档案/交通等局, 以及做局/破局/局中局/局长
      '.{2,}(?<!(市|分|警|总|省|卫|药|政|监|结|大|开|破|布|僵|困|骗|赌|胜|败|定|乱|危|迷|谜|入|搅|设|中|残|平|和|终|变|对|安|做|书|画|察|务|案|通|信|育|商|象|源|业|冰))局(?!(长|座|势|面|部|内|外|中|限|促|气))|' +

      // [7] 观察室/纪录片/揭秘防御，保护: ICU观察室, 宇宙/自然/赛事全纪录, 揭秘者
      '(?<!(重症|隔离|实验|心理|审讯|单向|术后))观察室|上班那点事儿|周top|赛段|VLOG|' +
      '(?<!(大案|要案|刑侦|侦查|破案|档案|风云|历史|战争|探案|自然|人文|科学|医学|地理|宇宙|赛事|世界杯|奥运))全纪录|' +
      '开播|先导|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘(?!(者|人))|' +

      // [8] 动画花絮过滤：只杀结构的明确前缀 (如 S1, S2, C1, C2, SP1, OP1 等)
      '(?:^|】\\s*|\\]\\s*)(?:[SC]|SP|OP|ED|PV)\\d+(?:[\\s:：\\.\\-]|$)';

    // 读取环境变量，如果设置了则完全覆盖默认值
    const customFilter = this.get('EPISODE_TITLE_FILTER', '', 'string', false).trim();
    let keywords = customFilter || defaultFilter;

    this.accessedEnvVars.set('EPISODE_TITLE_FILTER', keywords);

    try {
      return new RegExp(`^(.*?)(?:${keywords})(.*?)$`, 'i');
    } catch (error) {
      console.warn(`Invalid EPISODE_TITLE_FILTER format, using default.`);
      return new RegExp(`^(.*?)(?:${defaultFilter})(.*?)$`, 'i');
    }
  }

  /**
   * 解析 IP 黑名单列表
   * @description 支持逗号/分号/换行分隔，支持 /regex/ 或 /regex/i 的正则格式，支持 IPv4/IPv6 CIDR（如 127.0.0.0/24、2001:db8::/64）
   * @returns {Array} IP 黑名单规则列表
   */


  /**
   * 校验 IPv4 地址合法性
   * @param {string} ip IPv4 地址
   * @returns {boolean}
   */


  /**
   * 校验 IPv6 地址合法性（支持 :: 缩写与 IPv4 映射）
   * @param {string} ip IPv6 地址
   * @returns {boolean}
   */


  /**
   * 解析剧名过滤正则
   * @description 用于控制剧名过滤规则，没有默认值
   * @returns {RegExp|null} 过滤正则表达式或null
   */
  static resolveAnimeTitleFilter() {
    // 读取环境变量，如果没有设置则返回null
    const filterStr = this.get('ANIME_TITLE_FILTER', '', 'string', false).trim();

    if (!filterStr) {
      this.accessedEnvVars.set('ANIME_TITLE_FILTER', '');
      return null;
    }

    this.accessedEnvVars.set('ANIME_TITLE_FILTER', filterStr);

    try {
      return new RegExp(`^(.*?)(?:${filterStr})(.*?)$`, 'i');
    } catch (error) {
      console.warn(`Invalid ANIME_TITLE_FILTER format, returning null.`);
      return null;
    }
  }

  /**
   * 解析剧名杂音清理规则
   * 移除搜索关键词和源标题中的画质/配音/版本等杂音词。
   * 支持完全自定义的正则表达式，默认为同时匹配中英文括号的常用杂音词。
   * 未设置时使用默认规则，设为空值可禁用。
   * @returns {RegExp|null} 全局正则，显式设为空时返回 null（禁用）
   */
  static resolveTitleNoiseFilter() {
    const defaultPattern = String.raw`[（(\[［](?:臻彩|真彩|高清|标清|超清|国配|中配|日配|粤语|原声|台配|无修|未删减|完整版|日语版|国语版|英语版|中字|字幕|助听|原版)[\])）］]`;
    const raw = this.get('TITLE_NOISE_FILTER', '', 'string').trim();
    const hasKey = (this.env && 'TITLE_NOISE_FILTER' in this.env)
                || (typeof process !== 'undefined' && 'TITLE_NOISE_FILTER' in process.env);

    if (!raw) {
      if (hasKey) { this.accessedEnvVars.set('TITLE_NOISE_FILTER', ''); return null; }
      this.accessedEnvVars.set('TITLE_NOISE_FILTER', defaultPattern);
    } else {
      this.accessedEnvVars.set('TITLE_NOISE_FILTER', raw);
    }

    try { return new RegExp(raw || defaultPattern, 'gi'); }
    catch (e) { console.warn('Invalid TITLE_NOISE_FILTER regex, using default.'); try { return new RegExp(defaultPattern, 'gi'); } catch (e2) { return null; } }
  }

  /**
   * 获取记录的原始环境变量 JSON
   * @returns {Map<any, any>} JSON 字符串
   */
  static getOriginalEnvVars() {
    return this.originalEnvVars;
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

  static resolveAutoMatchMappingTable() {
    const mappingStr = this.get('AUTO_MATCH_MAPPING_TABLE', '', 'string').trim();
    const { rules, warnings } = parseAutoMatchMappingRules(mappingStr, this.ALLOWED_PLATFORMS);
    warnings.forEach(message => console.warn(`[auto-match-mapping] ${message}`));
    return rules;
  }

  /**
   * 获取记录的环境变量 JSON
   * @returns {Map<any, any>} JSON 字符串
   */
  static getAccessedEnvVars() {
    return this.accessedEnvVars;
  }

  static resolveBlockedWords() {
    const configured = [this.env, this.systemEnvBackup, this.rawEnvValues,
      typeof process === 'undefined' ? null : process.env].some(env => env && Object.hasOwn(env, 'BLOCKED_WORDS'));
    const raw = this.get('BLOCKED_WORDS', configured ? '' : BLOCKED_WORD_PRESETS.content.join(','), 'string');
    const legacy = {};
    for (const key of LEGACY_BLOCKED_WORD_KEYS) {
      if (Object.hasOwn(this.env || {}, key)) legacy[key] = this.env[key];
      else if (typeof process !== 'undefined' && Object.hasOwn(process.env || {}, key)) legacy[key] = process.env[key];
    }
    const value = migrateLegacyBlockedWords({ ...legacy, BLOCKED_WORDS: raw }).BLOCKED_WORDS;
    this.originalEnvVars.set('BLOCKED_WORDS', value);
    this.accessedEnvVars.set('BLOCKED_WORDS', value);
    return value;
  }

  /**
   * 初始化环境变量
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 配置对象
   */
  static load(env = {}) {
    this.env = env;
    for (const key of LEGACY_BLOCKED_WORD_KEYS) {
      this.originalEnvVars.delete(key);
      this.accessedEnvVars.delete(key);
    }

    // 环境变量分类和描述映射
    const envVarConfig = {
      // API配置
      'TOKEN': { category: 'api', type: 'text', description: 'API访问令牌' },
      'TOKEN_AUTH_DISABLED': { category: 'api', type: 'boolean', description: '关闭 API 和管理界面的 TOKEN 鉴权（仅建议在受信任的内网环境使用）' },
      'ADMIN_TOKEN': { category: 'api', type: 'text', description: '系统管理访问令牌' },
      'RATE_LIMIT_MAX_REQUESTS': { category: 'api', type: 'number', description: '限流配置：1分钟内最大请求次数，0表示不限流，默认3', min: 0, max: 50 },

      // 源配置
      'SOURCE_ORDER': { category: 'source', type: 'multi-select', options: this.ALLOWED_SOURCES, description: '启用的弹幕来源及搜索结果排列顺序。手动搜索并发查询这些来源；自动匹配按 PLATFORM_ORDER 分组搜索，本配置决定组内结果顺序，不决定自动匹配的组间优先级。' },
      'MERGE_SOURCE_PAIRS': { category: 'source', type: 'multi-select', options: this.MERGE_ALLOWED_SOURCES, description: '配置实际合并返回的弹幕来源，允许多组、多源、单源保留原结果。组内第一个为主源，其余为副源；主源无结果时轮替下一源。\n自动匹配只合并当前 PLATFORM_ORDER 组内已搜索的来源；需要一起合并的源应放在同一平台组。\n格式：源1&源2&源3，多组用逗号分隔。\n示例：tencent&iqiyi,youku&bilibili' },
      'CUSTOM_MERGE_RULES': { category: 'source', type: 'text', sources: this.MERGE_ALLOWED_SOURCES, description: '合并映射表，用于自定义源合并行为。\n格式1(合并)：副源剧名/S季数@来源 -> 主源剧名/S季数@来源 | E副源集数>E主源集数\n格式2(阻断)：副源剧名/S季数@来源 × 主源剧名/S季数@来源\n说明：[/S季数] 与 [|路由规则] 为可选项，留空则交由程序判断。多个规则用分号隔开，多段路由用逗号分隔。\n示例：\n1. 常规合并：天气之子@bilibili -> 天气之子@tencent\n2. 多集路由：我推的孩子/S01@bahamut -> 我推的孩子/S03@tencent | E25~E35>E25~E35\n3. 阻断合并：辉夜大小姐想让我告白？～天才们的恋爱头脑战～(2020)@bilibili × 辉夜大小姐想让我告白～天才们的恋爱头脑战～ OVA(2021)【OVA】@tencent' },
      'BILIBILI_COOKIE': { category: 'source', type: 'text', description: 'B站Cookie' },
      'YOUKU_CONCURRENCY': { category: 'source', type: 'number', description: '优酷并发配置，默认8', min: 1, max: 16 },
      'TENCENT_CONCURRENCY': { category: 'source', type: 'number', description: '腾讯弹幕分片并发数，默认100，范围1-200', min: 1, max: 200 },
      'IQIYI_CONCURRENCY': { category: 'source', type: 'number', description: '爱奇艺弹幕分片并发数，默认100，范围1-200', min: 1, max: 200 },

      // 匹配配置
      'PLATFORM_ORDER': { category: 'match', type: 'multi-select', options: this.ALLOWED_PLATFORMS, description: '自动匹配的平台组搜索与选择顺序：逗号分组，按组依次执行；& 连接同组并发来源。有有效季集匹配就停止，不启动后续组；全部未命中才搜索其余启用源。\n示例：tencent&youku,hongguo。只搜索 SOURCE_ORDER 已启用的来源。\n& 本身不启用弹幕合并，实际合并由 MERGE_SOURCE_PAIRS / CUSTOM_MERGE_RULES 控制。指定平台或手动选择优先。' },
      'ANIME_TITLE_FILTER': { category: 'match', type: 'text', description: '剧名过滤规则' },
      'EPISODE_TITLE_FILTER': { category: 'match', type: 'text', description: '剧集标题过滤规则' },
      'ENABLE_ANIME_EPISODE_FILTER': { category: 'match', type: 'boolean', description: '控制手动搜索的时候是否根据ANIME_TITLE_FILTER进行剧名过滤以及根据EPISODE_TITLE_FILTER进行集标题过滤' },
      'STRICT_TITLE_MATCH': { category: 'match', type: 'boolean', description: '严格标题匹配模式' },
      'ANIME_TITLE_SIMPLIFIED': { category: 'match', type: 'boolean', description: '搜索的剧名标题自动繁转简' },
      'TITLE_MAPPING_TABLE': { category: 'match', type: 'map', description: '本机剧名映射表，用于自动匹配时替换标题进行搜索。本机规则优先于远程规则。远程映射默认关闭；启用时请在下方 TITLE_MAPPING_TABLE_URL 填写：https://raw.githubusercontent.com/xlmc/danmu-mapping/main/Word/2026.txt。格式：原始标题->映射标题;原始标题->映射标题;...，例如："唐朝诡事录->唐朝诡事录之西行;国色芳华->锦绣芳华"' },
      'TITLE_MAPPING_TABLE_URL': { category: 'match', type: 'text', description: '远程剧名映射表（默认关闭，填写后启用）。推荐地址：https://raw.githubusercontent.com/xlmc/danmu-mapping/main/Word/2026.txt。程序首次下载后保存到本地，匹配时只读取本地缓存，不连接远程；每天北京时间05:30更新，失败保留旧缓存。本机 TITLE_MAPPING_TABLE 优先于远程表。支持 GitHub 文件页、Gist、jsDelivr 及任意 TXT 直链；内容格式为每行 原始标题->映射标题，# 或 // 开头为注释' },
      'AUTO_MATCH_MAPPING_TABLE': { category: 'match', type: 'map', description: '自动匹配映射表，仅作用于 POST /api/v2/match。多个规则使用分号分隔。\n开放映射：永生 S05E02 -> 永生 S01E58\n有限范围：永生 S05E02~03 -> 永生 S01E58~59\n指定结果：海贼王 S02E01 -> 航海王(1999)【动漫】 S01E62\n指定平台：航海王 S01E01 -> 航海王 S01E01 @iqiyi\n可选发布组：作品 S01E01 {[group=ANi]} -> 作品 S01E02；文件名有发布组时优先专用规则，失败后回退通用规则' },
      'AUTO_MATCH_MAPPING_TABLE_URL': { category: 'match', type: 'text', description: '远程季集映射表（默认关闭）。推荐填写 danmu-mapping 的 Word/season-candidates.txt。下载后保存到本机缓存，匹配过程中只读取本机缓存；每天北京时间05:30更新，失败沿用旧缓存。本机 AUTO_MATCH_MAPPING_TABLE 优先。为防止过度转换，远程表只接受同时写明起止集的有限范围规则；源侧可选使用 {[group=ANi]} 发布组标记。' },
      'TITLE_NOISE_FILTER': { category: 'match', type: 'text', description: '剧名杂音清理规则，按正则表达式清理搜索与匹配阶段的剧名杂音词（如`百花杀（真彩）`→`百花杀`）。\n默认值：[（(\\[［](?:臻彩|真彩|高清|标清|超清|国配|中配|日配|粤语|原声|台配|无修|未删减|完整版|日语版|国语版|英语版|中字|字幕|助听|原版)[\\])）］]，中英文圆方括号均匹配。\n设为空值可禁用' },
      'USE_BANGUMI_DATA': { category: 'match', type: 'boolean', description: 'Bangumi Data 加速匹配开关，开启后将动画元数据缓存至本地或内存中给源调用，提升动画源的检索与匹配速度并解锁隐藏/区域番剧。\n本地和Docker部署使用时请先挂载.cache目录获得最佳体验，云部署使用时会将数据缓存至临时内存中如果体验不佳请关闭。' },

      // 弹幕配置
      'BLOCKED_WORDS': { category: 'danmu', type: 'text', description: '屏蔽词列表：仅支持普通词（字面包含匹配）和 /正则/flags。配置页按分类单行摘要显示；编辑器各分类默认单行折叠，点击分类展开，再点击编辑修改完整条目；支持逐条添加、修改和删除，点击保存后生效。内置纯数字/符号、日期时间、地区预设正则单独分类，自定义正则归为其他正则。底层仍用逗号分隔，命中任意规则即屏蔽整条弹幕。' },
      'BLOCK_DOMESTIC_CELEBRITIES': { category: 'danmu', type: 'boolean', description: '当前作品人物与作品名屏蔽开关，默认关闭。开启后同时屏蔽当前作品完整名称及已有别名（兼容简繁、大小写、空格及标点差异，不派生作品简称）；与人物过滤共用免屏蔽名单，人物资料查询失败时仍按已知作品名称过滤。开启后通过 TMDB 获取当前国产/港台作品的中文演员名和角色名；当前作品演员表和角色表的完整姓名及派生称呼直接包含匹配：识别复姓，派生二字及以上去姓称呼及名字中相邻二字简称（如热巴、千玺）；全名、姓、名字及名字中的单字组合小/老/阿/大前缀、儿/子/哥姐/叔姨/老师/总/导/宝/崽等亲昵称谓、身份称谓和单字叠称。单字本身不屏蔽，同名普通词及更长词也会命中。需要可用的 TMDB_API_KEY，或能够代为认证的 TMDB 反代；动画角色名单同时合并 Bangumi 当前条目及动画前传、续集的角色资料；维基百科补充当前作品演员、角色及表中化名，校验作品名称与首播/上映年份，不遍历演员作品表。各资料源与弹幕拉取并行，返回前完成过滤，匹配兼容简繁中文；查询失败或名单不完整时五分钟后允许重试，完整名单缓存一天。' },
      'PERSON_FILTER_EXCLUDED_TITLES': { category: 'danmu', type: 'text', description: '不屏蔽人物和作品名的动漫/作品名单，支持逗号、分号或换行分隔。可填写实际作品名或已有别名，例如“诛仙4”；系统通过现有名称对应关系取得实际作品名后判断是否免屏蔽，名单里只填名字。同时跳过自动演员/角色及当前作品名屏蔽，其他屏蔽词、地区和日期规则继续生效。' },
      'GROUP_MINUTE': { category: 'danmu', type: 'number', description: '分钟内合并去重（0表示不去重），默认1', min: 0, max: 30 },
      'DANMU_LIMIT': { category: 'danmu', type: 'number', description: '弹幕数量限制，单位为k，即千：默认 0，表示不限制弹幕数', min: 0, max: 100 },
      'DANMU_SIMPLIFIED_TRADITIONAL': { category: 'danmu', type: 'select', options: ['default', 'simplified', 'traditional'], description: '弹幕简繁体转换设置：default（默认不转换）、simplified（繁转简）、traditional（简转繁）' },
      'CONVERT_TOP_BOTTOM_TO_SCROLL': { category: 'danmu', type: 'boolean', description: '顶部/底部弹幕转换为浮动弹幕' },
      'CONVERT_COLOR': { category: 'danmu', type: 'select', options: ['default', 'white', 'color'], description: '弹幕转换颜色配置' },
      'COLOR_POOL': { category: 'danmu', type: 'text', description: '自定义颜色池（CONVERT_COLOR为color时生效），不配置使用默认颜色池，格式：十进制颜色值逗号分隔' },
      'GRADIENT_ENABLED': { category: 'danmu', type: 'boolean', description: '启用渐变弹幕，默认关闭；普通白色弹幕按概率使用固定 B站粉蓝渐变（#FB7299→#33B8FF），无需开启颜色转换' },
      'GRADIENT_CHANCE': { category: 'danmu', type: 'number', min: 0, max: 100, description: '渐变弹幕概率（GRADIENT_ENABLED开启时生效），单位百分比 0-100，默认 0；固定 B站粉蓝渐变，0 表示不生成渐变弹幕' },
      'DANMU_OUTPUT_FORMAT': { category: 'danmu', type: 'select', options: ['json', 'xml', 'danmux', ...danAnyFormats], description: '弹幕输出格式，默认json' },
      'LIKE_SWITCH': { category: 'danmu', type: 'boolean', description: '弹幕点赞数显示开关，默认开启' },
      'HONGGUO_MERGE_ALL_EPISODES': { category: 'danmu', type: 'boolean', description: '红果短剧合并全集弹幕，默认关闭' },
      'DANMU_OFFSET': { category: 'danmu', type: 'text', sources: this.ALLOWED_SOURCES, description: '弹幕时间偏移配置，格式：剧名:秒 或 剧名/季:秒 或 剧名/季/集:秒，支持指定来源：剧名@来源:秒 或 剧名/季@来源1&来源2:秒，多条用逗号分隔，正数表示弹幕延后（向右），负数表示弹幕提前（向左）。支持百分比模式：在路径或来源末尾追加 %，如 东方/S03/E02@tencent%:11，按公式 原时间 * (视频时长 + 偏移秒数) / 视频时长 缩放全部弹幕时间。示例：overlord/S01:90,re-zero/S02@bilibili:120,re-zero/S02/E03@tencent&bilibili:10,东方/S03/E02@tencent%:11' },
      'BILIBILI_UGC_ENABLED': { category: 'danmu', type: 'boolean', description: 'B站 UGC 多源弹幕补充开关。开启后自动检索并验证相同剧集的优质投稿，对齐时间轴后叠加弹幕。' },

      // 缓存配置
      'LOCAL_CACHE_ENABLED': { category: 'cache', type: 'boolean', description: '通用文件缓存开关，默认开启且仍需已有 .cache 目录；关闭后不读取或写入通用文件缓存，包括收藏与定时计划；已配置 Upstash 时仍可持久化。不影响本地弹幕文件、Bangumi Data 或 Redis' },
      'SEARCH_CACHE_MINUTES': { category: 'cache', type: 'number', description: '搜索结果缓存时间(分钟)，默认3', min: 1, max: 120 },
      'MATCH_SEARCH_BUDGET_MS': { category: 'match', type: 'number', description: '自动匹配当前平台组的快速返回等待时间，默认1500毫秒。无组内合并时，准确季集可提前返回，组内已启动的慢源继续完成；需要合并时等待本组完成。后续平台组只有当前组未匹配才启动。0关闭快速目录复用和提前返回，仍按组搜索。手动搜索不受影响。', min: 0, max: 10000 },
      'COMMENT_CACHE_MINUTES': { category: 'cache', type: 'number', description: '弹幕缓存时间(分钟)，默认3', min: 1, max: 120 },
      'COMMENT_CACHE_MIN_COUNT': { category: 'cache', type: 'number', description: '弹幕缓存最少条数，低于该值时重新获取，默认100，设置0关闭', min: 0, max: 10000 },
      'REMEMBER_LAST_SELECT': { category: 'cache', type: 'boolean', description: '记住明确手动选择的结果；自动匹配后直接获取其返回结果不会写入偏好' },
      'MAX_LAST_SELECT_MAP': { category: 'cache', type: 'number', description: '记住上次选择映射缓存大小限制，默认100', min: 10, max: 1000 },
      'MAX_ANIMES': { category: 'cache', type: 'number', description: '动漫标题缓存最大数量，默认100', min: 100, max: 1000 },
      'LOCAL_REDIS_URL': { category: 'cache', type: 'text', description: '本地 Redis 连接URL，示例：redis://:password@127.0.0.1:6379/0，只支持本地部署和docker部署' },
      'BANGUMI_DATA_CACHE_DAYS': { category: 'cache', type: 'number', description: 'Bangumi Data 缓存有效期(天)，设置0则每次请求时强制异步更新，默认7天', min: 0, max: 30 },

      // 系统配置
      'UI_THEME': { category: 'system', type: 'select', options: ['lavender', 'shinyo', 'sakura', 'tianyi', 'hatsune', 'sakuragi', 'violet', 'amber'], description: '管理界面主题' },
      'PROXY_URL': { category: 'system', type: 'text', description: '代理/反代地址' },
      'TMDB_API_KEY': { category: 'system', type: 'text', description: 'TMDB API密钥' },
      'LOG_LEVEL': { category: 'system', type: 'select', options: ['debug', 'info', 'warn', 'error'], description: '日志级别配置' },
    };

    return {
      allowedPlatforms: this.ALLOWED_PLATFORMS,
      token: this.get('TOKEN', '87654321', 'string', true), // token，默认为87654321
      tokenAuthDisabled: this.get('TOKEN_AUTH_DISABLED', false, 'boolean'), // 是否关闭 TOKEN 鉴权
      adminToken: this.get('ADMIN_TOKEN', '', 'string', true), // admin token，用于系统管理访问控制
      sourceOrderArr: this.resolveSourceOrder(), // 源排序
      mergeSourcePairs: this.resolveMergeSourcePairs(), // 源合并配置，用于将源合并获取
      customMergeRules: this.resolveCustomMergeRules(), // 合并映射表，用于自定义源合并行为。
      bilibliCookie: this.get('BILIBILI_COOKIE', '', 'string', true), // b站cookie
      // 发布流程通过 build-arg 注入的自用版本（形如 xdanmu-v0.60）；页头「当前版本」使用，未注入时回退上游版本号
      selfVersion: this.get('XDANMU_VERSION', '', 'string'),
      bilibiliUgcEnabled: this.get('BILIBILI_UGC_ENABLED', false, 'boolean'),
      bilibiliUgcBudgetMs: Math.max(1000, Math.min(120000, this.get('BILIBILI_UGC_BUDGET_MS', 10000, 'number'))),
      youkuConcurrency: Math.min(this.get('YOUKU_CONCURRENCY', 8, 'number'), 16), // 优酷并发配置
      tencentConcurrency: Math.min(200, Math.max(1, Math.floor(this.get('TENCENT_CONCURRENCY', 100, 'number')))),
      iqiyiConcurrency: Math.min(200, Math.max(1, Math.floor(this.get('IQIYI_CONCURRENCY', 100, 'number')))),
      platformOrderArr: this.resolvePlatformOrder(), // 自动匹配优选平台
      animeTitleFilter: this.resolveAnimeTitleFilter(), // 剧名正则过滤
      episodeTitleFilter: this.resolveEpisodeTitleFilter(), // 剧集标题正则过滤
      titleNoiseFilter: this.resolveTitleNoiseFilter(), // 剧名杂音清理规则
      blockedWords: this.resolveBlockedWords(), // 屏蔽词列表
      blockDomesticCelebrities: this.get('BLOCK_DOMESTIC_CELEBRITIES', false, 'boolean'), // 按当前作品演员/角色表屏蔽姓名
      personFilterExcludedTitles: this.get('PERSON_FILTER_EXCLUDED_TITLES', '', 'string'),
      groupMinute: Math.min(this.get('GROUP_MINUTE', 1, 'number'), 30), // 分钟内合并去重（默认 1，最大值30，0表示不去重）
      danmuLimit: this.get('DANMU_LIMIT', 0, 'number'), // 等间隔采样限制弹幕总数，单位为k，即千：默认 0，表示不限制弹幕数，若改为5，弹幕总数在超过5000的情况下会将弹幕数控制在5000
      uiTheme: this.get('UI_THEME', 'lavender', 'string').toLowerCase(), // 管理界面主题
      proxyUrl: this.get('PROXY_URL', '', 'string', true), // 代理/反代地址
      danmuSimplifiedTraditional: this.get('DANMU_SIMPLIFIED_TRADITIONAL', 'default', 'string'), // 弹幕简繁体转换设置：default（默认不转换）、simplified（繁转简）、traditional（简转繁）
      likeSwitch: this.get('LIKE_SWITCH', true, 'boolean'), // 弹幕点赞数显示开关，默认开启
      danmuOffset: this.get('DANMU_OFFSET', '', 'string'), // 弹幕时间偏移配置
      danmuOffsetRules: parseOffsetRules(this.get('DANMU_OFFSET', '', 'string')), // 解析后的偏移规则（缓存）
      tmdbApiKey: this.get('TMDB_API_KEY', '', 'string', true), // TMDB API KEY
      localCacheEnabled: this.get('LOCAL_CACHE_ENABLED', true, 'boolean'), // 允许使用已有 .cache 目录保存通用文件缓存
      localRedisUrl: this.get('LOCAL_REDIS_URL', '', 'string', true), // 本地 Redis 连接URL，示例：redis://:password@127.0.0.1:6379/0，只支持本地部署和docker部署
      rateLimitMaxRequests: this.get('RATE_LIMIT_MAX_REQUESTS', 3, 'number'), // 限流配置：时间窗口内最大请求次数（默认 3，0表示不限流）
      enableAnimeEpisodeFilter: this.get('ENABLE_ANIME_EPISODE_FILTER', false, 'boolean'), // 控制手动搜索的时候是否根据ANIME_TITLE_FILTER进行剧名过滤以及根据EPISODE_TITLE_FILTER进行集标题过滤（默认 false，禁用过滤）
      logLevel: this.get('LOG_LEVEL', 'info', 'string'), // 日志级别配置（默认 info，可选值：error, warn, info, debug）
      searchCacheMinutes: this.get('SEARCH_CACHE_MINUTES', 3, 'number'), // 搜索结果缓存时间配置（分钟，默认 3）
      matchSearchBudgetMs: Math.max(0, Math.min(10000, this.get('MATCH_SEARCH_BUDGET_MS', 1500, 'number'))),
      commentCacheMinutes: this.get('COMMENT_CACHE_MINUTES', 3, 'number'), // 弹幕缓存时间配置（分钟，默认 3）
      commentCacheMinCount: this.get('COMMENT_CACHE_MIN_COUNT', 100, 'number'), // 弹幕缓存最少条数，低于该值时忽略缓存（默认 100，0 表示关闭）
      hongguoMergeAllEpisodes: this.get('HONGGUO_MERGE_ALL_EPISODES', false, 'boolean'), // 红果短剧是否合并全集弹幕（默认 false）
      convertTopBottomToScroll: this.get('CONVERT_TOP_BOTTOM_TO_SCROLL', false, 'boolean'), // 顶部/底部弹幕转换为浮动弹幕配置（默认 false，禁用转换）
      convertColor: this.get('CONVERT_COLOR', 'default', 'string'), // 弹幕转换颜色配置，支持 default、white、color（默认 default，禁用转换）
      colorPool: this.get('COLOR_POOL', '16777215,16777215,16777215,16777215,16777215,16777215,16777215,16777215,16744319,16752762,16774799,9498256,8388564,8900346,14204888,16758465', 'string'), // 自定义颜色池，CONVERT_COLOR为color时生效
      gradientEnabled: this.get('GRADIENT_ENABLED', false, 'boolean'), // 独立渐变开关
      gradientChance: this.get('GRADIENT_CHANCE', 0, 'number'), // 渐变色弹幕出现概率（百分比），GRADIENT_ENABLED开启时生效，0 表示关闭
      danmuOutputFormat: this.get('DANMU_OUTPUT_FORMAT', 'json', 'string'), // 弹幕输出格式配置（默认 json，可选值：json, xml, ...danAnyFormats）
      strictTitleMatch: this.get('STRICT_TITLE_MATCH', false, 'boolean'), // 严格标题匹配模式配置（默认 false，宽松模糊匹配）
      animeTitleSimplified: this.get('ANIME_TITLE_SIMPLIFIED', false, 'boolean'), // 搜索的剧名标题自动繁转简
      localTitleMappingTable: this.resolveTitleMappingTable(), // 保留纯本地表，避免远程合并覆盖本地查询
      titleMappingTable: this.resolveTitleMappingTable(), // 剧名映射表，用于自动匹配时替换标题进行搜索
      titleMappingTableUrl: this.get('TITLE_MAPPING_TABLE_URL', '', 'string'), // 远程剧名映射表地址（由用户托管维护，自动拉取生效）
      autoMatchMappingTable: this.resolveAutoMatchMappingTable(), // 自动匹配标题/季度/集数映射规则
      autoMatchMappingTableUrl: this.get('AUTO_MATCH_MAPPING_TABLE_URL', '', 'string'), // 远程季集映射表地址
      useBangumiData: this.get('USE_BANGUMI_DATA', false, 'boolean'), // Bangumi Data 加速匹配开关
      rememberLastSelect: this.get('REMEMBER_LAST_SELECT', true, 'boolean'), // 是否记住手动选择结果，用于match自动匹配时优选上次的选择（默认 true，记住）
      MAX_LAST_SELECT_MAP: this.get('MAX_LAST_SELECT_MAP', 100, 'number'), // 记住上次选择映射缓存大小限制（默认 100）
      MAX_ANIMES: this.get('MAX_ANIMES', 100, 'number'), // 动漫标题缓存最大数量（默认 100）
      bangumiDataCacheDays: this.get('BANGUMI_DATA_CACHE_DAYS', 7, 'number'), // Bangumi Data 缓存有效期(天)，默认7天
      envVarConfig: envVarConfig // 环境变量分类和描述映射
    };
  }
}
