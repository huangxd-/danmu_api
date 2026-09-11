import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { globals } from '../configs/globals.js';
import { getRedisKey, setRedisKey, runPipeline } from './redis-util.js';
import { normalizeLocalKey, normalizeLocalType, normalizeLocalSeason } from './local-danmu-parser.js';

const dir = () => path.resolve(process.cwd(), '.cache', 'local-danmu');
const safe = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const file = (key) => path.join(dir(), `${safe(key)}.json`);
const useRedis = () => globals.deployPlatform !== 'node';
const unwrap = (value) => {
  const v0 = Array.isArray(value) ? value[0] : value;
  const v = v0 && typeof v0 === 'object' && Object.prototype.hasOwnProperty.call(v0, 'result') ? v0.result : v0;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export async function saveLocalDanmu(resource) {
  if (useRedis()) {
    if (!globals.redisValid) throw new Error('云端 Redis 未连接');
    const payload = JSON.stringify(resource);
    const max = Number(globals.localDanmuRedisMaxBytes || 8 * 1024 * 1024);
    if (Buffer.byteLength(payload) > max) throw new Error(`解析结果超过 Redis 单资源限制 (${max} bytes)`);
    const index = unwrap(await getRedisKey('localDanmu:index')) || [];
    const next = Array.isArray(index) ? index.filter(x => x.resourceKey !== resource.resourceKey) : [];
    next.push(resource);
    await setRedisKey(`localDanmu:data:${resource.resourceKey}`, resource);
    await setRedisKey('localDanmu:index', next);
    return resource;
  }
  await fs.mkdir(dir(), { recursive: true });
  const target = file(resource.resourceKey); const tmp = `${target}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(resource), 'utf8'); await fs.rename(tmp, target);
  return resource;
}
export async function getLocalDanmu(resourceKey) {
  if (useRedis()) return unwrap(await getRedisKey(`localDanmu:data:${resourceKey}`)) || null;
  try { return JSON.parse(await fs.readFile(file(resourceKey), 'utf8')); } catch { return null; }
}
export async function listLocalDanmu() {
  if (useRedis()) return unwrap(await getRedisKey('localDanmu:index')) || [];
  try { const names = await fs.readdir(dir()); const out = []; for (const n of names.filter(x => x.endsWith('.json'))) { try { out.push(JSON.parse(await fs.readFile(path.join(dir(), n), 'utf8'))); } catch {} } return out.sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); } catch { return []; }
}
export async function removeLocalDanmu(resourceKey) {
  if (useRedis()) { const index = await listLocalDanmu(); await setRedisKey('localDanmu:index', index.filter(x => x.resourceKey !== resourceKey)); await runPipeline([['DEL', `localDanmu:data:${resourceKey}`]]); return; }
  try { await fs.unlink(file(resourceKey)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export async function findLocalDanmu(criteria = {}) {
  const all = await listLocalDanmu();
  const title = normalizeLocalKey(criteria.title);
  const year = criteria.year == null ? null : Number(criteria.year);
  const type = normalizeLocalType(criteria.type);
  const season = normalizeLocalSeason(criteria.season);
  const episode = criteria.episode == null ? null : Number(criteria.episode);
  const videoId = String(criteria.videoId || '').trim();
  return all.map(resource => {
    if (videoId && resource.videoId && String(resource.videoId) === videoId) return { resource, score: 100 };
    if (!title || normalizeLocalKey(resource.title) !== title) return null;
    if (season === null || normalizeLocalSeason(resource.season) !== season) return null;
    // 兼容未填写年份/类型的旧资源：只有资源和请求两边都有值且不一致时才排除。
    if (resource.year != null && year !== null && Number(resource.year) !== year) return null;
    if (resource.type && type && normalizeLocalType(resource.type) !== type) return null;
    const storedEpisode = resource.episode == null ? null : Number(resource.episode);
    // 有具体集数时优先具体集；无集数的标题级资源作为回退。
    if (storedEpisode !== null && episode !== null && episode !== storedEpisode) return null;
    if (storedEpisode !== null && episode === null) return null;
    return { resource, score: 10 + (resource.year != null && year !== null ? 3 : 0) + (resource.type && type ? 2 : 0) + (storedEpisode !== null ? 5 : 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score)[0]?.resource || null;
}
