import { splitBlockedWords } from "./blocked-word-parser.js";
export { splitBlockedWords };
import { canonicalPlatformGroup, canonicalPlatformName } from './platform-util.js';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { binResponse, jsonResponse, xmlResponse } from "./http-util.js";
import { simplized, traditionalized } from './zh-util.js';
import { convertDanAny } from './dan-any.js';
import { appendDanmuxGradients, convertCommentsToDanmux } from './danmux-adapter.js';
import { DANMUX_GRADIENT_META } from './danmux-meta.js';
import { getCommentTransformConfig } from './comment-context.js';

const NATIVE_GRADIENT_FIELDS = ['color_v2', 'colorV2', 'colorfulSrc', 'colorful_src', 'gradient'];

function getNativeGradientValue(item) {
  if (!item || typeof item !== 'object') return { present: false, value: undefined };
  for (const field of NATIVE_GRADIENT_FIELDS) {
    if (item[field] !== undefined) return { present: true, value: item[field] };
  }
  return { present: false, value: undefined };
}

// =====================
// danmu处理相关函数
// =====================

/**
 * 对弹幕进行分组、去重和计数处理
 * @param {Array} filteredDanmus 已过滤屏蔽词的弹幕列表
 * @param {number} n 分组时间间隔（分钟），0表示不分组（除非多源合并强制去重）
 * @param {boolean} isMultiSource 是否为多源弹幕
 * @returns {Array} 处理后的弹幕列表
 */
export function groupDanmusByMinute(filteredDanmus, n, isMultiSource = false) {
  // 特殊逻辑：如果未开启分组(n=0)且为单源，按时间排序后返回原始数据
  // 若为多源，即使n=0也强制执行精确时间点去重，以消除源之间的重复数据
  if (n === 0 && !isMultiSource) {
    return filteredDanmus
      .map(danmu => ({
        ...danmu,
        t: danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0])
      }))
      .sort((a, b) => a.t - b.t);
  }

  // 按 n 分钟分组
  const groupedByTime = filteredDanmus.reduce((acc, danmu) => {
    // 获取时间：优先使用 t 字段，如果没有则使用 p 的第一个值
    const time = danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0]);

    // 确定分组键：n=0时使用精确时间(保留2位小数)，否则使用分钟索引
    const groupKey = n === 0 ? time.toFixed(2) : Math.floor(time / (n * 60));

    // 初始化分组
    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }

    // 添加到对应分组
    acc[groupKey].push({ ...danmu, t: time });
    return acc;
  }, Object.create(null));

  // 处理每组的弹幕
  const result = Object.keys(groupedByTime).map(key => {
    const danmus = groupedByTime[key];

    // 按消息内容分组
    const groupedByMessage = danmus.reduce((acc, danmu) => {
      const message = danmu.m.split(' X')[0].trim(); // 提取原始消息（去除 Xn 后缀）
      if (!acc[message]) {
        acc[message] = {
          count: 0,
          earliestT: danmu.t,
          cid: danmu.cid,
          p: danmu.p,
          like: 0,  // 初始化like字段
          // 保留源弹幕的渐变色扩展字段。合并后使用组内第一条可用的 color_v2。
          color_v2: danmu.color_v2,
          sources: new Set() // 收集当前具体弹幕内容的真实独立来源
        };
      }
      acc[message].count += 1;
      // 更新最早时间
      acc[message].earliestT = Math.min(acc[message].earliestT, danmu.t);
      // 如果组内第一条没有渐变信息，但后续弹幕有，则保留后续第一条可用的 color_v2。
      if (acc[message].color_v2 === undefined && danmu.color_v2 !== undefined) {
        acc[message].color_v2 = danmu.color_v2;
      }
      // 合并like字段，如果是undefined则视为0
      acc[message].like += (danmu.like !== undefined ? danmu.like : 0);

      // 提取当前弹幕的来源并加入集合中，建立弹幕内容与平台的精确映射
      if (danmu.p) {
        const match = danmu.p.match(/\[([^\]]*)\]$/);
        if (match && match[1]) {
          match[1].split(/[&＆]/).forEach(s => {
            if (s.trim()) acc[message].sources.add(s.trim());
          });
        }
      }
      return acc;
    }, Object.create(null));

    // 转换为结果格式
    return Object.keys(groupedByMessage).map(message => {
      const data = groupedByMessage[message];

      // 以当前这句弹幕实际跨越的独立平台数作为除数，进行局部精准降噪，保留单平台内真实的重复计数
      let localSourceCount = Math.max(1, data.sources.size);
      let displayCount = Math.round(data.count / localSourceCount);

      if (displayCount < 1) displayCount = 1;

      // 将收集到的所有真实独立来源重新拼装回 p 属性标签中
      const combinedSources = Array.from(data.sources).join('＆');
      const newP = data.p.replace(/\[([^\]]*)\]$/, `[${combinedSources}]`);

      return {
        cid: data.cid,
        p: newP,
        // 仅当计算后的逻辑计数大于1时才显示 "x N"
        m: displayCount > 1 ? `${message}\u200Ax\u200A${displayCount}` : message,
        t: data.earliestT,
        like: data.like, // 包含合并后的like字段
        ...(data.color_v2 !== undefined ? { color_v2: data.color_v2 } : {})
      };
    });
  });

  // 展平结果并按时间排序
  return result.flat().sort((a, b) => a.t - b.t);
}

