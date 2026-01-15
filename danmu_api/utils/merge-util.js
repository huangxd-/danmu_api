import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
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

/**
 * 文本清洗工具函数
 * 将文本转为简体，并移除特定源标识、地区限制及标点符号，用于提高匹配精度
 * @param {string} text 原始文本
 * @returns {string} 清洗后的文本
 */
function cleanText(text) {
  if (!text) return '';
  // 1. 繁体转简体
  let clean = simplized(text);
  // 2. 移除源标识如 【dandan】
  clean = clean.replace(/【.*?】/g, '');
  // 3. 移除地区限制标识如 (仅限台湾地区)
  clean = clean.replace(/(\(|（)仅限.*?地区(\)|）)/g, '');
  // 4. 移除常见标点符号 (避免 "不行！" 和 "不行。" 被判为不同)
  clean = clean.replace(/[!！?？,，.。、~～]/g, ' ');
  
  return normalizeSpaces(clean).toLowerCase().trim();
}

/**
 * 移除标题中的所有括号内容
 * 用于提取主标题进行比对，规避副标题翻译差异（如：(※不是不可能！？) vs (※似乎可行？)）
 * @param {string} text 清洗后的文本
 * @returns {string} 移除括号后的文本
 */
function removeParentheses(text) {
  if (!text) return '';
  // 移除 () 和 （） 及其内部的所有内容
  return text.replace(/(\(|（).*?(\)|）)/g, '').trim();
}

/**
 * 清洗并提取真实的 ID/URL
 * 用于从组合或带前缀的字符串中还原出原始的请求 ID
 * @param {string} urlStr 原始 URL 字符串
 * @returns {string} 清洗后的 ID 或 完整 URL
 */
function sanitizeUrl(urlStr) {
  if (!urlStr) return '';
  
  // 去除可能存在的组合后缀，只取当前部分
  let clean = String(urlStr).split(MERGE_DELIMITER)[0].trim();

  // 自动修复被错误截断协议头的 URL
  if (clean.startsWith('//')) {
    return 'https:' + clean;
  }

  // 尝试解析 "source:id" 格式
  const match = clean.match(/^([^:]+):(.+)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const body = match[2];

    // 如果前缀是 http/https，说明是原始 URL，保留
    if (prefix === 'http' || prefix === 'https') {
      return clean;
    }

    // 如果 body 是 http 开头，直接返回
    if (/^https?:\/\//i.test(body)) {
      return body;
    }
    
    // 如果 body 是 // 开头，自动补全协议
    if (body.startsWith('//')) {
      return 'https:' + body;
    }

    // 普通 ID
    return body;
  }

  return clean;
}

/**
 * 解析日期字符串为对象
 * @param {string} dateStr 日期字符串
 * @returns {Object} { year: number|null, month: number|null }
 */
function parseDate(dateStr) {
  if (!dateStr) return { year: null, month: null };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { year: null, month: null };
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1
  };
}

/**
 * 计算编辑距离 (Levenshtein Distance)
 * 用于衡量两个字符串的差异程度（对顺序敏感）
 * @param {string} s1 字符串1
 * @param {string} s2 字符串2
 * @returns {number} 编辑距离
 */
function editDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1.charAt(i - 1) === s2.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[len1][len2];
}

/**
 * 计算 Dice 相似度系数 (基于字符集合)
 * 用于解决长标题意译差异（如 "我怎么可能" vs "我们不可能"），对语序不敏感
 * @param {string} s1 字符串1
 * @param {string} s2 字符串2
 * @returns {number} Dice 系数 (0.0 - 1.0)
 */
function calculateDiceSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  
  // 将字符串转换为去重的字符集合 (移除空格)
  const set1 = new Set(s1.replace(/\s/g, ''));
  const set2 = new Set(s2.replace(/\s/g, ''));
  
  if (set1.size === 0 && set2.size === 0) return 1.0;
  if (set1.size === 0 || set2.size === 0) return 0.0;

  // 计算交集大小
  let intersection = 0;
  for (const char of set1) {
    if (set2.has(char)) {
      intersection++;
    }
  }

  // Dice 公式: 2 * |A∩B| / (|A| + |B|)
  return (2.0 * intersection) / (set1.size + set2.size);
}

