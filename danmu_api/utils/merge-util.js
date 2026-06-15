import { globals } from '../configs/globals.js';
import { log as baseLog } from './log-util.js';
import { addAnime } from './cache-util.js';
import { simplized } from '../utils/zh-util.js';
import { normalizeSpaces } from '../utils/common-util.js';

// ==============================================================================
//  源合并处理工具 (merge-util.js)
//
//  架构分层（从底层到顶层）：
//  [L1] 核心配置与常量      —— 权重、阈值、日志开关
//  [L2] 日志系统            —— 带调试过滤的 log 包装器
//  [L3] 正则仓库与数据字典  —— RegexStore、SEASON_PATTERNS、特殊系列注册表
//  [L4] 基础文本处理层      —— 清洗、解析、通用工具（含 fastCloneAnime）
//  [L5] 相似度计算引擎      —— Levenshtein、Dice、综合相似度
//  [L6] 领域属性提取层      —— 季度标记、媒体类型、内容分类
//  [L7] 领域冲突检测层      —— 标题冲突、季度冲突、日期冲突、覆盖率校验
//  [L8] 集数处理层          —— 提取、过滤、对齐偏移、补全、沉底
//  [L9] 核心匹配层          —— 上下文感知、集内容探测、副源检索、映射表特权提权
//  [L10] 合并业务流程层     —— 合集探测、映射表精确路由 (Custom Routes)、单任务执行
//  [L11] 主入口             —— applyMergeLogic (动态源组合与三段式 Phase)
//  [L12] 弹幕工具层         —— 时间轴对齐、弹幕合并
// ==============================================================================


// ==============================================================================
// [L1] 核心配置与常量 (Immutable Configuration)
// ==============================================================================

/**
 * 定义组合 ID 的分隔符 (URL Safe)
 * 用于在单个 url 字段中拼接多源播放地址
 * @constant {string}
 */
export const MERGE_DELIMITER = '$$$';

/**
 * 定义前端显示的源连接符
 * 出现在合并后条目的来源标签中，如 "bilibili&dandan"
 * @constant {string}
 */
export const DISPLAY_CONNECTOR = '&';

/** 调试级别的详细合并日志开关 (false=关闭, true=开启) */
const ENABLE_VERBOSE_MERGE_LOG = false;

/**
 * 核心算法权重配置
 * 集中管理所有评分逻辑中的增益与惩罚数值，便于统一调参
 * @readonly
 */
const MergeWeights = Object.freeze({
    // ── 标题与结构 ──────────────────────────────────────────
    TITLE_STRUCTURE_CONFLICT: -0.30, // 标题结构冲突（如父子集关系）
    LANG_MATCH_CN:             0.15, // 双端均为中文时的语言一致奖励
    LANG_MISMATCH:            -0.20, // 语言不一致时的惩罚

    // ── 日期 ─────────────────────────────────────────────────
    DATE_MATCH: 0.0, // 基础日期匹配（动态计算，此处为占位）

    // ── 集数对齐 (Episode Alignment) ─────────────────────────
    EP_ALIGN: {
        MOVIE_TYPE_MISMATCH:     -5.0,  // 电影/TV 类型不符
        SPECIAL_STRICT_MISMATCH: -8.0,  // 正片与番外（SP/OVA）混淆
        LANG_MATCH:               3.0,  // 集标题语言一致
        LANG_MISMATCH:           -5.0,  // 集标题语言不一致
        SEASON_NUM_MISMATCH:    -10.0,  // 季度编号冲突
        SPECIAL_TYPE_MISMATCH:  -10.0,  // 特殊类型（OP/ED）不一致
        SPECIAL_TYPE_MATCH:       3.0,  // 特殊类型一致
        IS_SPECIAL_MATCH:         3.0,  // 是否为特殊集属性一致
        SEASON_SHIFT_EXACT:      15.0,  // 完美的季度偏移匹配（如 S2E1 → S1E13）
        CN_STRICT_MATCH:         25.0,  // 中文严格：核心词命中且集数一致的奖励
        CN_STRICT_MISMATCH:      -5.0,  // 中文严格：核心词包含但集数不同（防同系列误对齐）
        NUMERIC_MATCH:            2.0,  // 数字严格相等奖励
        PATTERN_CONSISTENCY_BONUS: 2.0, // 强规律性奖励（偏移一致比例高）
        ZERO_DIFF_BONUS_BASE:   100.0,  // 零偏移的额外基准奖励
        ZERO_DIFF_BONUS_PER_HIT:  5.0   // 零偏移的单次命中奖励
    }
});

/**
 * 逻辑判定阈值
 * 供各检测函数引用，避免散落的魔术数字
 * @readonly
 */
const Thresholds = Object.freeze({
    SIMILARITY_MIN:    0.65,  // 最低标题相似度（低于此值直接拒绝）
    SIMILARITY_STRONG: 0.98,  // 强匹配（Probe 确认后）
    TIER_DEFAULT:      0.001, // 默认分数梯度容差（精确匹配）
    TIER_CN:           0.40,  // 中文优先梯度容差（宽松保留CN资源）
    TIER_PART:         0.50,  // Part 分部容差
    COLLECTION_RATIO:  4.0,   // 合集判定比率上限（防超大合集误标）
    COLLECTION_DIFF:   6      // 合集判定数量差阈值（超出N集才认为是合集）
});


// ==============================================================================
// [L2] 日志系统 (Log System)
// ==============================================================================

/**
 * 带过滤功能的日志包装器
 * 拦截细碎的 [Merge-Check] 级别日志，仅在 ENABLE_VERBOSE_MERGE_LOG 为 true 时输出，
 * 避免生产环境日志洪泛
 * @param {string} level - 日志级别 ('info' | 'warn' | 'error')
 * @param {...any} args  - 日志内容
 */
function log(level, ...args) {
    const isMergeCheck = typeof args[0] === 'string' && args[0].includes('[Merge-Check]');
    if (isMergeCheck && !ENABLE_VERBOSE_MERGE_LOG) return;
    baseLog(level, ...args);
}


// ==============================================================================
// [L3] 正则仓库与数据字典 (Regex Store & Data Dictionaries)
// ==============================================================================

/**
 * 正则表达式中央仓库
 * 按功能域分组，避免在函数体内散落难以维护的字面量正则
 * 所有正则仅初始化一次，全局复用
 */
