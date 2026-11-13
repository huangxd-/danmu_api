import { convertChineseNumber } from './common-util.js';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { httpGet } from "./http-util.js";
import { isNonChinese } from "./zh-util.js";
import { searchBangumiData } from './bangumi-data-util.js';
import { getWikipediaPersonMetadata } from './wikipedia-person-util.js';
import { getBaiduPersonMetadata } from './baidu-person-util.js';
import { cachedPersonSource, personCacheIdentity, readCachedPersonSources } from './person-source-cache.js';

// ---------------------
// TMDB API 工具方法
// ---------------------

// 全局任务队列，用于管理并发请求的合并与中断
// Key: title, Value: { promise, controller, refCount }
const TMDB_PENDING = new Map();
const TMDB_ACTOR_NAMES_PENDING = new Map();

// TMDB API 请求基础函数
async function tmdbApiGet(url, options = {}) {
  const tmdbApi = "https://api.tmdb.org/3/";
  const tartgetUrl = `${tmdbApi}${url}`;
  // 使用统一的代理 URL 构建方法
  const nextUrl = globals.makeProxyUrl(tartgetUrl);

  try {
    const response = await httpGet(nextUrl, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      signal: options.signal // 透传中断信号
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    // 如果是中断信号，抛出以供上层处理
    if (error.name === 'AbortError') {
       throw error;
    }
    log("error", "[system] [tmdb] Api error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

function readTmdbData(response) {
  if (!response?.data) return null;
  if (typeof response.data !== 'string') return response.data;
  try {
    return JSON.parse(response.data);
  } catch {
    return null;
  }
}

// 允许由 TMDB 反代/网关提供认证；直连时仍可通过 TMDB_API_KEY 认证。
function tmdbQuery(params = {}) {
  const query = new URLSearchParams();
  if (globals.tmdbApiKey) query.set('api_key', globals.tmdbApiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export function personLookupTitle(value) {
  return String(value || '').normalize('NFKC')
    .replace(/(?:\s+|(?<=】))from\s+.*$/i, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\((?:19|20)\d{2}\)/g, '')
    .trim();
}

/** Only strip explicit season suffixes; keep the original title for exact matching. */
export function personSeasonContext(title) {
  const fullTitle = personLookupTitle(title);
  const match = fullTitle.match(/\s*(?:第\s*([0-9一二三四五六七八九十百]+)\s*季|(最终|最終|完结|完結)季|season\s*(\d+)|\s+s(\d+)|(?<!\d)(\d{1,2}))\s*$/i);
  const baseTitle = match ? fullTitle.slice(0, match.index).trim() : fullTitle;
  const number = match && !match[2] ? Number(match[1] ? convertChineseNumber(match[1]) : match[3] || match[4] || match[5]) : null;
  return { fullTitle, baseTitle, season: number, finalSeason: Boolean(match?.[2]), hasSeason: Boolean(match && baseTitle),
    year: String(title || '').normalize('NFKC').match(/\(((?:19|20)\d{2})\)/)?.[1] || '' };
}

async function resolveSeasonPersonCandidate(title) {
  const context = personSeasonContext(title);
  if (!context.hasSeason) return null;
  const response = readTmdbData(await searchTmdbTitles(context.baseTitle, 'tv', { page: 1 }));
  const exact = (response?.results || []).filter(item => [item.name, item.original_name]
    .some(name => normalizePersonLookupTitle(name) === normalizePersonLookupTitle(context.baseTitle)));
  if (exact.length > 5) return null;
  const validated = await Promise.all(exact.map(async item => {
    const detail = readTmdbData(await tmdbApiGet(`tv/${item.id}?${tmdbQuery({ language: 'zh-CN' })}`));
    if (!detail || ![detail.name, detail.original_name].some(name =>
      normalizePersonLookupTitle(name) === normalizePersonLookupTitle(context.baseTitle))) return null;
    const seasons = (detail.seasons || []).filter(season => season.season_number > 0);
    const number = context.finalSeason ? Math.max(0, ...seasons.map(season => season.season_number)) : context.season;
    const season = seasons.find(season => season.season_number === number);
    if (!season || (context.year && String(season.air_date || '').slice(0, 4) !== context.year)) return null;
    return { ...detail, media_type: 'tv', personSeason: { number, year: String(season.air_date || '').slice(0, 4) } };
  }));
  const matches = validated.filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

function normalizePersonLookupTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

export function selectTmdbActorCandidate(results, title) {
  const query = normalizePersonLookupTitle(personLookupTitle(title));
  const requestedYear = String(title || '').normalize('NFKC').match(/\(((?:19|20)\d{2})\)/)?.[1] || '';

  const candidates = (Array.isArray(results) ? results : [])
    .filter(item => item && (item.media_type === 'tv' || (!personSeasonContext(title).hasSeason && item.media_type === 'movie')))
    .map((item, index) => {
      const titles = [item.name, item.title, item.original_name, item.original_title]
        .map(normalizePersonLookupTitle)
        .filter(Boolean);
      let score = Math.max(...titles.map(candidate => {
        if (!query || !candidate) return 0;
        if (candidate === query) return 100;
        return 0;
      }), 0);
      const resultYear = String(item.first_air_date || item.release_date || '').slice(0, 4);
      if (requestedYear && resultYear !== requestedYear) score = 0;
      score += Math.max(0, 10 - index) / 100;
      return { item, score };
    })
    .filter(candidate => candidate.score >= 100)
    .sort((a, b) => b.score - a.score);
  // 无年份时不能仅凭搜索排名选择不同年份的同名作品。
  return candidates.length === 1 ? candidates[0].item : null;
}

export function isDomesticTmdbProduction(candidate) {
  const countries = Array.isArray(candidate?.origin_country) ? candidate.origin_country : [];
  const language = String(candidate?.original_language || '').toLowerCase();
  return countries.some(country => ['CN', 'HK', 'TW'].includes(country))
    || ['zh', 'cn', 'yue'].includes(language);
}

function normalizeTmdbChineseName(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .replace(/^(?:饰演?|配音|as)\s*/i, '')
    .trim();
  if (!/\p{Script=Han}/u.test(name) || Array.from(name.replace(/\s/g, '')).length < 2) return '';
  if (/^(?:本人|自己|演员|角色|未知|旁白)$/.test(name)) return '';
  return name;
}

function splitTmdbCharacterNames(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  if (!raw) return [];

  const variants = new Set();
  for (const part of raw.split(/\s*(?:\/|\||｜|、|,|，|&|＆)\s*/)) {
    variants.add(part);
    // NFKC 已把全角括号转成 ASCII；保留角色主名，去掉“少年/配音”等说明。
    variants.add(part.replace(/\([^)]*\)/g, '').trim());
  }
  return [...variants].map(normalizeTmdbChineseName).filter(Boolean);
}

export function extractTmdbChineseCastNames(credits, mediaType = 'movie') {
  const actorNames = new Set();
  const characterNames = new Set();
  for (const cast of (credits?.cast || [])) {
    for (const value of [cast?.name, cast?.original_name]) {
      const name = normalizeTmdbChineseName(value);
      if (name) actorNames.add(name);
    }
    const roles = mediaType === 'tv'
      ? (cast?.roles || []).map(role => role?.character)
      : [cast?.character];
    for (const role of roles) {
      for (const name of splitTmdbCharacterNames(role)) characterNames.add(name);
    }
  }
  for (const crew of (credits?.crew || [])) {
    const isHost = /host|presenter|主持/i.test(crew?.job || '')
      || (Array.isArray(crew?.jobs) && crew.jobs.some(j => /host|presenter|主持/i.test(j?.job || '')));
    if (isHost) {
      for (const value of [crew?.name, crew?.original_name]) {
        const name = normalizeTmdbChineseName(value);
        if (name) actorNames.add(name);
      }
    }
  }
  return {
    actorNames: [...actorNames],
    characterNames: [...characterNames],
    names: [...new Set([...actorNames, ...characterNames])]
  };
}

/**
 * 从 TMDB 搜索当前国产/港台作品并取得其中文演员名。
 * 不要求应用层配置 TMDB_API_KEY；无 Key 时交由反代/网关认证，直连失败则安全返回空数组。
 * 仅接受标题、指定年份一致的唯一候选；非华语作品或无法可靠匹配时返回空名单，
 * 避免把普通人名、外国演员或角色名当成国内明星。
 */
export function selectBangumiPersonSubject(results, title) {
  const query = normalizePersonLookupTitle(personLookupTitle(title));
  const year = String(title || '').normalize('NFKC').match(/\(((?:19|20)\d{2})\)/)?.[1];
  const matches = (Array.isArray(results) ? results : []).filter(item => item?.type === 2
    && [item.name, item.name_cn].some(name => normalizePersonLookupTitle(name) === query)
    && (!year || String(item.date || item.air_date || '').slice(0, 4) === year));
  return matches.length === 1 ? matches[0] : null;
}

export async function getBangumiPersonResponse(url, validate) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'xlmc/danmu_api (https://github.com/xlmc/danmu_api)' };
  const request = async target => {
    // httpGet 的内部超时在收到响应头后结束；此处覆盖响应体读取。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await httpGet(target, { headers, timeout: 5000, signal: controller.signal, validStatusCodes: [404] });
      if (response.status === 404) {
        const error = new Error('Bangumi 资源不存在');
        error.status = 404;
        throw error;
      }
      if (response.status !== 200 || !validate(readTmdbData(response))) throw new Error('Bangumi 响应无效');
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  // 有适用代理时直接使用，不逐次等待直连失败；未配置则使用原地址。
  return request(globals.makeProxyUrl(url));
}

async function getBangumiCharacterNames(title, onProgress) {
  // NAS 的内置中转只转发 GET，使用已验证的公开 GET 搜索接口。
  // 优先复用本地作品 ID；详情校验仍须通过精确名称及年份检查。
  let subject = null;
  if (globals.useBangumiData) {
    const local = (await searchBangumiData(personLookupTitle(title), ['bangumi'])).filter(item =>
      item.titles.some(name => normalizePersonLookupTitle(name) === normalizePersonLookupTitle(personLookupTitle(title))));
    if (local.length === 1 && /^\d+$/.test(String(local[0].siteId))) {
      const detail = readTmdbData(await getBangumiPersonResponse(`https://api.bgm.tv/v0/subjects/${local[0].siteId}`, data => Boolean(data?.id)));
      subject = selectBangumiPersonSubject(detail ? [detail] : [], title);
    }
  }
  if (!subject) {
    const searchUrl = `https://api.bgm.tv/search/subject/${encodeURIComponent(personLookupTitle(title))}?type=2&responseGroup=large&max_results=20`;
    const response = await getBangumiPersonResponse(searchUrl, data => Array.isArray(data?.list));
    subject = selectBangumiPersonSubject(readTmdbData(response)?.list, title);
  }
  if (!subject) throw new Error('Bangumi 未找到唯一且年份一致的动画条目');
  return getBangumiSeriesCharacterNames(subject.id, onProgress);
}

/** 仅沿动画前传/续集关系收集角色；限制条目数以避免异常关联图无限扩展。 */
export async function getBangumiSeriesCharacterNames(subjectId, onProgress) {
  const limit = 12;
  const subjectIds = [];
  const seen = new Set([Number(subjectId)]);
  const pending = [Number(subjectId)];
  const names = new Set();
  let incomplete = false;
  while (pending.length) {
    const id = pending.shift();
    subjectIds.push(id);
    const results = await Promise.allSettled([
      getBangumiPersonResponse(`https://api.bgm.tv/v0/subjects/${id}/characters`, Array.isArray).then(response => {
        for (const item of readTmdbData(response)) {
          const name = normalizeTmdbChineseName(item.name);
          if (name) names.add(name);
        }
        onProgress?.([...names]);
        return response;
      }),
      getBangumiPersonResponse(`https://api.bgm.tv/v0/subjects/${id}/subjects`, Array.isArray),
    ]);
    const [characters, relations] = results;
    if (characters.status === 'fulfilled') {
      const entries = readTmdbData(characters.value);
      if (entries.length === 0) incomplete = true;
    } else {
      incomplete = true;
      log('warn', `[system] [person-metadata] Bangumi ${id} 角色加载失败，保留已取得名单: ${characters.reason.message}`);
    }
    if (relations.status === 'fulfilled') {
      for (const item of readTmdbData(relations.value)) {
        const nextId = Number(item.id);
        if (item.type !== 2 || !['前传', '续集'].includes(item.relation)
          || !Number.isSafeInteger(nextId) || nextId <= 0 || seen.has(nextId)) continue;
        if (seen.size >= limit) { incomplete = true; continue; }
        seen.add(nextId);
        pending.push(nextId);
      }
    } else {
      incomplete = true;
      log('warn', `[system] [person-metadata] Bangumi ${id} 季度关系加载失败: ${relations.reason.message}`);
    }
  }
  log(incomplete ? 'warn' : 'info', `[system] [person-metadata] Bangumi 跨季条目 ${subjectIds.join(',')}，角色 ${names.size} 个，查询${incomplete ? '未完整，稍后重试' : '成功'}`);
  return { subjectId: Number(subjectId), subjectIds, names: [...names], incomplete };
}

const emptyPersonMetadata = (status = 'unavailable') => ({ actorNames: [], characterNames: [], names: [], status });
const copyPersonMetadata = value => ({ ...value, actorNames: value.actorNames.slice(), characterNames: value.characterNames.slice(), names: value.names.slice() });

export function mergePersonMetadata(...values) {
  const actorNames = [...new Set(values.flatMap(value => value?.actorNames || []))];
  const characterNames = [...new Set(values.flatMap(value => value?.characterNames || []))];
  const names = [...new Set([...actorNames, ...characterNames, ...values.flatMap(value => value?.names || [])])];
  return { ...Object.assign({}, ...values), actorNames, characterNames, names,
    status: values.some(value => value?.status === 'ready') ? 'ready' : names.length ? 'partial' : 'unavailable',
    workTitles: [...new Set(values.flatMap(value => value?.workTitles || []))] };
}

async function readCachedPersonMetadata(cacheKey, searchTitle) {
  const sources = await readCachedPersonSources(`${cacheKey}:`);
  const identity = sources.get('identity')?.value;
  const credits = identity ? sources.get(`${identity.media_type}/${identity.id}:credits-v2`) : null;
  const providers = [credits, sources.get('wiki'), sources.get('baidu-v2'), sources.get('bangumi')].filter(Boolean);
  const metadata = mergePersonMetadata(credits?.value, sources.get('wiki')?.value, sources.get('baidu-v2')?.value,
    { characterNames: sources.get('bangumi')?.value.names || [], workTitles: [searchTitle] });
  const animation = identity?.genre_ids?.includes(16) || identity?.genres?.some(genre => genre.id === 16);
  if (identity && credits && sources.has('wiki') && (!animation || sources.has('bangumi'))
      && !sources.get('identity').stale && providers.every(source => !source.stale)
      && metadata.actorNames.length && metadata.characterNames.length) metadata.status = 'ready';
  return metadata;
}

// awaitNames: 只要先拿到一批人名就返回，用于弹幕过滤——冷缓存下拿到身份与演员表（约 1~3 秒）即可先拦一轮，
// 不必等别名、百科等补充来源跑完；其余调用方仍等完整名单或预算耗尽。
async function waitForPersonMetadata(state, title, budgetMs, awaitNames = false) {
  let timer;
  try {
    const named = awaitNames && state.namesReady.then(() => {
      log('info', `[system] [person-metadata] 「${title}」先取得演员 ${state.value.actorNames.length} 个、角色 ${state.value.characterNames.length} 个，立即用于本次过滤；剩余来源继续补齐缓存`);
      return state.value;
    });
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        log('warn', `[system] [person-metadata] 「${title}」等待达到 ${budgetMs}ms，先使用演员 ${state.value.actorNames.length} 个、角色 ${state.value.characterNames.length} 个；剩余查询继续补齐缓存`);
        resolve(state.value);
      }, budgetMs);
    });
    return copyPersonMetadata(await Promise.race(named ? [state.task, named, timeout] : [state.task, timeout]));
  } finally { clearTimeout(timer); }
}

export async function getDomesticPersonMetadataForTitle(title, { budgetMs = 1500, cachedOnly = false, awaitNames = false } = {}) {
  if (!String(title || '').trim()) return emptyPersonMetadata();

  const context = personSeasonContext(title);
  const searchTitle = context.fullTitle;
  const year = context.year;
  const cacheKey = await personCacheIdentity([normalizePersonLookupTitle(searchTitle), year,
    globals.tmdbApiKey || '', globals.proxyUrl || '', Boolean(globals.useBangumiData), ...(context.hasSeason ? ['season-identity-v2'] : [])]);
  if (!searchTitle) return emptyPersonMetadata();

  const pending = TMDB_ACTOR_NAMES_PENDING.get(cacheKey);
  if (cachedOnly) {
    return pending ? copyPersonMetadata(pending.value) : readCachedPersonMetadata(cacheKey, searchTitle);
  }
  if (pending) {
    return waitForPersonMetadata(pending, title, budgetMs, awaitNames);
  }

  const state = { value: emptyPersonMetadata(), task: null };
  let resolveNames = null;
  // 首个非空名单出现时提前唤醒等待方，避免预算耗尽时仍在用空名单过滤。
  state.namesReady = new Promise(resolve => { resolveNames = resolve; });
  const publish = (value = {}) => {
    state.value = mergePersonMetadata(state.value, value);
    if (resolveNames && state.value.names.length > 0) {
      resolveNames();
      resolveNames = null;
    }
  };
  const task = (async () => {
    try {
      publish(await readCachedPersonMetadata(cacheKey, searchTitle));
      // 复用 bangumi-data 中已经建立的 TMDB ID 映射，并用详情再次校验身份。
      const identity = await cachedPersonSource(`${cacheKey}:identity`, async () => {
        let candidate = null;
        if (globals.useBangumiData) {
          const local = (await searchBangumiData(searchTitle, ['tmdb'])).filter(item => item.titles.some(name =>
            normalizePersonLookupTitle(name) === normalizePersonLookupTitle(searchTitle))
            && (!year || String(item.begin || '').slice(0, 4) === year));
          if (local.length === 1 && /^(tv|movie)\/\d+$/.test(String(local[0].siteId))) {
            const [mediaType, id] = local[0].siteId.split('/');
            const detail = readTmdbData(await tmdbApiGet(`${mediaType}/${id}?${tmdbQuery({ language: 'zh-CN' })}`));
            candidate = selectTmdbActorCandidate(detail ? [{ ...detail, media_type: mediaType }] : [], title);
          }
        }
        if (!candidate) {
          const searchResponse = await searchTmdbTitles(searchTitle, 'multi', { page: 1 });
          candidate = selectTmdbActorCandidate(readTmdbData(searchResponse)?.results, title);
        }
        if (!candidate) candidate = await resolveSeasonPersonCandidate(title);
        return candidate;
      }, value => Boolean(value?.id) && ['tv', 'movie'].includes(value.media_type));
      const candidate = identity.value;
      if (!candidate) {
        log('warn', `[system] [tmdb] 未找到可靠的 TMDB 作品匹配，继续独立校验补充来源: ${title}`);
      }

      const creditsPath = candidate?.media_type === 'tv' ? 'aggregate_credits' : 'credits';
      const isAnimation = candidate?.genre_ids?.includes(16) || candidate?.genres?.some(genre => genre.id === 16)
        || (!candidate && /【[^】]*(?:动漫|动画)/.test(title));
      const sourceTitle = candidate?.personSeason ? (candidate.name || candidate.original_name) : searchTitle;
      const sourceYear = candidate?.personSeason ? String(candidate.first_air_date || '').slice(0, 4)
        : year || String(candidate?.first_air_date || candidate?.release_date || '').slice(0, 4);
      const bangumiTitle = `${sourceTitle}${sourceYear ? `(${sourceYear})` : ''}`;
      publish({ workTitles: [searchTitle, candidate?.name, candidate?.original_name, candidate?.title, candidate?.original_title].filter(Boolean) });
      // Independent providers load together; partial failure must not discard another provider's names.
      const creditsLoader = async () => {
        const response = readTmdbData(await tmdbApiGet(
          `${candidate.media_type}/${candidate.id}/${creditsPath}?${tmdbQuery({ language: 'zh-CN' })}`));
        if (!Array.isArray(response?.cast)) throw new Error('TMDB 演员表获取失败');
        const names = extractTmdbChineseCastNames(response, candidate.media_type);
        publish(names);
        const ids = [...new Set(response.cast.filter(person => Number.isInteger(person.id) && person.id > 0).map(person => person.id))];
        // 演员表不含本名/别名；按人物 ID 补详情，缓存跨作品复用，分批避免同时请求整个演员表。
        for (let i = 0; i < ids.length; i += 5) {
          const aliases = await Promise.all(ids.slice(i, i + 5).map(async id => {
            const key = await personCacheIdentity(['tmdb-person-alias-v1', id, globals.tmdbApiKey || '', globals.proxyUrl || '']);
            return cachedPersonSource(`${key}:person-aliases`, async () => {
              const person = readTmdbData(await tmdbApiGet(`person/${id}?${tmdbQuery({ language: 'zh-CN' })}`));
              if (person?.id !== id || !Array.isArray(person.also_known_as)) throw new Error('TMDB 人物详情缺少有效别名字段');
              return [...new Set([person.name, ...person.also_known_as].map(normalizeTmdbChineseName).filter(Boolean))];
            }, value => Array.isArray(value));
          }));
          for (const result of aliases) {
            names.actorNames = [...new Set([...names.actorNames, ...(result.value || [])])];
            if (result.stale) names.aliasesIncomplete = true;
          }
          publish(names);
        }
        return names;
      };
      const [creditsResult, bangumiResult, wikiResult] = await Promise.all([
        candidate ? cachedPersonSource(`${cacheKey}:${candidate.media_type}/${candidate.id}:credits-v2`, creditsLoader, value => Array.isArray(value?.actorNames) && Array.isArray(value?.characterNames) && value.actorNames.length + value.characterNames.length > 0, value => !value.aliasesIncomplete)
          .then(result => { publish(result.value || {}); return result; }) : Promise.resolve({ value: null, stale: true }),
        isAnimation ? cachedPersonSource(`${cacheKey}:bangumi`, () => getBangumiCharacterNames(bangumiTitle, characterNames => publish({ characterNames })),
          value => Array.isArray(value?.names) && value.names.length > 0, value => !value.incomplete)
          .then(result => { publish({ characterNames: result.value?.names || [] }); return result; }) : Promise.resolve(null),
        cachedPersonSource(`${cacheKey}:wiki`, async () => {
          let res = await getWikipediaPersonMetadata(sourceTitle, sourceYear);
          if ((!res || res.actorNames.length + res.characterNames.length === 0) && context.hasSeason) {
            const CHINESE_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
            const zhSeason = (context.season > 0 && context.season <= 10) ? CHINESE_DIGITS[context.season] : String(context.season);
            const seasonTitles = [
              `${context.baseTitle}_(第${zhSeason}季)`,
              `${context.baseTitle}第${zhSeason}季`
            ];
            for (const sTitle of seasonTitles) {
              try {
                const altRes = await getWikipediaPersonMetadata(sTitle, sourceYear);
                if (altRes && altRes.actorNames.length + altRes.characterNames.length > 0) {
                  res = altRes;
                  break;
                }
              } catch (_) {}
            }
          }
          return res;
        }, value => Array.isArray(value?.actorNames) && Array.isArray(value?.characterNames))
          .then(result => { publish(result.value || {}); return result; }),
      ]);
      const credits = creditsResult.value;
      const resolved = credits || { actorNames: [], characterNames: [] };
      let incomplete = identity.stale || creditsResult.stale || wikiResult.stale;
      let bangumiSubjectId = null;
      if (isAnimation) {
        const fallback = bangumiResult.value;
        if (fallback) {
          resolved.characterNames = [...new Set([...resolved.characterNames, ...fallback.names])];
          bangumiSubjectId = fallback.subjectIds.join(',');
        }
        if (bangumiResult.stale) incomplete = true;
      }
      const wiki = wikiResult.value;
      if (wiki) {
        resolved.actorNames = [...new Set([...resolved.actorNames, ...wiki.actorNames])];
        resolved.characterNames = [...new Set([...resolved.characterNames, ...wiki.characterNames])];
        log('info', `[system] [person-metadata] Wikipedia 当前作品演员 ${wiki.actorNames.length} 个、角色 ${wiki.characterNames.length} 个${wiki.sourceUrl ? `，来源 ${wiki.sourceUrl}，修订 ${wiki.revision}` : '，无对应条目'}`);
      }
      // 为弹幕入口已选中的当前作品补人物信息；不参与作品匹配，也不以 TMDB 身份匹配失败为触发条件。
      // 缺少演员表或角色表时补查百度；两边名单取并集，不覆盖已有数据。
      if (resolved.characterNames.length === 0 || resolved.actorNames.length === 0) {
        const baiduTitle = context.hasSeason ? searchTitle : sourceTitle;
        const baiduYear = context.hasSeason ? year : sourceYear;
        const baiduResult = await cachedPersonSource(`${cacheKey}:baidu-v2`,
          async () => {
            let res = null;
            let reason = '';
            try {
              res = await getBaiduPersonMetadata(baiduTitle, baiduYear, candidate?.media_type || '');
            } catch (error) { reason = error.message; }
            if ((!res || res.actorNames.length === 0) && context.hasSeason) {
              const CHINESE_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
              const zhSeason = (context.season > 0 && context.season <= 10) ? CHINESE_DIGITS[context.season] : String(context.season);
              try {
                res = await getBaiduPersonMetadata(`${context.baseTitle}第${zhSeason}季`, baiduYear, candidate?.media_type || '');
              } catch (error) { reason = error.message || reason; }
            }
            // 带上真实原因：此前统一报「未找到匹配条目」，把「字段名没对上」误报成「没有这个条目」。
            if (!res) throw new Error(`百度百科无可用条目：${reason || '未取得页面内容'}`);
            return res;
          },
          value => Array.isArray(value?.actorNames) && Array.isArray(value?.characterNames)
            && value.actorNames.length + value.characterNames.length > 0,
          value => !value.aliasesIncomplete && (value.actorNames.length > 0 || value.characterNames.length > 0));
        if (baiduResult.value) {
          const baidu = baiduResult.value;
          // 取并集，而不是只在演员表为空时采用：综艺的百度条目常比 TMDB 的中文演员表全
          // （《短剧X家族》TMDB 10 人、百度 14 人），只补空项会把百度独有的演员整批丢掉。
          resolved.actorNames = [...new Set([...resolved.actorNames, ...baidu.actorNames])];
          resolved.characterNames = [...new Set([...resolved.characterNames, ...baidu.characterNames])];
          log('info', `[system] [person-metadata] Baidu 补充当前作品演员 ${baidu.actorNames.length} 个、角色 ${baidu.characterNames.length} 个，合并后演员 ${resolved.actorNames.length} 个、角色 ${resolved.characterNames.length} 个，来源 ${baidu.sourceUrl}`);
        }
        if (baiduResult.stale) incomplete = true;
      }
      if (resolved.characterNames.length === 0 && resolved.actorNames.length === 0) incomplete = true;
      resolved.names = [...new Set([...resolved.actorNames, ...resolved.characterNames])];
      const status = resolved.names.length === 0 ? 'unavailable' : incomplete ? 'partial' : 'ready';
      log('info', `[system] [person-metadata] 「${title}」TMDB ${candidate ? `${candidate.media_type}/${candidate.id}${candidate.personSeason ? ` S${candidate.personSeason.number}(${candidate.personSeason.year})` : ''}` : '身份未匹配'}${bangumiSubjectId ? ` + Bangumi ${bangumiSubjectId}` : ''}，演员 ${resolved.actorNames.length} 个，角色 ${resolved.characterNames.length} 个，状态 ${status}`);
      state.value = mergePersonMetadata(state.value, { ...resolved, status,
        workTitles: [searchTitle, candidate?.name, candidate?.original_name, candidate?.title, candidate?.original_title].filter(Boolean) });
      state.value.status = status;
      return state.value;
    } catch (error) {
      log('warn', `[system] [tmdb] 作品演员表加载失败，保留已取得名单: ${error.message}`);
      return state.value;
    }
  })();

  state.task = task;
  TMDB_ACTOR_NAMES_PENDING.set(cacheKey, state);
  task.finally(() => TMDB_ACTOR_NAMES_PENDING.delete(cacheKey)).catch(() => {});
  return waitForPersonMetadata(state, title, budgetMs, awaitNames);
}

export async function getTmdbDomesticCastNamesForTitle(title) {
  return (await getDomesticPersonMetadataForTitle(title)).names;
}

// 使用 TMDB API 查询片名
export async function searchTmdbTitles(title, mediaType = "multi", options = {}) {
  const {
    page = 1,          // 起始页码
    maxPages = 3,      // 最多获取几页结果
    signal = null      // 中断信号
  } = options;

  // 如果指定了具体页码，只获取单页
  if (options.page !== undefined) {
    const url = `search/${mediaType}?${tmdbQuery({ query: title, language: 'zh-CN', page })}`;
    return await tmdbApiGet(url, { signal });
  }

  // 默认获取多页合并结果
  const allResults = [];

  for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
    // 检查是否中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const url = `search/${mediaType}?${tmdbQuery({ query: title, language: 'zh-CN', page: currentPage })}`;
    const response = await tmdbApiGet(url, { signal });

    if (!response || !response.data) {
      break;
    }

    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

    if (!data.results || data.results.length === 0) {
      break;
    }

    allResults.push(...data.results);

    // 如果当前页结果少于20条，说明没有更多结果了
    if (data.results.length < 20) {
      break;
    }
  }

  log("info", `[system] [tmdb] 共获取到 ${allResults.length} 条搜索结果（最多${maxPages}页）`);

  // 返回与原格式兼容的结构
  return {
    data: {
      results: allResults
    },
    status: 200
  };
}

