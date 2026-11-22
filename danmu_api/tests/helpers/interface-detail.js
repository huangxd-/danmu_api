// 接口详情渲染夹具：DOM 桩、样例 trace 与 HTML_TEMPLATE 页面渲染
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

import { Globals } from '../../configs/globals.js';
import vm from 'node:vm';
import { HTML_TEMPLATE } from '../../ui/template.js';
import { requestRecordsJsContent } from '../../ui/js/requestrecords.js';
import { mainJsContent } from '../../ui/js/main.js';
import { TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS } from '../../utils/pipeline-trace.js';

// 追踪映射由配置目录注册，渲染夹具先完成一次配置加载
Globals.init({ LOG_LEVEL: 'error' });

// 从 main.js 的模板字符串中取出 escapeHtml 源码构造同一实现，避免测试桩与生产实现分叉
const escapeHtmlSource = mainJsContent.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/);
if (!escapeHtmlSource) throw new Error('未能从 main.js 提取 escapeHtml');
const escapeHtml = new Function(escapeHtmlSource[0] + ' return escapeHtml;')();

function makeElement() {
  return {
    innerHTML: '',
    hidden: false,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    onclick: null,
  };
}

// 展示用的配置取值，形状与 handleInterfaceDetail 富化后的全量配置一致
const SAMPLE_CONFIG_VALUES = {
  SOURCE_ORDER: '5 项',
  EPISODE_TITLE_FILTER: '(特别|惊喜|纳凉)?企划(?!(书|案|部))|合伙人手记|超前(营业|vlog)?|速览|vlog|预告(?!(函|信|书|犯))|花絮(独家)?|直拍|(制作|拍摄|幕后|花絮|未播|独家|演员|导演|主创|杀青|探班|收官|开播|先导|彩蛋|NG|回顾|高光|个人|主创)特辑|彩蛋|专访|采访(?!(吸血鬼|鬼))|(正式|角色|先导|概念|首曝|定档|剧情|动画|宣传|主题曲|印象)[\\s\\.]*[PpＰｐ][VvＶｖ]|幕后(?!(主谋|主使|黑手|真凶|玩家|老板|金主|英雄|功臣|推手|大佬|操纵|交易|策划|博弈|BOSS|真相))(故事|花絮|独家)?|直播(陪看|回顾)|未播(片段)?|衍生(?!(品|物|兽))|番外(?!(地|人))|会员(专享|加长|尊享|专属|版)?|片花|精华|看点|速看|解读(?!.*(密文|密码|密电|电报|档案|书信|遗书|碑文|代码|信号|暗号|讯息|谜题|人心|唇语|真相|谜团|梦境))|回顾|影评|解说|盘点|拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|番外彩蛋|精彩片段|精彩看点|精彩集锦|看点解析|看点预告|NG镜头|NG花絮|番外篇|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|插曲|高光回顾|背景音乐|OST|音乐MV|歌曲MV|前季回顾|剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|陪看(记)?|试看版|短剧|精编|Plus|独家版|特别版(?!(图|画))|短片|发布会|解忧局|走心局|火锅局|巅峰时刻|坞里都知道|福持目标坞民|福利篇|(福利|加更|番外|彩蛋|衍生|特别|收官|游戏|整蛊|日常)篇|独家(?!(记忆|试爱|报道|秘方|占有|宠爱|恩宠))|.{2,}(?<!(市|分|警|总|省|卫|药|政|监|结|大|开|破|布|僵|困|骗|赌|胜|败|定|乱|危|迷|谜|入|搅|设|中|残|平|和|终|变|对|安|做|书|画|察|务|案|通|信|育|商|象|源|业|冰))局(?!(长|座|势|面|部|内|外|中|限|促|气))|观察室|上班那点事儿|周top|赛段|VLOG|全纪录|开播|先导|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘(?!(者|人))|(?:^|】\\s*|\\]\\s*)(?:[SC]|SP|OP|ED|PV)\\d+(?:[\\s:：\\.\\-]|$)',
  STRICT_TITLE_MATCH: 'true',
  TITLE_NOISE_FILTER: '0 键',
  ANIME_TITLE_SIMPLIFIED: 'true',
  DANMU_LIMIT: '10000',
  DANMU_OUTPUT_FORMAT: 'ass',
  REMEMBER_LAST_SELECT: 'true',
  USE_BANGUMI_DATA: 'false',
};