/**
 * 处理弹幕的点赞数显示
 * @param {Array} groupedDanmus 弹幕列表
 * @returns {Array} 处理后的弹幕列表
 */
export function handleDanmusLike(groupedDanmus, enabled = globals.likeSwitch) {
  if (!enabled) {
    return groupedDanmus;
  }
  const lowThresholdSources = new Set([
    '[hanjutv]',
    '[sohu]',
    '[bilibili]',
    '[bilibili1]',
    '[migu]',
  ]);
  return groupedDanmus.map(item => {
    // 如果item没有like字段或者like值小于5，则不处理
    if (!item.like || item.like < 5) {
      return item;
    }

    // 韩剧TV 双链路标签可能继续扩展，按来源标签内容判断更稳。
    const sourceTag = item.p.match(/,(\[[^\]]+\])$/)?.[1] || '';
    const isHanjutvVariantTag = sourceTag.includes('韩小圈') || sourceTag.includes('极速版');
    const isLowThresholdSource = isHanjutvVariantTag || lowThresholdSources.has(sourceTag);

    // 确定阈值：特定源中>=100用🔥，其他>=1000用🔥
    const threshold = isLowThresholdSource ? 100 : 1000;
    const icon = item.like >= threshold ? '🔥' : '️♡';

    // 格式化点赞数，缩写显示
    let formattedLike;
    if (item.like >= 10000) {
      // 万级别，如 1.2w
      formattedLike = (item.like / 10000).toFixed(1) + 'w';
    } else if (item.like >= 1000) {
      // 千级别，如 1.2k
      formattedLike = (item.like / 1000).toFixed(1) + 'k';
    } else {
      // 百级别及以下，直接显示数字
      formattedLike = item.like.toString();
    }

    // 在弹幕内容m字段后面添加点赞信息
    const likeText = `\u200A${icon}${formattedLike}`;
    const newM = item.m + likeText;

    // 创建新对象，复制原属性，更新m字段，并删除like字段
    const { like, ...rest } = item;
    return {
      ...rest,
      m: newM
    };
  });
}

export function limitDanmusByCount(filteredDanmus, danmuLimit) {
  // 如果 danmuLimit 为 0，直接返回原始数据
  if (danmuLimit === 0) {
    return filteredDanmus;
  }

  // 计算目标弹幕数量
  const targetCount = danmuLimit * 1000;
  const totalCount = filteredDanmus.length;

  // 如果当前弹幕数不超过目标数量，直接返回
  if (totalCount <= targetCount) {
    return filteredDanmus;
  }

  // 计算采样间隔
  const interval = totalCount / targetCount;

  // 按间隔抽取弹幕
  const result = [];
  for (let i = 0; i < targetCount; i++) {
    // 计算当前应该取的索引位置
    const index = Math.floor(i * interval);
    result.push(filteredDanmus[index]);
  }

  return result;
}

/**
 * 转义正则特殊字符，用于将纯文本屏蔽词转为字面量匹配
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将单个屏蔽词条转换为正则对象：
 * - /pattern/ 或 /pattern/flags 按正则解析（忽略 g/y 标志，避免 lastIndex 状态影响 test 结果）
 * - 纯文本词条按字面量匹配
 * - 非法正则降级为字面量匹配并输出警告日志
 */
export function parseBlockedWord(segment) {
  const match = segment.match(/^\/([\s\S]+)\/([a-z]*)$/);
  if (match) {
    try {
      return new RegExp(match[1], match[2].replace(/[gy]/g, ''));
    } catch (e) {
      log("warn", `[system] [danmu] 无效的屏蔽词正则(已按字面量处理): ${segment}`, e?.message || e);
      return new RegExp(escapeRegExp(segment));
    }
  }
  return new RegExp(escapeRegExp(segment));
}

/**
 * 两个 0xRRGGBB 颜色按比例线性插值
 */
