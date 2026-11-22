import { globals } from "../../configs/globals.js";
import { jsonResponse } from "../../utils/http-util.js";
import { log } from "../../utils/log-util.js";
import { simplized } from "../../utils/zh-util.js";
import { convertChineseNumber, extractEpisodeTitle, extractEpisodeNumberFromTitle, extractSeasonNumberFromAnimeTitle, getExplicitSeasonNumber, stripEpisodePlatform, stripNonTitleChars } from "../../utils/common-util.js";
import { buildEpisodeCatalogs, filterEpisodesByTitle, filterSameEpisodeTitle, getBangumiDataForMatch, resolveCandidateSeason, resolveTitlePreference, scoreAnimePlatform, searchAnime } from "../dandan-api.js";
import { createPhaseTimer, markStepActive } from "../../utils/pipeline-trace.js";

// =====================
// FongMi 弹幕接口适配
// =====================

const FONGMI_TITLE_CLEAN_RULES = [
  [/[\(\[（【]\s*(19|20)\d{2}\s*[\)\]）】]/g, " "],
  [/\b(19|20)\d{2}\b/g, " "],
  [/\b(?:2160p|1080p|720p|4k|web-?dl|web-?rip|blu-?ray|hdr|dv|x265|x264|h\.?265|h\.?264|60fps)\b/gi, " "],
  [/[_.-]+/g, " "]
];

const FONGMI_EPISODE_CLEAN_RULES = [
  [/\[[^\]]*\]/g, " "],
  [/[【（(][^】）)]*[】）)]/g, " "],
  [/\.(mp4|mkv|avi|rmvb|ts|flv|mov|m4v)$/gi, " "],
  [/\b(?:2160p|1080p|720p|4k|web-?dl|web-?rip|blu-?ray|hdr|dv|x265|x264|h\.?265|h\.?264|60fps|aac|flac|dts)\b/gi, " "],
  [/[_~.-]+/g, " "]
];

const FONGMI_EPISODE_PATTERNS = [
  { pattern: /[Ss]\d{1,2}\s*[Ee](\d{1,4})/, group: 1 },                     // S01E05 / s1e5
  { pattern: /第\s*([零一二三四五六七八九十百零〇两\d]+)\s*[集期话章回段篇]/, group: 1, chinese: true },  // 第12集 / 第十二期
  { pattern: /[Ee][Pp]?\.?\s*(\d{1,4})/, group: 1 },                        // EP05 / Ep.5 / E5
  { pattern: /[Ee](\d{1,4})(?:\s|$|\.)/, group: 1 },                        // E05 后面有空格/结尾/点
  { pattern: /Episode\s*(\d{1,4})/i, group: 1 },                            // Episode 5
  { pattern: /(?:正在)?播放[：:]\s*(\d{1,4})/, group: 1 },                   // 播放:5 / 正在播放：12
  { pattern: /(?:第\s*)?[零一二三四五六七八九十百\d]+\s*季\s*[|｜]\s*(\d{1,4})/, group: 1 },  // 第1季|18 / 第一季｜05 (Emby格式)
  { pattern: /[\[【\(（](\d{1,4})[\]】\)）]/, group: 1 },                    // [05] / 【05】 / (05)
  { pattern: /@@@(\d{1,4})/, group: 1 },                                    // 剧名@@@5
  { pattern: /(?:^|[\s_\-])(\d{1,4})x(?:[\s_\-]|$)/i, group: 1 },          // 1x05 / 2-3x12-
  { pattern: /\s(\d{1,4})\.(?:mp4|mkv|avi|mov|mp3|1080|720|4k|2k)/i, group: 1 },  // 剧 05.mp4 / 名 12.1080p
  { pattern: /[_\-](\d{1,4})(?:\s|$|\.)/, group: 1 },                       // 剧名_05 / 名-12.
  { pattern: /\s(\d{1,4})\s/, group: 1 },                                   // 剧 05 名 (空格包围)
  { pattern: /\s(\d{1,4})$/, group: 1 },                                    // 剧名 05 (末尾数字)
  { pattern: /^(\d{1,4})\s/, group: 1 },                                    // 05 剧名 (开头数字)
  { pattern: /(\d{1,4})(?:\s|$)$/, group: 1 }                               // 剧名05 (结尾无空格)
];

