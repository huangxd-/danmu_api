// 请求级追踪：记录每个请求的阶段耗时、实际读到的配置项与接口处理流水的输入/输出
// 异步上下文由服务端入口注入，浏览器端插件等无 Node 异步上下文的运行环境不启用追踪

// 追踪记录保留条数，与 globals.MAX_RECORDS 保持一致，使请求记录与详情一一对应
export const MAX_PIPELINE_RECORDS = 100;

// 单个步骤保留的候选样本条数；判定计数不设上限，样本仅用于展示
// 取值覆盖常规搜索的候选规模，超出时仅作为超大结果的保护上限
const MAX_DECISION_SAMPLES = 200;

// 敏感配置项只登记是否存在，不登记取值；由 Envs.load 按 envVarConfig 的 sensitive 字段注册
const SENSITIVE_CONFIG_KEYS = new Set();

// 暴露敏感项副本，供配置目录一致性校验
export function getSensitiveConfigKeys() {
  return [...SENSITIVE_CONFIG_KEYS];
}

// 可配置项的大写名 → globals 访问器，由 Envs.load 时按 envVarConfig 的 accessor 字段注册
export const TRACE_CONFIG_ACCESSORS = {};

// 用同一份配置目录建立追踪映射与敏感项名单，避免多处维护同一份对应关系
export function registerTraceConfigAccessors(config) {
  for (const key of Object.keys(TRACE_CONFIG_ACCESSORS)) delete TRACE_CONFIG_ACCESSORS[key];
  SENSITIVE_CONFIG_KEYS.clear();
  for (const [name, meta] of Object.entries(config || {})) {
    if (!meta || typeof meta.accessor !== 'string') continue;
    TRACE_CONFIG_ACCESSORS[name] = meta.accessor;
    if (meta.sensitive === true) SENSITIVE_CONFIG_KEYS.add(meta.accessor);
  }
}

// 运行态取值不属于环境变量配置，展示在「运行环境」分组，取值随请求结束时的缓存/AI 状态而定
export const TRACE_RUNTIME_ACCESSORS = {
  localCacheValid: 'localCacheValid',
  redisValid: 'redisValid',
  localRedisValid: 'localRedisValid',
  aiValid: 'aiValid',
  deployPlatform: 'deployPlatform',
};

let records = [];

// 请求追踪序号，作为 trace 唯一标识，用于请求记录与接口详情关联
// 随机前缀延迟到首次创建 trace 时生成：Cloudflare Workers 禁止在模块全局作用域生成随机值
let traceNonce;
function getTraceNonce() {
  if (!traceNonce) {
    traceNonce = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return traceNonce;
}
let traceSeq = 0;
const activeTraces = new Set();

// 异步上下文存储；未注入时追踪不启用
let traceStorage = null;

// 取当前请求的追踪上下文；追踪对象、活动步骤与待归并的数据变换随请求隔离
function currentTraceContext() {
  if (!traceStorage) return null;
  return traceStorage.getStore() || null;
}

// 注入异步上下文实现，由服务端入口在启动时调用
export function useAsyncLocalStorage(ctor) {
  traceStorage = new ctor();
}

// 把配置取值整理为可展示的形式
function formatConfigValue(value) {
  if (value === null || value === undefined) return '未设置';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 0 ? value : '未设置';
  if (value instanceof RegExp) return value.source;
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value instanceof Map) return `${value.size} 项`;
  if (typeof value === 'object') return `${Object.keys(value).length} 键`;
  return String(value);
}

// 敏感配置只登记是否存在；读取捕获与详情补齐共用同一规则
export function describeConfigValue(key, value) {
  if (SENSITIVE_CONFIG_KEYS.has(key)) return value === null || value === undefined || value === '' ? '未设置' : '已设置';
  return formatConfigValue(value);
}

// 登记一次配置读取；未开启追踪的请求不产生任何开销
export function recordConfigAccess(key, value) {
  const context = currentTraceContext();
  const trace = context?.trace;
  if (!trace) return;
  if (Object.prototype.hasOwnProperty.call(trace.configs, key)) return;
  trace.configs[key] = {
    value: describeConfigValue(key, value),
    used: true,
    step: context.activeStep,
  };
}

