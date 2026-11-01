import { canonicalPlatformName, canonicalPlatformGroup } from './platform-util.js';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { simplized } from './zh-util.js';

// =====================
// 通用工具方法
// =====================

// 打印数据前200个字符
export function printFirst200Chars(data) {
  let dataToPrint;

  if (typeof data === 'string') {
    dataToPrint = data;  // 如果是字符串，直接使用
  } else if (Array.isArray(data)) {
    dataToPrint = JSON.stringify(data);  // 如果是数组，转为字符串
  } else if (typeof data === 'object') {
    dataToPrint = JSON.stringify(data);  // 如果是对象，转为字符串
  } else {
    log("error", "[system] [common] Unsupported data type");
    return;
  }

  log("info", "[system] [common]", dataToPrint.slice(0, 200));  // 打印前200个字符
}

// 正则表达式：提取episode标题中的内容
export const extractEpisodeTitle = (title) => {
  const match = title.match(/【(.*?)】/);  // 匹配【】中的内容
  return match ? canonicalPlatformGroup(match[1]) : null;  // 返回方括号中的内容，若没有匹配到，则返回null
};

// 正则表达式：提取anime标题中的内容
export const extractAnimeTitle = (str) => str.split('(')[0].trim();

// 提取年份的辅助函数
export function extractYear(animeTitle) {
  const match = String(animeTitle).normalize('NFKC').match(/(?:\(|(?<!\d))((?:19|20)\d{2})(?:\)|年|版|(?=$|[\s【]))/);
  return match ? parseInt(match[1]) : null;
}

export function matchMediaType(value) {
  if (/电影|剧场版|\b(?:movie|film)\b/i.test(value)) return 'movie';
  if (/电视剧|动漫|番剧|动画|综艺|\b(?:tv|tvseries|tv_series|series|anime|variety)\b/i.test(value)) return 'tv';
  return null;
}

// 主源、缓存与投稿都拒绝明确的年份、类型与作品 ID 冲突。
export function workIdentityConflict(candidate, target) {
  const typeText = [candidate.type, candidate.typeDescription, candidate.animeTitle || candidate.title].join(' ');
  const animation = /动漫|番剧|动画|\banime\b/i.test(typeText);
  if (target.tmdbIdentity?.isAnimation === true && !animation &&
      (candidate.isAnimation === false || /短剧|综艺|真人|实拍|\b(?:drama|variety)\b/i.test(typeText))) return 'animation-mismatch';
  const mediaType = matchMediaType([candidate.mediaType, candidate.type, candidate.typeDescription].join(' '));
  if (target.mediaType && mediaType && target.mediaType !== mediaType) return 'type-mismatch';
  const key = candidate.tmdbIdentity?.key;
  if (target.tmdbIdentity && key && key !== target.tmdbIdentity.key) return 'tmdb-mismatch';
  const year = Number(String(candidate.startDate || '').slice(0, 4)) || extractYear(candidate.animeTitle || candidate.title || '');
  if (target.year && year && Number(target.year) !== year) return 'year-mismatch';
  return null;
}

export function convertChineseNumber(chineseNumber) {
  // 如果是阿拉伯数字，直接转换
  if (/^\d+$/.test(chineseNumber)) {
    return Number(chineseNumber);
  }

  // 中文数字映射（简体+繁体）
  const digits = {
    // 简体
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9,
    // 繁体
    '壹': 1, '貳': 2, '參': 3, '肆': 4, '伍': 5,
    '陸': 6, '柒': 7, '捌': 8, '玖': 9
  };

  // 单位映射（简体+繁体）
  const units = {
    // 简体
    '十': 10, '百': 100, '千': 1000,
    // 繁体
    '拾': 10, '佰': 100, '仟': 1000
  };

  let result = 0;
  let current = 0;
  let lastUnit = 1;

  for (let i = 0; i < chineseNumber.length; i++) {
    const char = chineseNumber[i];

    if (digits[char] !== undefined) {
      // 数字
      current = digits[char];
    } else if (units[char] !== undefined) {
      // 单位
      const unit = units[char];

      if (current === 0) current = 1;

      if (unit >= lastUnit) {
        // 更大的单位，重置结果
        result = current * unit;
      } else {
        // 更小的单位，累加到结果
        result += current * unit;
      }

      lastUnit = unit;
      current = 0;
    }
  }

  // 处理最后的个位数
  if (current > 0) {
    result += current;
  }

  return result;
}

