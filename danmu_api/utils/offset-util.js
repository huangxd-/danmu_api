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

    // 分离 @来源
    const atIdx = rawPath.lastIndexOf('@');
    let pathPart, sources, all;

    if (atIdx !== -1) {
      pathPart = rawPath.substring(0, atIdx);
      const sourcePart = rawPath.substring(atIdx + 1).trim().toLowerCase();
      if (sourcePart === 'all' || sourcePart === '*') {
        sources = null;
        all = true;
      } else {
        sources = sourcePart.split('&').map(s => s.trim()).filter(Boolean);
        all = false;
        if (sources.length === 0) return null;
      }
    } else {
      pathPart = rawPath;
      sources = null;
      all = false;
    }

    // 解析路径：剧名/季/集
    const segments = pathPart.trim().split('/');
    const anime = segments[0] || null;
    if (!anime) return null;

    const season = segments[1] ? normalizeSegment(segments[1]) : null;
    const episode = segments[2] ? normalizeSegment(segments[2]) : null;

    return { anime, season, episode, sources, all, offset };
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
  if (!Array.isArray(rules) || rules.length === 0 || !anime) return 0;

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
          specificMatch = rule.offset;
        }
      } else if (rule.all) {
        allMatch = rule.offset;
      } else {
        genericMatch = rule.offset;
      }
    }

    // 按优先级返回
    if (specificMatch !== null) return specificMatch;
    if (allMatch !== null) return allMatch;
    if (genericMatch !== null) return genericMatch;
  }

  return 0;
}

/**
 * 应用时间偏移到弹幕数组（兼容多种时间字段格式）
 * @param {Array} danmus 弹幕数组
 * @param {number} offsetSeconds 偏移秒数
 * @returns {Array} 偏移后的弹幕数组
 */
export function applyOffset(danmus, offsetSeconds) {
  const offset = Number(offsetSeconds);
  if (!offset || !Array.isArray(danmus) || danmus.length === 0) return danmus;

  const offsetMs = offset * 1000;
  const clamp = v => Math.max(0, v);

  return danmus.map(danmu => {
    if (!danmu || typeof danmu !== 'object') return danmu;
    const updated = { ...danmu };

    // p 字段（逗号分隔，第一段为秒）
    if (typeof updated.p === 'string') {
      const parts = updated.p.split(',');
      const time = parseFloat(parts[0]);
      if (Number.isFinite(time)) {
        parts[0] = clamp(time + offset).toFixed(3);
        updated.p = parts.join(',');
      }
    }

    // t 字段（秒）
    if (updated.t !== undefined && updated.t !== null) {
      const t = Number(updated.t);
      if (Number.isFinite(t)) updated.t = clamp(t + offset);
    }

    // progress 字段（毫秒）
    if (updated.progress !== undefined && updated.progress !== null) {
      const p = Number(updated.progress);
      if (Number.isFinite(p)) updated.progress = clamp(p + offsetMs);
    }

    // timepoint 字段（秒）
    if (updated.timepoint !== undefined && updated.timepoint !== null) {
      const tp = Number(updated.timepoint);
      if (Number.isFinite(tp)) updated.timepoint = clamp(tp + offset);
    }

    return updated;
  });
}
