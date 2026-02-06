import { globals } from '../configs/globals.js';
import { log as baseLog } from './log-util.js';
import { normalizeSpaces } from './common-util.js';
import { addAnime } from './cache-util.js';
import { simplized } from '../utils/zh-util.js';

// =====================
// 源合并处理工具
// =====================

// 定义组合ID的分隔符 (URL Safe)
export const MERGE_DELIMITER = '$$$';
// 定义前端显示的源连接符
export const DISPLAY_CONNECTOR = '&';

// 调试级别的日志开关 false/true
const ENABLE_VERBOSE_MERGE_LOG = false; 

/**
 * 覆盖当前文件的 log 定义
 * 这个函数会拦截所有 log(...) 调用，并根据内容过滤
 */
function log(level, ...args) {
    // 检查是否是需要过滤的“细碎”日志
    const isMergeCheck = typeof args[0] === 'string' && args[0].includes('[Merge-Check]');
    
    if (isMergeCheck && !ENABLE_VERBOSE_MERGE_LOG) {
        return;
    }

    // 否则，调用原有的日志逻辑
    baseLog(level, ...args);
}

// ==========================================
// 正则表达式预编译区
// 将所有静态正则提取至此，避免函数重复调用时的重新编译开销
// ==========================================

// 纯季度/Part标识正则 (用于判断副标题是否仅仅是 S2 或 Part 3)
const REGEX_PURE_SEASON_PART = /^(?:(?:第|S(?:eason)?)\s*\d+(?:季|期|部)?|(?:Part|P|第)\s*\d+(?:部分)?)$/i;

// 语言识别正则
const RE_LANG_CN = /(普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听)(?:版)?/;
const RE_LANG_JP = /(日语|日配|原版|原声)(?:版)?/;

// cleanText 相关正则 (通用清洗)
const RE_NA_TAG = /(\(|（|\[)N\/A(\)|）|\])/gi;
const RE_PART_NORM = /第(\d+)部分/g;
const RE_PART_NORM_2 = /(?:Part|P)[\s.]*(\d+)/gi;
const RE_FINAL_SEASON = /(?:The\s+)?Final\s+Season/gi;
const RE_SEASON_NORM = /(?:Season|S)\s*(\d+)/gi;
const RE_CN_SEASON = /第([一二三四五六七八九十])季/g;
const RE_ROMAN_SEASON = /(\s|^)(IV|III|II|I)(\s|$)/g;
const RE_CN_DUB_VER = /(\(|（|\[)?(普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听)版?(\)|）|\])?/g;
const RE_JP_DUB_VER = /(\(|（|\[)?(日语|日配|原版|原声)版?(\)|）|\])?/g;
const RE_SOURCE_TAG = /【.*?】/g;
const RE_REGION_LIMIT = /(\(|（|\[)仅限.*?地区(\)|）|\])/g;
const RE_PUNCTUATION = /[!！?？,，.。、~～:：\-–—_]/g;
const RE_WHITESPACE = /\s+/g;

// cleanTitleForSimilarity 相关正则 (相似度专用极简清洗)
const RE_FROM_SUFFIX = /\s*from\s+.*$/i;
const RE_PARENTHESES_CONTENT = /(\(|（|\[).*?(\)|）|\])/g;
const RE_SEASON_INFO_STRONG = /(?:season|s|第)\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部(?!分))?/gi;
const RE_PART_INFO_STRONG = /(?:part|p|第)\s*\d+\s*(?:部分)?/gi;
const RE_MOVIE_KEYWORDS = /剧场版|the\s*movie|theatrical|movie|film|电影/gi;
const RE_LANG_KEYWORDS_STRONG = /(?:普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听|日语|日配|原版|原声)(?:版)?/g;
const RE_LONE_VER_CHAR = /(\s|^)版(\s|$)/g;
const RE_NON_ALPHANUM_CN = /[^\u4e00-\u9fa5a-zA-Z0-9]/g;

// cleanEpisodeText 相关正则 (集标题清洗)
const RE_EP_SUFFIX_DIGIT = /_\d+(?=$|\s)/g;
const RE_FILE_NOISE = /_(\d{2,4})(?=\.)/g;
const RE_EP_SEASON_PREFIX = /(?:^|\s)(?:第[0-9一二三四五六七八九十]+季|S(?:eason)?\s*\d+)(?:\s+|_)/gi;
const RE_CLEAN_EP_SMART = /(?:^|\s)(?:EP|E|Vol|Episode|No|Part|第)\s*\d+(?:\.\d+)?(?:\s*[话話集])?(?!\s*[季期部])/gi;
const RE_LANG_CN_STD = /普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听/g;
const RE_LANG_JP_STD = /日语|日配|原版|原声/g;
const RE_EP_PUNCTUATION = /[!！?？,，.。、~～:：\-–—]/g;