function lerpColor(a, b, frac) {
  const channel = (shift) => Math.round(((a >> shift) & 255) + ((((b >> shift) & 255) - ((a >> shift) & 255)) * frac));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

// 固定使用代码中 bili 的粉蓝渐变，不接受皮肤、色带或角度覆盖。
export const BILI_GRADIENT_COLORS = '16478873,3389695'; // #FB7299→#33B8FF

/**
 * 构建渐变色带采样器：按 0~1 的位置在色带上取渐变色，相邻弹幕位置相近时颜色平滑过渡
 * @param {string} rawStops 逗号分隔的十进制颜色值（至少 2 个）
 * @returns {Function|null} 采样函数；色带无效时返回 null
 */
export function buildGradientSampler(rawStops) {
  const stops = String(rawStops || '').split(',').map(c => parseInt(c.trim(), 10)).filter(c => !isNaN(c) && c >= 0 && c <= 16777215);
  if (stops.length === 0) return null;
  if (stops.length === 1) return () => stops[0];
  const span = stops.length - 1;
  return (pos) => {
    const t = Math.min(Math.max(pos, 0), 1) * span;
    const i = Math.min(Math.floor(t), span - 1);
    return lerpColor(stops[i], stops[i + 1], t - i);
  };
}

function gradientStopsForDanmux(rawStops) {
  const colors = String(rawStops || '').split(',')
    .map(c => parseInt(c.trim(), 10))
    .filter(c => !isNaN(c) && c >= 0 && c <= 16777215);
  if (colors.length < 2) return undefined;
  return colors.map((color, index) => ({
    position: index / (colors.length - 1),
    color: `#${color.toString(16).padStart(6, '0').toUpperCase()}`,
  }));
}

const SHORT_PERSON_CONTEXT_PREFIX = /(?:喜欢|讨厌|支持|心疼|粉上|夸夸|安利|看好|想看|期待|欢迎|呼叫)/u;
const SHORT_PERSON_CONTEXT_SUFFIX = /(?:老师|演员|主演|导演|演技|出演|饰演|扮演|演得|演的|出场|登场|上线|下线|本人|粉丝|好美|好帅|老婆|老公|姐姐|哥哥|妹妹|弟弟)/u;

/**
 * 将已确认的中文演员/角色名整理为匹配项。
 * 三字及以上名称按完整名称匹配；二字名称必须带明确人物语境，避免“白鹿”误伤“白鹿原”。
 */
export function buildBlockedNameMatchers(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const matchers = [];
  for (const rawName of names) {
    const label = String(rawName || '').normalize('NFKC').trim();
    const compact = label.replace(/[\s·・•‧·･]+/g, '');
    if (!/\p{Script=Han}/u.test(compact) || Array.from(compact).length < 2) continue;
    const key = simplized(compact).toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const length = Array.from(compact).length;
    const escaped = escapeRegExp(key);
    const regex = length === 2
      ? new RegExp(
        `(?:(?:^|[^\\p{Script=Han}])${escaped}(?=$|[^\\p{Script=Han}])|${SHORT_PERSON_CONTEXT_PREFIX.source}${escaped}(?=$|[^\\p{Script=Han}])|${escaped}${SHORT_PERSON_CONTEXT_SUFFIX.source})`,
        'u'
      )
      : null;
    matchers.push({ label, needle: key, regex });
  }
  return matchers;
}

const COMMON_COMPOUND_SURNAMES = new Set([
  '欧阳', '司马', '上官', '诸葛', '东方', '独孤', '南宫', '慕容', '尉迟', '皇甫',
  '令狐', '长孙', '宇文', '闻人', '夏侯', '公孙', '轩辕', '百里', '钟离', '澹台'
]);
const SURNAME_REFERENCE_SUFFIX = /(?:老师|导演|主演|演员|饰演|扮演|出演|姐姐|哥哥|妹妹|弟弟|大哥|二哥|三哥|大姐|二姐|叔叔|阿姨|公子|姑娘|小姐|先生|娘娘|皇后|皇帝|王爷|殿下|公主|太子|少爷|夫人|老婆|老公|宝宝|本人|同学|好美|好帅|家族|一哥|一姐)/u;

/** 从姓名中提取带明确称谓/身份上下文的姓氏匹配项。
 * bareSurname !== false 时（当前作品演员表路径），姓氏处于独立边界也算命中；
 * bareSurname === false 时，仅“姓氏+称谓”或“@/# 姓氏”等显式指代才命中，
 * 避免单字姓氏在无关语境下误伤（如演员杨幂的姓氏误拦“我是杨”）。
 */
export function buildBlockedSurnameMatchers(names, options = {}) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const matchers = [];
  for (const rawName of names) {
    const compact = String(rawName || '').normalize('NFKC').replace(/[\s·・•‧·･]+/g, '');
    if (!/\p{Script=Han}/u.test(compact) || Array.from(compact).length < 2) continue;
    const chars = Array.from(compact);
    const surname = COMMON_COMPOUND_SURNAMES.has(compact.slice(0, 2)) ? compact.slice(0, 2) : chars[0];
    if (seen.has(surname)) continue;
    seen.add(surname);
    const escaped = escapeRegExp(surname);
    const reference = `[@＃#]${escaped}(?=[^\\p{Script=Han}]|$)`;
    const bare = `(?:[@＃#]|^|[^\\p{Script=Han}])${escaped}(?=[^\\p{Script=Han}]|$|${SURNAME_REFERENCE_SUFFIX.source})`;
    const titled = `${escaped}${SURNAME_REFERENCE_SUFFIX.source}`;
    const regex = new RegExp(
      options.bareSurname === false ? `${reference}|${titled}` : `${bare}|${titled}`,
      'u'
    );
    matchers.push({ label: `姓氏:${surname}`, surname, regex });
  }
  return matchers;
}