const FONGMI_DATE_PATTERNS = [
  { pattern: /(\d{4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})/, type: "ymd" },  // 2025-05-13 / 2025.05.13 / 2025年5月13日
  { pattern: /(\d{4})(\d{2})(\d{2})/, type: "ymd_compact" }                 // 20250513 (8位紧凑日期)
];

/**
 * 规范化 FongMi 传入文本，统一大小写、空格和简繁体。
 * @param {string} value 原始文本
 * @returns {string} 规范化后的文本
 */
function normalizeFongmiText(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (globals.animeTitleSimplified) {
    try {
      text = simplized(text);
    } catch (e) {
      // 保底忽略简繁转换异常，继续使用原始文本
    }
  }
  return stripNonTitleChars(text.toLowerCase());
}

/**
 * 提取文本中的 8 位日期数字，兼容综艺类日期匹配。
 * @param {string} value 原始文本
 * @returns {string} 8 位日期数字，未提取到则返回空串
 */
function extractDateDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : "";
}

/**
 * 标题清洗正则预处理。
 * 这里预留独立函数，方便后续继续补充标题噪音规则。
 * @param {string} name 原始标题
 * @returns {string} 预处理后的标题
 */
function normalizeFongmiTitleByRegex(name) {
  let text = String(name || "");
  FONGMI_TITLE_CLEAN_RULES.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  return text;
}

/**
 * 集数文本正则预处理。
 * 这里先保留为空实现，后续补 PR 时可以继续扩充网盘命名兼容。
 * @param {string} episode 原始集数文本
 * @returns {string} 预处理后的集数文本
 */
function normalizeFongmiEpisodeByRegex(episode) {
  let text = String(episode || "");
  FONGMI_EPISODE_CLEAN_RULES.forEach(([pattern, replacement], i) => {
    text = text.replace(pattern, replacement);
  });
  const result = text.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * 从 FongMi 集数文本中提取更稳健的集数。
 * 除了复用公共提取逻辑外，再补充网盘命名常见格式。
 * @param {string} episode 原始集数文本
 * @returns {number|null} 集数，未提取到则返回 null
 */
function extractFongmiEpisodeNumber(episode) {
  if (!episode) return null;
  const text = String(episode);

  for (const { pattern, group, chinese } of FONGMI_EPISODE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[group] !== undefined) {
      const value = match[group];
      if (chinese) {
        const num = convertChineseNumber(value);
        if (num !== null && !isNaN(num)) return num;
      } else {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0 && num < 10000) return num;
      }
    }
  }

  for (const { pattern, type } of FONGMI_DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      if (type === "ymd") {
        const y = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const d = parseInt(match[3], 10);
        if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          return y * 10000 + m * 100 + d;
        }
      } else if (type === "ymd_compact") {
        const y = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const d = parseInt(match[3], 10);
        if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          return y * 10000 + m * 100 + d;
        }
      }
    }
  }

  const normalizedEpisode = normalizeFongmiEpisodeByRegex(episode);
  const commonNum = extractEpisodeNumberFromTitle(normalizedEpisode);
  if (commonNum !== null) return commonNum;

  return null;
}

/**
 * 从 FongMi 集数文本中提取显式季号。
 * 支持 S02E05 / 第2季第3集 / Season 2 / Part 2 / 2x05 等写法。
 * 分集文本中的「期」与「集」同义，只有显式标注且在 1~50 内的季号才参与匹配。
 * @param {string} episode 原始集数文本
 * @returns {number|null} 季号，无法识别时返回 null
 */
function extractFongmiSeasonNumber(episode) {
  if (!episode) return null;
  const text = String(episode);
  const season = getExplicitSeasonNumber(text.replace(/期/g, "集"));
  if (season !== null && Number.isFinite(season) && season >= 1 && season <= 50) return season;
  const match = text.match(/(?:^|[\s_\-])(\d{1,2})x(\d{1,4})(?:$|[\s_\-.])/i);
  if (match) {
    const seasonNum = parseInt(match[1], 10);
    if (seasonNum >= 1 && seasonNum <= 50) return seasonNum;
  }
  return null;
}

/**
 * 为 FongMi 标题生成搜索关键词列表。
 * 先保留原始标题，再追加正则清洗后的标题作为回退搜索词。
 * @param {string} name 原始标题
 * @returns {string[]} 搜索关键词数组
 */
