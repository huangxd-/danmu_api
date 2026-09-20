import { globals } from '../configs/globals.js';
import { httpGet } from './http-util.js';
import { log } from './log-util.js';

const CACHE_TEXT_FILE = 'title-mapping-remote.txt';
const CACHE_META_FILE = 'title-mapping-remote.json';
const FETCH_TIMEOUT_MS = 5000;
const MAX_REMOTE_TEXT_BYTES = 2 * 1024 * 1024;
const INITIAL_RETRY_BACKOFF_MS = 10 * 60 * 1000;
const SCHEDULE_RETRY_COUNT = 5;
const SCHEDULE_RETRY_DELAY_MS = 60 * 1000;
const REFRESH_HOUR_SHANGHAI = 5;
const REFRESH_MINUTE_SHANGHAI = 30;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const remoteState = {
  configuredUrl: '',
  mappings: new Map(),
  diskAttempted: false,
  nextInitialRetryAt: 0,
  schedulerTimer: null,
  fetches: new Map(),
  mergedTable: null,
  mergedKeys: new Set(),
};

function remoteLog(level, message) {
  log(level, `[system] [remote-mapping] ${message}`);
}

function getTitleMappingTable() {
  return globals.envs?.titleMappingTable instanceof Map ? globals.envs.titleMappingTable : null;
}

function removeMergedRemoteMappings() {
  const table = remoteState.mergedTable;
  if (table instanceof Map) {
    for (const key of remoteState.mergedKeys) table.delete(key);
  }
  remoteState.mergedTable = null;
  remoteState.mergedKeys = new Set();
}

function mergeRemoteMappingsIntoTitleTable() {
  const table = getTitleMappingTable();
  if (table === null || remoteState.mergedTable === table) return;

  remoteState.mergedTable = table;
  remoteState.mergedKeys = new Set();
  for (const [key, value] of remoteState.mappings) {
    if (table.has(key)) continue;
    table.set(key, value);
    remoteState.mergedKeys.add(key);
  }
}

function cancelScheduler() {
  if (remoteState.schedulerTimer) clearTimeout(remoteState.schedulerTimer);
  remoteState.schedulerTimer = null;
}

function resetForConfiguredUrl(url) {
  if (remoteState.configuredUrl === url) return;
  cancelScheduler();
  removeMergedRemoteMappings();
  remoteState.configuredUrl = url;
  remoteState.mappings = new Map();
  remoteState.diskAttempted = false;
  remoteState.nextInitialRetryAt = 0;
}

function currentConfiguredUrl() {
  return normalizeMappingSourceUrl(globals.titleMappingTableUrl);
}

function activateRemoteMappings(url, mappings) {
  if (remoteState.configuredUrl && remoteState.configuredUrl !== url) return false;
  removeMergedRemoteMappings();
  remoteState.mappings = mappings;
  remoteState.nextInitialRetryAt = 0;
  mergeRemoteMappingsIntoTitleTable();
  return true;
}

async function remoteCachePaths() {
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') return null;
  const { default: path } = await import('node:path');
  const dir = path.join(process.cwd(), '.cache');
  return {
    dir,
    text: path.join(dir, CACHE_TEXT_FILE),
    meta: path.join(dir, CACHE_META_FILE),
  };
}

async function loadDiskRemoteMapping(url) {
  if (remoteState.diskAttempted) return false;
  remoteState.diskAttempted = true;
  try {
    const paths = await remoteCachePaths();
    if (!paths) return false;
    const { default: fs } = await import('node:fs/promises');
    const meta = JSON.parse(await fs.readFile(paths.meta, 'utf8'));
    if (meta.url !== url) return false;
    const text = await fs.readFile(paths.text, 'utf8');
    const mappings = parseRemoteTitleMappings(text);
    if (!mappings.size || remoteState.configuredUrl !== url) return false;
    activateRemoteMappings(url, mappings);
    remoteLog('info', `已加载本地缓存: ${mappings.size} 条规则`);
    return true;
  } catch {
    return false;
  }
}