// 使用 TMDB API 获取日语详情
export async function getTmdbMatchDetails(mediaType, tmdbId) {
  if (!['tv', 'movie'].includes(mediaType) || !/^\d+$/.test(String(tmdbId))) return null;
  return readTmdbData(await tmdbApiGet(`${mediaType}/${tmdbId}?${tmdbQuery({
    language: 'zh-CN', append_to_response: 'alternative_titles,translations'
  })}`));
}

// 剧集搜索可只提供 TMDB ID；沿用代理/网关认证和标题回退。
export async function getTmdbMediaTitleById(tmdbId, preferredMediaType = 'tv') {
  const id = String(tmdbId ?? '').trim();
  if (!/^\d+$/.test(id)) return null;

  const firstType = preferredMediaType === 'movie' ? 'movie' : 'tv';
  for (const mediaType of [firstType, firstType === 'tv' ? 'movie' : 'tv']) {
    const detail = readTmdbData(await tmdbApiGet(`${mediaType}/${id}?${tmdbQuery({ language: 'zh-CN' })}`));
    if (!detail) continue;
    const title = mediaType === 'tv'
      ? (detail.name || detail.original_name || '')
      : (detail.title || detail.original_title || '');
    if (!title) continue;
    log('info', `[system] [tmdb] 通过 ID 解析标题成功: ${id} (${mediaType}) -> ${title}`);
    const originalTitle = mediaType === 'tv' ? detail.original_name : detail.original_title;
    const releaseDate = mediaType === 'tv' ? detail.first_air_date : detail.release_date;
    const year = Number(String(releaseDate || '').match(/^(\d{4})/)?.[1]) || null;
    return { id: Number(detail.id) || Number(id), mediaType, title, originalTitle: originalTitle || title, year };
  }
  return null;
}

