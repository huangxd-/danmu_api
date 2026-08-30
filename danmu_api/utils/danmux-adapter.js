import {
  createDanmuX,
  fromBilibili,
  applyGradient,
  toCompatibilityWire,
} from 'danmux';
import { DANMUX_GRADIENT_META } from './danmux-meta.js';

const NATIVE_GRADIENT_FIELDS = ['color_v2', 'colorV2', 'colorfulSrc', 'colorful_src', 'gradient'];

// 上游原生渐变通常引用平台纹理，不能直接等价为本项目生成的 linear 渐变。
// 这里只识别其存在性，后续将弹幕交给 dandan 兼容链路，并禁止叠加人工渐变。
function hasNativeGradient(comment) {
  return NATIVE_GRADIENT_FIELDS.some((field) => comment?.[field] !== undefined);
}

function parseComment(comment, sourceLabel) {
  const fields = String(comment.p ?? '').split(',');
  // 同时接受 DanDanPlay 四字段 JSON 和 Bilibili 八/九字段 XML 的 p 结构。
  // 两种结构的颜色位置不同，必须先确定 profile，避免把字号误当成颜色。
  const xmlProfile = fields.length >= 8;
  const colorIndex = xmlProfile ? 3 : 2;
  const fontSize = xmlProfile ? Number(fields[2]) : 25;
  const result = fromBilibili({
    id: comment.cid ?? `${sourceLabel}:${fields[0] ?? '0'}:${comment.m ?? ''}`,
    time: Number(fields[0]),
    mode: Number(fields[1]),
    fontSize,
    color: fields[colorIndex],
    content: String(comment.m ?? ''),
  });
  if (!result.value) return result;
  const normalized = createDanmuX({
    ...result.value,
    source: { platform: sourceLabel, id: String(comment.cid ?? result.value.id) },
  });
  return {
    ...normalized,
    diagnostics: [...(result.diagnostics ?? []), ...(normalized.diagnostics ?? [])],
  };
}

export function parseDanmuxGradientStops(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function convertCommentsToDanmux(danmuData, {
  sourceLabel = 'danmu_api',
  gradientStops,
  gradientAngle = 0,
  applyGradientToAll = true,
} = {}) {
  const comments = Array.isArray(danmuData?.comments) ? danmuData.comments : [];
  const diagnostics = [];
  const converted = [];
  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index];
    const nativeGradient = hasNativeGradient(comment);
    // 原生纹理不由当前播放器协议加载；标记为 dandan 后仍保留 p/m 单色降级能力。
    const commentSourceLabel = nativeGradient ? 'dandan' : sourceLabel;
    const parsed = parseComment(comment, String(commentSourceLabel).slice(0, 64) || 'danmu_api');
    diagnostics.push(...(parsed.diagnostics ?? []).map((entry) => ({ ...entry, index })));
    if (!parsed.value) continue;
    let item = parsed.value;
    // DANMUX_GRADIENT_META 是服务端筛选阶段写入的非枚举标记，只在当前转换链路内传递。
    // 这保证播放器只渲染已命中的普通白色弹幕，而不是给所有弹幕统一套渐变。
    const selectedGradient = comment[DANMUX_GRADIENT_META];
    const stops = nativeGradient
      ? undefined
      : selectedGradient
        ? (gradientStops ?? selectedGradient.stops)
        : (applyGradientToAll ? gradientStops : undefined);
    if (stops !== undefined) {
      const generated = applyGradient(item, { angle: selectedGradient?.angle ?? gradientAngle, stops });
      diagnostics.push(...(generated.diagnostics ?? []).map((entry) => ({ ...entry, index })));
      item = generated.value ?? item;
    }
    // 兼容线同时输出 p/m 和可选 danmux.effects：旧播放器读取单色，新播放器读取增强层。
    const wire = toCompatibilityWire(item);
    converted.push({
      ...wire,
      ...(comment.cid !== undefined ? { cid: comment.cid } : {}),
      ...(comment.like !== undefined ? { like: comment.like } : {}),
    });
  }
  return {
    format: 'danmux',
    schemaVersion: 1,
    count: converted.length,
    comments: converted,
    diagnostics,
  };
}