const RegexStore = {
    /** 语言识别正则 */
    Lang: {
        CN:          /(普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽])(?:版)?/,
        JP:          /(日[语語]|日配|原版|原[声聲])(?:版)?/,
        CN_DUB_VER:  /(\(|（|\[)?(普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽])版?(\)|）|\])?/g,
        JP_DUB_VER:  /(\(|（|\[)?(日[语語]|日配|原版|原[声聲])版?(\)|）|\])?/g,
        KEYWORDS_STRONG: /(?:普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽]|日[语語]|日配|原版|原[声聲])(?:版)?/g,
        CN_STD:      /普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽]/g,
        JP_STD:      /日[语語]|日配|原版|原[声聲]/g
    },
    /** 季度解析正则 */
    Season: {
        PURE_PART:        /^(?:(?:第|S(?:eason)?)\s*\d+(?:季|期|部)?|(?:Part|P|第)\s*\d+(?:部分)?)$/i,
        PART_NORM:        /第\s*(\d+)\s*部分/g,
        PART_NORM_2:      /(?:Part|P)[\s.]*(\d+)/gi,
        FINAL:            /(?:The\s+)?Final\s+Season/gi,
        NORM:             /(?:Season|S)\s*(\d+)/gi,
        CN:               /第\s*([一二三四五六七八九十])\s*季/g,
        ROMAN:            /(\s|^)(IV|III|II|I)(\s|$)/g,
        INFO_STRONG:      /(?:season|s|第)\s*[0-9一二三四五六七八九十]+\s*(?:季|期|部(?!分))?/gi,
        PART_INFO_STRONG: /(?:part|p|第)\s*\d+\s*(?:部分)?/gi,
        PART_ANY:         /(?:part|p)\s*\d+/gi,
        CN_STRUCTURE:     /(?:^|\s|×\d+\s?)(承|转|结)(?=$|[\s\(\（\[【])/i,
        SUFFIX_AMBIGUOUS: /(?:[\s\u4e00-\u9fa5]|^)(S|T|R|II|III|IV)(?=$|[\s\(\（\[【])/i,
        SUFFIX_SEQUEL:    /(?:续篇|续集|The Sequel)/i
    },
    /** 通用文本清洗正则 */
    Clean: {
        NA_TAG:              /(\(|（|\[)N\/A(\)|）|\])/gi,
        SOURCE_TAG:          /【.*?】/g,
        REGION_LIMIT:        /(\(|（|\[)仅限.*?地区(\)|）|\])/g,
        PUNCTUATION:         /[!！?？,，.。、~～:：\-–—_]/g,
        WHITESPACE:          /\s+/g,
        FROM_SUFFIX:         /\s*from\s+.*$/i,
        PARENTHESES_CONTENT: /(\(|（|\[).*?(\)|）|\])/g,
        MOVIE_KEYWORDS:      /剧场版|劇場版|the\s*movie|theatrical|movie|film|电影/gi,
        LONE_VER_CHAR:       /(\s|^)版(\s|$)/g,
        NON_ALPHANUM_CN:     /[^\u4e00-\u9fa5a-zA-Z0-9]/g,
        META_SUFFIX:         /(\(|（|\[)(续篇|TV版|无修|未删减|完整版)(\)|）|\])/gi,
        YEAR_TAG:            /(\(|（|\[)\d{4}(\)|）|\]).*$/i,
        SUBTITLE_SEPARATOR:  /^[\s:：\-–—(（\[【]/,
        SPACE_STRUCTURE:     /.+[\s\u00A0\u3000].+/,
        SPLIT_SPACES:        /[\s\u00A0\u3000]+/,
        REDUNDANT_SEPARATOR: /[\s:：~～]/,
        REDUNDANT_UNSAFE_END:/[\(\（\[【:：~～\-]$/,
        REDUNDANT_VALID_CHARS:/[\u4e00-\u9fa5a-zA-Z]{2,}/
    },
    /** 集数处理正则 */
    Episode: {
        SUFFIX_DIGIT:        /_\d+(?=$|\s)/g,
        FILE_NOISE:          /_(\d{2,4})(?=\.)/g,
        SEASON_PREFIX:       /(?:^|\s)(?:第\s*[0-9一二三四五六七八九十]+\s*季|S(?:eason)?\s*\d+)(?:\s+|_)/gi,
        CLEAN_SMART:         /(?:^|\s)(?:EP|E|Vol|Episode|No|Part|第)\s*\d+(?:\.\d+)?(?:\s*[话話集])?(?!\s*[季期部])/gi,
        PUNCTUATION:         /[!！?？,，.。、~～:：\-–—]/g,
        DANDAN_TAG:          /^【(dandan|animeko)】/i,
        SPECIAL_START:       /^S\d+/i,
        MOVIE_CHECK:         /剧场版|劇場版|movie|film/i,
        PV_CHECK:            /(pv|trailer|预告)/i,
        SPECIAL_CHECK:       /^(s|o|sp|special)\d/i,
        SEASON_MATCH:        /(?:^|\s)(?:第|S)\s*(\d+)\s*[季S]/i,
        NUM_STRATEGY_A:      /(?:第|s)\s*(\d+)\s*[季s]\s*(?:第|ep|e)\s*(\d+)/i,
        NUM_STRATEGY_B:      /(?:ep|e|vol|episode|chapter|no|part|第)\s*(\d+(\.\d+)?)(?:\s*[话話集])?(?!\s*[季期部])/i,
        NUM_STRATEGY_C:      /(?:^|\s)(?:第)?(\d+(\.\d+)?)(?:话|集|\s|$)/,
        DANDAN_IGNORE:       /^[SC]\d+/i,
        MAP_EXCLUDE_KEYWORDS:/(?:^|\s)(?:PV|OP|ED|SP|Special|Drama|OAD|OVA|Opening|Ending|特番|特典|Behind\s+the\s+Scenes|Making|Interview)(?:\s|$|[:：])/i,
        SINK_TITLE_STRICT:   /^(?:S\d+|C\d+|SP\d*|OP\d*|ED\d*|PV\d*|Trailers?|Interview|Making|特番|特典)(?:\s|$|[:：.\-]|\u3000)/i
    },
    /** 内容分类正则 */
    Category: {
        ANIME_KW:        /(动画|TV动画|动漫|日漫|国漫)/,
        REAL_KW:         /(电视剧|真人剧|综艺|纪录片)/,
        ANIMEKO_SOURCE:  /animeko/i
    },
    /** 相似度计算专用正则 */
    Similarity: {
        CN_STRICT_CORE_REMOVE: /[0-9a-zA-Z\s第季集话partEPep._\-–—:：【】()（）]/gi
    }
};

/**
 * 特殊后缀硬映射表
 * 处理特定系列的专有名称后缀（如 "A's" 对应 S2），优先于通用季度识别逻辑
 * @type {Array<{regex: RegExp, val: string}>}
 */
const SUFFIX_SPECIFIC_MAP = [
    { regex: /(?:\s|^)A's$/i,      val: 'S2' },
    { regex: /(?:\s|^)StrikerS$/i, val: 'S3' },
    { regex: /(?:\s|^)ViVid$/i,    val: 'S4' },
    { regex: /(?:\s|^)SuperS$/i,   val: 'S4' }
];

/**
 * 通用季度识别模式列表
 * 按优先级顺序排列，extractSeasonMarkers 遍历此表识别标记
 * prefix 字段表示提取数字后的标记前缀（如 'S' → 'S1', 'P' → 'P2'）
 * val 字段表示固定标记值（无需提取数字）
 * useCleaned 为 true 时使用去除 Part 信息后的标题进行匹配
 * @type {Array<{regex: RegExp, prefix?: string, val?: string, useCleaned?: boolean}>}
 */
const SEASON_PATTERNS = [
    { regex: /(?:第)?\s*(\d+)\s*(?:季|期|部(?!分))/, prefix: 'S' },
    { regex: /\bseason\s*(\d+)/i,                     prefix: 'S' },
    { regex: /\bs\s*(\d+)\b/i,                        prefix: 'S' },
    { regex: /\bpart\s*(\d+)/i,                       prefix: 'P' },
    { regex: /\b(ova|oad)\d*\b/i,                     val: 'OVA'   },
    { regex: /(剧场版|劇場版|the\s*movie|theatrical|movie|film|电影)/i, val: 'MOVIE' },
    { regex: /(续篇|续集)/,                            val: 'SEQUEL' },
    { regex: /\b(sp|special)\d*\b/i,                  val: 'SP'    },
    // 回退：清洗后以数字结尾（如 "タイトル2"）视为 S{N}
    { regex: /[^0-9](\d)$/, prefix: 'S', useCleaned: true }
];

/**
 * 特殊番剧特征规则注册表 (Special Series Registry)
 * 用于将特定系列的副标题或专有名词映射为标准季度/类型描述，
 * 确保 normalizeTitleForEngine 能正确归一化语义
 *
 * 规则结构：
 *   seriesKeywords  : 系列识别关键词（全部命中时生效）
 *   mappings        : 副标题 → 标准标签映射列表（可选）
 *   defaultStandard : 无副标题时的默认标签（可选）
 */
const SpecialSeriesRegistry = [
    {
        // 案例 1：经典的带副标题映射（美少女战士）
        seriesKeywords: ["美少女战士"],
        mappings: [
            { markers: ["R"],                       targetStandard: "第二季" },
            { markers: ["S"],                       targetStandard: "第三季" },
            { markers: ["SuperS", "Super S"],       targetStandard: "第四季" },
            { markers: ["Sailor Stars", "最后的星光"], targetStandard: "第五季" }
        ]
    },
    {
        seriesKeywords: ["小林家的龙女仆"],
        mappings: [
            { markers: ["S"], targetStandard: "第二季" }
        ]
    },
    {
        // 案例 2：可能携带副标题的（我们不可能成为恋人）
        seriesKeywords: ["可能成为恋人", "不行"],
        mappings: [
            { markers: ["NEXT SHINE", "再次闪耀"], targetStandard: "续篇" }
        ]
    },
    {
        // 案例 3：没有任何副标题，主标题本身就是特殊类型
        seriesKeywords: ["红猪", "千与千寻", "龙猫"],
        // 当没有匹配到任何 mappings（或根本没写 mappings）时，直接给这个条目打上默认标签
        defaultStandard: "剧场版"
    }
];


// ==============================================================================
// [L4] 基础文本处理层 (Foundation Text Utilities)
// ==============================================================================

/**
 * 转义正则表达式特殊字符
 * 防止动态构建正则时注入危险字符
 * @param {string} string - 原始字符串
 * @returns {string} 转义后的字符串
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * [性能优化] 快速对象深克隆
 * 优先使用 V8 引擎底层提供的 structuredClone，回退方案为 JSON 序列化。
 * 集中到基础工具层，供 processMergeTask 等业务函数复用，避免在业务逻辑中散落克隆代码。
 * @param {any} anime - 待克隆的对象
 * @returns {any} 深克隆副本
 */
function fastCloneAnime(anime) {
    // 兼容性降级处理，优先使用 structuredClone（性能更优）
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(anime);
        } catch (e) { /* Fallback to JSON */ }
    }
    return JSON.parse(JSON.stringify(anime));
}

/**
 * 识别文本语言类型 (CN / JP / Unspecified)
 * 用于后续的配音版本隔离和相似度算法选择
 * @param {string} text - 标题文本
 * @returns {'CN'|'JP'|'Unspecified'}
 */
function getLanguageType(text) {
    if (!text) return 'Unspecified';
    const t = text.toLowerCase();
    if (RegexStore.Lang.CN.test(t)) return 'CN';
    if (RegexStore.Lang.JP.test(t)) return 'JP';
    return 'Unspecified';
}

/**
 * 引擎级标题语义转换器 (Semantic Normalizer)
 * 在清洗流程的最前端，将特定系列的专有名词/副标题映射为标准化的季度/类型描述，
 * 保证后续所有算法看到一致的语义输入
 * 依赖 SpecialSeriesRegistry 和 escapeRegExp
 * @param {string} title - 原始标题
 * @returns {string} 语义归一化后的标题
 */
function normalizeTitleForEngine(title) {
    if (!title) return '';
    let normTitle = title;
    const upperTitle = normTitle.toUpperCase();
    for (const rule of SpecialSeriesRegistry) {
        // 判断是否命中了设定的系列（所有关键词必须全部命中）
        const isTargetSeries = rule.seriesKeywords.every(kw => upperTitle.includes(kw.toUpperCase()));
        if (!isTargetSeries) continue;
        let hasMapped = false;
        // 1. 尝试匹配并替换副标题
        if (rule.mappings) {
            for (const mapping of rule.mappings) {
                mapping.markers.forEach(marker => {
                    // 'gi' 保证了全局且忽略大小写的替换
                    const reg = new RegExp(escapeRegExp(marker), 'gi');
                    if (reg.test(normTitle)) {
                        normTitle = normTitle.replace(reg, ` ${mapping.targetStandard} `);
                        hasMapped = true;
                    }
                });
            }
        }
        // 2. 如果没有任何副标题被替换，且配置了 defaultStandard，则强行追加标准类型
        if (!hasMapped && rule.defaultStandard) {
            normTitle += ` ${rule.defaultStandard} `;
        }
    }
    return normTitle;
}

/**
 * 通用文本清洗
 * 包含：繁简转换、移除 N/A 标签、标准化季数格式、保护小数点、移除干扰符号
 * 用于集数标题比对等中间层处理
 * @param {string} text - 原始文本
 * @returns {string} 清洗后的文本（小写）
 */
function cleanText(text) {
    if (!text) return '';
    let clean = simplized(text);
    clean = clean.replace(RegexStore.Clean.NA_TAG, '');
    // 标准化 Part/Season 表达
    clean = clean.replace(RegexStore.Season.PART_NORM,   'part $1');
    clean = clean.replace(RegexStore.Season.PART_NORM_2, 'part $1');
    clean = clean.replace(RegexStore.Season.FINAL, '最终季');
    clean = clean.replace(RegexStore.Season.NORM,  '第$1季');
    // 中文数字季度转阿拉伯数字
    const cnNums = { '一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10' };
    clean = clean.replace(RegexStore.Season.CN, (m, num) => `第${cnNums[num]}季`);
    // 罗马数字季度转阿拉伯数字
    clean = clean.replace(RegexStore.Season.ROMAN, (match, p1, roman, p2) => {
        const rMap = { 'I':'1','II':'2','III':'3','IV':'4' };
        return `${p1}第${rMap[roman]}季${p2}`;
    });
    // 语言标识标准化
    clean = clean.replace(RegexStore.Lang.CN_DUB_VER, '中配版');
    clean = clean.replace(RegexStore.Lang.JP_DUB_VER, '');
    clean = clean.replace(RegexStore.Clean.SOURCE_TAG,    '');
    clean = clean.replace(RegexStore.Clean.REGION_LIMIT,  '');
    // 保护小数点，避免被标点清洗误删
    clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');
    clean = clean.replace(RegexStore.Clean.PUNCTUATION, ' ');
    clean = clean.replace(/{{DOT}}/g, '.');
    return clean.replace(RegexStore.Clean.WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 相似度计算专用极简清洗
 * 强力移除所有季数、Part、括号内容、语言标识、维数标识等，只保留核心标题字符，
 * 确保 calculateSimilarity 比较的是语义核心而非元数据外壳
 * @param {string} text - 原始标题
 * @returns {string} 用于相似度计算的极简标题（小写，无空格）
 */
function cleanTitleForSimilarity(text) {
    if (!text) return '';
    // 先做引擎级语义转换，保证特殊系列能被正确对齐
    let clean = normalizeTitleForEngine(text);
    clean = simplized(clean);
    // 标题保护逻辑：如果标题被包裹在 【】 或 [] 中且位于开头，尝试提取内容
    const startBracketMatch = clean.match(/^(?:【|\[)(.+?)(?:】|\])/);
    if (startBracketMatch) {
        const content = startBracketMatch[1];
        if (!/^(TV|剧场版|劇場版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
            clean = clean.replace(startBracketMatch[0], content + ' ');
        }
    }
    // 逐层剥离元数据
    clean = clean.replace(RegexStore.Clean.SOURCE_TAG,          '');
    clean = clean.replace(RegexStore.Clean.FROM_SUFFIX,         '');
    clean = clean.replace(RegexStore.Clean.NA_TAG,              '');
    clean = clean.replace(RegexStore.Clean.PARENTHESES_CONTENT, '');
    clean = clean.replace(RegexStore.Season.INFO_STRONG,        '');
    clean = clean.replace(RegexStore.Season.PART_INFO_STRONG,   '');
    clean = clean.replace(RegexStore.Clean.MOVIE_KEYWORDS,      '');
    clean = clean.replace(RegexStore.Lang.KEYWORDS_STRONG,      '');
    clean = clean.replace(RegexStore.Clean.LONE_VER_CHAR,       '');
    clean = clean.replace(RegexStore.Clean.NON_ALPHANUM_CN,     '');
    return clean.toLowerCase();
}

/**
 * 集标题清洗
 * 移除 S1、EP、第X话 等结构前缀，只保留集数描述或核心标题，
 * 供集数对齐算法的文本相似度比较使用
 * @param {string} text - 原始集标题
 * @returns {string} 清洗后的集标题（小写）
 */
function cleanEpisodeText(text) {
    if (!text) return '';
    let clean = simplized(text);
    clean = clean.replace(RegexStore.Episode.SUFFIX_DIGIT,   '');
    clean = clean.replace(RegexStore.Episode.FILE_NOISE,     '');
    clean = clean.replace(RegexStore.Episode.SEASON_PREFIX,  ' ');
    clean = clean.replace(RegexStore.Episode.CLEAN_SMART,    ' ');
    clean = clean.replace(RegexStore.Clean.SOURCE_TAG,       '');
    // 语言标识统一为标准词，便于后续比对
    clean = clean.replace(RegexStore.Lang.CN_STD, '中文');
    clean = clean.replace(RegexStore.Lang.JP_STD, '日文');
    // 保护小数点
    clean = clean.replace(/(\d+)\.(\d+)/g, '$1{{DOT}}$2');
    clean = clean.replace(RegexStore.Episode.PUNCTUATION, ' ');
    clean = clean.replace(/{{DOT}}/g, '.');
    return clean.replace(RegexStore.Clean.WHITESPACE, ' ').toLowerCase().trim();
}

/**
 * 移除括号内容
 * 用于提取主标题进行比对，规避副标题翻译差异对相似度的干扰
 * @param {string} text - 原始文本
 * @returns {string} 去除括号内容后的文本
 */
function removeParentheses(text) {
    if (!text) return '';
    return text.replace(RegexStore.Clean.PARENTHESES_CONTENT, '').trim();
}

/**
 * 清洗并提取真实的 ID / URL
 * 处理 MERGE_DELIMITER 分隔的复合 ID 字符串，提取第一个（主源）ID，
 * 并修正协议头缺失等常见问题
 * @param {string} urlStr - 原始 URL 或 ID 字符串
 * @returns {string} 清洗后的单一 URL
 */
function sanitizeUrl(urlStr) {
    if (!urlStr) return '';
    let clean = String(urlStr).split(MERGE_DELIMITER)[0].trim();
    if (clean.startsWith('//')) return 'https:' + clean;
    const match = clean.match(/^([^:]+):(.+)$/);
    if (match) {
        const prefix = match[1].toLowerCase();
        const body   = match[2];
        if (prefix === 'http' || prefix === 'https') return clean;
        if (/^https?:\/\//i.test(body)) return body;
        if (body.startsWith('//')) return 'https:' + body;
        return body;
    }
    return clean;
}

/**
 * 解析日期字符串，提取年份与月份
 * 防御性处理：Year > 2030 或非法日期均视为无效（返回 null）
 * @param {string} dateStr - 日期字符串（ISO 格式或类似）
 * @returns {{year: number|null, month: number|null}}
 */
function parseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return { year: null, month: null };
    const d    = new Date(dateStr);
    const time = d.getTime();
    if (isNaN(time)) return { year: null, month: null };
    const year = d.getFullYear();
    if (year > 2030) return { year: null, month: null };
    return { year: year, month: d.getMonth() + 1 };
}


// ==============================================================================
// [L5] 相似度计算引擎 (Similarity Engine)
// ==============================================================================

/**
 * 计算编辑距离 (Levenshtein Distance)
 * 空间复杂度优化为 O(min(m,n))，使用滚动数组替代完整矩阵
 * @param {string} s1
 * @param {string} s2
 * @returns {number} 最小编辑操作次数
 */
function editDistance(s1, s2) {
    const len1 = s1.length, len2 = s2.length;
    if (len1 === 0) return len2;
    if (len2 === 0) return len1;
    let prevRow = new Array(len2 + 1);
    let currRow = new Array(len2 + 1);
    for (let j = 0; j <= len2; j++) prevRow[j] = j;
    for (let i = 1; i <= len1; i++) {
        currRow[0] = i;
        const char1 = s1.charCodeAt(i - 1);
        for (let j = 1; j <= len2; j++) {
            const cost = char1 === s2.charCodeAt(j - 1) ? 0 : 1;
            currRow[j] = Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost);
        }
        // 交换行引用，避免重新分配内存
        const temp = prevRow; prevRow = currRow; currRow = temp;
    }
    return prevRow[len2];
}

/**
 * 计算 Dice 相似度系数
 * 对语序不敏感，适用于词组相同但排列不同的情况（如"进击的巨人" vs "巨人的进击"）
 * @param {string} s1
 * @param {string} s2
 * @returns {number} 相似度 [0.0, 1.0]
 */
function calculateDiceSimilarity(s1, s2) {
    if (!s1 || !s2) return 0;
    const set1 = new Set(s1.replace(RegexStore.Clean.WHITESPACE, ''));
    const set2 = new Set(s2.replace(RegexStore.Clean.WHITESPACE, ''));
    const size1 = set1.size, size2 = set2.size;
    if (size1 === 0 && size2 === 0) return 1.0;
    if (size1 === 0 || size2 === 0) return 0.0;
    let intersection = 0;
    const [smaller, larger] = size1 < size2 ? [set1, set2] : [set2, set1];
    for (const char of smaller) if (larger.has(char)) intersection++;
    return (2.0 * intersection) / (size1 + size2);
}

/**
 * 计算综合相似度 [0.0, 1.0]
 * 结合编辑距离、Dice 系数和覆盖系数三维度取最大值，
 * 解决长标题意译差异和包含关系等单维度算法覆盖不到的场景
 * @param {string} str1 - 原始标题 A（内部会调用 cleanTitleForSimilarity）
 * @param {string} str2 - 原始标题 B
 * @returns {number} 综合相似度
 */
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = cleanTitleForSimilarity(str1);
    const s2 = cleanTitleForSimilarity(str2);
    if (s1 === '' && s2 === '') return 0.0;
    if (s1 === s2) return 1.0;
    const len1 = s1.length, len2 = s2.length;
    const maxLen = Math.max(len1, len2), minLen = Math.min(len1, len2);
    // 包含关系特判：短字符串是长字符串子集时，给予高分（但有长度比例限制防误判）
    if (s1.includes(s2) || s2.includes(s1)) {
        const lenRatio = minLen / maxLen;
        if (lenRatio > 0.5) return 0.8 + (lenRatio * 0.2);
    }
    // 编辑距离评分
    const distance  = editDistance(s1, s2);
    const editScore = maxLen === 0 ? 1.0 : 1.0 - (distance / maxLen);
    // Dice 系数评分
    const set1 = new Set(s1.replace(RegexStore.Clean.WHITESPACE, ''));
    const set2 = new Set(s2.replace(RegexStore.Clean.WHITESPACE, ''));
    const size1 = set1.size, size2 = set2.size;
    if (size1 === 0 || size2 === 0) return 0.0;
    let intersection = 0;
    const [smallerSet, largerSet] = size1 < size2 ? [set1, set2] : [set2, set1];
    for (const char of smallerSet) if (largerSet.has(char)) intersection++;
    const diceScore = (2.0 * intersection) / (size1 + size2);
    // 覆盖系数评分（适合短标题被长标题包含的场景）
    let overlapScore = 0;
    const minSize = Math.min(size1, size2);
    if (minSize > 2) {
        overlapScore = intersection / minSize;
        if (overlapScore > 0.6) {
            // 惩罚长度差距过大的包含关系，防止误将相关但不同的作品合并
            const sizeRatio = minSize / Math.max(size1, size2);
            if (sizeRatio < 0.6) overlapScore -= 0.25;
        }
    }
    return Math.max(editScore, diceScore, overlapScore);
}


// ==============================================================================
// [L6] 领域属性提取层 (Domain Attribute Extraction)
// ==============================================================================

/**
 * 提取季数和类型标记
 * 核心逻辑：从主标题及别名列表中识别 S1/S2/MOVIE/SP/OVA/SEQUEL 等标记，
 * 并汇总去重。结果供季度冲突检测、合集探测、合集切片等多处复用
 * @param {string}        title    - 主标题
 * @param {string}        [typeDesc=''] - 类型描述字段
 * @param {Array<string>} [aliases=[]] - 别名列表
 * @returns {Set<string>} 标记集合，如 {'S1', 'MOVIE'} 或 {'S2', 'P1'}
 */
function extractSeasonMarkers(title, typeDesc = '', aliases = []) {
    const markers = new Set();
    const type    = cleanText(typeDesc || '');

    const processSingleTitle = (rawTitle) => {
        const t             = cleanText(normalizeTitleForEngine(rawTitle));
        const tWithoutParts = t.replace(RegexStore.Season.PART_ANY, '');

        // 1. 承转结字典映射（日系结构词）
        const structMatch = tWithoutParts.match(RegexStore.Season.CN_STRUCTURE);
        if (structMatch) {
            const charMap = { '承': 'S2', '转': 'S3', '结': 'S4' };
            if (charMap[structMatch[1]]) markers.add(charMap[structMatch[1]]);
        }

        // 2. 通用正则模式匹配（SEASON_PATTERNS 列表）
        SEASON_PATTERNS.forEach(p => {
            const match = (p.useCleaned ? tWithoutParts : t).match(p.regex);
            if (match) markers.add(p.prefix ? `${p.prefix}${parseInt(match[1])}` : p.val);
        });

        // 3. 特殊后缀硬映射（A's → S2 等）
        const hitSpecific = SUFFIX_SPECIFIC_MAP.some(item => {
            if (item.regex.test(tWithoutParts)) { markers.add(item.val); return true; }
        });

        // 4. 罗马数字/字母歧义标记字典映射（仅在未命中硬映射时执行）
        if (!hitSpecific) {
            const ambMatch = tWithoutParts.match(RegexStore.Season.SUFFIX_AMBIGUOUS);
            if (ambMatch) {
                markers.add('AMBIGUOUS');
                const sufMap = { 'II': 'S2', 'III': 'S3', 'IV': 'S4' };
                const suffix = ambMatch[1].toUpperCase();
                if (sufMap[suffix]) markers.add(sufMap[suffix]);
            }
        }

        // 5. 续篇与中文数字季度
        if (RegexStore.Season.SUFFIX_SEQUEL.test(t)) markers.add('SEQUEL');
        const cnNums = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, 'final': 99 };
        for (const [cn, num] of Object.entries(cnNums)) {
            if (t.includes(`第${cn}季`)) markers.add(`S${num}`);
        }
    };

    // 优雅合并主标题和别名并过滤空值，统一遍历处理
    [title, ...(Array.isArray(aliases) ? aliases : [])].filter(Boolean).forEach(processSingleTitle);

    // 利用类型描述字段作补充判断
    if (type.includes('续篇'))                        markers.add('SEQUEL');
    if (/(剧场版|movie|film|电影)/i.test(type))       markers.add('MOVIE');
    if (/\b(ova|oad)\b/i.test(type))                 markers.add('OVA');
    if (/\b(sp|special)\b/i.test(type))              markers.add('SP');

    // 默认值补偿：确保每个条目都有明确的季度/类型归属
    const mArr      = Array.from(markers);
    const hasSeason = mArr.some(m => m.startsWith('S'));
    const hasPart   = mArr.some(m => m.startsWith('P'));
    const isSpecial = ['MOVIE', 'OVA', 'SP', 'SEQUEL', 'AMBIGUOUS'].some(key => markers.has(key));
    if (hasPart && !hasSeason) markers.add('S1'); // Part 资源归属 S1
    if (!hasSeason && !hasPart && !isSpecial)     markers.add('S1'); // 默认 S1
    return markers;
}

/**
 * 辅助：从标题及别名中提取明确的季度编号 (1, 2, 3...)
 * 当存在多个季度标记时返回最大值（兼容双季合集）
 * @param {string}        title
 * @param {string}        [typeDesc='']
 * @param {Array<string>} [aliases=[]]
 * @returns {number|null} 季度编号，无法识别时返回 null
 */
function getSeasonNumber(title, typeDesc = '', aliases = []) {
    const markers  = extractSeasonMarkers(title, typeDesc, aliases);
    let maxSeason  = null;
    for (const m of markers) {
        if (m.startsWith('S')) {
            const num = parseInt(m.substring(1));
            if (!isNaN(num)) {
                if (maxSeason === null || num > maxSeason) maxSeason = num;
            }
        }
    }
    return maxSeason;
}

/**
 * 获取严格的媒体类型标识 (TV / MOVIE)
 * 基于标题和类型描述中的明确关键词判断，无歧义时才返回确切值
 * @param {string} title    - 标题
 * @param {string} typeDesc - 类型描述
 * @returns {'TV'|'MOVIE'|null} null 表示无法确定
 */
function getStrictMediaType(title, typeDesc) {
    const fullText = (title + ' ' + (typeDesc || '')).toLowerCase();
    const hasMovie = fullText.includes('电影');
    const hasTV    = fullText.includes('电视剧');
    if (hasMovie && !hasTV) return 'MOVIE';
    if (hasTV   && !hasMovie) return 'TV';
    return null;
}

/**
 * 获取内容分类 (ANIME / REAL / UNKNOWN)
 * 用于在合并前检测真人剧与动漫之间的类别冲突
 * @param {string} title    - 标题
 * @param {string} typeDesc - 类型描述
 * @param {string} source   - 来源名（animeko 来源直接判定为 ANIME）
 * @returns {'ANIME'|'REAL'|'UNKNOWN'}
 */
function getContentCategory(title, typeDesc, source) {
    if (source && RegexStore.Category.ANIMEKO_SOURCE.test(source)) return 'ANIME';
    const fullText = (title + ' ' + (typeDesc || '')).toLowerCase();
    if (RegexStore.Category.ANIME_KW.test(fullText)) return 'ANIME';
    if (RegexStore.Category.REAL_KW.test(fullText))  return 'REAL';
    return 'UNKNOWN';
}


// ==============================================================================
// [L7] 领域冲突检测层 (Domain Conflict Detection)
// ==============================================================================

/**
 * 检测主副标题结构冲突
 * 典型场景：主标题 "Title" vs 副标题 "Title: Subtitle"，
 * 后者是前者的延伸，而非独立的相同条目
 * @param {string}  titleA
 * @param {string}  titleB
 * @param {boolean} [isDateValid=true] - 日期是否有效（无效时判定更严格）
 * @returns {boolean} true = 存在冲突
 */
function checkTitleSubtitleConflict(titleA, titleB, isDateValid = true) {
    if (!titleA || !titleB) return false;
    if (cleanTitleForSimilarity(titleA) === cleanTitleForSimilarity(titleB)) return false;
    // 轻量清洗：只去除元数据标签，保留结构信息
    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str);
        s = s.replace(RegexStore.Clean.META_SUFFIX, '')
             .replace(RegexStore.Clean.YEAR_TAG,    '')
             .replace(RegexStore.Clean.SOURCE_TAG,  '')
             .replace(RegexStore.Clean.FROM_SUFFIX, '')
             .replace(RegexStore.Clean.WHITESPACE,  ' ');
        return s.trim().toLowerCase();
    };
    const t1 = lightClean(titleA), t2 = lightClean(titleB);
    if (t1 === t2) return false;
    const extractSubtitle = (fullTitle) => {
        const splitters = [':', '：', ' code:', ' code：', ' season', ' part'];
        for (const sep of splitters) {
            const idx = fullTitle.indexOf(sep);
            if (idx !== -1) return fullTitle.substring(idx).trim();
        }
        const spaceParts = fullTitle.split(RegexStore.Clean.WHITESPACE);
        if (spaceParts.length >= 2) return spaceParts.slice(1).join(' ');
        return null;
    };
    const sub1 = extractSubtitle(t1), sub2 = extractSubtitle(t2);
    const [short, long] = t1.length < t2.length ? [t1, t2] : [t2, t1];
    // 前缀包含关系检测
    if (long.startsWith(short)) {
        if (long.length === short.length) return false;
        const nextChar = long[short.length];
        if (RegexStore.Clean.SUBTITLE_SEPARATOR.test(nextChar)) {
            const subtitle = long.slice(short.length).replace(RegexStore.Clean.SUBTITLE_SEPARATOR, '').trim();
            if (!isDateValid && subtitle.length > 1) return true;
            if (subtitle.length > 2) return true;
        }
    }
    // 副标题相似度验证：两者副标题差异过大则视为冲突
    if (sub1 && sub2) {
        const sim = calculateDiceSimilarity(sub1, sub2);
        if (sim < 0.2) return true;
    }
    return false;
}

/**
 * 检查是否满足"剧场版"结构豁免条件
 * 防止包含 Part/Season 的标题被误判为普通剧场版，
 * 只有真正具有副标题结构的剧场版对才给予豁免
 * @param {string} titleA
 * @param {string} titleB
 * @param {string} typeDescA
 * @param {string} typeDescB
 * @returns {boolean} true = 允许豁免（忽略类型差异）
 */
function checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB) {
    const isTheatrical = (typeDescA || '').includes('剧场版') || (typeDescB || '').includes('剧场版');
    if (!isTheatrical) return false;
    const lightClean = (str) => {
        if (!str) return '';
        let s = simplized(str)
            .replace(RegexStore.Clean.YEAR_TAG,   '')
            .replace(RegexStore.Clean.SOURCE_TAG, '')
            .replace(RegexStore.Clean.FROM_SUFFIX,'');
        return s.trim();
    };
    const t1 = lightClean(titleA), t2 = lightClean(titleB);
    if (RegexStore.Clean.SPACE_STRUCTURE.test(t1) && RegexStore.Clean.SPACE_STRUCTURE.test(t2)) {
        const extractSub = (s) => {
            const parts = s.split(RegexStore.Clean.SPLIT_SPACES);
            return parts.length > 1 ? parts.slice(1).join(' ') : '';
        };
        const sub1 = extractSub(t1), sub2 = extractSub(t2);
        // Part/Season 结构的剧场版不予豁免
        if (RegexStore.Season.PURE_PART.test(sub1) || RegexStore.Season.PURE_PART.test(sub2)) return false;
        return true;
    }
    return false;
}

/**
 * 校验媒体类型是否冲突 (真人 vs 动漫, TV vs Movie, 3D vs 2D)
 * 包含维数通配符逻辑：无明确 3D/2D 标识的条目视为通配符，允许进行任何关联
 * @param {string}  titleA
 * @param {string}  titleB
 * @param {string}  typeDescA
 * @param {string}  typeDescB
 * @param {number}  countA     - 主源集数
 * @param {number}  countB     - 副源集数
 * @param {string}  [sourceA='']
 * @param {string}  [sourceB='']
 * @returns {boolean} true = 类型冲突，false = 兼容
 */
function checkMediaTypeMismatch(titleA, titleB, typeDescA, typeDescB, countA, countB, sourceA = '', sourceB = '') {
    const catA = getContentCategory(titleA, typeDescA, sourceA);
    const catB = getContentCategory(titleB, typeDescB, sourceB);
    // 动漫与真人剧绝对不兼容
    if ((catA === 'REAL' && catB === 'ANIME') || (catA === 'ANIME' && catB === 'REAL')) return true;

    // 提取明确的维数属性
    let is3DA = (typeDescA || '').includes('3D');
    let is3DB = (typeDescB || '').includes('3D');
    let is2DA = (typeDescA || '').includes('2D');
    let is2DB = (typeDescB || '').includes('2D');

    // 通配符状态判定：无维数标识视为通配符
    const isWildcardA = !is3DA && !is2DA;
    const isWildcardB = !is3DB && !is2DB;

    // 动态探测：仅当一方具备明确维数，另一方为通配符时，尝试从通配符方标题中提取维数
    if (!isWildcardA && isWildcardB) {
        if (/3[dD]/.test(titleB)) is3DB = true;
        else if (/2[dD]/.test(titleB)) is2DB = true;
    } else if (!isWildcardB && isWildcardA) {
        if (/3[dD]/.test(titleA)) is3DA = true;
        else if (/2[dD]/.test(titleA)) is2DA = true;
    }

    // 维数冲突校验：双方最终都具有确切维数时，才执行严格比对
    const finalHasDimA = is3DA || is2DA;
    const finalHasDimB = is3DB || is2DB;
    if (finalHasDimA && finalHasDimB && is3DA !== is3DB) return true;

    // TV vs Movie 检测
    const mediaA = getStrictMediaType(titleA, typeDescA);
    const mediaB = getStrictMediaType(titleB, typeDescB);
    if (!mediaA || !mediaB || mediaA === mediaB) return false;
    // 剧场版结构豁免（如系列剧场版集数差异合理）
    if (checkTheatricalExemption(titleA, titleB, typeDescA, typeDescB)) return false;
    const hasValidCounts = countA > 0 && countB > 0;
    if (hasValidCounts) {
        const diff = Math.abs(countA - countB);
        if (diff > 5) return true;
        return false;
    }
    return true;
}

/**
 * 校验季度/续作标记是否冲突
 * 核心判断：两个条目的 Season Marker 集合是否互斥
 * 内置歧义标记（AMBIGUOUS）和续作标记（SEQUEL）的特殊处理逻辑
 * @param {string}        titleA
 * @param {string}        titleB
 * @param {string}        typeA
 * @param {string}        typeB
 * @param {Array<string>} [aliasesA=[]]
 * @param {Array<string>} [aliasesB=[]]
 * @returns {boolean} true = 季度冲突，false = 兼容
 */
function checkSeasonMismatch(titleA, titleB, typeA, typeB, aliasesA = [], aliasesB = []) {
    const markersA = extractSeasonMarkers(titleA, typeA, aliasesA);
    const markersB = extractSeasonMarkers(titleB, typeB, aliasesB);
    if (markersA.size === 0 && markersB.size === 0) return false;

    const hasS2OrMore = (set) => Array.from(set).some(m => m.startsWith('S') && parseInt(m.substring(1)) >= 2);
    const hasSequel   = (set) => set.has('SEQUEL');
    const hasAmbiguous= (set) => set.has('AMBIGUOUS');
    const hasS1       = (set) => set.has('S1');

    if (markersA.size > 0 && markersB.size > 0) {
        // 歧义标记与 S1 明确冲突
        if ((hasAmbiguous(markersA) && hasS1(markersB)) || (hasAmbiguous(markersB) && hasS1(markersA))) return true;
        // 歧义标记与 S2+ 或 SEQUEL 兼容（歧义本身可能就是续作）
        if ((hasAmbiguous(markersA) && (hasS2OrMore(markersB) || hasSequel(markersB))) ||
            (hasAmbiguous(markersB) && (hasS2OrMore(markersA) || hasSequel(markersA)))) return false;
        // S2+ 与 SEQUEL 兼容（续作是 S2 的语义等价）
        if ((hasS2OrMore(markersA) && hasSequel(markersB)) || (hasS2OrMore(markersB) && hasSequel(markersA))) return false;
        // 严格季度编号比对
        for (const m of markersA) {
            if (m.startsWith('S')) {
                const hasSameS  = markersB.has(m);
                const bHasAnyS  = Array.from(markersB).some(b => b.startsWith('S'));
                if (!hasSameS && bHasAnyS) return true;
            }
        }
        return false;
    }

    // 标记集合大小不同时，尝试剧场版豁免
    if (markersA.size !== markersB.size) {
        if (checkTheatricalExemption(titleA, titleB, typeA, typeB)) return false;
        return true;
    }
    return false;
}

/**
 * 检查是否包含相同的季度标记
 * 用于日期严重不匹配时的豁免判断：季度精确命中时可以放宽年份限制
 * @param {string}        titleA
 * @param {string}        titleB
 * @param {string}        typeA
 * @param {string}        typeB
 * @param {Array<string>} [aliasesA=[]]
 * @param {Array<string>} [aliasesB=[]]
 * @returns {boolean}
 */
function hasSameSeasonMarker(titleA, titleB, typeA, typeB, aliasesA = [], aliasesB = []) {
    const markersA = extractSeasonMarkers(titleA, typeA, aliasesA);
    const markersB = extractSeasonMarkers(titleB, typeB, aliasesB);
    const seasonsA = Array.from(markersA).filter(m => m.startsWith('S'));
    const seasonsB = Array.from(markersB).filter(m => m.startsWith('S'));
    if (seasonsA.length > 0 && seasonsB.length > 0) return seasonsA.some(sa => seasonsB.includes(sa));
    return false;
}

/**
 * 校验日期匹配度，返回评分修正量
 * 配音版（isDub=true）允许 10 年误差（配音版发行晚于原版属正常现象）
 * @param {{year:number|null, month:number|null}} dateA
 * @param {{year:number|null, month:number|null}} dateB
 * @param {boolean} [isDub=false] - 是否为配音关系
 * @returns {number} 评分修正量（-1=严重不匹配, 0=中性, >0=奖励）
 */
function checkDateMatch(dateA, dateB, isDub = false) {
    if (!dateA.year || !dateB.year) return 0.05; // 日期未知给予小额默认分
    const yearDiff = dateA.year - dateB.year;
    if (yearDiff === 0) {
        if (dateA.month && dateB.month) {
            const monthDiff = Math.abs(dateA.month - dateB.month);
            if (monthDiff > 2) return 0;
            return monthDiff === 0 ? 0.2 : 0.1;
        }
        return 0.1;
    }
    const absDiff = Math.abs(yearDiff);
    if (isDub && absDiff <= 10) return 0; // 配音版年份误差豁免
    if (absDiff > 1) return -1;           // 年份差超过 1 年时严格惩罚
    return 0;
}

/**
 * 验证合并覆盖率
 * 防止剧场版误匹配 TV 版等低覆盖率情况（匹配上的集数占比过低则视为无效合并）
 * dandan/animeko 来源的集数元数据可信度高，直接放行
 * @param {number}  mergedCount    - 实际匹配上的集数
 * @param {number}  totalA         - 主源过滤后的集数
 * @param {number}  totalB         - 副源过滤后的集数
 * @param {string}  sourceA        - 主源名
 * @param {string}  sourceB        - 副源名
 * @param {boolean} [isAnyCollection=false] - 是否涉及合集
 * @returns {boolean} true = 覆盖率合法，允许合并
 */
function isMergeRatioValid(mergedCount, totalA, totalB, sourceA, sourceB, isAnyCollection = false) {
    // 高可信度源直接放行
    if (/^(dandan|animeko)$/i.test(sourceA) || /^(dandan|animeko)$/i.test(sourceB)) return true;
    if (isAnyCollection) {
        const minTotal = Math.min(totalA, totalB);
        if (minTotal > 0 && (mergedCount / minTotal) > 0.5) return true;
        if (mergedCount < 2) return false;
        return true;
    }
    const maxTotal = Math.max(totalA, totalB);
    if (maxTotal === 0) return false;
    const ratio = mergedCount / maxTotal;
    // 集数较多时（>5 集）要求至少 18% 的覆盖率
    if (maxTotal > 5 && ratio < 0.18) return false;
    return true;
}


// ==============================================================================
// [L8] 集数处理层 (Episode Processing)
// ==============================================================================

/**
 * 判断集标题是否属于特殊类型 (Opening / Ending / Interview / Bloopers)
 * 用于番外集的精确匹配，防止同名番外被映射到不同类型的番外
 * @param {string} title - 集标题
 * @returns {string|null} 类型标识或 null（表示不是特殊类型）
 */
function getSpecialEpisodeType(title) {
    if (!title) return null;
    const t = title.toLowerCase();
    if (t.includes('opening'))  return 'opening';
    if (t.includes('ending'))   return 'ending';
    if (t.includes('interview'))return 'interview';
    if (t.includes('bloopers')) return 'Bloopers';
    return null;
}

/**
 * 提取集数信息 (Episode Info Extraction)
 * 包含对 dandan/animeko 来源的特殊番外检测逻辑：
 * 这些来源的 S开头/C开头 标题在该源内就代表番外，不走通用正则
 * @param {string} title      - 集标题
 * @param {string} [sourceName=''] - 来源平台名称
 * @returns {{isMovie:boolean, num:number|null, isSpecial:boolean, isPV:boolean, season:number|null, isStrictSpecial:boolean}}
 */
function extractEpisodeInfo(title, sourceName = '') {
    let isStrictSpecial  = false;
    let effectiveSource  = sourceName;
    // 检测标题内嵌的来源标签（如 "【dandan】SP01"）
    if (title) {
        const tagMatch = title.match(RegexStore.Episode.DANDAN_TAG);
        if (tagMatch) effectiveSource = tagMatch[1].toLowerCase();
    }
    const isDandanOrAnimeko = /^(dandan|animeko)$/i.test(effectiveSource);
    if (isDandanOrAnimeko && title) {
        let rawTemp = title
            .replace(RegexStore.Clean.SOURCE_TAG,  '')
            .replace(RegexStore.Clean.FROM_SUFFIX, '')
            .trim();
        // dandan/animeko 来源中，S开头或 dandan 专属格式直接标记为严格番外
        if (RegexStore.Episode.SPECIAL_START.test(rawTemp) || RegexStore.Episode.DANDAN_IGNORE.test(rawTemp)) {
            isStrictSpecial = true;
        }
    }
    const t           = cleanText(title || '');
    const isMovie     = RegexStore.Episode.MOVIE_CHECK.test(t);
    const isPV        = RegexStore.Episode.PV_CHECK.test(t);
    let num    = null, season = null;
    const specialTypeTag = getSpecialEpisodeType(title);
    const isSpecial      = isPV || isStrictSpecial || !!specialTypeTag || RegexStore.Episode.SPECIAL_CHECK.test(t);
    // 季度编号提取
    const seasonMatch = t.match(RegexStore.Episode.SEASON_MATCH);
    if (seasonMatch) season = parseInt(seasonMatch[1]);
    // 集数提取：策略 A（含季度+集数）> 策略 B（强前缀）> 策略 C（弱前缀）
    const seasonEpMatch = t.match(RegexStore.Episode.NUM_STRATEGY_A);
    if (seasonEpMatch) {
        num = parseFloat(seasonEpMatch[2]);
    } else {
        const strongPrefixMatch = t.match(RegexStore.Episode.NUM_STRATEGY_B);
        if (strongPrefixMatch) {
            num = parseFloat(strongPrefixMatch[1]);
        } else {
            const weakPrefixMatch = t.match(RegexStore.Episode.NUM_STRATEGY_C);
            if (weakPrefixMatch) num = parseFloat(weakPrefixMatch[1]);
        }
    }
    return { isMovie, num, isSpecial, isPV, season, isStrictSpecial };
}

/**
 * 过滤无效剧集（基于标题正则）
 * 特定高置信度来源跳过正则过滤，防止常规集数因命中全局正则而丢失
 * @param {Array}   links       - 集数对象列表
 * @param {RegExp}  filterRegex - 过滤正则（null 则跳过过滤）
 * @param {string}  [sourceName=''] - 来源平台名称
 * @returns {Array<{link:Object, originalIndex:number}>} 携带原始索引的过滤后列表
 */
function filterEpisodes(links, filterRegex, sourceName = '') {
    if (!links) return [];
    // 白名单来源：集标题比较规范，免除正则拦截
    const skipFilterSources = ['animeko', 'bilibili', 'bilibili1', 'bahamut', 'dandan'];
    const shouldSkipFilter  = skipFilterSources.includes(sourceName);
    if (!filterRegex || shouldSkipFilter) {
        return links.map((link, index) => ({ link, originalIndex: index }));
    }
    const validLinks    = [];
    const droppedTitles = [];
    links.forEach((link, index) => {
        const title = link.title || link.name || '';
        if (filterRegex.test(title)) {
            droppedTitles.push(title);
        } else {
            validLinks.push({ link, originalIndex: index });
        }
    });
    // 集中输出被过滤的条目日志，便于排查误过滤
    if (droppedTitles.length > 0) {
        const sourcePrefix = sourceName ? `[${sourceName}] ` : '';
        log("info", `[Merge-Check] ${sourcePrefix}命中EPISODE_TITLE_FILTER过滤，已前置剔除 ${droppedTitles.length} 集: ${droppedTitles.join(', ')}`);
    }
    return validLinks;
}

/**
 * [性能优化] 冗余标题正则缓存
 * 避免在 identifyRedundantTitle 的循环中重复编译完全相同的来源名正则
 * @type {Map<string, RegExp>}
 */
const _redundantTitleRegexCache = new Map();

/**
 * 识别并提取冗余的系列标题前缀
 * 典型场景：所有集标题均以 "Series Title : " 开头，
 * 则该前缀是冗余的，对齐算法应在去除它后再比较
 * @param {Array<{link:Object}|Object>} links      - 集数列表（支持带 link 包装的格式）
 * @param {string}                      seriesTitle - 所属系列标题（用于锚定验证）
 * @param {string}                      sourceName  - 来源名（用于过滤来源标签）
 * @returns {string} 冗余前缀（空字符串表示无冗余）
 */
function identifyRedundantTitle(links, seriesTitle, sourceName) {
    if (!links || links.length < 2 || !seriesTitle) return '';
    const cleanSource = (text) => {
        if (!text || !sourceName) return text || '';
        try {
            let regex = _redundantTitleRegexCache.get(sourceName);
            if (!regex) {
                const escapedSource = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`(\\[|【|\\s)?${escapedSource}(\\]|】|\\s)?`, 'gi');
                _redundantTitleRegexCache.set(sourceName, regex);
            }
            return text.replace(regex, '').trim();
        } catch (e) { return text; }
    };
    let cleanSeriesTitle = cleanSource(seriesTitle);
    const separatorMatch = cleanSeriesTitle.match(RegexStore.Clean.REDUNDANT_SEPARATOR);
    if (separatorMatch) cleanSeriesTitle = cleanSeriesTitle.substring(0, separatorMatch.index);
    const titles = links.map(item => {
        const realLink = item.link || item;
        if (!realLink) return '';
        return cleanSource(realLink.title || realLink.name || '');
    });
    if (titles.some(t => !t)) return '';
    // 求最长公共子串 (LCS) - O(n²) 实现，集数列表通常不超过数十条
    const getLCS = (s1, s2) => {
        let maxSub = '';
        for (let i = 0; i < s1.length; i++) {
            for (let j = i + 1; j <= s1.length; j++) {
                const sub = s1.substring(i, j);
                if (s2.includes(sub) && sub.length > maxSub.length) maxSub = sub;
            }
        }
        return maxSub;
    };
    let common = getLCS(titles[0], titles[1]);
    if (common.length < 2) return '';
    for (let i = 2; i < titles.length; i++) {
        common = getLCS(common, titles[i]);
        if (common.length < 2) return '';
    }
    // 使用系列标题作为锚点验证：公共子串必须是系列标题的前缀
    const validatedRedundant = getLCS(common, cleanSeriesTitle);
    if (!cleanSeriesTitle.startsWith(validatedRedundant)) return '';
    // 防御：若候选冗余串以不安全字符结尾，尝试裁剪
    if (RegexStore.Clean.REDUNDANT_UNSAFE_END.test(validatedRedundant)) {
        const trimmed = validatedRedundant.slice(0, -1).trim();
        if (trimmed.length >= 2 && cleanSeriesTitle.startsWith(trimmed)) return trimmed;
        return '';
    }
    if (validatedRedundant.length >= 2) {
        if (RegexStore.Clean.REDUNDANT_VALID_CHARS.test(validatedRedundant) || validatedRedundant.length > 3) {
            log("info", `[Merge-Check] 检测到集内冗余标题字段: "${validatedRedundant}" (已忽略来源: ${sourceName}, 锚定验证通过)`);
            return validatedRedundant;
        }
    }
    return '';
}

/**
 * 获取列表中的"中间插值"小数集数（如 12.5）
 * 这类集数通常是番外回或特别版，若出现在正片序列中间会破坏偏移算法，
 * 需要识别后由 sinkDecimalEpisodes 沉至列表末尾
 * @param {Array}  links  - 集数列表
 * @param {string} source - 来源名
 * @returns {Set<number>} 需要沉底的小数集数集合
 */
function getDecimalEpisodes(links, source) {
    const decimals = new Set();
    if (!links) return decimals;
    let lastIntegerIndex = -1;
    // 先找到最后一个整数正片的索引，只有在它之前的小数集才算"中间插值"
    for (let i = 0; i < links.length; i++) {
        const title = links[i].title || links[i].name || '';
        const info  = extractEpisodeInfo(title, source);
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 === 0) lastIntegerIndex = i;
    }
    links.forEach((l, i) => {
        const title = l.title || l.name || '';
        const info  = extractEpisodeInfo(title, source);
        if (info.num !== null && !info.isSpecial && !info.isPV && info.num % 1 !== 0) {
            if (i < lastIntegerIndex) decimals.add(info.num);
        }
    });
    return decimals;
}

/**
 * 将指定的小数集数沉底（移动到列表末尾）
 * [性能优化] 使用原位修改（links.length = 0; links.push(...)）避免引用丢失
 * @param {Array}      links      - 集数列表（将被原地修改）
 * @param {Set<number>}numsToSink - 需要沉底的集数编号集合
 * @param {string}     source     - 来源名
 * @param {string}     sideName   - 日志显示的侧边名（如"主源:dandan"）
 */
function sinkDecimalEpisodes(links, numsToSink, source, sideName) {
    const normals = [], sinkers = [];
    let movedCount = 0;
    links.forEach(link => {
        const title  = link.title || link.name || '';
        const info   = extractEpisodeInfo(title, source);
        const isTarget = info.num !== null && numsToSink.has(info.num);
        if (isTarget) { sinkers.push(link); movedCount++; }
        else normals.push(link);
    });
    if (movedCount > 0) {
        // 原位修改，保持外部引用有效
        links.length = 0;
        links.push(...normals, ...sinkers);
        log("info", `[Merge-Check] [${sideName}] 自动沉底: 移动了 ${movedCount} 个中间插值集数 (${Array.from(numsToSink).join(',')}) 到末尾`);
    }
}

/**
 * 寻找最佳对齐偏移量 (Best Alignment Offset)
 *
 * 算法核心：遍历所有可能的 offset 值，对每个 offset 计算：
 *   - 配对集数的文本相似度（加权）
 *   - 数字匹配度（集数一致性）
 *   - 季度偏移的规律性
 *   - 零偏移奖励
 * 取总分最高的 offset 作为最终结果
 *
 * @param {Array}  primaryLinks         - 主源过滤后的集数列表
 * @param {Array}  secondaryLinks       - 副源过滤后的集数列表
 * @param {string} [seriesLangA='Unspecified'] - 主源系列语言
 * @param {string} [seriesLangB='Unspecified'] - 副源系列语言
 * @param {string} [sourceA='']         - 主源名
 * @param {string} [sourceB='']         - 副源名
 * @param {string} [primarySeriesTitle='']   - 主源系列标题（用于冗余前缀识别）
 * @param {string} [secondarySeriesTitle=''] - 副源系列标题
 * @returns {number} 最佳偏移量（0 表示无需对齐）
 */
function findBestAlignmentOffset(
    primaryLinks, secondaryLinks,
    seriesLangA = 'Unspecified', seriesLangB = 'Unspecified',
    sourceA = '', sourceB = '',
    primarySeriesTitle = '', secondarySeriesTitle = ''
) {
    if (primaryLinks.length === 0 || secondaryLinks.length === 0) return 0;

    const redundantA = identifyRedundantTitle(primaryLinks, primarySeriesTitle, sourceA);
    const redundantB = identifyRedundantTitle(secondaryLinks, secondarySeriesTitle, sourceB);

    const getTempTitle = (rawTitle, redundantStr) => {
        if (!rawTitle) return '';
        if (redundantStr && rawTitle.includes(redundantStr)) return rawTitle.replace(redundantStr, '');
        return rawTitle;
    };

    // 预处理每条集数的完整元数据，避免在双重循环中重复计算
    const processLink = (item, source, seriesLang, red) => {
        const rawTitle    = item.link.title || '';
        const cleanTitle  = getTempTitle(rawTitle, red);
        const info        = extractEpisodeInfo(cleanTitle, source);
        const epLang      = getLanguageType(cleanTitle);
        const effLang     = epLang !== 'Unspecified' ? epLang : seriesLang;
        // dandan/animeko 来源无语言标识时默认为日语
        const finalLang   = (effLang === 'Unspecified' && /^(dandan|animeko)$/i.test(source)) ? 'JP' : effLang;
        const cleanEpText = cleanEpisodeText(cleanTitle);
        // 中文严格匹配所需的核心词（去除所有数字和结构标记）
        const strictCnCore = (finalLang === 'CN') ? cleanTitle.replace(RegexStore.Similarity.CN_STRICT_CORE_REMOVE, '') : null;
        return { info, effLang: finalLang, specialType: getSpecialEpisodeType(cleanTitle), cleanEpText, strictCnCore };
    };

    const pInfos = primaryLinks.map(item   => processLink(item, sourceA, seriesLangA, redundantA));
    const sInfos = secondaryLinks.map(item => processLink(item, sourceB, seriesLangB, redundantB));

    // 计算季度偏移（最小正片集数之差），用于快速定位搜索范围中心
    let minNormalA = null, minNormalB = null;
    pInfos.forEach(({ info }) => {
        if (info.num !== null && !info.isSpecial && info.num % 1 === 0)
            minNormalA = minNormalA === null ? info.num : Math.min(minNormalA, info.num);
    });
    sInfos.forEach(({ info }) => {
        if (info.num !== null && !info.isSpecial && info.num % 1 === 0)
            minNormalB = minNormalB === null ? info.num : Math.min(minNormalB, info.num);
    });
    const seasonShift = (minNormalA !== null && minNormalB !== null) ? (minNormalA - minNormalB) : null;

    // 动态计算搜索范围，以估算的季度偏移为中心向外延伸
    const baseRange  = 15;
    const targetShift = (seasonShift !== null) ? -seasonShift : 0;
    const safeMin    = Math.max(Math.min(-baseRange, targetShift - baseRange), -Math.max(primaryLinks.length, secondaryLinks.length));
    const safeMax    = Math.min(Math.max(baseRange,  targetShift + baseRange),  Math.max(primaryLinks.length, secondaryLinks.length));

    let bestOffset = 0, maxScore = -9999;

    for (let offset = safeMin; offset <= safeMax; offset++) {
        let totalTextScore = 0, rawTextScoreSum = 0, matchCount = 0;
        let numericDiffs = new Map();
        let hasSeasonShiftMatch = false;
        let lastPNumLocal = null;

        for (let i = 0; i < secondaryLinks.length; i++) {
            const pIndex = i + offset;
            if (pIndex < 0 || pIndex >= primaryLinks.length) continue;

            const dataA = pInfos[pIndex], dataB = sInfos[i];
            const infoA = dataA.info,     infoB = dataB.info;
            let pairScore = 0;

            // ── 类型判断 ──────────────────────────────────────────────
            if (infoA.isMovie !== infoB.isMovie)
                pairScore += MergeWeights.EP_ALIGN.MOVIE_TYPE_MISMATCH;
            if ((infoA.isStrictSpecial && !infoB.isSpecial) || (infoB.isStrictSpecial && !infoA.isSpecial))
                pairScore += MergeWeights.EP_ALIGN.SPECIAL_STRICT_MISMATCH;

            // ── 语言对齐 ──────────────────────────────────────────────
            const normLangA = dataA.effLang === 'Unspecified' ? 'JP' : dataA.effLang;
            const normLangB = dataB.effLang === 'Unspecified' ? 'JP' : dataB.effLang;
            if (normLangA === normLangB) pairScore += MergeWeights.EP_ALIGN.LANG_MATCH;
            else                         pairScore += MergeWeights.EP_ALIGN.LANG_MISMATCH;

            // ── 季度编号 & 特殊类型 ───────────────────────────────────
            if (infoA.season !== null && infoB.season !== null && infoA.season !== infoB.season)
                pairScore += MergeWeights.EP_ALIGN.SEASON_NUM_MISMATCH;
            if (dataA.specialType || dataB.specialType) {
                if (dataA.specialType !== dataB.specialType) pairScore += MergeWeights.EP_ALIGN.SPECIAL_TYPE_MISMATCH;
                else                                          pairScore += MergeWeights.EP_ALIGN.SPECIAL_TYPE_MATCH;
            }
            if (infoA.isSpecial === infoB.isSpecial) pairScore += MergeWeights.EP_ALIGN.IS_SPECIAL_MATCH;

            // ── 季度偏移精确匹配奖励 ──────────────────────────────────
            if (seasonShift !== null && !infoA.isSpecial && !infoB.isSpecial) {
                if ((infoA.num - infoB.num) === seasonShift) {
                    pairScore += MergeWeights.EP_ALIGN.SEASON_SHIFT_EXACT;
                    hasSeasonShiftMatch = true;
                }
            }

            // ── 文本相似度（核心评分） ────────────────────────────────
            let sim = 0;
            if (dataA.effLang === 'CN' && dataB.effLang === 'CN' && dataA.strictCnCore && dataB.strictCnCore) {
                // 中文严格模式：核心词包含关系 + 集数一致性双重验证
                if (dataA.strictCnCore.includes(dataB.strictCnCore) || dataB.strictCnCore.includes(dataA.strictCnCore)) {
                    sim = (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num)
                        ? MergeWeights.EP_ALIGN.CN_STRICT_MATCH
                        : MergeWeights.EP_ALIGN.CN_STRICT_MISMATCH;
                } else {
                    sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
                }
            } else {
                sim = calculateSimilarity(dataA.cleanEpText, dataB.cleanEpText);
            }
            pairScore += sim;
            rawTextScoreSum += sim;

            // ── 数字严格相等奖励 ──────────────────────────────────────
            if (infoA.num !== null && infoB.num !== null && infoA.num === infoB.num)
                pairScore += MergeWeights.EP_ALIGN.NUMERIC_MATCH;

            // ── 断层惩罚（防异构/占位区污染） ─────────────────────────
            let weightMultiplier = 1.0;
            if (infoA.num !== null && !infoA.isSpecial) {
                if (lastPNumLocal !== null && (infoA.num - lastPNumLocal > 1)) {
                    // 主源集数跳跃，说明此段匹配可信度低
                    weightMultiplier = 0.1;
                } else {
                    lastPNumLocal = infoA.num;
                }
            }
            pairScore       *= weightMultiplier;
            sim             *= weightMultiplier;
            rawTextScoreSum += sim;
            totalTextScore  += pairScore;

            // ── 数字差分布统计（支持规律性检测） ─────────────────────
            if (infoA.num !== null && infoB.num !== null) {
                const diffKey = (infoB.num - infoA.num).toFixed(4);
                numericDiffs.set(diffKey, (numericDiffs.get(diffKey) || 0) + weightMultiplier);
            }
            matchCount++;
        }

        if (matchCount > 0) {
            let finalScore = totalTextScore / matchCount;
            // 规律性奖励：数字差分布高度集中时，说明偏移有意义
            let maxFrequency = 0;
            for (const count of numericDiffs.values()) maxFrequency = Math.max(maxFrequency, count);
            const consistencyRatio = maxFrequency / matchCount;
            const avgRawTextScore  = rawTextScoreSum / matchCount;
            if (consistencyRatio > 0.6) {
                if (hasSeasonShiftMatch || avgRawTextScore > 0.33) finalScore += MergeWeights.EP_ALIGN.PATTERN_CONSISTENCY_BONUS;
            }
            // 匹配数量规模奖励（对齐对越多越可信）
            finalScore += Math.min(matchCount * 0.15, 1.5);
            // 零偏移奖励：偏移为 0 说明主副源集数完全对齐，是最理想情况
            const zeroDiffCount = numericDiffs.get('0.0000') || 0;
            if (zeroDiffCount > 3) {
                finalScore += MergeWeights.EP_ALIGN.ZERO_DIFF_BONUS_BASE;
                finalScore += zeroDiffCount * MergeWeights.EP_ALIGN.ZERO_DIFF_BONUS_PER_HIT;
            } else if (zeroDiffCount > 0) {
                finalScore += zeroDiffCount * 2.0;
            }
            if (finalScore > maxScore) { maxScore = finalScore; bestOffset = offset; }
        }
    }

    return maxScore > 0.3 ? bestOffset : 0;
}

/**
 * 构建季度集数地图 (Season Length Map)
 * 采用众数（Mode）策略：同季度中出票最多的集数即为该季度的标准集数，
 * 并增加严格的媒体类型过滤（排除真人剧和电影），防止异构资源污染统计
 * 结果用于合集切片推断
 * @param {Array}  allGroupAnimes     - 当前分组内所有可能同名动画
 * @param {RegExp} epFilter            - 集数过滤正则
 * @param {Set}    collectionAnimeIds  - 合集 ID 集合（合集自身跳过，避免循环依赖）
 * @returns {Map<number, number>} 季数 → 集数的映射
 */
function buildSeasonLengthMap(allGroupAnimes, epFilter, collectionAnimeIds) {
    // 结构: Map<seasonNum, Map<count, Array<sourceName>>>
    // 含义: S1 → { 11集: ['dandan', 'animeko'], 8集: ['renren'] }
    const seasonStats = new Map();
    const debugLogs   = [];

    for (const anime of allGroupAnimes) {
        // 跳过合集自身（避免合集的总集数污染单季统计）
        if (collectionAnimeIds && collectionAnimeIds.has(anime.animeId)) {
            // debugLogs.push(`   [跳过] [${anime.source}] ${anime.animeTitle} (自身是合集)`);
            continue;
        }
        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;

        // 类型过滤：严格剔除电影和真人剧（其集数会严重干扰 TV 季度地图）
        const category = getContentCategory(realAnime.animeTitle, realAnime.typeDescription, realAnime.source);
        if (category === 'REAL') {
            debugLogs.push(`   [剔除] [${realAnime.source}] ${realAnime.animeTitle} (类型: 真人剧/REAL)`);
            continue;
        }
        const mediaType = getStrictMediaType(realAnime.animeTitle, realAnime.typeDescription);
        if (mediaType === 'MOVIE') {
            debugLogs.push(`   [剔除] [${realAnime.source}] ${realAnime.animeTitle} (类型: 电影/MOVIE)`);
            continue;
        }

        const seasonNum = getSeasonNumber(realAnime.animeTitle, realAnime.typeDescription, realAnime.aliases);
        if (seasonNum !== null && realAnime.links) {
            const validLinks = filterEpisodes(realAnime.links, epFilter, realAnime.source).filter(item => {
                const title    = item.link.title || item.link.name || '';
                const cleanT   = cleanText(title);
                const rawTemp  = cleanT.replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
                // dandan/animeko 来源的番外过滤
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                    if (RegexStore.Episode.SPECIAL_CHECK.test(rawTemp) || RegexStore.Episode.DANDAN_IGNORE.test(rawTemp)) return false;
                }
                if (RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawTemp) || RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(title)) return false;
                return true;
            });
            const count = validLinks.length;
            if (count > 0) {
                if (!seasonStats.has(seasonNum)) seasonStats.set(seasonNum, new Map());
                const freqMap = seasonStats.get(seasonNum);
                if (!freqMap.has(count)) freqMap.set(count, []);
                freqMap.get(count).push(realAnime.source);
                debugLogs.push(`   [采纳] [${realAnime.source}] S${seasonNum} = ${count}集 ("${realAnime.animeTitle}")`);
            } else {
                debugLogs.push(`   [忽略] [${realAnime.source}] S${seasonNum} (有效集数为 0)`);
            }
        } else {
            // debugLogs.push(`   [忽略] [${realAnime.source}] ${realAnime.animeTitle} (未识别到季度编号)`);
        }
    }

    const seasonMap = new Map();
    const resultLogs = [];
    for (const [sNum, freqMap] of seasonStats.entries()) {
        let modeCount = 0, maxFreq = 0, contributors = [];
        // 众数策略：票数最多的集数胜出；票数相同时取较小值（保守估计）
        for (const [count, sources] of freqMap.entries()) {
            const freq = sources.length;
            if (freq > maxFreq) {
                maxFreq = freq; modeCount = count; contributors = sources;
            } else if (freq === maxFreq && count < modeCount) {
                modeCount = count; contributors = sources;
            }
        }
        seasonMap.set(sNum, modeCount);
        const statDetails = Array.from(freqMap.entries())
            .map(([cnt, srcs]) => `${cnt}集(x${srcs.length})[${srcs.join(',')}]`)
            .join(', ');
        resultLogs.push(`S${sNum}=${modeCount} (推断来源: ${contributors.join(',')} | 统计: ${statDetails})`);
    }
    if (debugLogs.length > 0 || resultLogs.length > 0) {
        log("info", `[Merge-Check] [Map-Build] 季度地图构建详情:\n${debugLogs.join('\n')}\n   => 最终判定: { ${resultLogs.join('; ')} }`);
    }
    return seasonMap;
}

