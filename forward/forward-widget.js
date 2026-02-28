import { searchAnime, getBangumi, getComment, getSegmentComment, matchSeason } from '../danmu_api/apis/dandan-api.js';
import { Globals } from '../danmu_api/configs/globals.js';
import { log } from '../danmu_api/utils/log-util.js';
import { simplized } from '../danmu_api/utils/zh-util.js';

const wv = typeof widgetVersion !== 'undefined' ? widgetVersion : Globals.VERSION;

WidgetMetadata = {
  id: "forward.auto.danmu2",
  title: "自动链接弹幕v2",
  version: wv,
  requiredVersion: "0.0.2",
  description: "自动获取播放链接并从服务器获取弹幕【五折码：CHEAP.5;七折码：CHEAP】",
  author: "huangxd",
  site: "https://github.com/huangxd-/ForwardWidgets",
  globalParams: [
    // 源配置
    {
      name: "sourceOrder",
      title: "源排序配置，默认'360,vod,renren,hanjutv'，可选['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'migu', 'sohu', 'leshi', 'xigua', 'maiduidui', 'renren', 'hanjutv', 'bahamut', 'dandan', 'custom']",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "tencent,iqiyi,imgo,bilibili,youku,renren,hanjutv",
        },
        {
          title: "配置2",
          value: "douban,360,vod,renren,hanjutv",
        },
        {
          title: "配置3",
          value: "360,vod,renren,hanjutv",
        },
        {
          title: "配置4",
          value: "vod,360,renren,hanjutv,bahamut,dandan",
        },
      ],
    },
    {
      name: "otherServer",
      title: "第三方弹幕服务器，默认https://api.danmu.icu",
      type: "input",
      placeholders: [
        {
          title: "icu",
          value: "https://api.danmu.icu",
        },
        {
          title: "lyz05",
          value: "https://fc.lyz05.cn",
        },
        {
          title: "hls",
          value: "https://dmku.hls.one",
        },
        {
          title: "678",
          value: "https://se.678.ooo",
        },
        {
          title: "56uxi",
          value: "https://danmu.56uxi.com",
        },
        {
          title: "lxlad",
          value: "https://dm.lxlad.com",
        },
      ],
    },
    {
      name: "customSourceApiUrl",
      title: "自定义弹幕源API地址，默认为空，配置后还需在SOURCE_ORDER添加custom源",
      type: "input",
      placeholders: [
        {
          title: "自定义",
          value: "",
        },
      ],
    },
    {
      name: "vodServers",
      title: "VOD站点配置，格式：名称@URL,名称@URL，默认金蝉'https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top'",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top",
        },
        {
          title: "配置2",
          value: "金蝉@https://zy.jinchancaiji.com",
        },
        {
          title: "配置3",
          value: "金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou",
        },
        {
          title: "配置4",
          value: "金蝉@https://zy.jinchancaiji.com,听风@https://gctf.tfdh.top",
        },
      ],
    },
    {
      name: "vodReturnMode",
      title: "VOD返回模式：all（所有站点）或 fastest（最快的站点），默认fastest",
      type: "input",
      placeholders: [
        {
          title: "fastest",
          value: "fastest",
        },
        {
          title: "all",
          value: "all",
        },
      ],
    },
    {
      name: "vodRequestTimeout",
      title: "VOD请求超时时间，默认10000",
      type: "input",
      placeholders: [
        {
          title: "10s",
          value: "10000",
        },
        {
          title: "15s",
          value: "15000",
        },
        {
          title: "20s",
          value: "20000",
        },
      ],
    },
    {
      name: "bilibiliCookie",
      title: "B站Cookie（填入后能抓取b站完整弹幕）",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "SESSDATA=xxxx",
        },
      ],
    },

    // 匹配配置
    {
      name: "platformOrder",
      title: "平台优选配置，可选['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'migu', 'sohu', 'leshi, 'xigua', 'maiduidui', 'renren', 'hanjutv', 'bahamut', 'dandan', 'custom']",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "qq,qiyi,imgo,bilibili1,youku,migu,sohu,leshi,xigua,maiduidui,renren,hanjutv,bahamut,dandan,custom",
        },
        {
          title: "配置2",
          value: "bilibili1,qq,qiyi,imgo",
        },
        {
          title: "配置3",
          value: "dandan,bilibili1,bahamut",
        },
        {
          title: "配置4",
          value: "imgo,qiyi,qq,youku,bilibili1",
        },
      ],
    },
    {
      name: "animeTitleFilter",
      title: "剧名过滤规则，用于控制剧名过滤规则，需开启过滤开关ENABLE_ANIME_EPISODE_FILTER",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "广场舞|预告",
        },
      ],
    },
    {
      name: "episodeTitleFilter",
      title: "剧集标题过滤规则",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "(特别|惊喜|纳凉)?企划(?!(书|案|部))|合伙人手记|超前(营业|vlog)?|速览|vlog|(?<!(Chain|Chemical|Nuclear|连锁|化学|核|生化|生理|应激))reaction|(?<!(单))纯享|加更(版|篇)?|抢先(看|版|集|篇)?|(?<!(被|争|谁))抢[先鲜](?!(一步|手|攻|了|告|言|机|话))|抢鲜|预告(?!(函|信|书|犯))|(?<!(死亡|恐怖|灵异|怪谈))花絮(独家)?|(?<!(一|直))直拍|(制作|拍摄|幕后|花絮|未播|独家|演员|导演|主创|杀青|探班|收官|开播|先导|彩蛋|NG|回顾|高光|个人|主创)特辑|(?<!(行动|计划|游戏|任务|危机|神秘|黄金))彩蛋|(?<!(嫌疑人|证人|家属|律师|警方|凶手|死者))专访|(?<!(证人))采访(?!(吸血鬼|鬼))|(正式|角色|先导|概念|首曝|定档|剧情|动画|宣传|主题曲|印象)[\s\.]*[PpＰｐ][VvＶｖ]|(?<!(退居|回归|走向|转战|隐身|藏身))幕后(?!(主谋|主使|黑手|真凶|玩家|老板|金主|英雄|功臣|推手|大佬|操纵|交易|策划|博弈|BOSS|真相))(故事|花絮|独家)?|直播(陪看|回顾)?|直播(?!(.*(事件|杀人|自杀|谋杀|犯罪|现场|游戏|挑战)))|未播(片段)?|衍生(?!(品|物|兽))|番外(?!(地|人))|会员(专享|加长|尊享|专属|版)?|(?<!(鸦|雪|纸|相|照|图|名|大))片花|(?<!(提取|吸收|生命|魔法|修护|美白))精华|看点|速看|解读(?!.*(密文|密码|密电|电报|档案|书信|遗书|碑文|代码|信号|暗号|讯息|谜题|人心|唇语|真相|谜团|梦境))|(?<!(案情|人生|死前|历史|世纪))回顾|影评|解说|吐槽|(?<!(年终|季度|库存|资产|物资|财务|收获|战利))盘点|拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|番外彩蛋|精彩片段|精彩看点|精彩集锦|看点解析|看点预告|NG镜头|NG花絮|番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|(?<!(生命|生活|情感|爱情|一段|小|意外))插曲|高光回顾|背景音乐|OST|音乐MV|歌曲MV|前季回顾|剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|陪看(记)?|试看版|短剧|精编|(?<!(Love|Disney|One|C|Note|S\d+|\+|&|\s))Plus|独家版|(?<!(导演|加长|周年))特别版(?!(图|画))|短片|(?<!(新闻|紧急|临时|召开|破坏|大闹|澄清|道歉|新品|产品|事故))发布会|解忧局|走心局|火锅局|巅峰时刻|坞里都知道|福持目标坞民|福利(?!(院|会|主义|课))篇|(福利|加更|番外|彩蛋|衍生|特别|收官|游戏|整蛊|日常)篇|独家(?!(记忆|试爱|报道|秘方|占有|宠爱|恩宠))|.{2,}(?<!(市|分|警|总|省|卫|药|政|监|结|大|开|破|布|僵|困|骗|赌|胜|败|定|乱|危|迷|谜|入|搅|设|中|残|平|和|终|变|对|安|做|书|画|察|务|案|通|信|育|商|象|源|业|冰))局(?!(长|座|势|面|部|内|外|中|限|促|气))|(?<!(重症|隔离|实验|心理|审讯|单向|术后))观察室|上班那点事儿|周top|赛段|VLOG|(?<!(大案|要案|刑侦|侦查|破案|档案|风云|历史|战争|探案|自然|人文|科学|医学|地理|宇宙|赛事|世界杯|奥运))全纪录|开播|先导|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘(?!(者|人))",
        },
      ],
    },
    {
      name: "enableAnimeEpisodeFilter",
      title: "控制手动搜索的时候是否根据ANIME_TITLE_FILTER进行剧名过滤以及根据EPISODE_TITLE_FILTER进行集标题过滤，默认false",
      type: "input",
      placeholders: [
        {
          title: "false",
          value: "false",
        },
        {
          title: "true",
          value: "true",
        },
      ],
    },
    {
      name: "strictTitleMatch",
      title: "严格标题匹配模式，默认false",
      type: "input",
      placeholders: [
        {
          title: "false",
          value: "false",
        },
        {
          title: "true",
          value: "true",
        },
      ],
    },
    {
      name: "titleMappingTable",
      title: "剧名映射表，用于自动匹配时替换标题进行搜索，格式：原始标题->映射标题;原始标题->映射标题;... ，例如：\"唐朝诡事录->唐朝诡事录之西行;国色芳华->锦绣芳华\"",
      type: "input",
      placeholders: [
        {
          title: "映射表示例",
          value: "原始标题->映射标题;原始标题->映射标题",
        },
      ],
    },
    {
      name: "animeTitleSimplified",
      title: "搜索的剧名标题自动繁转简，默认false",
      type: "input",
      placeholders: [
        {
          title: "false",
          value: "false",
        },
        {
          title: "true",
          value: "true",
        },
      ],
    },

    // 弹幕配置
    {
      name: "blockedWords",
      title: "屏蔽词列表",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "/.{20,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\u4e00-\u9fa5])\\1{2,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{6,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{5,}$/,/^(\\d)\\1{2,}$/,/^\\d{1,4}$/,/(20[0-3][0-9])/,/(0?[1-9]|1[0-2])月/,/\\d{1,2}[.-]\\d{1,2}/,/[@#&$%^*+\\|/\\-_=<>°◆◇■□●○★☆▼▲♥♦♠♣①②③④⑤⑥⑦⑧⑨⑩]/,/[一二三四五六七八九十百\\d]+刷/,/第[一二三四五六七八九十百\\d]+/,/(全体成员|报到|报道|来啦|签到|刷|打卡|我在|来了|考古|爱了|挖坟|留念|你好|回来|哦哦|重温|复习|重刷|再看|在看|前排|沙发|有人看|板凳|末排|我老婆|我老公|撅了|后排|周目|重看|包养|DVD|同上|同样|我也是|俺也|算我|爱豆|我家爱豆|我家哥哥|加我|三连|币|新人|入坑|补剧|冲了|硬了|看完|舔屏|万人|牛逼|煞笔|傻逼|卧槽|tm|啊这|哇哦)/",
        },
      ],
    },
    {
      name: "groupMinute",
      title: "合并去重分钟数，表示按n分钟分组后对弹幕合并去重",
      type: "input",
      placeholders: [
        {
          title: "1分钟",
          value: "1",
        },
        {
          title: "2分钟",
          value: "2",
        },
        {
          title: "5分钟",
          value: "5",
        },
        {
          title: "10分钟",
          value: "10",
        },
        {
          title: "20分钟",
          value: "20",
        },
        {
          title: "30分钟",
          value: "30",
        },
      ],
    },
    {
      name: "danmuLimit",
      title: "弹幕数量限制，单位为k，即千：默认0，表示不限制弹幕数",
      type: "input",
      placeholders: [
        {
          title: "不限制",
          value: "0",
        },
        {
          title: "10k",
          value: "10",
        },
        {
          title: "8k",
          value: "8",
        },
        {
          title: "6k",
          value: "6",
        },
        {
          title: "4k",
          value: "4",
        },
        {
          title: "2k",
          value: "2",
        },
      ],
    },
    {
      name: "danmuSimplifiedTraditional",
      title: "弹幕简繁体转换设置：default（默认不转换）、simplified（繁转简）、traditional（简转繁）",
      type: "input",
      placeholders: [
        {
          title: "不转换",
          value: "default",
        },
        {
          title: "繁转简",
          value: "simplified",
        },
        {
          title: "简转繁",
          value: "traditional",
        },
      ],
    },
    {
      name: "convertTopBottomToScroll",
      title: "顶部/底部弹幕转换为浮动弹幕，默认false",
      type: "input",
      placeholders: [
        {
          title: "false",
          value: "false",
        },
        {
          title: "true",
          value: "true",
        },
      ],
    },
    {
      name: "convertColor",
      title: "弹幕转换颜色配置，默认default（不转换）",
      type: "input",
      placeholders: [
        {
          title: "不转换",
          value: "default",
        },
        {
          title: "白色",
          value: "white",
        },
        {
          title: "随机颜色(包括白色)",
          value: "color",
        },
      ],
    },
    {
      name: "likeSwitch",
      title: "点赞功能开关，默认true",
      type: "input",
      placeholders: [
        {
          title: "开启",
          value: "true",
        },
        {
          title: "关闭",
          value: "false",
        },
      ],
    },

    // 系统配置
    {
      name: "proxyUrl",
      title: "代理/反代地址，目前只对巴哈姆特和TMDB API生效",
      type: "input",
      placeholders: [
        {
          title: "如果添加了巴哈源且访问不了，请填写",
          value: "",
        },
        {
          title: "正常代理示例",
          value: "http://127.0.0.1:7890",
        },
        {
          title: "万能反代示例",
          value: "@http://127.0.0.1",
        },
        {
          title: "特定反代示例1",
          value: "bahamut@http://127.0.0.1",
        },
        {
          title: "特定反代示例2",
          value: "tmdb@http://127.0.0.1",
        },
      ],
    },
    {
      name: "tmdbApiKey",
      title: "TMDB API密钥，目前只对巴哈姆特生效，配置后并行从TMDB获取日语原名搜索巴哈",
      type: "input",
      placeholders: [
        {
          title: "如果添加了巴哈源，想自动获取日语原名搜索巴哈，请填写",
          value: "",
        },
        {
          title: "示例",
          value: "a1b2xxxxxxxxxxxxxxxxxxx",
        },
      ],
    }
  ],
  modules: [
    {
      id: "searchDanmu",
      title: "搜索弹幕",
      functionName: "searchDanmu",
      type: "danmu",
      params: [],
    },
    {
      id: "getDetail",
      title: "获取详情",
      functionName: "getDetailById",
      type: "danmu",
      params: [],
    },
    {
      id: "getComments",
      title: "获取弹幕",
      functionName: "getCommentsById",
      type: "danmu",
      params: [],
    },
    {
      id: "getDanmuWithSegmentTime",
      title: "获取指定时刻弹幕",
      functionName: "getDanmuWithSegmentTime",
      type: "danmu",
      params: [],
    }
  ],
};