/**
 * 计算两个字符串的综合相似度 (0.0 - 1.0)
 * 结合了 编辑距离（顺序敏感）和 Dice系数（字符重合度），并预先进行清洗
 * @param {string} str1 字符串1
 * @param {string} str2 字符串2
 * @returns {number} 相似度得分 (取多种算法的最大值)
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  // 使用增强的 cleanText 进行预处理
  const s1 = cleanText(str1);
  const s2 = cleanText(str2);
  
  // 1. 精确匹配
  if (s1 === s2) return 1.0;
  
  // 2. 包含关系 (给予较高基础分)
  if (s1.includes(s2) || s2.includes(s1)) {
    const lenRatio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
    return 0.8 + (lenRatio * 0.2); 
  }
  
  // 3. 编辑距离得分
  const distance = editDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  const editScore = maxLength === 0 ? 1.0 : 1.0 - (distance / maxLength);

  // 4. Dice 系数得分 (处理长标题意译)
  const diceScore = calculateDiceSimilarity(s1, s2);

  // 返回两种算法中较高的分数
  return Math.max(editScore, diceScore);
}

/**
 * 提取标题和类型中的季度/类型标识
 * 支持提取：第N季, Season N, Part N, OVA, OAD, 剧场版, 续篇, 以及末尾数字
 * 同时从 typeDesc (类型描述) 中提取特征，解决标题未写明但类型明确的情况
 * @param {string} title 标题文本
 * @param {string} typeDesc 类型描述 (可选)
 * @returns {Set<string>} 标识集合
 */
function extractSeasonMarkers(title, typeDesc = '') {
  const markers = new Set();
  // 使用 cleanText 确保繁简统一
  const t = cleanText(title);
  const type = cleanText(typeDesc || '');

  const patterns = [
    { regex: /第(\d+)[季期]/, prefix: 'S' }, 
    { regex: /season\s*(\d+)/, prefix: 'S' }, 
    { regex: /s(\d+)/, prefix: 'S' },         
    { regex: /part\s*(\d+)/, prefix: 'P' },   
    { regex: /(ova|oad)/, val: 'OVA' },
    { regex: /(剧场版|movie|film)/, val: 'MOVIE' },
    { regex: /(续篇|续集)/, val: 'SEQUEL' },
    { regex: /sp/, val: 'SP' },
    { regex: /[^0-9](\d)$/, prefix: 'S' } 
  ];

  patterns.forEach(p => {
    const match = t.match(p.regex);
    if (match) {
      if (p.prefix) {
        markers.add(`${p.prefix}${parseInt(match[1])}`);
      } else {
        markers.add(p.val);
      }
    }
  });

  // 从 Type 字段中补全标记
  if (type.includes('剧场版') || type.includes('movie') || type.includes('film')) markers.add('MOVIE');
  if (type.includes('ova') || type.includes('oad')) markers.add('OVA');
  if (type.includes('sp') || type.includes('special')) markers.add('SP');

  const cnNums = {'一':1, '二':2, '三':3, '四':4, '五':5, 'final': 99};
  for (const [cn, num] of Object.entries(cnNums)) {
    if (t.includes(`第${cn}季`)) markers.add(`S${num}`);
  }

  return markers;
}

/**
 * 校验季度/续作标记是否冲突
 * @param {string} titleA 标题A
 * @param {string} titleB 标题B
 * @param {string} typeA 类型A
 * @param {string} typeB 类型B
 * @returns {boolean} true 表示冲突(禁止合并)，false 表示无冲突
 */
function checkSeasonMismatch(titleA, titleB, typeA, typeB) {
  const markersA = extractSeasonMarkers(titleA, typeA);
  const markersB = extractSeasonMarkers(titleB, typeB);

  // 两者都无标记 -> 无冲突
  if (markersA.size === 0 && markersB.size === 0) return false;

  // 1. 如果两者都有标记，必须有交集，不能互斥
  if (markersA.size > 0 && markersB.size > 0) {
    for (const m of markersA) {
        // 如果 A 的标记在 B 中不存在，且 B 也有同类标记(如都是S开头的季数)，则视为冲突
        if (m.startsWith('S') && !markersB.has(m) && Array.from(markersB).some(b => b.startsWith('S'))) return true;
    }
    return false; 
  }

  // 2. 一方有标记，一方无标记 -> 冲突
  if (markersA.size !== markersB.size) {
      return true;
  }

  return false;
}

