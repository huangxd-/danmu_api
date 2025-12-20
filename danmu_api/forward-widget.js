// 独立的弹幕获取插件，直接调用内部函数而不是通过HTTP API
// 该插件集成了后端核心功能，无需启动后端服务

import { searchAnime, getBangumi, getComment, getSegmentComment } from './apis/dandan-api.js';
import { Globals } from './configs/globals.js';

const wv = typeof widgetVersion !== 'undefined' ? widgetVersion : Globals.VERSION;

// 定义WidgetMetadata
const WidgetMetadata = {
  id: "forward.auto.danmu2",
  title: "自动链接弹幕v2",
  version: wv,
  requiredVersion: "0.0.2",
  description: "自动获取播放链接并从服务器获取弹幕【五折码：CHEAP.5;七折码：CHEAP】",
  author: "huangxd",
  site: "https://github.com/huangxd-/ForwardWidgets",
  globalParams: [
    {
      name: "otherServer",
      title: "兜底第三方弹幕服务器，不填默认为https://api.danmu.icu",
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
      name: "vodServers",
      title: "VOD服务器列表，支持多个服务器并发查询，格式：名称@URL,名称@URL,...",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "vod@https://zy.jinchancaiji.com,vod2@https://www.caiji.cyou,vod3@https://gctf.tfdh.top",
        },
        {
          title: "配置2",
          value: "vod@https://zy.jinchancaiji.com",
        },
        {
          title: "配置3",
          value: "vod@https://zy.jinchancaiji.com,vod2@https://www.caiji.cyou",
        },
        {
          title: "配置4",
          value: "vod@https://zy.jinchancaiji.com,vod2@https://gctf.tfdh.top",
        },
      ],
    },
    {
      name: "bilibiliCookie",
      title: "b站cookie（填入后能抓取b站完整弹幕）",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "SESSDATA=xxxx",
        },
      ],
    },
    {
      name: "sourceOrder",
      title: "源排序，用于按源对返回资源的排序（注意：先后顺序会影响自动匹配最终的返回）",
      type: "input",
      placeholders: [
        {
          title: "配置1",
          value: "360,vod,ren,hanjutv",
        },
        {
          title: "配置2",
          value: "360,vod,ren,hanjutv,bahamut",
        },
        {
          title: "配置3",
          value: "vod,360,ren,hanjutv",
        },
        {
          title: "配置4",
          value: "vod,360,ren,hanjutv,bahamut",
        },
      ],
    },
    {
      name: "blockedWords",
      title: "弹幕屏蔽词列表",
      type: "input",
      placeholders: [
        {
          title: "示例",
          value: "/.{20,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\\u4e00-\\u9fa5])\\1{2,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{6,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{5,}$/,/^(\\d)\\1{2,}$/,/\\d{1,2}[.-]\\d{1,2}/,/[@#&$%^*+\\|/\\-_=<>°◆◇■□●○★☆▼▲♥♦♠♣①②③④⑤⑥⑦⑧⑨⑩]/,/[一二三四五六七八九十百\\d]+刷/,/第[一二三四五六七八九十百\\d]+/,/(全体成员|报到|报道|来啦|签到|刷|打卡|我在|来了|考古|爱了|挖坟|留念|你好|回来|哦哦|重温|复习|重刷|前排|沙发|有人看|板凳|末排|我老婆|我老公|撅了|后排|周目|重看|包养|DVD|同上|同样|我也是|俺也|算我|爱豆|我家哥哥|加我|三连|币|新人|入坑|补剧|冲了|硬了|看完|舔屏|万人|牛逼|煞笔|傻逼|卧槽|tm|啊这|哇哦)/",
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
  ],
  modules: [
    {
      //id需固定为searchDanmu
      id: "searchDanmu",
      title: "搜索弹幕",
      functionName: "searchDanmu",
      type: "danmu",
      params: [],
    },
    {
      //id需固定为getDetail
      id: "getDetail",
      title: "获取详情",
      functionName: "getDetailById",
      type: "danmu",
      params: [],
    },
    {
      //id需固定为getComments
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
function initGlobals(otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute) {
  // 将传入的参数设置到环境变量中，以便Globals可以访问它们
  const env = { ...process.env };
  
  if (otherServer !== undefined) env.OTHER_SERVER = otherServer;
  if (vodServers !== undefined) env.VOD_SERVERS = vodServers;
  if (bilibiliCookie !== undefined) env.BILIBILI_COOKIE = bilibiliCookie;
  if (sourceOrder !== undefined) env.SOURCE_ORDER = sourceOrder;
  if (blockedWords !== undefined) env.BLOCKED_WORDS = blockedWords;
  if (groupMinute !== undefined) env.GROUP_MINUTE = groupMinute;
  
  if (!globals) {
    globals = Globals.init(env);
  }
  return globals;
}

const PREFIX_URL = "http://localhost:9321"

async function searchDanmu(params) {
  const { tmdbId, type, title, season, link, videoUrl, otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute } = params;

  await initGlobals(otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute);

  const response = await searchAnime(new URL(`${PREFIX_URL}/api/v2/search/anime?keyword=${title}`));
  const resJson = await response.json();
  const animes = resJson.animes;

  console.log("info", "animes: ", animes);

  return {
    animes: animes,
  };
}

async function getDetailById(params) {
  const { animeId, otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute } = params;

  await initGlobals(otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute);

  const response = await getBangumi(`${PREFIX_URL}/api/v2/bangumi/${animeId}`);
  const resJson = await response.json();

  console.log("info", "bangumi", resJson);

  return resJson.bangumi.episodes;
}

async function getCommentsById(params) {
  const { commentId, link, videoUrl, season, episode, tmdbId, type, title, segmentTime, otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute } = params;

  await initGlobals(otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute);

  if (commentId) {
    const storeKey = season && episode ? `${tmdbId}.${season}.${episode}` : `${tmdbId}`;
    const segmentList = Widget.storage.get(storeKey);
    
    console.log("info", "tmdbId:", tmdbId);
    console.log("info", "segmentList:", segmentList);
    if (segmentList) {
        return await getDanmuWithSegmentTime({ segmentTime, tmdbId, season, episode, otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute })
    }

    const response = await getComment(`${PREFIX_URL}/api/v2/comment/${commentId}`, "json", true);
    const resJson = await response.json();

    Widget.storage.set(storeKey, resJson.comments.segmentList);

    console.log("segmentList", resJson.comments.segmentList);

    return resJson.comments.segmentList;
  }
  return null;
}

async function getDanmuWithSegmentTime(params) {
  const { segmentTime, tmdbId, season, episode, otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute } = params;

  await initGlobals(otherServer, vodServers, bilibiliCookie, sourceOrder, blockedWords, groupMinute);

  const storeKey = season && episode ? `${tmdbId}.${season}.${episode}` : `${tmdbId}`;
  const segmentList = Widget.storage.get(storeKey);
  if (segmentList) {
    const segment = segmentList.find((item) => {
        const start = Number(item.segment_start);
        const end = Number(item.segment_end);
        const time = Number(segmentTime);
        return time >= start && time < end;
    });
    console.log("info", "segment:", segment);
    const response = await getSegmentComment(segment);
    const resJson = await response.json();

    return resJson;
  }
  return null;
}

// 导出函数以供ForwardWidgets调用
export { searchDanmu, getDetailById, getCommentsById, getDanmuWithSegmentTime, WidgetMetadata };