const PERSON_NICKNAME_PREFIXES = ['小', '老', '阿', '大'];
const PERSON_NICKNAME_SUFFIXES = [
  '子', '儿', '哥', '姐', '弟', '妹', '叔', '姨', '爷', '奶',
  '哥哥', '姐姐', '弟弟', '妹妹', '叔叔', '阿姨', '爷爷', '奶奶',
  '老师', '先生', '小姐', '女士', '同学', '总', '导', '老板',
  '师傅', '师父', '公子', '姑娘', '少爷', '宝宝', '宝', '宝贝',
  '崽', '崽崽', '仔', '妞', '兄', '兄弟', '弟子', '妹子', '嫂', '嫂子',
  '爸', '妈', '爸爸', '妈妈', '伯', '伯伯', '舅', '舅舅', '婶', '婶婶',
  '姑', '姑姑', '姨姨', '爹', '娘', '姥姥', '姥爷', '桑', '酱',
  '大人', '殿下', '陛下', '夫人', '太太', '女神', '男神', '女王', '王子',
  '总裁', '队', '队长', '医生', '大夫', '警官', '院长', '教授'
];

/** 称呼仅从当前作品演员/角色姓名派生，按包含匹配，不限制人物语境。 */
export function buildPersonNicknameMatchers(names, kind = '角色') {
  const aliases = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = simplized(String(raw || '').normalize('NFKC')).trim();
    if (!/^\p{Script=Han}{2,}$/u.test(name)) continue;
    const chars = Array.from(name);
    const surnameLength = COMMON_COMPOUND_SURNAMES.has(chars.slice(0, 2).join('')) ? 2 : 1;
    const givenChars = chars.slice(surnameLength);
    const given = givenChars.join('');
    if (givenChars.length >= 2) aliases.add(given);
    // 相邻二字覆盖多字名简称（迪丽热巴→热巴、易烊千玺→千玺）；
    // 更长的名字片段已包含这些二字，因此无需枚举所有子串。
    for (let i = 0; i + 1 < givenChars.length; i++) aliases.add(givenChars.slice(i, i + 2).join(''));
    const surname = chars.slice(0, surnameLength).join('');
    const stems = new Set([name, surname, given, ...givenChars]);
    for (const stem of stems) {
      if (!stem) continue;
      for (const prefix of PERSON_NICKNAME_PREFIXES) aliases.add(`${prefix}${stem}`);
      for (const suffix of PERSON_NICKNAME_SUFFIXES) aliases.add(`${stem}${suffix}`);
      if (Array.from(stem).length === 1) aliases.add(`${stem}${stem}`);
    }
  }
  return [...aliases].map(needle => ({ label: `${kind}昵称:${needle}`, needle, regex: null }));
}

export function buildCharacterNicknameMatchers(names) {
  return buildPersonNicknameMatchers(names);
}

// 昵称数量随演员表增长（14 个演员即可派生 5000+ 个），逐条线性扫全部匹配器会让每次弹幕请求多花近 1 秒。
// 把纯字面量匹配器编成前缀树：按文本逐字走树，命中即返回，代价与昵称总数无关（只与文本长度有关）。
const NEEDLE_LABEL = Symbol('needleLabel');
function buildNeedleTrie(matchers) {
  const root = new Map();
  for (const matcher of matchers) {
    if (matcher.regex || !matcher.needle) continue;
    let node = root;
    for (const char of matcher.needle) {
      let next = node.get(char);
      if (!next) { next = new Map(); node.set(char, next); }
      node = next;
    }
    if (!node.has(NEEDLE_LABEL)) node.set(NEEDLE_LABEL, matcher.label);
  }
  return root;
}
function matchNeedleTrie(root, text) {
  for (let start = 0; start < text.length; start++) {
    let node = root;
    for (let index = start; index < text.length; index++) {
      node = node.get(text[index]);
      if (!node) break;
      const label = node.get(NEEDLE_LABEL);
      if (label !== undefined) return label;
    }
  }
  return null;
}

