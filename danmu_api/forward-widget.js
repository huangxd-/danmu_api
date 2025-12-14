// 独立的弹幕获取插件，直接调用内部函数而不是通过HTTP API
// 该插件集成了后端核心功能，无需启动后端服务

import { searchAnime, getBangumi, getComment, getCommentByUrl, matchAnime } from './apis/dandan-api.js';
import { Globals } from './configs/globals.js';

// 初始化全局配置
let globals;
function initGlobals() {
  if (!globals) {
    globals = Globals.init(process.env);
  }
  return globals;
}

// 搜索弹幕
async function searchDanmu(params) {
  // 初始化全局变量
  initGlobals();
  
  // 创建模拟URL对象
  const url = new URL('http://localhost');
  url.search = `?keyword=${encodeURIComponent(params.keyword || '')}`;
  
  try {
    const response = await searchAnime(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Search error:', error);
    return { errorCode: 500, success: false, errorMessage: error.message, animes: [] };
  }
}

// 获取详情
async function getDetailById(params) {
  // 初始化全局变量
  initGlobals();
  
  try {
    const response = await getBangumi(`/api/v2/bangumi/${params.id}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Get detail error:', error);
    return { errorCode: 500, success: false, errorMessage: error.message, bangumi: null };
  }
}

// 获取弹幕
async function getCommentsById(params) {
  // 初始化全局变量
  initGlobals();
  
  // 使用URL获取弹幕
  if (params.url) {
    try {
      const response = await getCommentByUrl(params.url, 'json');
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Get comments by URL error:', error);
      return { errorCode: 500, success: false, errorMessage: error.message, count: 0, comments: [] };
    }
  } 
  // 或使用commentId获取弹幕
  else if (params.id) {
    try {
      const response = await getComment(`/api/v2/comment/${params.id}`, 'json');
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Get comments by ID error:', error);
      return { errorCode: 500, success: false, errorMessage: error.message, count: 0, comments: [] };
    }
  }
  return { errorCode: 400, success: false, errorMessage: "Missing url or id parameter" };
}

// 获取指定时刻弹幕
async function getDanmuWithSegmentTime(params) {
  // 初始化全局变量
  initGlobals();
  
  // 根据时间段获取弹幕
  if (params.url && params.startTime !== undefined && params.endTime !== undefined) {
    try {
      const response = await getCommentByUrl(params.url, 'json');
      const data = await response.json();
      
      // 过滤时间段内的弹幕
      if (data.comments && Array.isArray(data.comments)) {
        const filteredComments = data.comments.filter(comment => {
          return comment.time >= params.startTime && comment.time <= params.endTime;
        });
        return { ...data, comments: filteredComments, count: filteredComments.length };
      }
      return data;
    } catch (error) {
      console.error('Get segment time danmu error:', error);
      return { errorCode: 500, success: false, errorMessage: error.message, count: 0, comments: [] };
    }
  }
  return { errorCode: 400, success: false, errorMessage: "Missing required parameters" };
}

// 定义WidgetMetadata
const WidgetMetadata = {
  id: "standalone.auto.danmu2",
  title: "自包含弹幕v2 (无需后端服务)",
  version: "2.0.10",
  requiredVersion: "0.0.2",
  description: "直接调用内部函数获取弹幕，无需启动后端服务【五折码：CHEAP.5;七折码：CHEAP】",
  author: "huangxd",
  site: "https://github.com/huangxd-/ForwardWidgets",
  globalParams: [
    {
      name: "other_server",
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
      name: "vod_servers",
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
      name: "bilibili_cookie",
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
      name: "source_order",
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
      name: "blocked_words",
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
      name: "group_minute",
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

// 导出函数以供ForwardWidgets调用
export { searchDanmu, getDetailById, getCommentsById, getDanmuWithSegmentTime, WidgetMetadata };