function buildFongmiSearchKeywords(name) {
  const rawName = String(name || "").trim();
  if (!rawName) return [];

  const keywords = [];
  const pushKeyword = (value) => {
    const keyword = stripNonTitleChars(String(value || "").trim());
    if (!keyword || keywords.includes(keyword)) return;
    keywords.push(keyword);
  };

  pushKeyword(rawName);

  const cleanedName = stripNonTitleChars(normalizeFongmiTitleByRegex(rawName)).trim();
  if (cleanedName && cleanedName !== rawName) {
    pushKeyword(cleanedName);
  }

  const plainBracketName = stripNonTitleChars(rawName.replace(/[\(\[（【].*$/, "")).trim();
  if (plainBracketName && plainBracketName !== rawName) {
    pushKeyword(plainBracketName);
  }

  return keywords.sort((a, b) => a.length - b.length);
}

/**
 * 构建 FongMi 返回的弹幕基础地址。
 * 这里会尽量保留 token 前缀，避免 comment 接口丢失部署路径。
 * @param {Request} req 请求对象
 * @returns {string} 弹幕基础地址
 */
function buildFongmiApiBase(req) {
  const reqUrl = new URL(req.url);
  const path = reqUrl.pathname.replace(/\/{2,}/g, "/");
  const parts = path.split("/").filter(Boolean);
  const firstPart = parts[0] || "";
  const isExplicitToken = !!firstPart && (
    firstPart === globals.token ||
    (!!globals.adminToken && firstPart === globals.adminToken)
  );
  const tokenPrefix = isExplicitToken ? `/${firstPart}` : "";

  let routePath = isExplicitToken
    ? `/${parts.slice(1).join("/")}`
    : path;
  routePath = routePath.replace(/\/+$/, "");
  routePath = routePath.replace(/\/api\/v2\/fongmi\/danmaku$/, "");
  routePath = routePath.replace(/\/danmaku$/, "");

  return `${reqUrl.origin}${tokenPrefix}${routePath}`;
}

/**
 * 解析 FongMi 的请求参数，兼容 GET、JSON POST、表单 POST。
 * @param {URL} url 请求 URL
 * @param {Request} req 请求对象
 * @returns {Promise<{name: string, episode: string}>} 标题和集数文本
 */
async function parseFongmiRequestParams(url, req) {
  if (req.method === "GET") {
    return {
      name: url.searchParams.get("name") || "",
      episode: url.searchParams.get("episode") || ""
    };
  }

  try {
    const clonedReq = req.clone();
    const contentType = (clonedReq.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("application/json")) {
      const body = await clonedReq.json();
      return {
        name: body?.name || "",
        episode: body?.episode || ""
      };
    }

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const form = await clonedReq.formData();
      return {
        name: form.get("name") || "",
        episode: form.get("episode") || ""
      };
    }

    const text = await clonedReq.text();
    if (text) {
      try {
        const body = JSON.parse(text);
        return {
          name: body?.name || "",
          episode: body?.episode || ""
        };
      } catch (e) {
        const params = new URLSearchParams(text);
        return {
          name: params.get("name") || "",
          episode: params.get("episode") || ""
        };
      }
    }
  } catch (e) {
    log("warn", `[system] [fongmi] 解析请求参数失败: ${e.message}`);
  }

  return { name: "", episode: "" };
}

/**
 * 计算单个候选分集与目标分集的匹配得分。
 * 当前综合标题、季数、集数、日期做排序，后续可以继续扩展更多维度。
 * @param {Object} anime 候选剧集对象
 * @param {Object} episode 候选分集对象
 * @param {string} targetEpisode FongMi 传入的分集文本
 * @param {number} index 分集索引
 * @returns {number} 匹配得分
 */
function scoreFongmiEpisodeMatch(anime, episode, targetEpisode, index, useIndexBonus = true, seasonNumber) {
  let score = useIndexBonus ? Math.max(0, 200 - index) : 0;

  const normalizedTargetEpisode = normalizeFongmiEpisodeByRegex(targetEpisode);
  const targetText = normalizeFongmiText(normalizedTargetEpisode);
  if (!targetText) return score;

  const episodeTitle = episode?.episodeTitle || "";
  const episodeText = normalizeFongmiText(episodeTitle);
  const titleWithoutPlatform = normalizeFongmiText(extractEpisodeTitle(episodeTitle));
  const animeText = normalizeFongmiText(anime?.animeTitle || "");

  const targetNum = extractFongmiEpisodeNumber(normalizedTargetEpisode);
  const targetDate = extractDateDigits(normalizedTargetEpisode);
  const targetSeason = extractFongmiSeasonNumber(targetEpisode);
  const useSeasonNumber = seasonNumber != null && targetNum !== null && (targetSeason !== null || !targetDate);
  if (!useSeasonNumber) {
    if (episodeText === targetText || titleWithoutPlatform === targetText) score += 10000;
    if (episodeText.includes(targetText) || targetText.includes(episodeText)) score += 4500;
    if (titleWithoutPlatform && (titleWithoutPlatform.includes(targetText) || targetText.includes(titleWithoutPlatform))) score += 2500;
  }
  const episodeNum = useSeasonNumber ? seasonNumber : extractFongmiEpisodeNumber(episodeTitle);
  const episodeIndexNum = parseInt(episode?.episodeNumber || `${index + 1}`, 10);
  if (targetNum !== null && episodeNum !== null && targetNum === episodeNum) score += 7000;
  if (targetNum !== null && Number.isFinite(episodeIndexNum) && targetNum === episodeIndexNum) score += 4000;

  // 季数比对：目标与候选都带显式季号时严格区分（如"剧名 S02E05"应优先命中"第二季"条目）。
  // 集数加分对跨季同号集完全同分，胜负此前只由源返回顺序决定；这里同季加分、跨季重罚，
  // 保证跨季候选排到任何同季候选之后。任一侧无季标注则不调整，保持原有行为。
  const animeSeason = extractSeasonNumberFromAnimeTitle(anime?.animeTitle || "").season;
  if (targetSeason !== null && animeSeason !== null) {
    score += targetSeason === animeSeason ? 5000 : -12000;
  }

  const episodeDate = extractDateDigits(episodeTitle);
  if (targetDate && episodeDate && targetDate === episodeDate) score += 9000;

  if (targetDate && targetText.includes(targetDate)) score += 800;
  if (animeText.includes("综艺") && targetDate && episodeDate) score += 1200;

  if (animeText.includes("综艺") && targetDate && !episodeDate && targetNum === null) score -= 1500;

  return score;
}

function resolveFongmiEpisodeTarget(catalogs, target) {
  const normalized = normalizeFongmiEpisodeByRegex(target);
  const number = extractFongmiEpisodeNumber(normalized);
  if (number === null || extractFongmiSeasonNumber(target) !== null || extractDateDigits(normalized)) return target;

  const title = String(target).trim();
  let resolved;
  for (const { anime, data, seasonNumbers } of catalogs) {
    for (const episode of data?.bangumi?.episodes || []) {
      if (Number(episode.episodeNumber) === number) return target;
      const relative = seasonNumbers?.get(episode.episodeId);
      if (relative == null || (episode.episodeTitle !== title && stripEpisodePlatform(episode.episodeTitle) !== title)) continue;
      const seasonEpisode = `S${resolveCandidateSeason(anime)}E${relative}`;
      if (resolved && resolved !== seasonEpisode) return target;
      resolved = seasonEpisode;
    }
  }
  return resolved ?? target;
}

/**
 * 将搜索结果展开成 FongMi 可排序的候选分集列表。
 * @param {Iterable} catalogs 搜索结果及其分集编号
 * @param {string} apiBase 基础地址
 * @returns {Array} 候选分集数组
 */
function buildFongmiDanmakuItems(catalogs, apiBase) {
  const candidates = [];

  for (const { anime, data: bangumiData, seasonNumbers } of catalogs) {
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes?.length) continue;

    const episodes = filterSameEpisodeTitle(bangumiData.bangumi.episodes, { seasonNumbers });

    episodes.forEach((episode, index) => {
      const commentUrl = `${apiBase}/api/v2/comment/${encodeURIComponent(episode.episodeId)}?format=xml`;
      candidates.push({
        anime,
        episode,
        seasonNumber: seasonNumbers?.get(episode.episodeId),
        index,
        commentUrl
      });
    });
  }

  return candidates;
}