export function filterDanmusByBlockedNames(danmus, names, options = {}) {
  if (!Array.isArray(danmus) || danmus.length === 0) {
    return { danmus: Array.isArray(danmus) ? danmus : [], removedCount: 0, hits: [] };
  }
  // 当前作品演员及角色表中的完整名字直接匹配；未分类的人物名单保留语境规则。
  const characterMatchers = buildBlockedNameMatchers(options.characterNames).map(matcher => ({ ...matcher, regex: null }));
  const actorMatchers = buildBlockedNameMatchers(options.actorNames).map(matcher => ({ ...matcher, regex: null }));
  const matchers = [...characterMatchers, ...actorMatchers,
    ...buildCharacterNicknameMatchers(options.characterNames),
    ...buildPersonNicknameMatchers(options.actorNames, '演员'), ...buildBlockedNameMatchers(names)];
  const workTitles = [...new Set(options.workTitles || [])].map(title => ({
    label: `作品：${title}`,
    needle: simplized(String(title).normalize('NFKC')).replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
  })).filter(item => Array.from(item.needle).length >= 2);
  const surnameMatchers = buildBlockedSurnameMatchers(options.surnameNames, options.surnameMatcherOptions);
  if (matchers.length === 0 && surnameMatchers.length === 0 && workTitles.length === 0) {
    return { danmus, removedCount: 0, hits: [] };
  }
  const needleTrie = buildNeedleTrie(matchers);
  // 极少数带正则的匹配器（未分类名单的语境规则）仍需逐条判断，数量很少。
  const regexMatchers = matchers.filter(matcher => matcher.regex);

  const hitCounts = new Map();
  const filtered = danmus.filter(item => {
    const rawText = String(item?.m || '').normalize('NFKC');
    const text = rawText.replace(/[\s·・•‧·･]+/g, '').toLocaleLowerCase();
    const personText = matchers.length ? simplized(text) : text;
    let hit = needleTrie.size ? matchNeedleTrie(needleTrie, personText) : null;
    if (hit === null && regexMatchers.length) hit = regexMatchers.find(candidate => candidate.regex.test(personText))?.label ?? null;
    if (hit === null) hit = surnameMatchers.find(candidate => candidate.regex.test(text))?.label ?? null;
    if (hit === null && workTitles.length) {
      const workText = simplized(rawText).replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase();
      hit = workTitles.find(item => workText.includes(item.needle))?.label ?? null;
    }
    if (hit === null) return true;
    hitCounts.set(hit, (hitCounts.get(hit) || 0) + 1);
    return false;
  });
  return {
    danmus: filtered,
    removedCount: danmus.length - filtered.length,
    hits: [...hitCounts.entries()].map(([name, count]) => ({ name, count }))
  };
}

export function filterDanmusByBlockedWords(danmus, blockedWords = globals.blockedWords) {
  if (!Array.isArray(danmus) || !danmus.length) return Array.isArray(danmus) ? danmus : [];
  // =====================
  // 屏蔽词过滤（含生效诊断日志）
  // =====================
  // 屏蔽词仅支持纯文本词与 /regex/flags，不再解析人名或地区前缀。
  const regexArray = splitBlockedWords(blockedWords).map(parseBlockedWord);

  // [诊断1] 解析阶段：确认规则是否正确加载
  if (regexArray.length === 0) {
    if (blockedWords && blockedWords.trim() !== '') {
      log("warn", `[system] [danmu] [blocked-words] ❌ 已配置屏蔽词但未解析出有效规则，本次不会过滤任何弹幕！原始配置: ${JSON.stringify(blockedWords)}`);
    } else {
      log("info", `[system] [danmu] [blocked-words] 未配置屏蔽词(BLOCKED_WORDS 为空)，跳过过滤`);
    }
  } else {
    const ruleSummary = regexArray.map(r => r.toString()).join(' , ');
    log("info", `[system] [danmu] [blocked-words] 规则解析成功: 共 ${regexArray.length} 条规则 [ ${ruleSummary} ]`);
  }

  // 过滤列表（统计每条规则命中次数与拦截样本）
  const ruleHitCounts = new Array(regexArray.length).fill(0);
  const blockedSamples = [];
  const filteredDanmus = danmus.filter(item => {
    for (let i = 0; i < regexArray.length; i++) {
      if (regexArray[i].test(item.m)) { // 针对 `m` 字段进行匹配
        ruleHitCounts[i]++;
        if (blockedSamples.length < 3) {
          blockedSamples.push(`「${String(item.m).slice(0, 30)}」← ${regexArray[i].toString()}`);
        }
        return false;
      }
    }
    return true;
  });

  // [诊断2] 过滤阶段：明确判定屏蔽词是否生效
  const removedCount = danmus.length - filteredDanmus.length;
  if (regexArray.length > 0) {
    if (removedCount > 0) {
      const hitSummary = regexArray
        .map((r, i) => ({ rule: r.toString(), count: ruleHitCounts[i] }))
        .filter(x => x.count > 0)
        .map(x => `${x.rule} ×${x.count}`)
        .join(', ');
      log("info", `[system] [danmu] [blocked-words] ✅ 屏蔽词已生效: 拦截 ${removedCount}/${danmus.length} 条弹幕${hitSummary ? `，命中明细: ${hitSummary}` : ''}`);
      if (blockedSamples.length) {
        log("info", `[system] [danmu] [blocked-words] 拦截示例(最多3条): ${blockedSamples.join(' | ')}`);
      }
    } else {
      log("info", `[system] [danmu] [blocked-words] ⚠️ 规则已加载(${regexArray.length} 条规则)但本集弹幕无命中`);
    }
  }

  return filteredDanmus;
}

// 弹弹play 协议只使用 1=滚动、4=底部、5=顶部。B站高级弹幕(7)、代码弹幕(8)、
// BAS 弹幕(9) 没有对应模式，原样透传会被支持这些模式的播放器按脚本弹幕渲染
// （引流广告常用它放大字号或固定位置），统一降级为普通滚动弹幕，只保留文字。
const UNSUPPORTED_DANMU_MODES = new Set([7, 8, 9]);
const DANMU_MODE_FALLBACK = 1;

