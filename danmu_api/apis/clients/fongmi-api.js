import { globals } from "../../configs/globals.js";
import { jsonResponse } from "../../utils/http-util.js";
import { log } from "../../utils/log-util.js";
import { simplized } from "../../utils/zh-util.js";
import { convertChineseNumber, extractEpisodeTitle, extractEpisodeNumberFromTitle, normalizeSpaces } from "../../utils/common-util.js";
import { filterSameEpisodeTitle, getBangumiDataForMatch, searchAnime } from "../dandan-api.js";

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
  return normalizeSpaces(text.toLowerCase());
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
  FONGMI_EPISODE_CLEAN_RULES.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  return normalizeSpaces(text);
}

/**
 * 从 FongMi 集数文本中提取更稳健的集数。
 * 除了复用公共提取逻辑外，再补充网盘命名常见格式。
 * @param {string} episode 原始集数文本
 * @returns {number|null} 集数，未提取到则返回 null
 */
function extractFongmiEpisodeNumber(episode) {
  const normalizedEpisode = normalizeFongmiEpisodeByRegex(episode);
  const commonNum = extractEpisodeNumberFromTitle(normalizedEpisode);
  if (commonNum !== null) return commonNum;

  const seasonEpisodeMatch = normalizedEpisode.match(/S\d{1,2}\s*E(\d{1,4})/i);
  if (seasonEpisodeMatch) {
    return parseInt(seasonEpisodeMatch[1], 10);
  }

  const chineseEpisodeMatch = normalizedEpisode.match(/第\s*([一二三四五六七八九十百零〇两\d]+)\s*(?:集|话|期|回|章)/);
  if (chineseEpisodeMatch) {
    return convertChineseNumber(chineseEpisodeMatch[1]);
  }

  const xEpisodeMatch = normalizedEpisode.match(/(?:^|\s)(\d{1,4})x(?:\s|$)/i);
  if (xEpisodeMatch) {
    return parseInt(xEpisodeMatch[1], 10);
  }

  const standaloneEpisodeMatch = normalizedEpisode.match(/(?:^|\s)(\d{1,4})(?:\s|$)/);
  if (standaloneEpisodeMatch) {
    return parseInt(standaloneEpisodeMatch[1], 10);
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
    const keyword = normalizeSpaces(String(value || "").trim());
    if (!keyword || keywords.includes(keyword)) return;
    keywords.push(keyword);
  };

  pushKeyword(rawName);

  const cleanedName = normalizeSpaces(normalizeFongmiTitleByRegex(rawName)).trim();
  if (cleanedName && cleanedName !== rawName) {
    pushKeyword(cleanedName);
  }

  const plainBracketName = normalizeSpaces(rawName.replace(/[\(\[（【].*$/, "")).trim();
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
  const path = reqUrl.pathname.replace(/\/+$/, "");
  const apiMarker = "/api/v2/";
  const danmakuMarker = "/danmaku";

  let prefix = "";
  const apiMarkerIndex = path.indexOf(apiMarker);
  if (apiMarkerIndex >= 0) {
    prefix = path.slice(0, apiMarkerIndex);
  } else {
    const danmakuIndex = path.indexOf(danmakuMarker);
    if (danmakuIndex >= 0) {
      prefix = path.slice(0, danmakuIndex);
    } else {
      prefix = path;
    }
  }

  return `${reqUrl.origin}${prefix}`;
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
    log("warn", `[Fongmi] 解析请求参数失败: ${e.message}`);
  }

  return { name: "", episode: "" };
}

/**
 * 计算单个候选分集与目标分集的匹配得分。
 * 当前综合标题、集数、日期做排序，后续可以继续扩展更多维度。
 * @param {Object} anime 候选剧集对象
 * @param {Object} episode 候选分集对象
 * @param {string} targetEpisode FongMi 传入的分集文本
 * @param {number} index 分集索引
 * @returns {number} 匹配得分
 */
function scoreFongmiEpisodeMatch(anime, episode, targetEpisode, index) {
  let score = Math.max(0, 200 - index);

  const normalizedTargetEpisode = normalizeFongmiEpisodeByRegex(targetEpisode);
  const targetText = normalizeFongmiText(normalizedTargetEpisode);
  if (!targetText) return score;

  const episodeTitle = episode?.episodeTitle || "";
  const episodeText = normalizeFongmiText(episodeTitle);
  const titleWithoutPlatform = normalizeFongmiText(extractEpisodeTitle(episodeTitle));
  const animeText = normalizeFongmiText(anime?.animeTitle || "");

  if (episodeText === targetText || titleWithoutPlatform === targetText) score += 10000;
  if (episodeText.includes(targetText) || targetText.includes(episodeText)) score += 4500;
  if (titleWithoutPlatform && (titleWithoutPlatform.includes(targetText) || targetText.includes(titleWithoutPlatform))) score += 2500;

  const targetNum = extractFongmiEpisodeNumber(normalizedTargetEpisode);
  const episodeNum = extractFongmiEpisodeNumber(episodeTitle);
  const episodeIndexNum = parseInt(episode?.episodeNumber || `${index + 1}`, 10);
  if (targetNum !== null && episodeNum !== null && targetNum === episodeNum) score += 7000;
  if (targetNum !== null && Number.isFinite(episodeIndexNum) && targetNum === episodeIndexNum) score += 4000;

  const targetDate = extractDateDigits(normalizedTargetEpisode);
  const episodeDate = extractDateDigits(episodeTitle);
  if (targetDate && episodeDate && targetDate === episodeDate) score += 9000;

  if (targetDate && targetText.includes(targetDate)) score += 800;
  if (animeText.includes("综艺") && targetDate && episodeDate) score += 1200;

  if (animeText.includes("综艺") && targetDate && !episodeDate && targetNum === null) score -= 1500;

  return score;
}

/**
 * 将搜索结果展开成 FongMi 可排序的候选分集列表。
 * @param {Array} animes 搜索到的剧集列表
 * @param {Map} detailStore 详情缓存
 * @param {string} apiBase 基础地址
 * @returns {Array} 候选分集数组
 */
function buildFongmiDanmakuItems(animes, detailStore, apiBase) {
  const candidates = [];

  for (const anime of animes) {
    const bangumiData = getBangumiDataForMatch(anime, detailStore);
    if (!bangumiData?.success || !bangumiData?.bangumi?.episodes?.length) continue;

    let episodes = bangumiData.bangumi.episodes;
    if (globals.enableAnimeEpisodeFilter) {
      episodes = episodes.filter(item => !globals.episodeTitleFilter.test(item.episodeTitle));
    }
    episodes = filterSameEpisodeTitle(episodes);

    episodes.forEach((episode, index) => {
      const commentUrl = `${apiBase}/api/v2/comment/${encodeURIComponent(episode.episodeId)}?format=xml`;
      candidates.push({
        anime,
        episode,
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
  const { name, episode } = await parseFongmiRequestParams(url, req);

  if (!name) {
    return jsonResponse([], 200);
  }

  const searchUrl = new URL(url.toString());
  const detailStore = new Map();
  const keywords = buildFongmiSearchKeywords(name);
  let animes = [];

  for (const keyword of keywords) {
    searchUrl.searchParams.set("keyword", keyword);
    const searchRes = await searchAnime(searchUrl, null, null, detailStore);
    const searchData = await searchRes.json();
    animes = Array.isArray(searchData?.animes) ? searchData.animes : [];
    if (animes.length) {
      if (keyword !== name) {
        log("info", `[Fongmi] Search fallback hit: raw=${name}, keyword=${keyword}, episode=${episode}`);
      }
      break;
    }
  }

  if (!animes.length) {
    log("info", `[Fongmi] No danmaku candidates for name=${name}, episode=${episode}`);
    return jsonResponse([], 200);
  }

  const apiBase = buildFongmiApiBase(req);
  const candidates = buildFongmiDanmakuItems(animes, detailStore, apiBase)
    .map(item => ({
      ...item,
      score: scoreFongmiEpisodeMatch(item.anime, item.episode, episode, item.index)
    }))
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const items = [];
  for (const candidate of candidates) {
    if (!candidate?.commentUrl || seen.has(candidate.commentUrl)) continue;
    seen.add(candidate.commentUrl);
    items.push({
      name: `${candidate.anime.animeTitle} - ${candidate.episode.episodeTitle}`,
      url: candidate.commentUrl
    });
    if (items.length >= 12) break;
  }

  log("info", `[Fongmi] name=${name}, episode=${episode}, candidates=${items.length}`);
  return jsonResponse(items, 200);
}