// 在浏览器环境中设置全局变量（ForwardWidget系统使用）
if (typeof window !== 'undefined') {
  window.WidgetMetadata = WidgetMetadata;
}

// 初始化全局配置
let globals;
async function initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                     platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                     danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch) {
  // 将传入的参数设置到环境变量中，以便Globals可以访问它们
  const env = {};
  
  if (sourceOrder !== undefined) env.SOURCE_ORDER = sourceOrder;
  if (otherServer !== undefined) env.OTHER_SERVER = otherServer;
  if (customSourceApiUrl !== undefined) env.CUSTOM_SOURCE_API_URL = customSourceApiUrl;
  if (vodServers !== undefined) env.VOD_SERVERS = vodServers;
  if (vodReturnMode !== undefined) env.VOD_RETURN_MODE = vodReturnMode;
  if (vodRequestTimeout !== undefined) env.VOD_REQUEST_TIMEOUT = vodRequestTimeout;
  if (bilibiliCookie !== undefined) env.BILIBILI_COOKIE = bilibiliCookie;
  if (platformOrder !== undefined) env.PLATFORM_ORDER = platformOrder;
  if (episodeTitleFilter !== undefined) env.EPISODE_TITLE_FILTER = episodeTitleFilter;
  if (enableAnimeEpisodeFilter !== undefined) env.ENABLE_ANIME_EPISODE_FILTER = enableAnimeEpisodeFilter;
  if (strictTitleMatch !== undefined) env.STRICT_TITLE_MATCH = strictTitleMatch;
  if (titleMappingTable !== undefined) env.TITLE_MAPPING_TABLE = titleMappingTable;
  if (animeTitleFilter !== undefined) env.ANIME_TITLE_FILTER = animeTitleFilter;
  if (animeTitleSimplified !== undefined) env.ANIME_TITLE_SIMPLIFIED = animeTitleSimplified;
  if (blockedWords !== undefined) env.BLOCKED_WORDS = blockedWords;
  if (groupMinute !== undefined) env.GROUP_MINUTE = groupMinute;
  if (danmuLimit !== undefined) env.DANMU_LIMIT = danmuLimit;
  if (danmuSimplifiedTraditional !== undefined) env.DANMU_SIMPLIFIED_TRADITIONAL = danmuSimplifiedTraditional;
  if (convertTopBottomToScroll !== undefined) env.CONVERT_TOP_BOTTOM_TO_SCROLL = convertTopBottomToScroll;
  if (convertColor !== undefined) env.CONVERT_COLOR = convertColor;
  if (likeSwitch !== undefined) env.LIKE_SWITCH = likeSwitch;
  if (proxyUrl !== undefined) env.PROXY_URL = proxyUrl;
  if (tmdbApiKey !== undefined) env.TMDB_API_KEY = tmdbApiKey;
  
  if (!globals) {
    globals = Globals.init(env);
  }

  await getCaches();

  return globals;
}

