import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { globals } from '../configs/globals.js';
import { getRedisKey, setRedisKey, runPipeline } from './redis-util.js';
import { normalizeLocalKey, normalizeLocalType, normalizeLocalSeason } from './local-danmu-parser.js';

const dir = () => path.resolve(process.cwd(), '.cache', 'local-danmu');
const safe = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
export const localDanmuFileName = (key) => `${safe(key)}.json`;
const file = (key) => path.join(dir(), localDanmuFileName(key));
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
    indexCache = {
      path: target,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
      fileNames: new Set(data.map(item => `${safe(item.resourceKey)}.json`)),
    };
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

async function scanResources() {
  const resources = [];
  try {
    const names = await fs.readdir(dir());
    const files = names.filter(name => name.endsWith('.json'));
    for (const name of files) {
      try { resources.push(metadataOnly(JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')))); } catch {}
    }
    return { resources, names: new Set(files) };
  } catch {
    return { resources, names: null };
  }
}

async function rebuildIndex() {
  const { resources } = await scanResources();
  return writeIndex(resources);
}

// 列表是只读路径：索引写不进去（只读挂载、磁盘临时故障）时退化为本次扫描结果，不能整个列表报错。
async function rebuildIndexForRead() {
  const { resources, names } = await scanResources();
  // 目录不存在或无法扫描时，读取不能为了空索引创建目录或覆盖索引。
  if (names === null) return sortByUpdatedAt(resources);
  try {
    const sorted = await writeIndex(resources);
    // 把目录快照绑到新索引上：目录里解析不了的遗留文件不会导致每次列表都全量重建。
    const fresh = await readIndex();
    if (fresh) rememberReconciledNames(fresh, names);
    return sorted;
  } catch {
    return sortByUpdatedAt(resources);
  }
}

// 用一次 readdir 校验索引和数据文件是否对得上，自愈崩溃/外部改动留下的孤儿或幻影条目。
// readdir 失败时无法判断，信任现有索引，避免把还能读到的索引误清空。
async function readResourceFileNames() {
  try {
    const names = await fs.readdir(dir());
    return new Set(names.filter(name => name.endsWith('.json')));
  } catch {
    return null;
  }
}

async function indexMatchesDirectory(index, names) {
  if (names === null) return true;
  const expected = indexCache && indexCache.data === index
    ? indexCache.fileNames
    : new Set(index.map(item => `${safe(item.resourceKey)}.json`));
  return names.size === expected.size && [...names].every(name => expected.has(name));
}

const sameNames = (a, b) => Boolean(a && b && a.size === b.size && [...a].every(name => b.has(name)));
// 校验期间索引可能被并发写入替换，只能把快照挂到同一个缓存对象上，否则会写坏/抛错。
const rememberReconciledNames = (index, names) => {
  if (indexCache && indexCache.data === index) indexCache.reconciledNames = names;
};

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
    const saved = await setRedisKey(`localDanmu:data:${resource.resourceKey}`, resource);
    if (saved?.result !== 'OK') throw new Error('弹幕数据保存失败，请重试');
    await withIndexLock(async () => {
      const index = unwrap(await getRedisKey('localDanmu:index'));
      if (index !== null && !Array.isArray(index)) throw new Error('弹幕索引读取失败，请重试');
      const next = (index || []).filter(x => x.resourceKey !== resource.resourceKey).map(metadataOnly);
      next.push(metadataOnly(resource));
      const indexed = await setRedisKey('localDanmu:index', next);
      if (indexed?.result !== 'OK') throw new Error('弹幕索引保存失败，请重试');
    });
    return resource;
  }
  await fs.mkdir(dir(), { recursive: true });
  const target = file(resource.resourceKey); const tmp = `${target}.tmp-${Date.now()}`;
  // null=确认不存在旧文件；undefined=存在但读不到，回滚时都要区别处理。
  let previous = null;
  try { previous = await fs.readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') previous = undefined; }
  await fs.writeFile(tmp, JSON.stringify(resource), 'utf8'); await fs.rename(tmp, target);
  try {
    await updateIndex(index => [...index.filter(item => item.resourceKey !== resource.resourceKey), metadataOnly(resource)]);
  } catch (error) {
    // 新建失败就删掉刚写入的文件；覆盖失败要恢复旧内容，不能把上一次可用的弹幕一起删掉。
    if (previous === null) {
      await fs.unlink(target).catch(() => {});
    } else if (previous !== undefined) {
      const restore = `${target}.tmp-${Date.now()}-restore`;
      try { await fs.writeFile(restore, previous, 'utf8'); await fs.rename(restore, target); }
      catch { await fs.unlink(restore).catch(() => {}); }
    }
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
  if (index) {
    const names = await readResourceFileNames();
    if (indexCache?.reconciledNames && sameNames(names, indexCache.reconciledNames)) return sortByUpdatedAt(index);
    if (await indexMatchesDirectory(index, names)) {
      rememberReconciledNames(index, names);
      return sortByUpdatedAt(index);
    }
  }
  // 重建必须和上传/删除共用一把锁：否则列表按旧目录快照重建时，可能覆盖掉并发上传刚写好的索引条目。
  return withIndexLock(async () => {
    const fresh = await readIndex();
    if (fresh) {
      const names = await readResourceFileNames();
      if (indexCache?.reconciledNames && sameNames(names, indexCache.reconciledNames)) return sortByUpdatedAt(fresh);
      if (await indexMatchesDirectory(fresh, names)) {
        rememberReconciledNames(fresh, names);
        return sortByUpdatedAt(fresh);
      }
    }
    return rebuildIndexForRead();
  });
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
  // 先更新索引再删数据：索引失败时数据仍然完整；删文件失败下次列表自愈会把仍存在的资源加回来。
  await updateIndex(index => index.filter(item => item.resourceKey !== resourceKey));
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
