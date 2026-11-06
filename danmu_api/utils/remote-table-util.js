import { globals } from '../configs/globals.js';
import { httpGet } from './http-util.js';
import { log } from './log-util.js';

const FETCH_TIMEOUT_MS = 5000;
const MAX_REMOTE_TEXT_BYTES = 2 * 1024 * 1024;
const INITIAL_RETRY_BACKOFF_MS = 10 * 60 * 1000;
const SCHEDULE_RETRY_COUNT = 5;
const SCHEDULE_RETRY_DELAY_MS = 60 * 1000;
const REFRESH_HOUR_SHANGHAI = 5;
const REFRESH_MINUTE_SHANGHAI = 30;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeRemoteTableUrl(rawUrl, label = '远程映射表') {
  let url = String(rawUrl || '').trim();
  if (!url) return '';

  const blobMatch = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/(.+)$/i);
  if (blobMatch) url = `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;

  const gistMatch = url.match(/^https?:\/\/gist\.github\.com\/([^/\s]+)\/([^/\s?#]+)\/?$/i);
  if (gistMatch) url = `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} 必须是有效的 HTTP/HTTPS 地址`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} 仅支持 HTTP/HTTPS 地址`);
  }
  return parsed.toString();
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

function isLongRunningRuntime() {
  return globals.deployPlatform === 'node' || globals.deployPlatform === 'huggingface';
}

