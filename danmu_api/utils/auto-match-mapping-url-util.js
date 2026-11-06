import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { mergeAutoMatchMappingRules, parseAutoMatchMappingRules } from './auto-match-mapping-util.js';
import { createRemoteTableLoader, normalizeRemoteTableUrl } from './remote-table-util.js';

const remoteState = {
  activeUrl: '',
  rules: [],
  localRulesRef: null,
  remoteRulesRef: null,
  mergedRules: [],
};

function resetRemoteRules() {
  remoteState.activeUrl = '';
  remoteState.rules = [];
  remoteState.localRulesRef = null;
  remoteState.remoteRulesRef = null;
  remoteState.mergedRules = [];
}

export function normalizeRemoteSeasonMappingUrl(value) {
  try {
    return normalizeRemoteTableUrl(value, 'AUTO_MATCH_MAPPING_TABLE_URL');
  } catch {
    return '';
  }
}

export function parseRemoteAutoMatchMappingRules(text, allowedPlatforms = globals.allowedPlatforms) {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .replace(/－>|—>|–>/g, '->')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
    .map(line => line.replace(/\s+(?:#|\/\/).*$/, '').trim())
    .join(';');
  const { rules, warnings } = parseAutoMatchMappingRules(normalized, allowedPlatforms);
  warnings.forEach(message => log('warn', `[system] [remote-season-mapping] ${message}`));
  return rules;
}

const seasonMappingLoader = createRemoteTableLoader({
  name: 'remote-season-mapping',
  cacheFileName: 'auto-match-mapping-remote.json',
  urlLabel: 'AUTO_MATCH_MAPPING_TABLE_URL',
  getRawUrl: () => globals.autoMatchMappingTableUrl,
  parseText: text => {
    const rules = parseRemoteAutoMatchMappingRules(text);
    return { value: rules, count: rules.length };
  },
  activate: (url, rules) => {
    remoteState.activeUrl = url;
    remoteState.rules = rules;
    remoteState.localRulesRef = null;
    remoteState.remoteRulesRef = null;
  },
  reset: resetRemoteRules,
  initialLoadMode: 'background',
  refreshStaleCache: true,
});

export async function ensureRemoteAutoMatchMapping(options = {}) {
  await seasonMappingLoader.ensure({
    waitForInitial: false,
    ...options,
  });
}

export async function initializeRemoteAutoMatchMapping() {
  await ensureRemoteAutoMatchMapping();
}

export function syncRemoteAutoMatchMappingConfig() {
  void ensureRemoteAutoMatchMapping();
}

export function getEffectiveAutoMatchMappingRules(localRules = globals.autoMatchMappingTable) {
  const url = normalizeRemoteSeasonMappingUrl(globals.autoMatchMappingTableUrl);
  const remoteRules = url && remoteState.activeUrl === url ? remoteState.rules : [];
  if (remoteState.localRulesRef !== localRules || remoteState.remoteRulesRef !== remoteRules) {
    remoteState.localRulesRef = localRules;
    remoteState.remoteRulesRef = remoteRules;
    remoteState.mergedRules = mergeAutoMatchMappingRules(localRules, remoteRules);
  }
  return remoteState.mergedRules;
}

export async function refreshRemoteAutoMatchMappingNow() {
  return seasonMappingLoader.refreshNow();
}

export function resetRemoteAutoMatchMappingForTests() {
  seasonMappingLoader.resetForTests();
  resetRemoteRules();
}
