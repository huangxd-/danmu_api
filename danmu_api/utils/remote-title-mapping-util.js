import { Globals, globals } from '../configs/globals.js';
import {
  createRemoteTableLoader,
  millisecondsUntilNextShanghaiRefresh,
  normalizeRemoteTableUrl,
} from './remote-table-util.js';

export { millisecondsUntilNextShanghaiRefresh };

export function normalizeMappingSourceUrl(rawUrl) {
  return normalizeRemoteTableUrl(rawUrl, 'TITLE_MAPPING_TABLE_URL');
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

const titleMappingLoader = createRemoteTableLoader({
  name: 'remote-mapping',
  cacheFileName: 'title-mapping-remote.json',
  urlLabel: 'TITLE_MAPPING_TABLE_URL',
  getRawUrl: () => globals.titleMappingTableUrl,
  parseText: text => {
    const mappings = parseRemoteTitleMappings(text);
    return { value: mappings, count: mappings.size };
  },
  activate: (_url, mappings) => {
    Globals.remoteTitleMappingTable = mappings;
  },
  reset: () => {
    Globals.remoteTitleMappingTable = new Map();
  },
  initialLoadMode: 'blocking',
});

export async function refreshRemoteTitleMappingNow() {
  return titleMappingLoader.refreshNow();
}

export function syncRemoteTitleMappingConfig() {
  void titleMappingLoader.ensure({ waitForInitial: false });
}

export async function ensureRemoteTitleMapping(options = {}) {
  await titleMappingLoader.ensure(options);
}