/**
 * 生成安全的合并 ID
 * 将两个来源 ID 和盐值哈希为一个唯一的正整数 ID，
 * 范围 [1e9, 2e9)，避免与原始来源 ID 冲突
 * @param {string|number} id1
 * @param {string|number} id2
 * @param {string}        [salt=''] - 额外盐值（如 groupFingerprint）
 * @returns {number}
 */
function generateSafeMergedId(id1, id2, salt = '') {
    const str = `${id1}_${id2}_${salt}`;
    let hash  = 0;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i) | 0;
    return (Math.abs(hash) % 1000000000) + 1000000000;
}

/**
 * 创建合并后的新链接对象
 * 统一添加来源标签前缀，并确保 URL 包含来源名前缀（便于播放器路由）
 * @param {{link:Object, originalIndex:number}} item - 带原始索引的集数项
 * @param {string} sourceName - 来源名
 * @returns {{title:string, url:string, name:string}} 新链接对象
 */
function createNewLink(item, sourceName) {
    const rawLink  = item.link;
    const rawTitle = rawLink.title || rawLink.name || `Episode ${item.originalIndex + 1}`;
    let newUrl     = rawLink.url || '';
    if (newUrl) {
        newUrl = sanitizeUrl(newUrl);
        if (!/^https?:\/\//i.test(newUrl)) newUrl = `${sourceName}:${newUrl}`;
    }
    let displayTitle = rawTitle;
    if (!displayTitle.includes(`【${sourceName}】`)) displayTitle = `【${sourceName}】 ${displayTitle}`;
    return { title: displayTitle, url: newUrl, name: rawTitle };
}

/**
 * 智能拼接未匹配的集数（Orphan Stitching）
 * 对于副源中没有在主源找到对应位置的孤立集数，根据其相对位置分三类处理：
 *   - 头部（relativeIndex < 0）: 插入到主源头部
 *   - 尾部（超出主源范围的正片）: 追加到主源尾部
 *   - 特殊（其余情况）: 附加到列表末尾
 *
 * 关键逻辑：通过 lastPrimaryMainIndex 确定主源正片边界，
 * 防止副源的后续正片被错误插入到主源尾部番外（SP/OVA）的中间
 * @param {Object} derivedAnime - 正在构建的合并结果对象（links 会被修改）
 * @param {Array}  orphans      - 未匹配的副源集数列表
 * @param {string} sourceName   - 副源名称
 */
function stitchUnmatchedEpisodes(derivedAnime, orphans, sourceName) {
    if (!orphans || orphans.length === 0) return;
    const headList = [], tailList = [], specialList = [];
    const currentLen = derivedAnime.links.length;

    // 寻找主源最后一个正片的位置，作为追加边界
    let lastPrimaryMainIndex = -1;
    for (let i = currentLen - 1; i >= 0; i--) {
        const link  = derivedAnime.links[i];
        const title = link.title || link.name || '';
        const info  = extractEpisodeInfo(title, derivedAnime.source);
        if (!info.isSpecial && !info.isPV && !info.isStrictSpecial && info.num !== null) {
            lastPrimaryMainIndex = i;
            break;
        }
    }

    for (const item of orphans) {
        const relativeIdx    = item.relativeIndex;
        const isStrictSpecial= item.info && item.info.isStrictSpecial;
        const isOrphanMain   = item.info && !item.info.isSpecial && !item.info.isPV && !isStrictSpecial && item.info.num !== null;
        if (relativeIdx < 0 && !isStrictSpecial) {
            headList.push(item);
        } else if (
            (relativeIdx >= currentLen && !isStrictSpecial) ||
            (isOrphanMain && relativeIdx > lastPrimaryMainIndex)
        ) {
            tailList.push(item);
        } else {
            specialList.push(item);
        }
    }

    const addedLogs = [];
    const processList = (list, target, msg) => {
        if (list.length > 0) {
            list.sort((a, b) => a.originalIndex - b.originalIndex);
            target.push(...list.map(it => createNewLink(it, sourceName)));
            addedLogs.push(`   [补全-${msg}] 插入/追加 ${list.length} 集 (${list.map(i => i.link.title).join(', ')})`);
        }
    };

    if (headList.length > 0) {
        headList.sort((a, b) => a.originalIndex - b.originalIndex);
        derivedAnime.links.unshift(...headList.map(it => createNewLink(it, sourceName)));
        addedLogs.push(`   [补全-头部] 插入 ${headList.length} 集 (${headList.map(i => i.link.title).join(', ')})`);
    }
    processList(tailList,    derivedAnime.links, '尾部');
    processList(specialList, derivedAnime.links, '特殊');

    if (addedLogs.length > 0) log("info", `[Merge] [${sourceName}] 智能补全:\n${addedLogs.join('\n')}`);
}


// ==============================================================================
// [L9] 核心匹配层 (Core Matching)
// ==============================================================================

/**
 * 上下文感知续作检测
 * 扫描副源列表，找出"本列表中同时存在基础标题"的续作条目，
 * 形成 ID→BaseTitle 的映射，供 findSecondaryMatches 做上下文阻断
 * @param {Array}  secondaryList - 副源番剧列表
 * @returns {Map<string, string>} animeId → 对应的基础标题
 */
function detectPeerContextSequels(secondaryList) {
    const contextMap = new Map();
    if (!secondaryList || secondaryList.length < 2) return contextMap;

    const items = secondaryList.map(item => {
        const raw   = item.animeTitle || '';
        const clean = cleanText(raw)
            .replace(RegexStore.Clean.SOURCE_TAG,  '')
            .replace(RegexStore.Clean.FROM_SUFFIX, '')
            .trim();
        return { id: item.animeId, raw, clean };
    });

    const baseTitles = new Set(items.map(i => i.clean));
    for (const item of items) {
        let baseCandidate = null;
        // 优先尝试特殊后缀硬映射
        for (const mapItem of SUFFIX_SPECIFIC_MAP) {
            const m = item.clean.match(mapItem.regex);
            if (m) {
                baseCandidate = item.clean.replace(mapItem.regex, '').trim();
                break;
            }
        }
        // 回退到歧义后缀识别
        if (!baseCandidate) {
            const m = item.clean.match(RegexStore.Season.SUFFIX_AMBIGUOUS);
            if (m) {
                const suffix = m[1];
                if (item.clean.endsWith(suffix)) baseCandidate = item.clean.substring(0, item.clean.length - suffix.length).trim();
            }
        }
        if (baseCandidate && baseCandidate.length > 1 && baseTitles.has(baseCandidate)) {
            contextMap.set(String(item.id), baseCandidate);
            log("info", `[Merge-Check] 上下文感知: 判定 [${item.raw}] 为续作 (Base: "${baseCandidate}" 同时也存在于列表)`);
        }
    }
    return contextMap;
}

/**
 * 探测集内容匹配情况 (Content Probe)
 * 通过抽样对比集标题（最多 5 对），判断两个条目是否强匹配或强不匹配。
 * 该结果可覆盖标题相似度，作为最高优先级的辅助信号
 * @param {Object} primaryAnime   - 主源番剧对象
 * @param {Object} candidateAnime - 候选副源番剧对象
 * @returns {{isStrongMatch:boolean, isStrongMismatch:boolean}}
 */
function probeContentMatch(primaryAnime, candidateAnime) {
    const result = { isStrongMatch: false, isStrongMismatch: false };
    if (!primaryAnime.links || !candidateAnime.links)   return result;
    if (!primaryAnime.links.length || !candidateAnime.links.length) return result;

    // 计算正片集数（排除 PV/Special），用于覆盖率判断
    const countEpisodes = (links) => links.filter(l => {
        const t = (l.title || l.name || '').toLowerCase();
        return !RegexStore.Episode.PV_CHECK.test(t) && !RegexStore.Episode.SPECIAL_CHECK.test(t);
    }).length;
    const countP = countEpisodes(primaryAnime.links);
    const countS = countEpisodes(candidateAnime.links);
    if (countP > 5 && countS > 5) {
        const ratio = Math.min(countP, countS) / Math.max(countP, countS);
        if (ratio < 0.4) { /* 覆盖率过低，不做强判断，留给后续流程决定 */ }
    }

    // 提取并清洗集标题（去除数字，只保留语义词）
    const getEpTitles = (links) => links.map(l => {
        const t = cleanEpisodeText(l.title || l.name || '');
        return t.replace(/\d+/g, '').trim();
    }).filter(t => t.length > 1);

    const titlesP = getEpTitles(primaryAnime.links);
    const titlesS = getEpTitles(candidateAnime.links);
    if (titlesP.length < 3 || titlesS.length < 3) return result;

    // 语言必须一致且可识别才进行探测（避免中日文集标题误判）
    const langP = getLanguageType(titlesP.join(' '));
    const langS = getLanguageType(titlesS.join(' '));
    if (langP !== langS || langP === 'Unspecified') return result;

    // 均匀抽样，最多 5 对
    const sampleSize = Math.min(titlesP.length, titlesS.length, 5);
    let matchHits = 0, mismatchHits = 0;
    let logSamples = [];
    for (let i = 0; i < sampleSize; i++) {
        const idxP = Math.floor(i * titlesP.length / sampleSize);
        const idxS = Math.floor(i * titlesS.length / sampleSize);
        const sim  = calculateSimilarity(titlesP[idxP], titlesS[idxS]);
        if (i < 3) logSamples.push(`"${titlesP[idxP]}" vs "${titlesS[idxS]}" (${sim.toFixed(2)})`);
        if (sim > 0.6) matchHits++;
        else if (sim < 0.3) mismatchHits++;
    }
    if (matchHits >= Math.ceil(sampleSize * 0.6)) {
        result.isStrongMatch = true;
        log("info", `[Merge-Check] [Probe] 采样对比 (Match): ${logSamples.join(', ')}`);
    } else if (mismatchHits >= Math.ceil(sampleSize * 0.8)) {
        result.isStrongMismatch = true;
        log("info", `[Merge-Check] [Probe] 采样对比 (Mismatch): ${logSamples.join(', ')}`);
    }
    return result;
}

/**
 * 检测是否命中合并映射表中的强制特权规则 (Custom Merge Rule)
 * 采用“严格完全匹配”策略。优化了对比文本构建逻辑，防止误删带括号的标题。
 * 支持动态保留年份与元数据标签：只有当用户规则中显式声明了年份或标签时，才参与严格比对。
 * @param {Object} pAnime - 主源番剧对象
 * @param {Object} sAnime - 副源番剧对象
 * @returns {Object|null} 命中的规则对象，未命中返回 null
 */
function getMatchingCustomRule(pAnime, sAnime) {
    const rules = globals.customMergeRules || [];
    if (rules.length === 0) return null;

    const pSeason = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases);
    const sSeason = getSeasonNumber(sAnime.animeTitle, sAnime.typeDescription, sAnime.aliases);

    // 动态构建用于完全匹配的对比文本
    const buildComparable = (animeTitle, ruleTitle) => {
        let cleanAnime = simplized(animeTitle || '').toLowerCase().replace(RegexStore.Clean.FROM_SUFFIX, '');
        let cleanRule = simplized(ruleTitle || '').toLowerCase();

        const hasYearInRule = /[\(（\[]?\d{4}[\)）\]]?/.test(cleanRule);
        const hasTagsInRule = /【.*?】/.test(cleanRule) || /\[.*?\]/.test(cleanRule);

        // 1. 如果规则里没写年份，去掉标题中的年份标签
        if (!hasYearInRule) {
            cleanAnime = cleanAnime.replace(/[\(（\[]\d{4}[\)）\]]/g, '');
        }

        // 2. 处理【】或 [] 标签。
        // 如果规则没写标签，我们应该“提取”标题内容而不是盲目“删除”括号。
        if (!hasTagsInRule) {
            const startBracketMatch = cleanAnime.match(/^(?:【|\[)(.+?)(?:】|\])/);
            if (startBracketMatch) {
                const content = startBracketMatch[1];
                // 排除常见的纯类型标签，提取真实的剧名
                const typeKeywords = /^(TV|剧场版|劇場版|movie|film|anime|动漫|动画|电影|电视剧|连续剧|综艺|真人秀|纪录片|日剧|韩剧|美剧|英剧|泰剧|国产剧|港剧|台剧|短剧|微短剧|特摄|OVA|OAD|SP|AVC|HEVC|MP4|MKV)$/i;
                
                if (!typeKeywords.test(content)) {
                    cleanAnime = cleanAnime.replace(startBracketMatch[0], content + ' ');
                }
            }
            // 删掉剩余的纯元数据标签
            cleanAnime = cleanAnime.replace(RegexStore.Clean.SOURCE_TAG, '').replace(/\[.*?\]/g, '');
        }

        // 3. 剥离季度和类型噪声
        if (!cleanRule.includes('季') && !cleanRule.includes('season')) {
            cleanAnime = cleanAnime.replace(RegexStore.Season.INFO_STRONG, '');
        }
        cleanAnime = cleanAnime.replace(RegexStore.Clean.MOVIE_KEYWORDS, '');

        // 终极清洗：使用 common-util 的 normalizeSpaces 规范化所有标点与特殊符号
        return {
            target: normalizeSpaces(cleanAnime).replace(/\s+/g, ''),
            rule: normalizeSpaces(cleanRule).replace(/\s+/g, '')
        };
    };

    for (const rule of rules) {
        // 提取基础源(Base Source)，并使用已导入的 DISPLAY_CONNECTOR 常量
        const getBaseSource = (src) => String(src).split(DISPLAY_CONNECTOR)[0];
        const rulePBaseSource = getBaseSource(rule.primary.source);
        const ruleSBaseSource = getBaseSource(rule.secondary.source);

        // 支持主副源可能已经是拼接过的源（如 "bilibili&dandan"）
        const pSources = String(pAnime.source).split(DISPLAY_CONNECTOR);
        const sSources = String(sAnime.source).split(DISPLAY_CONNECTOR);

        // 校验来源是否符合 主->副 指向
        if (!pSources.includes(rulePBaseSource) || !sSources.includes(ruleSBaseSource)) continue;

        const pComp = buildComparable(pAnime.animeTitle, rule.primary.title);
        const sComp = buildComparable(sAnime.animeTitle, rule.secondary.title);

        // 严格完全匹配 (Exact Match)
        const isPTitleMatch = (pComp.target === pComp.rule);
        const isSTitleMatch = (sComp.target === sComp.rule);

        if (!isPTitleMatch || !isSTitleMatch) continue;

        // 季度精确校验
        if (rule.primary.season !== null && (pSeason || 1) !== rule.primary.season) continue;
        if (rule.secondary.season !== null && (sSeason || 1) !== rule.secondary.season) continue;

        return rule;
    }
    return null;
}