/**
 * FongMi 自定义弹幕接口。
 * 返回 FongMi 需要的 JSON 数组格式：[{ name, url }]
 * @param {URL} url 请求 URL
 * @param {Request} req 请求对象
 * @returns {Promise<Response>} 弹幕候选响应
 */
export async function getFongmiDanmaku(url, req) {
  const phase = createPhaseTimer();
  markStepActive('弹幕·参数解析');
  let { name, episode } = await parseFongmiRequestParams(url, req);

  phase('弹幕·参数解析', {
    status: name ? 'ok' : 'empty',
    reason: name ? undefined : '缺少剧名参数，无法检索',
    inputs: { keyword: name, episode },
    outputs: { candidateKeywords: buildFongmiSearchKeywords(name || '') },
  });

  if (!name) {
    return jsonResponse([], 200);
  }
  const mappedTitle = globals.resolveTitleMapping(name);
  const preference = resolveTitlePreference(name, mappedTitle, extractFongmiSeasonNumber(episode));
  const preferredPlatform = preference?.platform;
  if (mappedTitle) {
    log("info", `[system] [fongmi] Title mapped from original: ${name} to: ${mappedTitle}`);
    name = mappedTitle;
  }
  const searchUrl = new URL(url.toString());
  const detailStore = new Map();
  const keywords = buildFongmiSearchKeywords(name);
  let animes = [];
  let boundaries;

  for (const keyword of keywords) {
    searchUrl.searchParams.set("keyword", keyword);
    const searchRes = await searchAnime(searchUrl, null, null, detailStore, null, false, preference);
    const searchData = await searchRes.json();
    animes = Array.isArray(searchData?.animes) ? searchData.animes : [];
    if (preference) animes = animes.filter(preference.matches);
    if (animes.length) {
      boundaries = searchData.tmdbSeasonBoundaries;
      if (keyword !== name) {
        log("info", `[system] [fongmi] Search fallback hit: raw=${name}, keyword=${keyword}, episode=${episode}`);
      }
      break;
    }
  }

  if (!animes.length) {
    log("info", `[system] [fongmi] No danmaku candidates for name=${name}, episode=${episode}`);
    return jsonResponse([], 200);
  }

  markStepActive('弹幕·候选检索');
  phase('弹幕·候选检索', {
    status: animes.length === 0 ? 'empty' : 'ok',
    reason: animes.length === 0 ? '按剧名与回退关键词均未检索到剧集' : undefined,
    inputs: { keywords, episode },
    outputs: { animeCount: animes.length },
  });

  const apiBase = buildFongmiApiBase(req);
  const listings = buildEpisodeCatalogs(animes, detailStore, preference, boundaries);
  const catalogs = preference ? [...listings] : listings;
  const target = preference ? resolveFongmiEpisodeTarget(catalogs, episode) : episode;
  const candidates = buildFongmiDanmakuItems(catalogs, apiBase)
    .map(item => ({
      ...item,
      score: scoreFongmiEpisodeMatch(item.anime, item.episode, target, item.index, !preferredPlatform, item.seasonNumber),
      platformScore: preferredPlatform ? scoreAnimePlatform(item.anime, preferredPlatform, extractEpisodeTitle(item.episode.episodeTitle)) : 0
    }))
    .sort((left, right) => right.score - left.score || right.platformScore - left.platformScore || (preferredPlatform ? left.index - right.index : 0));

  const seen = new Set();
  const items = [];
  for (const candidate of candidates) {
    if (!candidate?.commentUrl || seen.has(candidate.commentUrl)) continue;
    seen.add(candidate.commentUrl);
    items.push({
      name: `${candidate.anime.animeTitle} - ${candidate.episode.episodeTitle}`,
      url: candidate.commentUrl
    });
    if (items.length >= 1000) break;
  }

  log("info", `[system] [fongmi] name=${name}, episode=${episode}, candidates=${items.length}`);
  markStepActive('弹幕·候选评分');
  phase('弹幕·候选评分', {
    status: items.length === 0 ? 'empty' : 'ok',
    reason: items.length === 0 ? '候选剧集均无可用的弹幕地址' : undefined,
    inputs: { episode, candidateCount: candidates.length },
    // 该数量是可选弹幕地址数，不是弹幕条数，用候选字段名避免诊断按条数表述
    outputs: { 候选地址数: items.length, topScore: candidates[0]?.score },
  });
  return jsonResponse(items, 200);
}

export { buildFongmiApiBase, extractFongmiEpisodeNumber, extractFongmiSeasonNumber, scoreFongmiEpisodeMatch };
