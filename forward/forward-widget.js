import { searchAnime, getBangumi, getComment, getSegmentComment, matchSeason } from '../danmu_api/apis/dandan-api.js';
import { Globals } from '../danmu_api/configs/globals.js';
import { log } from '../danmu_api/utils/log-util.js';
import { simplized } from '../danmu_api/utils/zh-util.js';

const wv = typeof widgetVersion !== 'undefined' ? widgetVersion : Globals.VERSION;
WidgetMetadata = {
  id: globalThis.__FORWARD_WIDGET_DEBUG__ === true ? "forward.auto.danmu2.debug" : "forward.auto.danmu2",
  title: globalThis.__FORWARD_WIDGET_DEBUG__ === true ? "自动链接弹幕v2 [DEBUG]" : "自动链接弹幕v2",
  version: wv,
  requiredVersion: "0.0.2",
  description: "自动获取播放链接并从服务器获取弹幕【五折码：CHEAP.5;七折码：CHEAP】",
  author: "huangxd",
  site: "https://github.com/huangxd-/ForwardWidgets",
  globalParams: [
    ...(globalThis.__FORWARD_WIDGET_DEBUG__ === true ? [{
      name: "debugEndpoint",
      title: "调试回传地址，例如 http://192.168.1.10:9321/87654321",
      type: "input",
      placeholders: [{
        title: "局域网 danmu_api 地址",
        value: "http://192.168.1.10:9321/87654321",
      }],
    }] : []),
    // 源配置
    {
      name: "sourceOrder",
      title: "源排序配置，默认'douban,360,renren,hanjutv'，可选['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'migu', 'sohu', 'leshi', 'xigua', 'maiduidui', 'aiyifan', 'hongguo', 'renren', 'hanjutv', 'bahamut', 'dandan', 'custom']",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "tencent,iqiyi,imgo,bilibili,youku,renren,hanjutv",
        },
        {
          title: "配置2（推荐）",
          value: "douban,360,renren,hanjutv",
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
    {
      name: "doubanCookie",
      title: "豆瓣Cookie（填入后可提升豆瓣搜索和详情请求稳定性）",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "",
        },
      ],
    },

    // 匹配配置
    {
      name: "platformOrder",
      title: "平台优选配置，可选['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'migu', 'sohu', 'leshi, 'xigua', 'maiduidui', 'aiyifan', 'hongguo', 'renren', 'hanjutv', 'bahamut', 'dandan', 'custom']",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "qq,qiyi,imgo,bilibili1,youku,migu,sohu,leshi,xigua,maiduidui,aiyifan,renren,hanjutv,bahamut,dandan,custom",
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
      name: "danmuOffset",
      title: "弹幕时间偏移配置，格式：剧名:秒 或 剧名/季:秒 或 剧名/季/集:秒，正数表示弹幕延后（向右），负数表示弹幕提前（向左），多条用逗号分隔，示例：overlord/S01:90,re-zero/S02:120,re-zero/S02/E03:10；支持百分比模式，在路径/来源末尾添加 `%`，例如：`东方/S03/E02@tencent%:11`，按 `原时间 * (视频时长 + 偏移秒数) / 视频时长` 计算新的弹幕发送时间",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "",
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
      name: "colorPool",
      title: "自定义颜色池（CONVERT_COLOR为color时生效），不配置使用默认颜色池，格式：十进制颜色值逗号分隔",
      type: "input",
      placeholders: [
        {
          title: "默认颜色池",
          value: "",
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
    {
      name: "hongguoMergeAllEpisodes",
      title: "红果短剧合并全集弹幕，默认关闭",
      type: "enumeration",
      value: "false",
      enumOptions: [
        {
          title: "关闭",
          value: "false",
        },
        {
          title: "开启",
          value: "true",
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
let forwardCachesLoaded = false;
const FORWARD_CACHE_SCHEMA_VERSION = 2;
const FORWARD_CACHE_SCHEMA_KEY = 'forward.cache.schema';
const FORWARD_SEGMENT_CACHE_PREFIX = `forward.segment.v${FORWARD_CACHE_SCHEMA_VERSION}`;
const FORWARD_SEGMENT_CACHE_TTL_MS = 300 * 60 * 1000;
const FORWARD_SEGMENT_EMPTY_RETRY_MIN_AGE_MS = 60 * 1000;
const FORWARD_PERSISTED_LOG_LIMIT = 200;
const forwardSegmentMemoryCache = new Map();
const FORWARD_TRACE_MAX_LOGS = 80;
const FORWARD_TRACE_MAX_ARRAY = 5;
const FORWARD_TRACE_MAX_STRING = 500;
const FORWARD_TRACE_BATCH_SIZE = 20;
let forwardDebugContext = null;

function redactForwardTraceValue(value, key = '', depth = 0, seen = []) {
  if (/(cookie|token|api.?key|authorization|password|secret|debugEndpoint)/i.test(key)) {
    return value ? '[REDACTED]' : value;
  }
  if (typeof value === 'string') {
    return value.length > FORWARD_TRACE_MAX_STRING
      ? `${value.slice(0, FORWARD_TRACE_MAX_STRING)}...[truncated]`
      : value;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth >= 4) return '[max-depth]';
  if (seen.includes(value)) return '[circular]';

  const nextSeen = [...seen, value];
  if (Array.isArray(value)) {
    const items = value.slice(0, FORWARD_TRACE_MAX_ARRAY)
      .map((item) => redactForwardTraceValue(item, key, depth + 1, nextSeen));
    if (value.length > FORWARD_TRACE_MAX_ARRAY) {
      items.push(`[${value.length - FORWARD_TRACE_MAX_ARRAY} more items]`);
    }
    return items;
  }

  const output = {};
  Object.keys(value).slice(0, 50).forEach((childKey) => {
    output[childKey] = redactForwardTraceValue(value[childKey], childKey, depth + 1, nextSeen);
  });
  return output;
}

function summarizeForwardResult(handlerName, result) {
  if (handlerName === 'searchDanmu') {
    const animes = Array.isArray(result?.animes) ? result.animes : [];
    return { animeCount: animes.length, animes: redactForwardTraceValue(animes.slice(0, 5)) };
  }
  if (handlerName === 'getDetailById') {
    const episodes = Array.isArray(result) ? result : [];
    return { episodeCount: episodes.length, episodes: redactForwardTraceValue(episodes.slice(0, 5)) };
  }
  if (handlerName === 'getCommentsById') {
    const segments = Array.isArray(result) ? result : [];
    return {
      segmentCount: segments.length,
      firstSegment: redactForwardTraceValue(segments[0] || null),
      lastSegment: redactForwardTraceValue(segments[segments.length - 1] || null),
    };
  }
  if (handlerName === 'getDanmuWithSegmentTime') {
    const comments = Array.isArray(result?.comments) ? result.comments : [];
    return {
      success: result?.success,
      errorCode: result?.errorCode,
      errorMessage: result?.errorMessage,
      count: Number.isFinite(Number(result?.count)) ? Number(result.count) : comments.length,
      comments: redactForwardTraceValue(comments.slice(0, 3)),
    };
  }
  return redactForwardTraceValue(result);
}

function buildForwardTraceUrl(debugEndpoint) {
  const endpoint = String(debugEndpoint || '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  return endpoint.endsWith('/api/debug/forward-trace')
    ? endpoint
    : `${endpoint}/api/debug/forward-trace`;
}

function redactForwardRequestUrl(url) {
  return String(url || '').replace(
    /([?&](?:token|access_token|api_?key|key|signature|x-signature|authorization)=)[^&]*/gi,
    '$1[REDACTED]'
  );
}

function enqueueForwardRuntimeLog(level, message, details = {}) {
  if (!forwardDebugContext) return;
  forwardDebugContext.runtimeLogs.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redactForwardTraceValue(details),
  });
  flushForwardRuntimeLogs().catch(() => {});
}

function installForwardConsoleTrace() {
  ['log', 'info', 'warn', 'error'].forEach((method) => {
    const original = console[method];
    if (typeof original !== 'function' || original.__forwardTraceWrapped) return;
    const wrapped = (...args) => {
      const message = args.map((arg) => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(redactForwardTraceValue(arg)); } catch (_) { return String(arg); }
      }).join(' ');
      enqueueForwardRuntimeLog(method === 'log' ? 'info' : method, message, { kind: 'console' });
      return original.apply(console, args);
    };
    wrapped.__forwardTraceWrapped = true;
    console[method] = wrapped;
  });
}

function collectPendingForwardLogs(context) {
  const logs = [];
  const centralLogKeys = new Set();
  if (globals && Array.isArray(globals.logBuffer)) {
    globals.logBuffer.forEach((entry) => {
      if (context.seenLogs.includes(entry)) return;
      const timestamp = Date.parse(entry?.timestamp || '');
      if (!Number.isFinite(timestamp) || timestamp < context.startedAt - 1000) return;
      context.seenLogs.push(entry);
      const redacted = redactForwardTraceValue(entry);
      centralLogKeys.add(`${redacted.level}|${redacted.message}`);
      logs.push(redacted);
    });
  }
  context.runtimeLogs.splice(0).forEach((entry) => {
    const redacted = redactForwardTraceValue(entry);
    if (redacted.kind === 'console' && centralLogKeys.has(`${redacted.level}|${redacted.message}`)) return;
    logs.push(redacted);
  });
  return logs.slice(-FORWARD_TRACE_MAX_LOGS);
}

async function flushForwardRuntimeLogs() {
  const context = forwardDebugContext;
  if (!context || !context.debugEndpoint) return;
  if (context.flushing) {
    context.flushAgain = true;
    return context.flushPromise;
  }
  context.flushing = true;
  context.flushPromise = (async () => {
    try {
      do {
        context.flushAgain = false;
        const logs = collectPendingForwardLogs(context);
        for (let index = 0; index < logs.length; index += FORWARD_TRACE_BATCH_SIZE) {
          const batch = logs.slice(index, index + FORWARD_TRACE_BATCH_SIZE);
          await sendForwardTrace(context.debugEndpoint, {
            eventType: 'logBatch',
            widgetId: WidgetMetadata.id,
            widgetVersion: WidgetMetadata.version,
            handler: context.handler,
            status: batch.some((entry) => entry.level === 'error') ? 'error' : 'info',
            timestamp: new Date().toISOString(),
            logs: batch,
          });
        }
      } while (context.flushAgain);
    } finally {
      context.flushing = false;
    }
  })();
  return context.flushPromise;
}

async function startForwardRealtimeTrace(handlerName, params, startedAt) {
  forwardDebugContext = {
    handler: handlerName,
    debugEndpoint: params?.debugEndpoint,
    startedAt,
    seenLogs: [],
    runtimeLogs: [],
    flushing: false,
    flushAgain: false,
    flushPromise: null,
  };
  await sendForwardTrace(params?.debugEndpoint, {
    eventType: 'handlerStart',
    widgetId: WidgetMetadata.id,
    widgetVersion: WidgetMetadata.version,
    handler: handlerName,
    status: 'running',
    timestamp: new Date(startedAt).toISOString(),
    params: redactForwardTraceValue(params || {}),
  });
}

async function stopForwardRealtimeTrace() {
  const context = forwardDebugContext;
  if (!context) return;
  await flushForwardRuntimeLogs();
  if (forwardDebugContext === context) forwardDebugContext = null;
}

async function forwardDebugHttpRequest(method, url, body, options = {}) {
  const startedAt = Date.now();
  const safeUrl = redactForwardRequestUrl(url);
  enqueueForwardRuntimeLog('info', `[HTTP] ${method} ${safeUrl}`, { kind: 'httpStart', method, url: safeUrl });
  try {
    const response = method === 'GET'
      ? await Widget.http.get(url, options)
      : await Widget.http.post(url, body, options);
    enqueueForwardRuntimeLog(
      'info',
      `[HTTP] ${method} ${response?.status || 200} ${Date.now() - startedAt}ms ${safeUrl}`,
      { kind: 'httpComplete', method, url: safeUrl, status: response?.status || 200, durationMs: Date.now() - startedAt }
    );
    return response;
  } catch (error) {
    enqueueForwardRuntimeLog(
      'error',
      `[HTTP] ${method} ERROR ${Date.now() - startedAt}ms ${safeUrl}: ${error?.message || error}`,
      { kind: 'httpError', method, url: safeUrl, durationMs: Date.now() - startedAt, error: error?.message || String(error) }
    );
    throw error;
  }
}

async function forwardDebugHttpGet(url, options = {}) {
  return forwardDebugHttpRequest('GET', url, undefined, options);
}

async function forwardDebugHttpPost(url, body, options = {}) {
  return forwardDebugHttpRequest('POST', url, body, options);
}

if (globalThis.__FORWARD_WIDGET_DEBUG__ === true) {
  installForwardConsoleTrace();
  globalThis.__forwardDebugHttpGet = forwardDebugHttpGet;
  globalThis.__forwardDebugHttpPost = forwardDebugHttpPost;
}

async function sendForwardTrace(debugEndpoint, payload) {
  const traceUrl = buildForwardTraceUrl(debugEndpoint);
  if (!traceUrl) return;
  try {
    await Widget.http.post(traceUrl, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
    });
  } catch (error) {
    console.warn('[ForwardDebug] trace upload failed:', error?.message || error);
  }
}

async function runWithForwardTrace(handlerName, params, operation) {
  if (globalThis.__FORWARD_WIDGET_DEBUG__ !== true) return operation();

  const startedAt = Date.now();
  await startForwardRealtimeTrace(handlerName, params, startedAt);
  try {
    const result = await operation();
    await stopForwardRealtimeTrace();
    await sendForwardTrace(params?.debugEndpoint, {
      eventType: 'handlerComplete',
      widgetId: WidgetMetadata.id,
      widgetVersion: WidgetMetadata.version,
      handler: handlerName,
      status: 'success',
      timestamp: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      params: redactForwardTraceValue(params || {}),
      result: summarizeForwardResult(handlerName, result),
    });
    return result;
  } catch (error) {
    await stopForwardRealtimeTrace();
    await sendForwardTrace(params?.debugEndpoint, {
      eventType: 'handlerComplete',
      widgetId: WidgetMetadata.id,
      widgetVersion: WidgetMetadata.version,
      handler: handlerName,
      status: 'error',
      timestamp: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      params: redactForwardTraceValue(params || {}),
      error: redactForwardTraceValue({
        name: error?.name,
        message: error?.message || String(error),
        stack: error?.stack,
      }),
    });
    throw error;
  }
}

async function initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
                     platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                     danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes) {
  // 将传入的参数设置到环境变量中，以便Globals可以访问它们
  const env = {};
  if (globalThis.__FORWARD_WIDGET_DEBUG__ === true) env.LOG_LEVEL = 'info';
  
  if (sourceOrder !== undefined) env.SOURCE_ORDER = sourceOrder;
  if (otherServer !== undefined) env.OTHER_SERVER = otherServer;
  if (customSourceApiUrl !== undefined) env.CUSTOM_SOURCE_API_URL = customSourceApiUrl;
  if (vodServers !== undefined) env.VOD_SERVERS = vodServers;
  if (vodReturnMode !== undefined) env.VOD_RETURN_MODE = vodReturnMode;
  if (vodRequestTimeout !== undefined) env.VOD_REQUEST_TIMEOUT = vodRequestTimeout;
  if (bilibiliCookie !== undefined) env.BILIBILI_COOKIE = bilibiliCookie;
  if (doubanCookie !== undefined) env.DOUBAN_COOKIE = doubanCookie;
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
  if (danmuOffset !== undefined) env.DANMU_OFFSET = danmuOffset;
  if (convertTopBottomToScroll !== undefined) env.CONVERT_TOP_BOTTOM_TO_SCROLL = convertTopBottomToScroll;
  if (convertColor !== undefined) env.CONVERT_COLOR = convertColor;
  if (colorPool !== undefined) env.COLOR_POOL = colorPool;
  if (likeSwitch !== undefined) env.LIKE_SWITCH = likeSwitch;
  if (hongguoMergeAllEpisodes !== undefined) env.HONGGUO_MERGE_ALL_EPISODES = hongguoMergeAllEpisodes;
  if (proxyUrl !== undefined) env.PROXY_URL = proxyUrl;
  if (tmdbApiKey !== undefined) env.TMDB_API_KEY = tmdbApiKey;
  
  globals = Globals.init(env);

  await getCaches();

  return globals;
}

// 获取变量数据
async function getCaches() {
    if (forwardCachesLoaded) {
      return;
    }
    forwardCachesLoaded = true;

    log("info", '[Forward] getCaches start.');
    const storedSchemaVersion = await Widget.storage.get(FORWARD_CACHE_SCHEMA_KEY);
    if (Number(storedSchemaVersion) !== FORWARD_CACHE_SCHEMA_VERSION) {
      log("info", `[Forward] Cache schema changed to v${FORWARD_CACHE_SCHEMA_VERSION}; ignoring legacy cache.`);
      forwardSegmentMemoryCache.clear();
      if (typeof Widget.storage.clear === 'function') {
        await Widget.storage.clear();
      } else {
        await removeCaches();
      }
      await Widget.storage.set(FORWARD_CACHE_SCHEMA_KEY, FORWARD_CACHE_SCHEMA_VERSION);
      return;
    }

    const [kv_animes, kv_episodeIds, kv_episodeNum, kv_logBuffer, kv_lastSelectMap] = await Promise.all([
      Widget.storage.get('animes'),
      Widget.storage.get('episodeIds'),
      Widget.storage.get('episodeNum'),
      Widget.storage.get('logBuffer'),
      Widget.storage.get('lastSelectMap'),
    ]);

    globals.animes = parseForwardCacheValue(kv_animes, globals.animes, Array.isArray);
    globals.episodeIds = parseForwardCacheValue(kv_episodeIds, globals.episodeIds, Array.isArray);
    globals.episodeNum = parseForwardCacheValue(
      kv_episodeNum,
      globals.episodeNum,
      (value) => Number.isFinite(Number(value))
    );
    globals.logBuffer = parseForwardCacheValue(kv_logBuffer, globals.logBuffer, Array.isArray);

    const parsedLastSelectMap = parseForwardCacheValue(
      kv_lastSelectMap,
      null,
      (value) => Array.isArray(value) || (value && typeof value === 'object')
    );
    if (parsedLastSelectMap) {
      globals.lastSelectMap = new Map(
        Array.isArray(parsedLastSelectMap) ? parsedLastSelectMap : Object.entries(parsedLastSelectMap)
      );
    }
}

function parseForwardCacheValue(value, fallback, validator) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return validator(parsed) ? parsed : fallback;
  } catch (error) {
    log("warn", `[Forward] Ignoring invalid persisted cache: ${error.message}`);
    return fallback;
  }
}