/**
 * 在副源列表中寻找最佳匹配的动画对象列表 (Main Matcher)
 * 完整匹配流程：
 *   0. 映射表特权检测（最高优先级：强制放行并标记，或直接 block 阻断）
 *   1. 上下文感知续作检测（阻断 S1 vs S2 的错误关联）
 *   2. 组级权限沙箱阻断（防范映射表动态源跨组污染常规匹配）
 *   3. 各类冲突检测（媒体类型、之字结构、剧场版、日期、季度）
 *   4. 主副别名交叉比对 + 综合相似度计算
 *   5. 集内容 Probe（可覆盖相似度）
 *   6. Tier 筛选（特权通道无条件豁免、中文优先、Part 宽松）
 *
 * @param {Object} primaryAnime        - 主源番剧对象
 * @param {Array}  secondaryList       - 副源列表（同源内）
 * @param {Set}    [collectionAnimeIds=new Set()] - 合集 ID 集合
 * @param {Array}  [baseSecondaries=[]] - 当前组的基础原生副源配置（用于权限沙箱）
 * @returns {Array} 通过筛选的候选对象数组（按分数降序）
 */
export function findSecondaryMatches(primaryAnime, secondaryList, collectionAnimeIds = new Set(), baseSecondaries = []) {
    if (!secondaryList || secondaryList.length === 0) return [];

    // [性能优化] 提取循环不变量，避免在内层循环中重复计算
    const rawPrimaryTitle    = primaryAnime.animeTitle || '';
    const primaryTitleForSim = rawPrimaryTitle.replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim();
    const isPrimaryDub       = !!(primaryTitleForSim.match(RegexStore.Lang.CN_DUB_VER)) || RegexStore.Lang.CN.test(primaryTitleForSim);
    const isPrimaryIgnoredYear = primaryAnime.source === 'hanjutv';
    const primaryDate        = (rawPrimaryTitle.includes('N/A') || isPrimaryIgnoredYear) ? { year: null, month: null } : parseDate(primaryAnime.startDate);
    const primaryCount       = primaryAnime.episodeCount || (primaryAnime.links ? primaryAnime.links.length : 0);
    const primaryLang        = getLanguageType(rawPrimaryTitle);
    const primaryCleanForZhi = cleanText(primaryTitleForSim);
    const cleanPrimarySim    = cleanTitleForSimilarity(primaryTitleForSim);
    const markersP           = extractSeasonMarkers(rawPrimaryTitle, primaryAnime.typeDescription, primaryAnime.aliases);
    const seasonsP           = Array.from(markersP).filter(m => m.startsWith('S'));

    // 上下文感知：将主源也加入列表，统一检测续作关系
    const combinedForContext       = [{ animeId: primaryAnime.animeId, animeTitle: rawPrimaryTitle }, ...secondaryList];
    const ambiguousSequelsMap      = detectPeerContextSequels(combinedForContext);
    const isPrimaryContextSequel   = ambiguousSequelsMap.has(String(primaryAnime.animeId));
    const primaryBaseTitleFromContext = ambiguousSequelsMap.get(String(primaryAnime.animeId));
    const isPrimaryCollection      = collectionAnimeIds.has(primaryAnime.animeId);

    // 结构化日志辅助函数
    const logReason = (secTitle, reason) => {
        log("info", `[Merge-Check] 拒绝: [${primaryAnime.source}] ${rawPrimaryTitle} vs [${secTitle}] -> ${reason}`);
    };

    let validCandidates = [];
    let maxScore        = 0;

    for (const secAnime of secondaryList) {
        const rawSecTitle     = secAnime.animeTitle || '';
        
        // 检查是否命中合并映射表中的强制特权规则
        const customRule = getMatchingCustomRule(primaryAnime, secAnime);
        if (customRule) {
            if (customRule.action === 'block') {
                logReason(rawSecTitle, `被映射表 [×] 明确禁止与主源合并`);
                continue;
            }

            const secLang = getLanguageType(rawSecTitle);
            // 注入 isCustomMapped 标识
            validCandidates.push({ 
                anime: secAnime, 
                score: 1.0, 
                lang: secLang, 
                debugTitle: rawSecTitle,
                isCustomMapped: true 
            });
            log("info", `[Merge-Check] 合并映射表特权放行: [${primaryAnime.source}] ${rawPrimaryTitle} <-> [${secAnime.source}] ${rawSecTitle}`);
            continue; // 命中特权规则直接跳过后续所有的之字结构、剧场版、维度冲突等检测
        }

        // 校验配对权限：动态注入的源若未命中特权规则，则阻断，防止跨组污染常规匹配。
        if (!baseSecondaries.includes(secAnime.source)) {
            logReason(rawSecTitle, `该来源为映射表动态注入，且未命中特权规则，受限于权限沙箱予以阻断`);
            continue;
        }

        const isSecCollection = collectionAnimeIds.has(secAnime.animeId);
        const isAnyCollection = isPrimaryCollection || isSecCollection;
        const isSecIgnoredYear= secAnime.source === 'hanjutv';
        const secDate         = (rawSecTitle.includes('N/A') || isSecIgnoredYear) ? { year: null, month: null } : parseDate(secAnime.startDate);
        const secLang         = getLanguageType(rawSecTitle);
        const secTitleForSim  = rawSecTitle.replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim();
        const isSecDub        = !!(secTitleForSim.match(RegexStore.Lang.CN_DUB_VER)) || RegexStore.Lang.CN.test(secTitleForSim);
        const isDubRelation   = isPrimaryDub || isSecDub;
        const secCount        = secAnime.episodeCount || (secAnime.links ? secAnime.links.length : 0);

        // ── 之字结构强阻断 ───────────────────────────────────────────────
        // "XX之续篇" 这类结构中，"XX" 是前缀父集，不应与 "XX" 本体合并
        if (secTitleForSim.includes('之')) {
            const parts  = secTitleForSim.split('之');
            const prefix = cleanText(parts[0]);
            if (primaryCleanForZhi === prefix) {
                logReason(rawSecTitle, `结构冲突: 主标题是副标题的前缀父集 (Prefix: "${prefix}")`);
                continue;
            }
        }

        // ── 媒体类型冲突检测 ─────────────────────────────────────────────
        if (checkMediaTypeMismatch(rawPrimaryTitle, rawSecTitle, primaryAnime.typeDescription, secAnime.typeDescription, primaryCount, secCount, primaryAnime.source, secAnime.source)) {
            const pType = getContentCategory(rawPrimaryTitle, primaryAnime.typeDescription, primaryAnime.source);
            const sType = getContentCategory(rawSecTitle,     secAnime.typeDescription,     secAnime.source);
            logReason(rawSecTitle, `媒体类型或维数不匹配 (P:${pType}/${getStrictMediaType(rawPrimaryTitle, primaryAnime.typeDescription)} [${primaryAnime.typeDescription}] vs S:${sType}/${getStrictMediaType(rawSecTitle, secAnime.typeDescription)} [${secAnime.typeDescription}])`);
            continue;
        }

        const isDateValid        = (primaryDate.year !== null && secDate.year !== null);
        const hasStructureConflict = checkTitleSubtitleConflict(rawPrimaryTitle, rawSecTitle, isDateValid);

        // ── 上下文续作阻断 ───────────────────────────────────────────────
        // 阻断 "Title S1" 与 "Title S2" 之间的误匹配（两者同时存在于列表中）
        const isAmbiguousSequel = ambiguousSequelsMap.has(String(secAnime.animeId));
        if (isAmbiguousSequel) {
            const baseTitleOfSec = ambiguousSequelsMap.get(String(secAnime.animeId));
            if (cleanPrimarySim === cleanTitleForSimilarity(baseTitleOfSec)) {
                const primaryHasSuffix = RegexStore.Season.SUFFIX_AMBIGUOUS.test(primaryCleanForZhi) ||
                                         SUFFIX_SPECIFIC_MAP.some(x => x.regex.test(primaryCleanForZhi));
                if (!primaryHasSuffix) {
                    logReason(rawSecTitle, `上下文阻断: 主源(S1) vs 副源(S2/S续作) (Base: "${baseTitleOfSec}")`);
                    continue;
                }
            }
        }
        if (isPrimaryContextSequel) {
            if (cleanTitleForSimilarity(secTitleForSim) === cleanTitleForSimilarity(primaryBaseTitleFromContext)) {
                logReason(rawSecTitle, `上下文阻断: 主源(S2/Sequel) vs 副源(Base/S1) (Base: "${primaryBaseTitleFromContext}")`);
                continue;
            }
        }

        if (!isDateValid && hasStructureConflict) {
            logReason(rawSecTitle, `标题结构冲突且日期无效`);
            continue;
        }

        const isSeasonExactMatch = hasSameSeasonMarker(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription, primaryAnime.aliases, secAnime.aliases);
        const contentProbe       = probeContentMatch(primaryAnime, secAnime);

        // ── 剧场版标题阻断 ───────────────────────────────────────────────
        // 防止 "Title Movie" 与 "Title (TV)" 因高相似度而误合并
        const hasMovieA = rawPrimaryTitle.search(RegexStore.Clean.MOVIE_KEYWORDS) !== -1;
        const hasMovieB = rawSecTitle.search(RegexStore.Clean.MOVIE_KEYWORDS) !== -1;
        if (hasMovieA !== hasMovieB) {
            const markersB  = extractSeasonMarkers(rawSecTitle, secAnime.typeDescription, secAnime.aliases);
            const stripMovie = (t) => cleanTitleForSimilarity(t.replace(RegexStore.Clean.MOVIE_KEYWORDS, ''));
            const cleanA    = stripMovie(rawPrimaryTitle);
            const cleanB    = stripMovie(rawSecTitle);
            if (calculateSimilarity(cleanA, cleanB) > 0.9) {
                if (!markersP.has('SEQUEL') && !markersB.has('SEQUEL')) {
                    logReason(rawSecTitle, `剧场版标题阻断: [${hasMovieA ? 'Movie' : 'TV'}] vs [${hasMovieB ? 'Movie' : 'TV'}] (无续篇标识)`);
                    continue;
                }
            }
        }

        // ── 日期匹配校验 ─────────────────────────────────────────────────
        const dateScore = isAnyCollection ? 0 : checkDateMatch(primaryDate, secDate, isDubRelation);
        if (dateScore === -1) {
            let allowExemption = isSeasonExactMatch;
            if (contentProbe.isStrongMatch) allowExemption = true;
            if (isAnyCollection) allowExemption = true;
            if (hasStructureConflict && !isAnyCollection) allowExemption = false;
            if (allowExemption && primaryDate.year && secDate.year) {
                const yearDiff = Math.abs(primaryDate.year - secDate.year);
                if (yearDiff > 2 && !contentProbe.isStrongMatch && !isAnyCollection) allowExemption = false;
            }
            if (!allowExemption) {
                logReason(rawSecTitle, `日期严重不匹配且无豁免 (P:${primaryDate.year} vs S:${secDate.year}, IsDub:${isDubRelation})`);
                continue;
            }
        }

        // ── 季度标记冲突校验 ─────────────────────────────────────────────
        if (!isAnyCollection && checkSeasonMismatch(primaryTitleForSim, secTitleForSim, primaryAnime.typeDescription, secAnime.typeDescription, primaryAnime.aliases, secAnime.aliases)) {
            if (contentProbe.isStrongMatch) {
                log("info", `[Merge-Check] 季度冲突豁免: [${rawPrimaryTitle}] vs [${rawSecTitle}] (Probe强匹配)`);
            } else {
                logReason(rawSecTitle, `季度标记冲突`);
                continue;
            }
        }

        // ── 主副别名交叉比对 ─────────────────────────────────────────────
        const cleanFn = t => t ? String(t).replace(RegexStore.Clean.YEAR_TAG, '').replace(/【(电影|电视剧)】/g, '').trim() : '';
        const primaryCandidates = Array.from(new Set([primaryTitleForSim, ...(primaryAnime.aliases || [])].map(cleanFn).filter(Boolean)));
        const secCandidates     = Array.from(new Set([secTitleForSim,     ...(secAnime.aliases     || [])].map(cleanFn).filter(Boolean)));

        // 主源候选池 × 副源候选池 全量交叉，取最高相似度
        let bestScoreFull = 0, bestScoreBase = 0;
        for (const pCand of primaryCandidates) {
            const pBase = removeParentheses(pCand);
            for (const sCand of secCandidates) {
                bestScoreFull = Math.max(bestScoreFull, calculateSimilarity(pCand, sCand));
                bestScoreBase = Math.max(bestScoreBase, calculateSimilarity(pBase, removeParentheses(sCand)));
            }
        }

        let score         = Math.max(bestScoreFull, bestScoreBase);
        const originalScore = score;

        // ── 评分修正 ─────────────────────────────────────────────────────
        if (hasStructureConflict)      score += MergeWeights.TITLE_STRUCTURE_CONFLICT;
        if (dateScore !== -1)          score += dateScore;
        const isPrimaryCn = (primaryLang === 'CN');
        const isSecCn     = (secLang     === 'CN');
        if (isPrimaryCn && isSecCn)    score += MergeWeights.LANG_MATCH_CN;
        else if (isPrimaryCn !== isSecCn) score += MergeWeights.LANG_MISMATCH;

        // ── Probe 覆盖逻辑 ──────────────────────────────────────────────
        if (contentProbe.isStrongMatch) {
            log("info", `[Merge-Check] 集内容探测: 强匹配! 提升分数 (原分: ${score.toFixed(2)}) -> ${Thresholds.SIMILARITY_STRONG}`);
            score = Math.max(score, Thresholds.SIMILARITY_STRONG);
        } else if (contentProbe.isStrongMismatch) {
            logReason(rawSecTitle, `集内容探测: 强不匹配 (集标题/内容差异巨大)`);
            score = 0;
        }

        // ── 阈值过滤 ─────────────────────────────────────────────────────
        if (score < Thresholds.SIMILARITY_MIN) {
            const cleanA = cleanPrimarySim;
            const cleanB = cleanTitleForSimilarity(secTitleForSim);
            logReason(rawSecTitle, `相似度不足: ${score.toFixed(2)} (Raw:${originalScore.toFixed(2)}, CleanA:"${cleanA}", CleanB:"${cleanB}")`);
        } else {
            if (score > maxScore) maxScore = score;
            validCandidates.push({ anime: secAnime, score, lang: secLang, debugTitle: rawSecTitle });
            log("info", `[Merge-Check] 候选选中: ${rawSecTitle} Score=${score.toFixed(2)} (BestSoFar=${maxScore.toFixed(2)})`);
        }
    }

    // 特权通道放行时，不比较 SIMILARITY_MIN
    if (validCandidates.length === 0 || (maxScore < Thresholds.SIMILARITY_MIN && !validCandidates.some(c => c.isCustomMapped))) return [];

    // ── Tier 筛选：梯度过滤，保留合理竞争者 ─────────────────────────────
    const finalResults = validCandidates.filter(candidate => {
        // 映射表特权通道无条件放行
        if (candidate.isCustomMapped) return true;

        // 精确匹配层（容差极小）
        if (candidate.score >= (maxScore - Thresholds.TIER_DEFAULT)) return true;
        // 中文优先层（CN 资源可宽松保留）
        if ((candidate.lang === 'CN') && (candidate.score >= (maxScore - Thresholds.TIER_CN))) return true;
        // Part 分部宽松层（分部资源与季度交集时可保留）
        const markersC = extractSeasonMarkers(candidate.debugTitle, candidate.anime.typeDescription, candidate.anime.aliases);
        const hasPart  = Array.from(markersC).some(m => m.startsWith('P'));
        if (hasPart && (candidate.score >= (maxScore - Thresholds.TIER_PART))) {
            const seasonsC = Array.from(markersC).filter(m => m.startsWith('S'));
            if (seasonsP.length > 0 && seasonsC.length > 0) {
                const hasIntersection = seasonsP.some(sp => seasonsC.includes(sp));
                if (hasIntersection) return true;
            } else return true; // 主源无明确季度时宽松保留
        }
        return false;
    });

    // 排序：特权置顶，其余按分数降序
    finalResults.sort((a, b) => {
        if (a.isCustomMapped && !b.isCustomMapped) return -1;
        if (!a.isCustomMapped && b.isCustomMapped) return 1;
        return b.score - a.score;
    });
    return finalResults.map(item => item.anime);
}


