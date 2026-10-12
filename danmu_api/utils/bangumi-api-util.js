import { globals } from '../configs/globals.js';
import { isNonChinese } from './zh-util.js';

const BANGUMI_API_BASE = 'https://api.bgm.tv';

export function cleanBangumiTitle(value) {
  return String(value || '')
    .replace(/[（(]\s*(?:TV|WEB|OVA|OAD|剧场版|劇場版|Movie|Film)\s*[）)]/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBangumiMatchText(value) {
  return cleanBangumiTitle(value)
    .toLowerCase()
    .replace(/[.·・:：,，。!！?？;；'"“”‘’()[\]（）【】《》<>_\-\s]/g, '')
    .trim();
}

function chineseNumberToNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);

  const digitMap = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9
  };

  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (digitMap[text.slice(1)] || 0);
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (digitMap[tens] || 1) * 10 + (digitMap[ones] || 0);
  }

  return digitMap[text] || null;
}

function extractBangumiSeasonNumbers(value) {
  const text = String(value || '');
  const numbers = new Set();

  const patterns = [
    /season\s*(\d+)/ig,
    /(\d+)(?:st|nd|rd|th)\s*season/ig,
    /第\s*([0-9一二两三四五六七八九十]+)\s*[季期]/g,
    /(?:^|[\s._-])s(\d+)(?:$|[\s._-])/ig
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const number = chineseNumberToNumber(match[1]);
      if (number) numbers.add(number);
    }
  }

  return [...numbers];
}

function getBangumiHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'danmu-api/1.0 (https://github.com/huangxd-/danmu_api)'
  };
}

export async function bangumiFetch(path, options = {}) {
  const targetUrl = `${BANGUMI_API_BASE}${path}`;
  const nextUrl = globals.makeProxyUrl(targetUrl);
  const timeout = parseInt(options.timeout || globals.vodRequestTimeout || '10000', 10) || 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(nextUrl, {
      method: options.method || 'GET',
      headers: {
        ...getBangumiHeaders(),
        ...(options.headers || {})
      },
      body: options.body,
      signal: controller.signal
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractBangumiAliases(subject) {
  const aliases = [];
  const add = value => {
    const title = cleanBangumiTitle(value);
    if (title) aliases.push(title);
  };

  add(subject?.name_cn);
  add(subject?.name);

  for (const item of subject?.infobox || []) {
    const key = String(item?.key || '').trim();
    const value = item?.value;
    if (!['别名', '中文名', '简体中文名', '英文名', '罗马字'].includes(key)) continue;

    if (typeof value === 'string') {
      for (const part of value.split('/')) add(part);
    } else if (Array.isArray(value)) {
      for (const itemValue of value) {
        if (typeof itemValue === 'string') add(itemValue);
        else add(itemValue?.v);
      }
    }
  }

  return [...new Set(aliases)];
}

export function scoreBangumiSubject(subject, queryTitle, year = null, season = null) {
  const query = normalizeBangumiMatchText(queryTitle);
  const rawNames = [subject?.name, subject?.name_cn, ...extractBangumiAliases(subject)].filter(Boolean);
  const names = rawNames
    .map(normalizeBangumiMatchText)
    .filter(Boolean);
  let score = 0;

  if (names.some(name => name === query)) {
    score += 100;
  } else if (names.some(name => name.includes(query) || query.includes(name))) {
    score += 70;
  } else if (query) {
    const bestCharHit = names.reduce((best, name) => {
      let hit = 0;
      for (const ch of query) {
        if (name.includes(ch)) hit++;
      }
      return Math.max(best, hit / query.length);
    }, 0);
    score += bestCharHit * 50;
  }

  if (year && String(subject?.date || '').startsWith(String(year))) {
    score += 10;
  }

  const targetSeason = Number(season);
  const seasonNumbers = new Set(rawNames.flatMap(extractBangumiSeasonNumbers));
  if (Number.isInteger(targetSeason) && targetSeason > 0) {
    if (seasonNumbers.has(targetSeason)) {
      score += 35;
    } else if (targetSeason === 1 && seasonNumbers.size === 0) {
      score += 15;
    } else if (seasonNumbers.size > 0) {
      score -= 40;
    } else if (targetSeason > 1) {
      score -= 5;
    }
  } else if (seasonNumbers.size > 0) {
    score -= 35;
  }

  return score;
}

export function hasRelatedBangumiTitle(subject, title) {
  const query = normalizeBangumiMatchText(title);
  return query && extractBangumiAliases(subject).some(value => {
    const candidate = normalizeBangumiMatchText(value);
    return candidate && (candidate === query || (Math.min(candidate.length, query.length) >= 4 && (candidate.includes(query) || query.includes(candidate))));
  });
}

export function pickChineseTitle(subject) {
  const candidates = [
    subject?.name_cn,
    ...extractBangumiAliases(subject)
  ];

  return candidates
    .map(cleanBangumiTitle)
    .find(title => title && !isNonChinese(title)) || null;
}

export async function getBangumiSubjectDetail(subjectId) {
  if (!subjectId) return null;
  return await bangumiFetch(`/v0/subjects/${subjectId}`);
}