export async function getTmdbMatchEpisode(tmdbId, season, episode) {
  if (!/^[1-9]\d*$/.test(String(tmdbId)) || !Number.isInteger(season) || season < 0 ||
      !Number.isInteger(episode) || episode < 1) return null;
  return readTmdbData(await tmdbApiGet(`tv/${tmdbId}/season/${season}/episode/${episode}?${tmdbQuery({ language: 'zh-CN' })}`));
}

export async function getTmdbJpDetail(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}?api_key=${globals.tmdbApiKey}&language=ja-JP`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取external_ids
export async function getTmdbExternalIds(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/external_ids?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取别名
async function getTmdbAlternativeTitles(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/alternative_titles?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 从别名中提取中文别名相关函数
function extractChineseTitleFromAlternatives(altData, mediaType, queryTitle = "") {
  // 兼容不同 mediaType 的层级结构
  const titles = altData?.data?.results || altData?.data?.titles || [];
  if (!titles.length) return null;

  const cleanQuery = (queryTitle || "").toLowerCase().trim();
  const getStr = t => t.title || t.name || "";

  // 定义优先级判定规则数组，按先后顺序依次验证
  const priorityRules = [
    // 1. 最高优先级：精确命中用户搜索词
    t => cleanQuery && getStr(t).toLowerCase().trim() === cleanQuery,
    // 2. 地区优先级：按 CN > TW > HK > SG 顺序映射出 4 个规则函数
    ...['CN', 'TW', 'HK', 'SG'].map(region => 
      t => (t.iso_3166_1 || t.iso_639_1) === region && !isNonChinese(getStr(t))
    ),
    // 3. 兜底优先级：任何包含中文的别名
    t => !isNonChinese(getStr(t))
  ];

  // 遍历策略链，一旦有规则命中 (find 返回了对象)，立即提取并结束
  for (const rule of priorityRules) {
    const match = titles.find(rule);
    if (match) {
      const bestMatchTitle = getStr(match);
      log("info", `[system] [tmdb] 按优先级策略成功提取最佳中文别名: ${bestMatchTitle}`);
      return bestMatchTitle;
    }
  }

  return null;
}

// 别名获取判断相关函数
async function getChineseTitleForResult(result, signal, queryTitle = "") {
  const resultTitle = result.name || result.title || "";

  // 如果主标题正好完全匹配搜索词，直接返回
  if (queryTitle && resultTitle.toLowerCase().trim() === queryTitle.toLowerCase().trim()) {
    return resultTitle;
  }

  // 当主标题不是中文或者有搜索词但主标题没有完全命中时，才去拿别名池
  const needsAlternative = isNonChinese(resultTitle) || (queryTitle && resultTitle.toLowerCase().trim() !== queryTitle.toLowerCase().trim());

  if (!needsAlternative) {
    return resultTitle;
  }

  log("info", `[system] [tmdb] 尝试获取中文别名以寻找更优匹配 (当前标题: "${resultTitle}")`);

  const mediaType = result.media_type || (result.name ? "tv" : "movie");

  try {
    // 在发起别名请求前检查是否已中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const altResp = await getTmdbAlternativeTitles(mediaType, result.id, { signal });

    // 别名请求返回后再次检查（请求期间可能被中断）
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const chineseTitle = extractChineseTitleFromAlternatives(altResp, mediaType, queryTitle);

    if (chineseTitle) {
      log("info", `[system] [tmdb] 将使用中文别名进行相似匹配: ${chineseTitle}`);
      return chineseTitle;
    } else {
      log("info", `[system] [tmdb] 未找到中文别名，使用原标题: ${resultTitle}`);
      return resultTitle;
    }
  } catch (error) {
    // 遇到中断信号直接抛出
    if (error.name === 'AbortError') {
      throw error;
    }
    log("error", `[system] [tmdb] 获取别名失败: ${error.message}`);
    return resultTitle; // 失败则返回原标题
  }
}

// 使用TMDB API 查询日语原名，支持请求合并与引用计数控制
export async function getTmdbJaOriginalTitle(title, signal = null, sourceLabel = 'Unknown') {
  // 优化搜索关键词: 剥离 "Season 2", "第二季" 等后缀
  const cleanTitle = cleanSearchQuery(title);
  if (cleanTitle !== title) {
    log("info", `[system] [tmdb] 优化搜索关键词: "${title}" -> "${cleanTitle}"`);
  }

  // 优先尝试使用本地 Bangumi Data 获取原名与翻译，零延迟且无需 API Key
  if (globals.useBangumiData) {
    const localMatches = await searchBangumiData(cleanTitle, ['tmdb', 'bangumi', 'anidb']);
    if (localMatches && localMatches.length > 0) {
      // 按精确度排序：将正好匹配检索词的条目排在前面，避免子串混淆（如 "机动战士高达00" 匹配到 "机动战士高达0079"）
      if (localMatches.length > 1) {
        localMatches.sort((a, b) => {
          const aExact = a.titles.some(t => t === cleanTitle);
          const bExact = b.titles.some(t => t === cleanTitle);
          if (aExact && !bExact) return -1;
          if (!aExact && bExact) return 1;
          return 0;
        });
      }
      const m = localMatches[0]; // 取第一个最佳匹配
      const displayTitle = m.titles.find(t => t && t.includes(cleanTitle)) || m.titles[1] || m.title;
      const jaOriginalTitle = m.title; // Bangumi Data 的主标题就是原名

      log("info", `[system] [tmdb] Bangumi-Data 本地命中，提取原名成功: 原名=${jaOriginalTitle}, 别名=${displayTitle}（检索词：${cleanTitle}）`);
      return { title: stripSeasonMarker(jaOriginalTitle), cnAlias: displayTitle };
    }
  }

  if (!globals.tmdbApiKey) {
    log("info", "[system] [tmdb] 未配置API密钥，跳过TMDB网络搜索");
    return null;
  }

  // 检查是否已有相同关键词的搜索任务正在进行
  let task = TMDB_PENDING.get(cleanTitle);

  if (!task) {
    // 创建一个新的控制器，用于控制真正的后台网络请求
    const masterController = new AbortController();

    // 定义搜索核心逻辑
    const executeSearch = async () => {
      try {
        const backgroundSignal = masterController.signal;

        // 内部函数：判断单个媒体是否为动画或日语内容
        const isValidContent = (mediaInfo) => {
          const genreIds = mediaInfo.genre_ids || [];
          const genres = mediaInfo.genres || [];
          const allGenreIds = genreIds.length > 0 ? genreIds : genres.map(g => g.id);
          const originalLanguage = mediaInfo.original_language || '';
          const ANIMATION_GENRE_ID = 16;

          // 动画类型直接通过
          if (allGenreIds.includes(ANIMATION_GENRE_ID)) {
            return { isValid: true, reason: "明确动画类型(genre_id: 16)" };
          }

          // 日语内容通过（涵盖日剧、日影、日综艺）
          if (originalLanguage === 'ja') {
            return { isValid: true, reason: `原始语言为日语(ja),可能是日剧/日影/日综艺` };
          }

          return { 
            isValid: false, 
            reason: `非动画且非日语内容(language: ${originalLanguage}, genres: ${allGenreIds.join(',')})` 
          };
        };

        // 相似度计算函数
        const similarity = (s1, s2) => {
          // 标准化处理
          const normalize = (str) => {
            return str.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[：:、，。！？；""''（）【】《》]/g, '')
              .trim();
          };

          const n1 = normalize(s1);
          const n2 = normalize(s2);

          // 完全匹配
          if (n1 === n2) return 1.0;

          // 包含关系检查
          const shorter = n1.length < n2.length ? n1 : n2;
          const longer = n1.length >= n2.length ? n1 : n2;

          if (longer.includes(shorter) && shorter.length > 0) {
            // 如果有连词则得到一定加分
            const lengthRatio = shorter.length / longer.length;
            return 0.6 + (lengthRatio * 0.30);
          }

          // 编辑距离计算
          const longer2 = s1.length > s2.length ? s1 : s2;
          const shorter2 = s1.length > s2.length ? s2 : s1;
          if (longer2.length === 0) return 1.0;

          const editDistance = (str1, str2) => {
            str1 = str1.toLowerCase();
            str2 = str2.toLowerCase();
            const costs = [];
            for (let i = 0; i <= str1.length; i++) {
              let lastValue = i;
              for (let j = 0; j <= str2.length; j++) {
                if (i === 0) {
                  costs[j] = j;
                } else if (j > 0) {
                  let newValue = costs[j - 1];
                  if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                  }
                  costs[j - 1] = lastValue;
                  lastValue = newValue;
                }
              }
              if (i > 0) costs[str2.length] = lastValue;
            }
            return costs[str2.length];
          };

          return (longer2.length - editDistance(longer2, shorter2)) / longer2.length;
        };

        // 第一步：TMDB搜索
        log("info", `[system] [tmdb] 正在搜索 (Shared Task): ${cleanTitle}`);

        // 检查 masterController 是否已被中断
        if (backgroundSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        const respZh = await searchTmdbTitles(cleanTitle, "multi", { signal: backgroundSignal });

        if (!respZh || !respZh.data) {
          log("info", "[system] [tmdb] TMDB搜索结果为空");
          return null;
        }

        const dataZh = typeof respZh.data === "string" ? JSON.parse(respZh.data) : respZh.data;

        if (!dataZh.results || dataZh.results.length === 0) {
          log("info", "[system] [tmdb] TMDB未找到任何结果");
          return null;
        }

        // 第二步：数据清洗与类型严格过滤
        // 拦截所有非目标类型条目，确保只有动画或日文条目能进入核心匹配池
        const validResults = [];
        const invalidItems = [];

        for (const item of dataZh.results) {
          const validation = isValidContent(item);
          if (validation.isValid) {
            validResults.push(item);
          } else {
            const itemTitle = item.name || item.title || "未知";
            invalidItems.push(`${itemTitle}(${validation.reason})`);
          }
        }

        if (validResults.length === 0) {
          log("info", `[system] [tmdb] 数据清洗拦截: 搜索结果中没有任何目标类型(动画/日文)的内容`);
          return null;
        }

        log("info", `[system] [tmdb] 数据清洗完成: 保留 ${validResults.length} 个有效条目参与匹配，过滤 ${invalidItems.length} 个无关条目${invalidItems.length > 0 ? '，过滤详情: ' + invalidItems.join(', ') : ''}`);

        // 第三步：在干净的结果池中找到最相似的结果
        let bestMatch = null;
        let bestScore = -1;
        let bestMatchChineseTitle = null;
        let alternativeTitleFetchCount = 0; // 别名获取计数器
        const MAX_ALTERNATIVE_FETCHES = 5; // 最多获取5个别名
        let skipAlternativeFetch = false; // 是否跳过后续别名获取

        // 遍历经过严格过滤清洗后的干净结果池
        for (const result of validResults) {
          const resultTitle = result.name || result.title || "";
          if (!resultTitle) continue;

          // 先计算原标题的相似度
          const directScore = similarity(cleanTitle, resultTitle);
          const originalTitle = result.original_name || result.original_title || "";
          const originalScore = originalTitle ? similarity(cleanTitle, originalTitle) : 0;
          const initialScore = Math.max(directScore, originalScore);

          // 如果原标题已经100%匹配，标记跳过后续所有别名搜索
          if (initialScore === 1.0 && !skipAlternativeFetch) {
            skipAlternativeFetch = true;
            log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: 100.00% (完全匹配，跳过后续所有别名搜索)`);
            if (initialScore > bestScore) {
              bestScore = initialScore;
              bestMatch = result;
              bestMatchChineseTitle = resultTitle;
            }
            continue;
          }

          // 获取可用的中文标题
          let chineseTitle;
          let finalScore;

          // 检查原标题是否与查询词绝对一致
          const isExactMatch = resultTitle.toLowerCase().trim() === cleanTitle.toLowerCase().trim();

          // 如果强制跳过了，或者它本身就是我们要找的精确匹配词，不再调接口拿别名
          if (skipAlternativeFetch || isExactMatch) {
            chineseTitle = resultTitle;
            finalScore = initialScore;

            if (skipAlternativeFetch && isExactMatch) {
              log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}% (已找到完全匹配，跳过别名搜索)`);
            } else {
              log("info", `[system] [tmdb] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}%`);
            }
          } else {
            // 非完全匹配且未达到别名获取上限，尝试获取别名
            if (alternativeTitleFetchCount < MAX_ALTERNATIVE_FETCHES) {
              try {
                chineseTitle = await getChineseTitleForResult(result, backgroundSignal, cleanTitle);
                if (chineseTitle !== resultTitle) {
                  alternativeTitleFetchCount++;
                }
              } catch (error) {
                // 如果是中断错误，抛出
                if (error.name === 'AbortError') throw error;
                log("error", `[system] [tmdb] 处理结果失败: ${error.message}`);
                chineseTitle = resultTitle;
              }
            } else {
              chineseTitle = resultTitle;
              log("info", `[system] [tmdb] 已达到别名获取上限(${MAX_ALTERNATIVE_FETCHES})，使用原标题: ${resultTitle}`);
            }

            const finalDirectScore = similarity(cleanTitle, chineseTitle);
            finalScore = Math.max(finalDirectScore, originalScore);

            const displayInfo = chineseTitle !== resultTitle 
              ? `"${resultTitle}" (别名: ${chineseTitle})` 
              : `"${resultTitle}"`;
            log("info", `[system] [tmdb] 匹配检查 ${displayInfo} - 相似度: ${(finalScore * 100).toFixed(2)}%`);

            if (finalScore === 1.0 && !skipAlternativeFetch) {
              skipAlternativeFetch = true;
              log("info", `[system] [tmdb] 通过别名找到完全匹配，跳过后续所有别名搜索`);
            }
          }

          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestMatch = result;
            bestMatchChineseTitle = chineseTitle;
          }
        }

        const MIN_SIMILARITY = 0.4;
        if (!bestMatch || bestScore < MIN_SIMILARITY) {
          log("info", `[system] [tmdb] 最佳匹配相似度过低或未找到匹配 (${bestMatch ? (bestScore * 100).toFixed(2) + '%' : 'N/A'}),跳过`);
          return null;
        }

        log("info", `[system] [tmdb] TMDB最佳匹配: ${bestMatchChineseTitle}, 相似度: ${(bestScore * 100).toFixed(2)}%`);

        // 第四步：获取日语详情
        const mediaType = bestMatch.media_type || (bestMatch.name ? "tv" : "movie");

        const detailResp = await getTmdbJpDetail(mediaType, bestMatch.id, { signal: backgroundSignal });

        let jaOriginalTitle;
        if (!detailResp || !detailResp.data) {
          jaOriginalTitle = bestMatch.name || bestMatch.title;
          log("info", `[system] [tmdb] 使用中文搜索结果标题: ${jaOriginalTitle}`);
        } else {
          const detail = typeof detailResp.data === "string" ? JSON.parse(detailResp.data) : detailResp.data;
          jaOriginalTitle = detail.original_name || detail.original_title || detail.name || detail.title;
          log("info", `[system] [tmdb] 找到日语原名: ${jaOriginalTitle}`);
        }

        // 返回对象，包含原名和别名
        return { title: stripSeasonMarker(jaOriginalTitle), cnAlias: bestMatchChineseTitle };

      } catch (error) {
         if (error.name === 'AbortError') {
             log("info", `[system] [tmdb] 后台搜索任务已完全终止 (${cleanTitle})`);
             return null;
         }
         log("error", "[system] [tmdb] Background Search error:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
         });
         return null;
      }
    };

    // 初始化任务结构
    task = {
      controller: masterController,
      refCount: 0,
      promise: executeSearch().finally(() => {
        // 无论成功失败，移除 Map 记录
        TMDB_PENDING.delete(cleanTitle);
      })
    };

    TMDB_PENDING.set(cleanTitle, task);
    log("info", `[system] [tmdb] 启动新搜索任务: ${cleanTitle}`);
  } else {
    log("info", `[system] [tmdb] 加入正在进行的搜索: ${cleanTitle} (${sourceLabel})`);
  }

  // 增加引用计数
  task.refCount++;

  // 定义退出任务及释放计数的处理函数
  const leaveTask = () => {
    // 再次获取任务确认其仍存在
    const currentTask = TMDB_PENDING.get(cleanTitle);
    if (currentTask === task) {
        task.refCount--;
        if (task.refCount <= 0) {
            log("info", `[system] [tmdb] 所有调用者已取消，终止后台请求: ${cleanTitle}`);
            task.controller.abort();
        }
    }
  };

  // 声明局部变量以供全局释放
  let abortHandler;

  // 处理调用者主动中断的监听
  if (signal) {
    if (signal.aborted) {
        leaveTask();
        log("info", `[system] [tmdb] 搜索已被中断 (Source: ${sourceLabel})`);
        return null;
    }
    signal.addEventListener('abort', leaveTask);
  }

  // 使用 Race 机制等待结果或用户中断
  try {
    const userAbortPromise = new Promise((_, reject) => {
        if (signal) {
            abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', abortHandler);
        }
    });

    return await Promise.race([task.promise, userAbortPromise]);

  } catch (error) {
    if (error.name === 'AbortError') {
      log("info", `[system] [tmdb] 搜索已被中断 (Source: ${sourceLabel})`);
      return null;
    }
    log("error", `[system] [tmdb] 搜索异常: ${error.message}`);
    return null;
  } finally {
    // 释放并移除终止信号监听器，防止发生内存泄漏
    if (signal) {
      signal.removeEventListener('abort', leaveTask);
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}

/**
 * 查询 TMDB 获取中文标题
 * @param {string} title - 标题
 * @param {number|string} season - 季数（可选）
 * @param {number|string} episode - 集数（可选）
 * @returns {Promise<string>} 返回中文标题，如果查询失败则返回原标题
 */


// =====================
// 智能标题替换相关函数
// =====================

// 季与分部标记：第X季/期/部、第X赛段、2nd Season、1st STAGE、season N、sN、part/act/phase N、the final season
const SEASON_MARKER_SOURCE = '第?\\s*(?:\\d+|[一二三四五六七八九十]+)\\s*(?:[季期部]|赛段)|\\d+(?:st|nd|rd|th)\\s+(?:season|stage)|season\\s*\\d+|s\\d+|part\\s*\\d+|act\\s*\\d+|phase\\s*\\d+|the\\s+final\\s+season';

// 假名范围：波浪号两侧同为假名时属词内长音符（如「も～っと」「地獄先生ぬ～べ～」），不构成副标题分隔
const KANA_SOURCE = '\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC';

// 副标题分隔：冒号后须有空白；波浪号至少一侧非假名；半角、全角与 U+301C 波浪号一并识别
const SUBTITLE_SEPARATOR_SOURCE = `[:：]\\s|[~～\\u301C](?![${KANA_SOURCE}]|$)|(?<![${KANA_SOURCE}])[~～\\u301C]`;

// 识别季度、赛段、剧场版、外传、副标题等后缀信息的正则白名单
const SUFFIX_PATTERN = new RegExp(`(?:\\s+|^)(?:${SEASON_MARKER_SOURCE}|(?:movie|film|ova|oad|sp|剧场版|劇場版|续[篇集]|外传)(?![a-z]))|${SUBTITLE_SEPARATOR_SOURCE}|\\s+.*?篇|(?<=\\s|^)\\d+$`, 'i');

// 出站检索词只剥离季与分部标记，分隔符与影片类型词属于标题本身
const SEASON_MARKER_PATTERN = new RegExp(`(?:\\s+|^)(?:${SEASON_MARKER_SOURCE})`, 'i');

const SEPARATOR_REGEX = new RegExp(` |${SUBTITLE_SEPARATOR_SOURCE}`);

/**
 * 寻找标题中属于后缀或季度信息的起始位置
 * @param {string} title 原标题
 * @returns {number} 后缀起始索引
 */
function detectSuffixStart(title) {
  const match = title.match(SUFFIX_PATTERN);
  return match ? match.index : title.length;
}

/**
 * 利用后缀正则清洗搜索关键词，移除季度等信息以提高 TMDB 搜索命中率
 * @param {string} title 原始标题
 * @returns {string} 清洗后的标题主体
 */
export function cleanSearchQuery(title) {
  const limit = detectSuffixStart(title);
  if (limit < title.length) {
    return title.substring(0, limit).trim();
  }
  return title;
}

/**
 * 剥离标题中的季与分部标记，得到适合作为检索关键词的标题主体
 * 标记出现在标题开头或剥离后为空时保留原标题，避免检索关键词被清空
 * @param {string} title 原始标题
 * @returns {string} 去除季与分部标记的标题
 */
export function stripSeasonMarker(title) {
  const match = title.match(SEASON_MARKER_PATTERN);
  return match ? title.substring(0, match.index).trim() || title : title;
}

/**
 * 根据 TMDB 中文别名对番剧列表进行智能标题替换
 * @param {Array} animes 待处理的 anime 对象列表
 * @param {string} cnAlias TMDB 中文别名
 */
export function smartTitleReplace(animes, cnAlias) {
  if (!animes || animes.length === 0 || !cnAlias) return;

  let validCount = 0;
  // 遍历列表执行属性兜底赋值，并统计实际需要执行标题替换的有效条目数
  for (const anime of animes) {
    anime._displayTitle = anime._displayTitle || anime.title || "";
    if (!(anime.isLocalPriority || anime._displayTitle.includes(cnAlias))) {
      validCount++;
    }
  }

  // 若有效替换条目数为0，说明均已处理或无需处理，直接静默退出
  if (validCount === 0) return;

  log("info", `[system] [tmdb] 启动智能替换，目标别名: "${cnAlias}"，待处理条目: ${validCount}`);

  // 计算所有标题主体部分的 LCP (最长公共前缀)
  const baseTitles = animes.map(a => {
    const t = a.org_title || a.title || "";
    return t.substring(0, detectSuffixStart(t));
  });

  let lcp = "";
  if (baseTitles.length > 0) {
    const sorted = baseTitles.concat().sort();
    const a1 = sorted[0], a2 = sorted[sorted.length - 1];
    let i = 0;
    while (i < a1.length && a1.charAt(i) === a2.charAt(i)) i++;
    lcp = a1.substring(0, i);
  }

  if (lcp && lcp.length > 1) {
    log("info", `[system] [tmdb] 计算出最长公共前缀 (LCP): "${lcp}"`);
  }

  // 执行具体的智能替换策略
  for (const anime of animes) {
    const originalTitle = anime.title || "";

    // 过滤已被本地数据处理或已含目标别名的条目
    if (anime.isLocalPriority || originalTitle.includes(cnAlias)) continue;

    // 策略 A: LCP 模式
    if (lcp && lcp.length > 1 && originalTitle.startsWith(lcp)) {
      const suffix = originalTitle.substring(lcp.length).trim();
      anime._displayTitle = suffix ? `${cnAlias}${suffix.match(/^[~～:：]/) ? '' : ' '}${suffix}` : cnAlias;
      log("info", `[system] [tmdb] [LCP模式] "${originalTitle}" -> "${anime._displayTitle}"`);
    } else {
      const match = originalTitle.match(SEPARATOR_REGEX);
      if (match) {
        const prefix = originalTitle.substring(0, match.index).trim();
        const suffix = originalTitle.substring(match.index);
        // 策略 B1: 前缀保护模式（防止截断季数等特征前缀）
        if (prefix && SUFFIX_PATTERN.test(prefix)) {
          const subMatch = suffix.trim().match(SEPARATOR_REGEX);
          const subSuffix = subMatch ? suffix.trim().substring(subMatch.index) : '';
          anime._displayTitle = `${prefix} ${cnAlias}${subSuffix}`;
          log("info", `[system] [tmdb] [前缀保护模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        } else {
          // 策略 B2: 常规分隔符模式
          anime._displayTitle = cnAlias + suffix;
          log("info", `[system] [tmdb] [分隔符模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        }
      } else {
        // 策略 C: 安全兜底模式
        if (isNonChinese(originalTitle)) {
          anime._displayTitle = cnAlias;
          log("info", `[system] [tmdb] [纯外文全替模式] "${originalTitle}" -> "${anime._displayTitle}"`);
        } else {
          log("info", `[system] [tmdb] [跳过替换] "${originalTitle}" 含有中文且特征不符，拒绝强制全替以防误杀`);
        }
      }
    }
  }
}

// =====================
// TMDB 季边界映射
// =====================

/**
 * 将 bangumi-data 的 TMDB 扁平检索结果转换为跨季边界序列.
 * 每个 matchedSiteKey 为 'tmdb' 的结果, 其 siteId 形如 "tv/{id}" 或
 * "tv/{id}/season/N/episode/{M}", M 为该条目在 TMDB 绝对编号中的起始集数;
 * 收集同一 tv/{id} 下各条目起始集数即可推算跨季映射边界
 * @param {Array<Object>} matches searchBangumiData 返回的扁平结果数组
 * @returns {Array<{order:number, startEpisode:number, title:string, tmdbId:string}>|null}
 */
export function buildTmdbSeasonBoundaries(matches) {
  const baseMaps = new Map();

  for (const m of matches) {
    if (!m || m.matchedSiteKey !== 'tmdb' || !m.siteId) continue;

    const epMatch = m.siteId.match(/^(tv\/\d+)(?:\/season\/\d+\/episode\/(\d+))?$/);
    if (!epMatch) continue;

    const baseId = epMatch[1];
    const startEp = epMatch[2] ? parseInt(epMatch[2], 10) : 1;

    const entry = { order: 0, startEpisode: startEp, title: m.title || '', tmdbId: baseId };
    if (!baseMaps.has(baseId)) {
      baseMaps.set(baseId, [entry]);
    } else {
      baseMaps.get(baseId).push(entry);
    }
  }

  if (baseMaps.size === 0) return null;

  const best = [...baseMaps.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0];

  if (best[1].length < 2) return null;

  best[1].sort((a, b) => a.startEpisode - b.startEpisode);
  for (let i = 0; i < best[1].length; i++) {
    best[1][i].order = i + 1;
  }
  return best[1];
}

/**
 * 依据番剧标题从 bangumi-data 推导 TMDB 跨季边界, 用于在目标集不在首季时跳过无关季号
 * @param {string} title 检索标题 (直接传给 searchBangumiData, 内部已做季剥离处理)
 * @param {(title: string, siteKeys: string[]) => Promise<Array<Object>>} [searchFn]
 * @returns {Promise<Array<{order:number, startEpisode:number, title:string, tmdbId:string}>|null>}
 */
export async function getTmdbSeasonBoundaries(title, searchFn = searchBangumiData) {
  if (!globals.useBangumiData) return null;

  try {
    const matches = await searchFn(title, ['tmdb']);
    return buildTmdbSeasonBoundaries(matches);
  } catch (e) {
    log('warn', `[system] [tmdb] Bangumi-Data 本地获取TMDB季边界失败: ${e.message}（检索词：${title}）`);
    return null;
  }
}