async function saveDiskRemoteMapping(url, text) {
  let textTemp = '';
  let metaTemp = '';
  try {
    const paths = await remoteCachePaths();
    if (!paths) return;
    const { default: fs } = await import('node:fs/promises');
    await fs.mkdir(paths.dir, { recursive: true });
    const suffix = `${process.pid || 'current'}.${Date.now()}.tmp`;
    textTemp = `${paths.text}.${suffix}`;
    metaTemp = `${paths.meta}.${suffix}`;
    await fs.writeFile(textTemp, text, 'utf8');
    await fs.writeFile(metaTemp, JSON.stringify({ url }), 'utf8');
    await replaceCacheFile(fs, textTemp, paths.text);
    textTemp = '';
    await replaceCacheFile(fs, metaTemp, paths.meta);
    metaTemp = '';
  } catch (error) {
    remoteLog('warn', `写入磁盘缓存失败（当前内存规则仍有效）: ${error?.message || error}`);
    try {
      const { default: fs } = await import('node:fs/promises');
      if (textTemp) await fs.unlink(textTemp);
      if (metaTemp) await fs.unlink(metaTemp);
    } catch {
      // Best-effort cache cleanup.
    }
  }
}

async function replaceCacheFile(fs, source, target) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(source, target);
  }
}

export function normalizeMappingSourceUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return '';

  const blobMatch = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/(.+)$/i);
  if (blobMatch) url = `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;

  const gistMatch = url.match(/^https?:\/\/gist\.github\.com\/([^/\s]+)\/([0-9a-fA-F]+)\/?$/i);
  if (gistMatch) url = `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TITLE_MAPPING_TABLE_URL 必须是有效的 HTTP/HTTPS 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TITLE_MAPPING_TABLE_URL 仅支持 HTTP/HTTPS 地址');
  }
  return parsed.toString();
}

