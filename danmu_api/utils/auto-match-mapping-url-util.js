import { globals } from '../configs/globals.js';
import { httpGet } from './http-util.js';
import { log } from './log-util.js';
import { mergeAutoMatchMappingRules, parseAutoMatchMappingRules } from './auto-match-mapping-util.js';

const REFRESH_HOUR_BEIJING = 5;
const REFRESH_MINUTE_BEIJING = 30;
const state = {
  configuredUrl: '',
  loadedUrl: '',
  rules: [],
  diskLoadedUrl: '',
  initialAttemptedUrl: '',
  fetching: null,
  refreshTimer: null,
  localRulesRef: null,
  remoteRulesRef: null,
  mergedRules: []
};

function remoteLog(level, message) {
  log(level, `[system] [remote-season-mapping] ${message}`);
}

export function normalizeRemoteSeasonMappingUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.hostname === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 5 && parts[2] === 'blob') {
        return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts[3]}/${parts.slice(4).join('/')}`;
      }
    }
    if (url.hostname === 'gist.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;
    }
    return url.toString();
  } catch {
    return '';
  }
}

function syncConfiguredUrl(url) {
  if (state.configuredUrl === url) return;
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.configuredUrl = url;
  state.loadedUrl = '';
  state.rules = [];
  state.diskLoadedUrl = '';
  state.initialAttemptedUrl = '';
  state.fetching = null;
  state.refreshTimer = null;
  state.localRulesRef = null;
  state.remoteRulesRef = null;
  state.mergedRules = [];
}

async function cachePaths() {
  if (typeof process === 'undefined' || !process.cwd) return null;
  const { default: path } = await import('node:path');
  return {
    dir: path.join(process.cwd(), '.cache'),
    text: path.join(process.cwd(), '.cache', 'auto-match-mapping-remote.txt'),
    meta: path.join(process.cwd(), '.cache', 'auto-match-mapping-remote.json')
  };
}

export function parseRemoteAutoMatchMappingRules(text, allowedPlatforms = globals.allowedPlatforms) {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
    .join(';');
  const { rules, warnings } = parseAutoMatchMappingRules(normalized, allowedPlatforms);
  warnings.forEach(message => remoteLog('warn', message));
  return rules;
}

async function loadDisk(url) {
  if (state.diskLoadedUrl === url) return false;
  state.diskLoadedUrl = url;
  try {
    const paths = await cachePaths();
    if (!paths) return false;
    const { default: fs } = await import('node:fs/promises');
    const meta = JSON.parse(await fs.readFile(paths.meta, 'utf8'));
    if (meta.url !== url) return false;
    const text = await fs.readFile(paths.text, 'utf8');
    const rules = parseRemoteAutoMatchMappingRules(text);
    if (rules.length === 0) return false;
    state.loadedUrl = url;
    state.rules = rules;
    state.localRulesRef = null;
    remoteLog('info', `已加载本机缓存: ${rules.length} 条规则`);
    return true;
  } catch {
    return false;
  }
}

async function saveDisk(url, text) {
  try {
    const paths = await cachePaths();
    if (!paths) return;
    const { default: fs } = await import('node:fs/promises');
    await fs.mkdir(paths.dir, { recursive: true });
    const temp = `${paths.text}.${process.pid || 'current'}.tmp`;
    await fs.writeFile(temp, text, 'utf8');
    await fs.rename(temp, paths.text);
    await fs.writeFile(paths.meta, JSON.stringify({
      url,
      fetchedAt: Date.now(),
      ruleCount: state.rules.length
    }), 'utf8');
  } catch (error) {
    remoteLog('warn', `写入本机缓存失败: ${error?.message || error}`);
  }
}

async function fetchRemote(url) {
  const response = await httpGet(url, { timeout: 5000, retries: 0 });
  if (state.configuredUrl !== url) throw new Error('远程季集映射表配置已变更');
  const text = typeof response?.data === 'string' ? response.data : String(response?.data || '');
  const count = applyRemoteAutoMatchMappingText(url, text);
  await saveDisk(url, text);
  remoteLog('info', `远程规则已更新: ${count} 条`);
  return count;
}

export function applyRemoteAutoMatchMappingText(url, text) {
  const normalizedUrl = normalizeRemoteSeasonMappingUrl(url);
  if (!normalizedUrl) throw new Error('远程季集映射表地址无效');
  const rules = parseRemoteAutoMatchMappingRules(text);
  if (rules.length === 0) throw new Error('远程季集映射表没有有效规则');
  syncConfiguredUrl(normalizedUrl);
  state.loadedUrl = normalizedUrl;
  state.rules = rules;
  state.localRulesRef = null;
  return rules.length;
}

function scheduleRefresh(url) {
  const isNodeRuntime = typeof process !== 'undefined' && process?.release?.name === 'node';
  if (!isNodeRuntime || state.refreshTimer || !url || typeof setTimeout !== 'function') return;
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    REFRESH_HOUR_BEIJING - 8, REFRESH_MINUTE_BEIJING
  ));
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    if (normalizeRemoteSeasonMappingUrl(globals.autoMatchMappingTableUrl) !== url) return;
    try {
      await fetchRemote(url);
    } catch (error) {
      remoteLog('warn', `定时更新失败，继续使用已有缓存: ${error?.message || error}`);
    }
    scheduleRefresh(url);
  }, Math.max(1000, target.getTime() - now.getTime()));
  if (typeof state.refreshTimer?.unref === 'function') state.refreshTimer.unref();
}

export async function ensureRemoteAutoMatchMapping() {
  const url = normalizeRemoteSeasonMappingUrl(globals.autoMatchMappingTableUrl);
  syncConfiguredUrl(url);
  if (!url) return;
  scheduleRefresh(url);
  if (state.loadedUrl === url && state.rules.length > 0) return;
  if (await loadDisk(url)) return;
  if (state.initialAttemptedUrl === url && !state.fetching) return;
  state.initialAttemptedUrl = url;
  if (!state.fetching) {
    const request = fetchRemote(url)
      .catch(error => {
        remoteLog('warn', `初始化失败，继续使用本机规则: ${error?.message || error}`);
        return 0;
      })
      .finally(() => {
        if (state.fetching === request) state.fetching = null;
      });
    state.fetching = request;
  }
  await state.fetching;
}

export async function initializeRemoteAutoMatchMapping() {
  await ensureRemoteAutoMatchMapping();
}

export function getEffectiveAutoMatchMappingRules(localRules = globals.autoMatchMappingTable) {
  const url = normalizeRemoteSeasonMappingUrl(globals.autoMatchMappingTableUrl);
  const remoteRules = url && state.loadedUrl === url ? state.rules : [];
  if (state.localRulesRef !== localRules || state.remoteRulesRef !== remoteRules) {
    state.localRulesRef = localRules;
    state.remoteRulesRef = remoteRules;
    state.mergedRules = mergeAutoMatchMappingRules(localRules, remoteRules);
  }
  return state.mergedRules;
}

export async function refreshRemoteAutoMatchMappingNow() {
  const url = normalizeRemoteSeasonMappingUrl(globals.autoMatchMappingTableUrl);
  syncConfiguredUrl(url);
  if (!url) return { success: false, count: 0, error: '未配置 AUTO_MATCH_MAPPING_TABLE_URL' };
  try {
    const count = await fetchRemote(url);
    scheduleRefresh(url);
    return { success: true, count };
  } catch (error) {
    return { success: false, count: state.rules.length, error: error?.message || String(error) };
  }
}

export function resetRemoteAutoMatchMappingForTests() {
  syncConfiguredUrl('');
}
