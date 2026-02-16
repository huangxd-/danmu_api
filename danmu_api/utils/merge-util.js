/**
 * merge-util.js
 * * [核心功能]
 * 多源番剧数据合并引擎。负责将异构来源（如 Bilibili, Tencent, Dandan 等）的番剧数据
 * 基于标题语义分析、集数加权对齐、发布时间窗口匹配进行智能聚合。
 * * [工程设计]
 * - Configuration: 核心算法权重与阈值集中管理，与业务逻辑分离。
 * - Performance: 采用正则缓存、结构化克隆、循环不变量提取等手段优化高频路径。
 * - Stability: 严格保留历史迭代产生的边缘情况处理（Edge Cases）和特定源适配逻辑。
 * - Documentation: 全量 JSDoc 覆盖，确保每一处业务逻辑都有据可查。
 * * @module merge-util
 */

import { globals } from '../configs/globals.js';
import { log as baseLog } from './log-util.js';
import { addAnime } from './cache-util.js';
import { simplized } from '../utils/zh-util.js';

// ==========================================
// 1. 核心配置与常量 (Immutable Configuration)
// ==========================================

/** * 定义组合ID的分隔符 (URL Safe) 
 * @constant {string} 
 */
export const MERGE_DELIMITER = '$$$';

/** * 定义前端显示的源连接符 
 * @constant {string} 
 */
export const DISPLAY_CONNECTOR = '&';

// 调试级别的日志开关 false/true
const ENABLE_VERBOSE_MERGE_LOG = false; 

/**
 * 核心算法权重配置
 * 集中管理所有评分逻辑中的增益与惩罚数值
 * @readonly
 */
const MergeWeights = Object.freeze({
    // 标题与结构
    TITLE_STRUCTURE_CONFLICT: -0.15, // 标题结构冲突（如父子集关系）
    LANG_MATCH_CN: 0.15,             // 双端均为中文时的奖励
    LANG_MISMATCH: -0.20,            // 语言不一致时的惩罚
    
    // 日期
    DATE_MATCH: 0.0,                 // 基础日期匹配（动态计算，此处为占位）
    
    // 集数对齐 (Alignment)
    EP_ALIGN: {
        MOVIE_TYPE_MISMATCH: -5.0,   // 电影/TV 类型不符
        SPECIAL_STRICT_MISMATCH: -8.0, // 正片与番外（SP/OVA）混淆
        LANG_MATCH: 3.0,             // 集标题语言一致
        LANG_MISMATCH: -5.0,         // 集标题语言不一致
        SEASON_NUM_MISMATCH: -10.0,  // 季度编号冲突
        SPECIAL_TYPE_MISMATCH: -10.0,// 特殊类型（OP/ED）不一致
        SPECIAL_TYPE_MATCH: 3.0,     // 特殊类型一致
        IS_SPECIAL_MATCH: 3.0,       // 是否为特殊集属性一致
        SEASON_SHIFT_EXACT: 15.0,    // 完美的季度偏移匹配（如 S2E1 -> S1E13）
        CN_STRICT_MATCH: 25.0,       // 中文严格 核心词命中且集数一致的奖励
        CN_STRICT_MISMATCH: -5.0,    // 中文严格 核心词包含但集数不同（防止同系列不同集数的误对齐）
        NUMERIC_MATCH: 2.0,          // 数字严格相等
        PATTERN_CONSISTENCY_BONUS: 2.0, // 强规律性奖励
        ZERO_DIFF_BONUS_BASE: 100.0,    // 零偏移的额外基准奖励
        ZERO_DIFF_BONUS_PER_HIT: 5.0    // 零偏移的单次命中奖励
    }
});

/**
 * 逻辑判定阈值
 * @readonly
 */
const Thresholds = Object.freeze({
    SIMILARITY_MIN: 0.6,             // 最低标题相似度
    SIMILARITY_STRONG: 0.98,         // 强匹配（Probe确认后）
    TIER_DEFAULT: 0.001,             // 默认分数梯度容差
    TIER_CN: 0.40,                   // 中文优先梯度容差
    TIER_PART: 0.50,                 // Part分部容差
    COLLECTION_RATIO: 4.0,           // 合集判定比率上限
    COLLECTION_DIFF: 6               // 合集判定数量差阈值
});

/**
 * 带有过滤功能的日志包装器
 * 拦截细碎的合并检查日志，仅在 ENABLE_VERBOSE_MERGE_LOG 为真时输出
 * @param {string} level - 日志级别
 * @param {...any} args - 日志内容
 */
function log(level, ...args) {
    const isMergeCheck = typeof args[0] === 'string' && args[0].includes('[Merge-Check]');
    if (isMergeCheck && !ENABLE_VERBOSE_MERGE_LOG) return;
    baseLog(level, ...args);
}

// ==========================================
// 2. 类型定义 (JSDoc Type Definitions)
// ==========================================

/**
 * @typedef {Object} EpisodeInfo
 * @property {boolean} isMovie - 是否为剧场版
 * @property {number|null} num - 解析出的集数编号
 * @property {boolean} isSpecial - 是否为广义特殊集 (SP, OVA, PV)
 * @property {boolean} isPV - 是否为预告
 * @property {number|null} season - 解析出的季度编号
 * @property {boolean} isStrictSpecial - 是否为严格定义的特殊集 (用于 dandan/animeko)
 */

/**
 * @typedef {Object} ProcessedLink
 * @property {Object} link - 原始链接对象
 * @property {EpisodeInfo} info - 提取的集信息
 * @property {string} effLang - 有效语言类型
 * @property {string|null} specialType - 特殊类型标记 (opening, ending 等)
 * @property {string} cleanEpText - 清洗后的集标题文本
 * @property {string|null} strictCnCore - 中文严格核心词
 */

/**
 * @typedef {Object} Anime
 * @property {string|number} animeId - 唯一ID
 * @property {string} animeTitle - 标题
 * @property {string} source - 来源
 * @property {Array} links - 集数列表
 * @property {string} typeDescription - 类型描述
 * @property {string} startDate - 开始日期
 * @property {Array<string>} [aliases] - 别名
 */

// ==========================================
// 3. 正则表达式仓库 (Regex Store)
// ==========================================

