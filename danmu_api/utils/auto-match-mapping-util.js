import { canonicalPlatformName } from './platform-util.js';
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

const ruleIndexCache = new WeakMap();

function getRuleIndex(rules) {
  if (!Array.isArray(rules)) return { generic: new Map(), grouped: new Map() };
  const cached = ruleIndexCache.get(rules);
  if (cached) return cached;
  // Keep the hot path O(1): a generic bucket is indexed separately from
  // group-qualified buckets so a filename carrying a release group can try
  // the exact rule first without scanning every rule for the title/season.
  const index = { generic: new Map(), grouped: new Map() };
  for (const rule of rules) {
    const keys = [`${rule.sourceTitleKey}\u0000${rule.sourceSeason}`];
    const identityId = rule.sourceTmdbId || rule.targetTmdbId;
    if (identityId) keys.push(`@tmdb:${rule.sourceTmdbType || rule.targetTmdbType || 'tv'}:${identityId}\u0000${rule.sourceSeason}`);
    for (const key of keys) {
      const groupKeys = releaseGroupValues(rule.sourceReleaseGroups?.length
        ? rule.sourceReleaseGroups
        : (rule.sourceReleaseGroup || rule.releaseGroup));
      if (groupKeys.length === 0) {
        const bucket = index.generic.get(key) || [];
        bucket.push(rule);
        index.generic.set(key, bucket);
        continue;
      }
      for (const groupKey of groupKeys) {
        const fullKey = `${key}\u0000${groupKey}`;
        const bucket = index.grouped.get(fullKey) || [];
        bucket.push(rule);
        index.grouped.set(fullKey, bucket);
      }
    }
  }
  ruleIndexCache.set(rules, index);
  return index;
}

/**
 * Release groups are identifiers, not title words. Use the same Unicode
 * folding as title keys so case/NFKC variants resolve to the same bucket.
 */
function normalizeReleaseGroup(value) {
  return normalizeRuleTitle(value);
}

function releaseGroupValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .flatMap(item => String(item || '').split(/[|,;]/))
    .map(normalizeReleaseGroup)
    .filter(Boolean))];
}