function remoteTextByteLength(text) {
  return typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
    ? Buffer.byteLength(text, 'utf8')
    : text.length;
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

/**
 * 创建一个远程映射表控制器，统一处理下载、磁盘缓存、定时刷新和并发去重。
 *
 * initialLoadMode:
 * - blocking: 首次无缓存时等待下载完成（适合原有剧名映射行为）
 * - background: 首次无缓存时后台下载，当前请求先使用本机规则
 */
export function createRemoteTableLoader({
  name,
  cacheFileName,
  urlLabel,
  getRawUrl,
  parseText,
  activate,
  reset,
  initialLoadMode = 'blocking',
  loadDiskOnServerless = false,
  refreshStaleCache = false,
  saveDiskOnServerless = false,
}) {
  const state = {
    configuredUrl: '',
    diskAttempted: false,
    activeCount: 0,
    nextInitialRetryAt: 0,
    schedulerTimer: null,
    fetches: new Map(),
  };

  function remoteLog(level, message) {
    log(level, `[system] [${name}] ${message}`);
  }

  function cancelScheduler() {
    if (state.schedulerTimer) clearTimeout(state.schedulerTimer);
    state.schedulerTimer = null;
  }

  function resetForConfiguredUrl(url) {
    if (state.configuredUrl === url) return false;
    cancelScheduler();
    state.configuredUrl = url;
    state.diskAttempted = false;
    state.activeCount = 0;
    state.nextInitialRetryAt = 0;
    reset();
    return true;
  }

  function currentUrl() {
    return normalizeRemoteTableUrl(getRawUrl(), urlLabel);
  }

  async function cachePaths() {
    if (typeof process === 'undefined' || typeof process.cwd !== 'function') return null;
    const { default: path } = await import('node:path');
    const dir = path.join(process.cwd(), '.cache');
    return {
      dir,
      file: path.join(dir, cacheFileName),
    };
  }

  async function saveDisk(url, text) {
    if (!isLongRunningRuntime() && !saveDiskOnServerless) return;
    let tempFile = '';
    try {
      const paths = await cachePaths();
      if (!paths) return;
      const { default: fs } = await import('node:fs/promises');
      await fs.mkdir(paths.dir, { recursive: true });
      const suffix = `${process.pid || 'current'}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      tempFile = `${paths.file}.${suffix}`;
      await fs.writeFile(tempFile, JSON.stringify({ url, text, fetchedAt: Date.now() }), 'utf8');
      await replaceCacheFile(fs, tempFile, paths.file);
      tempFile = '';
    } catch (error) {
      remoteLog('warn', `写入磁盘缓存失败（当前内存规则仍有效）: ${error?.message || error}`);
      try {
        const { default: fs } = await import('node:fs/promises');
        if (tempFile) await fs.unlink(tempFile);
      } catch {
        // Best-effort cache cleanup.
      }
    }
  }

  async function loadDisk(url) {
    if (state.diskAttempted) return false;
    state.diskAttempted = true;
    if (!isLongRunningRuntime() && !loadDiskOnServerless) return false;
    try {
      const paths = await cachePaths();
      if (!paths) return false;
      const { default: fs } = await import('node:fs/promises');
      const cache = JSON.parse(await fs.readFile(paths.file, 'utf8'));
      if (cache.url !== url || typeof cache.text !== 'string') return false;
      const parsed = parseText(cache.text);
      if (!parsed?.count || state.configuredUrl !== url) return false;
      activate(url, parsed.value);
      state.activeCount = parsed.count;
      remoteLog('info', `已加载本地缓存: ${parsed.count} 条规则`);

      if (refreshStaleCache && Number.isFinite(cache.fetchedAt)
        && Date.now() - cache.fetchedAt > ONE_DAY_MS) {
        startFetch(url, '缓存已超过 24 小时').catch(error => {
          remoteLog('warn', `缓存刷新失败，继续使用磁盘缓存: ${error?.message || error}`);
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function fetchRemoteText(url) {
    const response = await httpGet(url, { timeout: FETCH_TIMEOUT_MS, retries: 0 });
    const text = typeof response?.data === 'string'
      ? response.data
      : response?.data == null ? '' : String(response.data);
    if (!text.trim()) throw new Error('远程映射表内容为空');
    if (remoteTextByteLength(text) > MAX_REMOTE_TEXT_BYTES) throw new Error('远程映射表超过 2 MB 限制');
    return text;
  }

  function startFetch(url, reason) {
    const existing = state.fetches.get(url);
    if (existing) return existing;

    const task = (async () => {
      remoteLog('info', `${reason}: ${url}`);
      const text = await fetchRemoteText(url);
      const parsed = parseText(text);
      if (!parsed?.count) throw new Error('远程映射表未解析到有效规则');
      if (state.configuredUrl !== url) throw new Error('配置地址已变化，忽略旧下载结果');
      activate(url, parsed.value);
      state.activeCount = parsed.count;
      await saveDisk(url, text);
      remoteLog('info', `更新成功: ${parsed.count} 条规则`);
      return parsed.count;
    })().finally(() => {
      if (state.fetches.get(url) === task) state.fetches.delete(url);
    });

    state.fetches.set(url, task);
    return task;
  }

  async function refreshWithRetries(url, reason) {
    for (let attempt = 1; attempt <= SCHEDULE_RETRY_COUNT; attempt++) {
      if (state.configuredUrl !== url) return false;
      try {
        await startFetch(url, `${reason}，尝试 ${attempt}/${SCHEDULE_RETRY_COUNT}`);
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

  function scheduleRefresh(url) {
    if (!isLongRunningRuntime() || !url || state.schedulerTimer) return;
    state.schedulerTimer = setTimeout(async () => {
      state.schedulerTimer = null;
      await refreshWithRetries(url, '北京时间 05:30 定时更新');
      if (state.configuredUrl === url) scheduleRefresh(url);
    }, millisecondsUntilNextShanghaiRefresh());
    if (typeof state.schedulerTimer?.unref === 'function') state.schedulerTimer.unref();
  }

  async function refreshNow() {
    let url;
    try {
      url = currentUrl();
    } catch (error) {
      resetForConfiguredUrl('');
      return { success: false, count: state.activeCount, errorMessage: error.message, status: 400 };
    }
    if (!url) {
      resetForConfiguredUrl('');
      return { success: false, count: 0, errorMessage: `未配置 ${urlLabel}`, status: 400 };
    }

    resetForConfiguredUrl(url);
    if (state.fetches.has(url)) {
      return { success: false, count: state.activeCount, errorMessage: '远程映射表更新任务正在进行中', status: 409 };
    }

    try {
      const count = await startFetch(url, '管理员手动更新');
      scheduleRefresh(url);
      return { success: true, count, status: 200 };
    } catch (error) {
      remoteLog('error', `管理员手动更新失败: ${error?.message || error}`);
      return {
        success: false,
        count: state.activeCount,
        errorMessage: error?.message || String(error),
        status: 502,
      };
    }
  }

  async function ensure({ waitForInitial = initialLoadMode === 'blocking' } = {}) {
    let url;
    try {
      url = currentUrl();
    } catch (error) {
      resetForConfiguredUrl('');
      remoteLog('warn', error.message);
      return;
    }

    resetForConfiguredUrl(url);
    if (!url) {
      reset();
      return;
    }

    if (isLongRunningRuntime()) {
      await loadDisk(url);
      scheduleRefresh(url);
    } else if (loadDiskOnServerless) {
      await loadDisk(url);
    }

    if (state.activeCount > 0) return;
    if (Date.now() < state.nextInitialRetryAt) return;

    let task = state.fetches.get(url);
    if (!task) {
      task = startFetch(url, '首次初始化').catch(error => {
        state.nextInitialRetryAt = Date.now() + INITIAL_RETRY_BACKOFF_MS;
        remoteLog('warn', `首次初始化失败，当前请求继续使用本机规则: ${error?.message || error}`);
        return 0;
      });
    }

    if (waitForInitial) await task;
    else void task.catch(() => {});
  }

  function resetForTests() {
    resetForConfiguredUrl('');
    state.activeCount = 0;
    reset();
  }

  return {
    ensure,
    refreshNow,
    resetForTests,
  };
}
