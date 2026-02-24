import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { jsonResponse, xmlResponse } from "./http-util.js";
import { traditionalized } from './zh-util.js';

// =====================
// danmu处理相关函数
// =====================

/**
 * 对弹幕进行分组、去重和计数处理
 * @param {Array} filteredDanmus 已过滤屏蔽词的弹幕列表
 * @param {number} n 分组时间间隔（分钟），0表示不分组（除非多源合并强制去重）
 * @returns {Array} 处理后的弹幕列表
 */
export function groupDanmusByMinute(filteredDanmus, n) {
  // 解析弹幕来源标签以确定合并源数量，用于智能去重
  // 检查第一条弹幕的 p 属性结尾的 [source] 标签
  let sourceCount = 1;
  if (filteredDanmus.length > 0 && filteredDanmus[0].p) {
    const pStr = filteredDanmus[0].p;
    const match = pStr.match(/\[([^\]]*)\]$/);
    if (match && match[1]) {
      // 支持半角 '&' 和全角 '＆' 分隔符
      sourceCount = match[1].split(/[&＆]/).length;
    }
  }

  // 如果检测到多源合并，输出日志提示
  if (sourceCount > 1) {
    log("info", `[Smart Deduplication] Detected multi-source merged danmaku (${sourceCount} sources). Applying smart count adjustment.`);
  }

  // 特殊逻辑：如果未开启分组(n=0)且为单源，直接返回原始数据
  // 若为多源，即使n=0也强制执行精确时间点去重，以消除源之间的重复数据
  if (n === 0 && sourceCount === 1) {
    return filteredDanmus.map(danmu => ({
      ...danmu,
      t: danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0])
    }));
  }

  // 按 n 分钟分组
  const groupedByTime = filteredDanmus.reduce((acc, danmu) => {
    // 获取时间：优先使用 t 字段，如果没有则使用 p 的第一个值
    const time = danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0]);
    
    // 确定分组键：n=0时使用精确时间(保留2位小数)，否则使用分钟索引
    const groupKey = n === 0 ? time.toFixed(2) : Math.floor(time / (n * 60));

    // 初始化分组
    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }

    // 添加到对应分组
    acc[groupKey].push({ ...danmu, t: time });
    return acc;
  }, {});

  // 处理每组的弹幕
  const result = Object.keys(groupedByTime).map(key => {
    const danmus = groupedByTime[key];

    // 按消息内容分组
    const groupedByMessage = danmus.reduce((acc, danmu) => {
      const message = danmu.m.split(' X')[0].trim(); // 提取原始消息（去除 Xn 后缀）
      if (!acc[message]) {
        acc[message] = {
          count: 0,
          earliestT: danmu.t,
          cid: danmu.cid,
          p: danmu.p,
          like: 0  // 初始化like字段
        };
      }
      acc[message].count += 1;
      // 更新最早时间
      acc[message].earliestT = Math.min(acc[message].earliestT, danmu.t);
      // 合并like字段，如果是undefined则视为0
      acc[message].like += (danmu.like !== undefined ? danmu.like : 0);
      return acc;
    }, {});

    // 转换为结果格式
    return Object.keys(groupedByMessage).map(message => {
      const data = groupedByMessage[message];
      
      // 计算显示计数：总次数除以源数量，四舍五入
      // 过滤因多源合并产生的自然重复
      let displayCount = Math.round(data.count / sourceCount);
      if (displayCount < 1) displayCount = 1;

      return {
        cid: data.cid,
        p: data.p,
        // 仅当计算后的逻辑计数大于1时才显示 "x N"
        m: displayCount > 1 ? `${message} x ${displayCount}` : message,
        t: data.earliestT,
        like: data.like // 包含合并后的like字段
      };
    });
  });

  // 展平结果并按时间排序
  return result.flat().sort((a, b) => a.t - b.t);
}

/**
 * 处理弹幕的点赞数显示
 * @param {Array} groupedDanmus 弹幕列表
 * @returns {Array} 处理后的弹幕列表
 */