// =====================
// 文件名发布组（字幕组）
// =====================

// 这些字段会影响作品/季集的选择吗？不会。它们只是资源发布信息，
// 不能被当成字幕组条件，否则 `[1080p]`、`[Baha]` 会误触发分组规则。
const RELEASE_GROUP_NOISE = /^(?:\d{3,4}p|4k|8k|hdr|dv|dolby[ ._-]*vision|web|dl|web[- .]?dl|web[- .]?rip|bluray|blu[- .]?ray|bdrip|hdtv|dvdrip|remux|hd|fhd|uhd|x26[45]|h[ .]?26[45]|hevc|avc|av1|10bit|8bit|hi10p|ma10p|aac|ac3|ddp|dts|flac|truehd|atmos|dd|5[.]1|7[.]1|2[.]0|baha|mp4|mkv|avi|mov|wmv|chs|cht|gb|big5|中字|国配|中配|日配|粤语|原声|无修|未删减|完整版|臻彩|真彩|group)$/i;

// `parseFileName` can be used before Globals.init() (for example by a
// lightweight worker import or a unit test). Keep platform markers out of
// releaseGroups even when the runtime list is not initialized yet.
const PLATFORM_MARKERS = new Set([
  'qq', 'tencent', 'qiyi', 'iqiyi', 'imgo', 'mango', 'youku', 'bilibili',
  'bilibili1', 'migu', 'hanjutv', 'renren', 'sohu', 'leshi', 'hongguo', 'bahamut'
]);

function isReleaseGroupNoise(value) {
  const text = String(value || '').trim();
  if (!text || /^(?:19|20)\d{2}$/.test(text) || /^\d{1,3}$/.test(text) || /^S\d{1,2}E\d{1,3}$/i.test(text)) return true;
  // A compound bracket such as `1080p WEB-DL Baha` is still metadata even
  // though it is not one of the single-token entries above.
  if (RELEASE_GROUP_NOISE.test(text)) return true;
  if (/^(?:[\[【].*[\]】])$/.test(text)) return isReleaseGroupNoise(text.slice(1, -1));
  const compoundParts = text.split(/[\s._-]+/).filter(Boolean);
  if (compoundParts.length > 1 && compoundParts.every(part =>
    RELEASE_GROUP_NOISE.test(part) || /^\d{1,3}$/.test(part) || /^S\d{1,2}E\d{1,3}$/i.test(part))) return true;
  return /^(?:\d{3,4}p|web[- .]?dl|web[- .]?rip|bluray|bdrip|hdtv|x26[45]|h[ .]?26[45]|aac|ac3|ddp|dts|中字|国配|中配|日配|粤语)(?:[\s._-]+|$)/i.test(text)
    && text.split(/[\s._-]+/).every(part => !part || RELEASE_GROUP_NOISE.test(part));
}

