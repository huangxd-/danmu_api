const NON_RULE_TITLE_CHARACTERS = (() => {
  try {
    return new RegExp('[^\\p{L}\\p{N}]', 'gu');
  } catch {
    // nodejs-mobile builds without Unicode property escapes still need CJK title matching.
    return /[^0-9A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u052F\u05D0-\u05EA\u05EF-\u05F2\u0620-\u063F\u0640-\u064A\u0660-\u0669\u0671-\u06D3\u06D5\u06EE-\u06FC\u06FF\u1100-\u11FF\u3005-\u3007\u3031-\u3035\u3038-\u303B\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF\uF900-\uFAFF]/g;
  }
})();

function normalizeRuleTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(NON_RULE_TITLE_CHARACTERS, '')
    .toLowerCase();
}

function parseEpisodeSide(value, { allowPlatform = false } = {}) {
  let text = String(value || '').trim();
  let platform = '';

  if (allowPlatform) {
    const platformMatch = text.match(/\s+@([a-zA-Z0-9_-]+)\s*$/);
    if (platformMatch) {
      platform = platformMatch[1].toLowerCase();
      text = text.slice(0, platformMatch.index).trim();
    }
  }

  const match = text.match(/^(.+?)\s+S(\d+)E(\d+)(?:~E?(\d+))?\s*$/i);
  if (!match) return null;

  const title = match[1].trim();
  const season = Number(match[2]);
  const startEpisode = Number(match[3]);
  const endEpisode = match[4] === undefined ? null : Number(match[4]);
  if (!title || season < 1 || startEpisode < 1 || (endEpisode !== null && endEpisode < startEpisode)) return null;

  return { title, season, startEpisode, endEpisode, platform };
}

function parseTargetTitle(value) {
  const displayTitle = String(value || '').trim();
  const yearMatch = displayTitle.match(/[（(]((?:19|20)\d{2})[)）]/);
  const typeMatches = [...displayTitle.matchAll(/【([^】]+)】/g)];
  const mediaType = typeMatches.length > 0 ? typeMatches[typeMatches.length - 1][1].trim() : '';
  const title = displayTitle
    .replace(/[（(](?:19|20)\d{2}[)）]/g, '')
    .replace(/【[^】]+】/g, '')
    .trim();

  return {
    title,
    displayTitle,
    year: yearMatch ? Number(yearMatch[1]) : null,
    mediaType
  };
}

/**
 * Parse AUTO_MATCH_MAPPING_TABLE into validated, declaration-ordered rules.
 */
export function parseAutoMatchMappingRules(value, allowedPlatforms = []) {
  const rules = [];
  const warnings = [];
  const allowed = new Set((allowedPlatforms || []).map(item => String(item).toLowerCase()));

  for (const [index, rawRule] of String(value || '').split(';').entries()) {
    const text = rawRule.trim();
    if (!text) continue;

    const arrowIndex = text.indexOf('->');
    if (arrowIndex === -1 || text.indexOf('->', arrowIndex + 2) !== -1) {
      warnings.push(`规则 ${index + 1} 缺少唯一的 -> 分隔符: ${text}`);
      continue;
    }

    const source = parseEpisodeSide(text.slice(0, arrowIndex));
    const targetSide = parseEpisodeSide(text.slice(arrowIndex + 2), { allowPlatform: true });
    if (!source || !targetSide) {
      warnings.push(`规则 ${index + 1} 的季集格式无效: ${text}`);
      continue;
    }

    const bounded = source.endEpisode !== null;
    if (bounded !== (targetSide.endEpisode !== null)) {
      warnings.push(`规则 ${index + 1} 的源和目标必须同时声明范围: ${text}`);
      continue;
    }
    if (bounded && source.endEpisode - source.startEpisode !== targetSide.endEpisode - targetSide.startEpisode) {
      warnings.push(`规则 ${index + 1} 的源和目标范围长度不一致: ${text}`);
      continue;
    }
    if (targetSide.platform && allowed.size > 0 && !allowed.has(targetSide.platform)) {
      warnings.push(`规则 ${index + 1} 使用了不支持的平台 ${targetSide.platform}: ${text}`);
      continue;
    }

    const targetTitle = parseTargetTitle(targetSide.title);
    if (!targetTitle.title) {
      warnings.push(`规则 ${index + 1} 的目标标题为空: ${text}`);
      continue;
    }

    rules.push({
      order: index,
      raw: text,
      bounded,
      sourceTitle: source.title,
      sourceTitleKey: normalizeRuleTitle(source.title),
      sourceSeason: source.season,
      sourceStartEpisode: source.startEpisode,
      sourceEndEpisode: source.endEpisode,
      targetTitle: targetTitle.title,
      targetDisplayTitle: targetTitle.displayTitle,
      targetYear: targetTitle.year,
      targetType: targetTitle.mediaType,
      targetSeason: targetSide.season,
      targetStartEpisode: targetSide.startEpisode,
      targetEndEpisode: targetSide.endEpisode,
      targetPlatform: targetSide.platform
    });
  }

  return { rules, warnings };
}