/**
 * 检查两个标题是否包含相同的季度/季数标记
 * 用于在年份不匹配时进行“豁免”判断
 * @param {string} titleA 标题A
 * @param {string} titleB 标题B
 * @param {string} typeA 类型A
 * @param {string} typeB 类型B
 * @returns {boolean} 是否包含相同的明确季度标记（如都包含 S1）
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
 * @param {Object} dateA 日期对象A
 * @param {Object} dateB 日期对象B
 * @returns {number} 匹配得分 (-1 表示硬性不匹配)
 */
function checkDateMatch(dateA, dateB) {
  if (!dateA.year || !dateB.year) return 0;
  const yearDiff = Math.abs(dateA.year - dateB.year);

  // 年份相差 > 1，硬性抛弃
  if (yearDiff > 1) return -1;

  // 年份相同
  if (yearDiff === 0) {
    if (dateA.month && dateB.month) {
      const monthDiff = Math.abs(dateA.month - dateB.month);
      // 月份差异大也不扣分 (可能是占位符 01-01)
      if (monthDiff > 2) return 0;
      return monthDiff === 0 ? 0.2 : 0.1;
    }
    return 0.1;
  }
  return 0;
}

/**
 * 在副源列表中寻找最佳匹配的动画对象
 * 采用“双重对比策略”：同时计算“完整标题相似度”和“去括号主标题相似度”，取最大值。
 * 并结合类型信息进行更精准的冲突检测（如剧场版vsTV版）。
 * @param {Object} primaryAnime 主源动画对象
 * @param {Array} secondaryList 副源动画列表
 * @returns {Object|null} 匹配的动画对象或 null
 */
export function findSecondaryMatch(primaryAnime, secondaryList) {
  if (!secondaryList || secondaryList.length === 0) return null;

  const primaryTitle = primaryAnime.animeTitle.replace(/\(\d{4}\).*$/, '').trim();
  const primaryDate = parseDate(primaryAnime.startDate);

  let bestMatch = null;
  let maxScore = 0;

  for (const secAnime of secondaryList) {
    const secDate = parseDate(secAnime.startDate);
    const secTitle = secAnime.animeTitle.replace(/\(\d{4}\).*$/, '').trim();
    
    // 检查是否具有完全一致的显式季度标记 (豁免日期校验)
    // 传入 typeDescription 以便提取隐含的类型标记
    const isSeasonExactMatch = hasSameSeasonMarker(primaryTitle, secTitle, primaryAnime.typeDescription, secAnime.typeDescription);

    // 1. 日期校验
    const dateScore = checkDateMatch(primaryDate, secDate);
    if (!isSeasonExactMatch && dateScore === -1) {
        continue;
    }

    // 2. 季度/续作标记冲突硬性校验
    // 传入 typeDescription，利用元数据补全标题中缺失的 "剧场版/OVA" 等信息
    if (checkSeasonMismatch(primaryTitle, secTitle, primaryAnime.typeDescription, secAnime.typeDescription)) {
        continue; 
    }

    // 3. 综合文本相似度计算
    // 策略 A: 完整标题对比 (保留括号内容，适合精准匹配)
    let scoreFull = calculateSimilarity(primaryTitle, secTitle);
    
    // 策略 B: 主标题对比 (移除括号内的副标题/注译，解决如 (※不是不可能) vs (※似乎可行) 的翻译差异)
    const baseA = removeParentheses(primaryTitle);
    const baseB = removeParentheses(secTitle);
    let scoreBase = calculateSimilarity(baseA, baseB);

    // 取两者的最大值作为最终得分
    let score = Math.max(scoreFull, scoreBase);
    
    if (dateScore !== -1) {
        score += dateScore;
    }

    if (score > maxScore) {
      maxScore = score;
      bestMatch = secAnime;
    }
  }

  return maxScore >= 0.6 ? bestMatch : null;
}

