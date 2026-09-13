import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { globals } from '../configs/globals.js';
import { getRedisKey, setRedisKey, runPipeline } from './redis-util.js';
import { normalizeLocalKey, normalizeLocalType, normalizeLocalSeason } from './local-danmu-parser.js';

const dir = () => path.resolve(process.cwd(), '.cache', 'local-danmu');
const safe = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const file = (key) => path.join(dir(), `${safe(key)}.json`);
// 故意不用 .json 后缀：旧版本（以及任何按 *.json 扫目录的逻辑）不会把它当成一个弹幕资源。
const indexFile = () => path.join(dir(), 'index.meta');
const useRedis = () => globals.deployPlatform !== 'node';
const unwrap = (value) => {
  const v0 = Array.isArray(value) ? value[0] : value;
  const v = v0 && typeof v0 === 'object' && Object.prototype.hasOwnProperty.call(v0, 'result') ? v0.result : v0;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};
const metadataOnly = (resource) => {
  if (!resource || typeof resource !== 'object') return resource;
  const { comments, ...meta } = resource;
  return meta;
};
const sortByUpdatedAt = (resources) => resources
  .slice()
  .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

// 列表索引只保存元数据：评论数组占单个文件 99% 的体积，逐文件整份解析会让本地资源一多
// 就阻塞事件循环（搜索、匹配、弹幕请求都会走列表），甚至把进程内存打满。
let indexCache = null;
let indexQueue = Promise.resolve();
const withIndexLock = (task) => {
  const run = indexQueue.then(task, task);
  indexQueue = run.catch(() => {});
  return run;
};

async function readIndex() {
  try {
    const target = indexFile();
    const stat = await fs.stat(target);
    if (indexCache && indexCache.path === target && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) return indexCache.data;
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    const data = parsed.filter(item => item && item.resourceKey).map(metadataOnly);
    indexCache = { path: target, mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch {
    return null;
  }
}

async function writeIndex(resources) {
  const sorted = sortByUpdatedAt(resources.map(metadataOnly));
  await fs.mkdir(dir(), { recursive: true });
  const target = indexFile(); const tmp = `${target}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(sorted), 'utf8'); await fs.rename(tmp, target);
  indexCache = null;
  return sorted;
}

async function rebuildIndex() {
  const out = [];
  try {
    const names = await fs.readdir(dir());
    for (const name of names.filter(item => item.endsWith('.json'))) {
      try { out.push(metadataOnly(JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')))); } catch {}
    }
  } catch { return []; }
  return writeIndex(out);
}

// 索引是读-改-写，串行化避免并发上传时互相覆盖掉条目。
async function updateIndex(transform) {
  return withIndexLock(async () => {
    const index = (await readIndex()) || (await rebuildIndex());
    return writeIndex(transform(index));
  });
}

export async function saveLocalDanmu(resource) {
  if (useRedis()) {
    if (!globals.redisValid) throw new Error('云端 Redis 未连接');
    const payload = JSON.stringify(resource);
    const max = Number(globals.localDanmuRedisMaxBytes || 8 * 1024 * 1024);
    if (Buffer.byteLength(payload) > max) throw new Error(`解析结果超过 Redis 单资源限制 (${max} bytes)`);
    await setRedisKey(`localDanmu:data:${resource.resourceKey}`, resource);
    await withIndexLock(async () => {
      const index = unwrap(await getRedisKey('localDanmu:index')) || [];
      const next = Array.isArray(index) ? index.filter(x => x.resourceKey !== resource.resourceKey).map(metadataOnly) : [];
      next.push(metadataOnly(resource));
      await setRedisKey('localDanmu:index', next);
    });
    return resource;
  }
  await fs.mkdir(dir(), { recursive: true });
  const target = file(resource.resourceKey); const tmp = `${target}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(resource), 'utf8'); await fs.rename(tmp, target);
  try {
    await updateIndex(index => [...index.filter(item => item.resourceKey !== resource.resourceKey), metadataOnly(resource)]);
  } catch (error) {
    // 索引写失败就回滚数据文件，避免留下"文件在、列表里看不到"的孤儿资源。
    await fs.unlink(target).catch(() => {});
    throw error;
  }
  return resource;
}
export async function getLocalDanmu(resourceKey) {
  if (useRedis()) return unwrap(await getRedisKey(`localDanmu:data:${resourceKey}`)) || null;
  try { return JSON.parse(await fs.readFile(file(resourceKey), 'utf8')); } catch { return null; }
}
export async function listLocalDanmu() {
  if (useRedis()) {
    const index = unwrap(await getRedisKey('localDanmu:index')) || [];
    return Array.isArray(index) ? sortByUpdatedAt(index.map(metadataOnly)) : [];
  }
  const index = await readIndex();
  return index ? sortByUpdatedAt(index) : await rebuildIndex();
}
export async function removeLocalDanmu(resourceKey) {
  if (useRedis()) {
    await withIndexLock(async () => {
      const index = unwrap(await getRedisKey('localDanmu:index')) || [];
      const next = Array.isArray(index) ? index.filter(x => x.resourceKey !== resourceKey).map(metadataOnly) : [];
      await setRedisKey('localDanmu:index', next);
    });
    await runPipeline([['DEL', `localDanmu:data:${resourceKey}`]]);
    return;
  }
  try { await fs.unlink(file(resourceKey)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await updateIndex(index => index.filter(item => item.resourceKey !== resourceKey));
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