const RegexStore = {
    Lang: {
        CN: /(普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听)(?:版)?/,
        JP: /(日语|日配|原版|原声)(?:版)?/,
        CN_DUB_VER: /(\(|（|\[)?(普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听)版?(\)|）|\])?/g,
        JP_DUB_VER: /(\(|（|\[)?(日语|日配|原版|原声)版?(\)|）|\])?/g,
        KEYWORDS_STRONG: /(?:普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听|日语|日配|原版|原声)(?:版)?/g,
        CN_STD: /普通话|国语|中文配音|中配|中文|粤配|粤语|台配|台语|港配|港语|字幕|助听/g,
        JP_STD: /日语|日配|原版|原声/g
    },
    Season: {
        PURE_PART: /^(?:(?:第|S(?:eason)?)\s*\d+(?:季|期|部)?|(?:Part|P|第)\s*\d+(?:部分)?)$/i,
        PART_NORM: /第(\d+)部分/g,
        PART_NORM_2: /(?:Part|P)[\s.]*(\d+)/gi,
        FINAL: /(?:The\s+)?Final\s+Season/gi,
        NORM: /(?:Season|S)\s*(\d+)/gi,
        CN: /第([一二三四五六七八九十])季/g,
        ROMAN: /(\s|^)(IV|III|II|I)(\s|$)/g,
        INFO_STRONG: /(?:season|s|第)\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部(?!分))?/gi,
        PART_INFO_STRONG: /(?:part|p|第)\s*\d+\s*(?:部分)?/gi,
        PART_ANY: /(?:part|p)\s*\d+/gi,
        CN_STRUCTURE: /(?:^|\s|×\d+\s?)(承|转|结)(?=$|[\s\(\（\[【])/i,
        SUFFIX_AMBIGUOUS: /(?:[\s\u4e00-\u9fa5]|^)(S|T|R|II|III|IV)(?=$|[\s\(\（\[【])/i,
        SUFFIX_SEQUEL: /(?:续篇|续集|The Sequel)/i
    },
    Clean: {
        NA_TAG: /(\(|（|\[)N\/A(\)|）|\])/gi,
        SOURCE_TAG: /【.*?】/g,
        REGION_LIMIT: /(\(|（|\[)仅限.*?地区(\)|）|\])/g,
        PUNCTUATION: /[!！?？,，.。、~～:：\-–—_]/g,
        WHITESPACE: /\s+/g,
        FROM_SUFFIX: /\s*from\s+.*$/i,
        PARENTHESES_CONTENT: /(\(|（|\[).*?(\)|）|\])/g,
        MOVIE_KEYWORDS: /剧场版|the\s*movie|theatrical|movie|film|电影/gi,
        LONE_VER_CHAR: /(\s|^)版(\s|$)/g,
        NON_ALPHANUM_CN: /[^\u4e00-\u9fa5a-zA-Z0-9]/g,
        META_SUFFIX: /(\(|（|\[)(续篇|TV版|无修|未删减|完整版)(\)|）|\])/gi,
        YEAR_TAG: /(\(|（|\[)\d{4}(\)|）|\]).*$/i,
        SUBTITLE_SEPARATOR: /^[\s:：\-–—(（\[【]/,
        SPACE_STRUCTURE: /.+[\s\u00A0\u3000].+/,
        SPLIT_SPACES: /[\s\u00A0\u3000]+/,
        REDUNDANT_SEPARATOR: /[\s:：~～]/,
        REDUNDANT_UNSAFE_END: /[\(\（\[【:：~～\-]$/,
        REDUNDANT_VALID_CHARS: /[\u4e00-\u9fa5a-zA-Z]{2,}/
    },
    Episode: {
        SUFFIX_DIGIT: /_\d+(?=$|\s)/g,
        FILE_NOISE: /_(\d{2,4})(?=\.)/g,
        SEASON_PREFIX: /(?:^|\s)(?:第[0-9一二三四五六七八九十]+季|S(?:eason)?\s*\d+)(?:\s+|_)/gi,
        CLEAN_SMART: /(?:^|\s)(?:EP|E|Vol|Episode|No|Part|第)\s*\d+(?:\.\d+)?(?:\s*[话話集])?(?!\s*[季期部])/gi,
        PUNCTUATION: /[!！?？,，.。、~～:：\-–—]/g,
        DANDAN_TAG: /^【(dandan|animeko)】/i,
        SPECIAL_START: /^S\d+/i,
        MOVIE_CHECK: /剧场版|movie|film/i,
        PV_CHECK: /(pv|trailer|预告)/i,
        SPECIAL_CHECK: /^(s|o|sp|special)\d/i,
        SEASON_MATCH: /(?:^|\s)(?:第|S)(\d+)[季S]/i,
        NUM_STRATEGY_A: /(?:第|s)(\d+)[季s]\s*(?:第|ep|e)(\d+)/i,
        NUM_STRATEGY_B: /(?:ep|e|vol|episode|chapter|no|part|第)\s*(\d+(\.\d+)?)(?:\s*[话話集])?(?!\s*[季期部])/i,
        NUM_STRATEGY_C: /(?:^|\s)(?:第)?(\d+(\.\d+)?)(?:话|集|\s|$)/,
        DANDAN_IGNORE: /^[SC]\d+/i,
        MAP_EXCLUDE_KEYWORDS: /(?:^|\s)(?:PV|OP|ED|SP|Special|Drama|OAD|OVA|Opening|Ending|特番|特典|Behind\s+the\s+Scenes|Making|Interview)(?:\s|$|[:：])/i,
        SINK_TITLE_STRICT: /^(?:S\d+|C\d+|SP\d*|OP\d*|ED\d*|PV\d*|Trailers?|Interview|Making|特番|特典)(?:\s|$|[:：.\-]|\u3000)/i
    },
    Category: {
        ANIME_KW: /(动画|TV动画|动漫|日漫|国漫)/,
        REAL_KW: /(电视剧|真人剧|综艺|纪录片)/,
        ANIMEKO_SOURCE: /animeko/i
    },
    Similarity: {
        CN_STRICT_CORE_REMOVE: /[0-9a-zA-Z\s第季集话partEPep._\-–—:：【】()（）]/gi
    }
};

const SUFFIX_SPECIFIC_MAP = [
    { regex: /(?:\s|^)A's$/i, val: 'S2' },
    { regex: /(?:\s|^)StrikerS$/i, val: 'S3' },
    { regex: /(?:\s|^)ViVid$/i, val: 'S4' },
    { regex: /(?:\s|^)SuperS$/i, val: 'S4' } 
];

const SEASON_PATTERNS = [
  { regex: /(?:第)?(\d+)(?:季|期|部(?!分))/, prefix: 'S' }, 
  { regex: /season\s*(\d+)/, prefix: 'S' }, 
  { regex: /s(\d+)/, prefix: 'S' },         
  { regex: /part\s*(\d+)/, prefix: 'P' },   
  { regex: /(ova|oad)/, val: 'OVA' },
  { regex: /(剧场版|the\s*movie|theatrical|movie|film|电影)/, val: 'MOVIE' },
  { regex: /(续篇|续集)/, val: 'SEQUEL' },
  { regex: /sp/, val: 'SP' },
  { regex: /[^0-9](\d)$/, prefix: 'S', useCleaned: true } 
];

// ==========================================
// 3. 基础文本处理工具 (Utilities)
// ==========================================

/**
 * 识别文本语言类型 (CN/JP/Unspecified)
 * 用于后续的配音版本隔离和相似度算法选择
 * @param {string} text - 标题文本
 * @returns {'CN'|'JP'|'Unspecified'}
 */
function getLanguageType(text) {
  if (!text) return 'Unspecified';
  const t = text.toLowerCase();
  if (RegexStore.Lang.CN.test(t)) return 'CN';
  if (RegexStore.Lang.JP.test(t)) return 'JP';
  return 'Unspecified';
}

/**
 * 通用文本清洗
 * 包含：繁简转换、移除N/A标签、标准化季数格式、保护小数点、移除干扰符号
 * @param {string} text - 原始文本
 * @returns {string} - 清洗后的文本
 */
function cleanText(text) {
  if (!text) return '';
  let clean = simplized(text);
  
  clean = clean.replace(RegexStore.Clean.NA_TAG, '');
  clean = clean.replace(RegexStore.Season.PART_NORM, 'part $1');
  clean = clean.replace(RegexStore.Season.PART_NORM_2, 'part $1');
  clean = clean.replace(RegexStore.Season.FINAL, '最终季');
  clean = clean.replace(RegexStore.Season.NORM, '第$1季');
  
  const cnNums = {'一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9', '十':'10'};
  clean = clean.replace(RegexStore.Season.CN, (m, num) => `第${cnNums[num]}季`);
  clean = clean.replace(RegexStore.Season.ROMAN, (match, p1, roman, p2) => {
      const rMap = {'I':'1', 'II':'2', 'III':'3', 'IV':'4'};
      return `${p1}第${rMap[roman]}季${p2}`;
  });

  clean = clean.replace(RegexStore.Lang.CN_DUB_VER, '中配版');
  clean = clean.replace(RegexStore.Lang.JP_DUB_VER, '');
  clean = clean.replace(RegexStore.Clean.SOURCE_TAG, '');
  clean = clean.replace(RegexStore.Clean.REGION_LIMIT, '');
  clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');
  clean = clean.replace(RegexStore.Clean.PUNCTUATION, ' ');
  clean = clean.replace(/{{DOT}}/g, '.');
  
  return clean.replace(RegexStore.Clean.WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 相似度计算专用极简清洗
 * 强力移除所有季数、Part、括号内容、语言标识，只保留核心标题
 * @param {string} text - 原始标题
 * @returns {string} - 用于相似度计算的极简标题
 */
function cleanTitleForSimilarity(text) {
    if (!text) return '';
    let clean = simplized(text);
    // 标题保护逻辑：如果标题被包裹在【】或[]中且位于开头，尝试提取内容
    const startBracketMatch = clean.match(/^(?:【|\[)(.+?)(?:】|\])/);
    if (startBracketMatch) {
        const content = startBracketMatch[1];
        if (!/^(TV|剧场版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
             clean = clean.replace(startBracketMatch[0], content + ' ');
        }
    }
    clean = clean.replace(RegexStore.Clean.SOURCE_TAG, '');
    clean = clean.replace(RegexStore.Clean.FROM_SUFFIX, '');
    clean = clean.replace(RegexStore.Clean.NA_TAG, '');
    clean = clean.replace(RegexStore.Clean.PARENTHESES_CONTENT, ''); 
    clean = clean.replace(RegexStore.Season.INFO_STRONG, ''); 
    clean = clean.replace(RegexStore.Season.PART_INFO_STRONG, ''); 
    clean = clean.replace(RegexStore.Clean.MOVIE_KEYWORDS, '');
    clean = clean.replace(RegexStore.Lang.KEYWORDS_STRONG, ''); 
    clean = clean.replace(RegexStore.Clean.LONE_VER_CHAR, ''); 
    clean = clean.replace(RegexStore.Clean.NON_ALPHANUM_CN, '');
    return clean.toLowerCase();
}

/**
 * 集标题清洗
 * 移除 S1, EP, 第X话 等前缀，只保留集数描述或核心标题
 * @param {string} text - 原始集标题
 * @returns {string} - 清洗后的集标题
 */
function cleanEpisodeText(text) {
    if (!text) return '';
    let clean = simplized(text);
    clean = clean.replace(RegexStore.Episode.SUFFIX_DIGIT, ''); 
    clean = clean.replace(RegexStore.Episode.FILE_NOISE, '');
    clean = clean.replace(RegexStore.Episode.SEASON_PREFIX, ' ');
    clean = clean.replace(RegexStore.Episode.CLEAN_SMART, ' ');
    clean = clean.replace(RegexStore.Clean.SOURCE_TAG, '');
    clean = clean.replace(RegexStore.Lang.CN_STD, '中文');
    clean = clean.replace(RegexStore.Lang.JP_STD, '日文');
    clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');
    clean = clean.replace(RegexStore.Episode.PUNCTUATION, ' ');
    clean = clean.replace(/{{DOT}}/g, '.');
    return clean.replace(RegexStore.Clean.WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 移除括号内容
 * 用于提取主标题进行比对，规避副标题翻译差异
 * @param {string} text 
 * @returns {string}
 */
function removeParentheses(text) {
  if (!text) return '';
  return text.replace(RegexStore.Clean.PARENTHESES_CONTENT, '').trim();
}

/**
 * 清洗并提取真实的 ID/URL
 * 处理 MERGE_DELIMITER 分隔的 ID 字符串
 * @param {string} urlStr 
 * @returns {string}
 */
function sanitizeUrl(urlStr) {
  if (!urlStr) return '';
  let clean = String(urlStr).split(MERGE_DELIMITER)[0].trim();
  if (clean.startsWith('//')) return 'https:' + clean;
  const match = clean.match(/^([^:]+):(.+)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const body = match[2];
    if (prefix === 'http' || prefix === 'https') return clean;
    if (/^https?:\/\//i.test(body)) return body;
    if (body.startsWith('//')) return 'https:' + body;
    return body;
  }
  return clean;
}

/**
 * 解析日期字符串 (Year > 2030 视为无效)
 * @param {string} dateStr 
 * @returns {{year: number|null, month: number|null}}
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'N/A') return { year: null, month: null };
  const d = new Date(dateStr);
  const time = d.getTime();
  if (isNaN(time)) return { year: null, month: null };
  const year = d.getFullYear();
  if (year > 2030) return { year: null, month: null };
  return { year: year, month: d.getMonth() + 1 };
}

// ==========================================
// 4. 相似度计算工具 (Core Math)
// ==========================================

/**
 * 计算编辑距离 (Levenshtein Distance)
 * 空间复杂度优化为 O(min(m,n))
 * @param {string} s1 
 * @param {string} s2 
 * @returns {number} 距离值
 */
function editDistance(s1, s2) {
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;
  let prevRow = new Array(len2 + 1);
  let currRow = new Array(len2 + 1);
  for (let j = 0; j <= len2; j++) prevRow[j] = j;
  for (let i = 1; i <= len1; i++) {
    currRow[0] = i;
    const char1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= len2; j++) {
      const cost = char1 === s2.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost);
    }
    const temp = prevRow; prevRow = currRow; currRow = temp;
  }
  return prevRow[len2];
}

/**
 * 计算 Dice 相似度系数
 * 对语序不敏感，适用于词组相同但排列不同的情况
 * @param {string} s1 
 * @param {string} s2 
 * @returns {number} 相似度 0.0-1.0
 */
function calculateDiceSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const set1 = new Set(s1.replace(RegexStore.Clean.WHITESPACE, ''));
  const set2 = new Set(s2.replace(RegexStore.Clean.WHITESPACE, ''));
  const size1 = set1.size, size2 = set2.size;
  if (size1 === 0 && size2 === 0) return 1.0;
  if (size1 === 0 || size2 === 0) return 0.0;
  let intersection = 0;
  const [smaller, larger] = size1 < size2 ? [set1, set2] : [set2, set1];
  for (const char of smaller) if (larger.has(char)) intersection++;
  return (2.0 * intersection) / (size1 + size2);
}

/**
 * 计算综合相似度 (0.0 - 1.0)
 * 结合编辑距离、Dice系数和覆盖系数，解决长标题意译差异和包含关系
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number}
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = cleanTitleForSimilarity(str1);
  const s2 = cleanTitleForSimilarity(str2);
  if (s1 === s2) return 1.0;
  const len1 = s1.length, len2 = s2.length;
  const maxLen = Math.max(len1, len2), minLen = Math.min(len1, len2);
  
  if (s1.includes(s2) || s2.includes(s1)) {
    const lenRatio = minLen / maxLen;
    if (lenRatio > 0.5) return 0.8 + (lenRatio * 0.2); 
  }
  
  const distance = editDistance(s1, s2);
  const editScore = maxLen === 0 ? 1.0 : 1.0 - (distance / maxLen);
  const set1 = new Set(s1.replace(RegexStore.Clean.WHITESPACE, ''));
  const set2 = new Set(s2.replace(RegexStore.Clean.WHITESPACE, ''));
  const size1 = set1.size, size2 = set2.size;
  if (size1 === 0 || size2 === 0) return 0.0;
  let intersection = 0;
  const [smallerSet, largerSet] = size1 < size2 ? [set1, set2] : [set2, set1];
  for (const char of smallerSet) if (largerSet.has(char)) intersection++;
  const diceScore = (2.0 * intersection) / (size1 + size2);
  let overlapScore = 0;
  const minSize = Math.min(size1, size2);
  if (minSize > 2) {
      overlapScore = intersection / minSize;
      if (overlapScore > 0.6) {
          const sizeRatio = minSize / Math.max(size1, size2);
          if (sizeRatio < 0.6) overlapScore -= 0.25;
      }
  }
  return Math.max(editScore, diceScore, overlapScore);
}

// ==========================================
// 5. 领域逻辑：冲突检测与属性提取
// ==========================================

/**
 * 检测主副标题结构冲突
 * 例如：主标题是 "Title"，副标题是 "Title: Subtitle"
 * @param {string} titleA 
 * @param {string} titleB 
 * @param {boolean} [isDateValid=true] 
 * @returns {boolean}
 */
function checkTitleSubtitleConflict(titleA, titleB, isDateValid = true) {
    if (!titleA || !titleB) return false;
    if (cleanTitleForSimilarity(titleA) === cleanTitleForSimilarity(titleB)) return false;
    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str);
		s = s.replace(RegexStore.Clean.META_SUFFIX, '').replace(RegexStore.Clean.YEAR_TAG, '')
            .replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '')
            .replace(RegexStore.Clean.WHITESPACE, ' ');
        return s.trim().toLowerCase();
    };
    const t1 = lightClean(titleA), t2 = lightClean(titleB);
    if (t1 === t2) return false;
    const extractSubtitle = (fullTitle) => {
       const splitters = [':', '：', ' code:', ' code：', ' season', ' part'];
       for (const sep of splitters) {
           const idx = fullTitle.indexOf(sep);
           if (idx !== -1) return fullTitle.substring(idx).trim();
       }
       const spaceParts = fullTitle.split(RegexStore.Clean.WHITESPACE);
       if (spaceParts.length >= 2) return spaceParts.slice(1).join(' ');
       return null;
    };
    const sub1 = extractSubtitle(t1), sub2 = extractSubtitle(t2);
    const [short, long] = t1.length < t2.length ? [t1, t2] : [t2, t1];
    if (long.startsWith(short)) {
        if (long.length === short.length) return false;
        const nextChar = long[short.length];
        if (RegexStore.Clean.SUBTITLE_SEPARATOR.test(nextChar)) {
             const subtitle = long.slice(short.length).replace(RegexStore.Clean.SUBTITLE_SEPARATOR, '').trim();
             if (!isDateValid && subtitle.length > 1) return true;
             if (subtitle.length > 2) return true;
        }
    }
    if (sub1 && sub2) {
        const sim = calculateDiceSimilarity(sub1, sub2);
        if (sim < 0.2) return true;
    }
    return false;
}

/**
 * 提取季数和类型标记
 * 核心逻辑：区分 S1, S2, MOVIE, SP 以及 AMBIGUOUS 标记
 * @param {string} title 
 * @param {string} [typeDesc=''] 
 * @returns {Set<string>}
 */
function extractSeasonMarkers(title, typeDesc = '') {
  const markers = new Set();
  const t = cleanText(title); 
  const type = cleanText(typeDesc || '');
  const tWithoutParts = t.replace(RegexStore.Season.PART_ANY, '');
  const structMatch = tWithoutParts.match(RegexStore.Season.CN_STRUCTURE);
  if (structMatch) {
      const char = structMatch[1];
      if (char === '承') markers.add('S2');
      else if (char === '转') markers.add('S3');
      else if (char === '结') markers.add('S4');
  }
  SEASON_PATTERNS.forEach(p => {
    const targetText = p.useCleaned ? tWithoutParts : t;
    const match = targetText.match(p.regex);
    if (match) {
      if (p.prefix) markers.add(`${p.prefix}${parseInt(match[1])}`);
      else markers.add(p.val);
    }
  });
  let hitSpecific = false;
  for (const item of SUFFIX_SPECIFIC_MAP) {
      if (item.regex.test(tWithoutParts)) {
          markers.add(item.val);
          hitSpecific = true;
          break; 
      }
  }
  if (!hitSpecific) {
      const ambMatch = tWithoutParts.match(RegexStore.Season.SUFFIX_AMBIGUOUS);
      if (ambMatch) {
          markers.add('AMBIGUOUS');
          const suffix = ambMatch[1].toUpperCase();
          if (suffix === 'II') markers.add('S2');
          if (suffix === 'III') markers.add('S3');
          if (suffix === 'IV') markers.add('S4');
      }
  }
  if (RegexStore.Season.SUFFIX_SEQUEL.test(t) || type.includes('续篇')) markers.add('SEQUEL');
  if (type.includes('剧场版') || type.includes('movie') || type.includes('film') || type.includes('电影')) markers.add('MOVIE');
  if (type.includes('ova') || type.includes('oad')) markers.add('OVA');
  if (type.includes('sp') || type.includes('special')) markers.add('SP');
  const cnNums = {'一':1, '二':2, '三':3, '四':4, '五':5, 'final': 99};
  for (const [cn, num] of Object.entries(cnNums)) {
    if (t.includes(`第${cn}季`)) markers.add(`S${num}`);
  }
  const hasSeason = Array.from(markers).some(m => m.startsWith('S'));
  const hasPart = Array.from(markers).some(m => m.startsWith('P'));
  const hasAmbiguous = markers.has('AMBIGUOUS');
  const hasSequel = markers.has('SEQUEL');
  const isTypeSpecial = markers.has('MOVIE') || markers.has('OVA') || markers.has('SP');
  if (hasPart && !hasSeason) markers.add('S1');
  if (!hasSeason && !hasPart && !hasAmbiguous && !hasSequel && !isTypeSpecial) markers.add('S1');
  return markers;
}

/**
 * 辅助：从标题中提取明确的季度编号 (1, 2, 3...)
 * @param {string} title 
 * @param {string} [typeDesc=''] 
 * @returns {number|null}
 */
function getSeasonNumber(title, typeDesc = '') {
    const markers = extractSeasonMarkers(title, typeDesc);
    let maxSeason = null;
    for (const m of markers) {
        if (m.startsWith('S')) {
            const num = parseInt(m.substring(1));
            if (!isNaN(num)) {
                if (maxSeason === null || num > maxSeason) maxSeason = num;
            }
        }
    }
    return maxSeason;
}

/**
 * 获取严格的媒体类型标识 (TV vs Movie)
 * @param {string} title 
 * @param {string} typeDesc 
 * @returns {'TV'|'MOVIE'|null}
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
 * @param {string} title 
 * @param {string} typeDesc 
 * @param {string} source 
 * @returns {'ANIME'|'REAL'|'UNKNOWN'}
 */
function getContentCategory(title, typeDesc, source) {
    if (source && RegexStore.Category.ANIMEKO_SOURCE.test(source)) return 'ANIME';
    const fullText = (title + ' ' + (typeDesc || '')).toLowerCase();
    if (RegexStore.Category.ANIME_KW.test(fullText)) return 'ANIME';
    if (RegexStore.Category.REAL_KW.test(fullText)) return 'REAL';
    return 'UNKNOWN';
}

/**
 * 检查是否满足“剧场版”结构豁免条件
 * 防止包含 Part/Season 的标题被误判为普通剧场版
 * @param {string} titleA 
 * @param {string} titleB 
 * @param {string} typeDescA 
 * @param {string} typeDescB 
 * @returns {boolean}
 */
function checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB) {
    const isTheatrical = (typeDescA || '').includes('剧场版') || (typeDescB || '').includes('剧场版');
    if (!isTheatrical) return false;
    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str).replace(RegexStore.Clean.YEAR_TAG, '').replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '');
        return s.trim();
    };
    const t1 = lightClean(titleA), t2 = lightClean(titleB);
    if (RegexStore.Clean.SPACE_STRUCTURE.test(t1) && RegexStore.Clean.SPACE_STRUCTURE.test(t2)) {
        const extractSub = (s) => {
            const parts = s.split(RegexStore.Clean.SPLIT_SPACES);
            return parts.length > 1 ? parts.slice(1).join(' ') : '';
        };
        const sub1 = extractSub(t1), sub2 = extractSub(t2);
        if (RegexStore.Season.PURE_PART.test(sub1) || RegexStore.Season.PURE_PART.test(sub2)) return false;
        return true;
    }
    return false;
}

/**
 * 校验媒体类型是否冲突 (真人 vs 动漫, TV vs Movie)
 * @returns {boolean} true=冲突, false=兼容
 */
function checkMediaTypeMismatch(titleA, titleB, typeDescA, typeDescB, countA, countB, sourceA = '', sourceB = '') {
    const catA = getContentCategory(titleA, typeDescA, sourceA);
    const catB = getContentCategory(titleB, typeDescB, sourceB);
    if ((catA === 'REAL' && catB === 'ANIME') || (catA === 'ANIME' && catB === 'REAL')) return true;
    const mediaA = getStrictMediaType(titleA, typeDescA);
    const mediaB = getStrictMediaType(titleB, typeDescB);
    if (!mediaA || !mediaB || mediaA === mediaB) return false;
    if (checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB)) return false;
    const hasValidCounts = countA > 0 && countB > 0;
    if (hasValidCounts) {
        const diff = Math.abs(countA - countB);
        if (diff > 5) return true;
        return false;
    }
    return true; 
}

/**
 * 校验季度/续作标记是否冲突
 * @returns {boolean} true=冲突, false=兼容
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
    if ((hasAmbiguous(markersA) && hasS1(markersB)) || (hasAmbiguous(markersB) && hasS1(markersA))) return true;
    if ((hasAmbiguous(markersA) && (hasS2OrMore(markersB) || hasSequel(markersB))) ||
        (hasAmbiguous(markersB) && (hasS2OrMore(markersA) || hasSequel(markersA)))) return false; 
    if ((hasS2OrMore(markersA) && hasSequel(markersB)) || (hasS2OrMore(markersB) && hasSequel(markersA))) return false;
    for (const m of markersA) {
        if (m.startsWith('S')) {
            const hasSameS = markersB.has(m);
            const bHasAnyS = Array.from(markersB).some(b => b.startsWith('S'));
            if (!hasSameS && bHasAnyS) return true;
        }
    }
    return false; 
  }
  if (markersA.size !== markersB.size) {
      if (checkTheatricalExemption(titleA, titleB, typeA, typeB)) return false;
      return true;
  }
  return false;
}

/**
 * 检查是否包含相同的季度标记
 * @returns {boolean}
 */
function hasSameSeasonMarker(titleA, titleB, typeA, typeB) {
  const markersA = extractSeasonMarkers(titleA, typeA);
  const markersB = extractSeasonMarkers(titleB, typeB);
  const seasonsA = Array.from(markersA).filter(m => m.startsWith('S'));
  const seasonsB = Array.from(markersB).filter(m => m.startsWith('S'));
  if (seasonsA.length > 0 && seasonsB.length > 0) return seasonsA.some(sa => seasonsB.includes(sa));
  return false;
}

/**
 * 校验日期匹配度
 * @param {Object} dateA 
 * @param {Object} dateB 
 * @param {boolean} [isDub=false] 配音版允许10年误差
 * @returns {number} 得分修正
 */
function checkDateMatch(dateA, dateB, isDub = false) {
  if (!dateA.year || !dateB.year) return 0.05;
  const yearDiff = dateA.year - dateB.year; 
  if (yearDiff === 0) {
    if (dateA.month && dateB.month) {
      const monthDiff = Math.abs(dateA.month - dateB.month);
      if (monthDiff > 2) return 0;
      return monthDiff === 0 ? 0.2 : 0.1;
    }
    return 0.1;
  }
  const absDiff = Math.abs(yearDiff);
  if (isDub && absDiff <= 10) return 0; 
  if (absDiff > 1) return -1;
  return 0;
}

/**
 * 验证合并覆盖率
 * 防止剧场版误匹配TV版等低覆盖率情况
 * @returns {boolean} 是否允许合并
 */
function isMergeRatioValid(mergedCount, totalA, totalB, sourceA, sourceB, isAnyCollection = false) {
    if (sourceA === 'animeko' || sourceB === 'animeko') return true; 
    if (isAnyCollection) {
        const minTotal = Math.min(totalA, totalB);
        if (minTotal > 0 && (mergedCount / minTotal) > 0.5) return true;
        if (mergedCount < 2) return false;
        return true; 
    }
    const maxTotal = Math.max(totalA, totalB);
    if (maxTotal === 0) return false;
    const ratio = mergedCount / maxTotal;
    if (maxTotal > 5 && ratio < 0.18) return false;
    return true;
}

/**
 * 上下文感知续作检测
 * @param {Array<Anime>} secondaryList 
 * @returns {Map<string, string>} ID到BaseTitle的映射
 */
function detectPeerContextSequels(secondaryList) {
    const contextMap = new Map();
    if (!secondaryList || secondaryList.length < 2) return contextMap;
    const items = secondaryList.map(item => {
        const raw = item.animeTitle || '';
        const clean = cleanText(raw).replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
        return { id: item.animeId, raw, clean };
    });
    const baseTitles = new Set(items.map(i => i.clean));
    for (const item of items) {
        let baseCandidate = null;
        for (const mapItem of SUFFIX_SPECIFIC_MAP) {
            const m = item.clean.match(mapItem.regex);
            if (m) {
                baseCandidate = item.clean.replace(mapItem.regex, '').trim();
                break;
            }
        }
        if (!baseCandidate) {
            const m = item.clean.match(RegexStore.Season.SUFFIX_AMBIGUOUS);
            if (m) {
                const suffix = m[1];
                if (item.clean.endsWith(suffix)) baseCandidate = item.clean.substring(0, item.clean.length - suffix.length).trim();
            }
        }
        if (baseCandidate && baseCandidate.length > 1 && baseTitles.has(baseCandidate)) {
            contextMap.set(String(item.id), baseCandidate);
            log("info", `[Merge-Check] 上下文感知: 判定 [${item.raw}] 为续作 (Base: "${baseCandidate}" 同时也存在于列表)`);
        }
    }
    return contextMap;
}

/**
 * 探测集内容匹配情况 (Content Probe)
 * 通过抽样对比集标题，判断是否强匹配或强不匹配
 * @param {Anime} primaryAnime 
 * @param {Anime} candidateAnime 
 * @returns {{isStrongMatch: boolean, isStrongMismatch: boolean}}
 */
function probeContentMatch(primaryAnime, candidateAnime) {
    const result = { isStrongMatch: false, isStrongMismatch: false };
    if (!primaryAnime.links || !candidateAnime.links) return result;
    if (primaryAnime.links.length === 0 || candidateAnime.links.length === 0) return result;
    const countEpisodes = (links) => links.filter(l => {
        const t = (l.title || l.name || '').toLowerCase();
        return !RegexStore.Episode.PV_CHECK.test(t) && !RegexStore.Episode.SPECIAL_CHECK.test(t);
    }).length;
    const countP = countEpisodes(primaryAnime.links);
    const countS = countEpisodes(candidateAnime.links);
    if (countP > 5 && countS > 5) {
        const ratio = Math.min(countP, countS) / Math.max(countP, countS);
        if (ratio < 0.4) { /* ... */ }
    }
    const getEpTitles = (links) => links.map(l => {
        const t = cleanEpisodeText(l.title || l.name || '');
        return t.replace(/\d+/g, '').trim(); 
    }).filter(t => t.length > 1);
    const titlesP = getEpTitles(primaryAnime.links);
    const titlesS = getEpTitles(candidateAnime.links);
    if (titlesP.length < 3 || titlesS.length < 3) return result;
    const langP = getLanguageType(titlesP.join(' '));
    const langS = getLanguageType(titlesS.join(' '));
    if (langP !== langS || langP === 'Unspecified') return result;
    const sampleSize = Math.min(titlesP.length, titlesS.length, 5);
    let matchHits = 0, mismatchHits = 0;
    let logSamples = [];
    for (let i = 0; i < sampleSize; i++) {
        const idxP = Math.floor(i * titlesP.length / sampleSize);
        const idxS = Math.floor(i * titlesS.length / sampleSize);
        const sim = calculateSimilarity(titlesP[idxP], titlesS[idxS]);
        if (i < 3) logSamples.push(`"${titlesP[idxP]}" vs "${titlesS[idxS]}" (${sim.toFixed(2)})`);
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

// ==========================================
// 6. 核心匹配逻辑 (Search & Match)
// ==========================================

/**
 * 在副源列表中寻找最佳匹配的动画对象列表
 * 包含：上下文感知、集内容探测、中配优先、Tier筛选
 * @param {Anime} primaryAnime 
 * @param {Array<Anime>} secondaryList 
 * @param {Set<string|number>} collectionAnimeIds 
 * @returns {Array<Anime>}
 */
export function findSecondaryMatches(primaryAnime, secondaryList, collectionAnimeIds = new Set()) {
  if (!secondaryList || secondaryList.length === 0) return [];

  // [性能优化] 循环不变量提取 (Loop Invariant Extraction)
  const rawPrimaryTitle = primaryAnime.animeTitle || '';
  const primaryTitleForSim = rawPrimaryTitle.replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim();
  const isPrimaryDub = !!(primaryTitleForSim.match(RegexStore.Lang.CN_DUB_VER)) || RegexStore.Lang.CN.test(primaryTitleForSim);
  const isPrimaryIgnoredYear = primaryAnime.source === 'hanjutv';
  const primaryDate = (rawPrimaryTitle.includes('N/A') || isPrimaryIgnoredYear) ? { year: null, month: null } : parseDate(primaryAnime.startDate);
  const primaryCount = primaryAnime.episodeCount || (primaryAnime.links ? primaryAnime.links.length : 0);
  const primaryLang = getLanguageType(rawPrimaryTitle);

  const primaryCleanForZhi = cleanText(primaryTitleForSim);
  const cleanPrimarySim = cleanTitleForSimilarity(primaryTitleForSim);
  const baseA = removeParentheses(primaryTitleForSim);
  const markersP = extractSeasonMarkers(rawPrimaryTitle, primaryAnime.typeDescription);
  const seasonsP = Array.from(markersP).filter(m => m.startsWith('S'));

  // 上下文感知准备
  const combinedForContext = [{ animeId: primaryAnime.animeId, animeTitle: rawPrimaryTitle }, ...secondaryList];
  const ambiguousSequelsMap = detectPeerContextSequels(combinedForContext);
  const isPrimaryContextSequel = ambiguousSequelsMap.has(String(primaryAnime.animeId));
  const primaryBaseTitleFromContext = ambiguousSequelsMap.get(String(primaryAnime.animeId));
  const isPrimaryCollection = collectionAnimeIds.has(primaryAnime.animeId);

  const logReason = (secTitle, reason) => {
      log("info", `[Merge-Check] 拒绝: [${primaryAnime.source}] ${rawPrimaryTitle} vs [${secTitle}] -> ${reason}`);
  };

  let validCandidates = [];
  let maxScore = 0;

  for (const secAnime of secondaryList) {
    const rawSecTitle = secAnime.animeTitle || '';
    const isSecCollection = collectionAnimeIds.has(secAnime.animeId);
    const isAnyCollection = isPrimaryCollection || isSecCollection;
    const isSecIgnoredYear = secAnime.source === 'hanjutv';
    const secDate = (rawSecTitle.includes('N/A') || isSecIgnoredYear) ? { year: null, month: null } : parseDate(secAnime.startDate);
    const secLang = getLanguageType(rawSecTitle);
    const secTitleForSim = rawSecTitle.replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim();
    const isSecDub = !!(secTitleForSim.match(RegexStore.Lang.CN_DUB_VER)) || RegexStore.Lang.CN.test(secTitleForSim);
    const isDubRelation = isPrimaryDub || isSecDub;
    const secCount = secAnime.episodeCount || (secAnime.links ? secAnime.links.length : 0);
    
    // 之字结构强阻断
    if (secTitleForSim.includes('之')) {
        const parts = secTitleForSim.split('之');
        const prefix = cleanText(parts[0]); 
        if (primaryCleanForZhi === prefix) {
            logReason(rawSecTitle, `结构冲突: 主标题是副标题的前缀父集 (Prefix: "${prefix}")`);
            continue;
        }
    }

    if (checkMediaTypeMismatch(rawPrimaryTitle, rawSecTitle, primaryAnime.typeDescription, secAnime.typeDescription, primaryCount, secCount, primaryAnime.source, secAnime.source)) {
        const pType = getContentCategory(rawPrimaryTitle, primaryAnime.typeDescription, primaryAnime.source);
        const sType = getContentCategory(rawSecTitle, secAnime.typeDescription, secAnime.source);
        logReason(rawSecTitle, `媒体类型不匹配 (P:${pType}/${getStrictMediaType(rawPrimaryTitle, primaryAnime.typeDescription)} vs S:${sType}/${getStrictMediaType(rawSecTitle, secAnime.typeDescription)})`);
        continue;
    }

    const isDateValid = (primaryDate.year !== null && secDate.year !== null);
    const hasStructureConflict = checkTitleSubtitleConflict(rawPrimaryTitle, rawSecTitle, isDateValid);

    // 上下文 Sequel 阻断
    const isAmbiguousSequel = ambiguousSequelsMap.has(String(secAnime.animeId));
    if (isAmbiguousSequel) {
        const baseTitleOfSec = ambiguousSequelsMap.get(String(secAnime.animeId));
        if (cleanPrimarySim === cleanTitleForSimilarity(baseTitleOfSec)) {
             const primaryHasSuffix = RegexStore.Season.SUFFIX_AMBIGUOUS.test(primaryCleanForZhi) || SUFFIX_SPECIFIC_MAP.some(x => x.regex.test(primaryCleanForZhi));
             if (!primaryHasSuffix) {
                 logReason(rawSecTitle, `上下文阻断: 主源(S1) vs 副源(S2/S续作) (Base: "${baseTitleOfSec}")`);
                 continue;
             }
        }
    }
    
    if (isPrimaryContextSequel) {
         if (cleanTitleForSimilarity(secTitleForSim) === cleanTitleForSimilarity(primaryBaseTitleFromContext)) {
             logReason(rawSecTitle, `上下文阻断: 主源(S2/Sequel) vs 副源(Base/S1) (Base: "${primaryBaseTitleFromContext}")`);
             continue;
         }
    }

    if (!isDateValid && hasStructureConflict) {
        logReason(rawSecTitle, `标题结构冲突且日期无效`);
        continue;
    }

    const isSeasonExactMatch = hasSameSeasonMarker(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription);
    const contentProbe = probeContentMatch(primaryAnime, secAnime);

    const hasMovieA = rawPrimaryTitle.search(RegexStore.Clean.MOVIE_KEYWORDS) !== -1;
    const hasMovieB = rawSecTitle.search(RegexStore.Clean.MOVIE_KEYWORDS) !== -1;

    if (hasMovieA !== hasMovieB) {
        const markersA = markersP; // Reused
        const markersB = extractSeasonMarkers(rawSecTitle, secAnime.typeDescription);
        const stripMovie = (t) => cleanTitleForSimilarity(t.replace(RegexStore.Clean.MOVIE_KEYWORDS, ''));
        const cleanA = stripMovie(rawPrimaryTitle);
        const cleanB = stripMovie(rawSecTitle);
        if (calculateSimilarity(cleanA, cleanB) > 0.9) {
            if (!markersA.has('SEQUEL') && !markersB.has('SEQUEL')) {
                logReason(rawSecTitle, `剧场版标题阻断: [${hasMovieA ? 'Movie' : 'TV'}] vs [${hasMovieB ? 'Movie' : 'TV'}] (无续篇标识)`);
                continue;
            }
        }
    }

    const dateScore = isAnyCollection ? 0 : checkDateMatch(primaryDate, secDate, isDubRelation);
    if (dateScore === -1) {
        let allowExemption = isSeasonExactMatch;
        if (contentProbe.isStrongMatch) allowExemption = true;
        if (isAnyCollection) allowExemption = true;
        if (hasStructureConflict && !isAnyCollection) allowExemption = false;
        if (allowExemption && primaryDate.year && secDate.year) {
             const yearDiff = Math.abs(primaryDate.year - secDate.year);
             if (yearDiff > 2 && !contentProbe.isStrongMatch && !isAnyCollection) allowExemption = false;
        }
        if (!allowExemption) {
            logReason(rawSecTitle, `日期严重不匹配且无豁免 (P:${primaryDate.year} vs S:${secDate.year}, IsDub:${isDubRelation})`);
            continue;
        }
    }

    if (!isAnyCollection && checkSeasonMismatch(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription)) {
        if (contentProbe.isStrongMatch) {
            log("info", `[Merge-Check] 季度冲突豁免: [${rawPrimaryTitle}] vs [${rawSecTitle}] (Probe强匹配)`);
        } else {
            logReason(rawSecTitle, `季度标记冲突`);
            continue; 
        }
    }

    const secCandidates = [secTitleForSim];
    if (secAnime.aliases && Array.isArray(secAnime.aliases)) {
        secAnime.aliases.forEach(alias => {
            let cleanAlias = alias.replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim();
            if (cleanAlias) secCandidates.push(cleanAlias);
        });
    }

    let bestScoreFull = 0, bestScoreBase = 0;
    for (const candTitle of secCandidates) {
        const sFull = calculateSimilarity(primaryTitleForSim, candTitle);
        if (sFull > bestScoreFull) bestScoreFull = sFull;
        const candBase = removeParentheses(candTitle);
        const sBase = calculateSimilarity(baseA, candBase);
        if (sBase > bestScoreBase) bestScoreBase = sBase;
    }

    let score = Math.max(bestScoreFull, bestScoreBase);
    const originalScore = score;
    if (hasStructureConflict) score += MergeWeights.TITLE_STRUCTURE_CONFLICT;
    if (dateScore !== -1) score += dateScore;

    const isPrimaryCn = (primaryLang === 'CN');
    const isSecCn = (secLang === 'CN');
    if (isPrimaryCn && isSecCn) score += MergeWeights.LANG_MATCH_CN;
    else if (isPrimaryCn !== isSecCn) score += MergeWeights.LANG_MISMATCH;

    if (contentProbe.isStrongMatch) {
        log("info", `[Merge-Check] 集内容探测: 强匹配! 提升分数 (原分: ${score.toFixed(2)}) -> ${Thresholds.SIMILARITY_STRONG}`);
        score = Math.max(score, Thresholds.SIMILARITY_STRONG);
    } else if (contentProbe.isStrongMismatch) {
        logReason(rawSecTitle, `集内容探测: 强不匹配 (集标题/内容差异巨大)`);
        score = 0; 
    }

    if (score < Thresholds.SIMILARITY_MIN) {
        const cleanA = cleanPrimarySim;
        const cleanB = cleanTitleForSimilarity(secTitleForSim);
        logReason(rawSecTitle, `相似度不足: ${score.toFixed(2)} (Raw:${originalScore.toFixed(2)}, CleanA:"${cleanA}", CleanB:"${cleanB}")`);
    } else {
        if (score > maxScore) maxScore = score;
        validCandidates.push({ anime: secAnime, score: score, lang: secLang, debugTitle: rawSecTitle });
        log("info", `[Merge-Check] 候选选中: ${rawSecTitle} Score=${score.toFixed(2)} (BestSoFar=${maxScore.toFixed(2)})`);
    }
  }

  if (validCandidates.length === 0 || maxScore < Thresholds.SIMILARITY_MIN) return [];

  const finalResults = validCandidates.filter(candidate => {
      if (candidate.score >= (maxScore - Thresholds.TIER_DEFAULT)) return true;
      if ((candidate.lang === 'CN') && (candidate.score >= (maxScore - Thresholds.TIER_CN))) return true;
      const markersC = extractSeasonMarkers(candidate.debugTitle, candidate.anime.typeDescription);
      const hasPart = Array.from(markersC).some(m => m.startsWith('P'));
      if (hasPart && (candidate.score >= (maxScore - Thresholds.TIER_PART))) {
          const seasonsC = Array.from(markersC).filter(m => m.startsWith('S'));
          if (seasonsP.length > 0 && seasonsC.length > 0) {
              const hasIntersection = seasonsP.some(sp => seasonsC.includes(sp));
              if (hasIntersection) return true;
          } else return true; 
      }
      return false;
  });

  finalResults.sort((a, b) => b.score - a.score);
  return finalResults.map(item => item.anime);
}

// ==========================================
// 8. 集数操作与对齐 (Episode Logic)
// ==========================================

/**
 * 判断集标题是否属于特殊的类型 (OP/ED/Interview)
 * @param {string} title 
 * @returns {string|null}
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
 * 提取集数信息
 * 包含对 dandan/animeko 源的特殊番外检测逻辑
 * @param {string} title 
 * @param {string} sourceName 
 * @returns {EpisodeInfo}
 */
function extractEpisodeInfo(title, sourceName = '') {
  let isStrictSpecial = false;
  let effectiveSource = sourceName;
  if (title) {
      const tagMatch = title.match(RegexStore.Episode.DANDAN_TAG);
      if (tagMatch) effectiveSource = tagMatch[1].toLowerCase();
  }
  const isDandanOrAnimeko = /^(dandan|animeko)$/i.test(effectiveSource);
  if (isDandanOrAnimeko && title) {
      let rawTemp = title.replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
      if (RegexStore.Episode.SPECIAL_START.test(rawTemp) || RegexStore.Episode.DANDAN_IGNORE.test(rawTemp)) {
          isStrictSpecial = true;
      }
  }
  const t = cleanText(title || "");
  const isMovie = RegexStore.Episode.MOVIE_CHECK.test(t);
  const isPV = RegexStore.Episode.PV_CHECK.test(t);
  let num = null, season = null;
  const specialTypeTag = getSpecialEpisodeType(title);
  const isSpecial = isPV || isStrictSpecial || !!specialTypeTag || RegexStore.Episode.SPECIAL_CHECK.test(t);
  const seasonMatch = t.match(RegexStore.Episode.SEASON_MATCH);
  if (seasonMatch) season = parseInt(seasonMatch[1]);
  const seasonEpMatch = t.match(RegexStore.Episode.NUM_STRATEGY_A);
  if (seasonEpMatch) num = parseFloat(seasonEpMatch[2]);
  else {
      const strongPrefixMatch = t.match(RegexStore.Episode.NUM_STRATEGY_B);
      if (strongPrefixMatch) num = parseFloat(strongPrefixMatch[1]);
      else {
        const weakPrefixMatch = t.match(RegexStore.Episode.NUM_STRATEGY_C);
        if (weakPrefixMatch) num = parseFloat(weakPrefixMatch[1]);
      }
  }
  return { isMovie, num, isSpecial, isPV, season, isStrictSpecial };
}

/**
 * 过滤无效剧集 (基于标题正则)
 * @param {Array} links 
 * @param {RegExp} filterRegex 
 * @returns {Array}
 */
function filterEpisodes(links, filterRegex) {
  if (!links) return [];
  if (!filterRegex) return links.map((link, index) => ({ link, originalIndex: index }));
  return links
    .map((link, index) => ({ link, originalIndex: index }))
    .filter(item => {
      const title = item.link.title || item.link.name || "";
      return !filterRegex.test(title);
    });
}

/**
 * [性能优化] 冗余标题正则缓存
 * 避免在循环中重复编译完全相同的正则表达式
 */
const _redundantTitleRegexCache = new Map();

/**
 * 识别并提取冗余的系列标题前缀
 * (例如：所有集数标题都是 "Series Title : Episode X"，则 "Series Title : " 为冗余)
 * @param {Array} links 
 * @param {string} seriesTitle 
 * @param {string} sourceName 
 * @returns {string} 冗余前缀
 */
function identifyRedundantTitle(links, seriesTitle, sourceName) {
    if (!links || links.length < 2 || !seriesTitle) return '';
    const cleanSource = (text) => {
        if (!text || !sourceName) return text || '';
        try {
            let regex = _redundantTitleRegexCache.get(sourceName);
            if (!regex) {
                const escapedSource = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`(\\[|【|\\s)?${escapedSource}(\\]|】|\\s)?`, 'gi');
                _redundantTitleRegexCache.set(sourceName, regex);
            }
            return text.replace(regex, '').trim();
        } catch (e) { return text; }
    };
    let cleanSeriesTitle = cleanSource(seriesTitle);
    const separatorMatch = cleanSeriesTitle.match(RegexStore.Clean.REDUNDANT_SEPARATOR);
    if (separatorMatch) cleanSeriesTitle = cleanSeriesTitle.substring(0, separatorMatch.index);
    const titles = links.map(item => {
        const realLink = item.link || item; 
        if (!realLink) return '';
        return cleanSource(realLink.title || realLink.name || '');
    });
    if (titles.some(t => !t)) return ''; 
    const getLCS = (s1, s2) => {
        let maxSub = '';
        for (let i = 0; i < s1.length; i++) {
            for (let j = i + 1; j <= s1.length; j++) {
                const sub = s1.substring(i, j);
                if (s2.includes(sub)) {
                    if (sub.length > maxSub.length) maxSub = sub;
                }
            }
        }
        return maxSub;
    };
    let common = getLCS(titles[0], titles[1]);
    if (common.length < 2) return ''; 
    for (let i = 2; i < titles.length; i++) {
        common = getLCS(common, titles[i]);
        if (common.length < 2) return '';
    }
    const validatedRedundant = getLCS(common, cleanSeriesTitle);
    if (!cleanSeriesTitle.startsWith(validatedRedundant)) return '';
    if (RegexStore.Clean.REDUNDANT_UNSAFE_END.test(validatedRedundant)) {
        const trimmed = validatedRedundant.slice(0, -1).trim();
        if (trimmed.length >= 2 && cleanSeriesTitle.startsWith(trimmed)) return trimmed;
        return '';
    }
    if (validatedRedundant.length >= 2) {
        if (RegexStore.Clean.REDUNDANT_VALID_CHARS.test(validatedRedundant) || validatedRedundant.length > 3) {
            log("info", `[Merge-Check] 检测到集内冗余标题字段: "${validatedRedundant}" (已忽略来源: ${sourceName}, 锚定验证通过)`);
            return validatedRedundant;
        }
    }
    return '';
}

/**
 * 寻找最佳对齐偏移量 (Best Alignment Offset)
 * 算法核心：遍历所有可能的 offset，计算文本相似度与数字匹配度，取得分最高者。
 * @param {Array} primaryLinks 
 * @param {Array} secondaryLinks 
 * @param {string} seriesLangA 
 * @param {string} seriesLangB 
 * @param {string} sourceA 
 * @param {string} sourceB 
 * @param {string} primarySeriesTitle 
 * @param {string} secondarySeriesTitle 
 * @returns {number} 最佳 offset
 */
function findBestAlignmentOffset(primaryLinks, secondaryLinks, seriesLangA = 'Unspecified', seriesLangB = 'Unspecified', sourceA = '', sourceB = '', primarySeriesTitle = '', secondarySeriesTitle = '') {
  if (primaryLinks.length === 0 || secondaryLinks.length === 0) return 0;
  const redundantA = identifyRedundantTitle(primaryLinks, primarySeriesTitle, sourceA);
  const redundantB = identifyRedundantTitle(secondaryLinks, secondarySeriesTitle, sourceB);
  const getTempTitle = (rawTitle, redundantStr) => {
      if (!rawTitle) return "";
      if (redundantStr && rawTitle.includes(redundantStr)) return rawTitle.replace(redundantStr, ''); 
      return rawTitle;
  };
  const processLink = (item, source, seriesLang, red) => {
      const rawTitle = item.link.title || "";
      const cleanTitle = getTempTitle(rawTitle, red);
      const info = extractEpisodeInfo(cleanTitle, source);
      const epLang = getLanguageType(cleanTitle);
      const effLang = epLang !== 'Unspecified' ? epLang : seriesLang;
      const finalLang = (effLang === 'Unspecified' && /^(dandan|animeko)$/i.test(source)) ? 'JP' : effLang;
      const cleanEpText = cleanEpisodeText(cleanTitle);
      const strictCnCore = (finalLang === 'CN') ? cleanTitle.replace(RegexStore.Similarity.CN_STRICT_CORE_REMOVE, "") : null;
      return { info, effLang: finalLang, specialType: getSpecialEpisodeType(cleanTitle), cleanEpText, strictCnCore };
  };
  const pInfos = primaryLinks.map(item => processLink(item, sourceA, seriesLangA, redundantA));
  const sInfos = secondaryLinks.map(item => processLink(item, sourceB, seriesLangB, redundantB));

  let bestOffset = 0, maxScore = -9999; 
  let minNormalA = null, minNormalB = null;
  pInfos.forEach(({info}) => { if (info.num !== null && !info.isSpecial) minNormalA = minNormalA === null ? info.num : Math.min(minNormalA, info.num); });
  sInfos.forEach(({info}) => { if (info.num !== null && !info.isSpecial) minNormalB = minNormalB === null ? info.num : Math.min(minNormalB, info.num); });
  const seasonShift = (minNormalA !== null && minNormalB !== null) ? (minNormalA - minNormalB) : null;
  const baseRange = 15;
  const targetShift = (seasonShift !== null) ? -seasonShift : 0;
  const safeMin = Math.max(Math.min(-baseRange, targetShift - baseRange), -Math.max(primaryLinks.length, secondaryLinks.length));
  const safeMax = Math.min(Math.max(baseRange, targetShift + baseRange), Math.max(primaryLinks.length, secondaryLinks.length));

  for (let offset = safeMin; offset <= safeMax; offset++) {
    let totalTextScore = 0, rawTextScoreSum = 0, matchCount = 0;
    let numericDiffs = new Map();
    let hasSeasonShiftMatch = false;

    for (let i = 0; i < secondaryLinks.length; i++) {
      const pIndex = i + offset;
      if (pIndex >= 0 && pIndex < primaryLinks.length) {
        const dataA = pInfos[pIndex], dataB = sInfos[i];
        const infoA = dataA.info, infoB = dataB.info;
        let pairScore = 0;
        if (infoA.isMovie !== infoB.isMovie) pairScore += MergeWeights.EP_ALIGN.MOVIE_TYPE_MISMATCH; 
        if ((infoA.isStrictSpecial && !infoB.isSpecial) || (infoB.isStrictSpecial && !infoA.isSpecial)) pairScore += MergeWeights.EP_ALIGN.SPECIAL_STRICT_MISMATCH; 

        const normLangA = dataA.effLang === 'Unspecified' ? 'JP' : dataA.effLang;
        const normLangB = dataB.effLang === 'Unspecified' ? 'JP' : dataB.effLang;
        if (normLangA === normLangB) pairScore += MergeWeights.EP_ALIGN.LANG_MATCH; 
        else pairScore += MergeWeights.EP_ALIGN.LANG_MISMATCH; 

        if (infoA.season !== null && infoB.season !== null && infoA.season !== infoB.season) pairScore += MergeWeights.EP_ALIGN.SEASON_NUM_MISMATCH;

        if (dataA.specialType || dataB.specialType) {
            if (dataA.specialType !== dataB.specialType) pairScore += MergeWeights.EP_ALIGN.SPECIAL_TYPE_MISMATCH; 
            else pairScore += MergeWeights.EP_ALIGN.SPECIAL_TYPE_MATCH; 
        }
        if (infoA.isSpecial === infoB.isSpecial) pairScore += MergeWeights.EP_ALIGN.IS_SPECIAL_MATCH;

        if (seasonShift !== null && !infoA.isSpecial && !infoB.isSpecial) {
            if ((infoA.num - infoB.num) === seasonShift) {
                pairScore += MergeWeights.EP_ALIGN.SEASON_SHIFT_EXACT; 
                hasSeasonShiftMatch = true;
            }
        }

        let sim = 0;
        if (dataA.effLang === 'CN' && dataB.effLang === 'CN' && dataA.strictCnCore && dataB.strictCnCore) {
            if (dataA.strictCnCore.includes(dataB.strictCnCore) || dataB.strictCnCore.includes(dataA.strictCnCore)) {
                if (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num) sim = MergeWeights.EP_ALIGN.CN_STRICT_MATCH; 
                else sim = MergeWeights.EP_ALIGN.CN_STRICT_MISMATCH;
            } else sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
        } else sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
        
        pairScore += sim;
        rawTextScoreSum += sim;
        if (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num) pairScore += MergeWeights.EP_ALIGN.NUMERIC_MATCH; 

        totalTextScore += pairScore;
        if (infoA.num !== null && infoB.num !== null) {
            const diffKey = (infoB.num - infoA.num).toFixed(4);
            numericDiffs.set(diffKey, (numericDiffs.get(diffKey) || 0) + 1);
        }
        matchCount++;
      }
    }

    if (matchCount > 0) {
      let finalScore = totalTextScore / matchCount;
      let maxFrequency = 0;
      for (const count of numericDiffs.values()) maxFrequency = Math.max(maxFrequency, count);
      
      const consistencyRatio = maxFrequency / matchCount;
      const avgRawTextScore = rawTextScoreSum / matchCount;

      if (consistencyRatio > 0.6) {
          if (hasSeasonShiftMatch || avgRawTextScore > 0.33) finalScore += MergeWeights.EP_ALIGN.PATTERN_CONSISTENCY_BONUS;
      }

      finalScore += Math.min(matchCount * 0.15, 1.5);
      const zeroDiffCount = numericDiffs.get("0.0000") || 0;
      if (zeroDiffCount > 3) {
          finalScore += MergeWeights.EP_ALIGN.ZERO_DIFF_BONUS_BASE; 
          finalScore += zeroDiffCount * MergeWeights.EP_ALIGN.ZERO_DIFF_BONUS_PER_HIT; 
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
 * 生成安全的合并 ID
 * @param {string|number} id1 
 * @param {string|number} id2 
 * @param {string} [salt=''] 
 * @returns {number}
 */
function generateSafeMergedId(id1, id2, salt = '') {
    const str = `${id1}_${id2}_${salt}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i) | 0; 
    return (Math.abs(hash) % 1000000000) + 1000000000;
}

/**
 * 创建合并后的新链接对象
 * @param {Object} item 
 * @param {string} sourceName 
 * @returns {Object}
 */
function createNewLink(item, sourceName) {
    const rawLink = item.link;
    const rawTitle = rawLink.title || rawLink.name || `Episode ${item.originalIndex + 1}`;
    let newUrl = rawLink.url || '';
    if (newUrl) {
        newUrl = sanitizeUrl(newUrl);
        if (!/^https?:\/\//i.test(newUrl)) newUrl = `${sourceName}:${newUrl}`;
    }
    let displayTitle = rawTitle;
    if (!displayTitle.includes(`【${sourceName}】`)) displayTitle = `【${sourceName}】 ${displayTitle}`;
    return { title: displayTitle, url: newUrl, name: rawTitle };
}

/**
 * 智能拼接未匹配的集数 (Stitching)
 * 处理逻辑：头部插入、尾部追加或标记为特殊
 * @param {Anime} derivedAnime - 正在构建的合并结果对象
 * @param {Array} orphans - 未匹配的副源集数列表
 * @param {string} sourceName - 副源名称
 */
function stitchUnmatchedEpisodes(derivedAnime, orphans, sourceName) {
    if (!orphans || orphans.length === 0) return;
    const headList = [], tailList = [], specialList = [];
    const currentLen = derivedAnime.links.length;

    // [逻辑关键点] 确定主源“正片”的有效边界。
    // 用于防止副源的后续正片被错误插入到主源尾部的番外（SP/OVA）中间。
    let lastPrimaryMainIndex = -1;
    for (let i = currentLen - 1; i >= 0; i--) {
        const link = derivedAnime.links[i];
        const title = link.title || link.name || "";
        const info = extractEpisodeInfo(title, derivedAnime.source);
        if (!info.isSpecial && !info.isPV && !info.isStrictSpecial && info.num !== null) {
            lastPrimaryMainIndex = i;
            break;
        }
    }
    
    for (const item of orphans) {
        const relativeIdx = item.relativeIndex;
        const isStrictSpecial = item.info && item.info.isStrictSpecial;
        const isOrphanMain = item.info && !item.info.isSpecial && !item.info.isPV && !isStrictSpecial && item.info.num !== null;

        if (relativeIdx < 0 && !isStrictSpecial) headList.push(item);
        else if (
            (relativeIdx >= currentLen && !isStrictSpecial) ||
            (isOrphanMain && relativeIdx > lastPrimaryMainIndex)
        ) tailList.push(item);
        else specialList.push(item);
    }

    const addedLogs = [];
    const processList = (list, target, msg) => {
        if (list.length > 0) {
            list.sort((a, b) => a.originalIndex - b.originalIndex);
            target.push(...list.map(it => createNewLink(it, sourceName)));
            addedLogs.push(`   [补全-${msg}] 插入/追加 ${list.length} 集 (${list.map(i => i.link.title).join(', ')})`);
        }
    };

    if (headList.length > 0) {
         headList.sort((a, b) => a.originalIndex - b.originalIndex);
         derivedAnime.links.unshift(...headList.map(it => createNewLink(it, sourceName)));
         addedLogs.push(`   [补全-头部] 插入 ${headList.length} 集 (${headList.map(i => i.link.title).join(', ')})`);
    }
    processList(tailList, derivedAnime.links, "尾部");
    processList(specialList, derivedAnime.links, "特殊");

    if (addedLogs.length > 0) log("info", `[Merge] [${sourceName}] 智能补全:\n${addedLogs.join('\n')}`);
}

/**
 * 获取列表中的“中间插值”小数集数 (如 12.5)
 * @param {Array} links 
 * @param {string} source 
 * @returns {Set<number>}
 */
function getDecimalEpisodes(links, source) {
    const decimals = new Set();
    if (!links) return decimals;
    let lastIntegerIndex = -1;
    for (let i = 0; i < links.length; i++) {
        const title = links[i].title || links[i].name || "";
        const info = extractEpisodeInfo(title, source);
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 === 0) lastIntegerIndex = i;
    }
    links.forEach((l, i) => {
        const title = l.title || l.name || "";
        const info = extractEpisodeInfo(title, source);
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 !== 0) {
            if (i < lastIntegerIndex) decimals.add(info.num);
        }
    });
    return decimals;
}

/**
 * 将指定的小数集数沉底 (移动到列表末尾)
 * @param {Array} links - 集数列表（将被修改）
 * @param {Set<number>} numsToSink - 需要沉底的集数编号集合
 * @param {string} source - 来源名
 * @param {string} sideName - 日志显示的侧边名 (主源/副源)
 */
function sinkDecimalEpisodes(links, numsToSink, source, sideName) {
    const normals = [], sinkers = [];
    let movedCount = 0;
    links.forEach(link => {
        const title = link.title || link.name || "";
        const info = extractEpisodeInfo(title, source);
        const isTarget = info.num !== null && numsToSink.has(info.num);
        if (isTarget) {
            sinkers.push(link);
            movedCount++;
        } else normals.push(link);
    });
    if (movedCount > 0) {
        // [性能优化] 原位修改数组，避免引用丢失
        links.length = 0;
        links.push(...normals, ...sinkers);
        log("info", `[Merge-Check] [${sideName}] 自动沉底: 移动了 ${movedCount} 个中间插值集数 (${Array.from(numsToSink).join(',')}) 到末尾`);
    }
}

/**
 * 构建季度集数地图 (辅助合集切片)
 * 采用众数(Mode)策略，并增加严格的媒体类型过滤（排除真人剧和电影），防止异构资源污染统计。
 * 同时输出详细的推断日志，标明每个数据源的贡献。
 * @param {Array<Anime>} allGroupAnimes 
 * @param {RegExp} epFilter 
 * @param {Set<string|number>} collectionAnimeIds 
 * @returns {Map<number, number>} 季数 -> 集数
 */
function buildSeasonLengthMap(allGroupAnimes, epFilter, collectionAnimeIds) {
    // 结构: Map<seasonNum, Map<count, Array<sourceName>>>
    // 用于记录：S1 -> { 11集: ['dandan', 'animeko'], 8集: ['renren'] }
    const seasonStats = new Map(); 
    const debugLogs = [];

    for (const anime of allGroupAnimes) {
        // 1. 基础过滤：跳过合集自身 (避免循环依赖)
        if (collectionAnimeIds && collectionAnimeIds.has(anime.animeId)) {
            // debugLogs.push(`   [跳过] [${anime.source}] ${anime.animeTitle} (自身是合集)`);
            continue;
        }

        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
        
        // 2. 类型过滤：严格剔除电影和真人剧
        // 地图构建是为了给 TV 动画切片，电影(1集)和真人剧(集数不同)会严重干扰统计
        const category = getContentCategory(realAnime.animeTitle, realAnime.typeDescription, realAnime.source);
        if (category === 'REAL') {
            debugLogs.push(`   [剔除] [${realAnime.source}] ${realAnime.animeTitle} (类型: 真人剧/REAL)`);
            continue;
        }
        
        const mediaType = getStrictMediaType(realAnime.animeTitle, realAnime.typeDescription);
        if (mediaType === 'MOVIE') {
            debugLogs.push(`   [剔除] [${realAnime.source}] ${realAnime.animeTitle} (类型: 电影/MOVIE)`);
            continue;
        }

        const seasonNum = getSeasonNumber(realAnime.animeTitle, realAnime.typeDescription);
        if (seasonNum !== null && realAnime.links) {
            const validLinks = filterEpisodes(realAnime.links, epFilter).filter(item => {
                const title = item.link.title || item.link.name || "";
                const cleanT = cleanText(title);
                const rawTemp = cleanT.replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
                
                // 特定源的番外过滤逻辑
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                     if (RegexStore.Episode.SPECIAL_CHECK.test(rawTemp) || RegexStore.Episode.DANDAN_IGNORE.test(rawTemp)) return false;
                }
                if (RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawTemp) || RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(title)) return false;
                return true;
            });

            const count = validLinks.length;
            if (count > 0) {
                if (!seasonStats.has(seasonNum)) seasonStats.set(seasonNum, new Map());
                const freqMap = seasonStats.get(seasonNum);
                
                if (!freqMap.has(count)) freqMap.set(count, []);
                freqMap.get(count).push(realAnime.source);
                
                debugLogs.push(`   [采纳] [${realAnime.source}] S${seasonNum} = ${count}集 ("${realAnime.animeTitle}")`);
            } else {
                debugLogs.push(`   [忽略] [${realAnime.source}] S${seasonNum} (有效集数为 0)`);
            }
        } else {
            // debugLogs.push(`   [忽略] [${realAnime.source}] ${realAnime.animeTitle} (未识别到季度编号)`);
        }
    }

    const seasonMap = new Map();
    const resultLogs = [];

    for (const [sNum, freqMap] of seasonStats.entries()) {
        let modeCount = 0;
        let maxFreq = 0;
        let contributors = [];

        // 寻找众数 (Mode Strategy)
        for (const [count, sources] of freqMap.entries()) {
            const freq = sources.length;
            if (freq > maxFreq) {
                maxFreq = freq;
                modeCount = count;
                contributors = sources;
            } else if (freq === maxFreq) {
                // 频率相同时的仲裁逻辑：
                // 1. 优先取集数较大的 (假设少的是缺集)
                //    但是，为了防止包含下一季首集的情况，之前是取小的。
                //    现在有了严格过滤，取较大值通常更安全(代表完整季度)。
                //    不过为了保守起见，如果两者相差不大(<=2)，取大的；相差巨大，取小的。
                //    此处维持原逻辑：取较小值，避免合集切片越界。
                if (count < modeCount) {
                    modeCount = count;
                    contributors = sources;
                }
            }
        }
        
        seasonMap.set(sNum, modeCount);
        
        // 构建详细的统计日志字符串
        const statDetails = Array.from(freqMap.entries())
            .map(([cnt, srcs]) => `${cnt}集(x${srcs.length})[${srcs.join(',')}]`)
            .join(', ');
        resultLogs.push(`S${sNum}=${modeCount} (推断来源: ${contributors.join(',')} | 统计: ${statDetails})`);
    }

    if (debugLogs.length > 0 || resultLogs.length > 0) {
        log("info", `[Merge-Check] [Map-Build] 季度地图构建详情:\n${debugLogs.join('\n')}\n   => 最终判定: { ${resultLogs.join('; ')} }`);
    }

    return seasonMap;
}

/**
 * [性能优化] 快速对象克隆
 * 优先使用 V8 引擎底层提供的 structuredClone，回退方案为 JSON 序列化
 * @param {any} anime 
 * @returns {any}
 */
function fastCloneAnime(anime) {
    // 兼容性降级处理，优先使用 structuredClone
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(anime);
        } catch (e) { /* Fallback */ }
    }
    return JSON.parse(JSON.stringify(anime));
}

// ==========================================
// 8. 核心业务流程 (Workflow)
// ==========================================

/**
 * 执行单个主源的合并任务
 * 包含：寻找匹配、ID生成、链接映射、集数补全
 * @param {Object} params - 任务参数对象
 * @returns {Promise<Anime|null>} 合并后的新对象或 null
 */
async function processMergeTask(params) {
    const { 
        pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds,
        generatedSignatures, epFilter, groupFingerprint, currentPrimarySource, logPrefix,
        limitSecondaryLang, collectionAnimeIds, allowReuseIds, collectionProgress
    } = params;

    if (collectionAnimeIds.has(pAnime.animeId) && globalConsumedIds.has(pAnime.animeId)) {
        log("info", `${logPrefix} 跳过: [${currentPrimarySource}] 是合集且已作为副源参与过合并。`);
        return null;
    }

    const cachedPAnime = globals.animes.find(a => String(a.animeId) === String(pAnime.animeId));
    if (!cachedPAnime?.links) {
         log("warn", `${logPrefix} 主源数据不完整，跳过: ${pAnime.animeTitle}`);
         return null;
    }

    const logTitleA = pAnime.animeTitle.replace(RegexStore.Clean.FROM_SUFFIX, '');
    let derivedAnime = fastCloneAnime(cachedPAnime);
    
    const actualMergedSources = []; 
    const contentSignatureParts = [pAnime.animeId];
    let hasMergedAny = false;

    const seriesLangA = getLanguageType(pAnime.animeTitle);
    const redundantP = identifyRedundantTitle(derivedAnime.links, pAnime.animeTitle, currentPrimarySource);
    
    const getTempTitle = (rawTitle, redundantStr) => {
        if (!rawTitle) return "";
        if (redundantStr && rawTitle.includes(redundantStr)) return rawTitle.replace(redundantStr, ''); 
        return rawTitle;
    };

    const isPrimaryCollection = collectionAnimeIds.has(pAnime.animeId);
    const pCleanTitle = cleanTitleForSimilarity(pAnime.animeTitle);
    const peerAnimes = curAnimes.filter(a => cleanTitleForSimilarity(a.animeTitle) === pCleanTitle);
    const seasonLengthMap = buildSeasonLengthMap(peerAnimes, epFilter, collectionAnimeIds);
    
    if (seasonLengthMap.size > 0) {
        const mapDesc = Array.from(seasonLengthMap.entries()).map(([k,v]) => `S${k}=${v}`).join(', ');
        if (isPrimaryCollection || availableSecondaries.some(s => curAnimes.some(a => a.source === s && collectionAnimeIds.has(a.animeId)))) {
            log("info", `${logPrefix} [合集处理] 构建季度集数地图 (Mode策略): { ${mapDesc} }`);
        }
    }

    for (const secSource of availableSecondaries) {
        let secondaryItems = curAnimes.filter(a => {
            if (a.source !== secSource) return false;
            const isConsumed = groupConsumedIds.has(a.animeId);
            const isAllowedReuse = allowReuseIds && allowReuseIds.has(a.animeId);
            if (isConsumed && !isAllowedReuse) return false;
            return true;
        });
        
        if (limitSecondaryLang) secondaryItems = secondaryItems.filter(a => getLanguageType(a.animeTitle) === limitSecondaryLang);

        if (secondaryItems.length > 1) {
            secondaryItems.sort((a, b) => {
                const isCnA = getLanguageType(a.animeTitle) === 'CN';
                const isCnB = getLanguageType(b.animeTitle) === 'CN';
                if (isCnA === isCnB) return 0;
                return isCnA ? 1 : -1;
            });
        }
        if (secondaryItems.length === 0) continue;

        const matches = findSecondaryMatches(pAnime, secondaryItems, collectionAnimeIds);
        
        for (const match of matches) {
            const isReuse = allowReuseIds && allowReuseIds.has(match.animeId);
            if (!isReuse && groupConsumedIds.has(match.animeId)) continue;

            const cachedMatch = globals.animes.find(a => String(a.animeId) === String(match.animeId));
            if (!cachedMatch?.links) continue;

            const mappingEntries = [], matchedPIndices = new Set(), pendingMutations = [], orphanedEpisodes = []; 
            const logTitleB = cachedMatch.animeTitle.replace(RegexStore.Clean.FROM_SUFFIX, '');

            const decimalsP = getDecimalEpisodes(derivedAnime.links, currentPrimarySource);
            const decimalsS = getDecimalEpisodes(cachedMatch.links, secSource);
            const toSinkS = new Set([...decimalsS].filter(x => !decimalsP.has(x)));
            const toSinkP = new Set([...decimalsP].filter(x => !decimalsS.has(x)));
            
            if (toSinkP.size > 0) sinkDecimalEpisodes(derivedAnime.links, toSinkP, currentPrimarySource, `主源:${currentPrimarySource}`);
            
            let currentSecondaryLinks = cachedMatch.links;
            if (toSinkS.size > 0) {
                currentSecondaryLinks = [...cachedMatch.links]; 
                sinkDecimalEpisodes(currentSecondaryLinks, toSinkS, secSource, `副源:${secSource}`);
            }

            const filteredPLinksWithIndex = filterEpisodes(derivedAnime.links, epFilter);
            const filteredMLinksWithIndex = filterEpisodes(currentSecondaryLinks, epFilter);

            const seriesLangB = getLanguageType(cachedMatch.animeTitle);
            let activePLinks = filteredPLinksWithIndex, activeMLinks = filteredMLinksWithIndex;
            let sliceStartP = 0, sliceStartS = 0;
            const isSecondaryCollection = collectionAnimeIds.has(match.animeId);
            
            const performSlicing = (isPrimarySide, collectionLinks, seasonNum) => {
                let sliceStart = 0, slicedList = collectionLinks;
                if (seasonNum && seasonNum > 1) {
                     // 1. 优先尝试历史推断
                     let historyFound = false;
                     if (!isPrimarySide && collectionProgress && collectionProgress.has(match.animeId)) {
                        const progress = collectionProgress.get(match.animeId);
                        const prevSeason = seasonNum - 1;
                        if (progress[`S${prevSeason}`] !== undefined) {
                            const inferredStart = progress[`S${prevSeason}`] + 1;
                            if (inferredStart > 0 && inferredStart < collectionLinks.length) {
                                slicedList = collectionLinks.slice(inferredStart);
                                sliceStart = inferredStart;
                                log("info", `${logPrefix} [合集切片] 历史推断命中: 根据 S${prevSeason} 结束位置 (Index ${progress[`S${prevSeason}`]}), 设定 S${seasonNum} 起点为 Index ${inferredStart}`);
                                historyFound = true;
                            }
                        }
                     }

                     // 2. 防御性回退：如果历史推断缺失，强制使用季度地图进行计算
                     if (!historyFound) {
                        let accumulatedCount = 0;
                        for (let s = 1; s < seasonNum; s++) accumulatedCount += (seasonLengthMap.get(s) || 0);
                        
                        // 移除 -2 缓冲。既然使用 Mode 策略得到了较准确的长度，直接信任该长度。
                        // 这样可以避免 S2 的第 1 集错误地回溯匹配到 S1 的最后几集。
                        let safeAccumulated = accumulatedCount;

                        if (safeAccumulated >= collectionLinks.length) {
                            const heuristicStart = (seasonNum - 1) * 12; 
                            if (heuristicStart < collectionLinks.length) {
                                log("info", `${logPrefix} [合集切片] 起点越界修正: 原计算 ${safeAccumulated} > Total ${collectionLinks.length}，启用回退估算 (S${seasonNum} -> Index ${heuristicStart})`);
                                safeAccumulated = Math.max(0, heuristicStart - 2); 
                            }
                        }
                        if (safeAccumulated > 0 && safeAccumulated < collectionLinks.length) {
                            const nextStart = accumulatedCount + (seasonLengthMap.get(seasonNum) || 999);
                            const safeEnd = Math.min(nextStart, collectionLinks.length);
                            slicedList = collectionLinks.slice(safeAccumulated, safeEnd);
                            sliceStart = safeAccumulated;
                            const sideName = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                            log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S${seasonNum}): 无历史推断(Defensive Fallback)，信任地图切至 ${safeAccumulated}~${safeEnd} (共 ${slicedList.length} 集) 参与对齐`);
                        } else log("info", `${logPrefix} [合集切片] 放弃切片: 计算起点 ${safeAccumulated} 超出范围 (Total: ${collectionLinks.length})`);
                     }
                } else if (seasonNum === 1) {
                     const s1Count = seasonLengthMap.get(1);
                     if (s1Count && s1Count < collectionLinks.length) {
                         slicedList = collectionLinks.slice(0, s1Count);
                         const sideName = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                         log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S1): 使用 Index 0~${s1Count} 参与对齐`);
                     }
                }
                return { sliceStart, slicedList };
            };

            if (isPrimaryCollection && !isSecondaryCollection) {
                const secSeason = getSeasonNumber(cachedMatch.animeTitle, cachedMatch.typeDescription);
                const res = performSlicing(true, filteredPLinksWithIndex, secSeason);
                activePLinks = res.slicedList; sliceStartP = res.sliceStart;
            } else if (!isPrimaryCollection && isSecondaryCollection) {
                const pSeason = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription);
                const res = performSlicing(false, filteredMLinksWithIndex, pSeason);
                activeMLinks = res.slicedList; sliceStartS = res.sliceStart;
            }

            const bestOffsetLocal = findBestAlignmentOffset(activePLinks, activeMLinks, seriesLangA, seriesLangB, currentPrimarySource, secSource, pAnime.animeTitle, cachedMatch.animeTitle);
            const offset = bestOffsetLocal + sliceStartP - sliceStartS;
            if (offset !== 0) log("info", `${logPrefix} 集数自动对齐 (${secSource}): Offset=${offset} (P:${filteredPLinksWithIndex.length}, S:${filteredMLinksWithIndex.length})`);

            derivedAnime.animeId = generateSafeMergedId(derivedAnime.animeId, match.animeId, groupFingerprint);
            derivedAnime.bangumiId = String(derivedAnime.animeId);

            let mergedCount = 0;
            const redundantS = identifyRedundantTitle(cachedMatch.links, cachedMatch.animeTitle, secSource);

            for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
              const pIndex = k + offset; 
              const sourceLinkItem = filteredMLinksWithIndex[k];
              const sourceLink = sourceLinkItem.link;
              const sTitleShort = sourceLink.name || sourceLink.title || `Index ${k}`;

              const orphanItem = { link: sourceLink, originalIndex: sourceLinkItem.originalIndex, relativeIndex: pIndex, info: null };
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
                    if (!currentUrl.startsWith(currentPrimarySource + ':')) currentUrl = `${currentPrimarySource}:${currentUrl}`;
                }
                const newMergedUrl = `${currentUrl}${MERGE_DELIMITER}${secPart}`;
                
                let newMergedTitle = targetLink.title;
                if (newMergedTitle) {
                    let sLabel = secSource;
                    if (sourceLink.title) {
                        const sMatch = sourceLink.title.match(/^【([^】\d]+)(?:\d*)】/);
                        if (sMatch) sLabel = sMatch[1].trim();
                    }
                    newMergedTitle = newMergedTitle.replace(/^【([^】]+)】/, (match, content) => `【${content}${DISPLAY_CONNECTOR}${sLabel}】`);
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
                  
                  // [进度自举] 成功合并后，更新历史进度
                  if (collectionProgress && isSecondaryCollection) {
                      let maxUsedIndex = -1;
                      for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
                           const pIndex = k + offset;
                           if (matchedPIndices.has(pIndex)) {
                               const item = filteredMLinksWithIndex[k];
                               if (item.originalIndex > maxUsedIndex) maxUsedIndex = item.originalIndex;
                           }
                      }
                      
                      if (maxUsedIndex !== -1) {
                          const pSeason = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription) || 1;
                          if (!collectionProgress.has(match.animeId)) collectionProgress.set(match.animeId, {});
                          const progress = collectionProgress.get(match.animeId);
                          // 只要有合并成功，就记录下来，为后续季度的关联提供基准
                          if (mergedCount >= 3) { 
                             progress[`S${pSeason}`] = maxUsedIndex;
                             // log("info", `[Merge-Check] 更新合集进度 [${match.animeId}]: S${pSeason} -> MaxIndex ${maxUsedIndex}`);
                          }
                      }
                  }

                  if (collectionAnimeIds.has(match.animeId)) log("info", `${logPrefix} [智能补全] 跳过: 副源 [${secSource}] 为合集，为避免混入其他季度集数，不执行补全。`);
                  else stitchUnmatchedEpisodes(derivedAnime, orphanedEpisodes, secSource);
                  
                  const normals = [], sinkers = [];
                  derivedAnime.links.forEach(link => {
                      const rawContent = link.title.replace(RegexStore.Clean.SOURCE_TAG, '').trim();
                      if (RegexStore.Episode.SINK_TITLE_STRICT.test(rawContent)) sinkers.push(link);
                      else normals.push(link);
                  });
                  if (sinkers.length > 0) {
                      derivedAnime.links = [...normals, ...sinkers];
                      log("info", `${logPrefix} [排序优化] 立即执行番外沉底: 移动了 ${sinkers.length} 个番外集到末尾`);
                  }
                  if (!collectionAnimeIds.has(match.animeId)) groupConsumedIds.add(match.animeId);
                  else log("info", `${logPrefix} 合集保留: [${secSource}] ${logTitleB} 是合集，保留以供同组复用。`);
                  globalConsumedIds.add(match.animeId);
                  hasMergedAny = true;
                  actualMergedSources.push(secSource);
                  contentSignatureParts.push(match.animeId);
              } else log("info", `${logPrefix} 关联取消: [${currentPrimarySource}] ${logTitleA} <-> [${secSource}] ${logTitleB} (匹配率过低: ${mergedCount}/${Math.max(filteredPLinksWithIndex.length, filteredMLinksWithIndex.length)})`);
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
 * 合集探测 (Collection Detection)
 * 识别包含多季内容的大合集源，防止其与分季源错误匹配
 * @param {Array<Anime>} curAnimes - 当前待处理的番剧列表
 * @returns {Set<string|number>} - 判定为合集的 AnimeID 集合
 */
function detectCollectionCandidates(curAnimes) {
    const collectionIds = new Set();
    if (!curAnimes || curAnimes.length === 0) return collectionIds;

    const cnNums = {'一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9', '十':'10'};
    const groups = new Map();

    curAnimes.forEach(anime => {
        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
        const markers = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription);

        if (markers.has('MOVIE') || markers.has('OVA') || markers.has('SP') || markers.has('SEQUEL')) return; 

        let protectedTitle = simplized(anime.animeTitle || '');
        const startBracketMatch = protectedTitle.match(/^(?:【|\[)(.+?)(?:】|\])/);
        if (startBracketMatch) {
            const content = startBracketMatch[1];
            if (!/^(TV|剧场版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
                protectedTitle = protectedTitle.replace(startBracketMatch[0], content + ' ');
            }
        }

        protectedTitle = protectedTitle.replace(/第([一二三四五六七八九十])季/g, (m, num) => `第${cnNums[num]}季`);

        let clean = protectedTitle
            .replace(RegexStore.Clean.SOURCE_TAG, '')
            .replace(RegexStore.Clean.FROM_SUFFIX, '')
            .replace(RegexStore.Clean.YEAR_TAG, '')
            .replace(RegexStore.Clean.META_SUFFIX, '')
            .replace(RegexStore.Lang.KEYWORDS_STRONG, '');
        
        SUFFIX_SPECIFIC_MAP.forEach(m => clean = clean.replace(m.regex, ''));

        clean = clean.replace(RegexStore.Season.SUFFIX_AMBIGUOUS, '')
            .replace(/(?:第|S)\d+(?:季|期|部)/gi, '')
            .replace(/(?:Part|P)\s*\d+/gi, '')
            .replace(/\s+/g, '').toLowerCase().trim();

        if (!clean) return;

        const category = getContentCategory(anime.animeTitle, realAnime.typeDescription, realAnime.source);
        const groupKey = `${clean}|${category}`;

        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(anime);
    });

    for (const [groupKey, list] of groups.entries()) {
        if (list.length < 2) continue;

        const [baseTitle, category] = groupKey.split('|');
        const itemDetails = list.map(a => `   - [${a.source}] ${a.animeTitle}`).join('\n');
        log("info", `[Merge-Check] [合集探测] 正在检查分组: "${baseTitle}" [${category}] (包含 ${list.length} 个条目):\n${itemDetails}`);

        const sourceStats = new Map(); 
        let groupGlobalMaxSeason = 0;

        list.forEach(anime => {
            const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
            const markers = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription);
            
            let seasonNum = 1; 
            for (const m of markers) {
                if (m.startsWith('S')) {
                    const num = parseInt(m.substring(1));
                    if (!isNaN(num)) seasonNum = num;
                }
            }

            if (seasonNum === 1) {
                const isSequel = markers.has('SEQUEL') || RegexStore.Season.SUFFIX_SEQUEL.test(realAnime.animeTitle);
                const isAmbiguous = markers.has('AMBIGUOUS') || RegexStore.Season.SUFFIX_AMBIGUOUS.test(realAnime.animeTitle);
                if (isSequel || isAmbiguous) {
                    seasonNum = 2; 
                    log("info", `[Merge-Check] [Detail] [${realAnime.source}] "${realAnime.animeTitle}" -> 判定为 S2 (Reason: Sequel/Ambiguous Suffix)`);
                }
            }

            if (seasonNum > groupGlobalMaxSeason) groupGlobalMaxSeason = seasonNum;

            let validCount = 0;
            if (realAnime.links) {
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                    validCount = realAnime.links.filter((l, idx) => {
                        const rawTitle = l.title || l.name || '';
                        const rawContent = rawTitle.replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
                        if (RegexStore.Episode.SPECIAL_CHECK.test(rawContent) || RegexStore.Episode.DANDAN_IGNORE.test(rawContent)) return false;
                        const t = cleanText(rawTitle);
                        if (RegexStore.Episode.SPECIAL_CHECK.test(t) || RegexStore.Episode.DANDAN_IGNORE.test(t)) return false;
                        if (RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawContent) || RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawTitle)) return false;
                        log("info", `[Merge-Check] [Detail-Ep] [${realAnime.source}] 保留: "${rawTitle}"`);
                        return true;
                    }).length;
                } else validCount = realAnime.links.length;
            }

            if (!sourceStats.has(realAnime.source)) sourceStats.set(realAnime.source, { seasonCounts: {}, maxSeason: 0, s1Candidates: [] });
            const stat = sourceStats.get(realAnime.source);
            
            if (!stat.seasonCounts[seasonNum]) stat.seasonCounts[seasonNum] = 0;
            stat.seasonCounts[seasonNum] += validCount;
            if (seasonNum > stat.maxSeason) stat.maxSeason = seasonNum;
            if (seasonNum === 1) stat.s1Candidates.push({ anime: realAnime, originalCount: validCount });
        });

        if (groupGlobalMaxSeason <= 1) continue;

        const allSources = Array.from(sourceStats.keys());

        for (const [source, stat] of sourceStats.entries()) {
            if (stat.maxSeason > 1) continue;

            let maxOtherS1 = 0;
            let hasOtherSources = false;

            for (const otherSource of allSources) {
                if (otherSource === source) continue;
                const otherStat = sourceStats.get(otherSource);
                if (otherStat.seasonCounts[1]) {
                    hasOtherSources = true;
                    if (otherStat.seasonCounts[1] > maxOtherS1) maxOtherS1 = otherStat.seasonCounts[1];
                }
            }

            if (!hasOtherSources) continue;

            const currentS1Total = stat.seasonCounts[1];
            const threshold = maxOtherS1 + Thresholds.COLLECTION_DIFF;
            const ratio = maxOtherS1 > 0 ? (currentS1Total / maxOtherS1) : 0;

            if (currentS1Total > threshold) {
                if (ratio > Thresholds.COLLECTION_RATIO) {
                     log("info", `[Merge-Check] [合集探测] 拒绝: [${source}] ${baseTitle} (Ratio too high: ${ratio.toFixed(2)} > ${Thresholds.COLLECTION_RATIO})`);
                     continue;
                }
                const giants = stat.s1Candidates.filter(c => c.originalCount > threshold);
                if (giants.length > 0) {
                    giants.forEach(cand => {
                        collectionIds.add(cand.anime.animeId);
                        log("info", `[Merge-Check] [合集探测] 发现疑似合集(单体): [${source}] ${cand.anime.animeTitle} (Count:${cand.originalCount} > Thr:${threshold}, Ratio:${ratio.toFixed(2)}) -> 标记为合集`);
                    });
                } else {
                    stat.s1Candidates.forEach(cand => {
                        collectionIds.add(cand.anime.animeId);
                        log("info", `[Merge-Check] [合集探测] 发现疑似合集(聚合): [${source}] ${cand.anime.animeTitle} (TotalS1:${currentS1Total} > Thr:${threshold}, Ratio:${ratio.toFixed(2)}) -> 标记为合集`);
                    });
                }
            } else log("info", `[Merge-Check] [合集探测] 未命中: [${source}] ${baseTitle} (TotalS1:${currentS1Total} <= Threshold:${threshold})`);
        }
    }
    return collectionIds;
}

// ==========================================
// 10. 主入口 (Main Entry)
// ==========================================

/**
 * 应用番剧合并逻辑 (Main Entry Point)
 * 遍历所有合并组配置，执行多轮匹配与合并操作，直接修改传入的 curAnimes 数组
 * 采用分阶段执行策略，并在每阶段内部严格遵循：
 * 优先级 1: 媒体类型 (TV正片 -> 电影/OVA/SP)
 * 优先级 2: 季度顺序 (S1 -> S2)
 * 优先级 3: 配置源优先级
 * * Phase 1: CN Primary Isolation (主源CN优先隔离，仅匹配CN副源)
 * Phase 1.5: CN Secondary Self-Org (副源CN自组网)
 * Phase 2: Standard Fallback (标准回退匹配，匹配剩余所有资源)
 * @param {Array<Anime>} curAnimes - 待处理的番剧列表（将被原地修改）
 * @returns {Promise<void>}
 */
export async function applyMergeLogic(curAnimes) {
  const groups = globals.mergeSourcePairs; 
  if (!groups || groups.length === 0) return;

  log("info", `[Merge] 启动源合并策略，配置: ${JSON.stringify(groups)}`);

  let epFilter = globals.episodeTitleFilter;
  if (epFilter && typeof epFilter === 'string') {
      try { epFilter = new RegExp(epFilter, 'i'); } catch (e) { epFilter = null; }
  }

  // 1. 合集探测 (前置计算)
  const collectionAnimeIds = detectCollectionCandidates(curAnimes);
  
  // 用于记录合集的使用进度，辅助切片推理 (Map<animeId, { S1: 10, S2: 24 }>)
  // 此进度对象在所有 Phase 间共享，确保 Phase 1 产生的进度能被 Phase 2 利用
  const collectionProgress = new Map();

  const newMergedAnimes = [];
  const generatedSignatures = new Set();
  const globalConsumedIds = new Set();
  const keepSources = new Set();
  groups.forEach(g => { if (g.secondaries.length === 0) keepSources.add(g.primary); });

  for (const group of groups) {
    if (group.secondaries.length === 0) continue;
    
    // 构建全局优先级地图，用于排序 (Primary=0, Sec1=1, Sec2=2...)
    // 优先级数值越小，代表在配置文件中越靠前，优先级越高
    const sourcePriorityMap = new Map();
    const fullPriorityList = [group.primary, ...group.secondaries];
    fullPriorityList.forEach((src, idx) => sourcePriorityMap.set(src, idx));
    
    const groupFingerprint = fullPriorityList.join('&');
    const groupConsumedIds = new Set();

    // 通用排序函数：媒体类型 (TV>Movie) > 季度编号 ASC (S1->S2) > 源优先级 ASC
    const sortCandidates = (list, phaseName) => {
        if (!list || list.length < 2) return list;
        
        log("info", `[Merge-Check] [Sort] ${phaseName} 排序前首个元素: ${list[0].animeTitle}`);

        list.sort((a, b) => {
            // 优先级 1: 媒体类型 (确保 TV 季度先于 电影/OVA/SP 处理)
            // 1 = High Priority (TV/Seasonal), 2 = Low Priority (Movie/Non-seasonal)
            const getMediaTypePriority = (anime) => {
                const markers = extractSeasonMarkers(anime.animeTitle, anime.typeDescription);
                if (markers.has('MOVIE')) return 2;
                if (markers.has('OVA') || markers.has('SP')) return 2;
                
                // 补充检查：防止 extractSeasonMarkers 漏网，使用严格类型判断
                const strictType = getStrictMediaType(anime.animeTitle, anime.typeDescription);
                if (strictType === 'MOVIE') return 2;
                
                return 1; // 默认为 TV 正片季度
            };

            const typeA = getMediaTypePriority(a);
            const typeB = getMediaTypePriority(b);
            if (typeA !== typeB) return typeA - typeB;

            // 优先级 2: 季度编号 ASC (确保合集进度记录按顺序产生，S1 先于 S2)
            const sA = getSeasonNumber(a.animeTitle, a.typeDescription) || 1;
            const sB = getSeasonNumber(b.animeTitle, b.typeDescription) || 1;
            if (sA !== sB) return sA - sB; 

            // 优先级 3: 源优先级 ASC (依据配置文件定义的源顺序)
            const pA = sourcePriorityMap.get(a.source);
            const pB = sourcePriorityMap.get(b.source);
            return pA - pB; 
        });

        const debugOrder = list.map(a => {
            const sNum = getSeasonNumber(a.animeTitle, a.typeDescription) || 1;
            // 调试辅助：如果是电影类型，标记为 Movie 以便区分
            const typeLabel = (extractSeasonMarkers(a.animeTitle, a.typeDescription).has('MOVIE') || getStrictMediaType(a.animeTitle, a.typeDescription) === 'MOVIE') ? 'Movie' : `S${sNum}`;
            return `[${typeLabel}] [${a.source}] ${a.animeTitle}`;
        });
        log("info", `[Merge-Check] [Sort] ${phaseName} 执行顺序:\n   ${debugOrder.join('\n   ')}`);
        return list;
    };

    // [Phase 1: CN Primary Isolation]
    // 筛选条件：属于当前组 + 未消费 + 语言为CN + 是配置中的主源或高优先级源
    // 注意：此处策略稍微放宽，允许列表中所有 CN 源作为发起方尝试匹配，只要它们还没被消费
    const cnCandidates = [];
    fullPriorityList.forEach(source => {
       const items = curAnimes.filter(a => a.source === source && !globalConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN');
       items.forEach(item => cnCandidates.push(item));
    });

    // 检查副源池中是否有 CN 资源，如果没有则跳过 Phase 1
    let hasCnInSecondaries = false;
    for (const secSrc of fullPriorityList) {
         if (curAnimes.some(a => a.source === secSrc && !globalConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN')) {
             hasCnInSecondaries = true;
             break;
         }
    }

    if (cnCandidates.length > 0 && hasCnInSecondaries) {
        log("info", `[Merge] [Phase 1] 启动 CN 隔离策略: 包含 ${cnCandidates.length} 个 CN 资源。`);
        sortCandidates(cnCandidates, "Phase 1");

        for (const pAnime of cnCandidates) {
            if (groupConsumedIds.has(pAnime.animeId)) continue;
            if (globalConsumedIds.has(pAnime.animeId)) continue;

            const currentPriorityIdx = sourcePriorityMap.get(pAnime.source);
            const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);

            if (availableSecondaries.length === 0) continue;

            const resultAnime = await processMergeTask({
                pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds, generatedSignatures, epFilter, groupFingerprint,
                currentPrimarySource: pAnime.source, logPrefix: `[Merge][Phase 1: CN-Strict]`, limitSecondaryLang: 'CN', collectionAnimeIds, collectionProgress
            });
            if (resultAnime) { 
                newMergedAnimes.push(resultAnime); 
                groupConsumedIds.add(pAnime.animeId); 
                globalConsumedIds.add(pAnime.animeId); 
            }
        }
    }

    // [Phase 1.5: Secondary CN Self-Organization]
    // 处理那些在 Phase 1 中未被主源捕获，但彼此之间可以互联的低顺位 CN 源
    // 重新扫描未消费的 CN 资源
    const secondaryCnCandidates = [];
    // 从第二个源开始扫描，因为主源已经在 Phase 1 尝试过了
    for (let i = 1; i < fullPriorityList.length; i++) {
        const source = fullPriorityList[i];
        const items = curAnimes.filter(a => a.source === source && !globalConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN');
        items.forEach(item => secondaryCnCandidates.push(item));
    }

    if (secondaryCnCandidates.length >= 2) {
         log("info", `[Merge] [Phase 1.5] 启动副源 CN 自组织: 检测到 ${secondaryCnCandidates.length} 个剩余 CN 资源。`);
         sortCandidates(secondaryCnCandidates, "Phase 1.5");

         for (const tAnime of secondaryCnCandidates) {
             if (groupConsumedIds.has(tAnime.animeId)) continue;
             if (globalConsumedIds.has(tAnime.animeId)) continue;

             const currentPriorityIdx = sourcePriorityMap.get(tAnime.source);
             const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);
             
             if (availableSecondaries.length === 0) continue;

             const resultAnime = await processMergeTask({
                 pAnime: tAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds, generatedSignatures, epFilter, groupFingerprint,
                 currentPrimarySource: tAnime.source, logPrefix: `[Merge][Phase 1.5: CN-Secondary]`, limitSecondaryLang: 'CN', collectionAnimeIds, collectionProgress
             });
             if (resultAnime) { 
                 newMergedAnimes.push(resultAnime); 
                 groupConsumedIds.add(tAnime.animeId); 
                 globalConsumedIds.add(tAnime.animeId); 
             }
         }
    }

    // [Phase 2: Standard Fallback]
    // 处理剩余的所有资源（包含非 CN 资源以及 Phase 1/1.5 未匹配的 CN 资源）
    const remainingCandidates = [];
    fullPriorityList.forEach(source => {
       const items = curAnimes.filter(a => a.source === source && !globalConsumedIds.has(a.animeId));
       items.forEach(item => remainingCandidates.push(item));
    });

    if (remainingCandidates.length > 0) {
        log("info", `[Merge] [Phase 2] 启动标准回退匹配: 剩余 ${remainingCandidates.length} 个资源。`);
        sortCandidates(remainingCandidates, "Phase 2");

        for (const pAnime of remainingCandidates) {
            if (groupConsumedIds.has(pAnime.animeId)) continue;
            if (globalConsumedIds.has(pAnime.animeId)) continue;

            const currentPriorityIdx = sourcePriorityMap.get(pAnime.source);
            const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);

            if (availableSecondaries.length === 0) continue;

            // Part 复用逻辑检测
            // 如果主源是 Part 分部资源，尝试寻找已合并过的、同季度的全集资源进行复用
            const markers = extractSeasonMarkers(pAnime.animeTitle, pAnime.typeDescription);
            const hasPart = Array.from(markers).some(m => m.startsWith('P'));
            let allowReuseIds = null;
            if (hasPart) {
                allowReuseIds = new Set();
                const pSeasonNum = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription) || 1;
                for (const consumedId of globalConsumedIds) {
                    const consumedAnime = globals.animes.find(a => String(a.animeId) === String(consumedId));
                    if (!consumedAnime) continue;
                    if (!availableSecondaries.includes(consumedAnime.source)) continue;
                    const secMarkers = extractSeasonMarkers(consumedAnime.animeTitle, consumedAnime.typeDescription);
                    if (Array.from(secMarkers).some(m => m.startsWith('P'))) continue;
                    const sSeasonNum = getSeasonNumber(consumedAnime.animeTitle, consumedAnime.typeDescription) || 1;
                    if (pSeasonNum === sSeasonNum) allowReuseIds.add(consumedAnime.animeId);
                }
            }

            const resultAnime = await processMergeTask({
                pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds, generatedSignatures, epFilter, groupFingerprint,
                currentPrimarySource: pAnime.source, logPrefix: `[Merge][Phase 2: Standard]`, collectionAnimeIds, allowReuseIds, collectionProgress
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
     for (const anime of newMergedAnimes) addAnime(anime);
     curAnimes.unshift(...newMergedAnimes);
  }

  // 保护单源配置
  if (keepSources.size > 0) {
      for (const anime of curAnimes) {
          if (globalConsumedIds.has(anime.animeId) && keepSources.has(anime.source)) globalConsumedIds.delete(anime.animeId);
      }
  }
  
  for (let i = curAnimes.length - 1; i >= 0; i--) {
    const item = curAnimes[i];
    if (item._isMerged || globalConsumedIds.has(item.animeId)) curAnimes.splice(i, 1);
  }
  
  log("info", `[Merge] 合并执行完毕，最终列表数量: ${curAnimes.length}`);
}

/**
 * 弹幕列表合并工具
 * 合并两个弹幕列表并按时间戳升序排列
 * @param {Array} listA - 弹幕列表 A
 * @param {Array} listB - 弹幕列表 B
 * @returns {Array} - 合并排序后的列表
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
  final.sort((a, b) => getTime(a) - getTime(b));
  return final;
}