function addReleaseGroup(groups, value) {
  // A leading `[A&B]` is commonly used for two independent release groups.
  // Keep names such as `VCB-Studio` intact; only split the explicit joiners.
  for (const part of String(value || '').split(/[&＋+]/)) {
    const text = part.trim().replace(/^[\[【]|[\]】]$/g, '').trim();
    if (!text || isReleaseGroupNoise(text)) continue;
    const normalized = text.toLowerCase();
    if (PLATFORM_MARKERS.has(normalized)
      || (Array.isArray(globals.allowedPlatforms)
        && globals.allowedPlatforms.some(platform => String(platform).toLowerCase() === normalized))) continue;
    if (text.length > 64 || /[\\/:*?"<>|]/.test(text)) continue;
    if (!groups.includes(text)) groups.push(text);
  }
}

/**
 * Extract release-group tokens without changing the title used for search.
 * Only leading bracket tags and explicit `-Group`/`@Group` suffixes are
 * considered; ordinary words at the end of a title are never guessed as a
 * group. The result is intentionally an array because a file may contain
 * `[GroupA&GroupB]` or both a bracket and a suffix group.
 */
export function extractReleaseGroups(fileName) {
  const baseName = String(fileName || '').split(/[\\/]/).pop()
    .replace(/\.(?:mkv|mp4|avi|mov|wmv|flv|ts|m2ts|ass|srt)$/i, '');
  const groups = [];
  let rest = baseName.trim();

  while (true) {
    const match = rest.match(/^\s*(?:\[([^\]]+)\]|【([^】]+)】)\s*/);
    if (!match) break;
    addReleaseGroup(groups, match[1] ?? match[2]);
    rest = rest.slice(match[0].length);
  }

  // Explicit release suffixes are normally introduced by a hyphen or @.
  // Do not inspect arbitrary final words: `Blood River` must not yield River.
  // Keep the capture free of hyphens so a technical chain such as
  // `WEB-DL.H264-ADWeb` starts at the final `-ADWeb`, not at `-DL...`.
  const suffix = rest.match(/(?:-|@)([A-Za-z][A-Za-z0-9_.+]{1,63})$/);
  // A trailing hyphen is also common inside a real title (`Spider-Man`).
  // Treat it as a release-group suffix only when the filename carries an
  // episode identity; title-only inputs should never lose their final word.
  if (suffix && /\bS\d+E\d+\b/i.test(rest)) {
    let suffixGroup = suffix[1];

    // A real group name may contain a hyphen (`VCB-Studio`), while a
    // preceding hyphenated token is often an encoder/quality field
    // (`H264-ADWeb`). Expand left only across non-noise tokens, stopping at
    // the season/episode identity or the first known technical token.
    if (suffix[0].startsWith('-')) {
      const groupParts = [suffixGroup];
      let prefix = rest.slice(0, suffix.index);
      while (true) {
        const previous = prefix.match(/(?:^|[.\s-])([A-Za-z][A-Za-z0-9_+]{1,63})$/);
        if (!previous || isReleaseGroupNoise(previous[1])) break;
        groupParts.unshift(previous[1]);
        prefix = prefix.slice(0, previous.index);
      }
      suffixGroup = groupParts.join('-');
    }
    addReleaseGroup(groups, suffixGroup);
  }

  return groups;
}

function stripLeadingReleaseGroupTags(value) {
  let text = String(value || '').trim();
  while (true) {
    const match = text.match(/^\s*(?:\[[^\]]+\]|【[^】]+】)\s*/);
    if (!match) break;
    text = text.slice(match[0].length);
  }
  return text.trim();
}

// 解析fileName，提取动漫名称、平台偏好和可选字幕组。
export function parseFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return { cleanFileName: '', preferredPlatform: '', releaseGroups: [], releaseGroup: '' };
  }

  const releaseGroups = extractReleaseGroups(fileName);
  const releaseResult = groups => ({ releaseGroups, releaseGroup: releaseGroups[0] || '', ...groups });

  const atIndex = fileName.indexOf('@');
  if (atIndex === -1) {
    // 没有@符号，直接返回原文件名
    return releaseResult({ cleanFileName: stripLeadingReleaseGroupTags(fileName) });
  }

  // 找到@符号，需要分离平台标识
  const beforeAt = fileName.substring(0, atIndex).trim();
  const afterAt = fileName.substring(atIndex + 1).trim();

  // 检查@符号后面是否有季集信息（如 S01E01）
  const seasonEpisodeMatch = afterAt.match(/^(\w+)\s+(S\d+E\d+)$/);
  if (seasonEpisodeMatch) {
    // 格式：动漫名称@平台 S01E01
    const platform = seasonEpisodeMatch[1];
    const seasonEpisode = seasonEpisodeMatch[2];
    return {
      ...releaseResult({
        cleanFileName: `${stripLeadingReleaseGroupTags(beforeAt)} ${seasonEpisode}`,
        preferredPlatform: normalizePlatformName(platform)
      })
    };
  } else {
    // 检查@符号前面是否有季集信息
    const beforeAtMatch = beforeAt.match(/^(.+?)\s+(S\d+E\d+)$/);
    if (beforeAtMatch) {
      // 格式：动漫名称 S01E01@平台
      const title = beforeAtMatch[1];
      const seasonEpisode = beforeAtMatch[2];
    return {
        ...releaseResult({
          cleanFileName: `${stripLeadingReleaseGroupTags(title)} ${seasonEpisode}`,
          preferredPlatform: normalizePlatformName(afterAt)
        })
      };
    } else {
      // 格式：动漫名称@平台（没有季集信息）
      return {
        ...releaseResult({
          cleanFileName: stripLeadingReleaseGroupTags(beforeAt),
          preferredPlatform: normalizePlatformName(afterAt)
        })
      };
    }
  }
}

