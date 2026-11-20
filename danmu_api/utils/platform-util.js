import { simplized } from './zh-util.js';

export function platformTitleKey(title) {
  return simplized(String(title || '').normalize('NFKC')).trim().replace(/\s+/g, ' ').toLowerCase();
}

const sourceAliases = new Map([
  ['tencent', 'qq'],
  ['iqiyi', 'qiyi'],
  ['bilibili', 'bilibili1']
]);

export function platformKey(source) {
  const key = source.trim().toLowerCase();
  return sourceAliases.get(key) || key;
}

export function normalizePlatformGroup(value, allowedPlatforms) {
  if (typeof value !== 'string' || !value) return '';
  const parts = value.split(/[&＆]/).map(platformKey);
  return parts.every(part => allowedPlatforms.includes(part)) ? [...new Set(parts)].join('&') : '';
}