export function convertToDanmakuJson(contents, platform, commentConfig = getCommentTransformConfig()) {
  let danmus = [];
  let cidCounter = 1;
  let colorV2Count = 0; // 源渐变色弹幕（B站 color_v2）识别计数；DanmuX 不输出原生纹理
  let unsupportedModeCount = 0; // 降级为滚动弹幕的高级/代码/BAS 弹幕计数

  // 统一处理输入为数组
  let items = [];
  if (typeof contents === "string") {
    // 处理 XML 字符串
    items = [...contents.matchAll(/<d p="([^"]+)">([^<]+)<\/d>/g)].map(match => ({
      p: match[1],
      m: match[2]
    }));
  } else if (contents && Array.isArray(contents.danmuku)) {
    // 处理 danmuku 数组，映射为对象格式
    const typeMap = { right: 1, top: 4, bottom: 5 };
    const hexToDecimal = (hex) => (hex ? parseInt(hex.replace("#", ""), 16) : 16777215);
    items = contents.danmuku.map(item => ({
      timepoint: item[0],
      ct: typeMap[item[1]] !== undefined ? typeMap[item[1]] : 1,
      color: hexToDecimal(item[2]),
      content: item[4]
    }));
  } else if (Array.isArray(contents)) {
    // 处理标准对象数组
    items = contents;
  }

  if (!items.length) {
    // 如果是空数组，直接返回空数组，不抛出异常
    // 这样可以让兜底逻辑有机会执行
    return [];
  }

  for (const item of items) {
    let attributes, m;
    let time, mode, color;
    const nativeGradient = getNativeGradientValue(item);

    // 新增：处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      time = (item.progress / 1000).toFixed(2);
      mode = item.mode || 1;
      color = item.color ?? 16777215;
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      time = parseFloat(item.timepoint).toFixed(2);
      mode = item.ct || 0;
      color = item.color ?? 16777215;
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      time = parseFloat(pValues[0]).toFixed(2);
      mode = pValues[1] || 0;

      // 支持多种格式的 p 属性
      // 旧格式（4字段）：时间,类型,颜色,来源
      // 标准格式（8字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
      // Bilibili格式（9字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID,权重
      if (pValues.length === 4) {
        // 旧格式
        color = pValues[2] || 16777215;
      } else if (pValues.length >= 8) {
        // 新标准格式（8字段或9字段）
        color = pValues[3] || 16777215;
      } else {
        // 其他格式，尝试从第3或第4位获取颜色
        color = pValues[3] || pValues[2] || 16777215;
      }
      m = item.m;
    }

    if (UNSUPPORTED_DANMU_MODES.has(Number(mode))) {
      mode = DANMU_MODE_FALLBACK;
      unsupportedModeCount++;
    }

    // 优先使用弹幕自带的 _sourceLabel（应对合并工具），其次是外部传入的宏观 platform
    let currentPlatform = canonicalPlatformGroup(item._sourceLabel || platform);

    // 如果存在实时拉取的副源标签，安全追加
    const realTimeSource = canonicalPlatformName(item.realTimeSource);
    if (realTimeSource && !currentPlatform.split(/[&＆]/).includes(realTimeSource)) {
      currentPlatform = `${currentPlatform}＆${realTimeSource}`;
    }

    attributes = [
      time,
      mode,
      color,
      `[${currentPlatform}]`
    ].join(",");

    // 识别源数据中的 color_v2；DanmuX 输出阶段不会把 B 站原生纹理作为效果输出。
    const danmu = { p: attributes, m, cid: cidCounter++, like: item?.like };
    if (nativeGradient.present) {
      danmu.color_v2 = nativeGradient.value;
      colorV2Count++;
    }
    danmus.push(danmu);
  }

  if (colorV2Count > 0) {
    log("info", `[system] [danmu] [danmu convert] 识别了 ${colorV2Count} 条源渐变色弹幕（color_v2）`);
  }
  if (unsupportedModeCount > 0) {
    log("info", `[system] [danmu] [danmu convert] 转换了 ${unsupportedModeCount} 条高级/代码/BAS弹幕为滚动弹幕`);
  }

  // 文本字段归一化为 m 后统一转换，确保所有来源及输入格式行为一致。
  const textConverter = commentConfig.danmuSimplifiedTraditional === 'simplified'
    ? simplized
    : commentConfig.danmuSimplifiedTraditional === 'traditional'
      ? traditionalized
      : null;

  if (textConverter) {
    danmus = danmus.map(danmu => ({
      ...danmu,
      m: typeof danmu.m === 'string' ? textConverter(danmu.m) : danmu.m
    }));
    const targetLabel = commentConfig.danmuSimplifiedTraditional === 'simplified' ? '简体字' : '繁体字';
    log("info", `[system] [danmu] [danmu convert] 转换了 ${danmus.length} 条弹幕为${targetLabel}`);
  }

  return commentConfig.deferProcessing ? danmus : renderDanmakuComments(danmus, commentConfig);
}