// 将用户输入的平台名称映射为标准平台名称
function normalizePlatformName(inputPlatform) {
  if (!inputPlatform || typeof inputPlatform !== 'string') {
    return '';
  }

  const input = canonicalPlatformName(inputPlatform);

  // 直接返回输入的平台名称（如果有效）
  if (Array.isArray(globals.allowedPlatforms) && globals.allowedPlatforms.includes(input)) {
    return input;
  }

  // 如果输入的平台名称无效，返回空字符串
  return '';
}

// 根据指定平台创建动态平台顺序
export function createDynamicPlatformOrder(preferredPlatform) {
  if (preferredPlatform) preferredPlatform = canonicalPlatformName(preferredPlatform);
  if (!preferredPlatform) {
    return [...globals.platformOrderArr]; // 返回默认顺序的副本
  }

  // 验证平台是否有效
  if (!globals.allowedPlatforms.includes(preferredPlatform)) {
    log("warn", `[system] [common] Invalid platform: ${preferredPlatform}, using default order`);
    return [...globals.platformOrderArr];
  }

  // 创建新的平台顺序，将指定平台放在最前面
  const dynamicOrder = [preferredPlatform];

  // 添加其他平台（排除已指定的平台）
  for (const platform of globals.platformOrderArr) {
    if (platform !== preferredPlatform && platform !== null) {
      dynamicOrder.push(platform);
    }
  }

  // 最后添加 null（用于回退逻辑）
  dynamicOrder.push(null);

  return dynamicOrder;
}

/**
 * 净化搜索关键词（专门针对请求源阶段的温和版）
 * @param {string} str - 原始搜索词
 * @returns {string} 净化后的搜索词
 */
export function sanitizeSearchKeyword(str) {
  if (!str) return '';
  // 仅移除零宽字符、BOM等肉眼不可见的“幽灵字符”，保留空格和合法标点，确保源站搜索的命中率。
  return String(str).replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
}

/**
 * 剔除标题中的非文字字符（空格、标点、符号），仅保留文字与数字
 * @param {string} str - 输入字符串
 * @returns {string} 剔除后的字符串
 */
export function stripNonTitleChars(str) {
  if (!str) return '';
  // 白名单模式：非白名单中的字符全部清理
  return String(str).replace(/[^\u4e00-\u9fa5\u3400-\u4DBF\u{20000}-\u{2EE5F}\u{30000}-\u{323AF}\u3040-\u30ff\uFF65-\uFF9F\uAC00-\uD7AFa-zA-Z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\u2160-\u217F\u0400-\u04FF\u00C0-\u024F\u0370-\u03FF]/gu, '');
}

// 兼容自用映射模块的旧导出名；语义仍为剔除非标题字符，不额外改变繁简。
export const normalizeSpaces = stripNonTitleChars;

/**
 * 标题比对归一化：繁转简后再剔除非文字字符，使同一标题的繁简与格式差异不参与比对
 * @param {string} str - 输入字符串
 * @returns {string} 归一化后的字符串
 */
export function normalizeTitleForMatch(str) {
  if (!str) return '';
  return stripNonTitleChars(simplized(String(str)));
}

// 只在有明确主副标题结构时扩展匹配，不对普通标题做任意前缀截取。
function keywordTitleText(title) {
  return simplized(String(title || '')).normalize('NFKC')
    .replace(/(?:\s+|(?<=】))from\s+.+$/i, '').replace(/【[^】]*】/g, '')
    .replace(/\((?:19|20)\d{2}\)/g, '')
    .replace(/(?:第\s*[\d一二三四五六七八九十]+\s*季|\bS\d+)\s*$/i, '').trim();
}