function splitRuleEntries(value) {
  const entries = [];
  let current = '';
  let markerDepth = 0;
  const source = String(value || '').replace(/\r/g, '')
    .split('\n')
    .filter(line => !/^\s*(?:#|\/\/)/.test(line))
    .join('\n');
  for (const char of source) {
    if (char === '{') markerDepth++;
    if (char === '}') markerDepth = Math.max(0, markerDepth - 1);
    if ((char === ';' || char === '\n') && markerDepth === 0) {
      if (current.trim()) entries.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function parseIdentityMarker(value) {
  const text = String(value || '');
  const fields = {};
  for (const marker of text.matchAll(/\{\[([^\]]+)\]\}/g)) {
    for (const item of marker[1].split(';')) {
      const eq = item.indexOf('=');
      if (eq === -1) continue;
      fields[item.slice(0, eq).trim().toLowerCase()] = item.slice(eq + 1).trim();
    }
  }
  const tmdbId = Number(fields.tmdbid || fields.tmdb || 0);
  const releaseGroup = fields.group || fields.releasegroup || fields.fansub || fields.fansubgroup || fields.subtitle || '';
  return {
    cleanText: text.replace(/\{\[[^\]]+\]\}/g, '').replace(/\s+/g, ' ').trim(),
    tmdbId: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
    mediaType: fields.type || '',
    releaseGroup: String(releaseGroup || '').trim(),
    releaseGroups: releaseGroupValues(releaseGroup)
  };
}

function parseEpisodeSide(value, { allowPlatform = false, allowReleaseGroup = false, allowSeasonZero = false } = {}) {
  const identity = parseIdentityMarker(value);
  let text = String(value || '').trim();
  if (allowReleaseGroup) {
    // Remove only source-condition markers here.  TMDB/type markers on the
    // target must remain in `title` so parseTargetTitle can retain their
    // candidate qualifiers.
    text = text.replace(/\{\[\s*(?:group|releasegroup|fansub|fansubgroup|subtitle)\s*=\s*[^\]}]+\]\}/gi, '');
  }
  text = text.replace(/\s+/g, ' ').trim();
  let platform = '';

  if (allowPlatform) {
    const platformMatch = text.match(/\s+@([a-zA-Z0-9_-]+)\s*$/);
    if (platformMatch) {
      platform = canonicalPlatformName(platformMatch[1].toLowerCase());
      text = text.slice(0, platformMatch.index).trim();
    }
  }

  const match = text.match(/^(.+?)\s+S(\d+)E(\d+)(?:~E?(\d+))?\s*$/i);
  if (!match) return null;

  const title = match[1].trim();
  const season = Number(match[2]);
  const startEpisode = Number(match[3]);
  const endEpisode = match[4] === undefined ? null : Number(match[4]);
  // 源侧允许 S00：播放器用 S00 表示特别篇；目标侧仍须 S01+。
  const minSeason = allowSeasonZero ? 0 : 1;
  if (!title || season < minSeason || startEpisode < 1 || (endEpisode !== null && endEpisode < startEpisode)) return null;

  return {
    title,
    tmdbId: identity.tmdbId,
    tmdbType: identity.mediaType.toLowerCase(),
    cleanTitle: parseIdentityMarker(title).cleanText,
    season,
    startEpisode,
    endEpisode,
    platform,
    // Group markers are meaningful on the source side. We still parse them
    // on the target side for tolerant input handling, but the resolver only
    // indexes sourceReleaseGroup.
    releaseGroup: allowReleaseGroup ? identity.releaseGroup : '',
    releaseGroups: allowReleaseGroup ? identity.releaseGroups : []
  };
}

function parseTargetTitle(value) {
  const identity = parseIdentityMarker(value);
  const displayTitle = identity.cleanText;
  const yearMatch = displayTitle.match(/[（(]((?:19|20)\d{2})[)）]/);
  const typeMatches = [...displayTitle.matchAll(/【([^】]+)】/g)];
  const mediaType = typeMatches.length > 0 ? typeMatches[typeMatches.length - 1][1].trim() : '';
  const markerMediaType = String(identity.mediaType || '').toLowerCase();
  const title = displayTitle
    .replace(/[（(](?:19|20)\d{2}[)）]/g, '')
    .replace(/【[^】]+】/g, '')
    .trim();

  return {
    title,
    displayTitle,
    year: yearMatch ? Number(yearMatch[1]) : null,
    // MoviePilot 的 type=tv 只是 TMDB 媒体大类，不能拿来排除动画候选；显式【类型】仍作为严格限定。
    mediaType: mediaType || (markerMediaType === 'movie' ? 'movie' : (markerMediaType && markerMediaType !== 'tv' ? markerMediaType : '')),
    tmdbId: identity.tmdbId,
    tmdbType: markerMediaType
  };
}

/**
 * Parse AUTO_MATCH_MAPPING_TABLE into validated, declaration-ordered rules.
 */
export function parseAutoMatchMappingRules(value, allowedPlatforms = []) {
  const rules = [];
  const warnings = [];
  const allowed = new Set((allowedPlatforms || []).map(item => canonicalPlatformName(String(item).toLowerCase())));

  for (const [index, rawRule] of splitRuleEntries(value).entries()) {
    const text = rawRule.trim();
    if (!text || text.startsWith('#') || text.startsWith('//')) continue;

    const arrowIndex = text.indexOf('->');
    if (arrowIndex === -1 || text.indexOf('->', arrowIndex + 2) !== -1) {
      warnings.push(`规则 ${index + 1} 缺少唯一的 -> 分隔符: ${text}`);
      continue;
    }

    const source = parseEpisodeSide(text.slice(0, arrowIndex), { allowReleaseGroup: true, allowSeasonZero: true });
    const targetSide = parseEpisodeSide(text.slice(arrowIndex + 2), { allowPlatform: true, allowReleaseGroup: true });
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
    if ((source.tmdbType && !['tv', 'movie'].includes(source.tmdbType)) ||
        (targetTitle.tmdbType && !['tv', 'movie'].includes(targetTitle.tmdbType)) ||
        (source.tmdbId && targetTitle.tmdbId && (source.tmdbId !== targetTitle.tmdbId ||
          (source.tmdbType || 'tv') !== (targetTitle.tmdbType || 'tv')))) {
      warnings.push(`规则 ${index + 1} 的 TMDB 身份冲突或类型无效: ${text}`);
      continue;
    }
    if (!targetTitle.title) {
      warnings.push(`规则 ${index + 1} 的目标标题为空: ${text}`);
      continue;
    }

    rules.push({
      order: index,
      raw: text,
      bounded,
      sourceTitle: source.cleanTitle,
      sourceTitleKey: normalizeRuleTitle(source.cleanTitle),
      sourceTmdbId: source.tmdbId,
      sourceTmdbType: source.tmdbId ? (source.tmdbType || 'tv') : '',
      sourceSeason: source.season,
      sourceStartEpisode: source.startEpisode,
      sourceEndEpisode: source.endEpisode,
      sourceReleaseGroup: source.releaseGroup,
      sourceReleaseGroups: source.releaseGroups,
      sourceReleaseGroupKey: source.releaseGroups[0] || '',
      // Alias retained for callers that consume the structured field
      // directly. The source-prefixed name is used internally to make the
      // direction explicit.
      releaseGroup: source.releaseGroup,
      targetTitle: targetTitle.title,
      targetDisplayTitle: targetTitle.displayTitle,
      targetYear: targetTitle.year,
      targetType: targetTitle.mediaType,
      targetTmdbId: targetTitle.tmdbId,
      targetTmdbType: targetTitle.tmdbId ? (targetTitle.tmdbType || 'tv') : '',
      targetSeason: targetSide.season,
      targetStartEpisode: targetSide.startEpisode,
      targetEndEpisode: targetSide.endEpisode,
      targetPlatform: targetSide.platform
    });
  }

  return { rules, warnings };
}

export function resolveAutoMatchMapping(rules, { title, identityKey = '', season, episode, releaseGroups = [], releaseGroup = '', preferredPlatform = '', rejectAmbiguous = false } = {}) {
  if (identityKey && !/^(tv|movie):[1-9]\d*$/.test(identityKey)) return null;
  const titleKey = identityKey ? `@tmdb:${identityKey}` : normalizeRuleTitle(title);
  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!titleKey || !Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) return null;

  const index = getRuleIndex(rules);
  const baseKey = `${titleKey}\u0000${seasonNumber}`;
  const requestedGroups = Array.isArray(releaseGroups)
    ? releaseGroups
    : (releaseGroups ? [releaseGroups] : []);
  const groups = releaseGroupValues(requestedGroups.length ? requestedGroups : releaseGroup);

  const inEpisodeRange = rule => {
    if (episodeNumber < rule.sourceStartEpisode) return false;
    return rule.sourceEndEpisode === null || episodeNumber <= rule.sourceEndEpisode;
  };

  // A group-qualified rule is more specific than a generic rule. If a
  // filename contains several release-group tokens, any exact token is
  // eligible; only when none is in range do we fall back to generic rules.
  const exactMatches = [];
  for (const groupKey of groups) {
    exactMatches.push(...(index.grouped.get(`${baseKey}\u0000${groupKey}`) || []).filter(inEpisodeRange));
  }
  const matches = exactMatches.length
    ? exactMatches.map(rule => ({ rule, groupSpecificity: 1 }))
    : (index.generic.get(baseKey) || []).filter(inEpisodeRange).map(rule => ({ rule, groupSpecificity: 0 }));
  // Open rules describe a mapping from their source start episode onward.
  // When several such rules share a source title/season, the latest start
  // episode is the most specific transition point. Keep declaration order
  // only as the tie-breaker for rules with the same specificity.
  matches.sort((left, right) => {
    const groupOrder = right.groupSpecificity - left.groupSpecificity;
    if (groupOrder !== 0) return groupOrder;
    const leftRule = left.rule;
    const rightRule = right.rule;
    const originOrder = Number(rightRule.originPriority || 0) - Number(leftRule.originPriority || 0);
    if (originOrder !== 0) return originOrder;
    const boundedOrder = Number(rightRule.bounded) - Number(leftRule.bounded);
    if (boundedOrder !== 0) return boundedOrder;
    if (!leftRule.bounded && leftRule.sourceStartEpisode !== rightRule.sourceStartEpisode) {
      return rightRule.sourceStartEpisode - leftRule.sourceStartEpisode;
    }
    return leftRule.order - rightRule.order;
  });

  let selected = matches[0];
  if (selected && rejectAmbiguous) {
    const top = selected.rule;
    const peers = matches.filter(item => item.groupSpecificity === selected.groupSpecificity
      && Number(item.rule.originPriority || 0) === Number(top.originPriority || 0)
      && item.rule.bounded === top.bounded
      && (top.bounded || item.rule.sourceStartEpisode === top.sourceStartEpisode));
    const platform = canonicalPlatformName(preferredPlatform);
    const preferred = platform ? peers.filter(item => item.rule.targetPlatform === platform) : [];
    const eligible = preferred.length ? preferred : peers;
    const signatures = new Set(eligible.map(({ rule }) => JSON.stringify([
      normalizeRuleTitle(rule.targetTitle), rule.targetSeason,
      rule.targetStartEpisode - rule.sourceStartEpisode, rule.targetPlatform,
      rule.targetYear, rule.targetType, rule.targetTmdbId
    ])));
    if (signatures.size > 1) return null;
    selected = eligible[0];
  }
  const rule = selected?.rule;
  if (!rule) return null;
  return {
    ...rule,
    targetEpisode: rule.targetStartEpisode + episodeNumber - rule.sourceStartEpisode
  };
}