const USED_CONFIG_STEPS = {
  SOURCE_ORDER: '搜索·逐源检索',
  TITLE_NOISE_FILTER: '搜索·缓存查询',
  ANIME_TITLE_SIMPLIFIED: '搜索·缓存查询',
  STRICT_TITLE_MATCH: '匹配·搜索与候选评分',
  REMEMBER_LAST_SELECT: '匹配·搜索与候选评分',
  DANMU_LIMIT: '搜索·持久化与响应',
  EPISODE_TITLE_FILTER: '搜索·源合并与过滤',
};

const SAMPLE_CATEGORIES = {
  api: ['TOKEN', 'ADMIN_TOKEN', 'RATE_LIMIT_MAX_REQUESTS'],
  source: ['SOURCE_ORDER', 'MERGE_SOURCE_PAIRS', 'CUSTOM_MERGE_RULES'],
  match: ['STRICT_TITLE_MATCH', 'TITLE_NOISE_FILTER', 'TITLE_MAPPING_TABLE', 'AUTO_MATCH_MAPPING_TABLE', 'AUTO_MATCH_MAPPING_TABLE_URL', 'USE_BANGUMI_DATA'],
  danmu: ['EPISODE_TITLE_FILTER', 'DANMU_LIMIT', 'DANMU_OUTPUT_FORMAT'],
  cache: ['SEARCH_CACHE_MINUTES', 'COMMENT_CACHE_MINUTES'],
  system: ['LOG_LEVEL', 'UI_THEME'],
};

// 已读取配置中可判定命中与否的样例：true 表示改变了处理结果，false 表示读取但未生效
const CONFIG_VERDICTS = {
  TITLE_NOISE_FILTER: true,
  STRICT_TITLE_MATCH: false,
  EPISODE_TITLE_FILTER: false,
  SOURCE_ORDER: true,
};

// 按分类构造全量配置项（71 项环境变量 + 5 项运行态）
function buildSampleConfigs() {
  const byName = {};
  for (const [category, names] of Object.entries(SAMPLE_CATEGORIES)) {
    for (const name of names) byName[name] = category;
  }
  return [
    ...Object.keys(TRACE_CONFIG_ACCESSORS).map(name => ({
      name,
      accessor: TRACE_CONFIG_ACCESSORS[name],
      value: SAMPLE_CONFIG_VALUES[name] !== undefined ? SAMPLE_CONFIG_VALUES[name] : '未设置',
      used: Object.prototype.hasOwnProperty.call(USED_CONFIG_STEPS, name),
      hit: CONFIG_VERDICTS[name],
      step: USED_CONFIG_STEPS[name] || null,
      category: byName[name] || 'system',
      description: name === 'EPISODE_TITLE_FILTER' ? '剧集标题过滤规则' : '',
    })),
    ...Object.keys(TRACE_RUNTIME_ACCESSORS).map(name => ({
      name,
      accessor: TRACE_RUNTIME_ACCESSORS[name],
      value: 'false',
      used: false,
      step: null,
      category: 'runtime',
      description: '请求结束时的运行态，不属于环境变量配置',
    })),
  ];
}

