import { globals } from '../configs/globals.js';

// Keep lookup independent from the Node-only disk cache code so Forward can
// safely import it while the server owns remote table loading.
let remoteMappings = new Map();

function getLocalMappings() {
  return globals.envs?.titleMappingTable instanceof Map ? globals.envs.titleMappingTable : null;
}

export function setRemoteTitleMappings(mappings) {
  remoteMappings = mappings instanceof Map ? mappings : new Map();
}

export function resetRemoteTitleMappingIndex() {
  remoteMappings = new Map();
}

export function resolveTitleMapping(title) {
  const key = String(title ?? '');
  const localMappings = getLocalMappings();
  // Local rules always win, while remote rules fill the remaining keys.
  if (localMappings?.has(key)) return localMappings.get(key);
  return remoteMappings.get(key) ?? null;
}
