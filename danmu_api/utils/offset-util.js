// 弹幕时间偏移独立模块
// 职责：解析偏移规则、匹配偏移量、应用偏移到弹幕

// 来源→平台别名映射（source 名和 platform 名不一致时扩展匹配）
const SOURCE_ALIASES = {
  tencent: 'qq',
  iqiyi: 'qiyi',
  bilibili: 'bilibili1'
};

// 规范化季/集编号（S1→S01, E3→E03）
function normalizeSegment(segment) {
  const seasonMatch = segment.match(/^S(\d+)$/i);
  if (seasonMatch) return `S${String(parseInt(seasonMatch[1])).padStart(2, '0')}`;
  const episodeMatch = segment.match(/^E(\d+)$/i);
  if (episodeMatch) return `E${String(parseInt(episodeMatch[1])).padStart(2, '0')}`;
  return segment;
}

/**
 * 解析 DANMU_OFFSET 环境变量为结构化规则数组（启动时调用一次，缓存到 globals）
 * @param {string} env 环境变量值
 * @returns {Array} 规则数组
 */
export function parseOffsetRules(env) {
  if (!env || typeof env !== 'string') return [];

  return env.split(',').map(entry => {
    const trimmed = entry.trim();
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx === -1) return null;

    const rawPath = trimmed.substring(0, colonIdx);
    const offsetStr = trimmed.substring(colonIdx + 1);
    if (!rawPath || offsetStr === '') return null;

    const offset = parseFloat(offsetStr);
    if (!Number.isFinite(offset)) return null;

    // 百分比模式：在路径/来源段末尾追加 %，例如：东方/S03/E02@tencent%:11
    let usePercent = false;
    let normalizedPath = rawPath.trim();
    if (normalizedPath.endsWith('%')) {
      usePercent = true;
      normalizedPath = normalizedPath.slice(0, -1).trim();
    }

    // 分离 @来源
    const atIdx = normalizedPath.lastIndexOf('@');
    let pathPart, sources, all;

    if (atIdx !== -1) {
      pathPart = normalizedPath.substring(0, atIdx);
      const sourcePart = normalizedPath.substring(atIdx + 1).trim().toLowerCase();
      if (sourcePart === 'all' || sourcePart === '*') {
        sources = null;
        all = true;
      } else {
        sources = sourcePart.split('&').map(s => s.trim()).filter(Boolean);
        all = false;
        if (sources.length === 0) return null;
      }
    } else {
      pathPart = normalizedPath;
      sources = null;
      all = false;
    }

    // 解析路径：剧名/季/集
    const segments = pathPart.trim().split('/');
    const anime = segments[0] || null;
    if (!anime) return null;

    const season = segments[1] ? normalizeSegment(segments[1]) : null;
    const episode = segments[2] ? normalizeSegment(segments[2]) : null;

    return { anime, season, episode, sources, all, offset, usePercent };
  }).filter(Boolean);
}

/**
 * 根据规则查找匹配的偏移量
 * @param {Array} rules parseOffsetRules 返回的规则数组
 * @param {Object} ctx 匹配上下文
 * @param {string} ctx.anime 剧名
 * @param {string} ctx.season 季（如 S01）
 * @param {string} ctx.episode 集（如 E03）
 * @param {string} ctx.source 来源（如 'bilibili' 或合并来源 'dandan&bilibili1'）
 * @returns {number} 偏移秒数，无匹配返回 0
 */
export function resolveOffset(rules, { anime, season, episode, source }) {
  const matchedRule = resolveOffsetRule(rules, { anime, season, episode, source });
  return matchedRule ? matchedRule.offset : 0;
}

/**
 * 根据规则查找匹配的偏移规则
 * @param {Array} rules parseOffsetRules 返回的规则数组
 * @param {Object} ctx 匹配上下文
 * @returns {Object|null} 匹配到的规则对象，无匹配返回 null
 */