function normalizeTitleKeyword(value) {
  return normalizeTitleForMatch(value).toLowerCase()
    .replace(/[一二两三四五六七八九][零〇一二两三四五六七八九十百千万]*[百千万][零〇一二两三四五六七八九十百千万]*/g,
      text => String(convertChineseNumber(text.replace(/两/g, '二'))));
}

export function getTitleKeywordParts(title) {
  const text = keywordTitleText(title);
  const match = text.match(/^(.{4,}?)(?:之|[:：]\s*|\s+[-—–]\s+|\s+)(.{3,})$/u);
  if (!match) return null;
  const main = match[1].trim(), subtitle = match[2].trim();
  if (!/[\u3400-\u9fff]/u.test(main) || !/[\u3400-\u9fff]/u.test(subtitle)) return null;
  if (normalizeTitleKeyword(main).length < 4 || normalizeTitleKeyword(subtitle).length < 3) return null;
  return { main, subtitle };
}

// “历险记/历险”是明确的标题形式变体；不全局删除“记”等普通字。
const subtitleKeyword = value => normalizeTitleKeyword(value).replace(/(历险|冒险)记$/, '$1');

export function buildTitleKeywordQueries(title) {
  const parts = getTitleKeywordParts(title);
  if (!parts) return [];
  const main = normalizeTitleKeyword(parts.main);
  return [...new Set([`${main} ${parts.subtitle}`, `${main} ${subtitleKeyword(parts.subtitle)}`])]
    .filter(query => query !== String(title).trim());
}

export function compoundTitleMatches(candidate, query) {
  const expected = getTitleKeywordParts(query);
  if (!expected) return false;
  const actual = getTitleKeywordParts(candidate);
  if (!actual || normalizeTitleKeyword(actual.main) !== normalizeTitleKeyword(expected.main)) return false;
  return subtitleKeyword(actual.subtitle) === subtitleKeyword(expected.subtitle);
}

/**
 * 严格标题匹配函数
 * @param {string} title - 动漫标题
 * @param {string} query - 搜索关键词
 * @returns {boolean} 是否匹配
 */
export function strictTitleMatch(title, query, parsedSeason = null) {
  if (!title || !query) return false;

  // 剧名杂音清理：移除画质/配音/版本等杂音词，避免阻塞匹配
  const tagFilter = globals.titleNoiseFilter || null;
  const cleanTitle = tagFilter ? title.replace(tagFilter, '').trim() : title;
  const cleanQuery = tagFilter ? query.replace(tagFilter, '').trim() : query;

  const t = normalizeTitleForMatch(cleanTitle).toLowerCase();
  const q = normalizeTitleForMatch(cleanQuery).toLowerCase();

  // 查询已经包含完整季名时，标题完全相等即可；parsedSeason 可能是该条目内部的 S01。
  if (t === q) return true;

  // 严格模式必须尊重已解析出的季：候选明确写了其他季时直接排除。
  const candidateSeason = getExplicitSeasonNumber(cleanTitle);
  if (parsedSeason !== null && candidateSeason !== null && Number(candidateSeason) !== Number(parsedSeason)) return false;

  if (compoundTitleMatches(cleanTitle, cleanQuery)) return true;

  // 标题以搜索词开头，且后面为季号或有效关键词时，允许严格匹配通过
  if (t.startsWith(q) && t.length > q.length) {
    const suffix = t.substring(q.length);
    const seasonPattern = /^(?:[\dⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]|s\d+|Season\s*\d+|Part\s*\d+|第\d+|[第]?\s*[零一二三四五六七八九十]+\s*[季期部]|年番|合集|部(?!分)|部分|篇|剧场|完结|最终)/i;
    if (seasonPattern.test(suffix)) return true;
  }

  return false;
}

/**
 * 从文本中提取明确的季度数字
 * 支持提取包含阿拉伯数字或中文数字的季度标识
 * @param {string} text 需要解析的文本
 * @returns {number|null} 提取出的季度数字，未匹配到时返回 null
 */