export function handleDanmusLike(groupedDanmus) {
  return groupedDanmus.map(item => {
    // 如果item没有like字段或者like值小于5，则不处理
    if (!item.like || item.like < 5) {
      return item;
    }

    // 获取弹幕来源信息，判断是否为hanjutv
    const isHanjutv = item.p.includes('[hanjutv]');

    // 确定阈值：hanjutv中>=100用🔥，其他>=1000用🔥
    const threshold = isHanjutv ? 100 : 1000;
    const icon = item.like >= threshold ? '🔥' : '❤️';

    // 格式化点赞数，缩写显示
    let formattedLike;
    if (item.like >= 10000) {
      // 万级别，如 1.2w
      formattedLike = (item.like / 10000).toFixed(1) + 'w';
    } else if (item.like >= 1000) {
      // 千级别，如 1.2k
      formattedLike = (item.like / 1000).toFixed(1) + 'k';
    } else {
      // 百级别及以下，直接显示数字
      formattedLike = item.like.toString();
    }

    // 在弹幕内容m字段后面添加点赞信息
    const likeText = ` ${icon} ${formattedLike}`;
    const newM = item.m + likeText;

    // 创建新对象，复制原属性，更新m字段，并删除like字段
    const { like, ...rest } = item;
    return {
      ...rest,
      m: newM
    };
  });
}

export function limitDanmusByCount(filteredDanmus, danmuLimit) {
  // 如果 danmuLimit 为 0，直接返回原始数据
  if (danmuLimit === 0) {
    return filteredDanmus;
  }

  // 计算目标弹幕数量
  const targetCount = danmuLimit * 1000;
  const totalCount = filteredDanmus.length;

  // 如果当前弹幕数不超过目标数量，直接返回
  if (totalCount <= targetCount) {
    return filteredDanmus;
  }

  // 计算采样间隔
  const interval = totalCount / targetCount;

  // 按间隔抽取弹幕
  const result = [];
  for (let i = 0; i < targetCount; i++) {
    // 计算当前应该取的索引位置
    const index = Math.floor(i * interval);
    result.push(filteredDanmus[index]);
  }

  return result;
}