// Display transforms run after dynamic text/person filtering; cached input stays lossless.
export function renderDanmakuComments(danmus, commentConfig = getCommentTransformConfig()) {
  const sourceLabels = new Set(danmus.map(item => item.p.match(/\[([^\]]*)\]$/)?.[1] || ''));
  const isMultiSource = [...sourceLabels].some(label => /[&＆]/.test(label));
  const filteredDanmus = filterDanmusByBlockedWords(danmus, commentConfig.blockedWords);

  // 按n分钟内去重
  log("info", `[system] [danmu] 去重分钟数: ${commentConfig.groupMinute}`);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, commentConfig.groupMinute, isMultiSource || sourceLabels.size > 1);

  // 处理点赞数
  const likeDanmus = handleDanmusLike(groupedDanmus, commentConfig.likeSwitch);

  // 应用弹幕转换规则（在去重和限制弹幕数之后）
  let convertedDanmus = limitDanmusByCount(likeDanmus, commentConfig.danmuLimit);
  if (commentConfig.convertTopBottomToScroll || commentConfig.convertColor === 'white' || commentConfig.convertColor === 'color' || commentConfig.gradientEnabled) {
    let topBottomCount = 0;
    let colorCount = 0;
    let gradientCount = 0;
    // 独立开关：普通白色弹幕按概率使用固定 bili 渐变。
    const gradientRawStops = commentConfig.gradientEnabled ? BILI_GRADIENT_COLORS : null;
    const gradientSampler = buildGradientSampler(gradientRawStops);
    const danmuxGradientStops = gradientStopsForDanmux(gradientRawStops);
    const gradientChance = Math.min(Math.max(commentConfig.gradientChance || 0, 0), 100) / 100;
    const colorPoolText = typeof commentConfig.colorPool === 'string' ? commentConfig.colorPool : '';
    const colors = colorPoolText.split(',')
      .map(c => parseInt(c.trim(), 10))
      .filter(c => !isNaN(c) && c >= 0 && c <= 16777215);
    const safeColors = colors.length > 0 ? colors : [16777215];

    convertedDanmus = convertedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) return danmu;

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10);
      const originallyWhite = color === 16777215;
      let modified = false;
      let selectedGradient = false;

      // 1. 将顶部/底部弹幕转换为浮动弹幕
      if (commentConfig.convertTopBottomToScroll && (mode === 4 || mode === 5)) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 弹幕转换颜色
      // 2.1 将彩色弹幕转换为白色
      if (commentConfig.convertColor === 'white' && color !== 16777215) {
        colorCount++;
        color = 16777215;
        modified = true;
      }
      // 2.2 将白色弹幕转换为随机颜色，白、红、橙、黄、绿、青、蓝、紫、粉（模拟真实情况，增加白色出现概率）
      // 颜色池配置可能为空或尚未初始化，先安全解析；无有效颜色时回退为白色。
      // 这样即使运行时配置不完整，也不会因为调用 split() 抛错或把颜色写成 undefined。
      // B 站原生渐变不参与本规则；这里只处理没有 color_v2 的普通白色弹幕。
      if ((commentConfig.convertColor === 'color' || commentConfig.gradientEnabled) && originallyWhite && !getNativeGradientValue(danmu).present) {
        let target = commentConfig.convertColor === 'color' ? safeColors[Math.floor(Math.random() * safeColors.length)] : color;
        if (gradientSampler && danmuxGradientStops && Math.random() < gradientChance) {
          // Legacy fallback samples pink→blue every 60 seconds, then resets.
          const appearTime = parseFloat(pValues[0]) || 0;
          target = gradientSampler((appearTime % 60) / 60);
          selectedGradient = true;
          gradientCount++;
        }
        if (color !== target) {
          colorCount++;
          color = target;
          modified = true;
        }
      }

      if (modified) {
        const newP = [pValues[0], mode, color, ...pValues.slice(3)].join(',');
        const converted = { ...danmu, p: newP };
        if (selectedGradient) Object.defineProperty(converted, DANMUX_GRADIENT_META, {
          value: { angle: 0, stops: danmuxGradientStops },
          enumerable: false,
        });
        return converted;
      }
      if (selectedGradient) Object.defineProperty(danmu, DANMUX_GRADIENT_META, {
        value: { angle: 0, stops: danmuxGradientStops },
        enumerable: false,
      });
      return danmu;
    });

    // 统计输出转换结果
    if (topBottomCount > 0) {
      log("info", `[system] [danmu] [danmu convert] 转换了 ${topBottomCount} 条顶部/底部弹幕为浮动弹幕`);
    }
    if (colorCount > 0) {
      const gradientShare = convertedDanmus.length ? Math.round(gradientCount * 100 / convertedDanmus.length) : 0;
      log("info", `[system] [danmu] [danmu convert] 转换了 ${colorCount} 条弹幕颜色（其中渐变色弹幕 ${gradientCount} 条，占全部弹幕 ${gradientShare}%）`);
    }
  }

  log("info", `[system] [danmu] danmus_original: ${danmus.length}`);
  log("info", `[system] [danmu] danmus_filter: ${filteredDanmus.length}`);
  log("info", `[system] [danmu] danmus_group: ${groupedDanmus.length}`);
  log("info", `[system] [danmu] danmus_limit: ${convertedDanmus.length}`);
  // 输出前五条弹幕
  log("info", "[system] [danmu] Top 5 danmus:", JSON.stringify(convertedDanmus.slice(0, 5), null, 2));
  return convertedDanmus;
}