// 存储更新后的变量
async function updateCaches() {
    log("info", '[Forward] updateCaches start.');
    const persistedLogs = Array.isArray(globals.logBuffer)
      ? globals.logBuffer.slice(-FORWARD_PERSISTED_LOG_LIMIT)
      : [];
    try {
      await Promise.all([
        Widget.storage.set(FORWARD_CACHE_SCHEMA_KEY, FORWARD_CACHE_SCHEMA_VERSION),
        Widget.storage.set('animes', globals.animes),
        Widget.storage.set('episodeIds', globals.episodeIds),
        Widget.storage.set('episodeNum', globals.episodeNum),
        Widget.storage.set('logBuffer', persistedLogs),
        Widget.storage.set('lastSelectMap', JSON.stringify(Object.fromEntries(globals.lastSelectMap)))
      ]);
    } catch (error) {
      log("warn", `[Forward] Failed to persist optional global cache: ${error.message}`);
    }
}

// 删除存储的变量
async function removeCaches() {
    log("info", '[Forward] removeCaches start.');
    await Promise.all([
      Widget.storage.remove(FORWARD_CACHE_SCHEMA_KEY),
      Widget.storage.remove('animes'),
      Widget.storage.remove('episodeIds'),
      Widget.storage.remove('episodeNum'),
      Widget.storage.remove('logBuffer'),
      Widget.storage.remove('lastSelectMap')
    ]);
}

