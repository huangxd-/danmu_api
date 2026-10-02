import { log } from './log-util.js';
import { isNonChinese } from './zh-util.js';
import { cleanBangumiTitle, bangumiFetch, scoreBangumiSubject, hasRelatedBangumiTitle, pickChineseTitle, getBangumiSubjectDetail } from './bangumi-api-util.js';

const BANGUMI_SUBJECT_TYPES = [2, 6]; // Animation and live action.
const BANGUMI_TITLE_CACHE = new Map();

/**
 * 使用 Bangumi API 将外语标题转换为中文标题。
 * 优先使用 name_cn，其次使用详情 infobox 中的中文别名。
 */
export async function getBangumiChineseTitle(title, season = null, episode = null, year = null) {
  if (!title || !isNonChinese(title)) {
    return title;
  }

  const cleanTitle = cleanBangumiTitle(title.replace(/\./g, ' '));
  const cacheKey = `${cleanTitle}|${season || ''}|${episode || ''}|${year || ''}`;
  if (BANGUMI_TITLE_CACHE.has(cacheKey)) {
    return BANGUMI_TITLE_CACHE.get(cacheKey);
  }

  try {
    const searchData = await bangumiFetch('/v0/search/subjects', {
      method: 'POST',
      body: JSON.stringify({
        keyword: cleanTitle,
        filter: { type: BANGUMI_SUBJECT_TYPES }
      })
    });

    const subjects = Array.isArray(searchData?.data) ? searchData.data : [];
    if (subjects.length === 0) {
      log('info', `[Utils] [Bangumi] 未找到标题转换结果: ${title}`);
      BANGUMI_TITLE_CACHE.set(cacheKey, title);
      return title;
    }

    // Resolve aliases on a bounded set before ranking. A fuzzy search result alone
    // is not enough evidence to replace the playback title.
    const candidates = [];
    for (const subject of subjects.slice(0, 5)) {
      let candidate = subject;
      if (!hasRelatedBangumiTitle(candidate, cleanTitle) || !pickChineseTitle(candidate)) {
        candidate = await getBangumiSubjectDetail(subject.id) || subject;
      }
      if (hasRelatedBangumiTitle(candidate, cleanTitle)) candidates.push(candidate);
    }
    const ranked = candidates
      .map(subject => ({ subject, score: scoreBangumiSubject(subject, cleanTitle, year, season) }))
      .sort((a, b) => b.score - a.score);
    const selected = ranked[0]?.subject;
    if (!selected) return title;

    let chineseTitle = pickChineseTitle(selected);
    if (!chineseTitle) {
      const detail = await getBangumiSubjectDetail(selected.id);
      chineseTitle = pickChineseTitle(detail);
    }

    if (chineseTitle) {
      log('info', `[Utils] [Bangumi] 标题转换: ${title} -> ${chineseTitle}`);
      BANGUMI_TITLE_CACHE.set(cacheKey, chineseTitle);
      return chineseTitle;
    }

    BANGUMI_TITLE_CACHE.set(cacheKey, title);
    return title;
  } catch (error) {
    log('error', `[Utils] [Bangumi] 标题转换失败: ${error.message}`);
    BANGUMI_TITLE_CACHE.set(cacheKey, title);
    return title;
  }
}