// 记录配置项的实际作用结果：命中视为已读取，未命中同样说明该配置被读取但未发挥作用
function markConfigVerdict(trace, configName, hit, step) {
  const accessor = TRACE_CONFIG_ACCESSORS[configName];
  if (!accessor) return;
  // 生效登记可能早于读取，此时不写 value，内存形态与落盘后恢复的形态保持一致
  const entry = trace.configs[accessor] || (trace.configs[accessor] = { used: true, step });
  entry.used = true;
  if (!entry.step) entry.step = step;
  // 首次读取可能早于真正生效的步骤，单独记录生效步骤供界面定位到流水线对应环节
  if (step && !entry.effectStep) entry.effectStep = step;
  if (typeof hit === 'boolean') entry.hit = hit;
}

// 累加同类数值字段：合并链接等场景下同一配置在一次步骤内多次生效，计数需要求和
function sumNumeric(target, source) {
  if (typeof source === 'number' && typeof target === 'number') return target + source;
  if (target && source && typeof target === 'object' && typeof source === 'object' && !Array.isArray(target)) {
    const out = { ...target };
    for (const key of Object.keys(source)) out[key] = sumNumeric(target[key], source[key]);
    return out;
  }
  return source === undefined ? target : source;
}

// 登记一次配置生效的数据变换：处理前后取值、命中规则、保留与剔除的候选项
// sum 为真时与本次步骤内同配置的记录合并计数；候选列表按样本上限截断并保留完整计数
export function recordConfigEffect(config, effect) {
  const context = currentTraceContext();
  if (!context) return;
  const trimmed = { ...effect };
  if (trimmed.sum) {
    const existing = context.effects.find(item => item.config === config && item.sum);
    if (existing) {
      for (const key of ['before', 'after', 'keptCount', 'removedCount']) {
        if (trimmed[key] !== undefined) existing[key] = sumNumeric(existing[key], trimmed[key]);
      }
      if (Array.isArray(trimmed.kept)) existing.kept = [...(existing.kept || []), ...trimmed.kept].slice(0, MAX_DECISION_SAMPLES);
      if (Array.isArray(trimmed.removed)) existing.removed = [...(existing.removed || []), ...trimmed.removed].slice(0, MAX_DECISION_SAMPLES);
      if (typeof trimmed.hit === 'boolean') existing.hit = Boolean(existing.hit) || trimmed.hit;
      markConfigVerdict(context.trace, config, existing.hit, context.activeStep);
      return;
    }
  }
  for (const [listKey, countKey] of [['kept', 'keptCount'], ['removed', 'removedCount']]) {
    if (Array.isArray(trimmed[listKey]) && trimmed[listKey].length > MAX_DECISION_SAMPLES) {
      trimmed[countKey] = trimmed[listKey].length;
      trimmed[listKey] = trimmed[listKey].slice(0, MAX_DECISION_SAMPLES);
    }
  }
  markConfigVerdict(context.trace, config, trimmed.hit, context.activeStep);
  context.effects.push({ config, ...trimmed });
}

// 合并标题组：同源内共享标题文本的主标题与别名合并为一个结果；不同源的同一标题是不同候选，不合并
function mergeTitleGroups(groups) {
  const nodes = groups.map(group => ({ ...group, variants: [...group.variants] }));
  const merged = new Set();
  for (const node of nodes) {
    if (merged.has(node)) continue;
    // 反复吸收共享任一标题文本的节点，直到没有新节点可并入，形成别名闭包
    let grew = true;
    const cluster = [node];
    merged.add(node);
    while (grew) {
      grew = false;
      for (const other of nodes) {
        if (merged.has(other)) continue;
        // 跨源结果不合并：不同源的同一标题是不同候选
        if (other.source !== node.source) continue;
        const texts = [other.title, ...other.variants];
        if (!texts.some(text => cluster.some(item => item.title === text || item.variants.includes(text)))) continue;
        cluster.push(other);
        merged.add(other);
        grew = true;
      }
    }
    const title = cluster.find(item => item.title)?.title || '';
    const variants = [];
    let matched = false;
    let reason = '';
    const sources = new Set();
    for (const item of cluster) {
      for (const text of [item.title, ...item.variants]) {
        if (text && text !== title && !variants.includes(text)) variants.push(text);
      }
      if (item.matched) matched = true;
      if (!reason && item.reason) reason = item.reason;
      if (item.source) sources.add(item.source);
    }
    node.cluster = { title, variants, matched, reason, sources: [...sources] };
  }
  return nodes.filter(node => node.cluster).map(node => node.cluster);
}