/**
 * 提取集数信息
 * 增强正则以支持紧凑格式，并预先进行去噪清洗
 * @param {string} title 分集标题
 * @returns {Object} { isMovie: boolean, num: number|null }
 */
function extractEpisodeInfo(title) {
  // 使用 cleanText 移除干扰前缀和地区文字
  const t = cleanText(title || "");
  
  // 1. 判断是否是剧场版
  const isMovie = /剧场版|movie|film/i.test(t);
  
  let num = null;

  // 2. 提取数字
  
  // 策略 A: 强前缀 (EP, O, S, Part, 第)
  const strongPrefixMatch = t.match(/(?:ep|o|s|part|第)\s*(\d+(\.\d+)?)/i);
  if (strongPrefixMatch) {
    num = parseFloat(strongPrefixMatch[1]);
  } else {
    // 策略 B: 弱前缀 (行首或空格)
    // 必须有后缀分隔符 (话/集/空格/行尾) 或者数字是独立的
    const weakPrefixMatch = t.match(/(?:^|\s)(\d+(\.\d+)?)(?:话|集|\s|$)/);
    if (weakPrefixMatch) {
      num = parseFloat(weakPrefixMatch[1]);
    }
  }

  return { isMovie, num };
}

/**
 * 过滤无效剧集 (预告/花絮等)
 * 完全依赖传入的正则，不再内置硬编码规则
 * @param {Array} links 剧集链接列表
 * @param {RegExp} filterRegex 过滤正则
 * @returns {Array} 包含原始索引的有效剧集列表
 */
