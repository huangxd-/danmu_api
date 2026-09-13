import crypto from 'node:crypto';
import { jsonResponse } from '../utils/http-util.js';
import { globals } from '../configs/globals.js';
import { parseLocalDanmu, normalizeLocalKey, normalizeLocalSeason, normalizeLocalEpisode, normalizeLocalType, buildLocalDanmuResourceKey, groupLocalDanmuResources } from '../utils/local-danmu-parser.js';
import { saveLocalDanmu, listLocalDanmu, getLocalDanmu, removeLocalDanmu } from '../utils/local-danmu-store.js';

function resourceMetadata({ comments, ...meta }) {
  return { ...meta, season: normalizeLocalSeason(meta.season) };
}

function buildLocalDanmuMatchKeys(resource) {
  return [...new Set([
    resource.title,
    `${resource.title}|${resource.year}|${resource.type}`,
    `${resource.title}|${resource.year}|${resource.type}|${resource.season}|${resource.episode ?? 'movie'}`
  ].map(normalizeLocalKey).filter(Boolean))];
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
    const matchKeys = buildLocalDanmuMatchKeys({ title, year, type, season, episode });
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
function validateEditFields(fields, current) {
  const title = String(fields.title ?? current.title ?? '').trim();
  if (!title) throw new Error('标题为必填项');
  const yearValue = String(fields.year ?? current.year ?? '').trim();
  const year = Number(yearValue);
  const currentYear = new Date().getFullYear();
  if (!/^[0-9]{4}$/.test(yearValue) || year < 1900 || year > currentYear) throw new Error(`年份必须在 1900–${currentYear} 年之间`);
  const type = normalizeLocalType(fields.type ?? current.type);
  if (type !== 'tv' && type !== 'movie') throw new Error('类型只能选择 tv 或 movie');
  const season = normalizeLocalSeason(fields.season ?? current.season);
  if (season === null) throw new Error('季数必须是大于 0 的整数');
  return { title, year, type, season };
}

export async function handleLocalDanmuUpdate(req, key) {
  try {
    const current = await getLocalDanmu(key);
    if (!current) return jsonResponse({ success: false, errorMessage: '资源不存在' }, 404);
    const body = await req.json();
    const all = await listLocalDanmu();
    const scope = body?.scope === 'group' ? 'group' : 'resource';
    const targets = scope === 'group'
      ? all.filter(resource => resource.title === current.title && Number(resource.year) === Number(current.year) && normalizeLocalType(resource.type) === normalizeLocalType(current.type) && normalizeLocalSeason(resource.season) === normalizeLocalSeason(current.season))
      : [current];
    if (!targets.length) return jsonResponse({ success: false, errorMessage: '资源不存在' }, 404);
    const common = scope === 'group' ? validateEditFields(body, current) : {
      title: current.title,
      year: current.year,
      type: normalizeLocalType(current.type),
      season: normalizeLocalSeason(current.season)
    };
    const updates = targets.map(resource => {
      const episodeValue = scope === 'group' || !Object.prototype.hasOwnProperty.call(body || {}, 'episode') ? resource.episode : body.episode;
      const episode = normalizeLocalEpisode(episodeValue);
      if (episode !== null && (!Number.isSafeInteger(episode) || episode < 1)) throw new Error('集数必须是大于 0 的整数');
      if (scope === 'resource' && common.type === 'tv' && episode === null) throw new Error('电视剧集数不能为空');
      const filename = scope === 'group' ? resource.filename : String(body?.filename ?? resource.filename ?? '').trim().slice(0, 240);
      if (!filename) throw new Error('文件名不能为空');
      const next = { ...resource, ...common, episode, filename };
      next.resourceKey = buildLocalDanmuResourceKey(next);
      next.matchKeys = buildLocalDanmuMatchKeys(next);
      next.updatedAt = new Date().toISOString();
      return next;
    });
    const oldKeys = new Set(targets.map(resource => resource.resourceKey));
    const existingKeys = new Set(all.map(resource => resource.resourceKey));
    if (updates.some(resource => existingKeys.has(resource.resourceKey) && !oldKeys.has(resource.resourceKey))) {
      return jsonResponse({ success: false, errorMessage: '目标资源已存在，无法覆盖' }, 409);
    }
    const savedKeys = [];
    try {
      for (const resource of updates) {
        await saveLocalDanmu(resource);
        savedKeys.push(resource.resourceKey);
      }
      const nextKeys = new Set(updates.map(resource => resource.resourceKey));
      for (const resource of targets) {
        if (!nextKeys.has(resource.resourceKey)) await removeLocalDanmu(resource.resourceKey);
      }
    } catch (error) {
      for (const resource of targets) {
        try { await saveLocalDanmu(resource); } catch {}
      }
      for (const savedKey of savedKeys) {
        if (!oldKeys.has(savedKey)) {
          try { await removeLocalDanmu(savedKey); } catch {}
        }
      }
      throw error;
    }
    for (const resource of updates) invalidateLocalDanmuCache(resource.resourceKey);
    for (const resource of targets) invalidateLocalDanmuCache(resource.resourceKey);
    return jsonResponse({ success: true, scope, resources: updates.map(resourceMetadata), resource: resourceMetadata(updates[0]) });
  } catch (e) {
    return jsonResponse({ success: false, errorMessage: e.message || '更新失败' }, 400);
  }
}
export async function handleLocalDanmuComment(key, format, formatResponse) { const r = await getLocalDanmu(key); if (!r) return null; return formatResponse({ count: r.count, comments: r.comments }, format); }