export function buildSampleTrace() {
  return {
    id: '42',
    method: 'GET',
    path: '/api/v2/search/anime',
    query: '?keyword=%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2',
    clientIp: '192.168.1.20',
    statusCode: 200,
    timestamp: Date.UTC(2026, 10, 15, 2, 20, 0),
    totalMs: 486,
    prepareMs: 3,
    handlerMs: 483,
    configs: buildSampleConfigs(),
    diagnosis: {
      chain: [
        { name: '搜索·缓存查询', count: 0, zero: false },
        { name: '搜索·逐源检索', count: 6, zero: false },
        { name: '搜索·结果合并与跨季扩展', count: 11, zero: false },
        { name: '搜索·源合并与过滤', count: 0, zero: true },
        { name: '搜索·持久化与响应', count: 0, zero: true },
        { name: '匹配·映射表加载', count: 0, zero: true },
      ],
      zeroStep: '搜索·源合并与过滤',
      conclusion: '候选结果在「搜索·源合并与过滤」步骤由 11 条候选归零，该步骤的配置生效记录是排查重点。',
    },
    steps: [
      {
        name: '搜索·缓存查询', ms: 2, status: 'miss', reason: '缓存未命中，进入逐源检索',
        inputs: { q: '葬送的芙莉莲', animeId: null }, outputs: { hit: false, count: 0 },
        changes: [
          { config: 'TITLE_NOISE_FILTER', label: '剧名杂音清理', before: '葬送的芙莉莲（真彩）', after: '葬送的芙莉莲', hit: true },
          { config: 'SEARCH_CACHE_MINUTES', label: '搜索缓存键与有效期', before: { keyword: '葬送的芙莉莲', season: null }, after: { cacheKey: '葬送的芙莉莲', ttlMinutes: 3 } },
        ],
      },
      {
        name: '搜索·逐源检索', ms: 402, status: 'ok',
        inputs: { sources: ['bilibili', 'tencent', 'iqiyi', 'youku', 'dandan'] },
        outputs: { count: 6 },
        changes: [
          {
            config: 'SOURCE_ORDER', label: '逐源检索结果', kind: 'stats',
            context: { 检索顺序: '哔哩哔哩 → Animeko → 爱奇艺', 源数量: 3 },
            summary: '3 个源共返回 7 条候选，保留 3 条，1 个源无结果',
            table: {
              columns: ['源', '状态', '原始候选', '保留', '剔除', '说明'],
              rows: [
                { 源: '哔哩哔哩', 状态: '成功', 原始候选: 4, 保留: 2, 剔除: 2, 说明: '剔除 2 条' },
                { 源: 'Animeko', 状态: '成功', 原始候选: 3, 保留: 1, 剔除: 2, 说明: '剔除 2 条' },
                { 源: '爱奇艺', 状态: '失败', 原始候选: 0, 保留: 0, 剔除: 0, 说明: '请求超时' },
              ],
            },
          },
          {
            config: null, label: '默认标题匹配（包含 / 相似度）', kind: 'decision', hit: true,
            context: { 搜索词: '正相反的你与我', 判定规则: '包含匹配 + 相似度（阈值 0.8）', 按源判定: 'animeko 1、bilibili 1、tencent 1' },
            summary: '共 3 个标题判定：命中 2 个、未命中 1 个；判定按标题逐条计数，同源多个标题可归为一条、部分源前置预筛不登记，故判定数与候选数可能不相等；标题命中不代表进入最终结果——来源还会按分集可用性、季过滤、来源自有规则继续筛选',
            kept: [
              { value: '正相反的你与我', source: 'tencent' },
              { value: '正相反的你与我(2026)【电影】from bilibili', source: 'bilibili', reason: '港澳台资源不做标题匹配，直接保留' },
            ], keptCount: 2,
            removed: [{ value: '正反対な君と僕', aliases: ['相反的你和我'], reason: '包含匹配与相似度匹配均未命中', source: 'animeko' }],
            removedCount: 1,
          },
        ],
      },
      {
        name: '搜索·结果合并与跨季扩展', ms: 48, status: 'ok', inputs: { rawCount: 6 },
        outputs: { mergedCount: 11, crossSeasonApplied: true, count: 11 },
      },
      {
        name: '搜索·源合并与过滤', ms: 26, status: 'empty', reason: '剧名或集标题过滤后候选归零',
        inputs: { filtersApplied: ['strictTitleMatch', 'blockedWords'], beforeCount: 11 },
        outputs: { filteredCount: 0, removedBy: 11, count: 0 },
        changes: [
          { config: 'ANIME_TITLE_FILTER', label: '剧名过滤', before: { animeCount: 11 }, after: { animeCount: 0 }, hit: true, removed: [{ value: '葬送的芙莉莲 特别篇' }], removedCount: 1 },
        ],
      },
      {
        name: '搜索·持久化与响应', ms: 8, status: 'fail', reason: '写回搜索缓存时失败，不影响本次响应',
        error: '写入缓存失败', outputs: { finalCount: 0, count: 0 },
      },
      {
        name: '匹配·映射表加载', ms: 1, status: 'skip', reason: '未配置映射表',
        inputs: { titleMappingTable: false, autoMatchMappingTable: false }, outputs: { mappingHit: false, count: 0 },
      },
    ],
  };
}