function filterEpisodes(links, filterRegex) {
  if (!links) return [];
  
  // 如果没有传入过滤正则（例如全局开关关闭），则不执行过滤，仅保留索引映射
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
 * 寻找最佳对齐偏移量
 * 解决策略：滑动窗口 + 匹配集数权重 + 类型惩罚 + 数字一致性
 * @param {Array} primaryLinks 主源链接列表
 * @param {Array} secondaryLinks 副源链接列表
 * @returns {number} 最佳偏移量
 */
function findBestAlignmentOffset(primaryLinks, secondaryLinks) {
  if (primaryLinks.length === 0 || secondaryLinks.length === 0) return 0;

  let bestOffset = 0;
  let maxScore = -999;
  let maxMatchCount = 0; // 记录最大匹配数量，用于 Tie-Breaker

  // 限制滑动范围 (假设差异 +/- 10 集)
  const maxShift = Math.min(primaryLinks.length, 10); 

  for (let offset = -maxShift; offset <= maxShift; offset++) {
    let totalTextScore = 0;
    let matchCount = 0;
    let numericDiffs = new Map();

    for (let i = 0; i < secondaryLinks.length; i++) {
      const pIndex = i + offset;
      
      if (pIndex >= 0 && pIndex < primaryLinks.length) {
        const titleA = primaryLinks[pIndex].link.title || "";
        const titleB = secondaryLinks[i].link.title || "";
        const infoA = extractEpisodeInfo(titleA);
        const infoB = extractEpisodeInfo(titleB);

        // 1. 类型惩罚 (关键：阻止剧场版与正片匹配)
        let pairScore = 0;
        if (infoA.isMovie !== infoB.isMovie) {
            pairScore -= 5.0; // 强惩罚
        }

        // 2. 文本相似度 (使用 calculateSimilarity 自动清洗对比)
        pairScore += calculateSimilarity(titleA, titleB);

        totalTextScore += pairScore;

        // 3. 数字差值记录
        if (infoA.num !== null && infoB.num !== null) {
            const diff = infoB.num - infoA.num;
            const count = numericDiffs.get(diff) || 0;
            numericDiffs.set(diff, count + 1);
        }

        matchCount++;
      }
    }

    if (matchCount > 0) {
      // 平均文本得分
      let finalAvgScore = totalTextScore / matchCount;

      // 4. 计算数字一致性加分
      let maxFrequency = 0;
      for (const count of numericDiffs.values()) {
          if (count > maxFrequency) maxFrequency = count;
      }
      
      // 如果大多数配对都遵循同一个数字差值规律，给予高额加分
      const consistencyRatio = maxFrequency / matchCount;
      if (consistencyRatio > 0.5) {
          finalAvgScore += (consistencyRatio * 2.0); // 一致性奖励
      }

      // 选择逻辑 (Tie-Breaker)
      if (finalAvgScore > maxScore + 0.1) {
        maxScore = finalAvgScore;
        bestOffset = offset;
        maxMatchCount = matchCount;
      } else if (Math.abs(finalAvgScore - maxScore) <= 0.1) {
        if (matchCount > maxMatchCount) {
             maxScore = finalAvgScore;
             bestOffset = offset;
             maxMatchCount = matchCount;
        }
      }
    }
  }

  // 只有当得分 > 0.3 时才采用偏移，否则默认对齐
  return maxScore > 0.3 ? bestOffset : 0;
}

/**
 * 生成符合 int32 范围的安全 ID
 * 通过哈希组合 ID 并映射到 10亿~21亿 区间，避免溢出并减少冲突
 * @param {string|number} id1 原始ID 1
 * @param {string|number} id2 原始ID 2
 * @returns {number} 安全的 Int32 ID
 */
function generateSafeMergedId(id1, id2) {
    const str = `${id1}_${id2}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    // 取绝对值并映射到 1,000,000,000 (10亿) ~ 2,147,483,647 (int32 max) 之间
    // 这样既保证了是正数，又避开了通常较小的原始 ID，同时确保不超过客户端 int32 限制
    return (Math.abs(hash) % 1000000000) + 1000000000;
}

/**
 * 执行源合并逻辑
 * 遍历配置的源对，合并符合条件的动画条目及其集数
 * @param {Array} curAnimes 当前所有的动画条目列表
 */
export async function applyMergeLogic(curAnimes) {
  const pairs = globals.mergeSourcePairs;
  if (!pairs || pairs.length === 0) return;

  log("info", `[Merge] 启动源合并策略，配置: ${JSON.stringify(pairs)}`);

  // 获取过滤正则 (直接从 globals 获取，支持 RegExp 或字符串)
  let epFilter = globals.episodeTitleFilter;
  if (epFilter && typeof epFilter === 'string') {
      try { epFilter = new RegExp(epFilter, 'i'); } catch (e) { epFilter = null; }
  }

  const newMergedAnimes = [];
  const usedBaseAnimeIds = new Set();
  const mergedSecondaryAnimes = new Set();

  for (const { primary, secondary } of pairs) {
    const primaryItems = curAnimes.filter(a => a.source === primary && !a._isMerged);
    const secondaryItems = curAnimes.filter(a => a.source === secondary && !a._isMerged);

    if (primaryItems.length === 0 || secondaryItems.length === 0) continue;

    for (const pAnime of primaryItems) {
      const match = findSecondaryMatch(pAnime, secondaryItems);
      
      if (match) {
        const cachedPAnime = globals.animes.find(a => String(a.animeId) === String(pAnime.animeId));
        const cachedMatch = globals.animes.find(a => String(a.animeId) === String(match.animeId));

        if (!cachedPAnime?.links || !cachedMatch?.links) {
           log("warn", `[Merge] 数据不完整，跳过合并: ${pAnime.animeTitle}`);
           continue;
        }

        const derivedAnime = JSON.parse(JSON.stringify(cachedPAnime));

        // 1. 预过滤 (保留 index 映射)
        const filteredPLinksWithIndex = filterEpisodes(derivedAnime.links, epFilter);
        derivedAnime.links = filteredPLinksWithIndex.map(item => item.link);
        
        const filteredMLinksWithIndex = filterEpisodes(cachedMatch.links, epFilter);

        // 2. 计算最佳对齐偏移量
        const offset = findBestAlignmentOffset(filteredPLinksWithIndex, filteredMLinksWithIndex);
        
        if (offset !== 0) {
            log("info", `[Merge] 集数自动对齐: Offset=${offset} (P:${filteredPLinksWithIndex.length}, S:${filteredMLinksWithIndex.length})`);
        }

        // [修复] 生成安全的 int32 ID，防止客户端溢出错误
        derivedAnime.animeId = generateSafeMergedId(pAnime.animeId, match.animeId);
        derivedAnime.bangumiId = String(derivedAnime.animeId);

        let mergedCount = 0;
        const mappingEntries = []; // 用于存储所有的映射记录（包含匹配和未匹配）
        const matchedPIndices = new Set(); // 记录已被副源匹配的主源索引

        // 3. 执行合并 (应用偏移量) - 以副源为驱动
        for (let i = 0; i < filteredMLinksWithIndex.length; i++) {
            const pIndex = i + offset; 
            const sourceLink = filteredMLinksWithIndex[i].link;
            const sTitleShort = sourceLink.name || sourceLink.title || `Index ${i}`;

            if (pIndex >= 0 && pIndex < derivedAnime.links.length) {
                // [匹配成功]
                const targetLink = derivedAnime.links[pIndex];
                const pTitleShort = targetLink.name || targetLink.title || `Index ${pIndex}`;

                const idA = sanitizeUrl(targetLink.url);
                const idB = sanitizeUrl(sourceLink.url);
                
                const newUrl = `${primary}:${idA}${MERGE_DELIMITER}${secondary}:${idB}`;
                targetLink.url = newUrl;
                
                // 记录映射日志
                mappingEntries.push({
                    idx: pIndex,
                    text: `   [匹配] ${pTitleShort} <-> ${sTitleShort}`
                });
                
                matchedPIndices.add(pIndex);

                // 修改分集标题
                if (targetLink.title) {
                    const prefixRegex = new RegExp(`【${primary}(\\d*)】`);
                    targetLink.title = targetLink.title.replace(
                        prefixRegex, 
                        (match, num) => `【${primary}${num}${DISPLAY_CONNECTOR}${secondary}】`
                    );
                }
                mergedCount++;
            } else {
                // [副源落单] (主源越界)
                mappingEntries.push({
                    idx: pIndex, // 使用虚拟索引进行排序
                    text: `   [落单] (主源越界) <-> ${sTitleShort}`
                });
            }
        }

        // 4. 检查主源是否有落单集数
        for (let j = 0; j < derivedAnime.links.length; j++) {
            if (!matchedPIndices.has(j)) {
                const targetLink = derivedAnime.links[j];
                const pTitleShort = targetLink.name || targetLink.title || `Index ${j}`;
                
                mappingEntries.push({
                    idx: j,
                    text: `   [落单] ${pTitleShort} <-> (副源缺失)`
                });
            }
        }

        // 按集数顺序排序日志
        mappingEntries.sort((a, b) => a.idx - b.idx);

        derivedAnime.animeTitle = derivedAnime.animeTitle.replace(`from ${primary}`, `from ${primary}${DISPLAY_CONNECTOR}${secondary}`);
        derivedAnime.source = primary; 

        addAnime(derivedAnime);

        newMergedAnimes.push(derivedAnime);
        usedBaseAnimeIds.add(pAnime.animeId);
        mergedSecondaryAnimes.add(match); 

        const logTitleA = cachedPAnime.animeTitle.replace(/\s*from\s+.*$/i, '');
        const logTitleB = cachedMatch.animeTitle.replace(/\s*from\s+.*$/i, '');
        log("info", `[Merge] 关联成功: [${primary}] ${logTitleA} <-> [${secondary}] ${logTitleB} (共合并 ${mergedCount} 集) (MergedID: ${derivedAnime.animeId})`);
        
        // 打印详细的集数映射日志
        if (mappingEntries.length > 0) {
            log("info", `[Merge] 集映射详情:\n${mappingEntries.map(e => e.text).join('\n')}`);
        }
      }
    }
  }

  curAnimes.push(...newMergedAnimes);
  
  mergedSecondaryAnimes.forEach(item => {
      item._isMerged = true;
  });

  for (let i = curAnimes.length - 1; i >= 0; i--) {
    const item = curAnimes[i];
    if (item._isMerged || usedBaseAnimeIds.has(item.animeId)) {
      curAnimes.splice(i, 1);
    }
  }
}

/**
 * 合并两个弹幕列表并按时间排序
 * @param {Array} listA 弹幕列表A
 * @param {Array} listB 弹幕列表B
 * @returns {Array} 合并后的弹幕列表
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