export function getExplicitSeasonNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:第\s*([0-9一二三四五六七八九十百千万]+)\s*[季期部])|(?:S(?:eason)?\s*(\d+))|(?:Part\s*(\d+))/i);
  if (match) {
    const numStr = match[1] || match[2] || match[3];
    if (numStr) {
      return convertChineseNumber(numStr);
    }
  }
  return null;
}

/**
 * 标题匹配路由函数：支持严格模式，或 宽松模式下的"包含+相似度"混合策略
 * @param {string} title - 动漫标题
 * @param {string} query - 搜索关键词
 * @param {number|null} parsedSeason - 解析出的目标季度
 * @returns {boolean} 是否匹配
 */
export function titleMatches(title, query, parsedSeason = null, forceNonStrict = false, threshold = 0.8) {
  if (title == null || query == null) return false;

  const titleText = String(title);
  const queryText = String(query);
  if (!titleText || !queryText) return false;

  // 策略1：严格模式仅允许头部或完全匹配（forceNonStrict 为 true 时跳过，用于偏好记录等场景）
  if (!forceNonStrict && globals.strictTitleMatch) return strictTitleMatch(titleText, queryText, parsedSeason);

  // 剧名杂音清理：移除画质/配音/版本等杂音词，避免阻塞匹配
  const tagFilter = globals.titleNoiseFilter || null;
  const cleanTitle = tagFilter ? titleText.replace(tagFilter, '').trim() : titleText;

  // 预处理：统一繁简、移除干扰字符并转小写，消除书写变体与格式差异
  const t = normalizeTitleForMatch(cleanTitle).toLowerCase();
  const q = normalizeTitleForMatch(queryText).toLowerCase();
  // A mapping can name an entire season catalogue ("作品 第3季") and
  // address its internal S01. Honor that exact identity in non-strict mode
  // too, before rejecting the catalogue's displayed season number.
  if (Number(parsedSeason) === 1 && getExplicitSeasonNumber(queryText) !== null && t === q) return true;
  let qList = [q];

  // 季度特征提取：提前提取季数以支撑策略2的去季包含匹配
  const querySeason = parsedSeason !== null ? parsedSeason : getExplicitSeasonNumber(queryText);

  // 查询词含季号时，将去季后的干净查询词加入候选池
  // 避免如"间谍过家家 第一季"因"第一季"三字不存在于源标题而导致包含匹配失败
  if (querySeason !== null && parsedSeason === null) {
    const seasonStripped = queryText.replace(/(?:season|s|第)\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部(?!分))?/gi, '').trim();
    if (seasonStripped && seasonStripped !== queryText) {
      qList = [...new Set([...qList, normalizeTitleForMatch(seasonStripped).toLowerCase()])];
    }
  }

  // 查询词含杂音词时，将清理后的干净查询词加入候选池
  // 如"百花杀（真彩）"→ 追加"百花杀"，避免"真彩"二字导致包含匹配失败
  if (tagFilter) {
    const tagStripped = queryText.replace(tagFilter, '').trim();
    if (tagStripped && tagStripped !== queryText) {
      qList = [...new Set([...qList, normalizeTitleForMatch(tagStripped).toLowerCase()])];
    }
  }

  // 季度特征校验：先于包含匹配执行，确保错误季度的标题不会因干净查询词误通过
  if (querySeason !== null) {
    const titleSeason = getExplicitSeasonNumber(titleText);

    if (querySeason > 1) {
      // 搜索指定续作(>1)时，仅当源标题明确包含季号时才校验季号一致性
      // 源标题无季号的不分季长剧不应被此规则拦截，交由上游源处理器决定
      if (titleSeason !== null && titleSeason !== querySeason) return false;
    } else if (querySeason === 1) {
      // 搜索第1季时，拦截明确标明为其他季度(如第2季、第3季)的结果
      if (titleSeason !== null && titleSeason !== 1) return false;
    }
  }

  // 策略2：包含匹配优先 (性能最优且准确，只要完整包含任意变种即匹配)
  if (qList.some(kw => t.includes(kw))) return true;

  // 策略3：相似度匹配 (阈值0.8)
  const simMatch = qList.some(kw => {
    // 长度差异过大，或纯英文/数字时，禁止使用相似度计算策略
    if (Math.abs(t.length - kw.length) > Math.max(t.length, kw.length) * 0.7 || /^[a-zA-Z0-9]+$/.test(kw)) {
      return false;
    }

    // 核心相似度计算：解决"和/与"等翻译差异
    let matchCount = 0;
    let tIndex = 0;

    for (const char of kw) {
      const foundIdx = t.indexOf(char, tIndex);
      if (foundIdx !== -1) {
        matchCount++;
        tIndex = foundIdx + 1;
      }
    }

    return (matchCount / kw.length) > threshold;
  });

  // 年份噪音兜底：前序策略均未命中时，尝试去年份后再次包含匹配
  // 如查询词含杂音年份"(2026)"但源标题不含，去年后可正常命中
  if (!simMatch) {
    const yearStripped = queryText.replace(/[\(\（]\s*(?:19|20)\d{2}\s*[\)\）]|\b(?:19|20)\d{2}\b/g, '').trim();
    if (yearStripped && yearStripped !== queryText) {
      // 去年份后可能残留杂音词，继续用配置的正则去除
      const cleanYear = tagFilter ? yearStripped.replace(tagFilter, '').trim() : yearStripped;
      const yearQ = normalizeTitleForMatch(cleanYear).toLowerCase();
      // 仅当标题不含年份时才接受兜底，保留用户刻意用年份过滤的语义
      const titleHasYear = /[\(\（]\s*(?:19|20)\d{2}\s*[\)\）]|\b(?:19|20)\d{2}\b/.test(titleText);
      if (yearQ && t.includes(yearQ) && !titleHasYear) return true;
    }
  }

  return simMatch;
}

