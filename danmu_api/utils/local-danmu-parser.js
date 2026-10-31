import { XMLParser } from 'fast-xml-parser';

const MAX_LINES = 200000;
const timeToSeconds = (value) => {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] || 0}`);
};
const cleanText = (v) => String(v ?? '').replace(/<[^>]+>/g, '').trim();
// 标准 B 站 XML 为 8/9 段 p（时间,类型,字号,颜色,...），旧的 3/4 段格式颜色仍在第 3 段。
const pickColorFromP = (p) => {
    const parts = String(p ?? '').split(',');
    return parts.length >= 8 ? parts[3] : parts[2];
};
const normalize = (rows, format, textCleaner = cleanText) => {
  const errors = [];
  const comments = [];
  for (let i = 0; i < rows.length && i < MAX_LINES; i++) {
    const row = rows[i] || {};
    const pTime = typeof row.p === 'string' ? row.p.split(',')[0] : null;
    const pMode = typeof row.p === 'string' ? row.p.split(',')[1] : null;
    const pColor = typeof row.p === 'string' ? pickColorFromP(row.p) : null;
    const time = timeToSeconds(row.time ?? row.start ?? row.progress ?? row.timepoint ?? row.t ?? pTime);
    const text = textCleaner(row.text ?? row.content ?? row.m ?? row.message);
    if (!Number.isFinite(time) || time < 0 || !text) { if (errors.length < 5) errors.push(`${format} 第 ${i + 1} 行时间或文本无效`); continue; }
    const mode = Number(row.mode ?? row.type ?? row.ct ?? pMode ?? 1) || 1;
    const colorValue = Number(row.color ?? pColor ?? 16777215);
    const color = colorValue === 0 && format === 'ASS' ? 0 : colorValue || 16777215;
    comments.push({ p: `${time.toFixed(2)},${mode},${color}`, m: text });
  }
  if (!comments.length) throw new Error(errors[0] || '文件中没有有效弹幕');
  return { comments, errors, format };
};

function parseJson(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.comments || data.danmuku || data.danmu || data.data || [];
  if (!Array.isArray(arr)) throw new Error('JSON 中未找到弹幕数组');
  return normalize(arr.map(x => Array.isArray(x) ? { time: x[0], mode: x[1], color: x[2], text: x[4] ?? x[3] } : x), 'JSON');
}
function parseXml(text) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const data = parser.parse(text);
  const nodes = [];
  const walk = (v) => { if (!v || typeof v !== 'object') return; if (v.p && (v['#text'] !== undefined || typeof v.p === 'string')) nodes.push({ p: v.p, text: v['#text'] ?? v.text ?? '' }); for (const x of Object.values(v)) Array.isArray(x) ? x.forEach(walk) : walk(x); };
  walk(data);
  return normalize(nodes.map(x => { const p = String(x.p).split(','); return { time: p[0], mode: p[1], color: pickColorFromP(x.p), text: x.text }; }), 'XML');
}
// ASS 的颜色为 AABBGGRR/BBGGRR，普通弹幕只保留 RGB。
function assColor(value) {
  const raw = String(value ?? '').trim();
  if (!/^(?:&H[\da-f]{1,8}&?|-?\d+)$/i.test(raw)) return undefined;
  const bgr = /^&H/i.test(raw) ? parseInt(raw.slice(2), 16) : Number(raw);
  return ((bgr & 255) << 16) | (bgr & 0xFF00) | ((bgr >>> 16) & 255);
}

// 按顶层反斜杠切分，避免把 \t(...) 内的动画目标当成立即生效的标签。
function assOverrideTags(block) {
  const tags = [];
  let start = -1;
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    if (block[i] === '(') depth++;
    else if (block[i] === ')') depth = Math.max(0, depth - 1);
    else if (block[i] === '\\' && depth === 0) {
      if (start >= 0) tags.push(block.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start >= 0) tags.push(block.slice(start).trim());
  return tags;
}

// 顺序扫描控制块；转义花括号属于正文，未闭合的花括号不反复扫描后缀。
function* assTextParts(text) {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '{' || text[i + 1] === '}')) { i++; continue; }
    if (text[i] !== '{') continue;
    const end = text.indexOf('}', i + 1);
    if (end === -1) break;
    if (i > start) yield { text: text.slice(start, i) };
    yield { block: text.slice(i + 1, end) };
    start = end + 1;
    i = end;
  }
  if (start < text.length) yield { text: text.slice(start) };
}

// 只记录需要的字段位置，避免异常 Format 的列数与事件数相乘放大内存。
function assFormat(value) {
  const columns = new Map();
  const needed = new Set(['start', 'style', 'text', 'name', 'primarycolour', 'alignment']);
  value.split(',').forEach((name, index) => {
    const key = name.trim().toLowerCase();
    if (needed.has(key)) columns.set(key, index);
  });
  return columns;
}

function parseAss(text) {
  const rows = [];
  const styles = new Map();
  const events = [];
  let section = '';
  let styleFormat = new Map();
  let eventFormat = assFormat('Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text');
  let wrapStyle = 0;
  const fields = (value, format) => {
    const parts = value.split(',');
    return Object.fromEntries([...format].map(([name, i]) => [name, name === 'text' ? parts.slice(i).join(',') : (parts[i] || '').trim()]));
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
    const entry = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!entry) continue;
    const [, key, value] = entry;
    if (section === '[script info]' && key.toLowerCase() === 'wrapstyle') wrapStyle = Number(value);
    if (section === '[v4+ styles]' || section === '[v4 styles]') {
      if (key.toLowerCase() === 'format') styleFormat = assFormat(value);
      if (key.toLowerCase() === 'style' && styleFormat.size) {
        const style = fields(value, styleFormat);
        let alignment = Number(style.alignment);
        // SSA v4 的顶部/中部对齐编号与 ASS 不同。
        if (section === '[v4 styles]') alignment = ({ 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 })[alignment];
        styles.set(style.name, { color: assColor(style.primarycolour) ?? 16777215, alignment });
      }
    }
    if (section === '[events]' || !section) {
      if (key.toLowerCase() === 'format') eventFormat = assFormat(value);
      if (key.toLowerCase() === 'dialogue') events.push(fields(value, eventFormat));
    }
  }
  for (const event of events) {
    const base = styles.get(event.style) || { color: 16777215, alignment: 0 };
    let currentStyle = base;
    let color = base.color;
    let alignment = base.alignment;
    let alignmentSet = false;
    let drawing = false;
    let moving = false;
    let wrap = wrapStyle;
    let visibleColor;
    let content = '';
    for (const part of assTextParts(event.text || '')) {
      if (part.block !== undefined) {
        for (const value of assOverrideTags(part.block)) {
          if (/^move\(/i.test(value)) moving = true;
          else if (/^an[1-9]$/i.test(value) && !alignmentSet) { alignment = Number(value.slice(2)); alignmentSet = true; }
          else if (/^a(?:[1235679]|10|11)$/i.test(value) && !alignmentSet) {
            alignment = ({ 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 })[Number(value.slice(1))];
            alignmentSet = true;
          }
          else if (/^1?c(?:&H[\da-f]{1,8}&?)?$/i.test(value)) color = assColor(value.replace(/^1?c/i, '')) ?? currentStyle.color;
          else if (/^p\d+$/i.test(value)) drawing = Number(value.slice(1)) > 0;
          else if (/^q[0-3]$/i.test(value)) wrap = Number(value.slice(1));
          else if (/^r/i.test(value)) {
            // \r 重置文字样式，不重置整行对齐、换行策略或绘图模式。
            currentStyle = styles.get(value.slice(1).trim()) || base;
            color = currentStyle.color;
          }
        }
      } else if (!drawing) {
        const visible = part.text.replace(/\\([Nnh{}])/g, (_, char) => ({ N: '\n', n: wrap === 2 ? '\n' : ' ', h: '\u00a0', '{': '{', '}': '}' })[char]);
        // 一条普通弹幕只能表达一种颜色，取首段可见正文的颜色。
        if (visible.trim() && visibleColor === undefined) visibleColor = color;
        content += visible;
      }
    }
    // 中部固定和精确坐标无法表达，回退为滚动；移动优先于对齐。
    const mode = moving ? 1 : alignment >= 7 && alignment <= 9 ? 5 : alignment >= 1 && alignment <= 3 ? 4 : 1;
    if (content.trim()) rows.push({ start: event.start, text: content, mode, color: visibleColor ?? color });
  }
  // ASS 正文不是 HTML，尖括号和颜文字必须保留。
  return normalize(rows, 'ASS', value => String(value ?? '').trim());
}
function parseDelimited(text, format) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const parts = s.split(s.includes('\t') ? '\t' : (s.includes('|') ? '|' : ',')); rows.push({ time: parts[0], text: parts.slice(1).join(',') }); }
  return normalize(rows, format);
}

export function parseLocalDanmu(buffer, filename = '') {
  let text;
  // 优先依据 BOM 判断编码；无 BOM 时再检查 UTF-16 的 NUL 字节分布。
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    text = buffer.subarray(2).toString('utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    // Node 没有原生 utf16be，先交换字节转成 LE。
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) { swapped[i - 2] = buffer[i + 1]; swapped[i - 1] = buffer[i]; }
    text = swapped.toString('utf16le');
  } else if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    text = buffer.subarray(3).toString('utf8');
  } else {
    const utf8 = buffer.toString('utf8');
    // 无 BOM 的 UTF-16 LE 通常每个 ASCII 字符后带 NUL；UTF-16 BE 则相反。
    const sample = buffer.subarray(0, Math.min(buffer.length, 512));
    let evenNul = 0; let oddNul = 0;
    for (let i = 0; i < sample.length; i++) { if (sample[i] === 0) (i % 2 === 0 ? evenNul++ : oddNul++); }
    if (oddNul > 3 && oddNul > evenNul * 2) text = buffer.toString('utf16le');
    else if (evenNul > 3 && evenNul > oddNul * 2) {
      const swapped = Buffer.allocUnsafe(buffer.length - (buffer.length % 2));
      for (let i = 0; i + 1 < buffer.length; i += 2) { swapped[i] = buffer[i + 1]; swapped[i + 1] = buffer[i]; }
      text = swapped.toString('utf16le');
    } else {
      // U+FFFD 也可能是原文中的合法字符，不能据此将整个文件改按 UTF-16 解码。
      text = utf8;
    }
  }
  text = text.replace(/^\uFEFF/, '').trim();
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'json') return parseJson(text);
  if (ext === 'xml') return parseXml(text);
  if (ext === 'ass' || ext === 'ssa') return parseAss(text);
  if (ext === 'csv' || ext === 'txt') return parseDelimited(text, ext.toUpperCase());
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return parseXml(text);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJson(text);
  return parseDelimited(text, 'TEXT');
}

export function normalizeLocalKey(value) { return String(value || '').normalize('NFKC').replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 180); }

export function normalizeLocalYear(value) {
  const year = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(year) && year >= 1800 && year <= 3000 ? year : null;
}

export function normalizeLocalType(value) {
  const raw = normalizeLocalKey(value);
  if (!raw) return '';
  if (/^(movie|film|电影|劇場版|剧场版)$/.test(raw)) return 'movie';
  if (/^(tv|电视剧|電視劇|番剧|番劇|anime|动画|動畫|动漫|動漫|series)$/.test(raw)) return 'tv';
  if (/^(ova|oad)$/.test(raw)) return 'ova';
  if (/^(special|sp|特别篇|特別篇)$/.test(raw)) return 'special';
  return raw;
}

export function normalizeLocalEpisode(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim().toUpperCase();
  const match = text.match(/^(?:E|EP|第)?\s*(\d+)\s*(?:集|话|話)?$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function normalizeLocalSeason(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 1;
  const match = String(value).trim().match(/^(?:S(?:EASON)?|第)?\s*(\d+)\s*(?:季)?$/i);
  const season = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(season) && season > 0 ? season : null;
}

export function buildLocalDanmuResourceKey({ title, year, type, season = 1, episode = null }) {
  const cleanTitle = normalizeLocalKey(title);
  const cleanYear = normalizeLocalYear(year);
  const cleanType = normalizeLocalType(type);
  const cleanSeason = normalizeLocalSeason(season);
  const cleanEpisode = normalizeLocalEpisode(episode);
  if (!cleanTitle) throw new Error('标题为必填项');
  if (cleanSeason === null) throw new Error('季数必须是大于 0 的整数');
  const parts = [cleanTitle, cleanYear ?? 'any', cleanType || 'any'];
  // 第 1 季沿用旧键，已有链接及同集重新上传继续生效；其他季增加独立标识。
  if (cleanSeason !== 1) parts.push(`s${cleanSeason}`);
  parts.push(cleanEpisode ?? 'all');
  return parts.join('|');
}

export function groupLocalDanmuResources(resources) {
  const groups = new Map();
  for (const resource of resources) {
    if (!resource?.resourceKey || !normalizeLocalKey(resource.title)) continue;
    const season = normalizeLocalSeason(resource.season);
    if (season === null) continue;
    const year = normalizeLocalYear(resource.year);
    const type = normalizeLocalType(resource.type);
    const groupKey = buildLocalDanmuResourceKey({ ...resource, season, episode: null });
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey, title: String(resource.title).trim(), year, type, season,
        episodeCount: 0, count: 0, size: 0, updatedAt: '', episodes: [],
      });
    }
    const group = groups.get(groupKey);
    const { comments, ...meta } = resource;
    group.episodes.push({ ...meta, year, type, season, episode: normalizeLocalEpisode(resource.episode) });
    group.count += Number(resource.count) || 0;
    group.size += Number(resource.size) || 0;
    if (String(resource.updatedAt || '') > group.updatedAt) group.updatedAt = resource.updatedAt;
  }
  for (const group of groups.values()) {
    group.episodes.sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity));
    group.episodeCount = group.episodes.length;
  }
  return [...groups.values()].sort((a, b) =>
    normalizeLocalKey(a.title).localeCompare(normalizeLocalKey(b.title), 'zh-CN') ||
    (b.year ?? 0) - (a.year ?? 0) || a.type.localeCompare(b.type) || a.season - b.season);
}