// ==============================================================================
// [L10] 合并业务流程层 (Merge Workflow)
// ==============================================================================

/**
 * 合集探测 (Collection Detection)
 * 识别包含多季内容的大合集资源（如"全集 S1+S2"），
 * 防止其与分季资源错误地以"集数互补"方式合并
 *
 * 判定逻辑：同分组内，若某来源的 S1 集数明显多于其他来源的 S1 集数
 * （且差值超过阈值），则视为合集
 * @param {Array} curAnimes - 当前待处理的番剧列表
 * @returns {Set} 判定为合集的 AnimeID 集合
 */
function detectCollectionCandidates(curAnimes) {
    const collectionIds = new Set();
    if (!curAnimes || curAnimes.length === 0) return collectionIds;

    const cnNums = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'};
    const groups = new Map();

    curAnimes.forEach(anime => {
        const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
        const markers   = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription, realAnime.aliases);
        // 电影/OVA/SP/SEQUEL 类型不参与合集探测（本身就是单集或特殊结构）
        if (markers.has('MOVIE') || markers.has('OVA') || markers.has('SP') || markers.has('SEQUEL')) return;

        // 标题标准化：提取前缀括号内容（如"【XX源】Title" → "Title"），转换中文数字季度
        let protectedTitle = simplized(anime.animeTitle || '');
        const startBracketMatch = protectedTitle.match(/^(?:【|\[)(.+?)(?:】|\])/);
        if (startBracketMatch) {
            const content = startBracketMatch[1];
            if (!/^(TV|剧场版|劇場版|movie|film|anime|动漫|动画|AVC|HEVC|MP4|MKV)$/i.test(content)) {
                protectedTitle = protectedTitle.replace(startBracketMatch[0], content + ' ');
            }
        }
        protectedTitle = protectedTitle.replace(/第([一二三四五六七八九十])季/g, (m, num) => `第${cnNums[num]}季`);

        // 去除所有元数据，只保留核心标题用作分组 key
        let clean = protectedTitle
            .replace(RegexStore.Clean.SOURCE_TAG,   '')
            .replace(RegexStore.Clean.FROM_SUFFIX,  '')
            .replace(RegexStore.Clean.YEAR_TAG,     '')
            .replace(RegexStore.Clean.META_SUFFIX,  '')
            .replace(RegexStore.Lang.KEYWORDS_STRONG,'');
        SUFFIX_SPECIFIC_MAP.forEach(m => clean = clean.replace(m.regex, ''));
        clean = clean
            .replace(RegexStore.Season.SUFFIX_AMBIGUOUS, '')
            .replace(/(?:第|S)\d+(?:季|期|部)/gi, '')
            .replace(/(?:Part|P)\s*\d+/gi, '')
            .replace(/\s+/g, '').toLowerCase().trim();
        if (!clean) return;

        const category = getContentCategory(anime.animeTitle, realAnime.typeDescription, realAnime.source);
        const groupKey = `${clean}|${category}`;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(anime);
    });

    for (const [groupKey, list] of groups.entries()) {
        if (list.length < 2) continue;
        const [baseTitle, category] = groupKey.split('|');
        const itemDetails = list.map(a => `   - [${a.source}] ${a.animeTitle}`).join('\n');
        log("info", `[Merge-Check] [合集探测] 正在检查分组: "${baseTitle}" [${category}] (包含 ${list.length} 个条目):\n${itemDetails}`);

        const sourceStats = new Map();
        let groupGlobalMaxSeason = 0;

        list.forEach(anime => {
            const realAnime = globals.animes.find(a => String(a.animeId) === String(anime.animeId)) || anime;
            const markers   = extractSeasonMarkers(realAnime.animeTitle, realAnime.typeDescription, realAnime.aliases);
            let seasonNum   = 1;
            for (const m of markers) {
                if (m.startsWith('S')) {
                    const num = parseInt(m.substring(1));
                    if (!isNaN(num)) seasonNum = num;
                }
            }
            // 续作/歧义后缀视为 S2，确保在对比时不被当作 S1 处理
            if (seasonNum === 1) {
                const isSequel    = markers.has('SEQUEL') || RegexStore.Season.SUFFIX_SEQUEL.test(realAnime.animeTitle);
                const isAmbiguous = markers.has('AMBIGUOUS') || RegexStore.Season.SUFFIX_AMBIGUOUS.test(realAnime.animeTitle);
                if (isSequel || isAmbiguous) {
                    seasonNum = 2;
                    log("info", `[Merge-Check] [Detail] [${realAnime.source}] "${realAnime.animeTitle}" -> 判定为 S2 (Reason: Sequel/Ambiguous Suffix)`);
                }
            }
            if (seasonNum > groupGlobalMaxSeason) groupGlobalMaxSeason = seasonNum;

            // 计算有效集数（dandan/animeko 来源需严格过滤番外）
            let validCount = 0;
            if (realAnime.links) {
                if (/^(dandan|animeko)$/i.test(realAnime.source)) {
                    validCount = realAnime.links.filter((l) => {
                        const rawTitle   = l.title || l.name || '';
                        const rawContent = rawTitle.replace(RegexStore.Clean.SOURCE_TAG, '').replace(RegexStore.Clean.FROM_SUFFIX, '').trim();
                        if (RegexStore.Episode.SPECIAL_CHECK.test(rawContent) || RegexStore.Episode.DANDAN_IGNORE.test(rawContent)) return false;
                        const t = cleanText(rawTitle);
                        if (RegexStore.Episode.SPECIAL_CHECK.test(t) || RegexStore.Episode.DANDAN_IGNORE.test(t)) return false;
                        if (RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawContent) || RegexStore.Episode.MAP_EXCLUDE_KEYWORDS.test(rawTitle)) return false;
                        return true;
                    }).length;
                } else {
                    validCount = realAnime.links.length;
                }
            }

            if (!sourceStats.has(realAnime.source)) sourceStats.set(realAnime.source, { seasonCounts: {}, maxSeason: 0, s1Candidates: [] });
            const stat = sourceStats.get(realAnime.source);
            if (!stat.seasonCounts[seasonNum]) stat.seasonCounts[seasonNum] = 0;
            // 取单季度的最大集数，避免多语言版本导致累加虚高
            stat.seasonCounts[seasonNum] = Math.max(stat.seasonCounts[seasonNum], validCount);
            if (seasonNum > stat.maxSeason) stat.maxSeason = seasonNum;
            if (seasonNum === 1) stat.s1Candidates.push({ anime: realAnime, originalCount: validCount });
        });

        // 只有当组内存在 S2+ 资源时，才有对比意义
        if (groupGlobalMaxSeason <= 1) continue;

        const allSources = Array.from(sourceStats.keys());
        for (const [source, stat] of sourceStats.entries()) {
            // 只检测 S1 资源（maxSeason === 1 意味着只有 S1 数据）
            if (stat.maxSeason > 1) continue;
            let maxOtherS1 = 0, hasOtherSources = false;
            for (const otherSource of allSources) {
                if (otherSource === source) continue;
                const otherStat = sourceStats.get(otherSource);
                if (otherStat.seasonCounts[1]) {
                    hasOtherSources = true;
                    if (otherStat.seasonCounts[1] > maxOtherS1) maxOtherS1 = otherStat.seasonCounts[1];
                }
            }
            if (!hasOtherSources) continue;

            const threshold = maxOtherS1 + Thresholds.COLLECTION_DIFF;
            // 逐个候选条目独立判定，避免聚合误判
            stat.s1Candidates.forEach(cand => {
                const ratio = maxOtherS1 > 0 ? (cand.originalCount / maxOtherS1) : 0;
                if (cand.originalCount > threshold) {
                    if (ratio > Thresholds.COLLECTION_RATIO) {
                        log("info", `[Merge-Check] [合集探测] 拒绝: [${source}] ${cand.anime.animeTitle} (Ratio too high: ${ratio.toFixed(2)} > ${Thresholds.COLLECTION_RATIO})`);
                        return;
                    }
                    collectionIds.add(cand.anime.animeId);
                    log("info", `[Merge-Check] [合集探测] 发现疑似合集(单体): [${source}] ${cand.anime.animeTitle} (Count:${cand.originalCount} > Thr:${threshold}, Ratio:${ratio.toFixed(2)}) -> 标记为合集`);
                } else {
                    log("info", `[Merge-Check] [合集探测] 未命中: [${source}] ${cand.anime.animeTitle} (Count:${cand.originalCount} <= Threshold:${threshold})`);
                }
            });
        }
    }
    return collectionIds;
}

