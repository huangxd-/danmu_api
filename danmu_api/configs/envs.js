/**
 * 环境变量管理模块
 * 提供获取和设置环境变量的函数，支持 Cloudflare Workers 和 Node.js
 */
export class Envs {
  static env;

  // 记录获取过的环境变量
  static originalEnvVars = new Map();
  static accessedEnvVars = new Map();

  static VOD_ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'migu', 'sohu', 'leshi', 'xigua']; // vod允许的播放平台
  static ALLOWED_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'migu', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'xigua', 'animeko', 'custom']; // 全部源允许的播放平台
  static ALLOWED_SOURCES = ['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'migu', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'xigua', 'animeko', 'custom']; // 允许的源
  static MERGE_ALLOWED_SOURCES = ['tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'migu', 'renren', 'hanjutv', 'bahamut', 'dandan', 'sohu', 'leshi', 'xigua', 'animeko']; // 允许的源合并

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
   * 支持单个平台或通过&连接的组合平台（如 bilibili1&dandan）
   * @returns {Array} 平台排序数组
   */
  static resolvePlatformOrder() {
    const rawOrder = this.get('PLATFORM_ORDER', '', 'string');
    
    const orderArr = rawOrder
      .split(',')
      .map(s => s.trim())
      .filter(item => {
        if (!item) return false;
        // 如果包含 &，则分割校验每一部分是否有效
        if (item.includes('&')) {
            const parts = item.split('&').map(p => p.trim());
            return parts.every(p => this.ALLOWED_PLATFORMS.includes(p));
        }
        // 单个平台直接校验
        return this.ALLOWED_PLATFORMS.includes(item);
      });

    this.accessedEnvVars.set('PLATFORM_ORDER', orderArr);

    return orderArr.length > 0 ? [...orderArr, null] : [null];
  }

  /**
   * 解析源合并配置
   * 从环境变量 MERGE_SOURCE_PAIRS 获取配置
   * 支持使用分号或逗号分隔多组配置
   * 支持一主多从配置，第一个为主源，后续为副源
   * 允许单源配置（用于保留特定源的原始结果，不被合并消耗）
   * 格式示例: bilibili&animeko, dandan&animeko&bahamut,dandan
   * @returns {Array} 合并配置数组 [{primary: 'dandan', secondaries: ['animeko', 'bahamut']}, {primary: 'renren', secondaries: []}]
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
        const parts = group.split('&').map(s => s.trim()).filter(s => s);
        
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
      '(?<!(退居|回归|走向|转战|隐身|藏身))幕后(?!(主谋|主使|黑手|真凶|玩家|老板|金主|英雄|功臣|推手|大佬|操纵|交易|策划|博弈|BOSS|真相))(故事|花絮|独家)?|' +
      '衍生(?!(品|物|兽))|番外(?!(地|人))|直播(陪看|回顾)?|直播(?!(.*(事件|杀人|自杀|谋杀|犯罪|现场|游戏|挑战)))|' +
      '未播(片段)?|会员(专享|加长|尊享|专属|版)?|' +
      
      // [4] 解读/回顾/盘点防御，保护: 生命精华, 案情回顾, 财务盘点, 新闻发布会
      '(?<!(提取|吸收|生命|魔法|修护|美白))精华|看点|速看|解读(?!.*(密文|密码|密电|电报|档案|书信|遗书|碑文|代码|信号|暗号|讯息|谜题|人心|唇语|真相|谜团|梦境))|' +
      '(?<!(案情|人生|死前|历史|世纪))回顾|影评|解说|吐槽|(?<!(年终|季度|库存|资产|物资|财务|收获|战利))盘点|' +
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
      '开播|先导|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘(?!(者|人))';

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
      'MERGE_SOURCE_PAIRS': { category: 'source', type: 'multi-select', options: this.MERGE_ALLOWED_SOURCES, description: '源合并配置，配置后将对应源合并同时一起获取弹幕返回，允许多组，允许多源，允许填单源表示保留原结果，一组中第一个为主源其余为副源，副源往主源合并，主源如果没有结果会轮替下一个作为主源。\n格式：源1&源2&源3 ，多组用逗号分隔。\n示例：dandan&animeko&bahamut,bilibili&animeko,dandan' },
      
      // 匹配配置
      'PLATFORM_ORDER': { category: 'match', type: 'multi-select', options: this.ALLOWED_PLATFORMS, description: '平台排序配置，可以配置自动匹配时的优选平台。\n当配置合并平台的时候，可以指定期望的合并源，\n示例：一个结果返回了“dandan&bilibili1&animeko”和“youku”时，\n当配置“youku”时返回“youku” \n当配置“dandan&animeko”时返回“dandan&bilibili1&animeko”' },
      'EPISODE_TITLE_FILTER': { category: 'match', type: 'text', description: '剧集标题过滤规则' },
      'ENABLE_EPISODE_FILTER': { category: 'match', type: 'boolean', description: '集标题过滤开关' },
      'STRICT_TITLE_MATCH': { category: 'match', type: 'boolean', description: '严格标题匹配模式' },
      'TITLE_TO_CHINESE': { category: 'match', type: 'boolean', description: '外语标题转换中文开关' },
      'TITLE_MAPPING_TABLE': { category: 'match', type: 'map', description: '剧名映射表，用于自动匹配时替换标题进行搜索，格式：原始标题->映射标题;原始标题->映射标题;... ，例如："唐朝诡事录->唐朝诡事录之西行;国色芳华->锦绣芳华"' },

      // 弹幕配置
      'BLOCKED_WORDS': { category: 'danmu', type: 'text', description: '屏蔽词列表' },
      'GROUP_MINUTE': { category: 'danmu', type: 'number', description: '分钟内合并去重（0表示不去重），默认1', min: 0, max: 30 },
      'DANMU_LIMIT': { category: 'danmu', type: 'number', description: '弹幕数量限制，单位为k，即千：默认 0，表示不限制弹幕数', min: 0, max: 100 },
      'DANMU_SIMPLIFIED_TRADITIONAL': { category: 'danmu', type: 'select', options: ['default', 'simplified', 'traditional'], description: '弹幕简繁体转换设置：default（默认不转换）、simplified（繁转简）、traditional（简转繁）' },
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
      danmuSimplifiedTraditional: this.get('DANMU_SIMPLIFIED_TRADITIONAL', 'default', 'string'), // 弹幕简繁体转换设置：default（默认不转换）、simplified（繁转简）、traditional（简转繁）
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
      convertColor: this.get('CONVERT_COLOR', 'default', 'string'), // 弹幕转换颜色配置，支持 default、white、color（默认 default，禁用转换）
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