/**
 * 数据类型校验
 * @param {string} value - 值
 * @param {string} expectedType - 期望类型
 * @param {string} fieldName - 参数名称
 */
export function validateType(value, expectedType) {
  const fieldName = value?.constructor?.name;  // 获取字段名
  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      throw new TypeError(`${value} 必须是一个数组，但传入的是 ${fieldName}`);
    }
  } else if (expectedType === "boolean") {
    // 对于 boolean 类型，允许任何可转换为布尔值的类型（number, boolean）
    if (typeof value !== "boolean" && typeof value !== "number") {
      throw new TypeError(`${value} 必须是 boolean 或 number，但传入的是 ${fieldName}`);
    }
  } else if (typeof value !== expectedType) {
    throw new TypeError(`${value} 必须是 ${expectedType}，但传入的是 ${fieldName}`);
  }
}

// 从 animeTitle 中提取季数、纯剧名与剥去年份的完整标题
// fullTitle 保留季号等内容，供需要按完整片名匹配的场景使用（如偏移规则）
export function extractSeasonNumberFromAnimeTitle(animeTitle) {
  if (!animeTitle) return { season: null, baseTitle: null, fullTitle: null };
  // 先在原始标题上做拆分切除年份后缀，再去除非法字符
  const match = animeTitle.match(/^(.*?)\(\d{4}\)/);
  const rawTitleWithoutYear = match ? match[1].trim() : animeTitle.split("(")[0].trim();
  const titleWithoutYear = stripNonTitleChars(rawTitleWithoutYear);

  // 1) 明确季数标识：第X季/期/部
  const explicitSeasonMatch = titleWithoutYear.match(/第\s*([0-9一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+)\s*[季期部]/);
  if (explicitSeasonMatch) {
    return {
      season: convertChineseNumber(explicitSeasonMatch[1]),
      baseTitle: titleWithoutYear.replace(explicitSeasonMatch[0], "").trim(),
      fullTitle: titleWithoutYear,
    };
  }

  // 2) S2/Season 2
  const seasonMatch = titleWithoutYear.match(/(?:S(?:eason)?|Season)\s*(\d+)/i);
  if (seasonMatch) {
    return {
      season: parseInt(seasonMatch[1], 10),
      baseTitle: titleWithoutYear.replace(seasonMatch[0], "").trim(),
      fullTitle: titleWithoutYear,
    };
  }

  // 3) Part 2
  const partMatch = titleWithoutYear.match(/Part\s*(\d+)/i);
  if (partMatch) {
    return {
      season: parseInt(partMatch[1], 10),
      baseTitle: titleWithoutYear.replace(partMatch[0], "").trim(),
      fullTitle: titleWithoutYear,
    };
  }

  // 4) 尾部阿拉伯数字（如"某某 2" 或 "某某2"，但不超过2位）
  const trailingNumber = titleWithoutYear.match(/(?:^|\s|[^\d])(\d{1,2})$/);
  if (trailingNumber) {
    const season = parseInt(trailingNumber[1], 10);
    // 尾部"00"等不合法的季号不视为季数标识（如"机动战士高达00"）
    if (season === 0) {
      return { season: null, baseTitle: titleWithoutYear, fullTitle: titleWithoutYear };
    }
    return {
      season,
      baseTitle: titleWithoutYear.slice(0, titleWithoutYear.lastIndexOf(trailingNumber[1])).trim(),
      fullTitle: titleWithoutYear,
    };
  }

  // 5) 尾部中文数字（如"某某二"）
  const trailingChinese = titleWithoutYear.match(/([一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+)$/);
  if (trailingChinese) {
    return {
      season: convertChineseNumber(trailingChinese[1]),
      baseTitle: titleWithoutYear.replace(trailingChinese[0], "").trim(),
      fullTitle: titleWithoutYear,
    };
  }

  // 6) 罗马数字季号（如"某某Ⅲ"、"某某 Ⅳ"），仅识别 Unicode 罗马数字字符（Ⅰ-Ⅻ）
  const romanMatch = titleWithoutYear.match(/[\u2160-\u216B]/);
  if (romanMatch) {
    return {
      season: romanMatch[0].codePointAt(0) - 0x2160 + 1,
      baseTitle: titleWithoutYear.replace(romanMatch[0], "").trim(),
      fullTitle: titleWithoutYear,
    };
  }

  return { season: null, baseTitle: titleWithoutYear, fullTitle: titleWithoutYear };
}

// 从集标题中提取集数（支持多种格式：第1集、第01集、EP01、E01等）
export function extractEpisodeNumberFromTitle(episodeTitle) {
  if (!episodeTitle) return null;

  // 匹配格式：第1集、第01集、第1话、第1回等
  const chineseMatch = episodeTitle.match(/第(\d+)[集话回]/);
  if (chineseMatch) {
    return parseInt(chineseMatch[1], 10);
  }

  // 匹配格式：EP01、EP1、E01、E1等
  const epMatch = episodeTitle.match(/[Ee][Pp]?(\d+)/);
  if (epMatch) {
    return parseInt(epMatch[1], 10);
  }

  // 匹配格式：01、1（纯数字，位于标题末尾）；同时兼容“剧名_32”“剧名.32”“剧名-32”等站点常见命名。
  // 两条约束，取「宁可不匹配也不要错配」：
  //   1) 日期不是集号：imgo 等平台的集标题以「2026-08-01」开头，日期里的日（-01）曾被当成
  //      集号（2026-08-01 → 1），导致请求 S01E01 选中「第6期」；先把日期整段剔除。
  //   2) 编号必须是标题的最后一个词：标题中间冒出来的数字（日期、分辨率等杂项）一概不认，
  //      返回 null，交给文件名期号或 TMDB 分集身份去定位，避免用猜测的数字错配。
  const withoutDates = episodeTitle.replace(/\d{4}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2}\s*日?/g, ' ');
  const numberMatch = withoutDates.match(/(?:^|[\s._-])(\d{1,3})(?=\s*$)/);
  if (numberMatch) {
    return parseInt(numberMatch[1], 10);
  }

  return null;
}

// 从标题中提取动漫名称、完整标题、季数和集数
export function extractAnimeInfo(animeTitle, episodeTitle) {
  let {season, baseTitle, fullTitle} = extractSeasonNumberFromAnimeTitle(animeTitle);
  let episode = extractEpisodeNumberFromTitle(episodeTitle);

  return { baseTitle, fullTitle, season, episode };
}