// 在最小 DOM 桩上执行 requestrecords.js，返回可直接调用渲染函数的上下文与元素表
export function createRequestRecordsSandbox(records = []) {
  const elements = {};
  const getElement = id => {
    if (!elements[id]) elements[id] = makeElement();
    return elements[id];
  };
  // 页面滚动锁定由 main.js 提供，这里只记录调用次数供断言
  let scrollLocks = 0;
  const context = vm.createContext({
    document: {
      getElementById: getElement,
      addEventListener() {},
      querySelector() { return null; },
    },
    window: {},
    console,
    setTimeout() {},
    escapeHtml,
    uiIcon: () => '',
    buildApiUrl: value => value,
    lockPageScroll() { scrollLocks += 1; },
    unlockPageScroll() { scrollLocks -= 1; },
    fetch: async () => ({ ok: true, json: async () => ({ records, todayReqNum: records.length }) }),
  });
  vm.runInContext(requestRecordsJsContent, context);
  return { context, elements, getScrollLocks: () => scrollLocks };
}

// 执行前端渲染，返回接口详情片段与请求记录列表片段
async function renderParts(trace, records) {
  const { context, elements } = createRequestRecordsSandbox(records);
  context.renderInterfaceDetail(trace);
  await context.renderRequestRecords();
  return {
    detailHtml: elements['interface-detail-content'].innerHTML,
    recordsHtml: elements['request-records-list'].innerHTML,
  };
}

// 仅渲染接口详情片段，供结构与样式覆盖校验使用
export async function renderInterfaceDetailHtml(trace = buildSampleTrace()) {
  return (await renderParts(trace, [])).detailHtml;
}

// 渲染完整页面：弹窗默认展开且已填入详情，请求记录列表也已渲染
export async function renderInterfaceDetailPage(trace = buildSampleTrace(), records = [
  { interface: '/api/v2/search/anime', requestId: trace.id, method: 'GET', clientIp: '192.168.1.20', timestamp: trace.timestamp, params: { keyword: '葬送的芙莉莲' } },
  { interface: '/api/v2/match', requestId: null, method: 'POST', clientIp: '192.168.1.20', timestamp: trace.timestamp - 60000, params: {} },
]) {
  const { detailHtml, recordsHtml } = await renderParts(trace, records);

  return HTML_TEMPLATE
    .replace('<div class="modal" id="interface-detail-modal" aria-hidden="true">',
      '<div class="modal active" id="interface-detail-modal" aria-hidden="false">')
    .replace('<div id="interface-detail-loading" class="interface-detail-loading">加载中…</div>',
      '<div id="interface-detail-loading" class="interface-detail-loading" hidden>加载中…</div>')
    .replace('<div id="interface-detail-content" class="interface-detail-content" hidden></div>',
      `<div id="interface-detail-content" class="interface-detail-content">${detailHtml}</div>`)
    .replace('<div class="request-records-container" id="request-records-list"></div>',
      `<div class="request-records-container" id="request-records-list">${recordsHtml}</div>`);
}