// 获取变量数据
async function getCaches() {
    if (globals.animes.length === 0) {
        log("info", 'getCaches start.');
        const [kv_animes, kv_episodeIds, kv_episodeNum, kv_logBuffer, kv_lastSelectMap] = await Promise.all([
          Widget.storage.get('animes'),
          Widget.storage.get('episodeIds'),
          Widget.storage.get('episodeNum'),
          Widget.storage.get('logBuffer'),
          Widget.storage.get('lastSelectMap'),
        ]);

        globals.animes = kv_animes ? (typeof kv_animes === 'string' ? JSON.parse(kv_animes) : kv_animes) : globals.animes;
        globals.episodeIds = kv_episodeIds ? (typeof kv_episodeIds === 'string' ? JSON.parse(kv_episodeIds) : kv_episodeIds) : globals.episodeIds;
        globals.episodeNum = kv_episodeNum ? (typeof kv_episodeNum === 'string' ? JSON.parse(kv_episodeNum) : kv_episodeNum) : globals.episodeNum;
        globals.logBuffer = kv_logBuffer ? (typeof kv_logBuffer === 'string' ? JSON.parse(kv_logBuffer) : kv_logBuffer) : globals.logBuffer;
        
        // 特殊处理 Map
        if (kv_lastSelectMap) {
          const parsed = typeof kv_lastSelectMap === 'string' ? JSON.parse(kv_lastSelectMap) : kv_lastSelectMap;
          globals.lastSelectMap = new Map(
            Array.isArray(parsed) ? parsed : Object.entries(parsed)
          );
        }
    }
}

