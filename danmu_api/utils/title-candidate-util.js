import { searchDoubanTitlesByPublic } from './douban-util.js';
import { getBangumiSeriesTitleCandidates } from './bangumi-series-util.js';
import { log } from './log-util.js';
import { stripNonTitleChars } from './common-util.js';

const DOUBAN_CANDIDATE_CACHE = new Map();
const DOUBAN_CANDIDATE_CACHE_TTL_MS = 10 * 60 * 1000;
const DOUBAN_CANDIDATE_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
let doubanCandidateDisabledUntil = 0;

function getCandidateTitleFromDoubanItem(item) {
  return String(item?.target?.title || item?.title || '').trim();
}

function getCandidateYearFromDoubanItem(item) {
  const value = item?.target?.year || item?.year || '';
  const match = String(value).match(/^(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function isDoubanVideoItem(item) {
  const type = String(item?.type_name || item?.subtype || item?.target_type || '').toLowerCase();
  return ['电视剧', '电影', 'tv', 'movie'].includes(type);
}

function collectDoubanItems(data) {
  const items = [];
  if (Array.isArray(data?.subjects?.items)) items.push(...data.subjects.items);
  if (Array.isArray(data?.subjects)) items.push(...data.subjects);
  if (Array.isArray(data?.smart_box)) items.push(...data.smart_box);
  return items;
}

async function getDoubanSeriesTitleCandidates(title, seasonYear) {
  const cacheKey = `${stripNonTitleChars(title)}|${seasonYear}`;
  const cached = DOUBAN_CANDIDATE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DOUBAN_CANDIDATE_CACHE_TTL_MS) {
    return cached.results;
  }

  if (Date.now() < doubanCandidateDisabledUntil) {
    return [];
  }

  const results = [];

  try {
    const response = await searchDoubanTitlesByPublic(title);
    for (const item of collectDoubanItems(response?.data)) {
      if (!isDoubanVideoItem(item)) continue;
      const candidateTitle = getCandidateTitleFromDoubanItem(item);
      const candidateYear = getCandidateYearFromDoubanItem(item);
      if (!candidateTitle || candidateYear !== Number(seasonYear)) continue;
      results.push({
        title: candidateTitle,
        year: candidateYear,
        source: 'douban',
        id: item?.target_id || item?.id || item?.target?.id || null
      });
    }
  } catch (error) {
    doubanCandidateDisabledUntil = Date.now() + DOUBAN_CANDIDATE_FAILURE_BACKOFF_MS;
    log('warn', `[Utils] [TitleCandidates] 豆瓣候选公开搜索失败: ${error.message}`);
  }

  DOUBAN_CANDIDATE_CACHE.set(cacheKey, { timestamp: Date.now(), results });
  return results;
}

function uniqCandidates(candidates, originalTitle) {
  const seen = new Set();
  const normalizedOriginal = stripNonTitleChars(originalTitle);
  const results = [];

  for (const candidate of candidates) {
    const title = String(candidate?.title || '').trim();
    const normalizedTitle = stripNonTitleChars(title);
    if (!title || !normalizedTitle || normalizedTitle === normalizedOriginal) continue;
    if (seen.has(normalizedTitle)) continue;
    seen.add(normalizedTitle);
    results.push({ ...candidate, title });
  }

  return results;
}

export async function getSeriesTitleCandidates(title, seasonYear, season = null) {
  if (!title || !seasonYear) return [];

  const [doubanCandidates, bangumiCandidates] = await Promise.all([
    getDoubanSeriesTitleCandidates(title, seasonYear),
    getBangumiSeriesTitleCandidates(title, seasonYear, season)
  ]);

  const candidates = uniqCandidates([...doubanCandidates, ...bangumiCandidates], title).slice(0, 8);
  if (candidates.length > 0) {
    log('info', `[Utils] [TitleCandidates] ${title} ${seasonYear} 候选标题: ${candidates.map(item => `${item.title}(${item.source})`).join(', ')}`);
  }
  return candidates;
}
