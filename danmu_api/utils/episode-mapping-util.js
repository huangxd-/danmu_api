import { convertChineseNumber, normalizeTitleForMatch } from './common-util.js';

// Part/cour/篇 are subdivisions, not seasons. Keep this stricter than source title parsing.
function parseSeasonTitle(value) {
  const title = String(value || '').replace(/\s*from\s+.+$/i, '').replace(/[（(](?:19|20)\d{2}[)）]|【[^】]*】/g, '').trim();
  const match = title.match(/第\s*([一二三四五六七八九十百\d]+)\s*季|\b(?:season\s*|s)(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
  return {
    season: match ? (match[1] ? convertChineseNumber(match[1]) : Number(match[2] || match[3])) : null,
    base: normalizeTitleForMatch(match ? title.slice(0, match.index) : title).replace(/\s+/g, ''),
    suffix: match ? title.slice(match.index + match[0].length).trim() : '',
    partOnly: !match && /\b(?:part|cour)\s*\d+|[前後后]半|[篇編]/i.test(title)
  };
}

function seasonIdentity(titles) {
  const parsed = titles.map(parseSeasonTitle);
  const seasons = new Set(parsed.map(t => t.season).filter(s => s !== null));
  return { parsed, season: seasons.size === 1 ? [...seasons][0] : null, conflict: seasons.size > 1 };
}

/** Build only unambiguous, contiguous seasons in a TMDB season-1 absolute numbering space. */
export function buildTmdbSeasonBoundaries(matches, { tvId = null } = {}) {
  const groups = new Map();
  for (const item of Array.isArray(matches) ? matches : []) {
    if (item?.matchedSiteKey !== 'tmdb' || (item.type && item.type !== 'tv')) continue;
    const site = String(item.siteId || '').match(/^tv\/(\d+)(?:\/season\/(\d+)\/episode\/(\d+))?$/);
    if (!site || (tvId !== null && String(tvId) !== site[1]) || (site[2] && Number(site[2]) !== 1)) continue;
    const key = `tv/${site[1]}`;
    if (!groups.has(key)) groups.set(key, []);
    const titles = [...new Set([item.title, ...(item.titles || [])].filter(Boolean))].sort();
    const identity = seasonIdentity(titles);
    // A bare series URL on a sequel duplicates the parent; it is not an episode-1 boundary.
    if (!site[3] && identity.season > 1 && !identity.conflict) continue;
    groups.get(key).push({ title: item.title, startEpisode: Number(site[3] || 1), titles, identity });
  }
  // Do not choose whichever unrelated TMDB ID happens to have the most entries.
  if (groups.size !== 1) return null;
  const [tmdbId, rows] = [...groups][0];
  const seasons = new Map();
  const titleStarts = new Map();
  for (const row of rows) {
    const { identity, startEpisode } = row;
    if (identity.conflict || !Number.isSafeInteger(startEpisode) || startEpisode < 1) return null;
    const titleKey = normalizeTitleForMatch(row.title || '');
    if (titleStarts.has(titleKey) && titleStarts.get(titleKey) !== startEpisode) return null;
    titleStarts.set(titleKey, startEpisode);
    const order = identity.season ?? (startEpisode === 1 && !identity.parsed.some(t => t.partOnly) ? 1 : null);
    if (!Number.isSafeInteger(order) || order < 1) return null;
    if (!seasons.has(order)) seasons.set(order, []);
    seasons.get(order).push(row);
  }
  if (seasons.size < 2) return null;
  const result = [...seasons].sort(([a], [b]) => a - b).map(([order, parts]) => {
    const titles = [...new Set(parts.flatMap(p => p.titles))].sort();
    const startEpisode = Math.min(...parts.map(p => p.startEpisode));
    const firstPartTitles = [...new Set(parts.filter(p => p.startEpisode === startEpisode).flatMap(p => p.titles))].sort();
    return { order, startEpisode, title: titles[0], titles, firstPartTitles, tmdbId };
  });
  const baseTitles = new Set(seasons.get(1)?.flatMap(row => row.identity.parsed.map(t => t.base)));
  for (let i = 0; i < result.length; i++) {
    const current = result[i];
    const next = result[i + 1];
    if (current.order !== i + 1 || (i === 0 && current.startEpisode !== 1)) return null;
    if (next && seasons.get(current.order).some(row => row.startEpisode >= next.startEpisode)) return null;
    if (seasons.get(current.order).some(row => row.startEpisode > current.startEpisode && !row.identity.parsed.some(t => t.suffix || t.partOnly))) return null;
    if (!seasons.get(current.order).some(row => row.identity.parsed.some(t => baseTitles.has(t.base)))) return null;
  }
  return result;
}

export function resolveTmdbEpisodeMapping(boundaries, season, episode) {
  if (season !== 1 || !Number.isSafeInteger(episode) || episode < 1 || !boundaries) return null;
  const boundary = boundaries.findLast(item => episode >= item.startEpisode);
  if (!boundary || boundary.order === 1) return null;
  return { season: boundary.order, episode: episode - boundary.startEpisode + 1, boundary };
}

/** Restrict automatic numbering to the same series and explicit real season, excluding spin-offs. */
export function matchesSeasonBoundary(anime, boundary) {
  if (!anime || /movie|ova|oad|special|电影|剧场|特[别別]/i.test(`${anime.type || ''} ${anime.typeDescription || ''}`)) return false;
  const identity = seasonIdentity([anime.animeTitle, ...(anime.aliases || [])].filter(Boolean));
  if (identity.conflict || identity.season !== boundary.order) return false;
  const bases = new Set(boundary.titles.map(parseSeasonTitle).filter(t => t.season === boundary.order).map(t => t.base));
  const primary = parseSeasonTitle(anime.animeTitle);
  if (primary.season !== boundary.order || !bases.has(primary.base)) return false;
  // Some sources retain the first cour's title while appending the rest of the season.
  // Its numbering starts at 1; later cours may restart at 1 and cannot be substituted.
  if (!primary.suffix) return true;
  return (boundary.firstPartTitles || []).some(title => {
    const first = parseSeasonTitle(title);
    return first.base === primary.base && first.season === primary.season && normalizeTitleForMatch(first.suffix) === normalizeTitleForMatch(primary.suffix);
  });
}