/**
 * 执行单个主源的合并任务 (Single Merge Task)
 * 完整流程：
 *   1. 从所有副源中检索匹配项（隔离检索，防源间内卷）
 *   2. 合集时序接管（按季数升序排列匹配队列）
 *   3. 小数集数沉底（防中间插值集破坏偏移计算）
 *   4. 合集切片（从大合集中提取对应季度的子集参与对齐）
 *   5. 最佳对齐偏移计算 / 映射表精确路由计算 (Custom Routes)
 *   6. 智能对齐映射（映射表强制制导 > 共识差正片制导 > 番外文本制导）
 *   7. 覆盖率校验（映射表特权可豁免占比校验）
 *   8. 原子化元数据合并（别名、标题、来源标签）
 *   9. 番外沉底排序
 *  10. 重复签名检测（防一对多导致的重复合并结果）
 *
 * @param {Object} params - 任务参数对象
 * @param {Object} params.pAnime                - 主源番剧对象
 * @param {Array}  params.availableSecondaries  - 可用副源名称列表
 * @param {Array}  params.curAnimes             - 当前所有番剧列表
 * @param {Set}    params.groupConsumedIds      - 当前组内已消费的 ID 集合
 * @param {Set}    params.globalConsumedIds     - 全局已消费的 ID 集合
 * @param {Set}    params.generatedSignatures   - 已生成的合并签名集合（防重复）
 * @param {RegExp} params.epFilter              - 集数标题过滤正则
 * @param {string} params.groupFingerprint      - 当前组的指纹（用于 ID 生成盐值）
 * @param {string} params.currentPrimarySource  - 主源名称
 * @param {string} params.logPrefix             - 日志前缀
 * @param {string} [params.limitSecondaryLang]  - 限制副源语言（Phase 1 CN 隔离时使用）
 * @param {Set}    params.collectionAnimeIds    - 合集 ID 集合
 * @param {Set}    [params.allowReuseIds]       - 允许复用的 ID 集合（Part 资源复用全集副源）
 * @param {Map}    [params.collectionProgress]  - 合集进度记录（跨 Phase 共享）
 * @param {Array}  [params.baseSecondaries]     - 当前组的基础原生副源配置
 * @returns {Promise<Object|null>} 合并后的新对象，失败时返回 null
 */