// checkTitleSubtitleConflict 相关正则 (结构检测)
const RE_META_SUFFIX = /(\(|（|\[)(续篇|TV版|无修|未删减|完整版)(\)|）|\])/gi;
const RE_YEAR_TAG = /(\(|（|\[)\d{4}(\)|）|\]).*$/i;
const RE_SUBTITLE_SEPARATOR = /^[\s:：\-–—(（\[【]/;
const RE_SPACE_STRUCTURE = /.+[\s\u00A0\u3000].+/;
const RE_SPLIT_SPACES = /[\s\u00A0\u3000]+/;

// extractSeasonMarkers 相关正则模式 (季数/类型提取)
const SEASON_PATTERNS = [
  { regex: /(?:第)?(\d+)(?:季|期|部(?!分))/, prefix: 'S' }, 
  { regex: /season\s*(\d+)/, prefix: 'S' }, 
  { regex: /s(\d+)/, prefix: 'S' },         
  { regex: /part\s*(\d+)/, prefix: 'P' },   
  { regex: /(ova|oad)/, val: 'OVA' },
  { regex: /(剧场版|the\s*movie|theatrical|movie|film|电影)/, val: 'MOVIE' },
  { regex: /(续篇|续集)/, val: 'SEQUEL' },
  { regex: /sp/, val: 'SP' },
  // 末尾数字检测：改为使用无 Part 的文本进行检测
  { regex: /[^0-9](\d)$/, prefix: 'S', useCleaned: true } 
];
const RE_PART_ANY = /(?:part|p)\s*\d+/gi; // 用于预处理移除Part

// 起承转结结构正则 (Global Scope) 匹配模式：空格/开头/x数字 后接 承/转/结，且后面是结束或分隔符
const RE_CN_STRUCTURE = /(?:^|\s|×\d+\s?)(承|转|结)(?=$|[\s\(\（\[【])/i;

// 复杂特定后缀 (高优先级检测)
// 包含: A's(S2), StrikerS(S3), ViVid(S4), SuperS(S4)
const RE_SUFFIX_SPECIFIC_MAP = [
    { regex: /(?:\s|^)A's$/i, val: 'S2' },
    { regex: /(?:\s|^)StrikerS$/i, val: 'S3' },
    { regex: /(?:\s|^)ViVid$/i, val: 'S4' },
    { regex: /(?:\s|^)SuperS$/i, val: 'S4' } 
];

// 歧义后缀 (S, T, R, II...)
// 这些后缀含义不确定，可能是 S2, S3 或 OVA，需配合内容探测
// 允许紧跟汉字([\u4e00-\u9fa5])或空格，且后缀后必须是结束符或标点
const RE_SUFFIX_AMBIGUOUS = /(?:[\s\u4e00-\u9fa5]|^)(S|T|R|II|III|IV)(?=$|[\s\(\（\[【])/i;

// 续篇标识
const RE_SUFFIX_SEQUEL = /(?:续篇|续集|The Sequel)/i;

// extractEpisodeInfo 相关正则 (集数提取)
const RE_DANDAN_TAG = /^【(dandan|animeko)】/i;
const RE_SPECIAL_START = /^S\d+/i; // dandan S1 check
const RE_MOVIE_CHECK = /剧场版|movie|film/i;
const RE_PV_CHECK = /(pv|trailer|预告)/i;
const RE_SPECIAL_CHECK = /^(s|o|sp|special)\d/i;
const RE_EP_SEASON_MATCH = /(?:^|\s)(?:第|S)(\d+)[季S]/i;
const RE_EP_NUM_STRATEGY_A = /(?:第|s)(\d+)[季s]\s*(?:第|ep|e)(\d+)/i;
const RE_EP_NUM_STRATEGY_B = /(?:ep|e|vol|episode|chapter|no|part|第)\s*(\d+(\.\d+)?)(?:\s*[话話集])?(?!\s*[季期部])/i;
const RE_EP_NUM_STRATEGY_C = /(?:^|\s)(?:第)?(\d+(\.\d+)?)(?:话|集|\s|$)/;

// dandan/animeko 特殊集排除相关正则 (S1, C1...)
const RE_DANDAN_IGNORE_EP = /^[SC]\d+/i; 

// 非正片集数关键词相关正则 (用于构建季度集数地图时严格过滤)
const RE_MAP_EXCLUDE_KEYWORDS = /(?:^|\s)(?:PV|OP|ED|SP|Special|Drama|OAD|OVA|Opening|Ending|特番|特典|Behind\s+the\s+Scenes|Making|Interview)(?:\s|$|[:：])/i;

// getContentCategory 相关 (内容分类)
const RE_ANIME_KW = /(动画|TV动画|动漫|日漫|国漫)/;
const RE_REAL_KW = /(电视剧|真人剧|综艺|纪录片)/;
const RE_ANIMEKO_SOURCE = /animeko/i;

// identifyRedundantTitle 相关 (冗余检测)
const RE_REDUNDANT_SEPARATOR = /[\s:：~～]/;
const RE_REDUNDANT_UNSAFE_END = /[\(\（\[【:：~～\-]$/;
const RE_REDUNDANT_VALID_CHARS = /[\u4e00-\u9fa5a-zA-Z]{2,}/;

// findBestAlignmentOffset - CN Strict Mode (纯中文模式)
const RE_CN_STRICT_CORE_REMOVE = /[0-9a-zA-Z\s第季集话partEPep._\-–—:：【】()（）]/gi;

// 列表沉底检测正则 匹配规则：以 S, C, SP, OP, ED, PV 开头，后跟数字，或者特定的关键词
const RE_SPECIAL_SINK_TITLE_STRICT = /^(?:S\d+|C\d+|SP\d*|OP\d*|ED\d*|PV\d*|Trailers?|Interview|Making|特番|特典)(?:\s|$|[:：.\-]|\u3000)/i;

/**
 * 获取文本的语言/配音类型
 * 用于识别中配、日配、原声等特征，辅助匹配优先级判断
 * @param {string} text 标题文本
 * @returns {string} 语言类型 ('CN' | 'JP' | 'Unspecified')
 */
function getLanguageType(text) {
  if (!text) return 'Unspecified';
  const t = text.toLowerCase();
  if (RE_LANG_CN.test(t)) return 'CN';
  if (RE_LANG_JP.test(t)) return 'JP';
  return 'Unspecified';
}

/**
 * 文本清洗工具函数
 * 将文本转为简体，移除干扰标识，并对季数、章节进行标准化处理
 * @param {string} text 原始文本
 * @returns {string} 清洗后的标准化文本
 */
function cleanText(text) {
  if (!text) return '';
  let clean = simplized(text);
  
  clean = clean.replace(RE_NA_TAG, '');
  clean = clean.replace(RE_PART_NORM, 'part $1');
  clean = clean.replace(RE_PART_NORM_2, 'part $1');

  clean = clean.replace(RE_FINAL_SEASON, '最终季');
  clean = clean.replace(RE_SEASON_NORM, '第$1季');
  
  const cnNums = {'一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9', '十':'10'};
  clean = clean.replace(RE_CN_SEASON, (m, num) => `第${cnNums[num]}季`);
  
  clean = clean.replace(RE_ROMAN_SEASON, (match, p1, roman, p2) => {
      const rMap = {'I':'1', 'II':'2', 'III':'3', 'IV':'4'};
      return `${p1}第${rMap[roman]}季${p2}`;
  });

  clean = clean.replace(RE_CN_DUB_VER, '中配版');
  clean = clean.replace(RE_JP_DUB_VER, '');
  clean = clean.replace(RE_SOURCE_TAG, '');
  clean = clean.replace(RE_REGION_LIMIT, '');
  
  // 保护数字中间的小数点 (如 12.5 -> 12{{DOT}}5)
  // 避免被 RE_PUNCTUATION 误伤
  clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');

  clean = clean.replace(RE_PUNCTUATION, ' ');

  // 恢复小数点
  clean = clean.replace(/{{DOT}}/g, '.');
  
  return clean.replace(RE_WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 相似度计算专用极简清洗函数
 * 深度增强清洗能力，强力移除季数、Part、括号内容，确保 "S1" 与 "S1 Part 2" 文本一致
 * 保护开头的【Title】结构，解决 "【Title】(Year)" 被过度清洗的问题
 * @param {string} text 原始标题
 * @returns {string} 用于相似度计算的极简字符串
 */
function cleanTitleForSimilarity(text) {
    if (!text) return '';
    let clean = simplized(text);
    
    // 标题保护逻辑：如果标题被包裹在【】或[]中且位于开头，尝试提取内容
    // 必须在 RE_SOURCE_TAG (移除所有【】) 之前执行
    // 示例: 【我推的孩子】(2023)【动漫】 -> 我推的孩子 (2023)【动漫】
    const startBracketMatch = clean.match(/^(?:【|\[)(.+?)(?:】|\])/);
    if (startBracketMatch) {
        const content = startBracketMatch[1];
        // 只有当括号内的内容不像是一个简单的类型标识（如“动漫”、“TV”）时，才认为是标题
        if (!/^(TV|剧场版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
             clean = clean.replace(startBracketMatch[0], content + ' ');
        }
    }

    clean = clean.replace(RE_SOURCE_TAG, '');
    clean = clean.replace(RE_FROM_SUFFIX, '');
    clean = clean.replace(RE_NA_TAG, '');
    clean = clean.replace(RE_PARENTHESES_CONTENT, ''); 
    clean = clean.replace(RE_SEASON_INFO_STRONG, ''); 
    clean = clean.replace(RE_PART_INFO_STRONG, ''); 
    clean = clean.replace(RE_MOVIE_KEYWORDS, '');
    clean = clean.replace(RE_LANG_KEYWORDS_STRONG, ''); 
    clean = clean.replace(RE_LONE_VER_CHAR, ''); 
    clean = clean.replace(RE_NON_ALPHANUM_CN, '');

    return clean.toLowerCase();
}

/**
 * 专用于集标题的清洗函数
 * 专门净化 "第X集_01"、"EP01"、"第1话" 等格式，只保留核心标题
 * @param {string} text 集标题
 * @returns {string} 清洗后的集标题
 */
function cleanEpisodeText(text) {
    if (!text) return '';
    let clean = simplized(text);

    // 1. 清除文件杂质
    clean = clean.replace(RE_EP_SUFFIX_DIGIT, ''); 
    clean = clean.replace(RE_FILE_NOISE, '');
    // 2. 清除季数前缀 (S2 ...)
    clean = clean.replace(RE_EP_SEASON_PREFIX, ' ');
    // 3. 清除集数编号 (第25话 -> "")
    clean = clean.replace(RE_CLEAN_EP_SMART, ' ');
    clean = clean.replace(RE_SOURCE_TAG, '');
    clean = clean.replace(RE_LANG_CN_STD, '中文');
    clean = clean.replace(RE_LANG_JP_STD, '日文');
    // 保护数字中间的小数点
    clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');
    clean = clean.replace(RE_EP_PUNCTUATION, ' ');
    // 恢复小数点
    clean = clean.replace(/{{DOT}}/g, '.');
    
    return clean.replace(RE_WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 移除标题中的所有括号内容
 * 用于提取主标题进行比对，规避副标题翻译差异
 * @param {string} text 清洗后的文本
 * @returns {string} 移除括号后的文本
 */
function removeParentheses(text) {
  if (!text) return '';
  return text.replace(RE_PARENTHESES_CONTENT, '').trim();
}

/**
 * 清洗并提取真实的 ID/URL
 * 用于从组合字符串中还原出原始请求 ID
 * @param {string} urlStr 原始 URL 字符串
 * @returns {string} 清洗后的 ID 或 完整 URL
 */
function sanitizeUrl(urlStr) {
  if (!urlStr) return '';
  
  let clean = String(urlStr).split(MERGE_DELIMITER)[0].trim();

  if (clean.startsWith('//')) {
    return 'https:' + clean;
  }

  const match = clean.match(/^([^:]+):(.+)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const body = match[2];

    if (prefix === 'http' || prefix === 'https') {
      return clean;
    }
    if (/^https?:\/\//i.test(body)) {
      return body;
    }
    if (body.startsWith('//')) {
      return 'https:' + body;
    }
    return body;
  }
  return clean;
}

/**
 * 解析日期字符串为对象
 * 年份阈值设定为 2030
 * @param {string} dateStr 日期字符串
 * @returns {Object} 日期对象 { year: number|null, month: number|null }
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'N/A') return { year: null, month: null };
  const d = new Date(dateStr);
  const time = d.getTime();
  if (isNaN(time)) return { year: null, month: null };
  
  const year = d.getFullYear();
  if (year > 2030) return { year: null, month: null };
  
  return {
    year: year,
    month: d.getMonth() + 1
  };
}

/**
 * 计算编辑距离 (Levenshtein Distance)
 * 空间复杂度优化为 O(min(m,n))
 * @param {string} s1 字符串1
 * @param {string} s2 字符串2
 * @returns {number} 编辑距离
 */
function editDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  // 使用两行数组代替矩阵，空间优化
  let prevRow = new Array(len2 + 1);
  let currRow = new Array(len2 + 1);

  for (let j = 0; j <= len2; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    currRow[0] = i;
    const char1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= len2; j++) {
      const cost = char1 === s2.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,      // insertion
        prevRow[j] + 1,          // deletion
        prevRow[j - 1] + cost    // substitution
      );
    }
    // Swap rows
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  
  return prevRow[len2];
}

/**
 * 计算 Dice 相似度系数 (基于字符集合)
 * 用于解决长标题意译差异，对语序不敏感
 * @param {string} s1 字符串1
 * @param {string} s2 字符串2
 * @returns {number} Dice 系数 (0.0 - 1.0)
 */
function calculateDiceSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  
  const set1 = new Set(s1.replace(RE_WHITESPACE, ''));
  const set2 = new Set(s2.replace(RE_WHITESPACE, ''));
  
  const size1 = set1.size;
  const size2 = set2.size;

  if (size1 === 0 && size2 === 0) return 1.0;
  if (size1 === 0 || size2 === 0) return 0.0;

  let intersection = 0;
  // 优化：总是遍历较小的 Set
  const [smaller, larger] = size1 < size2 ? [set1, set2] : [set2, set1];
  
  for (const char of smaller) {
    if (larger.has(char)) {
      intersection++;
    }
  }

  return (2.0 * intersection) / (size1 + size2);
}

/**
 * 计算两个字符串的综合相似度 (0.0 - 1.0)
 * 结合编辑距离、Dice系数和覆盖系数，取最大值
 * 引入覆盖系数解决 "判处勇者刑" vs "勇者处刑..." 问题
 * @param {string} str1 字符串1
 * @param {string} str2 字符串2
 * @returns {number} 相似度得分
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = cleanTitleForSimilarity(str1);
  const s2 = cleanTitleForSimilarity(str2);
  
  if (s1 === s2) return 1.0;
  
  const len1 = s1.length;
  const len2 = s2.length;
  const maxLen = Math.max(len1, len2);
  const minLen = Math.min(len1, len2);

  // 包含关系检测
  if (s1.includes(s2) || s2.includes(s1)) {
    const lenRatio = minLen / maxLen;
    // 只有当长度差异不悬殊(>0.5)时，才给予包含关系的高分奖励
    if (lenRatio > 0.5) {
        return 0.8 + (lenRatio * 0.2); 
    }
  }
  
  // 编辑距离得分
  const distance = editDistance(s1, s2);
  const editScore = maxLen === 0 ? 1.0 : 1.0 - (distance / maxLen);

  // 预处理字符集合 (用于 Dice 和 Overlap)
  const set1 = new Set(s1.replace(RE_WHITESPACE, ''));
  const set2 = new Set(s2.replace(RE_WHITESPACE, ''));
  const size1 = set1.size;
  const size2 = set2.size;

  if (size1 === 0 || size2 === 0) return 0.0;

  let intersection = 0;
  const [smallerSet, largerSet] = size1 < size2 ? [set1, set2] : [set2, set1];
  for (const char of smallerSet) {
    if (largerSet.has(char)) intersection++;
  }

  // Dice 系数
  const diceScore = (2.0 * intersection) / (size1 + size2);

  // Overlap 系数
  let overlapScore = 0;
  const minSize = Math.min(size1, size2);
  if (minSize > 2) {
      overlapScore = intersection / minSize;
      
      // 覆盖率高但长度差异大时略微扣分
      if (overlapScore > 0.6) {
          const sizeRatio = minSize / Math.max(size1, size2);
          if (sizeRatio < 0.6) {
              overlapScore -= 0.25;
          }
      }
  }

  return Math.max(editScore, diceScore, overlapScore);
}

/**
 * 检测主副标题结构冲突
 * @param {string} titleA 标题A
 * @param {string} titleB 标题B
 * @param {boolean} isDateValid 日期是否有效
 * @returns {boolean} 是否存在结构冲突
 */
function checkTitleSubtitleConflict(titleA, titleB, isDateValid = true) {
    if (!titleA || !titleB) return false;

    // 豁免：clean 后一致
    if (cleanTitleForSimilarity(titleA) === cleanTitleForSimilarity(titleB)) {
        return false;
    }

    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str);
		s = s.replace(RE_META_SUFFIX, '');
        s = s.replace(RE_YEAR_TAG, '');
        s = s.replace(RE_SOURCE_TAG, '');
        s = s.replace(RE_FROM_SUFFIX, '');
        s = s.replace(RE_WHITESPACE, ' '); // 标准化空格
        return s.trim().toLowerCase();
    };

    const t1 = lightClean(titleA);
    const t2 = lightClean(titleB);

    if (t1 === t2) return false;

    const extractSubtitle = (fullTitle) => {
       const splitters = [':', '：', ' code:', ' code：', ' season', ' part'];
       for (const sep of splitters) {
           const idx = fullTitle.indexOf(sep);
           if (idx !== -1) return fullTitle.substring(idx).trim();
       }
       // 依赖空格分割
       const spaceParts = fullTitle.split(RE_WHITESPACE);
       if (spaceParts.length >= 2) {
           return spaceParts.slice(1).join(' ');
       }
       return null;
    };

    const sub1 = extractSubtitle(t1);
    const sub2 = extractSubtitle(t2);

    const [short, long] = t1.length < t2.length ? [t1, t2] : [t2, t1];

    // 检查长标题是否包含短标题作为前缀，并跟随特定分隔符
    if (long.startsWith(short)) {
        if (long.length === short.length) return false;

        const nextChar = long[short.length];
        
        if (RE_SUBTITLE_SEPARATOR.test(nextChar)) {
             const subtitle = long.slice(short.length).replace(RE_SUBTITLE_SEPARATOR, '').trim();
             if (!isDateValid && subtitle.length > 1) {
                 return true;
             }
             if (subtitle.length > 2) {
                 // 如果副标题只是 "Part 2" 则在后续 Tier 处理，这里先标记为冲突
                 return true;
             }
        }
    }
    
    // 双副标题差异检测
    if (sub1 && sub2) {
        const sim = calculateDiceSimilarity(sub1, sub2);
        if (sim < 0.2) {
            return true;
        }
    }

    return false;
}

/**
 * 提取标题和类型中的季度/类型标识
 * 针对复杂命名规则进行特征提取，区分确定性标记与歧义标记
 * @param {string} title 标题
 * @param {string} typeDesc 类型描述
 * @returns {Set<string>} 标识集合 (如 'S1', 'S2', 'AMBIGUOUS', 'MOVIE')
 */
function extractSeasonMarkers(title, typeDesc = '') {
  const markers = new Set();
  const t = cleanText(title); 
  const type = cleanText(typeDesc || '');

  // 临时移除 Part 信息，防止 Part 数字干扰末尾季数检测
  const tWithoutParts = t.replace(RE_PART_ANY, '');

  // 起承转结 (Qi-Cheng-Zhuan-Jie) 结构检测 匹配模式：空格/开头/x数字 后接 承/转/结，且后面是结束或分隔符
  // 例子: "无头骑士异闻录×2 承" -> S2, "×2 转" -> S3, "×2 结" -> S4
  const structMatch = tWithoutParts.match(RE_CN_STRUCTURE);
  if (structMatch) {
      const char = structMatch[1];
      if (char === '承') markers.add('S2');
      else if (char === '转') markers.add('S3');
      else if (char === '结') markers.add('S4');
  }

  // 1. 标准数字季数检测 (Season 2, 第2季)
  SEASON_PATTERNS.forEach(p => {
    const targetText = p.useCleaned ? tWithoutParts : t;
    const match = targetText.match(p.regex);
    if (match) {
      if (p.prefix) {
        markers.add(`${p.prefix}${parseInt(match[1])}`);
      } else {
        markers.add(p.val);
      }
    }
  });

  // 2. 检测特定复杂后缀 (高优先级，直接映射到 S2/S3/S4)
  let hitSpecific = false;
  for (const item of RE_SUFFIX_SPECIFIC_MAP) {
      if (item.regex.test(tWithoutParts)) {
          markers.add(item.val);
          hitSpecific = true;
          break; // 命中一个具体后缀后停止，避免重叠
      }
  }

  // 3. 检测歧义后缀 (S, T, R...)
  // 只有在未命中特定后缀时才检测，避免 SuperS 被拆解为 Super + S
  if (!hitSpecific) {
      const ambMatch = tWithoutParts.match(RE_SUFFIX_AMBIGUOUS);
      if (ambMatch) {
          // 不再硬性映射为 S2，而是标记为 AMBIGUOUS
          // 让后续逻辑允许它与 S2, S3, S4 尝试匹配，依靠集探测定夺
          markers.add('AMBIGUOUS');
          
          // 针对 II, III, IV 这种罗马数字，依然可以保留明确的季数含义以辅助判断
          const suffix = ambMatch[1].toUpperCase();
          if (suffix === 'II') markers.add('S2');
          if (suffix === 'III') markers.add('S3');
          if (suffix === 'IV') markers.add('S4');
      }
  }

  // 4. 续篇标识
  if (RE_SUFFIX_SEQUEL.test(t) || type.includes('续篇')) {
      markers.add('SEQUEL');
  }

  // 5. 类型检测
  if (type.includes('剧场版') || type.includes('movie') || type.includes('film') || type.includes('电影')) markers.add('MOVIE');
  if (type.includes('ova') || type.includes('oad')) markers.add('OVA');
  if (type.includes('sp') || type.includes('special')) markers.add('SP');

  // 6. 中文数字季数检测
  const cnNums = {'一':1, '二':2, '三':3, '四':4, '五':5, 'final': 99};
  for (const [cn, num] of Object.entries(cnNums)) {
    if (t.includes(`第${cn}季`)) markers.add(`S${num}`);
  }

  // 7. 默认 S1 补全逻辑
  const hasSeason = Array.from(markers).some(m => m.startsWith('S'));
  const hasPart = Array.from(markers).some(m => m.startsWith('P'));
  const hasAmbiguous = markers.has('AMBIGUOUS');
  const hasSequel = markers.has('SEQUEL');

  // 如果有 Part 但没有 Season，默认视为 S1
  // 这防止 "Part 2" 误匹配 "Season 2" (确保它们产生 S1 vs S2 冲突)
  if (hasPart && !hasSeason) {
      markers.add('S1');
  }

  // 如果没有明确的 S 标记，也没有歧义标记和续篇标记，且不是剧场版/OVA，则默认为 S1
  const isTypeSpecial = markers.has('MOVIE') || markers.has('OVA') || markers.has('SP');
  
  if (!hasSeason && !hasPart && !hasAmbiguous && !hasSequel && !isTypeSpecial) {
      markers.add('S1');
  }

  return markers;
}

/**
 * 辅助：从标题中提取明确的季度编号 (1, 2, 3...)
 * 基于 extractSeasonMarkers 的逻辑，优先返回最大的 S 值
 * @param {string} title 
 * @param {string} typeDesc 
 * @returns {number|null} 季度编号
 */
function getSeasonNumber(title, typeDesc = '') {
    const markers = extractSeasonMarkers(title, typeDesc);
    let maxSeason = null;
    for (const m of markers) {
        if (m.startsWith('S')) {
            const num = parseInt(m.substring(1));
            if (!isNaN(num)) {
                if (maxSeason === null || num > maxSeason) {
                    maxSeason = num;
                }
            }
        }
    }
    return maxSeason;
}

/**
 * 获取严格的媒体类型标识
 * 仅用于区分 'MOVIE' 和 'TV'
 * @param {string} title 标题
 * @param {string} typeDesc 类型描述
 * @returns {string|null} 类型 ('MOVIE' | 'TV' | null)
 */
function getStrictMediaType(title, typeDesc) {
    const fullText = (title + ' ' + (typeDesc || '')).toLowerCase();
    
    const hasMovie = fullText.includes('电影');
    const hasTV = fullText.includes('电视剧');

    if (hasMovie && !hasTV) return 'MOVIE';
    if (hasTV && !hasMovie) return 'TV';
    return null;
}

/**
 * 获取内容分类 (真人/动漫)
 * 用于解决真人剧与动漫的合并冲突
 * @param {string} title 标题
 * @param {string} typeDesc 类型描述
 * @param {string} source 来源
 * @returns {string} 分类 ('REAL' | 'ANIME' | 'UNKNOWN')
 */
function getContentCategory(title, typeDesc, source) {
    if (source && RE_ANIMEKO_SOURCE.test(source)) {
        return 'ANIME';
    }

    const fullText = (title + ' ' + (typeDesc || '')).toLowerCase();

    if (RE_ANIME_KW.test(fullText)) return 'ANIME';
    if (RE_REAL_KW.test(fullText)) return 'REAL';

    return 'UNKNOWN';
}

/**
 * 检查是否满足“剧场版”结构豁免条件
 * 增加对纯季度/Part标记的阻断
 * @param {string} titleA 标题A
 * @param {string} titleB 标题B
 * @param {string} typeDescA 类型A
 * @param {string} typeDescB 类型B
 * @returns {boolean} 是否豁免
 */
function checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB) {
    const isTheatrical = (typeDescA || '').includes('剧场版') || (typeDescB || '').includes('剧场版');
    if (!isTheatrical) return false;

    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str);
        s = s.replace(RE_YEAR_TAG, '');
        s = s.replace(RE_SOURCE_TAG, '');
        s = s.replace(RE_FROM_SUFFIX, '');
        return s.trim();
    };

    const t1 = lightClean(titleA);
    const t2 = lightClean(titleB);

    if (RE_SPACE_STRUCTURE.test(t1) && RE_SPACE_STRUCTURE.test(t2)) {
        // 检查副标题是否仅仅是 Part/Season，如果是则不予豁免
        const extractSub = (s) => {
            const parts = s.split(RE_SPLIT_SPACES);
            return parts.length > 1 ? parts.slice(1).join(' ') : '';
        };

        const sub1 = extractSub(t1);
        const sub2 = extractSub(t2);

        if (REGEX_PURE_SEASON_PART.test(sub1) || REGEX_PURE_SEASON_PART.test(sub2)) {
            return false;
        }

        return true;
    }

    return false;
}

/**
 * 校验媒体类型是否冲突
 * @param {string} titleA 
 * @param {string} titleB 
 * @param {string} typeDescA 
 * @param {string} typeDescB 
 * @param {number} countA 集数A
 * @param {number} countB 集数B
 * @param {string} sourceA 来源A
 * @param {string} sourceB 来源B
 * @returns {boolean} 是否冲突 (true: 冲突, false: 无冲突)
 */
function checkMediaTypeMismatch(titleA, titleB, typeDescA, typeDescB, countA, countB, sourceA = '', sourceB = '') {
    // 优先检测 真人剧 vs 动漫
    const catA = getContentCategory(titleA, typeDescA, sourceA);
    const catB = getContentCategory(titleB, typeDescB, sourceB);

    if ((catA === 'REAL' && catB === 'ANIME') || (catA === 'ANIME' && catB === 'REAL')) {
        return true;
    }

    const mediaA = getStrictMediaType(titleA, typeDescA);
    const mediaB = getStrictMediaType(titleB, typeDescB);

    if (!mediaA || !mediaB || mediaA === mediaB) return false;

    if (checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB)) {
        return false;
    }

    const hasValidCounts = countA > 0 && countB > 0;

    if (hasValidCounts) {
        const diff = Math.abs(countA - countB);
        if (diff > 5) {
            return true;
        }
        return false;
    }

    return true; 
}

/**
 * 校验季度/续作标记是否冲突
 * 包含针对 AMBIGUOUS 歧义标记的宽容处理逻辑
 * @param {string} titleA 标题A
 * @param {string} titleB 标题B
 * @param {string} typeA 类型A
 * @param {string} typeB 类型B
 * @returns {boolean} 是否冲突
 */
function checkSeasonMismatch(titleA, titleB, typeA, typeB) {
  const markersA = extractSeasonMarkers(titleA, typeA);
  const markersB = extractSeasonMarkers(titleB, typeB);

  if (markersA.size === 0 && markersB.size === 0) return false;

  const hasS2OrMore = (set) => Array.from(set).some(m => m.startsWith('S') && parseInt(m.substring(1)) >= 2);
  const hasSequel = (set) => set.has('SEQUEL');
  const hasAmbiguous = (set) => set.has('AMBIGUOUS');
  const hasS1 = (set) => set.has('S1');

  if (markersA.size > 0 && markersB.size > 0) {
    // 显式冲突检测：AMBIGUOUS (代表S2/S3/续作) 与 S1 绝对互斥
    // 之前的逻辑因为 AMBIGUOUS 不以 'S' 开头，导致跳过了循环检查，从而让 "中配版(S1)" 漏网
    if ((hasAmbiguous(markersA) && hasS1(markersB)) ||
        (hasAmbiguous(markersB) && hasS1(markersA))) {
        return true;
    }

    // 歧义后缀豁免：如果任意一方包含 AMBIGUOUS，且另一方包含 S2+ 或 Sequel，则不再判定为硬性冲突
    // 这允许 "小林S" (Ambiguous) 匹配 "小林S2" 或 "小林续篇"
    if ((hasAmbiguous(markersA) && (hasS2OrMore(markersB) || hasSequel(markersB))) ||
        (hasAmbiguous(markersB) && (hasS2OrMore(markersA) || hasSequel(markersA)))) {
        return false; 
    }

    // 兼容 "S2+" 与 "SEQUEL"
    if ((hasS2OrMore(markersA) && hasSequel(markersB)) || (hasS2OrMore(markersB) && hasSequel(markersA))) {
        return false;
    }

    // 标准冲突检测 (针对 S1, S2, S3 等明确数字标记)
    for (const m of markersA) {
        if (m.startsWith('S')) {
            const hasSameS = markersB.has(m);
            const bHasAnyS = Array.from(markersB).some(b => b.startsWith('S'));
            // 如果 A 有 S标记 (如 S2)，但 B 没有这个标记且 B 有其他 S标记 (如 S1)，则冲突
            if (!hasSameS && bHasAnyS) {
                return true;
            }
        }
    }
    return false; 
  }

  // 如果集合大小不同，可能存在包含关系或漏标，进行剧场版豁免检查
  if (markersA.size !== markersB.size) {
      if (checkTheatricalExemption(titleA, titleB, typeA, typeB)) {
          return false;
      }
      return true;
  }

  return false;
}

/**
 * 检查两个标题是否包含相同的季度/季数标记
 * 用于豁免逻辑
 * @param {string} titleA 
 * @param {string} titleB 
 * @param {string} typeA 
 * @param {string} typeB 
 * @returns {boolean} 
 */
function hasSameSeasonMarker(titleA, titleB, typeA, typeB) {
  const markersA = extractSeasonMarkers(titleA, typeA);
  const markersB = extractSeasonMarkers(titleB, typeB);

  const seasonsA = Array.from(markersA).filter(m => m.startsWith('S'));
  const seasonsB = Array.from(markersB).filter(m => m.startsWith('S'));

  if (seasonsA.length > 0 && seasonsB.length > 0) {
    return seasonsA.some(sa => seasonsB.includes(sa));
  }
  return false;
}

/**
 * 校验日期匹配度
 * 包含针对配音版(Dub)的年份豁免逻辑
 * @param {Object} dateA 日期A
 * @param {Object} dateB 日期B
 * @param {boolean} [isDub=false] 是否为配音版本（配音版允许较大的年份差异）
 * @returns {number} 匹配分数 (-1 表示硬性不匹配, 0 表示中性, >0 表示加分)
 */
function checkDateMatch(dateA, dateB, isDub = false) {
  if (!dateA.year || !dateB.year) return 0.05;
  const yearDiff = dateA.year - dateB.year; // 有符号差值

  // 如果年份完全相同
  if (yearDiff === 0) {
    if (dateA.month && dateB.month) {
      const monthDiff = Math.abs(dateA.month - dateB.month);
      if (monthDiff > 2) return 0;
      return monthDiff === 0 ? 0.2 : 0.1;
    }
    return 0.1;
  }

  const absDiff = Math.abs(yearDiff);

  // 配音版豁免逻辑
  // 如果是配音版，允许最大 10 年的误差，不扣分
  if (isDub) {
      if (absDiff <= 10) {
          return 0; 
      }
  }

  // 常规逻辑：超过1年即视为严重不匹配
  if (absDiff > 1) return -1;

  return 0;
}

/**
 * 验证合并覆盖率是否合规
 * 防止剧场版误匹配TV版等低覆盖率情况
 * 增加 isAnyCollection 参数，放宽合集匹配的比例限制
 * @param {number} mergedCount 成功匹配集数
 * @param {number} totalA 主源总集数
 * @param {number} totalB 副源总集数
 * @param {string} sourceA 主源名称
 * @param {string} sourceB 副源名称
 * @param {boolean} isAnyCollection 是否涉及合集
 * @returns {boolean} 是否合规
 */
function isMergeRatioValid(mergedCount, totalA, totalB, sourceA, sourceB, isAnyCollection = false) {
    if (sourceA === 'animeko' || sourceB === 'animeko') {
        return true; // 豁免 animeko (可能包含未放送集)
    }

    if (isAnyCollection) {
        // 合集逻辑：只要匹配了较短方（单季）的大部分内容，即视为通过
        const minTotal = Math.min(totalA, totalB);
        if (minTotal > 0 && (mergedCount / minTotal) > 0.5) return true;
        
        // 兜底：如果总数很大但匹配很少，或者完全不匹配，还是拦截
        if (mergedCount < 2) return false;
        return true; 
    }

    const maxTotal = Math.max(totalA, totalB);
    if (maxTotal === 0) return false;

    const ratio = mergedCount / maxTotal;

    if (maxTotal > 5 && ratio < 0.18) {
        return false;
    }
    
    return true;
}

/**
 * 在当前副源列表中，检测是否存在基于上下文的续作关系
 * 如果列表中同时存在 "Title" 和 "Title S"，则 "Title S" 被认定为 Ambiguous Sequel
 * @param {Array} secondaryList 副源动画列表
 * @returns {Map<string, string>} 返回 { animeId -> baseTitle } 的 Map，命中ID即为续作
 */
function detectPeerContextSequels(secondaryList) {
    const contextMap = new Map();
    if (!secondaryList || secondaryList.length < 2) return contextMap;

    // 预处理所有标题
    const items = secondaryList.map(item => {
        const raw = item.animeTitle || '';
        const clean = cleanText(raw).replace(RE_SOURCE_TAG, '').replace(RE_FROM_SUFFIX, '').trim();
        return { id: item.animeId, raw, clean };
    });

    // 建立基准标题集合
    const baseTitles = new Set(items.map(i => i.clean));

    for (const item of items) {
        let baseCandidate = null;

        // 1. 优先检测特定后缀 (如 A's, StrikerS)
        for (const mapItem of RE_SUFFIX_SPECIFIC_MAP) {
            const m = item.clean.match(mapItem.regex);
            if (m) {
                baseCandidate = item.clean.replace(mapItem.regex, '').trim();
                break;
            }
        }

        // 2. 如果没命中特定后缀，检测歧义后缀 (S, T, R, II...)
        if (!baseCandidate) {
            const m = item.clean.match(RE_SUFFIX_AMBIGUOUS);
            if (m) {
                const suffix = m[1];
                if (item.clean.endsWith(suffix)) {
                    baseCandidate = item.clean.substring(0, item.clean.length - suffix.length).trim();
                }
            }
        }

        if (baseCandidate) {
            // 只有当剥离后缀后的 Base Title 也存在于同列表中时，才判定为续作
            if (baseCandidate.length > 1 && baseTitles.has(baseCandidate)) {
                contextMap.set(String(item.id), baseCandidate);
                log("info", `[Merge-Check] 上下文感知: 判定 [${item.raw}] 为续作 (Base: "${baseCandidate}" 同时也存在于列表)`);
            }
        }
    }

    return contextMap;
}

/**
 * 探测集内容匹配情况 (深度检测)
 * 通过抽样对比集标题，判断是否强匹配或强不匹配
 * @param {Object} primaryAnime 主源动画
 * @param {Object} candidateAnime 候选动画
 * @returns {Object} { isStrongMatch: boolean, isStrongMismatch: boolean }
 */
function probeContentMatch(primaryAnime, candidateAnime) {
    const result = { isStrongMatch: false, isStrongMismatch: false };
    
    if (!primaryAnime.links || !candidateAnime.links) return result;
    if (primaryAnime.links.length === 0 || candidateAnime.links.length === 0) return result;

    // 1. 集数量探测 (过滤掉番外)
    const countEpisodes = (links) => {
        return links.filter(l => {
            const t = (l.title || l.name || '').toLowerCase();
            return !RE_PV_CHECK.test(t) && !RE_SPECIAL_CHECK.test(t);
        }).length;
    };
    
    const countP = countEpisodes(primaryAnime.links);
    const countS = countEpisodes(candidateAnime.links);
    
    // 如果两边都有较多集数，且数量差异巨大（如 12 vs 24），视为负面参考
    if (countP > 5 && countS > 5) {
        const ratio = Math.min(countP, countS) / Math.max(countP, countS);
        if (ratio < 0.4) { 
             // 不直接判定 Mismatch，需结合集标题进一步确认
        }
    }

    // 2. 集标题探测 (必须语言一致)
    const getEpTitles = (links) => links.map(l => {
        const t = cleanEpisodeText(l.title || l.name || '');
        return t.replace(/\d+/g, '').trim(); // 移除数字，只比对文本
    }).filter(t => t.length > 1);

    const titlesP = getEpTitles(primaryAnime.links);
    const titlesS = getEpTitles(candidateAnime.links);

    if (titlesP.length < 3 || titlesS.length < 3) return result;

    const langP = getLanguageType(titlesP.join(' '));
    const langS = getLanguageType(titlesS.join(' '));

    if (langP !== langS || langP === 'Unspecified') return result;

    // 抽样对比 (最多5个)
    const sampleSize = Math.min(titlesP.length, titlesS.length, 5);
    let matchHits = 0;
    let mismatchHits = 0;
    let logSamples = [];

    for (let i = 0; i < sampleSize; i++) {
        // 简单按索引对齐采样
        const idxP = Math.floor(i * titlesP.length / sampleSize);
        const idxS = Math.floor(i * titlesS.length / sampleSize);
        
        const tp = titlesP[idxP];
        const ts = titlesS[idxS];
        
        const sim = calculateSimilarity(tp, ts);
        
        if (i < 3) {
            logSamples.push(`"${tp}" vs "${ts}" (${sim.toFixed(2)})`);
        }

        if (sim > 0.6) matchHits++;
        else if (sim < 0.3) mismatchHits++;
    }

    if (matchHits >= Math.ceil(sampleSize * 0.6)) {
        result.isStrongMatch = true;
        log("info", `[Merge-Check] [Probe] 采样对比 (Match): ${logSamples.join(', ')}`);
    } else if (mismatchHits >= Math.ceil(sampleSize * 0.8)) {
        result.isStrongMismatch = true;
        log("info", `[Merge-Check] [Probe] 采样对比 (Mismatch): ${logSamples.join(', ')}`);
    }

    return result;
}

/**
 * 在副源列表中寻找最佳匹配的动画对象列表
 * 包含上下文感知、集内容探测、中配优先等复杂逻辑
 * @param {Object} primaryAnime 主源动画对象
 * @param {Array} secondaryList 副源动画列表
 * @param {Set<string>} collectionAnimeIds 已识别的合集 ID 集合
 * @returns {Array} 匹配的动画对象列表（已按分数排序）
 */
export function findSecondaryMatches(primaryAnime, secondaryList, collectionAnimeIds = new Set()) {
  if (!secondaryList || secondaryList.length === 0) return [];

  const rawPrimaryTitle = primaryAnime.animeTitle || '';
  
  // 预处理主标题
  let primaryTitleForSim = rawPrimaryTitle.replace(RE_YEAR_TAG, '');
  primaryTitleForSim = primaryTitleForSim.replace(/【(电影|电视剧)】/g, '').trim();

  // 检测主源是否为中配 (RE_CN_DUB_VER 是 global，使用 match 避免 lastIndex 问题)
  const isPrimaryDub = !!(primaryTitleForSim.match(RE_CN_DUB_VER)) || RE_LANG_CN.test(primaryTitleForSim);

  // 针对 hanjutv 源进行年份忽略处理，视为无效日期
  const isPrimaryIgnoredYear = primaryAnime.source === 'hanjutv';
  const primaryDate = (rawPrimaryTitle.includes('N/A') || isPrimaryIgnoredYear) ? { year: null, month: null } : parseDate(primaryAnime.startDate);
  
  const primaryCount = primaryAnime.episodeCount || (primaryAnime.links ? primaryAnime.links.length : 0);
  const primaryLang = getLanguageType(rawPrimaryTitle);

  let validCandidates = [];
  let maxScore = 0;

  const logReason = (secTitle, reason) => {
      log("info", `[Merge-Check] 拒绝: [${primaryAnime.source}] ${rawPrimaryTitle} vs [${secTitle}] -> ${reason}`);
  };

  const primaryCleanForZhi = cleanText(primaryTitleForSim);
  const cleanPrimarySim = cleanTitleForSimilarity(primaryTitleForSim);
  const baseA = removeParentheses(primaryTitleForSim);

  // 检查主源是否为合集 (Collection)
  const isPrimaryCollection = collectionAnimeIds.has(primaryAnime.animeId);

  // 上下文感知：预先标记副源列表中的Ambiguous Sequels
  // 将主源也加入检测池，判断主源是否为列表内某条目的续作
  // 这解决了 "小林家的龙女仆S" (主源) 匹配 "小林家的龙女仆" (副源/Base) 的问题
  const combinedForContext = [{ animeId: primaryAnime.animeId, animeTitle: rawPrimaryTitle }, ...secondaryList];
  const ambiguousSequelsMap = detectPeerContextSequels(combinedForContext);
  
  const isPrimaryContextSequel = ambiguousSequelsMap.has(String(primaryAnime.animeId));
  const primaryBaseTitleFromContext = ambiguousSequelsMap.get(String(primaryAnime.animeId));

  for (const secAnime of secondaryList) {
    const rawSecTitle = secAnime.animeTitle || '';

    // 检查副源是否为合集
    const isSecCollection = collectionAnimeIds.has(secAnime.animeId);
    // 只要任意一方是合集，则启用“合集豁免”模式
    const isAnyCollection = isPrimaryCollection || isSecCollection;

    // 针对 hanjutv 源进行年份忽略处理，视为无效日期
    const isSecIgnoredYear = secAnime.source === 'hanjutv';
    const secDate = (rawSecTitle.includes('N/A') || isSecIgnoredYear) ? { year: null, month: null } : parseDate(secAnime.startDate);

    const secLang = getLanguageType(rawSecTitle);
    let secTitleForSim = rawSecTitle.replace(RE_YEAR_TAG, '');
    secTitleForSim = secTitleForSim.replace(/【(电影|电视剧)】/g, '').trim();

    // 检测副源是否为中配
    const isSecDub = !!(secTitleForSim.match(RE_CN_DUB_VER)) || RE_LANG_CN.test(secTitleForSim);
    
    // 只要任意一方是配音版，即视为配音关系，启用宽容日期检查
    const isDubRelation = isPrimaryDub || isSecDub;

    const secCount = secAnime.episodeCount || (secAnime.links ? secAnime.links.length : 0);
    
    // 之字结构强阻断：主标题是副标题的前缀父集
    if (secTitleForSim.includes('之')) {
        const parts = secTitleForSim.split('之');
        const prefix = cleanText(parts[0]); 
        if (primaryCleanForZhi === prefix) {
            logReason(rawSecTitle, `结构冲突: 主标题是副标题的前缀父集 (Prefix: "${prefix}")`);
            continue;
        }
    }

    // 严格媒体类型冲突
    if (checkMediaTypeMismatch(rawPrimaryTitle, rawSecTitle, primaryAnime.typeDescription, secAnime.typeDescription, primaryCount, secCount, primaryAnime.source, secAnime.source)) {
        const pType = getContentCategory(rawPrimaryTitle, primaryAnime.typeDescription, primaryAnime.source);
        const sType = getContentCategory(rawSecTitle, secAnime.typeDescription, secAnime.source);
        logReason(rawSecTitle, `媒体类型不匹配 (P:${pType}/${getStrictMediaType(rawPrimaryTitle, primaryAnime.typeDescription)} vs S:${sType}/${getStrictMediaType(rawSecTitle, secAnime.typeDescription)})`);
        continue;
    }

    const isDateValid = (primaryDate.year !== null && secDate.year !== null);
    const hasStructureConflict = checkTitleSubtitleConflict(rawPrimaryTitle, rawSecTitle, isDateValid);

    // 上下文 Sequel 阻断逻辑
    const isAmbiguousSequel = ambiguousSequelsMap.has(String(secAnime.animeId));
    
    // 1. 副源是续作，而主源是前作 -> 阻断
    if (isAmbiguousSequel) {
        const baseTitleOfSec = ambiguousSequelsMap.get(String(secAnime.animeId));
        
        if (cleanPrimarySim === cleanTitleForSimilarity(baseTitleOfSec)) {
             // 再次确认：除非主源自己也有类似的后缀
             const primaryHasSuffix = RE_SUFFIX_AMBIGUOUS.test(primaryCleanForZhi) || RE_SUFFIX_SPECIFIC_MAP.some(x => x.regex.test(primaryCleanForZhi));
             
             if (!primaryHasSuffix) {
                 logReason(rawSecTitle, `上下文阻断: 主源(S1) vs 副源(S2/S续作) (Base: "${baseTitleOfSec}")`);
                 continue;
             }
        }
    }
    
    // 2. 主源是续作，而副源是前作 -> 阻断
    // 即使 checkSeasonMismatch 豁免了 S1，这里也会基于上下文进行强制拦截
    if (isPrimaryContextSequel) {
         if (cleanTitleForSimilarity(secTitleForSim) === cleanTitleForSimilarity(primaryBaseTitleFromContext)) {
             logReason(rawSecTitle, `上下文阻断: 主源(S2/Sequel) vs 副源(Base/S1) (Base: "${primaryBaseTitleFromContext}")`);
             continue;
         }
    }

    if (!isDateValid && hasStructureConflict) {
        logReason(rawSecTitle, `标题结构冲突且日期无效 (HasConflict=true, DateValid=false)`);
        continue;
    }

    const isSeasonExactMatch = hasSameSeasonMarker(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription);

    // 提前计算集内容匹配度 (Probe Content Match)
    const contentProbe = probeContentMatch(primaryAnime, secAnime);

    // 标题级剧场版阻断 (Standalone Movie vs Season 1/2/3...)
    // 逻辑：如果一方明确是剧场版标题（且无副标题），另一方是普通S，且去除“剧场版”后标题一致，则阻断。
    // 豁免：续篇 (Sequel)，因为部分剧场版其实是TV续篇。
    const hasMovieA = rawPrimaryTitle.search(RE_MOVIE_KEYWORDS) !== -1;
    const hasMovieB = rawSecTitle.search(RE_MOVIE_KEYWORDS) !== -1;

    if (hasMovieA !== hasMovieB) {
        const markersB = extractSeasonMarkers(rawSecTitle, secAnime.typeDescription);
        const markersA = extractSeasonMarkers(rawPrimaryTitle, primaryAnime.typeDescription);
        
        // 1. 尝试剥离电影关键词，检查Base Title是否一致
        const stripMovie = (t) => cleanTitleForSimilarity(t.replace(RE_MOVIE_KEYWORDS, ''));
        const cleanA = stripMovie(rawPrimaryTitle);
        const cleanB = stripMovie(rawSecTitle);
        
        // 如果去除“剧场版”字样后，两者标题高度一致，说明触发了同名冲突
        if (calculateSimilarity(cleanA, cleanB) > 0.9) {
            const hasSequelA = markersA.has('SEQUEL');
            const hasSequelB = markersB.has('SEQUEL');

            // 2. 如果双方都没有宣称是“续篇”，则认定为“独立剧场版”撞上了“TV版”，予以阻断
            // 只要有一方是续篇（如Watanare），则允许匹配
            if (!hasSequelA && !hasSequelB) {
                logReason(rawSecTitle, `剧场版标题阻断: [${hasMovieA ? 'Movie' : 'TV'}] vs [${hasMovieB ? 'Movie' : 'TV'}] (无续篇标识，强制隔离同名Movie与TV)`);
                continue;
            }
        }
    }

    // 日期检查 (传入 isDubRelation 参数)
    // 如果是合集，豁免日期检查
    const dateScore = isAnyCollection ? 0 : checkDateMatch(primaryDate, secDate, isDubRelation);
    
    // 日期严重不匹配处理
    if (dateScore === -1) {
        let allowExemption = isSeasonExactMatch;
        // 如果内容探测强匹配，强制豁免日期错误
        if (contentProbe.isStrongMatch) allowExemption = true;
        // 如果是合集，强制豁免
        if (isAnyCollection) allowExemption = true;

        if (hasStructureConflict && !isAnyCollection) {
            allowExemption = false; // 结构冲突下取消日期豁免 (除非是合集)
        }

        if (allowExemption && primaryDate.year && secDate.year) {
             const yearDiff = Math.abs(primaryDate.year - secDate.year);
             // 仅当Probe强匹配时，允许 >2 年的差异
             // 除非是合集，合集允许大跨度
             if (yearDiff > 2 && !contentProbe.isStrongMatch && !isAnyCollection) {
                 allowExemption = false;
             }
        }
        
        if (!allowExemption) {
            logReason(rawSecTitle, `日期严重不匹配且无豁免 (P:${primaryDate.year} vs S:${secDate.year}, IsDub:${isDubRelation}, StrongProbe:${contentProbe.isStrongMatch})`);
            continue;
        }
    }

    // 季度冲突检查 (支持探测越狱)
    // 如果是合集，豁免季度冲突
    if (!isAnyCollection && checkSeasonMismatch(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription)) {
        if (contentProbe.isStrongMatch) {
            log("info", `[Merge-Check] 季度冲突豁免: [${rawPrimaryTitle}] vs [${rawSecTitle}] (检测到集内容强匹配，无视标题季度差异)`);
        } else {
            logReason(rawSecTitle, `季度标记冲突`);
            continue; 
        }
    }

    // 核心相似度计算
    let scoreFull = calculateSimilarity(primaryTitleForSim, secTitleForSim);
    
    const baseB = removeParentheses(secTitleForSim);
    let scoreBase = calculateSimilarity(baseA, baseB);

    let score = Math.max(scoreFull, scoreBase);
    const originalScore = score;
    
    if (hasStructureConflict) {
        score -= 0.15;
    }

    if (dateScore !== -1) {
        score += dateScore;
    }

    // 语言优先逻辑
    const isPrimaryCn = (primaryLang === 'CN');
    const isSecCn = (secLang === 'CN');

    if (isPrimaryCn && isSecCn) {
        score += 0.15;
    } else if (isPrimaryCn !== isSecCn) {
        score -= 0.20;
    }

    // 应用 Probe 结果调整分数
    if (contentProbe.isStrongMatch) {
        log("info", `[Merge-Check] 集内容探测: 强匹配! 提升分数 (原分: ${score.toFixed(2)}) -> 0.98`);
        score = Math.max(score, 0.98);
    } else if (contentProbe.isStrongMismatch) {
        logReason(rawSecTitle, `集内容探测: 强不匹配 (集标题/内容差异巨大)`);
        score = 0; // Force Kill
    }

    if (score < 0.6) {
        const cleanA = cleanPrimarySim;
        const cleanB = cleanTitleForSimilarity(secTitleForSim);
        logReason(rawSecTitle, `相似度不足: ${score.toFixed(2)} (Raw:${originalScore.toFixed(2)}, CleanA:"${cleanA}", CleanB:"${cleanB}")`);
    } else {
        if (score > maxScore) maxScore = score;
        
        validCandidates.push({
            anime: secAnime,
            score: score,
            lang: secLang,
            debugTitle: rawSecTitle
        });
        
        log("info", `[Merge-Check] 候选选中: ${rawSecTitle} Score=${score.toFixed(2)} (BestSoFar=${maxScore.toFixed(2)})`);
    }
  }

  if (validCandidates.length === 0 || maxScore < 0.6) return [];

  // ==========================================
  // 高分梯队筛选 (Score Tier Filtering)
  // 解决 Winner-Takes-All，允许中配版或Part分部并存
  // ==========================================
  
  const TIER_TOLERANCE_DEFAULT = 0.001;
  const TIER_TOLERANCE_CN = 0.40;
  const TIER_TOLERANCE_PART = 0.50;

  const markersP = extractSeasonMarkers(rawPrimaryTitle, primaryAnime.typeDescription);
  const seasonsP = Array.from(markersP).filter(m => m.startsWith('S'));

  const finalResults = validCandidates.filter(candidate => {
      // 1. 最高分入选
      const isTopScore = candidate.score >= (maxScore - TIER_TOLERANCE_DEFAULT);
      if (isTopScore) return true;

      // 2. 高分中配入选
      const isHighTierCn = (candidate.lang === 'CN') && (candidate.score >= (maxScore - TIER_TOLERANCE_CN));
      if (isHighTierCn) return true;

      // 3. Part 分部入选
      const markersC = extractSeasonMarkers(candidate.debugTitle, candidate.anime.typeDescription);
      const hasPart = Array.from(markersC).some(m => m.startsWith('P'));
      
      if (hasPart && (candidate.score >= (maxScore - TIER_TOLERANCE_PART))) {
          const seasonsC = Array.from(markersC).filter(m => m.startsWith('S'));
          if (seasonsP.length > 0 && seasonsC.length > 0) {
              const hasIntersection = seasonsP.some(sp => seasonsC.includes(sp));
              if (hasIntersection) return true;
          } else {
              return true; 
          }
      }

      return false;
  });

  finalResults.sort((a, b) => b.score - a.score);

  return finalResults.map(item => item.anime);
}

/**
 * 提取集数信息
 * 包含严格番外检测和来源标签识别
 * @param {string} title 集标题
 * @param {string} sourceName 来源名称
 * @returns {Object} 集信息对象 { isMovie, num, isSpecial, isPV, season, isStrictSpecial }
 */
function extractEpisodeInfo(title, sourceName = '') {
  let isStrictSpecial = false;
  
  // 优先从标题标签中识别真实来源
  let effectiveSource = sourceName;
  if (title) {
      const tagMatch = title.match(RE_DANDAN_TAG);
      if (tagMatch) {
          effectiveSource = tagMatch[1].toLowerCase();
      }
  }

  const isDandanOrAnimeko = /^(dandan|animeko)$/i.test(effectiveSource);
  
  if (isDandanOrAnimeko && title) {
      // 严格检测：必须移除标签后才进行 S1 检测
      let rawTemp = title.replace(RE_SOURCE_TAG, '').replace(RE_FROM_SUFFIX, '').trim();
      
      if (RE_SPECIAL_START.test(rawTemp) || RE_DANDAN_IGNORE_EP.test(rawTemp)) {
          isStrictSpecial = true;
      }
  }

  const t = cleanText(title || "");
  
  const isMovie = RE_MOVIE_CHECK.test(t);
  const isPV = RE_PV_CHECK.test(t);
  
  let num = null;
  let season = null;
  
  // 显式检测特殊集类型 (OP, ED, Interview 等)，防止其被识别为正片数字
  const specialTypeTag = getSpecialEpisodeType(title);
  const isSpecialType = !!specialTypeTag;

  const isSpecial = isPV || isStrictSpecial || isSpecialType || RE_SPECIAL_CHECK.test(t);

  const seasonMatch = t.match(RE_EP_SEASON_MATCH);
  if (seasonMatch) {
      season = parseInt(seasonMatch[1]);
  }

  const seasonEpMatch = t.match(RE_EP_NUM_STRATEGY_A);
  if (seasonEpMatch) {
      num = parseFloat(seasonEpMatch[2]);
  } else {
      const strongPrefixMatch = t.match(RE_EP_NUM_STRATEGY_B);
      if (strongPrefixMatch) {
        num = parseFloat(strongPrefixMatch[1]);
      } else {
        const weakPrefixMatch = t.match(RE_EP_NUM_STRATEGY_C);
        if (weakPrefixMatch) {
          num = parseFloat(weakPrefixMatch[1]);
        }
      }
  }

  return { isMovie, num, isSpecial, isPV, season, isStrictSpecial };
}

/**
 * 判断集标题是否属于特定的特殊类型
 * @param {string} title 集标题
 * @returns {string|null} 特殊类型标识 ('opening' | 'ending' | 'interview' | 'Bloopers' | null)
 */
function getSpecialEpisodeType(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  
  if (t.includes('opening')) return 'opening';
  if (t.includes('ending')) return 'ending';
  if (t.includes('interview')) return 'interview';
  if (t.includes('bloopers')) return 'Bloopers'; 
  
  return null;
}

/**
 * 过滤无效剧集
 * @param {Array} links 链接列表
 * @param {RegExp} filterRegex 过滤正则
 * @returns {Array} 过滤后的列表 (保留 originalIndex)
 */
function filterEpisodes(links, filterRegex) {
  if (!links) return [];
  if (!filterRegex) {
    return links.map((link, index) => ({ link, originalIndex: index }));
  }

  return links
    .map((link, index) => ({ link, originalIndex: index }))
    .filter(item => {
      const title = item.link.title || item.link.name || "";
      return !filterRegex.test(title);
    });
}

/**
 * 辅助函数：计算两个字符串的最长公共子串
 * @param {string} str1 字符串1
 * @param {string} str2 字符串2
 * @returns {string} 最长公共子串
 */
function getLongestCommonSubstring(str1, str2) {
    if (!str1 || !str2) return '';
    let maxSub = '';
    const len1 = str1.length;
    // 双重循环，无需过度优化，对于标题长度尚可
    for (let i = 0; i < len1; i++) {
        for (let j = i + 1; j <= len1; j++) {
            const sub = str1.substring(i, j);
            if (str2.includes(sub)) {
                if (sub.length > maxSub.length) maxSub = sub;
            }
        }
    }
    return maxSub;
}

/**
 * 检测并识别冗余的系列标题字段
 * 包含主标题截断和位置锚定逻辑，防止误删
 * @param {Array} links 集链接列表
 * @param {string} seriesTitle 系列标题
 * @param {string} sourceName 来源名称
 * @returns {string} 冗余字段字符串
 */
function identifyRedundantTitle(links, seriesTitle, sourceName) {
    if (!links || links.length < 2 || !seriesTitle) return '';

    const cleanSource = (text) => {
        if (!text || !sourceName) return text || '';
        try {
            const escapedSource = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(\\[|【|\\s)?${escapedSource}(\\]|】|\\s)?`, 'gi');
            return text.replace(regex, '').trim();
        } catch (e) {
            return text;
        }
    };

    let cleanSeriesTitle = cleanSource(seriesTitle);

    const separatorMatch = cleanSeriesTitle.match(RE_REDUNDANT_SEPARATOR);
    if (separatorMatch) {
        cleanSeriesTitle = cleanSeriesTitle.substring(0, separatorMatch.index);
    }

    const titles = links.map(item => {
        const realLink = item.link || item; 
        if (!realLink) return '';
        return cleanSource(realLink.title || realLink.name || '');
    });
    
    if (titles.some(t => !t)) return ''; 

    let common = getLongestCommonSubstring(titles[0], titles[1]);
    if (common.length < 2) return ''; 

    for (let i = 2; i < titles.length; i++) {
        common = getLongestCommonSubstring(common, titles[i]);
        if (common.length < 2) return '';
    }

    const validatedRedundant = getLongestCommonSubstring(common, cleanSeriesTitle);

    // 锚定检测
    if (!cleanSeriesTitle.startsWith(validatedRedundant)) {
        return '';
    }

    if (RE_REDUNDANT_UNSAFE_END.test(validatedRedundant)) {
        const trimmed = validatedRedundant.slice(0, -1).trim();
        if (trimmed.length >= 2 && cleanSeriesTitle.startsWith(trimmed)) {
             return trimmed;
        }
        return '';
    }

    if (validatedRedundant.length >= 2) {
        if (RE_REDUNDANT_VALID_CHARS.test(validatedRedundant) || validatedRedundant.length > 3) {
            log("info", `[Merge-Check] 检测到集内冗余标题字段: "${validatedRedundant}" (已忽略来源: ${sourceName}, 锚定验证通过)`);
            return validatedRedundant;
        }
    }

    return '';
}

/**
 * 寻找最佳对齐偏移量
 * 包含超级锚点逻辑、双模式CN匹配等
 * @param {Array} primaryLinks 主源链接
 * @param {Array} secondaryLinks 副源链接
 * @param {string} seriesLangA 主源语言
 * @param {string} seriesLangB 副源语言
 * @param {string} sourceA 主源名称
 * @param {string} sourceB 副源名称
 * @param {string} primarySeriesTitle 主源标题
 * @param {string} secondarySeriesTitle 副源标题
 * @returns {number} 最佳偏移量 (Offset)
 */
function findBestAlignmentOffset(primaryLinks, secondaryLinks, seriesLangA = 'Unspecified', seriesLangB = 'Unspecified', sourceA = '', sourceB = '', primarySeriesTitle = '', secondarySeriesTitle = '') {
  if (primaryLinks.length === 0 || secondaryLinks.length === 0) return 0;

  // 1. 预计算冗余标题
  const redundantA = identifyRedundantTitle(primaryLinks, primarySeriesTitle, sourceA);
  const redundantB = identifyRedundantTitle(secondaryLinks, secondarySeriesTitle, sourceB);

  const getTempTitle = (rawTitle, redundantStr) => {
      if (!rawTitle) return "";
      if (redundantStr && rawTitle.includes(redundantStr)) {
          return rawTitle.replace(redundantStr, ''); 
      }
      return rawTitle;
  };

  const pInfos = primaryLinks.map(item => {
      const rawTitle = item.link.title || "";
      const cleanTitle = getTempTitle(rawTitle, redundantA);
      const info = extractEpisodeInfo(cleanTitle, sourceA);
      const epLang = getLanguageType(cleanTitle);
      const effLang = epLang !== 'Unspecified' ? epLang : seriesLangA;
      const specialType = getSpecialEpisodeType(cleanTitle);
      // Pre-calc Clean Text for similarity
      const cleanEpText = cleanEpisodeText(cleanTitle);
      const strictCnCore = (effLang === 'CN') ? cleanTitle.replace(RE_CN_STRICT_CORE_REMOVE, "") : null;

      return { info, effLang, specialType, cleanEpText, strictCnCore };
  });

  const sInfos = secondaryLinks.map(item => {
      const rawTitle = item.link.title || "";
      const cleanTitle = getTempTitle(rawTitle, redundantB);
      const info = extractEpisodeInfo(cleanTitle, sourceB);
      const epLang = getLanguageType(cleanTitle);
      let effLang = epLang !== 'Unspecified' ? epLang : seriesLangB;
      // 针对 dandan/animeko 的默认语言推断
      if (effLang === 'Unspecified' && /^(dandan|animeko)$/i.test(sourceB)) {
          effLang = 'JP';
      }
      const specialType = getSpecialEpisodeType(cleanTitle);
      const cleanEpText = cleanEpisodeText(cleanTitle);
      const strictCnCore = (effLang === 'CN') ? cleanTitle.replace(RE_CN_STRICT_CORE_REMOVE, "") : null;

      return { info, effLang, specialType, cleanEpText, strictCnCore };
  });

  let bestOffset = 0;
  let maxScore = -9999; 
  
  let minNormalA = null;
  let minNormalB = null;

  // 使用预计算的数据寻找最小集数
  for (const { info } of pInfos) {
      if (info.num !== null && !info.isSpecial) {
          if (minNormalA === null || info.num < minNormalA) minNormalA = info.num;
      }
  }
  for (const { info } of sInfos) {
      if (info.num !== null && !info.isSpecial) {
          if (minNormalB === null || info.num < minNormalB) minNormalB = info.num;
      }
  }

  const seasonShift = (minNormalA !== null && minNormalB !== null) ? (minNormalA - minNormalB) : null;

  const baseRange = 15;
  const targetShift = (seasonShift !== null) ? -seasonShift : 0;
  const minSearch = Math.min(-baseRange, targetShift - baseRange);
  const maxSearch = Math.max(baseRange, targetShift + baseRange);
  const safeMin = Math.max(minSearch, -Math.max(primaryLinks.length, secondaryLinks.length));
  const safeMax = Math.min(maxSearch, Math.max(primaryLinks.length, secondaryLinks.length));

  for (let offset = safeMin; offset <= safeMax; offset++) {
    let totalTextScore = 0;
    let rawTextScoreSum = 0;
    let matchCount = 0;
    let numericDiffs = new Map();
    let hasSeasonShiftMatch = false;

    for (let i = 0; i < secondaryLinks.length; i++) {
      const pIndex = i + offset;
      
      if (pIndex >= 0 && pIndex < primaryLinks.length) {
        // 直接访问预计算数据
        const dataA = pInfos[pIndex];
        const dataB = sInfos[i];
        
        const infoA = dataA.info;
        const infoB = dataB.info;

        // 1. 类型惩罚
        let pairScore = 0;
        if (infoA.isMovie !== infoB.isMovie) {
            pairScore -= 5.0; 
        }

        if ((infoA.isStrictSpecial && !infoB.isSpecial) || (infoB.isStrictSpecial && !infoA.isSpecial)) {
            pairScore -= 8.0; 
        }

        // 语言匹配
        const effLangA = dataA.effLang;
        const effLangB = dataB.effLang;
        // 将 Unspecified 默认为 JP，防止无标识主源匹配到 CN 副源
        const normLangA = effLangA === 'Unspecified' ? 'JP' : effLangA;
        const normLangB = effLangB === 'Unspecified' ? 'JP' : effLangB;

        if (normLangA === normLangB) {
             pairScore += 3.0; 
        } else {
             pairScore -= 5.0; 
        }

        if (infoA.season !== null && infoB.season !== null && infoA.season !== infoB.season) {
            pairScore -= 10.0;
        }

        // 特殊集类型
        if (dataA.specialType || dataB.specialType) {
            if (dataA.specialType !== dataB.specialType) {
                pairScore -= 10.0; 
            } else {
                pairScore += 3.0; 
            }
        }

        if (infoA.isSpecial === infoB.isSpecial) {
             pairScore += 3.0;
        }

        if (seasonShift !== null && !infoA.isSpecial && !infoB.isSpecial) {
            if ((infoA.num - infoB.num) === seasonShift) {
                // 如果集数差值正好符合全局季度偏移，给予巨额奖励，压倒性优势
                // 这解决了 Absolute vs Relative 编号对齐问题 (如 Ep1 vs Ep25)
                pairScore += 15.0; 
                hasSeasonShiftMatch = true;
            }
        }

        // 2. 文本相似度 (利用预计算)
        let sim = 0;
        if (effLangA === 'CN' && effLangB === 'CN') {
            const coreA = dataA.strictCnCore;
            const coreB = dataB.strictCnCore;

            if (coreA && coreB && (coreA.includes(coreB) || coreB.includes(coreA))) {
                if (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num) {
                    sim = 25.0; 
                } else {
                    sim = -5.0;
                }
            } else {
                 sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
            }
        } else {
            sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
        }

        pairScore += sim;
        rawTextScoreSum += sim;

        if (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num) {
            pairScore += 2.0; 
        }

        totalTextScore += pairScore;

        if (infoA.num !== null && infoB.num !== null) {
            const diff = infoB.num - infoA.num;
            const diffKey = diff.toFixed(4);
            const count = numericDiffs.get(diffKey) || 0;
            numericDiffs.set(diffKey, count + 1);
        }

        matchCount++;
      }
    }

    if (matchCount > 0) {
      let finalScore = totalTextScore / matchCount;

      let maxFrequency = 0;
      for (const count of numericDiffs.values()) {
          if (count > maxFrequency) maxFrequency = count;
      }
      
      const consistencyRatio = maxFrequency / matchCount;
      const avgRawTextScore = rawTextScoreSum / matchCount;

      // 如果检测到强烈的数字对应规律 (consistencyRatio高)
      // 即使文本相似度极低 (如 CN vs JP)，只要有 seasonShift 支撑，或者一致性极高，都给予奖励
      if (consistencyRatio > 0.6) {
          if (hasSeasonShiftMatch || avgRawTextScore > 0.33) {
              finalScore += 2.0;
          }
      }

      const coverageBonus = Math.min(matchCount * 0.15, 1.5);
      finalScore += coverageBonus;

      const zeroDiffCount = numericDiffs.get("0.0000") || 0;
      if (zeroDiffCount > 3) {
          finalScore += zeroDiffCount * 5.0; 
          finalScore += 100.0; 
      } else if (zeroDiffCount > 0) {
          finalScore += zeroDiffCount * 2.0;
      }

      if (finalScore > maxScore) {
        maxScore = finalScore;
        bestOffset = offset;
      }
    }
  }

  return maxScore > 0.3 ? bestOffset : 0;
}

/**
 * 生成符合 int32 范围的安全 ID
 * 通过哈希映射到 10亿~21亿 区间，避免溢出
 * @param {string|number} id1 ID 1
 * @param {string|number} id2 ID 2
 * @param {string} salt 盐值
 * @returns {number} 安全 ID
 */
function generateSafeMergedId(id1, id2, salt = '') {
    const str = `${id1}_${id2}_${salt}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; 
    }
    return (Math.abs(hash) % 1000000000) + 1000000000;
}

/**
 * 创建新的 Link 对象
 * 格式化 URL 并设置显示标题
 * @param {Object} item 包含 link 和 originalIndex 的对象
 * @param {string} sourceName 来源名称
 * @returns {Object} 格式化后的 Link 对象
 */
function createNewLink(item, sourceName) {
    const rawLink = item.link;
    const rawTitle = rawLink.title || rawLink.name || `Episode ${item.originalIndex + 1}`;
    
    let newUrl = rawLink.url || '';
    if (newUrl) {
        newUrl = sanitizeUrl(newUrl);
        if (!/^https?:\/\//i.test(newUrl)) {
             newUrl = `${sourceName}:${newUrl}`;
        }
    }

    let displayTitle = rawTitle;
    if (!displayTitle.includes(`【${sourceName}】`)) {
        displayTitle = `【${sourceName}】 ${displayTitle}`;
    }

    return {
        title: displayTitle,
        url: newUrl,
        name: rawTitle 
    };
}

/**
 * 智能拼接未匹配的集数
 * 处理头部插入、尾部追加和特殊集补充
 * @param {Object} derivedAnime 目标动漫对象
 * @param {Array} orphans 未匹配的集数列表
 * @param {string} sourceName 来源名称
 */
function stitchUnmatchedEpisodes(derivedAnime, orphans, sourceName) {
    if (!orphans || orphans.length === 0) return;

    const headList = [];
    const tailList = [];
    const specialList = [];
    const currentLen = derivedAnime.links.length;

    // 计算主源“正片”的有效边界索引
    // 解决 dandan 等源在正片后堆积大量番外(S1, S2...)导致 currentLen 虚高，
    // 进而导致副源后续的正片(如13-24集)被误判为“中间缺失/番外”的问题。
    let lastPrimaryMainIndex = -1;
    for (let i = currentLen - 1; i >= 0; i--) {
        const link = derivedAnime.links[i];
        const title = link.title || link.name || "";
        // 复用 info 提取逻辑，为保证性能和准确性，直接解析
        // 注意：derivedAnime.source 在 processMergeTask 中已被修正为 currentPrimarySource
        const info = extractEpisodeInfo(title, derivedAnime.source);
        
        // 如果是正片（非PV、非SP、有数字），则标记为最后的主线位置
        if (!info.isSpecial && !info.isPV && !info.isStrictSpecial && info.num !== null) {
            lastPrimaryMainIndex = i;
            break;
        }
    }
    
    // 如果整个列表都没找到正片（全是番外），则设为 -1，
    // 这样副源任何 index >= 0 的正片都会被视为 Tail 追加

    for (const item of orphans) {
        const relativeIdx = item.relativeIndex;
        const isStrictSpecial = item.info && item.info.isStrictSpecial;
        // 判断副源集是否为“正片”
        const isOrphanMain = item.info && !item.info.isSpecial && !item.info.isPV && !isStrictSpecial && item.info.num !== null;

        if (relativeIdx < 0 && !isStrictSpecial) {
            headList.push(item);
        }
        else if (
            // 场景A: 索引超出了物理长度 (常规追加)
            (relativeIdx >= currentLen && !isStrictSpecial) ||
            // 场景B [Fix]: 索引虽在物理长度内，但已超过了主源“最后正片”的位置，且自身是正片
            // 这意味着主源后面占据坑位的都是番外，副源的正片应当追加到最后，而不是插到番外中间
            (isOrphanMain && relativeIdx > lastPrimaryMainIndex)
        ) {
            tailList.push(item);
        }
        else {
            specialList.push(item);
        }
    }

    const addedLogs = [];

    if (headList.length > 0) {
        headList.sort((a, b) => a.originalIndex - b.originalIndex);
        const newLinks = headList.map(it => createNewLink(it, sourceName));
        derivedAnime.links.unshift(...newLinks);
        addedLogs.push(`   [补全-头部] 插入 ${headList.length} 集 (${headList.map(i => i.link.title).join(', ')})`);
    }

    if (tailList.length > 0) {
        tailList.sort((a, b) => a.originalIndex - b.originalIndex);
        const newLinks = tailList.map(it => createNewLink(it, sourceName));
        derivedAnime.links.push(...newLinks);
        addedLogs.push(`   [补全-尾部] 追加 ${tailList.length} 集 (${tailList.map(i => i.link.title).join(', ')})`);
    }

    if (specialList.length > 0) {
        specialList.sort((a, b) => a.originalIndex - b.originalIndex);
        const newLinks = specialList.map(it => createNewLink(it, sourceName));
        derivedAnime.links.push(...newLinks);
        addedLogs.push(`   [补全-特殊] 补充 ${specialList.length} 集 (中间缺失或番外) (${specialList.map(i => i.link.title).join(', ')})`);
    }

    if (addedLogs.length > 0) {
        log("info", `[Merge] [${sourceName}] 智能补全:\n${addedLogs.join('\n')}`);
    }
}

/**
 * 获取列表中的“中间插值”小数集数
 * 智能逻辑：识别夹在整数序列中间的小数 (如 12->12.5->13 中的 12.5)
 * 忽略位于序列末尾的小数 (如 12->13->12.5，此时 12.5 不影响对齐，不视为插值)
 * @param {Array} links 集数列表
 * @param {string} source 来源
 * @returns {Set<number>} 需要处理的中间小数集合
 */
function getDecimalEpisodes(links, source) {
    const decimals = new Set();
    if (!links) return decimals;
    
    // 1. 预解析所有集数信息，并找到最后一个“正片整数集”的索引
    // 目的：确定“主序列”的边界
    let lastIntegerIndex = -1;
    const parsedLinks = [];

    for (let i = 0; i < links.length; i++) {
        const title = links[i].title || links[i].name || "";
        const info = extractEpisodeInfo(title, source);
        parsedLinks.push({ index: i, info });

        // 更新最后一个整数集的索引
        // 排除 PV、Special 等干扰，只认准正片整数
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 === 0) {
            lastIntegerIndex = i;
        }
    }

    // 2. 筛选出位于主序列内部的小数
    // 判定标准：该小数出现在最后一个整数集之前
    parsedLinks.forEach(item => {
        const { index, info } = item;
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 !== 0) {
            // [智能判断] 只有当它出现在最后一个整数之前，才视为“中间插值”
            // 如果它已经在最后 (index > lastIntegerIndex)，说明已经是沉底状态或后续无正片，无需处理
            if (index < lastIntegerIndex) {
                decimals.add(info.num);
            }
        }
    });

    return decimals;
}

/**
 * 将指定的小数集数沉底
 * 保持其他集数顺序不变，仅将目标集数移到末尾
 */
function sinkDecimalEpisodes(links, numsToSink, source, sideName) {
    const normals = [];
    const sinkers = [];
    let movedCount = 0;
    
    links.forEach(link => {
        const title = link.title || link.name || "";
        const info = extractEpisodeInfo(title, source);
        // 如果是目标小数集数，则加入沉底队列
        const isTarget = info.num !== null && numsToSink.has(info.num);
        
        if (isTarget) {
            sinkers.push(link);
            movedCount++;
        } else {
            normals.push(link);
        }
    });
    
    if (movedCount > 0) {
        // 就地修改数组
        links.length = 0;
        links.push(...normals, ...sinkers);
        log("info", `[Merge-Check] [${sideName}] 自动沉底: 移动了 ${movedCount} 个中间插值集数 (${Array.from(numsToSink).join(',')}) 到末尾 (因对方缺失或位置不一致，避免阻断对齐)`);
    }
}

/**
 * 构建季度集数地图 (辅助合集切片)
 * 遍历同组内所有动漫，统计各季度的公认集数
 * 优化点：强力排除番外、OP、ED，避免统计出的“单季长度”虚高
 * @param {Array} allGroupAnimes 同组动漫列表
 * @param {RegExp} epFilter 集过滤正则
 * @param {Set<string>} collectionAnimeIds 已知合集ID集合 (用于排除合集本身)
 * @returns {Map<number, number>} 季度 -> 最大集数
 */
function buildSeasonLengthMap(allGroupAnimes, epFilter, collectionAnimeIds) {
    const seasonMap = new Map();
    
    // 默认 S1 至少 10 集 (防止某些单集剧场版被误认为S1长度)
    // 但如果有明确数据会覆盖
    
    for (const anime of allGroupAnimes) {
        // 如果该动漫已被识别为合集，则不参与季度长度的统计
        // 避免合集（如Bahamut 28集）将 S1 的统计长度撑大到 28
        if (collectionAnimeIds && collectionAnimeIds.has(anime.animeId)) {
            continue;
        }

        // 使用 globals.animes 获取完整数据 (links)
        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
        const seasonNum = getSeasonNumber(realAnime.animeTitle, realAnime.typeDescription);
        
        if (seasonNum !== null && realAnime.links) {
            // 计算有效集数 (强力排除番外/OP/ED/Behind the scenes)
            const validLinks = filterEpisodes(realAnime.links, epFilter).filter(item => {
                const title = item.link.title || item.link.name || "";
                
                // 1. 基础清理
                const cleanT = cleanText(title);
                const rawTemp = cleanT.replace(RE_SOURCE_TAG, '').replace(RE_FROM_SUFFIX, '').trim();

                // 2. 检查 dandan/animeko 的特殊标记
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                     if (RE_SPECIAL_CHECK.test(rawTemp) || RE_DANDAN_IGNORE_EP.test(rawTemp)) return false;
                }

                // 3. 增强的关键词过滤，拦截 "Behind the Scenes", "Opening" 等漏网之鱼
                if (RE_MAP_EXCLUDE_KEYWORDS.test(rawTemp) || RE_MAP_EXCLUDE_KEYWORDS.test(title)) {
                    return false;
                }
                
                return true;
            });
            
            const count = validLinks.length;
            if (count > 0) {
                const currentMax = seasonMap.get(seasonNum) || 0;
                // 取最大值，确保覆盖全集
                if (count > currentMax) {
                    seasonMap.set(seasonNum, count);
                }
            }
        }
    }
    return seasonMap;
}

// =========================================================================
// 单个主源合并任务处理函数
// 复用逻辑核心，用于 Phase 1 (CN隔离) 和 Phase 2 (标准合并)
// =========================================================================
async function processMergeTask(params) {
    const { 
        pAnime, 
        availableSecondaries, 
        curAnimes, 
        groupConsumedIds, 
        globalConsumedIds,
        generatedSignatures,
        epFilter,
        groupFingerprint,
        currentPrimarySource,
        logPrefix,
        limitSecondaryLang,
        collectionAnimeIds, // 传入合集 ID 集合
        allowReuseIds // 允许复用的 ID 集合 (用于 Part 主源复用全集副源)
    } = params;

    // 如果当前主源就是合集，且它已经被部分消费过（在 globalConsumedIds 中），则跳过
    // 防止合集作为主源再次去匹配其他内容（例如剧场版）
    if (collectionAnimeIds.has(pAnime.animeId) && globalConsumedIds.has(pAnime.animeId)) {
        log("info", `${logPrefix} 跳过: [${currentPrimarySource}] 是合集且已作为副源参与过合并。`);
        return null;
    }

    const cachedPAnime = globals.animes.find(a => String(a.animeId) === String(pAnime.animeId));
    if (!cachedPAnime?.links) {
         log("warn", `${logPrefix} 主源数据不完整，跳过: ${pAnime.animeTitle}`);
         return null;
    }

    const logTitleA = pAnime.animeTitle.replace(RE_FROM_SUFFIX, '');
    // Deep Clone 仅在必要时执行
    let derivedAnime = JSON.parse(JSON.stringify(cachedPAnime));
    
    const actualMergedSources = []; 
    const contentSignatureParts = [pAnime.animeId];
    let hasMergedAny = false;

    const seriesLangA = getLanguageType(pAnime.animeTitle);

    const redundantP = identifyRedundantTitle(derivedAnime.links, pAnime.animeTitle, currentPrimarySource);
    
    const getTempTitle = (rawTitle, redundantStr) => {
        if (!rawTitle) return "";
        if (redundantStr && rawTitle.includes(redundantStr)) {
            return rawTitle.replace(redundantStr, ''); 
        }
        return rawTitle;
    };

    // [合集预处理] 
    // 只要当前任务涉及合集（无论是P还是S），构建“季度-集数”地图
    const isPrimaryCollection = collectionAnimeIds.has(pAnime.animeId);
    let seasonLengthMap = new Map();
    // 查找同组内所有的同名不同源动漫
    const pCleanTitle = cleanTitleForSimilarity(pAnime.animeTitle);
    const peerAnimes = curAnimes.filter(a => cleanTitleForSimilarity(a.animeTitle) === pCleanTitle);
    
    // 传入 collectionAnimeIds 以避免合集本身污染统计数据
    seasonLengthMap = buildSeasonLengthMap(peerAnimes, epFilter, collectionAnimeIds);
    
    if (seasonLengthMap.size > 0) {
        const mapDesc = Array.from(seasonLengthMap.entries()).map(([k,v]) => `S${k}=${v}`).join(', ');
        // 仅在涉及合集时输出此日志
        if (isPrimaryCollection || availableSecondaries.some(s => curAnimes.some(a => a.source === s && collectionAnimeIds.has(a.animeId)))) {
            log("info", `${logPrefix} [合集处理] 构建季度集数地图: { ${mapDesc} }`);
        }
    }

    for (const secSource of availableSecondaries) {
        // 过滤副源时，检查 groupConsumedIds。
        // 如果 animeId 在 allowReuseIds 中，则豁免 groupConsumedIds 的检查。
        let secondaryItems = curAnimes.filter(a => {
            if (a.source !== secSource) return false;
            
            const isConsumed = groupConsumedIds.has(a.animeId);
            const isAllowedReuse = allowReuseIds && allowReuseIds.has(a.animeId);

            if (isConsumed && !isAllowedReuse) return false;
            return true;
        });
        
        if (limitSecondaryLang) {
             secondaryItems = secondaryItems.filter(a => getLanguageType(a.animeTitle) === limitSecondaryLang);
        }

        // 副源排序逻辑：让 Non-CN 结果优先执行
        // 目的：与主源排序逻辑保持一致，确保 Non-CN 的副源（通常是原版或更高质量）排在前面传入匹配函数
        if (secondaryItems.length > 1) {
            secondaryItems.sort((a, b) => {
                const isCnA = getLanguageType(a.animeTitle) === 'CN';
                const isCnB = getLanguageType(b.animeTitle) === 'CN';
                if (isCnA === isCnB) return 0;
                return isCnA ? 1 : -1; // Non-CN 排在前面 (false < true)
            });
        }

        if (secondaryItems.length === 0) continue;

        // 将 collectionAnimeIds 传递给匹配函数
        const matches = findSecondaryMatches(pAnime, secondaryItems, collectionAnimeIds);
        
        for (const match of matches) {
            // 合集豁免：如果 match 是合集，即使在 globalConsumedIds 中也可以再次使用（但 group 中不能重复）
            // 兼容 allowReuseIds，如果明确允许复用，也跳过此检查
            const isReuse = allowReuseIds && allowReuseIds.has(match.animeId);
            if (!isReuse && groupConsumedIds.has(match.animeId)) continue;

            const cachedMatch = globals.animes.find(a => String(a.animeId) === String(match.animeId));
            if (!cachedMatch?.links) continue;

            const mappingEntries = []; 
            const matchedPIndices = new Set(); 
            const pendingMutations = [];
            const orphanedEpisodes = []; 

            const logTitleB = cachedMatch.animeTitle.replace(RE_FROM_SUFFIX, '');

            // [智能沉底逻辑应用]
            // getDecimalEpisodes 现在只返回“捣乱”的中间小数
            const decimalsP = getDecimalEpisodes(derivedAnime.links, currentPrimarySource);
            const decimalsS = getDecimalEpisodes(cachedMatch.links, secSource);
            
            // 逻辑 A: 副源沉底
            // 如果副源有某个中间小数，但主源没有（可能主源根本没有，或者主源已经沉底了导致 getDecimalEpisodes 不返回它）
            // 那么副源也应该把这个小数沉底，以保持序列一致
            const toSinkS = new Set([...decimalsS].filter(x => !decimalsP.has(x)));
            
            // 逻辑 B: 主源沉底
            // 如果主源有中间小数，但副源没有，主源沉底以适配副源
            const toSinkP = new Set([...decimalsP].filter(x => !decimalsS.has(x)));
            
            if (toSinkP.size > 0) {
                 sinkDecimalEpisodes(derivedAnime.links, toSinkP, currentPrimarySource, `主源:${currentPrimarySource}`);
            }
            
            // 副源不能直接修改 cachedMatch，需创建副本
            let currentSecondaryLinks = cachedMatch.links;
            if (toSinkS.size > 0) {
                currentSecondaryLinks = [...cachedMatch.links]; // Shallow copy
                sinkDecimalEpisodes(currentSecondaryLinks, toSinkS, secSource, `副源:${secSource}`);
            }

            const filteredPLinksWithIndex = filterEpisodes(derivedAnime.links, epFilter);
            const filteredMLinksWithIndex = filterEpisodes(currentSecondaryLinks, epFilter);

            const seriesLangB = getLanguageType(cachedMatch.animeTitle);
            
            // =========================
            // 双向合集切片逻辑 (Core Logic)
            // =========================
            
            let activePLinks = filteredPLinksWithIndex;
            let activeMLinks = filteredMLinksWithIndex;
            let sliceStartP = 0;
            let sliceStartS = 0;

            const isSecondaryCollection = collectionAnimeIds.has(match.animeId);
            
            const performSlicing = (isPrimarySide, collectionLinks, seasonNum) => {
                let sliceStart = 0;
                let slicedList = collectionLinks;
                
                if (seasonNum && seasonNum > 1) {
                     let accumulatedCount = 0;
                     for (let s = 1; s < seasonNum; s++) {
                         accumulatedCount += (seasonLengthMap.get(s) || 0);
                     }
                     
                     // 计算切片起点时保留安全缓冲
                     // 故意少切 2 集，让 findBestAlignmentOffset 去修正微小误差
                     let safeAccumulated = Math.max(0, accumulatedCount - 2);
                     
                     // 动态回退逻辑
                     // 如果计算出的起点已经超出了合集总长度（说明地图统计可能虚高了），尝试使用“标准季度长度”进行回退
                     // 假设每季标准长度为 12 集，计算一个保守的起点
                     if (safeAccumulated >= collectionLinks.length) {
                         const heuristicStart = (seasonNum - 1) * 12; // 简单的启发式估算
                         // 如果启发式起点有效，则采用它
                         if (heuristicStart < collectionLinks.length) {
                             log("info", `${logPrefix} [合集切片] 起点越界修正: 原计算 ${safeAccumulated} > Total ${collectionLinks.length}，启用回退估算 (S${seasonNum} -> Index ${heuristicStart})`);
                             safeAccumulated = Math.max(0, heuristicStart - 2); // 依然应用缓冲
                         }
                     }

                     if (safeAccumulated > 0 && safeAccumulated < collectionLinks.length) {
                         const nextStart = accumulatedCount + (seasonLengthMap.get(seasonNum) || 999);
                         const safeEnd = Math.min(nextStart, collectionLinks.length);
                         
                         slicedList = collectionLinks.slice(safeAccumulated, safeEnd);
                         sliceStart = safeAccumulated;
                         
                         const sideName = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                         log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S${seasonNum}): 原Index ${accumulatedCount}, 安全回退至 ${safeAccumulated}~${safeEnd} (共 ${slicedList.length} 集) 参与对齐`);
                     } else {
                         log("info", `${logPrefix} [合集切片] 放弃切片: 计算起点 ${safeAccumulated} 超出范围 (Total: ${collectionLinks.length})`);
                     }
                } else if (seasonNum === 1) {
                     // S1 限制范围防止误伤 S2
                     const s1Count = seasonLengthMap.get(1);
                     if (s1Count && s1Count < collectionLinks.length) {
                         slicedList = collectionLinks.slice(0, s1Count);
                         const sideName = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                         log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S1): 使用 Index 0~${s1Count} 参与对齐`);
                     }
                }
                return { sliceStart, slicedList };
            };

            // 场景 1: 主源是合集，副源是分季
            if (isPrimaryCollection && !isSecondaryCollection) {
                const secSeason = getSeasonNumber(cachedMatch.animeTitle, cachedMatch.typeDescription);
                const res = performSlicing(true, filteredPLinksWithIndex, secSeason);
                activePLinks = res.slicedList;
                sliceStartP = res.sliceStart;
            }
            // 场景 2: 副源是合集，主源是分季
            else if (!isPrimaryCollection && isSecondaryCollection) {
                const pSeason = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription);
                const res = performSlicing(false, filteredMLinksWithIndex, pSeason);
                activeMLinks = res.slicedList;
                sliceStartS = res.sliceStart;
            }

            const bestOffsetLocal = findBestAlignmentOffset(
                activePLinks, 
                activeMLinks, 
                seriesLangA, 
                seriesLangB, 
                currentPrimarySource, 
                secSource,
                pAnime.animeTitle,     
                cachedMatch.animeTitle 
            );
            
            // 还原全局 Offset
            // 如果切的是主源：Offset 增大 (使得副源[0] 对齐到 主源[sliceStart])
            // 如果切的是副源：Offset 减小 (使得主源[0] 对齐到 副源[sliceStart])
            const offset = bestOffsetLocal + sliceStartP - sliceStartS;
            
            if (offset !== 0) {
              log("info", `${logPrefix} 集数自动对齐 (${secSource}): Offset=${offset} (P:${filteredPLinksWithIndex.length}, S:${filteredMLinksWithIndex.length})`);
            }

            derivedAnime.animeId = generateSafeMergedId(derivedAnime.animeId, match.animeId, groupFingerprint);
            derivedAnime.bangumiId = String(derivedAnime.animeId);

            let mergedCount = 0;
            
            const redundantS = identifyRedundantTitle(cachedMatch.links, cachedMatch.animeTitle, secSource);

            for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
              const pIndex = k + offset; 
              const sourceLinkItem = filteredMLinksWithIndex[k];
              const sourceLink = sourceLinkItem.link;
              const sTitleShort = sourceLink.name || sourceLink.title || `Index ${k}`;

              const orphanItem = {
                  link: sourceLink,
                  originalIndex: sourceLinkItem.originalIndex, 
                  relativeIndex: pIndex,  
                  info: null 
              };

              const cleanTitleS = getTempTitle(sourceLink.title, redundantS);
              orphanItem.info = extractEpisodeInfo(cleanTitleS, secSource);

              if (epFilter && epFilter.test(sTitleShort)) {
                  mappingEntries.push({ idx: pIndex, text: `   [略过] ${sTitleShort} (命中PV/预告过滤器)` });
                  continue;
              }
              
              if (pIndex >= 0 && pIndex < filteredPLinksWithIndex.length) {
                const originalPIndex = filteredPLinksWithIndex[pIndex].originalIndex;
                const targetLink = derivedAnime.links[originalPIndex];
                const pTitleShort = targetLink.name || targetLink.title || `Index ${originalPIndex}`;
                
                const cleanTitleP = getTempTitle(targetLink.title, redundantP);

                const specialP = getSpecialEpisodeType(cleanTitleP);
                const specialS = getSpecialEpisodeType(cleanTitleS);
                
                const infoP = extractEpisodeInfo(cleanTitleP, currentPrimarySource);
                const infoS = orphanItem.info;
                
                if (infoS.isPV && !specialP) {
                     mappingEntries.push({ idx: pIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (PV不匹配正片)` });
                     orphanedEpisodes.push(orphanItem); 
                    continue;
                }

                if (specialP !== specialS) {
                    mappingEntries.push({ idx: pIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (特殊集类型不匹配)` });
                    orphanedEpisodes.push(orphanItem); 
                    continue;
                }

                if ((infoP.isStrictSpecial && !infoS.isSpecial) || (infoS.isStrictSpecial && !infoP.isSpecial)) {
                    mappingEntries.push({ idx: pIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (正片与番外阻断)` });
                    orphanedEpisodes.push(orphanItem); 
                    continue;
                }
                
                const idB = sanitizeUrl(sourceLink.url);
                let currentUrl = targetLink.url;
                const secPart = `${secSource}:${idB}`;
                
                if (!currentUrl.includes(MERGE_DELIMITER)) {
                    if (!currentUrl.startsWith(currentPrimarySource + ':')) {
                       currentUrl = `${currentPrimarySource}:${currentUrl}`;
                    }
                }
                const newMergedUrl = `${currentUrl}${MERGE_DELIMITER}${secPart}`;
                
                let newMergedTitle = targetLink.title;
                if (newMergedTitle) {
                    let sLabel = secSource;
                    if (sourceLink.title) {
                        const sMatch = sourceLink.title.match(/^【([^】\d]+)(?:\d*)】/);
                        if (sMatch) sLabel = sMatch[1].trim();
                    }
                    newMergedTitle = newMergedTitle.replace(
                        /^【([^】]+)】/, 
                        (match, content) => `【${content}${DISPLAY_CONNECTOR}${sLabel}】`
                    );
                }

                mappingEntries.push({ idx: pIndex, text: `   [匹配] ${pTitleShort} <-> ${sTitleShort}` });
                matchedPIndices.add(pIndex);
                mergedCount++;

                pendingMutations.push({ linkIndex: originalPIndex, newUrl: newMergedUrl, newTitle: newMergedTitle });

              } else {
                  mappingEntries.push({ idx: pIndex, text: `   [落单] (主源越界) <-> ${sTitleShort}` });
                  orphanedEpisodes.push(orphanItem); 
              }
            }
            
            for (let j = 0; j < filteredPLinksWithIndex.length; j++) {
                if (!matchedPIndices.has(j)) {
                    const originalPIndex = filteredPLinksWithIndex[j].originalIndex;
                    const targetLink = derivedAnime.links[originalPIndex];
                    const pTitleShort = targetLink.name || targetLink.title || `Index ${originalPIndex}`;
                    mappingEntries.push({ idx: j, text: `   [落单] ${pTitleShort} <-> (副源缺失或被略过)` });
                }
            }

            if (mergedCount > 0) {
              // 传入合集标识
              const isAnyCollection = collectionAnimeIds.has(pAnime.animeId) || collectionAnimeIds.has(match.animeId);
              
              if (isMergeRatioValid(mergedCount, filteredPLinksWithIndex.length, filteredMLinksWithIndex.length, currentPrimarySource, secSource, isAnyCollection)) {
                  
                  for (const mutation of pendingMutations) {
                      const link = derivedAnime.links[mutation.linkIndex];
                      link.url = mutation.newUrl;
                      link.title = mutation.newTitle;
                  }

                  log("info", `${logPrefix} 关联成功: [${currentPrimarySource}] ${logTitleA} <-> [${secSource}] ${logTitleB} (本次合并 ${mergedCount} 集)`);
                  if (mappingEntries.length > 0) {
                      mappingEntries.sort((a, b) => a.idx - b.idx);
                      log("info", `${logPrefix} [${secSource}] 映射详情:\n${mappingEntries.map(e => e.text).join('\n')}`);
                  }

                  // 智能补全逻辑：如果是合集副源，则不进行补全，避免列表混乱
                  if (collectionAnimeIds.has(match.animeId)) {
                      log("info", `${logPrefix} [智能补全] 跳过: 副源 [${secSource}] 为合集，为避免混入其他季度集数，不执行补全。`);
                  } else {
                      stitchUnmatchedEpisodes(derivedAnime, orphanedEpisodes, secSource);
                  }
                  
                  // ===============================================
                  // 立即执行番外沉底排序
                  // ===============================================
                  // 在每次成功合并并补全后，立即清理列表顺序
                  // 确保 dandan/animeko 引入的混乱番外集不会影响后续副源的对齐映射
                  const normals = [];
                  const sinkers = [];
                  
                  // 注意：这里必须遍历最新的 derivedAnime.links
                  derivedAnime.links.forEach(link => {
                      const rawContent = link.title.replace(RE_SOURCE_TAG, '').trim();
                      if (RE_SPECIAL_SINK_TITLE_STRICT.test(rawContent)) {
                          sinkers.push(link);
                      } else {
                          normals.push(link);
                      }
                  });
                  
                  if (sinkers.length > 0) {
                      derivedAnime.links = [...normals, ...sinkers];
                      log("info", `${logPrefix} [排序优化] 立即执行番外沉底: 移动了 ${sinkers.length} 个番外集到末尾`);
                  }

                  // 合集消费豁免
                  // 如果匹配的是合集，不要将其加入 groupConsumedIds，使其能继续参与同组其他（S2/S1）的匹配
                  if (!collectionAnimeIds.has(match.animeId)) {
                      groupConsumedIds.add(match.animeId);
                  } else {
                      log("info", `${logPrefix} 合集保留: [${secSource}] ${logTitleB} 是合集，保留以供同组复用。`);
                  }
                  
                  // 依然加入 globalConsumedIds 以标记它被“使用过”（防止后续作为主源），但配合 processMergeTask 开头的检查逻辑
                  globalConsumedIds.add(match.animeId);

                  hasMergedAny = true;
                  actualMergedSources.push(secSource);
                  contentSignatureParts.push(match.animeId);
              } else {
                  log("info", `${logPrefix} 关联取消: [${currentPrimarySource}] ${logTitleA} <-> [${secSource}] ${logTitleB} (匹配率过低: ${mergedCount}/${Math.max(filteredPLinksWithIndex.length, filteredMLinksWithIndex.length)})`);
              }
            }
        }
    }

    if (hasMergedAny) {

        const signature = contentSignatureParts.join('|');
        if (generatedSignatures.has(signature)) {
             log("info", `${logPrefix} 检测到重复的合并结果 (Signature: ${signature})，已自动隐去冗余条目。`);
             return derivedAnime; 
        }
        generatedSignatures.add(signature);

        const joinedSources = actualMergedSources.join(DISPLAY_CONNECTOR);
        derivedAnime.animeTitle = derivedAnime.animeTitle.replace(`from ${currentPrimarySource}`, `from ${currentPrimarySource}${DISPLAY_CONNECTOR}${joinedSources}`);
        derivedAnime.source = currentPrimarySource;
        
        return derivedAnime;
    } 

    return null;
}

/**
 * 合集探测函数
 * 检测是否存在某个源将多季内容合并，而其他源是分季的情况
 * 引入标题保护逻辑，防止【Title】格式在清洗时丢失，导致分组失败
 * 引入中文数字转换，解决“第三季”与“第3季”清洗不一致问题
 * 引入 Part 聚合逻辑，确保 S1 + S1 Part 2 被正确计算为单季总量
 * 引入 内容分类隔离、多季先决条件、倍率上限
 * @param {Array} curAnimes 
 * @returns {Set<string>} 疑似合集的 Anime ID 集合
 */
function detectCollectionCandidates(curAnimes) {
    const collectionIds = new Set();
    if (!curAnimes || curAnimes.length === 0) return collectionIds;

    const cnNums = {'一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9', '十':'10'};
    // 按清洗后的 Base Title 分组
    const groups = new Map();

    // ==========================================================
    // 阶段一：分组与初筛 (Grouping & Pre-filtering)
    // ==========================================================
    curAnimes.forEach(anime => {
        // 获取完整数据对象，确保类型判断准确
        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
        const markers = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription);

        // [严格类型阻断] 在分组前直接排除非目标类型 (MOVIE/OVA/SP/SEQUEL)
        if (markers.has('MOVIE') || markers.has('OVA') || markers.has('SP') || markers.has('SEQUEL')) {
             return; 
        }

        const rawTitle = anime.animeTitle || '';
        
        // 标题保护逻辑：如果标题被包裹在【】或[]中且位于开头，尝试提取内容
        let protectedTitle = simplized(rawTitle);
        const startBracketMatch = protectedTitle.match(/^(?:【|\[)(.+?)(?:】|\])/);
        if (startBracketMatch) {
            const content = startBracketMatch[1];
            if (!/^(TV|剧场版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
                protectedTitle = protectedTitle.replace(startBracketMatch[0], content + ' ');
            }
        }

        // 中文数字转换，统一格式
        protectedTitle = protectedTitle.replace(/第([一二三四五六七八九十])季/g, (m, num) => `第${cnNums[num]}季`);

        // 基础清洗 (移除来源、年份、Meta)
        let clean = protectedTitle
            .replace(RE_SOURCE_TAG, '')
            .replace(RE_FROM_SUFFIX, '')
            .replace(RE_YEAR_TAG, '')
            .replace(RE_META_SUFFIX, '') 
            .trim();
        
        // 移除配音版本关键词 (中配/日配等)，确保不同配音版本能归入同一分组进行统计
        clean = clean.replace(RE_LANG_KEYWORDS_STRONG, '');
        
        // 移除特定后缀 (A's, StrikerS...)
        for (const mapItem of RE_SUFFIX_SPECIFIC_MAP) {
             clean = clean.replace(mapItem.regex, '');
        }

        // 移除歧义后缀 (S, II, III...)
        clean = clean.replace(RE_SUFFIX_AMBIGUOUS, '');
        
        // 移除标准季数/Part标记
        clean = clean
            .replace(/(?:第|S)\d+(?:季|期|部)/gi, '')
            .replace(/(?:Part|P)\s*\d+/gi, '')
            .trim();
        
        // 移除空格并转小写
        clean = clean.replace(/\s+/g, '').toLowerCase();

        if (!clean) return;

        // 获取内容分类 (REAL vs ANIME)
        // 将分类混入 GroupKey，确保动漫不会去和真人剧比对集数
        const category = getContentCategory(rawTitle, realAnime.typeDescription, realAnime.source);
        const groupKey = `${clean}|${category}`;

        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
        }
        groups.get(groupKey).push(anime);
    });

    // ==========================================================
    // 阶段二：组内统计与判定 (Analysis & Detection)
    // ==========================================================
    for (const [groupKey, list] of groups.entries()) {
        if (list.length < 2) continue;

        const [baseTitle, category] = groupKey.split('|');

        // 输出详细的分组详情日志
        const itemDetails = list.map(a => `   - [${a.source}] ${a.animeTitle}`).join('\n');
        log("info", `[Merge-Check] [合集探测] 正在检查分组: "${baseTitle}" [${category}] (包含 ${list.length} 个条目):\n${itemDetails}`);

        // 预聚合：按源统计各季度集数 (处理 Part 拆分)
        const sourceStats = new Map(); // Source -> { seasonCounts: {1:0, 2:0...}, maxSeason: 0, s1Candidates: [] }
        let groupGlobalMaxSeason = 0; // 全组最大季数记录

        list.forEach(anime => {
            const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
            const markers = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription);
            
            // 确定季度编号 (S2, S3...)
            let seasonNum = 1; // 默认为 S1
            for (const m of markers) {
                if (m.startsWith('S')) {
                    const num = parseInt(m.substring(1));
                    if (!isNaN(num)) seasonNum = num;
                }
            }

            // 检测标题中是否包含歧义后缀或续篇标识
            // 如果 seasonNum 仍为 1 (未检测到明确的 S2, S3)，但存在歧义标记 (如 "Title S")
            // 则强制将其视为 S2 (或更高)，避免将其集数误计入 S1 统计池
            if (seasonNum === 1) {
                const isSequel = markers.has('SEQUEL') || RE_SUFFIX_SEQUEL.test(realAnime.animeTitle);
                const isAmbiguous = markers.has('AMBIGUOUS') || RE_SUFFIX_AMBIGUOUS.test(realAnime.animeTitle);
                
                if (isSequel || isAmbiguous) {
                    seasonNum = 2; 
                    // [Debug] 输出季度判定日志
                    log("info", `[Merge-Check] [Detail] [${realAnime.source}] "${realAnime.animeTitle}" -> 判定为 S2 (Reason: Sequel/Ambiguous Suffix)`);
                }
            }

            if (seasonNum > groupGlobalMaxSeason) groupGlobalMaxSeason = seasonNum;

            // 计算有效正片集数，针对 dandan/animeko 源执行强力过滤以排除番外
            let validCount = 0;
            if (realAnime.links) {
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                    validCount = realAnime.links.filter((l, idx) => {
                        const rawTitle = l.title || l.name || '';
                        
                        // 1. 优先基于【原始无清洗】的文本进行特征检测
                        // 目的：防止 cleanText 将 "S1 ..." 标准化为 "第1季 ..." 从而导致 RE_SPECIAL_CHECK 失效
                        const rawContent = rawTitle.replace(RE_SOURCE_TAG, '').replace(RE_FROM_SUFFIX, '').trim();

                        if (RE_SPECIAL_CHECK.test(rawContent) || RE_DANDAN_IGNORE_EP.test(rawContent)) {
                             // log("info", `[Merge-Check] [Detail-Ep] [${realAnime.source}] 排除: "${rawTitle}" (Reason: Raw Title Pattern [S/C/SP+Digit])`);
                             return false;
                        }

                        // 2. 基础清洗后的检测 (保留原有逻辑作为补充)
                        const t = cleanText(rawTitle);
                        const rawTemp = t.replace(RE_SOURCE_TAG, '').replace(RE_FROM_SUFFIX, '').trim();

                        if (RE_SPECIAL_CHECK.test(t) || RE_DANDAN_IGNORE_EP.test(t)) {
                             // log("info", `[Merge-Check] [Detail-Ep] [${realAnime.source}] 排除: "${rawTitle}" (Reason: Cleaned Title Pattern)`);
                             return false;
                        }

                        // 3. 使用关键词强力排除非正片集数 (OVA, OAD, SP, OP, ED, Special...)
                        if (RE_MAP_EXCLUDE_KEYWORDS.test(rawTemp) || RE_MAP_EXCLUDE_KEYWORDS.test(rawTitle)) {
                            // log("info", `[Merge-Check] [Detail-Ep] [${realAnime.source}] 排除: "${rawTitle}" (Reason: Keyword Filter)`);
                            return false;
                        }

                        // 保留的集数记录
                        log("info", `[Merge-Check] [Detail-Ep] [${realAnime.source}] 保留: "${rawTitle}"`);
                        
                        return true;
                    }).length;
                } else {
                    validCount = realAnime.links.length;
                }
            }

            // 聚合到 Source
            if (!sourceStats.has(realAnime.source)) {
                sourceStats.set(realAnime.source, { 
                    seasonCounts: {}, 
                    maxSeason: 0,
                    s1Candidates: [] 
                });
            }
            const stat = sourceStats.get(realAnime.source);
            
            // 累加集数 (例如 S1 + S1 Part 2)
            if (!stat.seasonCounts[seasonNum]) stat.seasonCounts[seasonNum] = 0;
            stat.seasonCounts[seasonNum] += validCount;

            if (seasonNum > stat.maxSeason) stat.maxSeason = seasonNum;

            // 只有被认定为真正的 S1 时，才加入候选项
            if (seasonNum === 1) {
                stat.s1Candidates.push({ anime: realAnime, originalCount: validCount });
            }
        });

        // 多季特征先决条件：理论上都是 S1 的组意味着这个作品本身就没有季，没有季哪来的合集
        if (groupGlobalMaxSeason <= 1) {
             // log("info", `[Merge-Check] [合集探测] 跳过: [${baseTitle}] 全组均为 S1，无多季特征`);
             continue;
        }

        // 计算其他源的 S1 基准长度 (排除当前源)
        const allSources = Array.from(sourceStats.keys());

        for (const [source, stat] of sourceStats.entries()) {
            // 豁免：如果该源拥有 S2+ 独立条目，说明该源已分季，其 S1 不视为合集
            if (stat.maxSeason > 1) {
                continue;
            }

            // 计算对比基准：其他源的 S1 集数
            let maxOtherS1 = 0;
            let hasOtherSources = false;

            for (const otherSource of allSources) {
                if (otherSource === source) continue;
                const otherStat = sourceStats.get(otherSource);
                if (otherStat.seasonCounts[1]) {
                    hasOtherSources = true;
                    if (otherStat.seasonCounts[1] > maxOtherS1) {
                        maxOtherS1 = otherStat.seasonCounts[1];
                    }
                }
            }

            if (!hasOtherSources) continue;

            // 判定：如果当前源的 S1 总集数 > 其他源最大 S1 集数 + 阈值
            // 说明它可能包含了 S2，将其标记为合集
            const currentS1Total = stat.seasonCounts[1];
            const threshold = maxOtherS1 + 6;
            const ratio = maxOtherS1 > 0 ? (currentS1Total / maxOtherS1) : 0;

            if (currentS1Total > threshold) {
                // 上限检查：倍率不能超过 4.0 (防止长篇连载匹配到短篇)
                if (ratio > 4.0) {
                     log("info", `[Merge-Check] [合集探测] 拒绝: [${source}] ${baseTitle} (Ratio too high: ${ratio.toFixed(2)} > 4.0)`);
                     continue;
                }

                // 区分“单体巨头”和“分部聚合”
                // 1. 检查是否存在单个文件就已经超过阈值的“巨头”
                const giants = stat.s1Candidates.filter(c => c.originalCount > threshold);
                
                if (giants.length > 0) {
                    // 场景A: 存在单体合集 (如 24集版) - 只标记巨头
                    giants.forEach(cand => {
                        collectionIds.add(cand.anime.animeId);
                        log("info", `[Merge-Check] [合集探测] 发现疑似合集(单体): [${source}] ${cand.anime.animeTitle} (Count:${cand.originalCount} > Thr:${threshold}, Ratio:${ratio.toFixed(2)}) -> 标记为合集`);
                    });
                } else {
                    // 场景B: 单体都未超标，但总和超标 (Part1+Part2) - 标记全员
                    stat.s1Candidates.forEach(cand => {
                        collectionIds.add(cand.anime.animeId);
                        log("info", `[Merge-Check] [合集探测] 发现疑似合集(聚合): [${source}] ${cand.anime.animeTitle} (TotalS1:${currentS1Total} > Thr:${threshold}, Ratio:${ratio.toFixed(2)}) -> 标记为合集`);
                    });
                }
            } else {
                // 打印未命中日志
                log("info", `[Merge-Check] [合集探测] 未命中: [${source}] ${baseTitle} (TotalS1:${currentS1Total} <= Threshold:${threshold})`);
            }
        }
    }

    return collectionIds;
}

/**
 * 执行源合并逻辑 (入口函数)
 * 引入 CN 隔离逻辑 (Phase 1) -> 副源 CN 自组织 (Phase 1.5) -> 回退机制 (Phase 2)
 * Phase 2 增加排序逻辑：非CN主源优先执行，防止CN主源抢占通用资源
 * @param {Array} curAnimes 当前所有的动画条目列表 (将被就地修改)
 */
export async function applyMergeLogic(curAnimes) {
  const groups = globals.mergeSourcePairs; 
  if (!groups || groups.length === 0) return;

  log("info", `[Merge] 启动源合并策略，配置: ${JSON.stringify(groups)}`);

  let epFilter = globals.episodeTitleFilter;
  if (epFilter && typeof epFilter === 'string') {
      try { epFilter = new RegExp(epFilter, 'i'); } catch (e) { epFilter = null; }
  }

  // 执行合集探测
  const collectionAnimeIds = detectCollectionCandidates(curAnimes);

  const newMergedAnimes = [];
  
  const generatedSignatures = new Set();
  const globalConsumedIds = new Set();

  // 识别需要保留原始结果的单源配置 (防止被合并消耗)
  const keepSources = new Set();
  groups.forEach(g => {
      if (g.secondaries.length === 0) {
          keepSources.add(g.primary);
      }
  });

  for (const group of groups) {
    // 跳过纯保留配置，不进行合并处理
    if (group.secondaries.length === 0) continue;

    const groupConsumedIds = new Set();
    const fullPriorityList = [group.primary, ...group.secondaries];
    const groupFingerprint = fullPriorityList.join('&');

    // 外层循环：主源轮替
    for (let i = 0; i < fullPriorityList.length - 1; i++) {
      const currentPrimarySource = fullPriorityList[i];
      const availableSecondaries = fullPriorityList.slice(i + 1);

      // 获取当前主源的所有有效条目
      const allSourceItems = curAnimes.filter(a => a.source === currentPrimarySource);
      
      // 检查剩余可用源的数量（用于日志判断是否轮替）
      const activeRemainingSourcesCount = availableSecondaries.filter(secSrc => {
          return curAnimes.some(a => a.source === secSrc && !groupConsumedIds.has(a.animeId));
      }).length;
      
      if (allSourceItems.length === 0) {
        if (activeRemainingSourcesCount >= 2) {
             log("info", `[Merge] 轮替: 源 [${currentPrimarySource}] 无可用结果，尝试下一顺位.`);
        }
        continue; 
      }

      // =================================================================================
      // [Phase 1: Primary CN Isolation] 主源主导的 CN 隔离
      // =================================================================================
      // 只有当“当前主源”自己就是 CN 时才触发。
      // 目的：保护 CN 主源不被 JP 副源干扰。
      
      const validPrimaryItems = allSourceItems.filter(a => !groupConsumedIds.has(a.animeId));
      if (validPrimaryItems.length === 0) continue;

      const cnPrimaries = validPrimaryItems.filter(a => getLanguageType(a.animeTitle) === 'CN');
      
      // 检查副源是否有 CN 资源 (触发条件的开关)
      let hasCnInSecondaries = false;
      for (const secSrc of availableSecondaries) {
           if (curAnimes.some(a => a.source === secSrc && !groupConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN')) {
               hasCnInSecondaries = true;
               break;
           }
      }

      if (cnPrimaries.length > 0 && hasCnInSecondaries) {
          log("info", `[Merge] [Phase 1] 启动主源 CN 隔离: [${currentPrimarySource}] 包含 ${cnPrimaries.length} 个 CN 资源。`);
          
          for (const pAnime of cnPrimaries) {
              const resultAnime = await processMergeTask({
                  pAnime,
                  availableSecondaries,
                  curAnimes,
                  groupConsumedIds,
                  globalConsumedIds,
                  generatedSignatures,
                  epFilter,
                  groupFingerprint,
                  currentPrimarySource,
                  logPrefix: `[Merge][Phase 1: CN-Primary]`,
                  limitSecondaryLang: 'CN', // 强制只匹配 CN 副源
                  collectionAnimeIds
              });

              if (resultAnime) {
                  newMergedAnimes.push(resultAnime);
                  groupConsumedIds.add(pAnime.animeId);
                  globalConsumedIds.add(pAnime.animeId);
              } 
          }
      }

      // =================================================================================
      // [Phase 1.5: Secondary CN Self-Organization] 副源自组织 CN 隔离 (NEW!)
      // =================================================================================
      // 场景：主源可能是原版(无标)，但副源里有 Youku(助听) 和 iQiyi(助听)。
      // 目标：在主源介入前，先让 Youku 和 iQiyi 内部自行配对，防止被主源误吞。
      
      // 1. 统计剩余未消费的副源中有多少个 CN 资源
      let secondaryCnCount = 0;
      for (const secSrc of availableSecondaries) {
          const count = curAnimes.filter(a => 
              a.source === secSrc && 
              !groupConsumedIds.has(a.animeId) && 
              getLanguageType(a.animeTitle) === 'CN'
          ).length;
          secondaryCnCount += count;
      }

      // 只有当至少能凑成一对 (>=2) 时才启动
      if (secondaryCnCount >= 2) {
           log("info", `[Merge] [Phase 1.5] 启动副源 CN 自组织: 检测到副源池中有 ${secondaryCnCount} 个未消费的 CN 资源，尝试内部互联...`);

           // 遍历副源列表，将其中的 CN 资源“临时提拔”为主源
           // 注意：我们只遍历到倒数第二个，因为最后一个没法再配对了
           for (let j = 0; j < availableSecondaries.length - 1; j++) {
               const tempPrimarySrc = availableSecondaries[j];
               // 它的匹配对象只能是它“顺位后面”的副源 (防止逆向匹配导致死循环或重复)
               const tempSecondaries = availableSecondaries.slice(j + 1);

               // 找出该源下的 CN 候选人
               const tempPrimaryItems = curAnimes.filter(a => 
                   a.source === tempPrimarySrc && 
                   !groupConsumedIds.has(a.animeId) && 
                   getLanguageType(a.animeTitle) === 'CN'
               );

               for (const tAnime of tempPrimaryItems) {
                   const resultAnime = await processMergeTask({
                       pAnime: tAnime,
                       availableSecondaries: tempSecondaries, // 只能匹配它后面的副源
                       curAnimes,
                       groupConsumedIds,
                       globalConsumedIds,
                       generatedSignatures,
                       epFilter,
                       groupFingerprint,
                       currentPrimarySource: tempPrimarySrc, // 临时身份：主源
                       logPrefix: `[Merge][Phase 1.5: CN-Secondary]`,
                       limitSecondaryLang: 'CN', // 严格限制：只跟后面的 CN 配对
                       collectionAnimeIds
                   });

                   if (resultAnime) {
                       newMergedAnimes.push(resultAnime);
                       groupConsumedIds.add(tAnime.animeId); // 标记已消费，真正的主源就不会再碰它了
                       globalConsumedIds.add(tAnime.animeId);
                   }
               }
           }
      }

      // =================================================================================
      // [Phase 2: Standard Fallback] 标准合并 (兜底)
      // =================================================================================
      // 处理剩下的所有资源（包括 Phase 1 和 1.5 没匹配上的，以及非 CN 资源）
      
      let remainingPrimaryItems = allSourceItems.filter(a => !groupConsumedIds.has(a.animeId));

      // 主源排序优化：让 非CN 结果优先执行
      // 目的：避免 CN 结果（通常匹配分较低或容易误配）抢占了属于 JP 原版的高质量副源。
      // 排序规则：Non-CN 排在前面，CN 排在后面。
      if (remainingPrimaryItems.length > 1) {
          remainingPrimaryItems.sort((a, b) => {
              const isCnA = getLanguageType(a.animeTitle) === 'CN';
              const isCnB = getLanguageType(b.animeTitle) === 'CN';
              if (isCnA === isCnB) return 0;
              return isCnA ? 1 : -1;
          });
      }

      for (const pAnime of remainingPrimaryItems) {
          // 检查当前主源是否包含 Part 标识
          const markers = extractSeasonMarkers(pAnime.animeTitle, pAnime.typeDescription);
          const hasPart = Array.from(markers).some(m => m.startsWith('P'));
          const pSeasonNum = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription) || 1;
          
          let allowReuseIds = null;

          // 如果主源是 Part (如 S1 Part 2)，允许复用已被消费的、属于同一季度且非 Part 的副源
          if (hasPart) {
              allowReuseIds = new Set();
              log("info", `[Merge] 检测到主源 [${currentPrimarySource}] ${pAnime.animeTitle} 为 Part 类型，尝试寻找可复用的全集副源...`);

              // 扫描已消费的 globalConsumedIds，看看有没有符合条件的副源
              for (const consumedId of globalConsumedIds) {
                  const consumedAnime = globals.animes.find(a => String(a.animeId) === String(consumedId));
                  if (!consumedAnime) continue;

                  // 1. 必须是候选副源之一
                  if (!availableSecondaries.includes(consumedAnime.source)) continue;
                  
                  // 2. 检查副源是否也是 Part (如果是 Part，则不复用，避免 Part2 匹配到 Part1)
                  const secMarkers = extractSeasonMarkers(consumedAnime.animeTitle, consumedAnime.typeDescription);
                  const secHasPart = Array.from(secMarkers).some(m => m.startsWith('P'));
                  if (secHasPart) continue;

                  // 3. 检查季度是否一致
                  const sSeasonNum = getSeasonNumber(consumedAnime.animeTitle, consumedAnime.typeDescription) || 1;
                  if (pSeasonNum !== sSeasonNum) continue;

                  // 4. 符合条件：主源 Part 复用 副源 Full
                  allowReuseIds.add(consumedAnime.animeId);
              }
              if (allowReuseIds.size > 0) {
                  log("info", `[Merge] 已豁免 ${allowReuseIds.size} 个副源参与 Part 复用匹配。`);
              }
          }

          const resultAnime = await processMergeTask({
              pAnime,
              availableSecondaries,
              curAnimes,
              groupConsumedIds,
              globalConsumedIds,
              generatedSignatures,
              epFilter,
              groupFingerprint,
              currentPrimarySource,
              logPrefix: `[Merge][Phase 2: Standard]`,
              collectionAnimeIds, // 传递合集集合
              allowReuseIds // 传递豁免 ID 集合
          });

          if (resultAnime) {
              newMergedAnimes.push(resultAnime);
              groupConsumedIds.add(pAnime.animeId);
              globalConsumedIds.add(pAnime.animeId);
          }
      }
    } 
  } 

  if (newMergedAnimes.length > 0) {
     for (const anime of newMergedAnimes) {
         addAnime(anime);
     }
     curAnimes.unshift(...newMergedAnimes);
  }

  // 保护配置为单源保留的条目，将其从消耗列表中移除，确保原始条目不被删除
  if (keepSources.size > 0) {
      for (const anime of curAnimes) {
          if (globalConsumedIds.has(anime.animeId) && keepSources.has(anime.source)) {
              globalConsumedIds.delete(anime.animeId);
          }
      }
  }
  
  for (let i = curAnimes.length - 1; i >= 0; i--) {
    const item = curAnimes[i];
    if (item._isMerged || globalConsumedIds.has(item.animeId)) {
      curAnimes.splice(i, 1);
    }
  }
  
  log("info", `[Merge] 合并执行完毕，最终列表数量: ${curAnimes.length}`);
}

/**
 * 合并两个弹幕列表并按时间排序
 * @param {Array} listA 弹幕列表A
 * @param {Array} listB 弹幕列表B
 * @returns {Array} 合并后按时间升序排列的列表
 */
export function mergeDanmakuList(listA, listB) {
  const final = [...(listA || []), ...(listB || [])];
  
  const getTime = (item) => {
    if (!item) return 0;
    if (item.t !== undefined && item.t !== null) return Number(item.t);
    if (item.p && typeof item.p === 'string') {
      const pTime = parseFloat(item.p.split(',')[0]);
      return isNaN(pTime) ? 0 : pTime;
    }
    return 0;
  };

  final.sort((a, b) => {
    return getTime(a) - getTime(b);
  });
  
  return final;
}