// 存储更新后的变量
async function updateCaches() {
    log("info", 'updateCaches start.');
    await Promise.all([
      Widget.storage.set('animes', globals.animes),
      Widget.storage.set('episodeIds', globals.episodeIds),
      Widget.storage.set('episodeNum', globals.episodeNum),
      Widget.storage.set('logBuffer', globals.logBuffer),
      Widget.storage.set('lastSelectMap', JSON.stringify(Object.fromEntries(globals.lastSelectMap)))
    ]);
}

// 删除存储的变量
async function removeCaches() {
    log("info", 'removeCaches start.');
    await Promise.all([
      Widget.storage.remove('animes'),
      Widget.storage.remove('episodeIds'),
      Widget.storage.remove('episodeNum'),
      Widget.storage.remove('logBuffer'),
      Widget.storage.remove('lastSelectMap')
    ]);
}

const PREFIX_URL = "http://localhost:9321"

async function searchDanmu(params) {
  const { tmdbId, type, title, season, link, videoUrl, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch);

  let simplifiedTitle = title
  // 如果启用了搜索关键字繁转简，则进行转换
  if (globals.animeTitleSimplified) {
    simplifiedTitle = simplized(title);
    log("info", `searchAnime converted traditional to simplified: ${title} -> ${simplifiedTitle}`);
  }

  const response = await searchAnime(new URL(`${PREFIX_URL}/api/v2/search/anime?keyword=${simplifiedTitle}`));
  const resJson = await response.json();
  const curAnimes = resJson.animes;

  // 开始排序数据，将匹配到季的数据挪到前面
  let animes = [];
  if (curAnimes && curAnimes.length > 0) {
    animes = curAnimes;
    if (season) {
      // order by season
      const matchedAnimes = [];
      const nonMatchedAnimes = [];

      animes.forEach((anime) => {
        if (matchSeason(anime, simplifiedTitle, season) && !(anime.animeTitle.includes("电影") || anime.animeTitle.includes("movie"))) {
            matchedAnimes.push(anime);
        } else {
            nonMatchedAnimes.push(anime);
        }
      });

      // Sort matched animes by title length (before first parenthesis)
      matchedAnimes.sort((a, b) => {
        const aLength = a.animeTitle.split('(')[0].length;
        const bLength = b.animeTitle.split('(')[0].length;
        return aLength - bLength;
      });

      // Combine matched and non-matched animes, with matched ones at the front
      animes = [...matchedAnimes, ...nonMatchedAnimes];
    } else {
      // order by type
      const matchedAnimes = [];
      const nonMatchedAnimes = [];

      animes.forEach((anime) => {
        if (anime.animeTitle.includes("电影") || anime.animeTitle.includes("movie")) {
            matchedAnimes.push(anime);
        } else {
            nonMatchedAnimes.push(anime);
        }
      });

      // Sort matched animes by title length (before first parenthesis)
      matchedAnimes.sort((a, b) => {
        const aLength = a.animeTitle.split('(')[0].length;
        const bLength = b.animeTitle.split('(')[0].length;
        return aLength - bLength;
      });

      // Combine matched and non-matched animes, with matched ones at the front
      animes = [...matchedAnimes, ...nonMatchedAnimes];
    }
  }

  log("info", "animes: ", animes);

  await updateCaches();

  return {
    animes: animes,
  };
}