export function convertToDanmakuJson(contents, platform) {
  let danmus = [];
  let cidCounter = 1;

  // 统一处理输入为数组
  let items = [];
  if (typeof contents === "string") {
    // 处理 XML 字符串
    items = [...contents.matchAll(/<d p="([^"]+)">([^<]+)<\/d>/g)].map(match => ({
      p: match[1],
      m: match[2]
    }));
  } else if (contents && Array.isArray(contents.danmuku)) {
    // 处理 danmuku 数组，映射为对象格式
    const typeMap = { right: 1, top: 4, bottom: 5 };
    const hexToDecimal = (hex) => (hex ? parseInt(hex.replace("#", ""), 16) : 16777215);
    items = contents.danmuku.map(item => ({
      timepoint: item[0],
      ct: typeMap[item[1]] !== undefined ? typeMap[item[1]] : 1,
      color: hexToDecimal(item[2]),
      content: item[4]
    }));
  } else if (Array.isArray(contents)) {
    // 处理标准对象数组
    items = contents;
  }

  if (!items.length) {
    // 如果是空数组，直接返回空数组，不抛出异常
    // 这样可以让兜底逻辑有机会执行
    return [];
  }

  for (const item of items) {
    let attributes, m;
    let time, mode, color;

    // 新增：处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      time = (item.progress / 1000).toFixed(2);
      mode = item.mode || 1;
      color = item.color || 16777215;
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      time = parseFloat(item.timepoint).toFixed(2);
      mode = item.ct || 0;
      color = item.color || 16777215;
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      time = parseFloat(pValues[0]).toFixed(2);
      mode = pValues[1] || 0;

      // 支持多种格式的 p 属性
      // 旧格式（4字段）：时间,类型,颜色,来源
      // 标准格式（8字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
      // Bilibili格式（9字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID,权重
      if (pValues.length === 4) {
        // 旧格式
        color = pValues[2] || 16777215;
      } else if (pValues.length >= 8) {
        // 新标准格式（8字段或9字段）
        color = pValues[3] || 16777215;
      } else {
        // 其他格式，尝试从第3或第4位获取颜色
        color = pValues[3] || pValues[2] || 16777215;
      }
      m = item.m;
    }

    attributes = [
      time,
      mode,
      color,
      `[${platform}]`
    ].join(",");

    danmus.push({ p: attributes, m, cid: cidCounter++, like: item?.like });
  }

  // 切割字符串成正则表达式数组
  const regexArray = globals.blockedWords.split(/(?<=\/),(?=\/)/).map(str => {
    // 去除两端的斜杠并转换为正则对象
    const pattern = str.trim();
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        // 去除两边的 `/` 并转化为正则
        return new RegExp(pattern.slice(1, -1));
      } catch (e) {
        log("error", `无效的正则表达式: ${pattern}`, e);
        return null;
      }
    }
    return null; // 如果不是有效的正则格式则返回 null
  }).filter(regex => regex !== null); // 过滤掉无效的项

  log("info", `原始屏蔽词字符串: ${globals.blockedWords}`);
  const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
  log("info", `屏蔽词列表: ${regexArrayToString(regexArray)}`);

  // 过滤列表
  const filteredDanmus = danmus.filter(item => {
    return !regexArray.some(regex => regex.test(item.m)); // 针对 `m` 字段进行匹配
  });

  // 按n分钟内去重
  log("info", `去重分钟数: ${globals.groupMinute}`);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, globals.groupMinute);

  // 处理点赞数
  const likeDanmus = handleDanmusLike(groupedDanmus);

  // 应用弹幕转换规则（在去重和限制弹幕数之后）
  let convertedDanmus = limitDanmusByCount(likeDanmus, globals.danmuLimit);
  if (globals.convertTopBottomToScroll || globals.convertColor === 'white' || globals.convertColor === 'color') {
    let topBottomCount = 0;
    let colorCount = 0;

    convertedDanmus = convertedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) return danmu;

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10);
      let modified = false;

      // 1. 将顶部/底部弹幕转换为浮动弹幕
      if (globals.convertTopBottomToScroll && (mode === 4 || mode === 5)) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 弹幕转换颜色
      // 2.1 将彩色弹幕转换为白色
      if (globals.convertColor === 'white' && color !== 16777215) {
        colorCount++;
        color = 16777215;
        modified = true;
      }
      // 2.2 将白色弹幕转换为随机颜色，白、红、橙、黄、绿、青、蓝、紫、粉（模拟真实情况，增加白色出现概率）
      let colors = [16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 
                    16744319, 16752762, 16774799, 9498256, 8388564, 8900346, 14204888, 16758465];
      let randomColor = colors[Math.floor(Math.random() * colors.length)];
      if (globals.convertColor === 'color' && color === 16777215 && color !== randomColor) {
        colorCount++;
        color = randomColor;
        modified = true;
      }

      if (modified) {
        const newP = [pValues[0], mode, color, ...pValues.slice(3)].join(',');
        return { ...danmu, p: newP };
      }
      return danmu;
    });

    // 统计输出转换结果
    if (topBottomCount > 0) {
      log("info", `[danmu convert] 转换了 ${topBottomCount} 条顶部/底部弹幕为浮动弹幕`);
    }
    if (colorCount > 0) {
      log("info", `[danmu convert] 转换了 ${colorCount} 条弹幕颜色`);
    }
  }

  // 根据 danmuSimplifiedTraditional 设置转换弹幕文本
  if (globals.danmuSimplifiedTraditional === 'traditional') {
    convertedDanmus = convertedDanmus.map(danmu => ({
      ...danmu,
      m: traditionalized(danmu.m)
    }));
    log("info", `[danmu convert] 转换了 ${convertedDanmus.length} 条弹幕为繁体字`);
  }

  log("info", `danmus_original: ${danmus.length}`);
  log("info", `danmus_filter: ${filteredDanmus.length}`);
  log("info", `danmus_group: ${groupedDanmus.length}`);
  log("info", `danmus_limit: ${convertedDanmus.length}`);
  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(convertedDanmus.slice(0, 5), null, 2));
  return convertedDanmus;
}