// 把标题判定桶整理为一条可展示的记录：结果按作品聚合，计数以作品为单位
function composeTitleDecision(bucket) {
  const clusters = mergeTitleGroups([...bucket.groups.values()]);
  // 候选项统一为 { value, aliases?, reason?, source? }，主标题与别名分开记录，空字段不输出
  const toItem = cluster => {
    const item = { value: cluster.title };
    if (cluster.variants.length > 0) item.aliases = cluster.variants;
    if (cluster.reason) item.reason = cluster.reason;
    if (cluster.sources.length > 0) item.source = cluster.sources.join('、');
    return item;
  };
  const kept = clusters.filter(cluster => cluster.matched);
  const removed = clusters.filter(cluster => !cluster.matched);
  // 按来源统计判定次数：部分源在返回结果前已按标题过滤，其判定不计入逐源候选数
  const sourceCounts = new Map();
  for (const group of bucket.groups.values()) {
    const name = group.source || '未标注来源';
    sourceCounts.set(name, (sourceCounts.get(name) || 0) + 1);
  }
  const sourceBreakdown = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source} ${count}`)
    .join('、');
  return {
    config: bucket.config,
    label: bucket.label,
    kind: 'decision',
    hit: removed.length > 0,
    // 按源判定次数是独立事实：同一结果可能被多个源分别判定，不等于结果数
    context: { 搜索词: bucket.query, 判定规则: bucket.mode, 按源判定: sourceBreakdown || '未标注来源' },
    // 口径说明：判定与逐源保留数互不蕴含——季过滤在判定之后剔除候选，季边界收敛与
    // 预筛判定不登记，因此命中数可少于也可多于逐源保留数
    summary: `共 ${kept.length + removed.length} 个标题判定：命中 ${kept.length} 个、未命中 ${removed.length} 个；`
      + '判定按标题逐条计数，同源多个标题可归为一条、部分源前置预筛不登记，故判定数与候选数可能不相等；'
      + '标题命中不代表进入最终结果——来源还会按分集可用性、季过滤、来源自有规则继续筛选',
    keptCount: kept.length,
    removedCount: removed.length,
    kept: kept.slice(0, MAX_DECISION_SAMPLES).map(toItem),
    removed: removed.slice(0, MAX_DECISION_SAMPLES).map(toItem),
  };
}

// 登记一次候选标题的匹配判定；同一候选的多个标题（主标题与别名）通过 group 归为一个结果
// config 为影响该判定的配置项，默认匹配规则不对应环境变量时留空并由 label 说明
export function recordTitleDecision({ config = null, label, group, source, query, mode, value, matched, reason }) {
  const context = currentTraceContext();
  if (!context) return;
  const key = config || label;
  let bucket = context.decisions.get(key);
  if (!bucket) {
    bucket = { config, label, query: query || '', mode: mode || '', groups: new Map() };
    context.decisions.set(key, bucket);
  }
  // 标题为空的调用没有候选可展示，不登记
  const title = String(group || value || '').trim();
  if (!title) return;
  // 分组键包含来源：同一标题在不同源是不同候选，合并展示会让候选数与逐源统计对不上
  const groupKey = `${source || ''}\u0000${title}`;
  const text = String(value ?? '');
  let entry = bucket.groups.get(groupKey);
  if (!entry) {
    entry = { title, variants: [], matched: false, reason: '', source: source || '' };
    bucket.groups.set(groupKey, entry);
  }
  if (text && text !== title && !entry.variants.includes(text)) entry.variants.push(text);
  if (matched) entry.matched = true;
  else if (!entry.reason) entry.reason = reason || '';
}

// 在给定追踪对象的作用域内执行函数；活动步骤与数据变换存于该作用域，不随并发请求串扰
export function runWithTrace(trace, fn) {
  if (!traceStorage) return fn();
  return traceStorage.run({ trace, activeStep: null, effects: [], decisions: new Map(), stepTimings: [] }, fn);
}

// 取当前请求的追踪对象
export function currentTrace() {
  return currentTraceContext()?.trace || null;
}

// 在步骤业务逻辑前标记活动步骤名，使该步骤期间的配置读取归属到该步骤
export function markStepActive(name) {
  const context = currentTraceContext();
  if (context) context.activeStep = name || null;
}

// 步骤是否有实际耗时：零耗时步骤多为状态标记，不作为嵌套子步骤计入
function childHasDuration(timing) {
  return timing.endedAt - timing.startedAt > 0;
}

// 记录一个阶段的耗时、输入输出与本阶段归并的配置生效记录
export function traceStep(name, startedAt, detail) {
  const context = currentTraceContext();
  const trace = context?.trace;
  if (!trace) return;
  const endedAt = Date.now();
  const elapsed = Math.max(0, endedAt - startedAt);
  // 识别在当前步骤区间内完成的子步骤：子步骤先记录，父步骤后记录，父步骤只保留独占耗时
  let nestedMs = 0;
  for (const timing of context.stepTimings) {
    // 子步骤须在父开始后启动、结束不晚于父；同一毫秒启动视为在父区间内，父之前启动的步骤不认领
    if (timing.startedAt < startedAt || timing.endedAt > endedAt || timing.claimed) continue;
    if (!childHasDuration(timing)) continue;
    timing.claimed = true;
    timing.step.nested = true;
    // 多层嵌套时子步骤自身已扣除其子步骤，这里取含子步骤的总耗时，避免重复计入
    nestedMs += timing.step.totalMs || timing.step.ms || 0;
  }
  const step = { name, ms: Math.max(0, elapsed - nestedMs) };
  if (nestedMs > 0) step.totalMs = elapsed;
  context.stepTimings.push({ startedAt, endedAt, step, claimed: false });
  if (detail && typeof detail === 'object') {
    if (detail.status !== undefined) step.status = detail.status;
    if (detail.reason !== undefined) step.reason = detail.reason;
    if (detail.inputs !== undefined) step.inputs = detail.inputs;
    if (detail.outputs !== undefined) step.outputs = detail.outputs;
    // 步骤级表格用于承载逐条明细（如命中候选的评分），与输入输出分开渲染
    if (detail.table !== undefined) step.table = detail.table;
    if (detail.error !== undefined) step.error = detail.error;
  }
  const decisions = [...context.decisions.values()].map(bucket => {
    const change = composeTitleDecision(bucket);
    markConfigVerdict(trace, change.config, change.hit, context.activeStep);
    return change;
  });
  // sum 只是合并阶段的标记，不进入步骤记录
  const effects = context.effects.map(({ sum, ...effect }) => effect);
  const changes = [...effects, ...decisions];
  if (changes.length > 0) step.changes = changes;
  context.effects = [];
  context.decisions = new Map();
  trace.steps.push(step);
}

// 读取当前步骤尚未归并的配置生效记录；供步骤打点在收尾前汇总过程数量
export function peekConfigEffects() {
  const context = currentTraceContext();
  if (!context) return [];
  return context.effects.map(({ sum, ...effect }) => effect);
}

// 按阶段顺序记录步骤：每次记录后重置起点，使相邻步骤的耗时互不重叠
export function createPhaseTimer() {
  let startedAt = Date.now();
  return function recordPhase(name, detail) {
    traceStep(name, startedAt, detail);
    startedAt = Date.now();
  };
}

// 标记通用准备段结束，其余耗时归入接口处理段
export function markHandlerStart(startedAt) {
  const trace = currentTrace();
  if (!trace) return;
  trace.prepareMs = Math.max(0, Date.now() - startedAt);
}

// 建立一条请求追踪记录
export function createTrace(method, path, clientIp) {
  const trace = {
    id: `${getTraceNonce()}-${++traceSeq}`,
    method,
    path,
    query: '',
    clientIp: clientIp || 'unknown',
    statusCode: null,
    timestamp: Date.now(),
    startedAt: Date.now(),
    totalMs: 0,
    prepareMs: 0,
    handlerMs: 0,
    steps: [],
    configs: {},
  };
  activeTraces.add(trace);
  return trace;
}

// 结束并留存一条追踪记录；重复调用只生效首次，保持记录列表与落盘钩子的幂等
export function finishTrace(trace, retain = true) {
  if (!trace || trace.finished) return;
  trace.finished = true;
  activeTraces.delete(trace);
  // 页面、静态资源与详情查询不产生请求记录，其追踪不占用留存名额
  if (!retain) return;
  trace.totalMs = Math.max(0, Date.now() - trace.startedAt);
  // 准备段为请求解析与鉴权，其余耗时归接口处理
  trace.handlerMs = Math.max(0, trace.totalMs - trace.prepareMs);
  // 只保留本次请求实际读取到的配置；未读取项由详情接口按配置目录补齐
  records.push(trace);
  trimRecords();
  // 详情与请求记录同批落盘：查询缓存写入不覆盖弹幕等不触发缓存写入的请求
  if (tracePersistHook) tracePersistHook();
}

export function buildResultDiagnosis(steps) {
  const list = steps || [];
  const subject = resolveResultSubject(list);
  // 缓存未命中是「本次未从缓存取数」的正常流转，其 0 不代表产出归零；命中时 count 才是真实产出
  // 步骤内部有处理过程时（rawCount 与 count 不同），链上以「处理前 → 处理后」呈现该步的数量变化
  const chain = list
    .filter(step => step.outputs && Number.isFinite(step.outputs.count) && step.status !== 'miss')
    .map(step => ({
      name: step.name,
      count: step.outputs.count,
      rawCount: Number.isFinite(step.outputs.rawCount) && step.outputs.rawCount !== step.outputs.count
        ? step.outputs.rawCount : undefined,
    }));
  if (chain.length === 0) {
    // 没有数量可链时优先指出中断的步骤：失败、跳过或明确未找到的步骤就是本次请求没有结果的原因
    // 按严重程度取最后一个：fail（异常）> skip（前置条件不满足）> miss（资源未找到）
    const reversed = [...list].reverse();
    const last = list[list.length - 1];
    // 按严重程度取原因：异常 > 前置条件不满足 > 未找到目标
    // 中间步骤的 miss 是正常流转（本地弹幕、缓存未命中都会继续后续步骤），只有末步 miss 才说明请求因此结束
    const stopped = reversed.find(step => step.status === 'fail')
      || reversed.find(step => step.status === 'skip')
      || reversed.find(step => step.status === 'empty' && step.reason)
      || (last && last.status === 'miss' && last.reason ? last : null);
    if (stopped) {
      return {
        chain: [],
        zeroStep: stopped.name,
        conclusion: `${stopped.name}${stopped.reason ? '：' + stopped.reason : '未产出结果'}。`,
      };
    }
    // 删除收藏、设置定时等写操作没有数量输出，成功步骤的说明本身即完整结论
    const finished = reversed.find(step => step.status === 'ok' && step.reason);
    if (finished) {
      return { chain: [], zeroStep: null, conclusion: `${finished.reason}。` };
    }
    if (list.length === 0) {
      return { chain: [], zeroStep: null, conclusion: '本次请求未进入处理流水线，请结合状态码与接口参数排查。' };
    }
    return { chain: [], zeroStep: null, conclusion: '本次请求未记录结果数量，请按步骤查看输入、输出与配置生效记录。' };
  }
  const lastPositive = chain.reduce((last, item, index) => (item.count > 0 ? index : last), -1);
  const zeroIndex = chain.findIndex((item, index) => index > lastPositive && item.count === 0);
  const withFlags = chain.map((item, index) => ({ ...item, zero: zeroIndex !== -1 && index >= zeroIndex }));
  const zeroStep = zeroIndex === -1 ? null : chain[zeroIndex].name;

  // 匹配接口只保留 1 条结果，用候选数与命中源说明过程，而不是重复「保留 1 条」
  const matchOutcome = describeMatchOutcome(list);
  if (matchOutcome) return { chain: withFlags, zeroStep, conclusion: matchOutcome };
  const favoriteOutcome = describeFavoriteOutcome(list);
  if (favoriteOutcome) return { chain: withFlags, zeroStep, conclusion: favoriteOutcome };
  const fongmiOutcome = describeFongmiOutcome(list);
  if (fongmiOutcome) return { chain: withFlags, zeroStep, conclusion: fongmiOutcome };

  if (zeroIndex === -1) {
    const base = `本次请求最终${subject.verb} ${chain[chain.length - 1].count} ${subject.unit}`;
    const detail = [describeCacheHit(list), describeDanmakuOffset(list)].filter(Boolean).join('，');
    return { chain: withFlags, zeroStep: null, conclusion: appendDetail(base, detail) };
  }
  // 归零点紧邻最后一个正数结果，前一步的数量即归零前的数量
  // 全程为 0 时按步骤状态区分：明确失败才提示排查，无结果但无失败给出排查入口，全部正常则如实陈述为空
  const failure = list.find(step => step.status === 'fail' || step.error);
  const noResult = list.some(step => step.status === 'empty');
  // 前置条件不满足而跳过的步骤（如搜索词为空）不是「正常返回」，应说明跳过原因
  const skipped = list.find(step => step.status === 'skip' && step.reason);
  // 是否存在逐源明细取决于步骤里是否真的带了明细表格（收藏等复用搜索流水线的接口同样会有）
  const hasSourceBreakdown = (list || []).some(step => (step.changes || []).some(change => change.table));
  const base = lastPositive === -1
    ? (failure
      ? `${subject.label}在「${failure.name}」步骤失败，请查看该步骤的错误信息`
      : noResult
        ? `${subject.label}自「${chain[zeroIndex].name}」步骤起未获得结果${hasSourceBreakdown ? '，逐源明细可查看各源返回情况' : ''}`
        : skipped
          ? `本次请求在「${skipped.name}」步骤跳过：${skipped.reason}`
          : `本次请求最终${subject.verb} 0 ${subject.unit}，各步骤均正常返回`)
    : `${subject.label}在「${chain[zeroIndex].name}」步骤由 ${chain[lastPositive].count} ${subject.unit}归零，请结合该步骤的输入输出${hasSourceBreakdown ? '、逐源明细' : ''}与配置生效记录确认原因`;
  return { chain: withFlags, zeroStep, conclusion: appendDetail(base, describeDanmakuOffset(list)) };
}

// 在主结论后补充过程说明，保持一句话表述
function appendDetail(base, detail) {
  return detail ? `${base}（${detail}）。` : `${base}。`;
}

// 弹幕地址查询串中的凭据类参数在登记前替换为掩码；名单与请求路径的查询串遮罩共用同一套语义
const TRACE_CREDENTIAL_PARAMS = new Set([
  'token', 'admintoken', 'accesstoken', 'refreshtoken', 'apikey', 'key',
  'secret', 'password', 'passwd', 'auth', 'authorization', 'sign', 'signature', 'sig',
]);

// 合并弹幕链接使用与 merge-util 相同的分隔符；此处保留本地常量以避免循环依赖
const TRACE_URL_DELIMITER = '$$$';

function isTraceCredentialParam(key) {
  return TRACE_CREDENTIAL_PARAMS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

// 遮罩一组查询参数中的凭据，并递归处理 HTTP URL 值
function maskTraceParams(params) {
  for (const key of [...params.keys()]) {
    if (isTraceCredentialParam(key)) {
      params.set(key, '***');
      continue;
    }
    const value = params.get(key);
    if (value && /^https?:\/\//i.test(value.trim())) {
      params.set(key, maskCredentialParams(value));
    }
  }
}

// 遮罩单个 URL 的查询串，保留 fragment
function maskSingleUrlCredentials(text) {
  const hashIndex = text.indexOf('#');
  const fragment = hashIndex === -1 ? '' : text.slice(hashIndex);
  const withoutFragment = hashIndex === -1 ? text : text.slice(0, hashIndex);
  const qIndex = withoutFragment.indexOf('?');
  if (qIndex === -1) return text;

  const base = withoutFragment.slice(0, qIndex);
  const params = new URLSearchParams(withoutFragment.slice(qIndex + 1));
  maskTraceParams(params);
  const query = params.toString();
  return `${base}${query ? `?${query}` : ''}${fragment}`;
}

// 对登记进步骤输入的弹幕地址遮蔽凭据参数，保留路径与非凭据参数以便排查
export function maskCredentialParams(targetUrl) {
  return String(targetUrl ?? '')
    .split(TRACE_URL_DELIMITER)
    .map(maskSingleUrlCredentials)
    .join(TRACE_URL_DELIMITER);
}

// 对请求查询串做与弹幕地址一致的凭据遮罩
export function maskTraceQueryString(search) {
  if (!search) return '';
  const params = new URLSearchParams(search);
  maskTraceParams(params);
  const text = params.toString();
  return text ? `?${text}` : '';
}

// 按输出字段识别步骤用途：步骤名仅用于展示，改名不影响诊断
function findStepOutputs(steps, predicate) {
  for (let i = (steps || []).length - 1; i >= 0; i--) {
    const outputs = steps[i].outputs;
    if (outputs && predicate(outputs)) return outputs;
  }
  return null;
}

// 按字段识别步骤用途，同时查看输入与输出：偏移等数据落在步骤输入里
function findStepData(steps, predicate) {
  for (let i = (steps || []).length - 1; i >= 0; i--) {
    for (const data of [steps[i].outputs, steps[i].inputs]) {
      if (data && predicate(data)) return data;
    }
  }
  return null;
}

// 匹配结果：候选数与命中源
function describeMatchOutcome(steps) {
  const outputs = findStepOutputs(steps, item => Number.isFinite(item.candidateCount));
  if (!outputs) return null;
  if (outputs.matched) {
    // 非管理员看到的源名已打码，省略该词避免出现「匹配到 1 条 *** 候选」这类表述
    const source = outputs.source && outputs.source !== '***' ? ` ${outputs.source} ` : '';
    return `本次请求从 ${outputs.candidateCount} 条候选中匹配到 1 条${source}候选。`;
  }
  return `本次请求从 ${outputs.candidateCount} 条候选中未匹配到结果。`;
}

// FongMi 返回的是可选弹幕地址列表，其数量与「弹幕条数」无关，单独表述避免误读
function describeFongmiOutcome(steps) {
  const outputs = findStepOutputs(steps, item => '候选地址数' in item);
  if (!outputs) return null;
  if (outputs.候选地址数 === 0) {
    // 候选为 0 时说明原因（如候选剧集无可用弹幕地址），避免只报一个 0
    const reason = (steps || []).slice().reverse().find(step => step.status === 'empty' && step.reason)?.reason;
    return reason ? `本次请求未返回弹幕候选地址：${reason}。` : '本次请求未返回弹幕候选地址。';
  }
  return `本次请求返回 ${outputs.候选地址数} 个弹幕候选地址。`;
}

// 收藏写入以「已收藏 + 候选数」表述，避免把搜索候选数说成收藏条数；名称由明细展示，结论不携带以便统一脱敏
function describeFavoriteOutcome(steps) {
  const added = findStepOutputs(steps, item => '写入剧集数' in item);
  if (added) return `本次请求已收藏，写入 ${added.写入剧集数} 条候选剧集。`;
  // 刷新复用搜索流水线，其候选数不代表收藏条数，用刷新结果单独表述
  const refreshed = findStepOutputs(steps, item => 'animeTitle' in item && !Number.isFinite(item.count));
  const hitRefresh = (steps || []).some(step => step.name.includes('刷新') && step.status === 'ok');
  if (refreshed && hitRefresh) return '本次请求已刷新该收藏的搜索结果。';
  return null;
}

// 弹幕偏移：命中来源规则或链接上标注的偏移时说明实际位移
function describeDanmakuOffset(steps) {
  const outputs = findStepData(steps, item => 'ruleOffset' in item || 'linkOffset' in item);
  if (!outputs) return '';
  const ruleOffset = Number(outputs.ruleOffset) || 0;
  const linkOffset = Number(outputs.linkOffset) || 0;
  // 偏移为负表示弹幕时间提前，为正表示延后；用「提前 / 延迟」比正负秒数更直观
  const describe = (value, percent, source) => {
    if (!value) return '';
    const direction = value < 0 ? '提前' : '延迟';
    return `弹幕${direction} ${Math.abs(value)}${percent ? '%' : ' 秒'}（${source}）`;
  };
  return describe(ruleOffset, outputs.percent, '来源规则') || describe(linkOffset, outputs.linkOffsetPercent, '链接参数');
}

// 缓存命中的请求说明结果来源，避免用户误以为每次都发起外部检索
function describeCacheHit(steps) {
  const outputs = findStepOutputs(steps, item => item.hit === true && 'cachedCount' in item);
  return outputs ? '结果来自缓存' : '';
}

// 结果数量的表述随步骤分类变化：按步骤名前缀取单位，步骤前缀即接口分类
const RESULT_SUBJECTS = {
  弹幕: { label: '弹幕', unit: '条弹幕', verb: '返回' },
  分段弹幕: { label: '弹幕', unit: '条弹幕', verb: '返回' },
  详情: { label: '剧集', unit: '集', verb: '返回' },
  分集: { label: '剧集', unit: '集', verb: '返回' },
  收藏: { label: '收藏', unit: '条收藏', verb: '返回' },
  搜索: { label: '候选结果', unit: '条候选', verb: '保留' },
};

// 取最后一个有结果数量的步骤所属分类，诊断表述与该步骤产出的对象一致
function resolveResultSubject(steps) {
  const named = (steps || []).filter(step => step.outputs && Number.isFinite(step.outputs.count));
  for (let i = named.length - 1; i >= 0; i--) {
    const prefix = named[i].name.split('·')[0];
    if (RESULT_SUBJECTS[prefix]) return RESULT_SUBJECTS[prefix];
  }
  return { label: '候选结果', unit: '条候选', verb: '保留' };
}

// 详情落盘钩子，由部署入口注册；注册前详情只留在内存
let tracePersistHook = null;

export function setTracePersistHook(fn) {
  tracePersistHook = typeof fn === 'function' ? fn : null;
}

// 按 trace id 取单条请求追踪，用于「接口详情」弹窗
export function getInterfaceDetail(id) {
  if (!id) return null;
  const key = String(id);
  return records.find(record => record.id === key) || null;
}

// 取当前留存的追踪记录，供缓存持久化
export function getTraceRecords() {
  return records;
}

// 恢复持久化追踪记录：规范化、去重后再截断，确保保留窗口尽量包含唯一详情
export function replaceTraceRecords(list) {
  const normalized = Array.isArray(list)
    ? list
      .filter(item => item && item.id)
      .map(item => ({
        ...item,
        steps: Array.isArray(item.steps) ? item.steps : [],
        configs: item.configs && typeof item.configs === 'object' && !Array.isArray(item.configs) ? item.configs : {},
      }))
    : [];
  const seen = new Set();
  const unique = [];
  for (let index = normalized.length - 1; index >= 0; index--) {
    const item = normalized[index];
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  records = unique.reverse().slice(-MAX_PIPELINE_RECORDS);

  for (const item of records) bumpTraceSequence(item.id);

  // 恢复发生在请求记录写入前；此处为所有并发在途 trace 消除与历史快照的 id 冲突
  const usedIds = new Set(records.map(item => String(item.id)));
  for (const trace of activeTraces) {
    if (!usedIds.has(String(trace.id))) {
      usedIds.add(String(trace.id));
      continue;
    }
    do {
      trace.id = `${getTraceNonce()}-${++traceSeq}`;
    } while (usedIds.has(trace.id));
    usedIds.add(trace.id);
  }
}

// 兼容旧版纯数字 id：抬高进程内序号，避免旧详情与新记录继续重号
export function bumpTraceSequence(id) {
  const text = String(id ?? '');
  if (!/^\d+$/.test(text)) return;
  const value = Number(text);
  if (Number.isSafeInteger(value)) traceSeq = Math.max(traceSeq, value);
}

// 清空追踪记录
export function clearTraceRecords() {
  records = [];
}

function trimRecords() {
  if (records.length > MAX_PIPELINE_RECORDS) {
    records = records.slice(-MAX_PIPELINE_RECORDS);
  }
}