async function getDetailById(params) {
  const { animeId, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch);

  const response = await getBangumi(`${PREFIX_URL}/api/v2/bangumi/${animeId}`);
  const resJson = await response.json();

  log("info", "bangumi", resJson);

  await updateCaches();

  return resJson.bangumi.episodes;
}

async function getCommentsById(params) {
  const { commentId, link, videoUrl, season, episode, tmdbId, type, title, segmentTime, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch);

  if (commentId) {
    const storeKey = season && episode ? `${tmdbId}.${season}.${episode}` : `${tmdbId}`;
    const commentIdKey = `${storeKey}.${commentId}`;
    const segmentList = Widget.storage.get(storeKey);
    const lastCommentId = Widget.storage.get(commentIdKey);
    
    log("info", "storeKey:", storeKey);
    log("info", "commentIdKey:", commentIdKey);
    log("info", "commentId:", commentId);
    log("info", "lastCommentId:", lastCommentId);
    log("info", "segmentList:", segmentList);

    if (lastCommentId === commentId && segmentList) {
        return await getDanmuWithSegmentTime({ segmentTime, tmdbId, season, episode, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                                               platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                                               danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch })
    } else {
      Widget.storage.remove(storeKey);
      Widget.storage.remove(commentIdKey);
    }

    const response = await getComment(`${PREFIX_URL}/api/v2/comment/${commentId}`, "json", true);
    const resJson = await response.json();

    log("info", "segmentList:", resJson.comments.segmentList);

    Widget.storage.set(storeKey, resJson.comments.segmentList);
    Widget.storage.set(commentIdKey, commentId);

    console.log("segmentList", resJson.comments.segmentList);

    await updateCaches();

    return resJson.comments.segmentList;
  }
  return null;
}

async function getDanmuWithSegmentTime(params) {
  const { segmentTime, tmdbId, season, episode, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, 
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, convertTopBottomToScroll, convertColor, proxyUrl, tmdbApiKey, likeSwitch);

  const storeKey = season && episode ? `${tmdbId}.${season}.${episode}` : `${tmdbId}`;
  const segmentList = Widget.storage.get(storeKey);
  if (segmentList) {
    const segment = segmentList.find((item) => {
        const start = Number(item.segment_start);
        const end = Number(item.segment_end);
        const time = Number(segmentTime);
        return time >= start && time < end;
    });
    log("info", "segment:", segment);
    const response = await getSegmentComment(segment);
    const resJson = await response.json();

    await updateCaches();

    return resJson;
  }
  return null;
}

// 导出函数以供ForwardWidgets调用
export { searchDanmu, getDetailById, getCommentsById, getDanmuWithSegmentTime };
