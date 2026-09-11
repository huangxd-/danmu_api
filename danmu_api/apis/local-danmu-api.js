import crypto from 'node:crypto';
import { jsonResponse } from '../utils/http-util.js';
import { globals } from '../configs/globals.js';
import { parseLocalDanmu, normalizeLocalKey, normalizeLocalSeason, normalizeLocalEpisode, normalizeLocalType, buildLocalDanmuResourceKey, groupLocalDanmuResources } from '../utils/local-danmu-parser.js';
import { saveLocalDanmu, listLocalDanmu, getLocalDanmu, removeLocalDanmu } from '../utils/local-danmu-store.js';

function resourceMetadata({ comments, ...meta }) {
  return { ...meta, season: normalizeLocalSeason(meta.season) };
}

function invalidateLocalDanmuCache(resourceKey) {
  globals.searchCache?.clear();
  globals.commentCache?.delete(`local:${resourceKey}`);
  globals.commentCache?.delete(resourceKey);
}

export async function handleLocalDanmuUpload(req) {
  try {
    const form = await req.formData(); const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return jsonResponse({ success: false, errorMessage: '缺少 file 文件字段' }, 400);
    if (file.size > 10 * 1024 * 1024) return jsonResponse({ success: false, errorMessage: '文件大小不能超过 10 MB' }, 413);
    const title = String(form.get('title') || '').trim();
    if (!title) throw new Error('标题为必填项');
    const yearValue = String(form.get('year') || '').trim();
    if (!yearValue) throw new Error('年份为必填项');
    const year = Number(yearValue);
    const currentYear = new Date().getFullYear();
    if (!/^[0-9]{4}$/.test(yearValue) || year < 1900 || year > currentYear) throw new Error(`年份必须在 1900–${currentYear} 年之间`);
    const type = normalizeLocalType(form.get('type'));
    if (!type) throw new Error('类型为必填项');
    if (type !== 'tv' && type !== 'movie') throw new Error('类型只能选择 tv 或 movie');
    const episodeValue = String(form.get('episode') || '').trim();
    const episode = episodeValue ? normalizeLocalEpisode(episodeValue) : (type === 'tv' ? 1 : null);
    if (episodeValue && (!Number.isSafeInteger(episode) || episode < 1)) throw new Error('集数必须是大于 0 的整数');
    // movie 可以不传季和集；空季沿用已有资源键的第 1 季归一化规则。
    const season = normalizeLocalSeason(form.get('season'));
    if (season === null) throw new Error('季数必须是大于 0 的整数');
    const resourceKey = buildLocalDanmuResourceKey({ title, year, type, season, episode });
    const filename = String(file.name || 'danmu.txt').slice(0, 240);
    const parsed = parseLocalDanmu(Buffer.from(await file.arrayBuffer()), filename);
    // videoId 作为内部资源标识，不要求用户填写；未提供时自动生成 UUID。
    const videoId = String(form.get('videoId') || '').trim() || crypto.randomUUID();
    const matchKeys = [...new Set([title, `${title}|${year}|${type}`, `${title}|${year}|${type}|${season}|${episode ?? 'movie'}`].map(normalizeLocalKey).filter(Boolean))];
    const resource = { resourceKey, videoId, title, year, type, season, episode, filename, size: file.size, format: parsed.format, status: 'ready', count: parsed.comments.length, matchKeys, comments: parsed.comments, updatedAt: new Date().toISOString() };
    await saveLocalDanmu(resource);
    invalidateLocalDanmuCache(resourceKey);
    return jsonResponse({ success: true, resource: resourceMetadata(resource) });
  } catch (e) { return jsonResponse({ success: false, status: 'failed', errorMessage: e.message || '解析失败' }, 400); }
}
export async function handleLocalDanmuList() {
  const resources = (await listLocalDanmu()).map(resourceMetadata);
  return jsonResponse({ success: true, resources, groups: groupLocalDanmuResources(resources) });
}
export async function handleLocalDanmuGet(key) { const r = await getLocalDanmu(key); return r ? jsonResponse({ success: true, resource: resourceMetadata(r) }) : jsonResponse({ success: false, errorMessage: '资源不存在' }, 404); }
export async function handleLocalDanmuDelete(key) {
  await removeLocalDanmu(key);
  invalidateLocalDanmuCache(key);
  return jsonResponse({ success: true });
}
export async function handleLocalDanmuComment(key, format, formatResponse) { const r = await getLocalDanmu(key); if (!r) return null; return formatResponse({ count: r.count, comments: r.comments }, format); }