// RGB 转整数的函数
export function rgbToInt(color) {
  // 检查 RGB 值是否有效
  if (
    typeof color.r !== 'number' || color.r < 0 || color.r > 255 ||
    typeof color.g !== 'number' || color.g < 0 || color.g > 255 ||
    typeof color.b !== 'number' || color.b < 0 || color.b > 255
  ) {
    return -1;
  }
  return color.r * 256 * 256 + color.g * 256 + color.b;
}

// 解析 hex 到 int（假设不带 #）
export function hexToInt(hex) {
  // 简单校验：确保是 6 位 hex 字符串（不带 #）
  if (typeof hex !== 'string' || hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
    return 16777215;  // 无效输入，返回 16777215 白色
  }
  return parseInt(hex, 16);  // 直接转换为整数
}

// 将弹幕 JSON 数据转换为 XML 格式（Bilibili 标准格式）
export function convertDanmuToXml(danmuData) {
  let xml = '<?xml version="1.0" ?>\n';
  xml += '<i>\n';

  // 添加弹幕数据
  const comments = danmuData.comments || [];
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      // 解析原有的 p 属性，转换为 Bilibili 格式
      const pValue = buildBilibiliDanmuP(comment);
      xml += '    <d p="' + escapeXmlAttr(pValue) + '">' + escapeXmlText(comment.m) + '</d>\n';
    }
  }

  xml += '</i>';
  return xml;
}

// 生成弹幕ID（11位数字）
function generateDanmuId() {
  // 生成11位数字ID
  // 格式: 时间戳后8位 + 随机3位
  const timestamp = Date.now();
  const lastEightDigits = (timestamp % 100000000).toString().padStart(8, '0');
  const randomThreeDigits = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return lastEightDigits + randomThreeDigits;
}

// 构建 Bilibili 格式的 p 属性值（8个字段）
function buildBilibiliDanmuP(comment) {
  // Bilibili 格式: 时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
  // 示例: 5.0,5,25,16488046,1751533608,0,0,13190629936

  const pValues = comment.p.split(',');
  const timeNum = parseFloat(pValues[0]) || 0;
  const time = timeNum.toFixed(1); // 时间（秒，保留1位小数）
  const mode = pValues[1] || '1'; // 类型（1=滚动, 4=底部, 5=顶部）
  const fontSize = '25'; // 字体大小（25=中, 18=小）

  // 颜色字段（输入总是4字段格式：时间,类型,颜色,平台）
  const color = pValues[2] || '16777215'; // 默认白色

  // 使用固定值以符合标准格式
  const timestamp = '1751533608'; // 固定时间戳
  const pool = '0'; // 弹幕池（固定为0）
  const userHash = '0'; // 用户Hash（固定为0）
  const danmuId = generateDanmuId(); // 弹幕ID（11位数字）

  return `${time},${mode},${fontSize},${color},${timestamp},${pool},${userHash},${danmuId}`;
}

// 转义 XML 属性值
function escapeXmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 转义 XML 文本内容
function escapeXmlText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 根据格式参数返回弹幕数据（JSON 或 XML）
export function formatDanmuResponse(danmuData, queryFormat) {
  // 确定最终使用的格式：查询参数 > 环境变量 > 默认值
  let format = queryFormat || globals.danmuOutputFormat;
  format = format.toLowerCase();

  log("info", `[Format] Using format: ${format}`);

  if (format === 'xml') {
    try {
      const xmlData = convertDanmuToXml(danmuData);
      return xmlResponse(xmlData);
    } catch (error) {
      log("error", `Failed to convert to XML: ${error.message}`);
      // 转换失败时回退到 JSON
      return jsonResponse(danmuData);
    }
  }

  // 默认返回 JSON
  return jsonResponse(danmuData);
}