// RGB 转整数的函数
export function rgbToInt(color) {
  // 检查 RGB 值是否有效
  if (
    typeof color.r !== 'number' || color.r < 0 || color.r > 255 ||
    typeof color.g !== 'number' || color.g < 0 || color.g > 255 ||
    typeof color.b !== 'number' || color.b < 0 || color.b > 255
  ) {
    return -1;
  }
  return color.r * 256 * 256 + color.g * 256 + color.b;
}

// 解析 hex 到 int（假设不带 #）
export function hexToInt(hex) {
  // 简单校验：确保是 6 位 hex 字符串（不带 #）
  if (typeof hex !== 'string' || hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
    return 16777215;  // 无效输入，返回 16777215 白色
  }
  return parseInt(hex, 16);  // 直接转换为整数
}

// 将弹幕 JSON 数据转换为 XML 格式（Bilibili 标准格式）
export function convertDanmuToXml(danmuData) {
  let xml = '<?xml version="1.0" ?>\n';
  xml += '<i>\n';

  // 添加弹幕数据
  const comments = danmuData.comments || [];
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      // 解析原有的 p 属性，转换为 Bilibili 格式
      const pValue = buildBilibiliDanmuP(comment);
      xml += '    <d p="' + escapeXmlAttr(pValue) + '">' + escapeXmlText(comment.m) + '</d>\n';
    }
  }

  xml += '</i>';
  return xml;
}

// 生成弹幕ID（11位数字）
function generateDanmuId() {
  // 生成11位数字ID
  // 格式: 时间戳后8位 + 随机3位
  const timestamp = Date.now();
  const lastEightDigits = (timestamp % 100000000).toString().padStart(8, '0');
  const randomThreeDigits = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return lastEightDigits + randomThreeDigits;
}

// 构建 Bilibili 格式的 p 属性值（8个字段）
function buildBilibiliDanmuP(comment) {
  // Bilibili 格式: 时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
  // 示例: 5.0,5,25,16488046,1751533608,0,0,13190629936

  const pValues = comment.p.split(',');
  const timeNum = parseFloat(pValues[0]) || 0;
  const time = timeNum.toFixed(1); // 时间（秒，保留1位小数）
  const mode = pValues[1] || '1'; // 类型（1=滚动, 4=底部, 5=顶部）
  const fontSize = '25'; // 字体大小（25=中, 18=小）

  // 颜色字段（输入总是4字段格式：时间,类型,颜色,平台）
  const color = pValues[2] || '16777215'; // 默认白色

  // 使用固定值以符合标准格式
  const timestamp = '1751533608'; // 固定时间戳
  const pool = '0'; // 弹幕池（固定为0）
  const userHash = '0'; // 用户Hash（固定为0）
  const danmuId = generateDanmuId(); // 弹幕ID（11位数字）

  return `${time},${mode},${fontSize},${color},${timestamp},${pool},${userHash},${danmuId}`;
}

// 转义 XML 属性值
function escapeXmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 转义 XML 文本内容
function escapeXmlText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 根据格式参数返回弹幕数据
export function formatDanmuResponse(danmuData, queryFormat) {
  // 确定最终使用的格式：查询参数 > 环境变量 > 默认值
  let format = queryFormat || globals.danmuOutputFormat;
  format = format.toLowerCase();

  log("info", `[system] [danmu] [format] Using format: ${format}`);

  if (format === 'danmux') {
    try {
      return jsonResponse(convertCommentsToDanmux(danmuData, {
        sourceLabel: 'danmu_api',
        applyGradientToAll: false,
      }));
    } catch (error) {
      log("error", `[system] [danmu] Failed to convert to DanmuX: ${error.message}`);
      return jsonResponse({ format: 'danmux', schemaVersion: 1, count: 0, comments: [], diagnostics: [{ code: 'danmux_output_failed', message: error.message }] }, 500);
    }
  }

  // 兼容旧格式转换
  if (format === 'xml') {
    try {
      const xmlData = convertDanmuToXml(danmuData);
      return xmlResponse(xmlData);
    } catch (error) {
      log("error", `[system] [danmu] Failed to convert to XML: ${error.message}`);
      // 转换失败时回退到 JSON
      return jsonResponse(danmuData);
    }
  } else if (format === 'json') return jsonResponse(appendDanmuxGradients(danmuData, getCommentTransformConfig()));

  const converted = convertDanAny(danmuData, format);
  if (converted?.type === 'json') return jsonResponse(converted.data);
  if (converted?.type === 'xml') return xmlResponse(converted.data);
  if (converted?.type === 'binary') return binResponse(converted.data, converted.filename);

  // 默认返回 JSON
  return jsonResponse(appendDanmuxGradients(danmuData, getCommentTransformConfig()));
}