export function resolveAutoMatchMapping(rules, { title, season, episode }) {
  const titleKey = normalizeRuleTitle(title);
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!titleKey || !Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) return null;

  const matches = (Array.isArray(rules) ? rules : []).filter(rule => {
    if (rule.sourceTitleKey !== titleKey || rule.sourceSeason !== seasonNumber) return false;
    if (episodeNumber < rule.sourceStartEpisode) return false;
    return rule.sourceEndEpisode === null || episodeNumber <= rule.sourceEndEpisode;
  });
  matches.sort((left, right) => Number(right.bounded) - Number(left.bounded) || left.order - right.order);

  const rule = matches[0];
  if (!rule) return null;
  return {
    ...rule,
    targetEpisode: rule.targetStartEpisode + episodeNumber - rule.sourceStartEpisode
  };
}

function normalizeMediaType(value) {
  const type = normalizeRuleTitle(value);
  if (!type) return '';
  if (/(日番|番剧|动漫|动画|anime|animation)/i.test(type)) return 'anime';
  if (/(电影|剧场|movie|film)/i.test(type)) return 'movie';
  if (/(电视剧|电视|tvseries|series|drama)/i.test(type)) return 'series';
  if (/(综艺|variety)/i.test(type)) return 'variety';
  if (/ova/i.test(type)) return 'ova';
  return type;
}

function stripCandidateTitleMetadata(value) {
  return String(value || '')
    .replace(/\s*from\s+.+$/i, '')
    .replace(/[（(](?:19|20)\d{2}[)）]/g, '')
    .replace(/【[^】]+】/g, '')
    .trim();
}

export function candidateMatchesMappingTitle(anime, mapping) {
  if (!anime || !mapping?.targetTitle) return false;
  const expected = normalizeRuleTitle(mapping.targetTitle);
  const candidateTitles = [anime.animeTitle, ...(Array.isArray(anime.aliases) ? anime.aliases : [])].filter(Boolean);

  return candidateTitles.some(value => {
    const candidate = normalizeRuleTitle(stripCandidateTitleMetadata(value));
    if (candidate === expected) return true;
    if (!candidate.startsWith(expected)) return false;
    const suffix = candidate.slice(expected.length);
    return /^(?:第[一二三四五六七八九十百\d]+季|season\d+|s\d+)$/i.test(suffix);
  });
}

export function candidateMatchesMappingQualifiers(anime, mapping) {
  if (!anime || !mapping) return false;
  const candidateTitles = [anime.animeTitle, ...(Array.isArray(anime.aliases) ? anime.aliases : [])].filter(Boolean);

  if (mapping.targetYear) {
    const years = candidateTitles
      .map(title => String(title).match(/(?:19|20)\d{2}/)?.[0])
      .filter(Boolean)
      .map(Number);
    const startYear = String(anime.startDate || '').match(/^(?:19|20)\d{2}/)?.[0];
    if (startYear) years.push(Number(startYear));
    if (!years.includes(mapping.targetYear)) return false;
  }

  if (mapping.targetType) {
    const expectedType = normalizeMediaType(mapping.targetType);
    const candidateTypes = [anime.type, anime.typeDescription];
    for (const title of candidateTitles) {
      candidateTypes.push(...[...String(title).matchAll(/【([^】]+)】/g)].map(match => match[1]));
    }
    if (!candidateTypes.some(type => normalizeMediaType(type) === expectedType)) return false;
  }

  return true;
}

export function filterMappingQualifierCandidates(animes, mapping) {
  if (!mapping?.targetYear && !mapping?.targetType) return [];
  return (Array.isArray(animes) ? animes : []).filter(anime => candidateMatchesMappingQualifiers(anime, mapping));
}

export function filterMappingTargetCandidates(animes, mapping) {
  return (Array.isArray(animes) ? animes : []).filter(anime => candidateMatchesMappingTitle(anime, mapping));
}