export function resolveOffsetRule(rules, { anime, season, episode, source }) {
  if (!Array.isArray(rules) || rules.length === 0 || !anime) return null;

  // 拆分合并来源，并展开别名
  const sourceKeys = new Set();
  if (source) {
    for (const s of source.split('&')) {
      const trimmed = s.trim().toLowerCase();
      if (trimmed) {
        sourceKeys.add(trimmed);
        if (SOURCE_ALIASES[trimmed]) sourceKeys.add(SOURCE_ALIASES[trimmed]);
      }
    }
  }

  // 路径级别：集级 > 季级 > 剧级
  const levels = [
    { matchSeason: true, matchEpisode: true },   // 集级
    { matchSeason: true, matchEpisode: false },   // 季级
    { matchSeason: false, matchEpisode: false }    // 剧级
  ];

  for (const level of levels) {
    // 同一路径级别内，按优先级：来源特定 > all 通配 > 无限定
    let specificMatch = null;
    let allMatch = null;
    let genericMatch = null;

    for (const rule of rules) {
      // 匹配剧名
      if (rule.anime !== anime) continue;

      // 匹配路径级别
      if (level.matchEpisode) {
        if (!rule.season || !rule.episode) continue;
        if (rule.season !== season || rule.episode !== episode) continue;
      } else if (level.matchSeason) {
        if (!rule.season || rule.episode) continue;
        if (rule.season !== season) continue;
      } else {
        if (rule.season || rule.episode) continue;
      }

      // 匹配来源
      if (rule.sources) {
        // 来源特定规则
        if (sourceKeys.size > 0 && rule.sources.some(s => sourceKeys.has(s))) {
          specificMatch = rule;
        }
      } else if (rule.all) {
        allMatch = rule;
      } else {
        genericMatch = rule;
      }
    }

    // 按优先级返回
    if (specificMatch !== null) return specificMatch;
    if (allMatch !== null) return allMatch;
    if (genericMatch !== null) return genericMatch;
  }

  return null;
}

/**
 * 应用时间偏移到弹幕数组（兼容多种时间字段格式）
 * @param {Array} danmus 弹幕数组
 * @param {number} offsetSeconds 偏移秒数
 * @param {Object} options 额外选项
 * @param {boolean} options.usePercent 是否启用百分比模式
 * @param {number} options.videoDuration 视频时长（秒）
 * @returns {Array} 偏移后的弹幕数组
 */
export function applyOffset(danmus, offsetSeconds, options = {}) {
  const offset = Number(offsetSeconds);
  if (!offset || !Array.isArray(danmus) || danmus.length === 0) return danmus;

  const usePercent = options?.usePercent === true;
  const videoDuration = Number(options?.videoDuration || 0);
  const getDanmuTimeSeconds = (danmu) => {
    if (!danmu || typeof danmu !== 'object') return null;

    if (typeof danmu.p === 'string') {
      const parts = danmu.p.split(',');
      const time = parseFloat(parts[0]);
      if (Number.isFinite(time)) return time;
    }

    if (danmu.t !== undefined && danmu.t !== null) {
      const time = Number(danmu.t);
      if (Number.isFinite(time)) return time;
    }

    if (danmu.progress !== undefined && danmu.progress !== null) {
      const time = Number(danmu.progress);
      if (Number.isFinite(time)) return time / 1000;
    }

    if (danmu.timepoint !== undefined && danmu.timepoint !== null) {
      const time = Number(danmu.timepoint);
      if (Number.isFinite(time)) return time;
    }

    return null;
  };
  const fallbackDuration = videoDuration > 0
    ? videoDuration
    : getDanmuTimeSeconds(danmus[danmus.length - 1]) || 0;
  const scaleRatio = usePercent && Number.isFinite(fallbackDuration) && fallbackDuration > 0
    ? (fallbackDuration + offset) / fallbackDuration
    : null;

  if (usePercent && scaleRatio === null) return danmus;

  const offsetMs = offset * 1000;
  const clamp = v => Math.max(0, v);
  const roundTo = (value, digits = 2) => Number(value.toFixed(digits));
  const transformSeconds = (time) => {
    const value = scaleRatio !== null ? clamp(time * scaleRatio) : clamp(time + offset);
    return scaleRatio !== null ? roundTo(value, 2) : value;
  };
  const transformMilliseconds = (time) => {
    const value = scaleRatio !== null ? clamp(time * scaleRatio) : clamp(time + offsetMs);
    return scaleRatio !== null ? Math.round(value) : value;
  };

  return danmus.map(danmu => {
    if (!danmu || typeof danmu !== 'object') return danmu;
    const updated = { ...danmu };

    // p 字段（逗号分隔，第一段为秒）
    if (typeof updated.p === 'string') {
      const parts = updated.p.split(',');
      const time = parseFloat(parts[0]);
      if (Number.isFinite(time)) {
        parts[0] = transformSeconds(time).toFixed(2);
        updated.p = parts.join(',');
      }
    }

    // t 字段（秒）
    if (updated.t !== undefined && updated.t !== null) {
      const t = Number(updated.t);
      if (Number.isFinite(t)) updated.t = transformSeconds(t);
    }

    // progress 字段（毫秒）
    if (updated.progress !== undefined && updated.progress !== null) {
      const p = Number(updated.progress);
      if (Number.isFinite(p)) updated.progress = transformMilliseconds(p);
    }

    // timepoint 字段（秒）
    if (updated.timepoint !== undefined && updated.timepoint !== null) {
      const tp = Number(updated.timepoint);
      if (Number.isFinite(tp)) updated.timepoint = transformSeconds(tp);
    }

    return updated;
  });
}
