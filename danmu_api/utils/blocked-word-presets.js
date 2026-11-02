import { DOMESTIC_REGION_NAMES } from '../data/domestic-regions.js';
import { BLOCKED_REGION_PRESET_NAMES } from '../data/blocked-region-presets.js';
import { simplized, traditionalized } from './zh-util.js';

export const LEGACY_BLOCKED_WORD_KEYS = ['BLOCK_DOMESTIC_REGIONS', 'BLOCK_DATES'];
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function regionBlockedWord(names) {
  const variants = new Set();
  for (const raw of names) {
    const name = String(raw || '').normalize('NFKC').trim();
    if (name) for (const variant of [name, simplized(name), traditionalized(name)]) variants.add(variant);
  }
  return `/(?:${[...variants].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegex).join('|')})/u`;
}

// 日期使用分月天数及闰年分支，避免仅按数字外形屏蔽无效日期。
const year = '(?:19|20)\\d{2}';
const leapYear = '(?:19(?:0[48]|[2468][048]|[13579][26])|20(?:00|0[48]|[2468][048]|[13579][26]))';
const shortLeapYear = '(?:0[048]|[2468][048]|[13579][26])';
const validMonthDay = separator => `(?:(?:0?[13578]|1[02])${separator}(?:0?[1-9]|[12]\\d|3[01])|(?:0?[469]|11)${separator}(?:0?[1-9]|[12]\\d|30)|0?2${separator}(?:0?[1-9]|1\\d|2[0-8]))`;
const chineseSeparator = '\\s*月\\s*';
const yearSeparator = '(?:\\s*年\\s*|\\s*[.．\\/／－-]\\s*|\\s+)';
const dateEnd = '(?!\\d|[.．]\\d)';
const dateStart = '(?<![A-Za-zＡ-Ｚａ-ｚ0-9.．])';
const numericDates = ['[.．]', '[\\/／]', '[-－]'].map(delimiter => {
  const separator = `\\s*${delimiter}\\s*`;
  return `(?:${year}${separator}${validMonthDay(separator)}|${leapYear}${separator}0?2${separator}29)`;
}).join('|');
const chineseDates = `(?:${year}${yearSeparator}${validMonthDay(chineseSeparator)}|${leapYear}${yearSeparator}0?2${chineseSeparator}29|\\d{2}\\s*年\\s*${validMonthDay(chineseSeparator)}|${shortLeapYear}\\s*年\\s*0?2${chineseSeparator}29)\\s*[日号]?`;
const yearlessMonthDay = `(?<![\\d.．年\\/／－-])(?<!\\d\\s*年\\s*)(?<!\\d{4}\\s*)(?<!\\d{4}\\s*[.．\\/／－-]\\s*)(?:${validMonthDay(chineseSeparator)}|0?2${chineseSeparator}29)\\s*[日号]`;
const abbreviatedDates = ['[.．]', '[\\/／]', '[-－]'].map(delimiter => `(?:${validMonthDay(delimiter)}|0?2${delimiter}29)`).join('|');
const abbreviated = `(?<![A-Za-zＡ-Ｚａ-ｚ0-9.．年\\/／－-])(?:${abbreviatedDates})${dateEnd}(?=\\s*(?:国庆|元旦|春节|中秋|七夕|情人节|二刷|一刷|三刷|打卡|报到|报道|签到|来看|看的|看完))`;

// 预设本身兼容全角数字；自定义正则仍直接匹配原文，保持既有语义。
function wideDigits(pattern) {
  const widen = token => token + token.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  return pattern.replace(/\{\d+(?:,\d*)?\}|\\d|\[(?:[^\]\\]|\\.)*\]|[0-9]/g, token => {
    if (token.startsWith('{')) return token;
    if (token === '\\d') return '[0-9０-９]';
    if (token.startsWith('[')) return token.replace(/\\d|[0-9](?:-[0-9])?/g, part => part === '\\d' ? '0-9０-９' : widen(part));
    return `[${widen(token)}]`;
  });
}

export const BLOCKED_WORD_PRESETS = Object.freeze({
  content: Object.freeze([
    String.raw`/^\s*\p{N}+(?:\s+\p{N}+)*\s*$/u`,
    String.raw`/^[\s\p{P}\p{S}\uFE0E\uFE0F\u200D]+$/u`
  ]),
  regions: Object.freeze([regionBlockedWord([...DOMESTIC_REGION_NAMES, ...BLOCKED_REGION_PRESET_NAMES])]),
  dates: Object.freeze([
    `/${wideDigits(`${dateStart}(?:${numericDates}|${chineseDates})${dateEnd}|${yearlessMonthDay}|${abbreviated}`)}/u`,
    `/${wideDigits('(?<!\\d)(?<![\\d:：][:：])(?:[01]?\\d|2[0-3])[:：][0-5]\\d(?:[:：][0-5]\\d)?(?!\\d|[:：]\\d)')}/u`,
    `/${wideDigits('(?<![\\d.])(?:[01]?\\d|2[0-3])\\s*[点時时]\\s*(?:[0-5]?\\d\\s*分?(?:\\s*[0-5]?\\d\\s*秒)?(?!\\d)|半|整)')}/u`
  ])
});

const enabled = value => value === true || value === 'true' || value === 1 || value === '1';
export function migrateLegacyBlockedWords(env) {
  if (!LEGACY_BLOCKED_WORD_KEYS.some(key => Object.hasOwn(env, key))) return env;
  const migrated = { ...env };
  let words = String(env.BLOCKED_WORDS || '').trim();
  const presets = [
    ...(enabled(env.BLOCK_DOMESTIC_REGIONS) ? BLOCKED_WORD_PRESETS.regions : []),
    ...(enabled(env.BLOCK_DATES) ? BLOCKED_WORD_PRESETS.dates : [])
  ];
  for (const rule of presets) {
    if (!words.includes(rule)) words = words ? `${words},${rule}` : rule;
  }
  migrated.BLOCKED_WORDS = words;
  for (const key of LEGACY_BLOCKED_WORD_KEYS) delete migrated[key];
  return migrated;
}

/** Node 配置文件迁移：保留其他变量和注释；调用方负责写回文件。 */
export function migrateLegacyBlockedWordsText(text, env) {
  if (!LEGACY_BLOCKED_WORD_KEYS.some(key => Object.hasOwn(env, key))) return text;
  const migrated = migrateLegacyBlockedWords(env);
  const lines = text.split(/\r?\n/).filter(line => !/^\s*(?:BLOCK_DOMESTIC_REGIONS|BLOCK_DATES)\s*=/.test(line));
  let written = false;
  const result = lines.map(line => {
    if (!/^\s*BLOCKED_WORDS\s*=/.test(line)) return line;
    if (written) return null;
    written = true;
    return `BLOCKED_WORDS="${migrated.BLOCKED_WORDS}"`;
  }).filter(line => line !== null);
  if (!written) result.push(`BLOCKED_WORDS="${migrated.BLOCKED_WORDS}"`);
  return result.join(text.includes('\r\n') ? '\r\n' : '\n');
}