export function parseRemoteTitleMappings(text) {
  const table = new Map();
  if (typeof text !== 'string' || !text.trim()) return table;

  const cleanField = value => value.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  const normalized = text.replace(/－>|—>|–>/g, '->');
  for (const rawLine of normalized.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    line = line.replace(/\s+(?:#|\/\/).*$/, '').trim();
    for (const rawRule of line.split(';')) {
      const rule = rawRule.trim().replace(/[,，;；]+$/, '').trim();
      const arrowIndex = rule.indexOf('->');
      if (arrowIndex < 0) continue;
      const original = cleanField(rule.slice(0, arrowIndex));
      const mapped = cleanField(rule.slice(arrowIndex + 2));
      if (original && mapped) table.set(original, mapped);
    }
  }
  return table;
}

export function applyRemoteTitleMappingText(url, text) {
  const normalizedUrl = normalizeMappingSourceUrl(url);
  const mappings = parseRemoteTitleMappings(text);
  if (!mappings.size) {
    throw new Error('远程映射表未解析到有效规则（每条需为 原始标题->映射标题 格式）');
  }
  let configuredUrl = '';
  try {
    configuredUrl = currentConfiguredUrl();
  } catch {
    configuredUrl = '';
  }
  resetForConfiguredUrl(configuredUrl || normalizedUrl);
  if (!activateRemoteMappings(normalizedUrl, mappings)) return false;
  remoteLog('info', `远程映射表已更新: ${mappings.size} 条规则`);
  return true;
}

async function fetchRemoteMappingText(url) {
  const response = await httpGet(url, { timeout: FETCH_TIMEOUT_MS, retries: 0 });
  const text = typeof response?.data === 'string'
    ? response.data
    : response?.data == null ? '' : String(response.data);
  if (!text.trim()) throw new Error('远程映射表内容为空');
  const byteLength = typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
    ? Buffer.byteLength(text, 'utf8')
    : text.length;
  if (byteLength > MAX_REMOTE_TEXT_BYTES) throw new Error('远程映射表超过 2 MB 限制');
  return text;
}

async function fetchAndApply(url, reason) {
  if (remoteState.fetches.has(url)) return remoteState.fetches.get(url);

  const task = (async () => {
    remoteLog('info', `${reason}: ${url}`);
    const text = await fetchRemoteMappingText(url);
    const mappings = parseRemoteTitleMappings(text);
    if (!mappings.size) throw new Error('远程映射表未解析到有效规则');
    if (remoteState.configuredUrl !== url) throw new Error('配置地址已变化，忽略旧下载结果');
    activateRemoteMappings(url, mappings);
    if (isLongRunningRuntime()) await saveDiskRemoteMapping(url, text);
    remoteLog('info', `更新成功: ${mappings.size} 条规则`);
    return mappings.size;
  })().finally(() => remoteState.fetches.delete(url));

  remoteState.fetches.set(url, task);
  return task;
}

async function refreshWithRetries(url, reason) {
  for (let attempt = 1; attempt <= SCHEDULE_RETRY_COUNT; attempt++) {
    if (remoteState.configuredUrl !== url) return false;
    try {
      await fetchAndApply(url, `${reason}，尝试 ${attempt}/${SCHEDULE_RETRY_COUNT}`);
      return true;
    } catch (error) {
      remoteLog('warn', `尝试 ${attempt}/${SCHEDULE_RETRY_COUNT} 失败: ${error?.message || error}`);
      if (attempt < SCHEDULE_RETRY_COUNT) {
        await new Promise(resolve => setTimeout(resolve, SCHEDULE_RETRY_DELAY_MS));
      }
    }
  }
  remoteLog('error', `连续 ${SCHEDULE_RETRY_COUNT} 次更新失败，继续使用旧缓存`);
  return false;
}

function isLongRunningRuntime() {
  return globals.deployPlatform === 'node' || globals.deployPlatform === 'huggingface';
}

export function millisecondsUntilNextShanghaiRefresh(now = new Date()) {
  const nowMs = now.getTime();
  const shanghaiNow = new Date(nowMs + SHANGHAI_UTC_OFFSET_MS);
  let targetMs = Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    REFRESH_HOUR_SHANGHAI,
    REFRESH_MINUTE_SHANGHAI,
  ) - SHANGHAI_UTC_OFFSET_MS;
  if (targetMs <= nowMs) targetMs += ONE_DAY_MS;
  return targetMs - nowMs;
}

function scheduleRemoteRefresh(url) {
  if (!isLongRunningRuntime() || !url) return;
  if (remoteState.schedulerTimer) return;
  remoteState.schedulerTimer = setTimeout(async () => {
    remoteState.schedulerTimer = null;
    await refreshWithRetries(url, '北京时间 05:30 定时更新');
    if (remoteState.configuredUrl === url) scheduleRemoteRefresh(url);
  }, millisecondsUntilNextShanghaiRefresh());
  if (typeof remoteState.schedulerTimer?.unref === 'function') remoteState.schedulerTimer.unref();
}

export async function refreshRemoteTitleMappingNow() {
  let url;
  try {
    url = currentConfiguredUrl();
  } catch (error) {
    resetForConfiguredUrl('');
    return { success: false, count: remoteState.mappings.size, errorMessage: error.message, status: 400 };
  }
  if (!url) {
    resetForConfiguredUrl('');
    return { success: false, count: 0, errorMessage: '未配置 TITLE_MAPPING_TABLE_URL', status: 400 };
  }

  resetForConfiguredUrl(url);
  if (remoteState.fetches.has(url)) {
    return { success: false, count: remoteState.mappings.size, errorMessage: '远程映射表更新任务正在进行中', status: 409 };
  }

  try {
    const count = await fetchAndApply(url, '管理员手动更新');
    scheduleRemoteRefresh(url);
    return { success: true, count, status: 200 };
  } catch (error) {
    remoteLog('error', `管理员手动更新失败: ${error?.message || error}`);
    return {
      success: false,
      count: remoteState.mappings.size,
      errorMessage: error?.message || String(error),
      status: 502,
    };
  }
}

export function syncRemoteTitleMappingConfig() {
  void ensureRemoteTitleMapping();
}

export async function ensureRemoteTitleMapping() {
  let url;
  try {
    url = currentConfiguredUrl();
  } catch (error) {
    resetForConfiguredUrl('');
    remoteLog('warn', error.message);
    return;
  }

  resetForConfiguredUrl(url);
  if (!url) return;
  mergeRemoteMappingsIntoTitleTable();

  // Long-running runtimes can reuse a disk snapshot and maintain the daily
  // refresh timer. Serverless runtimes load once into the warm instance's
  // memory, so the first title-matching request waits for the configured table.
  if (isLongRunningRuntime()) {
    await loadDiskRemoteMapping(url);
    scheduleRemoteRefresh(url);
  }

  if (remoteState.mappings.size) return;
  if (Date.now() < remoteState.nextInitialRetryAt) return;

  try {
    await fetchAndApply(url, '首次初始化');
  } catch (error) {
    remoteState.nextInitialRetryAt = Date.now() + INITIAL_RETRY_BACKOFF_MS;
    remoteLog('warn', `首次初始化失败，当前请求继续使用本地映射: ${error?.message || error}`);
  }
}