/** Original filename rules first; aliases supply identity only, never season guesses. */
export function collectAutoMatchCandidates(rules, { title, aliasTitle, identityKey = '', season, episode, releaseGroups = [], preferredPlatform = '' }) {
  const queries = identityKey ? [''] : [...new Set([title, aliasTitle].filter(Boolean))];
  const result = [];
  const seen = new Set();
  for (const groups of releaseGroups.length ? [releaseGroups, []] : [[]]) {
    for (const queryTitle of queries) {
      const rule = resolveAutoMatchMapping(rules, { title: queryTitle, identityKey, season, episode,
        releaseGroups: groups, preferredPlatform, rejectAmbiguous: true });
      if (!rule) continue;
      const key = JSON.stringify([rule.targetTitle, rule.targetSeason, rule.targetEpisode,
        rule.targetPlatform, rule.targetYear, rule.targetType, rule.targetTmdbId]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(rule);
    }
  }
  return result;
}

export function mergeAutoMatchMappingRules(localRules, remoteRules) {
  const local = (Array.isArray(localRules) ? localRules : []).map(rule => ({
    ...rule,
    origin: 'local',
    originPriority: 2
  }));
  const remote = (Array.isArray(remoteRules) ? remoteRules : []).map(rule => ({
    ...rule,
    origin: 'remote',
    originPriority: 1
  }));
  return [...local, ...remote];
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

  if (mapping.targetTmdbId) {
    const candidateIds = [anime.tmdbId, anime.tmdb_id, anime.externalIds?.tmdb, anime.externalIds?.tmdbId]
      .map(Number)
      .filter(value => Number.isInteger(value) && value > 0);
    // 有明确外部身份时必须一致；没有外部身份的弹幕源继续由标题、年份和类型严格校验。
    if (candidateIds.length > 0 && !candidateIds.includes(mapping.targetTmdbId)) return false;
  }

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
  if (!mapping?.targetYear && !mapping?.targetType && !mapping?.targetTmdbId) return [];
  return (Array.isArray(animes) ? animes : []).filter(anime => candidateMatchesMappingQualifiers(anime, mapping));
}

export function filterMappingTargetCandidates(animes, mapping) {
  return (Array.isArray(animes) ? animes : []).filter(anime => candidateMatchesMappingTitle(anime, mapping));
}