const PREFIX_URL = "http://localhost:9321"

async function searchDanmuCore(params) {
  const { tmdbId, type, title, season, link, videoUrl, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes);

  let simplifiedTitle = title
  // 如果启用了搜索关键字繁转简，则进行转换
  if (globals.animeTitleSimplified) {
    simplifiedTitle = simplized(title);
    log("info", `[Forward] searchAnime converted traditional to simplified: ${title} -> ${simplifiedTitle}`);
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

  log("info", "[Forward] animes: ", animes);

  await updateCaches();

  return {
    animes: animes,
  };
}

async function getDetailByIdCore(params) {
  const { animeId, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes);

  const response = await getBangumi(`${PREFIX_URL}/api/v2/bangumi/${animeId}`);
  const resJson = await response.json();

  log("info", "[Forward] bangumi", resJson);

  return resJson.bangumi.episodes;
}

function hashForwardCacheIdentity(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeForwardCacheKeyPart(value, fallback = 'none') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return String(value).trim() || fallback;
}

function getSegmentCacheKey(params) {
  const normalizedTmdbId = normalizeForwardCacheKeyPart(params.tmdbId, '');
  const tmdbId = ['undefined', 'null', 'none'].includes(normalizedTmdbId.toLowerCase())
    ? ''
    : normalizedTmdbId;
  const mediaIdentity = tmdbId
    ? `tmdb:${normalizeForwardCacheKeyPart(params.type)}:${tmdbId}`
    : `media:${normalizeForwardCacheKeyPart(params.type)}:${normalizeForwardCacheKeyPart(
        params.seriesName || params.title || params.link || params.videoUrl,
        'unknown'
      )}`;
  const season = normalizeForwardCacheKeyPart(params.season);
  const episode = normalizeForwardCacheKeyPart(params.episode);
  return `${FORWARD_SEGMENT_CACHE_PREFIX}.${hashForwardCacheIdentity(mediaIdentity)}.${season}.${episode}`;
}

function getLegacySegmentCacheKey(params) {
  return params.season && params.episode
    ? `${params.tmdbId}.${params.season}.${params.episode}`
    : `${params.tmdbId}`;
}

function isValidSegment(segment) {
  if (!segment || typeof segment !== 'object' || typeof segment.url !== 'string' || !segment.url.trim()) {
    return false;
  }
  const start = Number(segment.segment_start);
  const end = Number(segment.segment_end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function parseSegmentCacheRecord(value) {
  const record = parseForwardCacheValue(
    value,
    null,
    (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
  );
  if (!record
      || record.version !== FORWARD_CACHE_SCHEMA_VERSION
      || record.commentId === null
      || record.commentId === undefined
      || !Number.isFinite(Number(record.cachedAt))
      || !Array.isArray(record.segmentList)
      || record.segmentList.length === 0
      || !record.segmentList.every(isValidSegment)) {
    return null;
  }
  return record;
}

function isSegmentCacheFresh(record) {
  const age = Date.now() - Number(record.cachedAt);
  return age >= 0 && age <= FORWARD_SEGMENT_CACHE_TTL_MS;
}

async function readSegmentCache(params) {
  const key = getSegmentCacheKey(params);
  let storedValue = null;
  try {
    storedValue = await Widget.storage.get(key);
  } catch (error) {
    log("warn", `[Forward] Failed to read segment cache: ${error.message}`);
  }
  storedValue ||= forwardSegmentMemoryCache.get(key);
  const record = parseSegmentCacheRecord(storedValue);
  if (storedValue && !record) {
    forwardSegmentMemoryCache.delete(key);
    try {
      await Widget.storage.remove(key);
    } catch (error) {
      log("warn", `[Forward] Failed to remove invalid segment cache: ${error.message}`);
    }
  }
  return { key, record, fresh: record ? isSegmentCacheFresh(record) : false };
}

async function removeSegmentCache(params, commentId = null) {
  const key = getSegmentCacheKey(params);
  const legacyKey = getLegacySegmentCacheKey(params);
  forwardSegmentMemoryCache.delete(key);
  const removals = [
    Widget.storage.remove(key),
    Widget.storage.remove(legacyKey),
  ];
  if (commentId !== null && commentId !== undefined) {
    removals.push(Widget.storage.remove(`${legacyKey}.${commentId}`));
  }
  const results = await Promise.allSettled(removals);
  if (results.some((result) => result.status === 'rejected')) {
    log("warn", '[Forward] Some stale segment cache entries could not be removed.');
  }
}

async function fetchAndCacheSegmentList(commentId, params) {
  const response = await getComment(`${PREFIX_URL}/api/v2/comment/${commentId}`, "json", true);
  const resJson = await response.json();
  if (resJson?.success === false || (resJson?.errorCode && Number(resJson.errorCode) !== 0)) {
    throw new Error(resJson?.errorMessage || `Failed to fetch segment list for comment ${commentId}`);
  }

  const rawSegmentList = resJson?.comments?.segmentList;
  const segmentList = Array.isArray(rawSegmentList) ? rawSegmentList.filter(isValidSegment) : [];
  if (segmentList.length !== (Array.isArray(rawSegmentList) ? rawSegmentList.length : 0)) {
    log("warn", `[Forward] Ignored invalid segments for comment ${commentId}.`);
  }

  const key = getSegmentCacheKey(params);
  if (segmentList.length === 0) {
    forwardSegmentMemoryCache.delete(key);
    try {
      await Widget.storage.remove(key);
    } catch (error) {
      log("warn", `[Forward] Failed to remove empty segment cache: ${error.message}`);
    }
    return { record: null, segmentList: [] };
  }

  const record = {
    version: FORWARD_CACHE_SCHEMA_VERSION,
    commentId: String(commentId),
    cachedAt: Date.now(),
    segmentList,
  };
  forwardSegmentMemoryCache.set(key, record);
  try {
    await Widget.storage.set(key, record);
  } catch (error) {
    log("warn", `[Forward] Failed to persist segment cache; using memory cache: ${error.message}`);
  }
  return { record, segmentList };
}

function findSegmentAtTime(segmentList, segmentTime) {
  const time = Number(segmentTime);
  if (!Number.isFinite(time)) {
    return null;
  }
  return segmentList.find((item) => time >= Number(item.segment_start) && time < Number(item.segment_end)) || null;
}

function buildMissingSegmentResponse(segmentList, segmentTime) {
  const starts = segmentList.map((item) => Number(item.segment_start)).filter(Number.isFinite);
  const ends = segmentList.map((item) => Number(item.segment_end)).filter(Number.isFinite);
  const rangeStart = starts.length ? Math.min(...starts) : null;
  const rangeEnd = ends.length ? Math.max(...ends) : null;
  const errorMessage = `No segment covers ${segmentTime}s; available range: ${rangeStart}-${rangeEnd}s`;
  log("warn", `[Forward] ${errorMessage}`);
  return { errorCode: 404, success: false, errorMessage, count: 0, comments: [] };
}

function shouldRefreshSegmentResponse(resJson, record) {
  if (!resJson || resJson.success === false || Number(resJson.errorCode || 0) !== 0) {
    return true;
  }
  if (!Array.isArray(resJson.comments)) {
    return true;
  }
  const cacheAge = Date.now() - Number(record.cachedAt);
  return resJson.comments.length === 0 && cacheAge >= FORWARD_SEGMENT_EMPTY_RETRY_MIN_AGE_MS;
}

async function getCommentsByIdCore(params) {
  const { commentId, link, videoUrl, season, episode, tmdbId, type, title, segmentTime, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes);

  if (!commentId) return null;

  const cached = await readSegmentCache(params);
  if (cached.fresh && String(cached.record.commentId) === String(commentId)) {
    log("info", "[Forward] Using fresh segment cache:", cached.key);
    return cached.record.segmentList;
  }

  await removeSegmentCache(params, commentId);
  const { segmentList } = await fetchAndCacheSegmentList(commentId, params);
  log("info", "[Forward] segmentList:", segmentList);
  await updateCaches();
  return segmentList;
}

async function getDanmuWithSegmentTimeCore(params) {
  const { segmentTime, tmdbId, season, episode, sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
         platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
         danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes } = params;

  await initGlobals(sourceOrder, otherServer, customSourceApiUrl, vodServers, vodReturnMode, vodRequestTimeout, bilibiliCookie, doubanCookie,
                    platformOrder, episodeTitleFilter, enableAnimeEpisodeFilter, strictTitleMatch, titleMappingTable, animeTitleFilter, animeTitleSimplified, blockedWords, groupMinute, 
                    danmuLimit, danmuSimplifiedTraditional, danmuOffset, convertTopBottomToScroll, convertColor, colorPool, proxyUrl, tmdbApiKey, likeSwitch, hongguoMergeAllEpisodes);

  let cached = await readSegmentCache(params);
  if (!cached.record) return null;

  let record = cached.record;
  let refreshed = false;
  if (!cached.fresh) {
    try {
      const refreshResult = await fetchAndCacheSegmentList(record.commentId, params);
      if (refreshResult.record) record = refreshResult.record;
      refreshed = true;
    } catch (error) {
      log("warn", `[Forward] Failed to refresh expired segment cache: ${error.message}`);
    }
  }

  let segment = findSegmentAtTime(record.segmentList, segmentTime);
  if (!segment && !refreshed) {
    try {
      const refreshResult = await fetchAndCacheSegmentList(record.commentId, params);
      if (refreshResult.record) {
        record = refreshResult.record;
        segment = findSegmentAtTime(record.segmentList, segmentTime);
      }
      refreshed = true;
    } catch (error) {
      log("warn", `[Forward] Failed to refresh segment range: ${error.message}`);
    }
  }
  if (!segment) {
    return buildMissingSegmentResponse(record.segmentList, segmentTime);
  }

  log("info", "[Forward] segment:", segment);
  let response = await getSegmentComment(segment);
  let resJson = await response.json();

  if (!refreshed && shouldRefreshSegmentResponse(resJson, record)) {
    log("warn", "[Forward] Segment response is stale or invalid; refreshing segment list once.");
    try {
      const refreshResult = await fetchAndCacheSegmentList(record.commentId, params);
      refreshed = true;
      if (refreshResult.record) {
        record = refreshResult.record;
        segment = findSegmentAtTime(record.segmentList, segmentTime);
        if (!segment) return buildMissingSegmentResponse(record.segmentList, segmentTime);
        response = await getSegmentComment(segment);
        resJson = await response.json();
      }
    } catch (error) {
      log("warn", `[Forward] Failed to retry stale segment response: ${error.message}`);
    }
  }

  return resJson;
}

async function searchDanmu(params = {}) {
  return globalThis.__FORWARD_WIDGET_DEBUG__ === true
    ? runWithForwardTrace('searchDanmu', params, () => searchDanmuCore(params))
    : searchDanmuCore(params);
}

async function getDetailById(params = {}) {
  return globalThis.__FORWARD_WIDGET_DEBUG__ === true
    ? runWithForwardTrace('getDetailById', params, () => getDetailByIdCore(params))
    : getDetailByIdCore(params);
}

async function getCommentsById(params = {}) {
  return globalThis.__FORWARD_WIDGET_DEBUG__ === true
    ? runWithForwardTrace('getCommentsById', params, () => getCommentsByIdCore(params))
    : getCommentsByIdCore(params);
}

async function getDanmuWithSegmentTime(params = {}) {
  return globalThis.__FORWARD_WIDGET_DEBUG__ === true
    ? runWithForwardTrace('getDanmuWithSegmentTime', params, () => getDanmuWithSegmentTimeCore(params))
    : getDanmuWithSegmentTimeCore(params);
}

// 导出函数以供ForwardWidgets调用
export { searchDanmu, getDetailById, getCommentsById, getDanmuWithSegmentTime };