async function processMergeTask(params) {
    const {
        pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds,
        generatedSignatures, epFilter, groupFingerprint, currentPrimarySource, logPrefix,
        limitSecondaryLang, collectionAnimeIds, allowReuseIds, collectionProgress, baseSecondaries
    } = params;

    // 合集副源保护：合集作为副源已被消费时不再作为主源重复触发
    if (collectionAnimeIds.has(pAnime.animeId) && groupConsumedIds.has(pAnime.animeId)) {
        log("info", `${logPrefix} 跳过: [${currentPrimarySource}] 是合集且已作为组内副源参与过合并。`);
        return null;
    }

    // 以传入的最新对象为元数据基准进行克隆，确保包含数据流传递过程中的全量最新元数据
    let derivedAnime = fastCloneAnime(pAnime);
    if (!derivedAnime.links) {
        const cachedPAnime = globals.animes.find(a => String(a.animeId) === String(pAnime.animeId));
        derivedAnime.links = cachedPAnime?.links ? fastCloneAnime(cachedPAnime.links) : [];
    }
    if (!derivedAnime.links || derivedAnime.links.length === 0) {
        log("warn", `${logPrefix} 主源数据不完整，跳过: ${pAnime.animeTitle}`);
        return null;
    }

    const logTitleA            = pAnime.animeTitle.replace(RegexStore.Clean.FROM_SUFFIX, '');
    const actualMergedSources  = [];
    const contentSignatureParts= [pAnime.animeId];
    let hasMergedAny           = false;
    const seriesLangA          = getLanguageType(pAnime.animeTitle);
    const redundantP           = identifyRedundantTitle(derivedAnime.links, pAnime.animeTitle, currentPrimarySource);
    const isPrimaryCollection  = collectionAnimeIds.has(pAnime.animeId);

    // 冗余前缀清洗辅助函数
    const getTempTitle = (rawTitle, redundantStr) => {
        if (!rawTitle) return '';
        if (redundantStr && rawTitle.includes(redundantStr)) return rawTitle.replace(redundantStr, '');
        return rawTitle;
    };

    // 构建同名动画分组（用于季度地图推断）
    const pCleanTitle    = cleanTitleForSimilarity(pAnime.animeTitle);
    const peerAnimes     = curAnimes.filter(a => cleanTitleForSimilarity(a.animeTitle) === pCleanTitle);
    const seasonLengthMap = buildSeasonLengthMap(peerAnimes, epFilter, collectionAnimeIds);
    if (seasonLengthMap.size > 0) {
        const mapDesc = Array.from(seasonLengthMap.entries()).map(([k, v]) => `S${k}=${v}`).join(', ');
        if (isPrimaryCollection || availableSecondaries.some(s => curAnimes.some(a => a.source === s && collectionAnimeIds.has(a.animeId)))) {
            log("info", `${logPrefix} [合集处理] 构建季度集数地图 (Mode策略): { ${mapDesc} }`);
        }
    }

    // ── 隔离检索 ────────────────────────────────────────────────────────────
    // 分源查找，避免不同源因微小相似度差异在同一 findSecondaryMatches 调用中相互排挤
    let allMatches = [];
    for (const secSource of availableSecondaries) {
        let secondaryItems = curAnimes.filter(a => {
            if (a.source !== secSource) return false;

            // 映射表特权前置：必须位于 isPrimaryCollection 之前，防止合集特权绕过阻断规则
            const rule = getMatchingCustomRule(pAnime, a);
            if (rule) {
                if (rule.action === 'block') {
                    log("info", `${logPrefix} 拦截: 副源 [${a.source}] ${a.animeTitle} 被映射表 [×] 规则明确阻断`);
                    return false; 
                }
                return true;
            }

            // 合集主源特权：当主源为合集时，允许无视消耗状态，复用已消费的副源拼凑完整季度
            if (isPrimaryCollection) return true;

            const isConsumed     = groupConsumedIds.has(a.animeId);
            const isAllowedReuse = allowReuseIds && allowReuseIds.has(a.animeId);
            if (isConsumed && !isAllowedReuse) return false;
            return true;
        });

        // 实体去重：防范部分源接口返回重复记录（同 animeId），导致在单一匹配生命周期内被反复合并同一资源
        const uniqueSecItems = [];
        const seenIds = new Set();
        for (const item of secondaryItems) {
            if (!seenIds.has(item.animeId)) {
                seenIds.add(item.animeId);
                uniqueSecItems.push(item);
            }
        }
        secondaryItems = uniqueSecItems;

        if (limitSecondaryLang) secondaryItems = secondaryItems.filter(a => getLanguageType(a.animeTitle) === limitSecondaryLang);
        // 同源内 CN 资源后置（优先尝试与 JP/Unspecified 版本配对）
        if (secondaryItems.length > 1) {
            secondaryItems.sort((a, b) => {
                const isCnA = getLanguageType(a.animeTitle) === 'CN';
                const isCnB = getLanguageType(b.animeTitle) === 'CN';
                if (isCnA === isCnB) return 0;
                return isCnA ? 1 : -1;
            });
        }
        if (secondaryItems.length === 0) continue;
        const matchesForSource = findSecondaryMatches(pAnime, secondaryItems, collectionAnimeIds, baseSecondaries);
        allMatches.push(...matchesForSource);
    }

    if (allMatches.length > 0) {
        // ── 跨源合集时序接管 ─────────────────────────────────────────────────────
        // 当主源或任意匹配项为合集时，强制按季数升序排列匹配队列，
        // 保障切片推断严格自举（S1 的进度会为 S2 的切片提供锚点）
        if (allMatches.length > 1 && (isPrimaryCollection || allMatches.some(m => collectionAnimeIds.has(m.animeId)))) {
            allMatches.sort((a, b) => {
                const sA = getSeasonNumber(a.animeTitle, a.typeDescription, a.aliases) || 1;
                const sB = getSeasonNumber(b.animeTitle, b.typeDescription, b.aliases) || 1;
                if (sA !== sB) return sA - sB;
                // 季数相同时遵循用户配置的源优先级
                const idxA = availableSecondaries.indexOf(a.source);
                const idxB = availableSecondaries.indexOf(b.source);
                return idxA - idxB;
            });
            const seqLogs = allMatches.map(m => `[${m.source}]S${getSeasonNumber(m.animeTitle, m.typeDescription, m.aliases) || 1}`);
            log("info", `${logPrefix} [合集时序] 已将跨源匹配队列按季数升序排列，保障切片推断严格自举: ${seqLogs.join(' -> ')}`);
        }

        for (const match of allMatches) {
            const secSource = match.source;
            // 识别合并映射表中用户自定义的特权路由规则
            const customRule = getMatchingCustomRule(pAnime, match);
            if (customRule && customRule.action === 'block') {
                log("info", `${logPrefix} [安全网拦截] 关联取消: [${currentPrimarySource}] ${pAnime.animeTitle} <-> [${secSource}] ${match.animeTitle} 被明确阻断`);
                continue;
            }

            // 非合集主源的二次消耗校验（合集主源直接跳过）
            if (!isPrimaryCollection) {
                const isReuse = allowReuseIds && allowReuseIds.has(match.animeId);
                // 特权放行：如果命中映射表规则，即使已消费也放行进入复用组装
                if (!isReuse && !customRule && groupConsumedIds.has(match.animeId)) continue;
            }

            const globalCachedMatch = globals.animes.find(a => String(a.animeId) === String(match.animeId));
            if (!globalCachedMatch?.links) continue;

            const derivedMatch       = fastCloneAnime(globalCachedMatch);
            const mappingEntries     = [], matchedPIndices = new Set(), pendingMutations = [], orphanedEpisodes = [];
            const logTitleB          = derivedMatch.animeTitle.replace(RegexStore.Clean.FROM_SUFFIX, '');

            // ── 小数集数预处理 ───────────────────────────────────────────────
            // 找出主副源各自独有的中间插值小数集，沉底处理后再对齐
            const decimalsP  = getDecimalEpisodes(derivedAnime.links, currentPrimarySource);
            const decimalsS  = getDecimalEpisodes(derivedMatch.links, secSource);
            const toSinkS    = new Set([...decimalsS].filter(x => !decimalsP.has(x)));
            const toSinkP    = new Set([...decimalsP].filter(x => !decimalsS.has(x)));
            if (toSinkP.size > 0) sinkDecimalEpisodes(derivedAnime.links, toSinkP, currentPrimarySource, `主源:${currentPrimarySource}`);
            if (toSinkS.size > 0) sinkDecimalEpisodes(derivedMatch.links, toSinkS, secSource, `副源:${secSource}`);

            let currentSecondaryLinks   = derivedMatch.links;
            const filteredPLinksWithIndex = filterEpisodes(derivedAnime.links,    epFilter, currentPrimarySource);
            const filteredMLinksWithIndex = filterEpisodes(currentSecondaryLinks, epFilter, secSource);
            const seriesLangB           = getLanguageType(derivedMatch.animeTitle);
            let activePLinks  = filteredPLinksWithIndex;
            let activeMLinks  = filteredMLinksWithIndex;
            let sliceStartP   = 0, sliceStartS = 0;
            const isSecondaryCollection = collectionAnimeIds.has(match.animeId);

            // ── 合集切片 ─────────────────────────────────────────────────────
            // 当主或副源为合集时，从全集 links 中切出本次需要对齐的季度子集
            const performSlicing = (isPrimarySide, collectionLinks, seasonNum) => {
                let sliceStart = 0, slicedList = collectionLinks;
                if (seasonNum && seasonNum > 1) {
                    // 1. 优先尝试历史推断（上一次合并记录的结束位置）
                    let historyFound = false;
                    const collectionIdToCheck = isPrimarySide ? pAnime.animeId : match.animeId;
                    if (collectionProgress && collectionProgress.has(collectionIdToCheck)) {
                        const progress  = collectionProgress.get(collectionIdToCheck);
                        const prevSeason = seasonNum - 1;
                        if (progress[`S${prevSeason}`] !== undefined) {
                            const inferredStart = progress[`S${prevSeason}`] + 1;
                            if (inferredStart > 0 && inferredStart < collectionLinks.length) {
                                slicedList  = collectionLinks.slice(inferredStart);
                                sliceStart  = inferredStart;
                                log("info", `${logPrefix} [合集切片] 历史推断命中: 根据 S${prevSeason} 结束位置 (Index ${progress[`S${prevSeason}`]}), 设定 S${seasonNum} 起点为 Index ${inferredStart}`);
                                historyFound = true;
                            }
                        }
                    }
                    // 2. 防御性回退：历史推断缺失时，信任季度地图进行计算
                    if (!historyFound) {
                        let accumulatedCount = 0;
                        for (let s = 1; s < seasonNum; s++) accumulatedCount += (seasonLengthMap.get(s) || 0);
                        let safeAccumulated = accumulatedCount;
                        if (safeAccumulated >= collectionLinks.length) {
                            // 起点越界：使用启发式估算（每季约 12 集）
                            const heuristicStart = (seasonNum - 1) * 12;
                            if (heuristicStart < collectionLinks.length) {
                                log("info", `${logPrefix} [合集切片] 起点越界修正: 原计算 ${safeAccumulated} > Total ${collectionLinks.length}，启用回退估算 (S${seasonNum} -> Index ${heuristicStart})`);
                                safeAccumulated = Math.max(0, heuristicStart - 2);
                            }
                        }
                        if (safeAccumulated > 0 && safeAccumulated < collectionLinks.length) {
                            const nextStart = accumulatedCount + (seasonLengthMap.get(seasonNum) || 999);
                            const safeEnd   = Math.min(nextStart, collectionLinks.length);
                            slicedList      = collectionLinks.slice(safeAccumulated, safeEnd);
                            sliceStart      = safeAccumulated;
                            const sideName  = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                            log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S${seasonNum}): 无历史推断(Defensive Fallback)，信任地图切至 ${safeAccumulated}~${safeEnd} (共 ${slicedList.length} 集) 参与对齐`);
                        } else {
                            log("info", `${logPrefix} [合集切片] 放弃切片: 计算起点 ${safeAccumulated} 超出范围 (Total: ${collectionLinks.length})`);
                        }
                    }
                } else if (seasonNum === 1) {
                    // S1 切片：当地图显示 S1 比全集短时，截断避免多余集干扰对齐
                    const s1Count = seasonLengthMap.get(1);
                    if (s1Count && s1Count < collectionLinks.length) {
                        slicedList = collectionLinks.slice(0, s1Count);
                        const sideName = isPrimarySide ? `主源[${currentPrimarySource}]` : `副源[${secSource}]`;
                        log("info", `${logPrefix} [合集切片] 检测到${sideName}为合集 (Target: S1): 使用 Index 0~${s1Count} 参与对齐`);
                    }
                }
                return { sliceStart, slicedList };
            };

            // 切片决策：主源是合集时切主源，副源是合集时切副源
            if (isPrimaryCollection && !isSecondaryCollection) {
                const secSeason = getSeasonNumber(derivedMatch.animeTitle, derivedMatch.typeDescription, derivedMatch.aliases);
                const res       = performSlicing(true, filteredPLinksWithIndex, secSeason);
                activePLinks    = res.slicedList; sliceStartP = res.sliceStart;
            } else if (!isPrimaryCollection && isSecondaryCollection) {
                const pSeason   = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases);
                const res       = performSlicing(false, filteredMLinksWithIndex, pSeason);
                activeMLinks    = res.slicedList; sliceStartS = res.sliceStart;
            }

            // 每次合并新副源都生成新的合并 ID（保持唯一性）
            derivedAnime.animeId  = generateSafeMergedId(derivedAnime.animeId, match.animeId, groupFingerprint);
            derivedAnime.bangumiId = String(derivedAnime.animeId);

            let mergedCount        = 0;
            const redundantS       = identifyRedundantTitle(derivedMatch.links, derivedMatch.animeTitle, secSource);
            // 广义番外判断：isSpecial / isStrictSpecial / 小数集数
            const isBroadSpecial = (info) => info.isSpecial || info.isStrictSpecial || (info.num !== null && info.num % 1 !== 0);
            const kToPIndexMap = new Map(); // 用于记录副源到主源的索引映射，供合集进度记录使用
            let offset = 0; // 保留供非特权情况和合集索引修正使用

            if (customRule && customRule.hasRoutes) {
                // ── 智能对齐策略（特权映射表介入） ─────────────────────────────
                log("info", `${logPrefix} 启用映射表精确路由: ${pAnime.animeTitle} <-> ${match.animeTitle}`);

                // 计算基准推断偏移量，为未匹配到的落单集数提供准确的相对位置参考（头/尾/特殊分类），确保它们不被无脑沉底
                const bestOffsetLocal = findBestAlignmentOffset(activePLinks, activeMLinks, seriesLangA, seriesLangB, currentPrimarySource, secSource, pAnime.animeTitle, derivedMatch.animeTitle);
                const fallbackOffset  = bestOffsetLocal + sliceStartP - sliceStartS;
                
                // 将计算出的推断偏移赋给外层变量，保障后续合集进度的精准计算
                offset = fallbackOffset;

                // 构建集数强映射哈希表
                const sToPMap = new Map();
                for (const route of customRule.routes) {
                    const sLen = route.sec.end - route.sec.start + 1;
                    const pLen = route.prim.end - route.prim.start + 1;
                    if (sLen !== pLen) {
                        log("warn", `[Merge] [映射表] 路由区间跨度不对等，跳过此段: E${route.sec.start}~E${route.sec.end} > E${route.prim.start}~E${route.prim.end}`);
                        continue;
                    }
                    for (let i = 0; i < sLen; i++) {
                        sToPMap.set(route.sec.start + i, route.prim.start + i);
                    }
                }

                for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
                    const sItem = filteredMLinksWithIndex[k];
                    const sourceLink = sItem.link;
                    const sTitleShort = sourceLink.name || sourceLink.title || `Index ${k}`;
                    const cleanTitleS = getTempTitle(sourceLink.title || sourceLink.name, redundantS);
                    const infoS = extractEpisodeInfo(cleanTitleS, secSource);

                    const orphanItem = { link: sourceLink, originalIndex: sItem.originalIndex, relativeIndex: -1, info: infoS };

                    // 提取集数：优先使用标题中提取的数字，若提取为空（如电影/单集）则回退使用当前正片列表的自然序列索引
                    let sNum = infoS.num;
                    if (sNum === null && !infoS.isStrictSpecial) {
                        sNum = k + 1;
                    }

                    // 路由隔离机制：未在规则内的集数使用推断的 fallbackOffset 以获得合法索引，交由 stitchUnmatchedEpisodes 接管
                    if (sNum === null || !sToPMap.has(sNum)) {
                        orphanItem.relativeIndex = k + fallbackOffset;
                        mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [未路由落单] ${sTitleShort} (应用推断偏移位置)` });
                        orphanedEpisodes.push(orphanItem);
                        continue;
                    }

                    const targetPNum = sToPMap.get(sNum);
                    const pIndex = filteredPLinksWithIndex.findIndex((pItem, idx) => {
                        const infoP = extractEpisodeInfo(getTempTitle(pItem.link.title || pItem.link.name, redundantP), currentPrimarySource);
                        let pNum = infoP.num;
                        if (pNum === null && !infoP.isStrictSpecial) {
                            pNum = idx + 1;
                        }
                        return pNum === targetPNum && !infoP.isSpecial && !infoP.isStrictSpecial;
                    });

                    if (pIndex !== -1) {
                        kToPIndexMap.set(k, pIndex);
                        orphanItem.relativeIndex = pIndex;
                        const originalPIndex = filteredPLinksWithIndex[pIndex].originalIndex;
                        const targetLink = derivedAnime.links[originalPIndex];
                        const pTitleShort = targetLink.name || targetLink.title || `Index ${originalPIndex}`;

                        // ── 执行 URL 合并 ────────────────────────────────────────
                        const idB = sanitizeUrl(sourceLink.url);
                        let currentUrl = targetLink.url;
                        const secPart = `${secSource}:${idB}`;
                        if (!currentUrl.includes(MERGE_DELIMITER)) {
                            if (!currentUrl.startsWith(currentPrimarySource + ':')) currentUrl = `${currentPrimarySource}:${currentUrl}`;
                        }
                        const newMergedUrl = `${currentUrl}${MERGE_DELIMITER}${secPart}`;

                        // ── 合并标题标签 ─────────────────────────────────────────
                        let newMergedTitle = targetLink.title;
                        if (newMergedTitle) {
                            let sLabel = secSource;
                            const sMatch = (sourceLink.title || '').match(/^【([^】\d]+)(?:\d*)】/);
                            if (sMatch) sLabel = sMatch[1].trim();
                            newMergedTitle = newMergedTitle.replace(/^【([^】]+)】/, (m, content) => `【${content}${DISPLAY_CONNECTOR}${sLabel}】`);
                        }

                        mappingEntries.push({ idx: pIndex, text: `   [已路由映射] ${pTitleShort} <-> ${sTitleShort} (Rule: E${sNum}>E${targetPNum})` });
                        matchedPIndices.add(pIndex);
                        mergedCount++;
                        pendingMutations.push({ linkIndex: originalPIndex, newUrl: newMergedUrl, newTitle: newMergedTitle });
                    } else {
                        // 目标找不到时，同样应用推断偏移以正常处理落单集数
                        orphanItem.relativeIndex = k + fallbackOffset;
                        mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [路由失败] 主源找不到 E${targetPNum} <-> ${sTitleShort}` });
                        orphanedEpisodes.push(orphanItem);
                    }
                }
            } else {
                if (customRule) {
                    log("info", `${logPrefix} 命中映射表常规合并: [${secSource}] ${match.animeTitle} -> [${currentPrimarySource}] ${pAnime.animeTitle} (已免检放行，交由系统自动对齐)`);
                }
                
                // ── 对齐偏移计算 ─────────────────────────────────────────────────
                const bestOffsetLocal = findBestAlignmentOffset(activePLinks, activeMLinks, seriesLangA, seriesLangB, currentPrimarySource, secSource, pAnime.animeTitle, derivedMatch.animeTitle);
                offset                = bestOffsetLocal + sliceStartP - sliceStartS;
                if (offset !== 0) log("info", `${logPrefix} 集数自动对齐 (${secSource}): Offset=${offset} (P:${filteredPLinksWithIndex.length}, S:${filteredMLinksWithIndex.length})`);

                // ── 智能对齐策略（共识差计算） ───────────────────────────────────
                // 1. 提取共识集数差（consensus shift）
                // 通过所有正片对的集数差加权投票，找出最可信的"主源集数 - 副源集数"偏移量
                const shiftCounts = new Map();
                let lastPNum = null;
                filteredMLinksWithIndex.forEach((sItem, k) => {
                    const pItem  = filteredPLinksWithIndex[k + offset];
                    if (!pItem) return;
                    const titleP = getTempTitle(pItem.link.title || pItem.link.name, redundantP);
                    const titleS = getTempTitle(sItem.link.title || sItem.link.name, redundantS);
                    const infoP  = extractEpisodeInfo(titleP, currentPrimarySource);
                    const infoS  = extractEpisodeInfo(titleS, secSource);
                    if (infoP.num === null || infoS.num === null || isBroadSpecial(infoP) || isBroadSpecial(infoS)) return;
                    const diff   = infoP.num - infoS.num;
                    const sim    = calculateSimilarity(cleanEpisodeText(titleP), cleanEpisodeText(titleS));
                    // 权重计算：基础(1.0) + 文本奖励(1.0)
                    let weight   = 1.0 + (sim > 0.45 ? 1.0 : 0);
                    // 断层惩罚：主源正片跳集，说明此段不可信（如占位集/异构区）
                    if (lastPNum !== null && (infoP.num - lastPNum > 1)) {
                        weight = 0.1;
                    } else {
                        lastPNum = infoP.num;
                    }
                    shiftCounts.set(diff, (shiftCounts.get(diff) || 0) + weight);
                });
                const consensusShift = shiftCounts.size > 0
                    ? [...shiftCounts.entries()].reduce((max, curr) => curr[1] > max[1] ? curr : max)[0]
                    : null;

                // 2. 预处理主源的广义番外索引池（供番外制导使用）
                const pSpecialIndices = filteredPLinksWithIndex.reduce((acc, pItem, i) => {
                    const info = extractEpisodeInfo(getTempTitle(pItem.link.title || pItem.link.name, redundantP), currentPrimarySource);
                    if (isBroadSpecial(info) && !info.isPV) acc.push(i);
                    return acc;
                }, []);
                let sSpecialCounter = 0;

                // 3. 执行智能映射
                for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
                    let pIndex          = k + offset;
                    const sourceLinkItem = filteredMLinksWithIndex[k];
                    const sourceLink    = sourceLinkItem.link;
                    const sTitleShort   = sourceLink.name || sourceLink.title || `Index ${k}`;
                    const cleanTitleS   = getTempTitle(sourceLink.title || sourceLink.name, redundantS);
                    const infoS         = extractEpisodeInfo(cleanTitleS, secSource);
                    const orphanItem    = { link: sourceLink, originalIndex: sourceLinkItem.originalIndex, relativeIndex: pIndex, info: infoS };
                    const broadSpecialS = isBroadSpecial(infoS);

                    if (consensusShift !== null && infoS.num !== null && !broadSpecialS) {
                        // [正片制导] 基于共识差精确定位主源对应集
                        const targetNum = infoS.num + consensusShift;
                        pIndex = filteredPLinksWithIndex.findIndex(pItem => {
                            const infoP = extractEpisodeInfo(getTempTitle(pItem.link.title || pItem.link.name, redundantP), currentPrimarySource);
                            return infoP.num === targetNum && !isBroadSpecial(infoP);
                        });
                        if (pIndex !== -1) {
                            orphanItem.relativeIndex = pIndex;
                        } else {
                            // 未找到精确匹配：找最近的前一个正片作为插入锚点
                            let closestIdx = -0.5;
                            for (let i = filteredPLinksWithIndex.length - 1; i >= 0; i--) {
                                const infoP = extractEpisodeInfo(getTempTitle(filteredPLinksWithIndex[i].link.title || filteredPLinksWithIndex[i].link.name, redundantP), currentPrimarySource);
                                if (infoP.num !== null && !infoP.isSpecial && infoP.num < targetNum) {
                                    closestIdx = i; break;
                                }
                            }
                            orphanItem.relativeIndex = closestIdx + (k * 0.001) + 0.1;
                        }
                    } else if (broadSpecialS) {
                        // [番外制导] 优先文本查重（同类番外名字相同），其次顺序映射
                        let bestPIdx  = -1, bestSim = 0.65;
                        const cleanEpS = cleanEpisodeText(cleanTitleS);
                        for (const pIdx of pSpecialIndices) {
                            const pTitle = getTempTitle(filteredPLinksWithIndex[pIdx].link.title || filteredPLinksWithIndex[pIdx].link.name, redundantP);
                            const infoP  = extractEpisodeInfo(pTitle, currentPrimarySource);
                            if (infoS.isPV !== infoP.isPV) continue; // PV 与非 PV 不互通
                            const sim    = calculateSimilarity(cleanEpS, cleanEpisodeText(pTitle));
                            if (sim > bestSim) { bestSim = sim; bestPIdx = pIdx; }
                        }
                        if (bestPIdx === -1 && !infoS.isPV && sSpecialCounter < pSpecialIndices.length) {
                            bestPIdx = pSpecialIndices[sSpecialCounter];
                        }
                        if (!infoS.isPV) sSpecialCounter++;
                        pIndex = bestPIdx;
                        orphanItem.relativeIndex = pIndex !== -1 ? pIndex : filteredPLinksWithIndex.length + (k * 0.001);
                    } else {
                        orphanItem.relativeIndex = pIndex !== -1 ? pIndex : (k + offset);
                    }

                    if (pIndex >= 0 && pIndex < filteredPLinksWithIndex.length) {
                        kToPIndexMap.set(k, pIndex);
                        const originalPIndex = filteredPLinksWithIndex[pIndex].originalIndex;
                        const targetLink     = derivedAnime.links[originalPIndex];
                        const pTitleShort    = targetLink.name || targetLink.title || `Index ${originalPIndex}`;
                        const cleanTitleP    = getTempTitle(targetLink.title, redundantP);
                        const specialP       = getSpecialEpisodeType(cleanTitleP);
                        const specialS       = getSpecialEpisodeType(cleanTitleS);
                        const infoP          = extractEpisodeInfo(cleanTitleP, currentPrimarySource);

                        // PV 不匹配正片
                        if (infoS.isPV && !specialP) {
                            mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (PV不匹配正片)` });
                            orphanedEpisodes.push(orphanItem);
                            continue;
                        }
                        // 特殊集类型不一致
                        if (specialP !== specialS) {
                            mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (特殊集类型不匹配)` });
                            orphanedEpisodes.push(orphanItem);
                            continue;
                        }
                        // 正片与番外强阻断：isStrictSpecial 或小数集视为"强番外属性"，不与纯正片互通
                        const strictOrDecimalP = infoP.isStrictSpecial || (infoP.num !== null && infoP.num % 1 !== 0);
                        const strictOrDecimalS = infoS.isStrictSpecial || (infoS.num !== null && infoS.num % 1 !== 0);
                        const isRegularP       = !infoP.isSpecial && (infoP.num === null || infoP.num % 1 === 0);
                        const isRegularS       = !infoS.isSpecial && (infoS.num === null || infoS.num % 1 === 0);
                        if ((strictOrDecimalP && isRegularS) || (strictOrDecimalS && isRegularP)) {
                            mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [略过] ${pTitleShort} =/= ${sTitleShort} (正片与番外阻断)` });
                            orphanedEpisodes.push(orphanItem);
                            continue;
                        }

                        // ── 执行 URL 合并 ────────────────────────────────────────
                        const idB         = sanitizeUrl(sourceLink.url);
                        let currentUrl    = targetLink.url;
                        const secPart     = `${secSource}:${idB}`;
                        if (!currentUrl.includes(MERGE_DELIMITER)) {
                            if (!currentUrl.startsWith(currentPrimarySource + ':')) currentUrl = `${currentPrimarySource}:${currentUrl}`;
                        }
                        const newMergedUrl = `${currentUrl}${MERGE_DELIMITER}${secPart}`;

                        // ── 合并标题标签 ─────────────────────────────────────────
                        let newMergedTitle = targetLink.title;
                        if (newMergedTitle) {
                            let sLabel = secSource;
                            if (sourceLink.title) {
                                const sMatch = sourceLink.title.match(/^【([^】\d]+)(?:\d*)】/);
                                if (sMatch) sLabel = sMatch[1].trim();
                            }
                            newMergedTitle = newMergedTitle.replace(/^【([^】]+)】/, (match, content) => `【${content}${DISPLAY_CONNECTOR}${sLabel}】`);
                        }

                        mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [匹配] ${pTitleShort} <-> ${sTitleShort}` });
                        matchedPIndices.add(pIndex);
                        mergedCount++;
                        pendingMutations.push({ linkIndex: originalPIndex, newUrl: newMergedUrl, newTitle: newMergedTitle });
                    } else {
                        mappingEntries.push({ idx: orphanItem.relativeIndex, text: `   [落单] (主源越界) <-> ${sTitleShort}` });
                        orphanedEpisodes.push(orphanItem);
                    }
                }
            }

            // 记录主源中未被匹配的集数（日志用）
            for (let j = 0; j < filteredPLinksWithIndex.length; j++) {
                if (!matchedPIndices.has(j)) {
                    const originalPIndex = filteredPLinksWithIndex[j].originalIndex;
                    const targetLink     = derivedAnime.links[originalPIndex];
                    const pTitleShort    = targetLink.name || targetLink.title || `Index ${originalPIndex}`;
                    mappingEntries.push({ idx: j, text: `   [落单] ${pTitleShort} <-> (副源缺失或被略过)` });
                }
            }

            if (mergedCount > 0) {
                const isAnyCollection = collectionAnimeIds.has(pAnime.animeId) || collectionAnimeIds.has(match.animeId);
                // ── 覆盖率校验 ────────────────────────────────────────────────
                let isValidMerge = false;
                if (customRule) {
                    // 如果是映射表强行指定，跳过基于占比的覆盖率检查，有成功匹配的集数即视为合法
                    isValidMerge = mergedCount > 0;
                } else {
                    isValidMerge = isMergeRatioValid(mergedCount, filteredPLinksWithIndex.length, filteredMLinksWithIndex.length, currentPrimarySource, secSource, isAnyCollection);
                }

                if (isValidMerge) {
                    // 原子写入：所有 URL/Title 变更一次性提交，保证数据一致性
                    for (const mutation of pendingMutations) {
                        const link  = derivedAnime.links[mutation.linkIndex];
                        link.url    = mutation.newUrl;
                        link.title  = mutation.newTitle;
                    }

                    // ── 别名合并 ─────────────────────────────────────────────
                    const getBaseTitle = (t) => {
                        if (!t) return '';
                        return t.replace(RegexStore.Clean.YEAR_TAG,   '')
                                .replace(RegexStore.Clean.SOURCE_TAG, '')
                                .replace(RegexStore.Clean.FROM_SUFFIX,'')
                                .trim();
                    };
                    const currentPrimaryBase = getBaseTitle(derivedAnime.animeTitle);
                    derivedAnime.aliases = [...new Set([
                        ...(derivedAnime.aliases  || []),
                        ...(derivedMatch.aliases  || []),
                        ...(match.aliases          || []),
                        getBaseTitle(derivedMatch.animeTitle)
                    ])].filter(alias => alias && alias !== currentPrimaryBase);

                    log("info", `${logPrefix} 关联成功: [${currentPrimarySource}] ${logTitleA} <-> [${secSource}] ${logTitleB} (本次合并 ${mergedCount} 集)`);
                    if (mappingEntries.length > 0) {
                        mappingEntries.sort((a, b) => a.idx - b.idx);
                        log("info", `${logPrefix} [${secSource}] 映射详情:\n${mappingEntries.map(e => e.text).join('\n')}`);
                    }
                    // ── 记录合并层级 ──────────────────────────────────────
                    derivedAnime.mergedChildren = derivedAnime.mergedChildren || [];
                    // 1. 将副源数据存入全新组合对象的 mergedChildren 集合中
                    if (!derivedAnime.mergedChildren.some(c => String(c.animeId) === String(match.animeId) && c.source === match.source)) {
                        derivedAnime.mergedChildren.push({
                            animeId: match.animeId,
                            animeTitle: match.animeTitle,
                            source: match.source,
                            episodes: derivedMatch.links ? derivedMatch.links.length : 0,
                            imageUrl: match.imageUrl || ''
                        });
                    }

                    // 2. 在全局缓存中将“被合并的原始副源”标记为隐藏
                    const cachedSec = globals.animes.find(a => String(a.animeId) === String(match.animeId) && a.source === match.source);
                    if (cachedSec) cachedSec.isHiddenChild = true;

                    // ── 合集进度双向写入 ──────────────────────────────────────
                    // 支持主源为合集与副源为合集两种情况，为链式关联的下一次切片铺路
                    if (collectionProgress && (isSecondaryCollection || isPrimaryCollection)) {
                        let maxUsedIndex = -1;
                        if (isPrimaryCollection && !isSecondaryCollection) {
                            // 主源是合集：在主源索引中找最大落点，记录此季度的结束位置
                            for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
                                const pIndex = kToPIndexMap.has(k) ? kToPIndexMap.get(k) : (k + offset);
                                if (matchedPIndices.has(pIndex)) {
                                    const originalPIndex = filteredPLinksWithIndex[pIndex].originalIndex;
                                    if (originalPIndex > maxUsedIndex) maxUsedIndex = originalPIndex;
                                }
                            }
                            if (maxUsedIndex !== -1) {
                                const sSeason = getSeasonNumber(derivedMatch.animeTitle, derivedMatch.typeDescription, derivedMatch.aliases) || 1;
                                if (!collectionProgress.has(pAnime.animeId)) collectionProgress.set(pAnime.animeId, {});
                                const progress = collectionProgress.get(pAnime.animeId);
                                if (mergedCount >= 3) {
                                    progress[`S${sSeason}`] = maxUsedIndex;
                                }
                            }
                        } else if (!isPrimaryCollection && isSecondaryCollection) {
                            // 副源是合集：在副源索引中找最大落点
                            for (let k = 0; k < filteredMLinksWithIndex.length; k++) {
                                const pIndex = kToPIndexMap.has(k) ? kToPIndexMap.get(k) : (k + offset);
                                if (matchedPIndices.has(pIndex)) {
                                    const item = filteredMLinksWithIndex[k];
                                    if (item.originalIndex > maxUsedIndex) maxUsedIndex = item.originalIndex;
                                }
                            }
                            if (maxUsedIndex !== -1) {
                                const pSeason = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases) || 1;
                                if (!collectionProgress.has(match.animeId)) collectionProgress.set(match.animeId, {});
                                const progress = collectionProgress.get(match.animeId);
                                if (mergedCount >= 3) {
                                    progress[`S${pSeason}`] = maxUsedIndex;
                                    log("info", `[Merge-Check] 更新合集进度 [${match.animeId}]: S${pSeason} -> MaxIndex ${maxUsedIndex}`);
                                }
                            }
                        }
                    }

                    // 合集副源及跨季度映射跳过孤立集补全（避免混入其他季度集数或无用合集信息）
                    const pSeasonNum = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases) || 1;
                    const sSeasonNum = getSeasonNumber(derivedMatch.animeTitle, derivedMatch.typeDescription, derivedMatch.aliases) || 1;
                    const isCrossSeasonMapping = customRule && (pSeasonNum !== sSeasonNum);

                    if (collectionAnimeIds.has(match.animeId) || isCrossSeasonMapping) {
                        log("info", `${logPrefix} [智能补全] 跳过: 副源 [${secSource}] 为合集或触发跨季度映射，为避免混入其他季度集数，不执行补全。`);
                    } else {
                        stitchUnmatchedEpisodes(derivedAnime, orphanedEpisodes, secSource);
                    }

                    // ── 番外沉底排序 ──────────────────────────────────────────
                    // 将严格番外（OP/ED/SP等）移动到列表末尾，保证正片优先展示
                    const normals = [], sinkers = [];
                    derivedAnime.links.forEach(link => {
                        const rawContent = link.title.replace(RegexStore.Clean.SOURCE_TAG, '').trim();
                        if (RegexStore.Episode.SINK_TITLE_STRICT.test(rawContent)) sinkers.push(link);
                        else normals.push(link);
                    });
                    if (sinkers.length > 0) {
                        derivedAnime.links = [...normals, ...sinkers];
                        log("info", `${logPrefix} [排序优化] 立即执行番外沉底: 移动了 ${sinkers.length} 个番外集到末尾`);
                    }

                    hasMergedAny = true;
                    actualMergedSources.push(secSource);
                    contentSignatureParts.push(match.animeId);
                } else {
                    log("info", `${logPrefix} 关联取消: [${currentPrimarySource}] ${logTitleA} <-> [${secSource}] ${logTitleB} (匹配率过低: ${mergedCount}/${Math.max(filteredPLinksWithIndex.length, filteredMLinksWithIndex.length)})`);
                }
            }
        }
    }

    if (hasMergedAny) {
        // ── 重复签名检测 ──────────────────────────────────────────────────────
        // 防止多主源并发触发时，同一组 ID 的合并被重复写入
        const signature = contentSignatureParts.join('|');
        if (generatedSignatures.has(signature)) {
            log("info", `${logPrefix} 检测到重复的合并结果 (Signature: ${signature})，已自动隐去冗余条目。`);
            return null;
        }
        generatedSignatures.add(signature);
        // 在全局缓存中将“被取代的原始主源”标记为隐藏
        const cachedPrim = globals.animes.find(a => String(a.animeId) === String(pAnime.animeId) && a.source === pAnime.source);
        if (cachedPrim) cachedPrim.isHiddenChild = true;

        // 标记消费：合集 ID 仅标记全局消费（保留组内复用能力），普通 ID 标记两级消费
        for (let i = 1; i < contentSignatureParts.length; i++) {
            const secId = contentSignatureParts[i];
            if (!collectionAnimeIds.has(secId)) {
                groupConsumedIds.add(secId);
            } else {
                log("info", `${logPrefix} 合集保留: ID [${secId}] 是合集，保留以供同组复用。`);
            }
            globalConsumedIds.add(secId);
        }

        // 更新合并标题中的来源标签
        const joinedSources = actualMergedSources.join(DISPLAY_CONNECTOR);
        derivedAnime.animeTitle = derivedAnime.animeTitle.replace(
            `from ${currentPrimarySource}`,
            `from ${currentPrimarySource}${DISPLAY_CONNECTOR}${joinedSources}`
        );
        derivedAnime.source = currentPrimarySource;
        return derivedAnime;
    }
    return null;
}


// ==============================================================================
// [L11] 主入口 (Main Entry Point)
// ==============================================================================

/**
 * 应用番剧合并逻辑 (Main Entry Point)
 * 遍历所有合并组配置，执行三段式匹配策略，直接修改传入的 curAnimes 数组
 *
 * 三段式策略：
 *   Phase 1     : CN Primary Isolation  —— 主源CN优先隔离，仅向 CN 副源发起匹配
 *                 保证中文配音资源优先与同语言副源对齐，避免被其他语言版本干扰
 *   Phase 1.5   : CN Secondary Self-Org —— 副源CN自组网
 *                 处理 Phase 1 主源未捕获的低顺位 CN 源，让它们相互配对
 *   Phase 2     : Standard Fallback      —— 标准回退匹配，处理所有剩余资源
 *
 * @param {Array}        curAnimes   - 待处理的番剧列表（将被原地修改）
 * @param {Object|null}  detailStore - 详情存储对象（可选）
 * @returns {Promise<void>}
 */
export async function applyMergeLogic(curAnimes, detailStore = null) {
    if (!curAnimes || curAnimes.length < 2) return;

    // 获取常规配置与映射表配置
    const baseGroups = globals.mergeSourcePairs || [];
    const customRules = globals.customMergeRules || [];
    const dynamicPairsMap = new Map();

    // 扫描映射表，推断隐含的源依赖关系
    for (const rule of customRules) {
        if (rule.action === 'block') continue;
        // 从规则中提取基础源，支持已合并指向解析
        const pSrc = rule.primary.source.split('&')[0];
        const sSrc = rule.secondary.source.split('&')[0];
        if (!dynamicPairsMap.has(pSrc)) dynamicPairsMap.set(pSrc, new Set());
        dynamicPairsMap.get(pSrc).add(sSrc);
    }

    // 将基础组复制为执行组，并记录 baseSecondaries 用于执行期权限隔离
    let groups = baseGroups.map(bg => ({
        primary: bg.primary,
        secondaries: [...bg.secondaries],
        baseSecondaries: [...bg.secondaries]
    }));

    // 将映射表规则混入执行组内，提供特权运行通道
    for (const [pSrc, sSrcs] of dynamicPairsMap.entries()) {
        let existing = groups.find(g => g.primary === pSrc);
        if (!existing) {
            existing = { primary: pSrc, secondaries: [], baseSecondaries: [] };
            groups.push(existing);
        }
        for (const sSrc of sSrcs) {
            if (!existing.secondaries.includes(sSrc)) {
                existing.secondaries.push(sSrc);
            }
        }
    }

    if (!groups || groups.length === 0) return;
    log("info", `[Merge] 启动源合并策略，组合计算后的配置: ${JSON.stringify(groups)}`);

    // 预处理集数过滤正则
    let epFilter = globals.episodeTitleFilter;
    if (epFilter && typeof epFilter === 'string') {
        try { epFilter = new RegExp(epFilter, 'i'); } catch (e) { epFilter = null; }
    }

    // ── 前置全局计算 ────────────────────────────────────────────────────────
    const collectionAnimeIds = detectCollectionCandidates(curAnimes);
    // 合集切片进度（跨 Phase 共享，确保 Phase 1 产生的切片进度能被 Phase 2 利用）
    // 结构: Map<animeId, { S1: lastUsedIndex, S2: lastUsedIndex }>
    const collectionProgress  = new Map();
    const newMergedAnimes     = [];
    const generatedSignatures = new Set();
    const globalConsumedIds   = new Set();

    // 收集单独作为主源（无副源配置）的来源，用于最终保护阶段
    const keepSources = new Set();
    groups.forEach(g => { if (g.secondaries.length === 0) keepSources.add(g.primary); });

    for (const group of groups) {
        if (group.secondaries.length === 0) continue;

        // 构建全局优先级地图（Primary=0, Sec1=1, Sec2=2...）
        const sourcePriorityMap = new Map();
        const fullPriorityList  = [group.primary, ...group.secondaries];
        fullPriorityList.forEach((src, idx) => sourcePriorityMap.set(src, idx));
        const groupFingerprint  = fullPriorityList.join('&');
        const groupConsumedIds  = new Set(); // 当前组内消费追踪（Phase 间隔离）

        /**
         * 通用排序函数
         * 排序优先级（ASC）：
         *   1. 源优先级（配置文件定义顺序）
         *   2. 媒体类型（TV > Movie/OVA/SP）
         *   3. 季度编号（S1 → S2 → ...）
         * 确保主源总先于副源执行，且同源内按季度顺序处理
         */
        const sortCandidates = (list, phaseName) => {
            if (!list || list.length < 2) return list;
            log("info", `[Merge-Check] [Sort] ${phaseName} 排序前首个元素: ${list[0].animeTitle}`);
            list.sort((a, b) => {
                // 优先级 1: 源优先级 ASC（?? 99 防止未在 map 中的来源报错）
                const pA = sourcePriorityMap.get(a.source) ?? 99;
                const pB = sourcePriorityMap.get(b.source) ?? 99;
                if (pA !== pB) return pA - pB;
                // 优先级 2: 媒体类型（1=TV, 2=Movie/OVA/SP）
                const getMediaTypePriority = (anime) => {
                    const markers    = extractSeasonMarkers(anime.animeTitle, anime.typeDescription, anime.aliases);
                    if (markers.has('MOVIE')) return 2;
                    if (markers.has('OVA') || markers.has('SP')) return 2;
                    const strictType = getStrictMediaType(anime.animeTitle, anime.typeDescription);
                    if (strictType === 'MOVIE') return 2;
                    return 1; // 默认为 TV 正片季度
                };
                const typeA = getMediaTypePriority(a);
                const typeB = getMediaTypePriority(b);
                if (typeA !== typeB) return typeA - typeB;
                // 优先级 3: 季度编号 ASC（S1 → S2 → S3）
                const sA = getSeasonNumber(a.animeTitle, a.typeDescription, a.aliases) || 1;
                const sB = getSeasonNumber(b.animeTitle, b.typeDescription, b.aliases) || 1;
                return sA - sB;
            });
            const debugOrder = list.map(a => {
                const sNum      = getSeasonNumber(a.animeTitle, a.typeDescription, a.aliases) || 1;
                const typeLabel = (extractSeasonMarkers(a.animeTitle, a.typeDescription, a.aliases).has('MOVIE') ||
                                   getStrictMediaType(a.animeTitle, a.typeDescription) === 'MOVIE') ? 'Movie' : `S${sNum}`;
                const pLevel    = sourcePriorityMap.get(a.source) ?? '?';
                return `[P${pLevel}] [${typeLabel}] [${a.source}] ${a.animeTitle}`;
            });
            log("info", `[Merge-Check] [Sort] ${phaseName} 执行顺序:\n   ${debugOrder.join('\n   ')}`);
            return list;
        };

        // ── Phase 1: CN Primary Isolation ──────────────────────────────────
        // 收集所有未消费的 CN 条目（含主源和副源），它们之间优先相互匹配
        const cnCandidates = [];
        fullPriorityList.forEach(source => {
            const items = curAnimes.filter(a => a.source === source && !groupConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN');
            items.forEach(item => cnCandidates.push(item));
        });
        // 检查副源池中是否有 CN 资源，无 CN 副源则跳过 Phase 1
        let hasCnInSecondaries = false;
        for (const secSrc of fullPriorityList) {
            if (curAnimes.some(a => a.source === secSrc && !groupConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN')) {
                hasCnInSecondaries = true; break;
            }
        }
        if (cnCandidates.length > 0 && hasCnInSecondaries) {
            log("info", `[Merge] [Phase 1] 启动 CN 隔离策略: 包含 ${cnCandidates.length} 个 CN 资源。`);
            sortCandidates(cnCandidates, 'Phase 1');
            for (const pAnime of cnCandidates) {
                if (groupConsumedIds.has(pAnime.animeId)) continue;
                const currentPriorityIdx = sourcePriorityMap.get(pAnime.source);
                const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);
                if (availableSecondaries.length === 0) continue;
                const resultAnime = await processMergeTask({
                    pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds,
                    generatedSignatures, epFilter, groupFingerprint,
                    currentPrimarySource: pAnime.source, logPrefix: `[Merge][Phase 1: CN-Strict]`,
                    limitSecondaryLang: 'CN', collectionAnimeIds, collectionProgress,
                    baseSecondaries: group.baseSecondaries
                });
                if (resultAnime) {
                    newMergedAnimes.push(resultAnime);
                    groupConsumedIds.add(pAnime.animeId);
                    globalConsumedIds.add(pAnime.animeId);
                }
            }
        }

        // ── Phase 1.5: Secondary CN Self-Organization ───────────────────────
        // 处理 Phase 1 中未被主源捕获的剩余 CN 资源，让低顺位 CN 源之间互联
        const secondaryCnCandidates = [];
        for (let i = 1; i < fullPriorityList.length; i++) { // 从第二个源开始（主源已在 Phase 1 处理）
            const source = fullPriorityList[i];
            const items  = curAnimes.filter(a => a.source === source && !groupConsumedIds.has(a.animeId) && getLanguageType(a.animeTitle) === 'CN');
            items.forEach(item => secondaryCnCandidates.push(item));
        }
        if (secondaryCnCandidates.length >= 2) {
            log("info", `[Merge] [Phase 1.5] 启动副源 CN 自组织: 检测到 ${secondaryCnCandidates.length} 个剩余 CN 资源。`);
            sortCandidates(secondaryCnCandidates, 'Phase 1.5');
            for (const tAnime of secondaryCnCandidates) {
                if (groupConsumedIds.has(tAnime.animeId)) continue;
                const currentPriorityIdx   = sourcePriorityMap.get(tAnime.source);
                const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);
                if (availableSecondaries.length === 0) continue;
                const resultAnime = await processMergeTask({
                    pAnime: tAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds,
                    generatedSignatures, epFilter, groupFingerprint,
                    currentPrimarySource: tAnime.source, logPrefix: `[Merge][Phase 1.5: CN-Secondary]`,
                    limitSecondaryLang: 'CN', collectionAnimeIds, collectionProgress,
                    baseSecondaries: group.baseSecondaries
                });
                if (resultAnime) {
                    newMergedAnimes.push(resultAnime);
                    groupConsumedIds.add(tAnime.animeId);
                    globalConsumedIds.add(tAnime.animeId);
                }
            }
        }

        // ── Phase 2: Standard Fallback ──────────────────────────────────────
        // 处理所有剩余资源（含非 CN 以及 Phase 1/1.5 未匹配的 CN 资源）
        const remainingCandidates = [];
        fullPriorityList.forEach(source => {
            const items = curAnimes.filter(a => a.source === source && !groupConsumedIds.has(a.animeId));
            items.forEach(item => remainingCandidates.push(item));
        });
        const uniqueRemainingSources = new Set(remainingCandidates.map(a => a.source));
        if (remainingCandidates.length > 0 && uniqueRemainingSources.size >= 2) {
            log("info", `[Merge] [Phase 2] 启动标准回退匹配: 剩余 ${remainingCandidates.length} 个资源。`);
            sortCandidates(remainingCandidates, 'Phase 2');
            for (const pAnime of remainingCandidates) {
                if (groupConsumedIds.has(pAnime.animeId)) continue;
                const currentPriorityIdx   = sourcePriorityMap.get(pAnime.source);
                const availableSecondaries = fullPriorityList.slice(currentPriorityIdx + 1);
                if (availableSecondaries.length === 0) continue;

                // Part 复用逻辑：如果主源是 Part 分部资源，尝试寻找已合并的同季度全集资源进行复用
                const markers  = extractSeasonMarkers(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases);
                const hasPart  = Array.from(markers).some(m => m.startsWith('P'));
                let allowReuseIds = null;
                if (hasPart) {
                    allowReuseIds = new Set();
                    const pSeasonNum = getSeasonNumber(pAnime.animeTitle, pAnime.typeDescription, pAnime.aliases) || 1;
                    for (const consumedId of globalConsumedIds) {
                        const consumedAnime = globals.animes.find(a => String(a.animeId) === String(consumedId));
                        if (!consumedAnime) continue;
                        if (!availableSecondaries.includes(consumedAnime.source)) continue;
                        // 排除自身也是 Part 类型的资源（只复用全集）
                        const secMarkers = extractSeasonMarkers(consumedAnime.animeTitle, consumedAnime.typeDescription, consumedAnime.aliases);
                        if (Array.from(secMarkers).some(m => m.startsWith('P'))) continue;
                        const sSeasonNum = getSeasonNumber(consumedAnime.animeTitle, consumedAnime.typeDescription, consumedAnime.aliases) || 1;
                        if (pSeasonNum === sSeasonNum) allowReuseIds.add(consumedAnime.animeId);
                    }
                }

                const resultAnime = await processMergeTask({
                    pAnime, availableSecondaries, curAnimes, groupConsumedIds, globalConsumedIds,
                    generatedSignatures, epFilter, groupFingerprint,
                    currentPrimarySource: pAnime.source, logPrefix: `[Merge][Phase 2: Standard]`,
                    collectionAnimeIds, allowReuseIds, collectionProgress,
                    baseSecondaries: group.baseSecondaries
                });
                if (resultAnime) {
                    newMergedAnimes.push(resultAnime);
                    groupConsumedIds.add(pAnime.animeId);
                    globalConsumedIds.add(pAnime.animeId);
                }
            }
        }
    }

    // ── 最终整理 ─────────────────────────────────────────────────────────────
    // 将所有合法衍生出来的合并对象推入主列表
    if (newMergedAnimes.length > 0) {
        for (const anime of newMergedAnimes) addAnime(anime, detailStore);
        curAnimes.unshift(...newMergedAnimes);
    }

    // 保护单源配置：secondaries 为空的主源不应被标记为已消费
    if (keepSources.size > 0) {
        for (const anime of curAnimes) {
            if (globalConsumedIds.has(anime.animeId) && keepSources.has(anime.source)) {
                globalConsumedIds.delete(anime.animeId);
            }
        }
    }

    // 最终清理：移除已被任意一组所消费的单源原始资源
    for (let i = curAnimes.length - 1; i >= 0; i--) {
        const item = curAnimes[i];
        if (item._isMerged || globalConsumedIds.has(item.animeId)) curAnimes.splice(i, 1);
    }

    if (newMergedAnimes.length > 0) {
        log("info", `[Merge] 合并执行完毕，新增了 ${newMergedAnimes.length} 个合并项，最终列表数量: ${curAnimes.length}`);
    } else {
        log("info", `[Merge] 扫描完毕，未产生任何合并，列表保持不变 (数量: ${curAnimes.length})`);
    }
}


// ==============================================================================
// [L12] 弹幕工具层 (Danmaku Utilities)
//
// 私有辅助函数前置定义，保证导出函数调用时已可见
// ==============================================================================

/**
 * 获取弹幕时间戳（秒）
 * 兼容三种格式：
 *   dandan  : p 字符串（"12.5,1,16777215,弹幕文本"）
 *   bilibili: t 字段（数值，单位秒）
 *   legacy  : progress 字段（毫秒）
 * @param {Object} danmu - 弹幕对象
 * @returns {number} 时间戳（秒），解析失败返回 0
 */
function getDanmuTime(danmu) {
    if (danmu.p && typeof danmu.p === 'string') {
        const pTime = parseFloat(danmu.p.split(',')[0]);
        if (!isNaN(pTime)) return pTime;
    }
    if (danmu.t !== undefined && danmu.t !== null) return Number(danmu.t);
    if (typeof danmu.progress === 'number') return danmu.progress / 1000;
    return 0;
}

/**
 * 获取弹幕文本内容
 * 兼容 dandan (m 字段) / bilibili (text 字段) / 其他 (content 字段) 格式
 * @param {Object} danmu - 弹幕对象
 * @returns {string} 文本内容，解析失败返回空字符串
 */
function getDanmuText(danmu) {
    if (danmu) {
        if (typeof danmu.m       === 'string') return danmu.m;
        if (typeof danmu.text    === 'string') return danmu.text;
        if (typeof danmu.content === 'string') return danmu.content;
    }
    return '';
}

/**
 * 弹幕文本标准化
 * 移除所有标点、括号、空白字符并转小写，用于跨源弹幕匹配
 * @param {string} text - 原始文本
 * @returns {string} 标准化后的文本
 */
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\s.,!?"'(){}\[\]<>;:，。！？、""''（）【】《》；：~～]/g, '').toLowerCase();
}

/**
 * 弹幕列表合并工具
 * 合并两个弹幕列表并按时间戳升序排列，兼容所有已知弹幕格式
 * @param {Array} listA - 弹幕列表 A
 * @param {Array} listB - 弹幕列表 B
 * @returns {Array} 合并排序后的弹幕列表
 */
export function mergeDanmakuList(listA, listB) {
    const final = [...(listA || []), ...(listB || [])];
    const getTime = (item) => {
        if (!item) return 0;
        if (item.t !== undefined && item.t !== null) return Number(item.t);
        if (item.p && typeof item.p === 'string') {
            const pTime = parseFloat(item.p.split(',')[0]);
            return isNaN(pTime) ? 0 : pTime;
        }
        return 0;
    };
    final.sort((a, b) => getTime(a) - getTime(b));
    return final;
}

/**
 * 跨源时间轴对齐 (Timeline Alignment)
 * 以 dandan 来源为时间基准，对其他来源计算并应用全局偏移量，
 * 解决不同弹幕源时间戳不一致的问题
 *
 * 采用最大匹配率策略: maxCount / min(dandanCount, sourceCount)
 * 仅当匹配率和集中度都超过阈值时才执行对齐（防误对齐）
 *
 * @param {Array<Array<Object>>} results        - 各源弹幕数组（对应关系由 sourceNames 决定）
 * @param {Array<string>}        sourceNames    - 源名数组（与 results 一一对应）
 * @param {Array<string>}        realIds        - 对应的 ID 数组（仅用于日志）
 * @param {number}               [minMatchRatio=0.8]    - 最小匹配率阈值
 * @param {number}               [offsetThreshold=1]    - 最小触发偏移阈值（秒）
 * @returns {Array<Array<Object>>} 对齐后的各源弹幕数组（原地修改并返回）
 */
export function alignSourceTimelines(results, sourceNames, realIds, minMatchRatio = 0.8, offsetThreshold = 1) {
    const dandanIndex = sourceNames.indexOf('dandan');
    if (dandanIndex === -1 || !results[dandanIndex]?.length) {
        log("info", "[Merge][AlignTimeline] 无 dandan 源或无数据，跳过时间轴对齐");
        return results;
    }

    const dandanList       = results[dandanIndex];
    const dandanTotalCount = dandanList.length;
    // 构建 dandan 弹幕文本→最早时间 的 Map（同文本取最早时间戳）
    const dandanTextMap    = new Map();
    dandanList.forEach(dd => {
        const text = normalizeText(getDanmuText(dd));
        const time = getDanmuTime(dd);
        if (text && (!dandanTextMap.has(text) || time < dandanTextMap.get(text))) {
            dandanTextMap.set(text, time);
        }
    });

    results.forEach((list, idx) => {
        const sourceName = sourceNames[idx];
        if (sourceName === 'dandan' || !list?.length) return;

        const offsetCounts = new Map();
        const parsedCache  = [];
        let matchCount     = 0;

        // 遍历当前源，统计每个偏移量的投票数
        list.forEach(danmu => {
            const text = normalizeText(getDanmuText(danmu));
            const time = getDanmuTime(danmu);
            parsedCache.push({ danmu, time });
            if (text && dandanTextMap.has(text)) {
                matchCount++;
                const offset = Math.round(time - dandanTextMap.get(text));
                offsetCounts.set(offset, (offsetCounts.get(offset) || 0) + 1);
            }
        });

        // 找出得票最多的偏移量
        let bestOffset = 0, maxCount = 0;
        offsetCounts.forEach((count, offset) => {
            if (count > maxCount) { maxCount = count; bestOffset = offset; }
        });

        const minCount         = Math.min(dandanTotalCount, list.length);
        const effectiveRatio   = maxCount / minCount;
        const consensusRatio   = matchCount > 0 ? maxCount / matchCount : 0;

        // 匹配率或集中度过低，跳过此次对齐
        if ((matchCount / minCount) < minMatchRatio || effectiveRatio < 0.05 || consensusRatio < 0.15) {
            log("info", `[Merge][AlignTimeline] ${sourceName}:${realIds[idx]} 匹配率或集中度过低 (有效:${(effectiveRatio * 100).toFixed(1)}%, 集中度:${(consensusRatio * 100).toFixed(1)}%)，跳过对齐`);
            return;
        }
        // 偏移量低于触发阈值，无需对齐
        if (Math.abs(bestOffset) < offsetThreshold) {
            log("info", `[Merge][AlignTimeline] ${sourceName}:${realIds[idx]} 最佳偏移 ${bestOffset}s 低于阈值，无需对齐`);
            return;
        }

        log("info", `[Merge][AlignTimeline] ${sourceName}:${realIds[idx]} 应用偏移 ${bestOffset}s (获 ${maxCount} 票)`);

        // 将偏移量应用到该源所有弹幕（支持三种时间戳格式的原地修改）
        parsedCache.forEach(({ danmu, time }) => {
            const targetTime = Math.max(0, time - bestOffset);
            if (typeof danmu.p === 'string') {
                danmu.p = danmu.p.replace(/^[^,]+(?=,)/, targetTime.toFixed(2));
            }
            if (danmu.t != null) {
                danmu.t = targetTime;
            }
            if (typeof danmu.progress === 'number') {
                danmu.progress = Math.round(targetTime * 1000);
            }
        });
    });

    return results;
}
