// 接口详情追踪：trace 创建、步骤打点、配置捕获、配置生效记录与查询

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Globals } from '../../configs/globals.js';
import {
  createTrace, traceStep, markStepActive, recordConfigAccess, recordConfigEffect,
  recordTitleDecision, runWithTrace, currentTrace,
  finishTrace, getInterfaceDetail, getTraceRecords, replaceTraceRecords, buildResultDiagnosis, setTracePersistHook, useAsyncLocalStorage, MAX_PIPELINE_RECORDS,
  TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS, getSensitiveConfigKeys, describeConfigValue, bumpTraceSequence, registerTraceConfigAccessors, markHandlerStart, createPhaseTimer,
} from '../../utils/pipeline-trace.js';

// 用同步可用的存储桩替代 AsyncLocalStorage，使 currentTrace 在 runWithTrace 作用域内可取
// 追踪映射由配置目录注册，测试进程先完成一次配置加载
Globals.init({ LOG_LEVEL: 'error' });

class StubStorage {
  constructor() { this._store = null; }
  run(store, fn) { const prev = this._store; this._store = store; try { return fn(); } finally { this._store = prev; } }
  getStore() { return this._store; }
}

const traceSeqOf = id => Number(String(id).slice(String(id).lastIndexOf('-') + 1));

test('createTrace 生成唯一且进程内递增的 id，并初始化耗时与容器', () => {
  useAsyncLocalStorage(StubStorage);
  const a = createTrace('GET', '/api/v2/search');
  const b = createTrace('POST', '/api/v2/match');
  assert.equal(traceSeqOf(a.id), 1);
  assert.equal(traceSeqOf(b.id), traceSeqOf(a.id) + 1);
  assert.notEqual(a.id, b.id);
  assert.equal(a.method, 'GET');
  assert.equal(a.path, '/api/v2/search');
  assert.equal(a.clientIp, 'unknown');
  assert.equal(a.totalMs, 0);
  assert.equal(a.prepareMs, 0);
  assert.equal(a.handlerMs, 0);
  assert.deepEqual(a.steps, []);
  assert.deepEqual(a.configs, {});
});

test('不同模块实例生成的 trace id 前缀不同', async () => {
  const first = await import('../../utils/pipeline-trace.js?instance=first');
  const second = await import('../../utils/pipeline-trace.js?instance=second');
  const a = first.createTrace('GET', '/a');
  const b = second.createTrace('GET', '/b');
  assert.notEqual(a.id, b.id, '不同实例不得从相同序号生成同一个 id');
});

test('createTrace 记录客户端 IP', () => {
  const t = createTrace('GET', '/x', '9.9.9.9');
  assert.equal(t.clientIp, '9.9.9.9');
});

test('traceStep 在 runWithTrace 作用域内记录 name/ms/detail', () => {
  const trace = createTrace('GET', '/api/v2/search');
  runWithTrace(trace, () => {
    traceStep('搜索·缓存查询', Date.now() - 5, { status: 'miss', reason: '缓存未命中', inputs: { q: 'a' }, outputs: { hit: false } });
  });
  assert.equal(trace.steps.length, 1);
  const step = trace.steps[0];
  assert.equal(step.name, '搜索·缓存查询');
  assert.equal(step.status, 'miss');
  assert.equal(step.reason, '缓存未命中');
  assert.deepEqual(step.inputs, { q: 'a' });
  assert.equal(step.ms >= 0, true);
});

test('markStepActive 使后续 recordConfigAccess 归属到该步骤', () => {
  const trace = createTrace('GET', '/api/v2/search');
  runWithTrace(trace, () => {
    markStepActive('搜索·逐源检索');
    recordConfigAccess('sourceOrderArr', ['bilibili', 'dandan']);
  });
  assert.equal(trace.configs.sourceOrderArr.used, true);
  assert.equal(trace.configs.sourceOrderArr.step, '搜索·逐源检索');
  assert.equal(trace.configs.sourceOrderArr.value, '2 项');
});

test('finishTrace 仅包含本次读取到的配置', () => {
  const trace = createTrace('GET', '/api/v2/search');
  runWithTrace(trace, () => {
    markStepActive('搜索·逐源检索');
    recordConfigAccess('sourceOrderArr', ['bilibili', 'dandan']);
  });
  finishTrace(trace);
  assert.equal(trace.totalMs >= 0, true);
  assert.equal(trace.handlerMs, trace.totalMs - trace.prepareMs);
  // 未读取项由详情接口按配置目录补齐，追踪记录只保存请求实际观察到的配置
  assert.deepEqual(Object.keys(trace.configs), ['sourceOrderArr']);
  assert.equal(trace.configs.sourceOrderArr.value, '2 项');
  assert.equal(trace.configs.sourceOrderArr.used, true);
  assert.equal(trace.configs.sourceOrderArr.step, '搜索·逐源检索');
});

test('TRACE_CONFIG_ACCESSORS 由 envVarConfig 注册，运行态独立分组', () => {
  const source = fs.readFileSync(new URL('../../configs/envs.js', import.meta.url), 'utf8');
  const start = source.indexOf('const envVarConfig = {');
  const end = source.indexOf('\n    };', start);

  const declared = [...source.slice(start, end)
    .matchAll(/'([A-Z][A-Z0-9_]*)':\s*\{[^}]*?accessor:\s*'(\w+)'/g)];
  const expected = Object.fromEntries(declared.map(m => [m[1], m[2]]));
  assert.deepEqual(TRACE_CONFIG_ACCESSORS, expected, '追踪映射应与配置目录中的 accessor 一致');
  assert.ok(Object.keys(expected).length > 0, 'envVarConfig 未声明 accessor');
  assert.equal(Object.keys(TRACE_RUNTIME_ACCESSORS).length, 5);
});

test('describeConfigValue 按取值形态摘要，敏感项只返回是否设置', () => {
  // 敏感项只暴露存在性
  assert.equal(describeConfigValue('token', 'secret'), '已设置');
  assert.equal(describeConfigValue('token', ''), '未设置');
  assert.equal(describeConfigValue('token', null), '未设置');
  // 非敏感项按形态摘要，不展开内容
  assert.equal(describeConfigValue('sourceOrderArr', ['a', 'b', 'c']), '3 项');
  assert.equal(describeConfigValue('titleMappingTable', new Map([['a', 'b']])), '1 项');
  assert.equal(describeConfigValue('customMergeRules', { a: 1, b: 2 }), '2 键');
  assert.equal(describeConfigValue('whatever', /abc/), 'abc');
  assert.equal(describeConfigValue('whatever', true), 'true');
  assert.equal(describeConfigValue('whatever', 0), '0');
  assert.equal(describeConfigValue('whatever', ''), '未设置');
});

test('bumpTraceSequence 只接受数字 id，非法值不抬高序号', () => {
  const before = createTrace('GET', '/x').id;
  bumpTraceSequence('not-a-number');
  bumpTraceSequence(null);
  const after = createTrace('GET', '/x').id;
  assert.equal(traceSeqOf(after), traceSeqOf(before) + 1, '非法 id 不改变序号');
  bumpTraceSequence('999');
  const bumped = createTrace('GET', '/x').id;
  assert.equal(traceSeqOf(bumped), 1000, '旧数字 id 抬高序号下限');
});

test('registerTraceConfigAccessors 重复注册以最新配置为准', () => {
  registerTraceConfigAccessors({ A: { accessor: 'a', sensitive: true }, B: { accessor: 'b' }, C: {} });
  assert.deepEqual({ ...TRACE_CONFIG_ACCESSORS }, { A: 'a', B: 'b' });
  assert.deepEqual(getSensitiveConfigKeys(), ['a']);
  // 再次注册清空旧键，不残留上一次的映射
  registerTraceConfigAccessors({ D: { accessor: 'd' } });
  assert.deepEqual({ ...TRACE_CONFIG_ACCESSORS }, { D: 'd' });
  assert.deepEqual(getSensitiveConfigKeys(), []);
  // 恢复真实配置目录，避免影响后续用例
  Globals.init({ LOG_LEVEL: 'error' });
});

test('敏感项名单由 envVarConfig 的 sensitive 声明派生', () => {
  const source = fs.readFileSync(new URL('../../configs/envs.js', import.meta.url), 'utf8');
  const start = source.indexOf('const envVarConfig = {');
  const end = source.indexOf('\n    };', start);
  const expected = [...source.slice(start, end)
    .matchAll(/accessor: '(\w+)'[^}]*?sensitive: true/g)]
    .map(m => m[1]).sort();
  assert.deepEqual(getSensitiveConfigKeys().sort(), expected, '敏感项应与配置目录声明一致');
});

test('envVarConfig 中所有访问器均能在 Envs.load 返回值中找到', () => {
  const source = fs.readFileSync(new URL('../../configs/envs.js', import.meta.url), 'utf8');
  const start = source.indexOf('return {', source.indexOf('static load('));
  const body = source.slice(start, source.indexOf('envVarConfig: envVarConfig', start));
  for (const [upName, accessor] of Object.entries(TRACE_CONFIG_ACCESSORS)) {
    assert.ok(
      body.includes(`'${upName}'`) || body.includes(`${accessor}:`),
      `${upName} -> ${accessor} 未在 Envs.load 中登记`);
  }
});

test('recordConfigAccess 敏感配置只登记是否存在，不登记取值', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => recordConfigAccess('token', 'my-secret-token'));
  finishTrace(trace);
  assert.equal(trace.configs.token.value, '已设置');
  assert.equal(trace.configs.token.value.includes('my-secret'), false);
  assert.equal(trace.configs.adminToken, undefined, '未读取的配置不写入追踪记录');
});

test('getInterfaceDetail 命中返回 trace，未命中返回 null', () => {
  const trace = createTrace('GET', '/api/v2/search');
  finishTrace(trace);
  assert.equal(getInterfaceDetail(trace.id).id, trace.id);
  assert.equal(getInterfaceDetail('not-exist'), null);
  assert.equal(getInterfaceDetail(null), null);
});

test('finishTrace 未留存时不计入追踪记录', () => {
  const before = getTraceRecords().length;
  const trace = createTrace('GET', '/api/interface-detail/1');
  runWithTrace(trace, () => traceStep('详情查询', Date.now(), { status: 'ok' }));
  finishTrace(trace, false);
  assert.equal(getTraceRecords().length, before, '未留存的追踪不应占用名额');
  assert.equal(getInterfaceDetail(trace.id)?.id === trace.id, false);
});

test('finishTrace 环形缓冲超出上限后淘汰早期记录', () => {
  const first = createTrace('GET', '/api/v2/search');
  finishTrace(first);
  for (let i = 0; i < MAX_PIPELINE_RECORDS; i++) {
    const t = createTrace('GET', '/api/v2/search');
    finishTrace(t);
  }
  assert.equal(getInterfaceDetail(first.id), null, '最早创建的 trace 应被淘汰');
  assert.equal(getInterfaceDetail('999999'), null, '未创建的 id 不应命中');
});

test('traceStep 与 recordConfigAccess 无追踪作用域时为无害空操作', () => {
  const t = createTrace('GET', '/x');
  assert.doesNotThrow(() => traceStep('无作用域', Date.now()));
  assert.doesNotThrow(() => recordConfigAccess('sourceOrderArr', ['bilibili']));
  assert.equal(t.steps.length, 0);
  assert.deepEqual(t.configs, {});
});

test('pipeline-trace 未注入 AsyncLocalStorage 时打点为无害空操作', async () => {
  const fresh = await import('../../utils/pipeline-trace.js?no-als');
  const t = fresh.createTrace('GET', '/x');
  assert.doesNotThrow(() => fresh.traceStep('无存储', Date.now()));
  assert.doesNotThrow(() => fresh.recordConfigAccess('sourceOrderArr', ['bilibili']));
  assert.doesNotThrow(() => fresh.recordConfigEffect('TITLE_NOISE_FILTER', { hit: true }));
  assert.doesNotThrow(() => fresh.recordTitleDecision({ config: 'STRICT_TITLE_MATCH', label: '严格标题匹配', value: 'x', matched: false, reason: '原因' }));
  assert.doesNotThrow(() => fresh.markHandlerStart(t.startedAt));
  assert.equal(t.steps.length, 0);
  assert.deepEqual(t.configs, {});
  assert.equal(t.prepareMs, 0);
});

test('markHandlerStart 在追踪作用域内计算 prepareMs，handlerMs 为其余耗时', () => {
  const trace = createTrace('GET', '/api/v2/search');
  trace.startedAt -= 50;
  runWithTrace(trace, () => markHandlerStart(trace.startedAt));
  assert.equal(trace.prepareMs >= 50, true);
  finishTrace(trace);
  assert.equal(trace.handlerMs, trace.totalMs - trace.prepareMs);
});

test('runWithTrace 并发交错时活动步骤按请求隔离', async () => {
  const fresh = await import('../../utils/pipeline-trace.js?concurrent');
  fresh.useAsyncLocalStorage(AsyncLocalStorage);

  const first = fresh.createTrace('GET', '/a');
  const second = fresh.createTrace('POST', '/b');
  const gate = [];
  const interleave = async (trace, stepName, key) => fresh.runWithTrace(trace, async () => {
    fresh.markStepActive(stepName);
    await new Promise(resolve => gate.push(resolve));
    fresh.recordConfigAccess(key, [stepName]);
  });

  const firstRun = interleave(first, '搜索·缓存查询', 'sourceOrderArr');
  const secondRun = interleave(second, '匹配·文件名解析', 'platformOrderArr');
  while (gate.length < 2) await Promise.resolve();
  gate.splice(0).forEach(resolve => resolve());
  await Promise.all([firstRun, secondRun]);

  assert.equal(first.configs.sourceOrderArr.step, '搜索·缓存查询');
  assert.equal(second.configs.platformOrderArr.step, '匹配·文件名解析');
  assert.equal(first.configs.platformOrderArr, undefined);
  assert.equal(second.configs.sourceOrderArr, undefined);
});

test('recordConfigAccess 将正则配置显示为规则源码', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => recordConfigAccess('animeTitleFilter', /广告|预告/gi));
  assert.equal(trace.configs.animeTitleFilter.value, '广告|预告');
});

test('traceStep 仅写入有消费方的 detail 字段', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => traceStep('步骤', Date.now(), {
    status: 'ok', reason: '原因', inputs: { q: 'a' }, outputs: { hit: true }, error: '失败', count: 3,
  }));
  assert.deepEqual(Object.keys(trace.steps[0]).sort(), ['error', 'inputs', 'ms', 'name', 'outputs', 'reason', 'status']);
});

test('traceStep 记录步骤级明细表格', () => {
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => traceStep('匹配·搜索与候选评分', Date.now(), {
    status: 'ok',
    table: { columns: ['平台', '候选'], rows: [{ 平台: 'bilibili', 候选: '钢铁侠2' }] },
  }));
  assert.deepEqual(trace.steps[0].table.columns, ['平台', '候选']);
  assert.equal(trace.steps[0].table.rows[0].候选, '钢铁侠2');
});

test('recordConfigEffect 把处理前后取值归并到当前步骤', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    markStepActive('搜索·缓存查询');
    recordConfigEffect('TITLE_NOISE_FILTER', { label: '剧名杂音清理', before: '百花杀（真彩）', after: '百花杀', hit: true });
    traceStep('搜索·缓存查询', Date.now(), { status: 'ok' });
  });
  assert.equal(trace.steps[0].changes.length, 1);
  const change = trace.steps[0].changes[0];
  assert.equal(change.config, 'TITLE_NOISE_FILTER');
  assert.equal(change.label, '剧名杂音清理');
  assert.equal(change.before, '百花杀（真彩）');
  assert.equal(change.after, '百花杀');
  assert.equal(change.hit, true);
});

test('recordConfigEffect 的记录不串到下一步骤', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordConfigEffect('TITLE_NOISE_FILTER', { before: 'a', after: 'b' });
    traceStep('搜索·缓存查询', Date.now(), {});
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  assert.equal(trace.steps[0].changes.length, 1);
  assert.equal(trace.steps[1].changes, undefined);
});

test('maskCredentialParams 遮蔽地址查询串中的凭据参数', async () => {
  const { maskCredentialParams } = await import('../../utils/pipeline-trace.js');
  const masked = maskCredentialParams('https://example.com/d?token=a&sign=b&api-key=c&episode=3&path/to/page');
  assert.match(masked, /token=%2A%2A%2A|token=\*\*\*/, '凭据参数应遮蔽');
  assert.match(masked, /sign=%2A%2A%2A|sign=\*\*\*/, '签名参数应遮蔽');
  assert.match(masked, /api-key=%2A%2A%2A|api-key=\*\*\*/, '带连字符的变体应遮蔽');
  assert.match(masked, /episode=3/, '非凭据参数应保留');
  assert.match(masked, /^https:\/\/example\.com\/d/, '路径应保留');
  // 无查询串的地址原样返回
  assert.equal(maskCredentialParams('https://example.com/page'), 'https://example.com/page');
});

test('maskCredentialParams 分别处理合并链接中的每段地址', async () => {
  const { maskCredentialParams } = await import('../../utils/pipeline-trace.js');
  const masked = maskCredentialParams(
    'https://a.example/v?x=1&episode=2$$$https://b.example/v?sign=xyz&episode=3'
  );
  const decoded = decodeURIComponent(masked);

  assert.match(masked, /\$\$\$/, '合并链接分隔符应保留');
  assert.match(decoded, /https:\/\/a\.example\/v\?x=1/);
  assert.match(decoded, /https:\/\/b\.example\/v\?sign=\*\*\*/);
  assert.doesNotMatch(decoded, /sign=xyz/, '第二段的签名不得明文保留');
  assert.match(decoded, /episode=2/);
  assert.match(decoded, /episode=3/);
});

test('maskCredentialParams 递归遮蔽嵌套 URL 并保留 fragment', async () => {
  const { maskCredentialParams } = await import('../../utils/pipeline-trace.js');
  const masked = maskCredentialParams(
    'https://example.com/d?url=https%3A%2F%2Fnested.example%2Fv%3Ftoken%3Dabc%26episode%3D4#player'
  );
  const decoded = decodeURIComponent(masked);

  assert.match(decoded, /url=https:\/\/nested\.example\/v\?token=\*\*\*/);
  assert.doesNotMatch(decoded, /token=abc/, '嵌套地址中的令牌不得明文保留');
  assert.match(decoded, /episode=4/);
  assert.match(masked, /#player$/, 'fragment 应保留');
});

test('同组的主标题与别名归并为一条判定并显示归属', () => {
  useAsyncLocalStorage(StubStorage);
  const trace = createTrace('GET', '/api/v2/search/anime');
  runWithTrace(trace, () => {
    markStepActive('搜索·逐源检索');
    recordTitleDecision({ label: '默认标题匹配（包含 / 相似度）', group: '葬送的芙莉莲',
      source: 'renren', query: 'x', value: '葬送的芙莉莲', matched: false, reason: '未命中' });
    recordTitleDecision({ label: '默认标题匹配（包含 / 相似度）', group: '葬送的芙莉莲',
      source: 'renren', query: 'x', value: '葬送的芙莉蓮', matched: false, reason: '未命中' });
    traceStep('搜索·逐源检索', Date.now(), { status: 'ok', outputs: { count: 0 } });
  });
  const decision = trace.steps[0].changes.find(c => c.kind === 'decision');
  assert.equal(decision.removedCount, 1, '两个判定应合并为一条');
  // 归并后是 kept/removed 中的一项，带 aliases
  const all = [...decision.kept, ...decision.removed];
  assert.equal(all.length, 1, '主标题与别名应统一为一条结果');
  assert.equal(all[0].value, '葬送的芙莉莲');
  assert.deepEqual(all[0].aliases, ['葬送的芙莉蓮']);
});

test('recordTitleDecision 聚合保留与剔除计数，常规规模完整保留', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    for (let i = 0; i < 12; i++) {
      recordTitleDecision({
        config: 'STRICT_TITLE_MATCH', label: '严格标题匹配', value: '候选' + i,
        matched: i < 2, reason: '严格匹配：标题不以搜索词开头',
        source: i < 8 ? 'bilibili' : 'iqiyi',
      });
    }
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.config, 'STRICT_TITLE_MATCH');
  assert.equal(change.label, '严格标题匹配');
  assert.equal(change.kind, 'decision');
  assert.equal(change.keptCount, 2);
  assert.equal(change.removedCount, 10);
  assert.equal(change.kept.length, 2);
  assert.equal(change.removed.length, 10, '常规规模不应截断');
  assert.equal(change.removed[0].value, '候选2');
  assert.equal(change.removed[0].reason, '严格匹配：标题不以搜索词开头');
  assert.match(change.summary, /共 12 个标题判定/);
  // 真实案例里判定数可多于候选数（一个候选多个标题），摘要必须解释口径避免用户误读为数据矛盾
  assert.match(change.summary, /判定数与候选数可能不相等/, '摘要应说明判定与候选数的口径差异');
  assert.equal(change.context.按源判定, 'bilibili 8、iqiyi 4');
});

test('recordTitleDecision 按配置项分别聚合', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordTitleDecision({ config: 'STRICT_TITLE_MATCH', label: '严格标题匹配', value: 'a', matched: false, reason: '原因A' });
    recordTitleDecision({ config: 'EPISODE_TITLE_FILTER', label: '集标题过滤', value: '预告', matched: false, reason: '原因B' });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  assert.deepEqual(trace.steps[0].changes.map(c => c.config).sort(), ['EPISODE_TITLE_FILTER', 'STRICT_TITLE_MATCH']);
  assert.equal(trace.steps[0].changes.length, 2);
});

test('recordTitleDecision 无配置项时按说明文字分桶', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordTitleDecision({ label: '默认标题匹配（包含 / 相似度）', value: 'x', matched: false, reason: '未命中' });
    recordTitleDecision({ label: '默认标题匹配（包含 / 相似度）', value: 'y', matched: true });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.config, null);
  assert.equal(change.label, '默认标题匹配（包含 / 相似度）');
  assert.equal(change.keptCount, 1);
  assert.equal(change.removedCount, 1);
});

test('recordTitleDecision 同一候选的主标题与别名合并为一个结果', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    const base = { label: '默认标题匹配（包含 / 相似度）', mode: '包含匹配 + 相似度（阈值 0.8）', query: '正相反的你与我', group: '反対な君と僕', source: 'animeko' };
    recordTitleDecision({ ...base, value: '反対な君と僕', matched: false, reason: '包含匹配与相似度匹配均未命中' });
    recordTitleDecision({ ...base, value: '相反的你和我', matched: false, reason: '包含匹配与相似度匹配均未命中' });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.removedCount, 1, '别名不应额外计为一次未命中');
  assert.equal(change.removed[0].value, '反対な君と僕', '主标题与别名分开记录');
  assert.deepEqual(change.removed[0].aliases, ['相反的你和我']);
  assert.equal(change.removed[0].source, 'animeko');
  assert.equal(change.context.搜索词, '正相反的你与我');
});

test('recordTitleDecision 超出保护上限时截断并保留总数', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    for (let i = 0; i < 260; i++) {
      recordTitleDecision({ label: '默认标题匹配', value: '候选' + i, matched: false, reason: '未命中' });
    }
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.removedCount, 260, '计数不受样本上限影响');
  assert.equal(change.removed.length, 200, '样本按保护上限截断');
});

test('recordTitleDecision 任一别名命中即视为该作品命中', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    const base = { label: '默认标题匹配（包含 / 相似度）', query: '正相反的你与我', group: '反対な君と僕' };
    recordTitleDecision({ ...base, value: '反対な君と僕', matched: false, reason: '未命中' });
    recordTitleDecision({ ...base, value: '相反的你和我', matched: true });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.keptCount, 1);
  assert.equal(change.removedCount, 0);
  assert.equal(change.hit, false, '没有任何作品被剔除时规则未发挥作用');
});

test('recordTitleDecision 同源内主标题与别名合并，跨源分别成行', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordTitleDecision({ label: '默认标题匹配', query: '正相反的你与我', group: '反対な君と僕', value: '反対な君と僕', matched: false, reason: '未命中', source: 'animeko' });
    recordTitleDecision({ label: '默认标题匹配', query: '正相反的你与我', group: '反対な君と僕', value: '正相反的你与我', matched: true, source: 'animeko' });
    recordTitleDecision({ label: '默认标题匹配', query: '正相反的你与我', group: '正相反的你与我', value: '正相反的你与我', matched: true, source: 'bilibili' });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.keptCount, 2, '同源合并、跨源分行');
  const animeko = change.kept.find(item => item.source === 'animeko');
  assert.equal(animeko.value, '反対な君と僕');
  assert.deepEqual(animeko.aliases, ['正相反的你与我'], '同源别名并入同一行');
  assert.equal(change.kept.find(item => item.source === 'bilibili').value, '正相反的你与我');
  assert.equal(change.removedCount, 0);
});

test('recordTitleDecision 同一标题被多个源判定时按源分别成行', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    const base = { label: '默认标题匹配（包含 / 相似度）', query: '钢铁侠2' };
    for (const source of ['tencent', 'youku', 'iqiyi']) {
      recordTitleDecision({ ...base, value: '钢铁侠2', matched: true, source });
    }
    recordTitleDecision({ ...base, value: '钢铁侠2普通话', matched: true, source: 'iqiyi' });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  // 保留行数与逐源候选数一致：同标题在不同源是不同候选
  assert.equal(change.keptCount, 4);
  assert.deepEqual(change.kept.map(item => `${item.value}|${item.source}`), [
    '钢铁侠2|tencent', '钢铁侠2|youku', '钢铁侠2|iqiyi', '钢铁侠2普通话|iqiyi',
  ]);
  assert.equal(change.context.按源判定, 'iqiyi 2、tencent 1、youku 1');
});

test('recordTitleDecision 忽略空标题，不产生空候选项', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordTitleDecision({ label: '默认标题匹配', value: null, matched: false, reason: '标题或搜索词为空' });
    recordTitleDecision({ label: '默认标题匹配', value: '   ', matched: false, reason: '标题或搜索词为空' });
    recordTitleDecision({ label: '默认标题匹配', value: '有效标题', matched: true });
    traceStep('搜索·逐源检索', Date.now(), {});
  });
  const change = trace.steps[0].changes[0];
  assert.equal(change.keptCount, 1);
  assert.equal(change.removedCount, 0, '空标题不应计为未命中候选');
  assert.deepEqual(change.kept, [{ value: '有效标题' }]);
});

test('recordConfigEffect 同一配置多次生效时合并计数与样本', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordConfigEffect('BLOCKED_WORDS', { label: '屏蔽词过滤', hit: false, before: { 弹幕条数: 10 }, after: { 弹幕条数: 10 }, removed: [], removedCount: 0, sum: true });
    recordConfigEffect('BLOCKED_WORDS', { label: '屏蔽词过滤', hit: true, before: { 弹幕条数: 8 }, after: { 弹幕条数: 6 }, removed: [{ value: '广告' }], removedCount: 2, sum: true });
    traceStep('弹幕·源抓取', Date.now(), {});
  });
  const changes = trace.steps[0].changes;
  assert.equal(changes.length, 1, '同一配置应合并为一条记录');
  assert.deepEqual(changes[0].before, { 弹幕条数: 18 });
  assert.deepEqual(changes[0].after, { 弹幕条数: 16 });
  assert.equal(changes[0].removedCount, 2);
  assert.equal(changes[0].hit, true, '任一次命中即为命中');
  assert.equal('sum' in changes[0], false, '合并标记不应出现在步骤记录中');
  assert.equal(trace.configs.blockedWords.hit, true);
});

test('recordConfigEffect 记录配置命中与未命中两种状态', () => {
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordConfigEffect('EPISODE_TITLE_FILTER', { label: '集标题过滤', hit: false, before: { episodeCount: 3 }, after: { episodeCount: 3 } });
    traceStep('详情·响应组装', Date.now(), {});
  });
  assert.equal(trace.configs.episodeTitleFilter.used, true);
  assert.equal(trace.configs.episodeTitleFilter.hit, false);
  assert.equal(trace.configs.episodeTitleFilter.step, null, '步骤名为空时保持 null');
});

test('traceStep 嵌套步骤只计入父步骤独占耗时', () => {
  // 同步打点即可覆盖嵌套场景：子步骤先记录，父步骤区间覆盖子步骤后记录
  const trace = createTrace('GET', '/x');
  const now = Date.now();
  runWithTrace(trace, () => {
    traceStep('搜索·逐源检索', now - 25, { outputs: { count: 1 } });
    traceStep('匹配·评分', now - 30, { outputs: { count: 1 } });
  });
  const [child, parent] = trace.steps;
  assert.equal(child.nested, true, '子步骤应标记嵌套');
  assert.equal(parent.nested, undefined, '父步骤不标记嵌套');
  assert.ok(parent.totalMs > parent.ms, '父步骤保留含子步骤的总耗时');
  assert.ok(parent.ms < child.ms, `父步骤只保留独占耗时，实际 ${parent.ms}`);
  assert.ok(child.ms + parent.ms <= parent.totalMs + 5, '父子耗时之和不超过父步骤总耗时');
});

test('traceStep 父子步骤同毫秒启动时仍识别嵌套', () => {
  // phase 重置的起点与内部首个步骤常落在同一毫秒，此时子步骤仍应归属父步骤
  const trace = createTrace('GET', '/x');
  const base = Date.now();
  while (Date.now() - base < 15) { /* 忙等，制造真实耗时 */ }
  runWithTrace(trace, () => {
    traceStep('搜索·逐源检索', base, {});
    traceStep('弹幕·候选检索', base, {});
  });
  const [search, parent] = trace.steps;
  assert.equal(search.nested, true, '与父同毫秒启动的子步骤仍应认领');
  assert.ok(parent.totalMs > parent.ms, '父步骤保留含子步骤总耗时');
  assert.equal(parent.totalMs, search.ms, '父总耗时即子步骤耗时');
});

test('traceStep 多层嵌套按含子步骤总耗时逐层扣减', () => {
  const trace = createTrace('GET', '/x');
  const now = Date.now();
  runWithTrace(trace, () => {
    traceStep('甲·最内层', now - 25, {});
    traceStep('乙·中间层', now - 30, {});
    traceStep('丙·最外层', now - 40, {});
  });
  const [inner, middle, outer] = trace.steps;
  assert.equal(inner.nested, true);
  assert.equal(middle.nested, true);
  assert.equal(outer.nested, undefined);
  assert.ok(middle.totalMs >= middle.ms, '中间层保留含内层的总耗时');
  // 三层相加应接近最外层总耗时，不得因逐层重复扣减而放大
  const sum = trace.steps.reduce((total, step) => total + step.ms, 0);
  assert.ok(Math.abs(sum - outer.totalMs) <= 5, `三层耗时之和应接近外层总耗时，实际 ${sum} vs ${outer.totalMs}`);
});

test('createPhaseTimer 使相邻步骤耗时互不重叠', async () => {
  // 真实异步上下文：桩存储会在返回 Promise 时立即清空作用域
  useAsyncLocalStorage(AsyncLocalStorage);
  const trace = createTrace('GET', '/x');
  await runWithTrace(trace, () => {
    const phase = createPhaseTimer();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    return (async () => {
      await wait(40);
      phase('第一步', { status: 'ok' });
      await wait(5);
      phase('第二步', { status: 'ok' });
      const elapsed = Date.now();
      assert.ok(trace.steps[0].ms >= 30, `第一步耗时应覆盖第一段等待，实际 ${trace.steps[0].ms}`);
      assert.ok(trace.steps[1].ms < trace.steps[0].ms, '第二步不应重复累计第一步的耗时');
      assert.ok(trace.steps[0].ms + trace.steps[1].ms <= elapsed - trace.startedAt + 5);
    })();
  });
});

test('replaceTraceRecords 恢复记录并从已有 id 之后继续编号', () => {
  replaceTraceRecords([{ id: '7', path: '/old-7' }, { id: '12', path: '/old-12' }]);
  assert.equal(getTraceRecords().length, 2);
  assert.equal(getInterfaceDetail('12').path, '/old-12');
  assert.equal(getInterfaceDetail(7).path, '/old-7', '数字 id 也应按记录查找');
  const next = createTrace('GET', '/new');
  assert.ok(traceSeqOf(next.id) > 12, '重启后新请求不得与已保存记录重号');
});

test('追踪记录经 JSON 往返后内容不变', () => {
  // 落盘与恢复都依赖 JSON；打点若引入 Map/RegExp/函数会在序列化时静默丢失，必须在此拦截
  useAsyncLocalStorage(StubStorage);
  const trace = createTrace('POST', '/api/v2/match', '1.1.1.1');
  trace.statusCode = 200;
  runWithTrace(trace, () => {
    markStepActive('匹配·文件名解析');
    recordConfigEffect('BLOCKED_WORDS', {
      label: '屏蔽词过滤', hit: true,
      before: { 弹幕条数: 3 }, after: { 弹幕条数: 2 },
      removed: [{ value: '广告', reason: '命中屏蔽词' }],
    });
    traceStep('匹配·文件名解析', Date.now(), {
      status: 'ok',
      inputs: { fileName: 'a.mp4', nested: { deep: [1, 2, 3] } },
      outputs: { count: 1, title: '测试剧', matched: true },
    });
  });
  const roundtrip = JSON.parse(JSON.stringify(trace));
  assert.deepEqual(roundtrip.steps, trace.steps, '步骤在 JSON 往返后应完全一致');
  assert.deepEqual(roundtrip.configs, trace.configs, '配置记录在 JSON 往返后应完全一致');
  assert.equal(roundtrip.statusCode, 200);
});

test('replaceTraceRecords 兼容缺少可选字段或多出未知字段的快照', () => {
  // 旧版快照的步骤可能只有 name/ms，未来版本可能多出未知字段，恢复后都应可消费
  replaceTraceRecords([
    { id: '901', method: 'GET', path: '/x', steps: [{ name: '搜索·缓存查询', ms: 2 }], configs: {} },
    { id: '902', method: 'GET', path: '/y', futureField: { a: 1 }, steps: [{ name: '搜索·逐源检索', ms: 5, status: 'ok', futureStepField: true, outputs: { count: 3 } }], configs: {} },
  ]);
  const [legacy, future] = getTraceRecords();
  assert.equal(legacy.steps.length, 1);
  assert.equal(future.steps[0].futureStepField, true, '未知字段原样保留');
  for (const record of [legacy, future]) {
    assert.doesNotThrow(() => buildResultDiagnosis(record.steps));
  }
  assert.equal(buildResultDiagnosis(future.steps).conclusion.includes('3 条候选'), true);
});

test('replaceTraceRecords 规范化损坏快照的步骤与配置字段', () => {
  replaceTraceRecords([
    { id: '1', steps: 'bad', configs: null },
    { id: '2', steps: [{ name: '搜索·x', outputs: null }], configs: [] },
    null,
  ]);
  const records = getTraceRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].steps, [], '非数组步骤规范化为空数组');
  assert.deepEqual(records[0].configs, {}, '空配置规范化为空对象');
  assert.deepEqual(records[1].configs, {}, '数组配置规范化为空对象');
  // 规范化后诊断可直接消费恢复的记录
  for (const record of records) {
    assert.doesNotThrow(() => buildResultDiagnosis(record.steps));
  }
});

test('replaceTraceRecords 忽略无效记录并按上限截断', () => {
  const many = Array.from({ length: MAX_PIPELINE_RECORDS + 5 }, (_, i) => ({ id: String(1000 + i) }));
  many.push({ id: String(1000 + MAX_PIPELINE_RECORDS + 4), path: '/latest-duplicate' });
  replaceTraceRecords([null, {}, ...many]);
  assert.equal(getTraceRecords().length, MAX_PIPELINE_RECORDS);
  assert.equal(getTraceRecords()[0].id, String(1000 + 5));
  assert.equal(getInterfaceDetail(String(1000 + MAX_PIPELINE_RECORDS + 4)).path, '/latest-duplicate');
});

test('replaceTraceRecords 历史重复 id 保留最新记录', () => {
  replaceTraceRecords([
    { id: 'dup', path: '/old' },
    { id: 'other', path: '/other' },
    { id: 'dup', path: '/new' },
  ]);
  assert.deepEqual(getTraceRecords().map(record => record.id), ['other', 'dup']);
  assert.equal(getInterfaceDetail('dup').path, '/new');
});

test('replaceTraceRecords 为在途 trace 重新分配冲突 id', () => {
  const active = createTrace('GET', '/active');
  active.id = 'legacy-conflict';
  replaceTraceRecords([{ id: 'legacy-conflict', path: '/restored' }]);

  assert.notEqual(active.id, 'legacy-conflict');
  assert.equal(getInterfaceDetail('legacy-conflict').path, '/restored');
  finishTrace(active);
  assert.equal(getInterfaceDetail(active.id).path, '/active');
  assert.equal(getTraceRecords().filter(record => record.id === active.id).length, 1);
});

test('createTrace 的 id 在恢复后依然唯一', () => {
  replaceTraceRecords([{ id: '3' }]);
  const a = createTrace('GET', '/a');
  const b = createTrace('GET', '/b');
  assert.notEqual(a.id, b.id);
  assert.ok(traceSeqOf(a.id) > 3 && traceSeqOf(b.id) > traceSeqOf(a.id));
});

test('配置生效记录引用的配置名都存在于配置目录', async () => {
  // 记录里的配置名写错或配置改名时，命中状态会静默失效，此处直接失败
  const fs = await import('node:fs');
  const sources = [
    '../../apis/dandan-api.js', '../../apis/favorite-api.js',
    '../../apis/clients/fongmi-api.js', '../../utils/danmu-util.js',
  ];
  const missing = new Set();
  let referenced = 0;
  for (const relative of sources) {
    const code = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    for (const match of code.matchAll(/recordConfigEffect\('([A-Z][A-Z0-9_]+)'/g)) {
      referenced++;
      if (!Object.prototype.hasOwnProperty.call(TRACE_CONFIG_ACCESSORS, match[1])) missing.add(match[1]);
    }
  }
  for (const name of ['STRICT_TITLE_MATCH', 'TITLE_MAPPING_TABLE']) {
    if (!Object.prototype.hasOwnProperty.call(TRACE_CONFIG_ACCESSORS, name)) missing.add(name);
  }
  assert.ok(referenced >= 10, `配置生效记录提取数量异常: ${referenced}`);
  assert.deepEqual([...missing].sort(), [], '配置生效记录引用了不存在的配置名');
});

test('MAX_PIPELINE_RECORDS 与请求记录上限一致', async () => {
  const { Globals } = await import('../../configs/globals.js');
  assert.equal(MAX_PIPELINE_RECORDS, Globals.MAX_RECORDS, '详情留存上限需与请求记录一致');
});

test('buildResultDiagnosis 用候选数与命中源描述匹配结果', () => {
  const matched = buildResultDiagnosis([
    { name: '匹配·搜索与候选评分', outputs: { candidateCount: 2, matched: true, source: 'bilibili', count: 1 } },
    { name: '匹配·结果组装', outputs: { matchCount: 1, count: 1 } },
  ]);
  assert.equal(matched.conclusion, '本次请求从 2 条候选中匹配到 1 条 bilibili 候选。');

  const unmatched = buildResultDiagnosis([
    { name: '匹配·搜索与候选评分', outputs: { candidateCount: 2, matched: false, count: 0 } },
    { name: '匹配·结果组装', outputs: { matchCount: 0, count: 0 } },
  ]);
  assert.equal(unmatched.conclusion, '本次请求从 2 条候选中未匹配到结果。');
  assert.equal(unmatched.zeroStep, '匹配·搜索与候选评分');
});

test('buildResultDiagnosis 无步骤时不引导用户查看空流水线', () => {
  const none = buildResultDiagnosis([]);
  assert.equal(none.conclusion, '本次请求未进入处理流水线，请结合状态码与接口参数排查。');
  assert.doesNotMatch(none.conclusion, /按步骤查看/);

  // 有步骤但无数量时仍保留原有引导文案
  const noCount = buildResultDiagnosis([
    { name: '收藏·定时刷新', status: 'ok' },
  ]);
  assert.match(noCount.conclusion, /请按步骤查看/);
});

test('buildResultDiagnosis 收藏刷新不使用搜索候选数作结论', () => {
  const steps = [
    { name: '搜索·逐源检索', status: 'ok', outputs: { count: 9 } },
    { name: '搜索·持久化与响应', status: 'ok', outputs: { count: 9 } },
    { name: '收藏·刷新', status: 'ok', reason: '已刷新收藏', outputs: { animeTitle: 'X' } },
  ];
  const d = buildResultDiagnosis(steps);
  assert.equal(d.conclusion, '本次请求已刷新该收藏的搜索结果。');
  assert.doesNotMatch(d.conclusion, /条候选/, '刷新结论不应复述搜索候选数');
});

test('buildResultDiagnosis FongMi 返回候选地址数而非弹幕条数', () => {
  const steps = [
    { name: '弹幕·参数解析', status: 'ok', outputs: { candidateKeywords: ['x'] } },
    { name: '搜索·缓存查询', status: 'hit', outputs: { hit: true, cachedCount: 4, count: 4 } },
    { name: '弹幕·候选检索', status: 'ok', outputs: { animeCount: 4 } },
    { name: '弹幕·候选评分', status: 'ok', outputs: { 候选地址数: 112, topScore: 15698 } },
  ];
  const d = buildResultDiagnosis(steps);
  assert.equal(d.conclusion, '本次请求返回 112 个弹幕候选地址。');
  assert.doesNotMatch(d.conclusion, /条弹幕/, '候选地址数不是弹幕条数');
  assert.doesNotMatch(d.conclusion, /来自缓存/, '搜索缓存命中不代表弹幕候选来自缓存');

  // 候选为 0 时说明原因，不能只报一个 0
  const none = buildResultDiagnosis([
    { name: '搜索·缓存查询', status: 'hit', outputs: { hit: true, cachedCount: 2, count: 2 } },
    { name: '弹幕·候选评分', status: 'empty', reason: '候选剧集均无可用的弹幕地址', outputs: { 候选地址数: 0 } },
  ]);
  assert.match(none.conclusion, /候选剧集均无可用的弹幕地址/, '空结果应说明原因');
});

test('buildResultDiagnosis 收藏写入不把候选数说成收藏条数', () => {
  const steps = [
    { name: '搜索·逐源检索', status: 'ok', outputs: { count: 5 } },
    { name: '收藏·缓存查找', status: 'hit', outputs: { 可用候选数: 5 } },
    { name: '收藏·写入', status: 'ok', reason: '已收藏「X」', outputs: { 写入剧集数: 5 } },
  ];
  const d = buildResultDiagnosis(steps);
  assert.equal(d.conclusion, '本次请求已收藏，写入 5 条候选剧集。');
  assert.doesNotMatch(d.conclusion, /条收藏/, '不得把搜索候选数说成收藏条数');
});

test('buildResultDiagnosis 按步骤是否带明细表格决定是否提示逐源', () => {
  // 详情接口没有逐源表格，不应引导用户去看不存在的区域
  const detail = buildResultDiagnosis([
    { name: '详情·剧集定位', status: 'empty', reason: '缓存中不存在该剧集', outputs: { count: 0 } },
  ]);
  assert.doesNotMatch(detail.conclusion, /逐源/, '无明细表格时不应提示逐源');
  assert.match(detail.conclusion, /未获得结果/);

  // 搜索步骤带逐源表格（收藏复用搜索流水线时同样带），应提示
  const withTable = buildResultDiagnosis([
    { name: '搜索·逐源检索', status: 'empty', outputs: { count: 0 },
      changes: [{ label: '逐源检索结果', kind: 'stats', table: { columns: ['源'], rows: [{ 源: 'bilibili' }] } }] },
  ]);
  assert.match(withTable.conclusion, /逐源明细/, '有明细表格时应提示逐源');
});

test('buildResultDiagnosis 按接口选择数量单位并定位归零步骤', () => {
  const steps = [
    { name: '弹幕·缓存查询', outputs: { count: 0 } },
    { name: '弹幕·抓取与过滤', outputs: { count: 300 } },
    { name: '弹幕·响应组装', outputs: { count: 0 } },
  ];
  const diagnosis = buildResultDiagnosis(steps);
  assert.equal(diagnosis.zeroStep, '弹幕·响应组装');
  assert.match(diagnosis.conclusion, /弹幕在「弹幕·响应组装」步骤由 300 条弹幕归零/);
  assert.deepEqual(diagnosis.chain.map(item => item.zero), [false, false, true]);

  const episode = buildResultDiagnosis([{ name: '详情·响应组装', outputs: { count: 12 } }]);
  assert.equal(episode.conclusion, '本次请求最终返回 12 集。');

  const favorite = buildResultDiagnosis([{ name: '收藏·列表', outputs: { count: 3 } }]);
  assert.equal(favorite.conclusion, '本次请求最终返回 3 条收藏。');
});

test('buildResultDiagnosis 从步骤输入读取来源规则偏移', () => {
  // 偏移写在步骤 inputs 里，若只查 outputs 会漏掉规则偏移
  const d = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', status: 'ok', outputs: { rawCount: 2446, count: 2171 } },
    { name: '弹幕·偏移处理', status: 'ok',
      inputs: { linkOffset: 0, ruleOffset: -60, percent: false },
      outputs: { count: 2171 } },
  ]);
  assert.match(d.conclusion, /弹幕提前 60 秒（来源规则）/, '应从 inputs 读取 ruleOffset');
});

test('buildResultDiagnosis 在缓存命中结论中说明结果来源', () => {
  const hit = buildResultDiagnosis([
    { name: '搜索·缓存查询', status: 'hit', reason: '普通搜索缓存命中',
      outputs: { hit: true, cachedCount: 3, count: 3 } },
  ]);
  assert.equal(hit.conclusion, '本次请求最终保留 3 条候选（结果来自缓存）。');

  // 缓存未命中是正常流转，不应标注来源
  const miss = buildResultDiagnosis([
    { name: '搜索·缓存查询', status: 'miss', outputs: { hit: false, count: 0 } },
    { name: '搜索·逐源检索', status: 'ok', outputs: { count: 2 } },
  ]);
  assert.doesNotMatch(miss.conclusion, /结果来自缓存/);
  assert.match(miss.conclusion, /2 条候选/);
});

test('buildResultDiagnosis 在弹幕结论中补充偏移信息', () => {
  const rule = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 120 } },
    { name: '弹幕·偏移处理', outputs: { linkOffset: 0, ruleOffset: 30, percent: false, count: 120 } },
    { name: '弹幕·响应组装', outputs: { count: 120 } },
  ]);
  assert.equal(rule.conclusion, '本次请求最终返回 120 条弹幕（弹幕延迟 30 秒（来源规则））。');

  const link = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 60 } },
    { name: '弹幕·偏移处理', outputs: { linkOffset: 5, ruleOffset: 0, percent: false, count: 60 } },
  ]);
  assert.equal(link.conclusion, '本次请求最终返回 60 条弹幕（弹幕延迟 5 秒（链接参数））。');

  // 链接偏移以百分比给出时按 % 展示，不能写成秒
  const linkPercent = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 60, linkOffset: 10, linkOffsetPercent: true } },
  ]);
  assert.equal(linkPercent.conclusion, '本次请求最终返回 60 条弹幕（弹幕延迟 10%（链接参数））。');

  // 负偏移用「提前」表述并取绝对值
  const earlier = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 60, linkOffset: -50 } },
  ]);
  assert.equal(earlier.conclusion, '本次请求最终返回 60 条弹幕（弹幕提前 50 秒（链接参数））。');

  const none = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 60 } },
    { name: '弹幕·偏移处理', outputs: { linkOffset: 0, ruleOffset: 0, count: 60 } },
  ]);
  assert.equal(none.conclusion, '本次请求最终返回 60 条弹幕。');
});

test('buildResultDiagnosis 按输出字段识别步骤用途，不受步骤名影响', () => {
  // 步骤改名后诊断仍能识别匹配过程与偏移信息
  const matched = buildResultDiagnosis([
    { name: '匹配·搜索与评分', outputs: { count: 1, candidateCount: 5, matched: true, source: 'bilibili' } },
  ]);
  assert.match(matched.conclusion, /从 5 条候选中匹配到 1 条 bilibili 候选/);

  const offset = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', outputs: { count: 10 } },
    { name: '弹幕·偏移', outputs: { count: 10, ruleOffset: 30, linkOffset: 0, percent: false } },
  ]);
  assert.match(offset.conclusion, /弹幕延迟 30 秒/);
});

test('buildResultDiagnosis 步骤内处理过程以处理前后数量呈现', () => {
  // 弹幕抓取步骤内部完成去重：rawCount 是处理前数量，链上应并列展示变化
  const result = buildResultDiagnosis([
    { name: '弹幕·抓取与过滤', status: 'ok', outputs: { rawCount: 28933, count: 23455 } },
    { name: '弹幕·响应组装', status: 'ok', outputs: { count: 23455 } },
  ]);
  const [fetch, assemble] = result.chain;
  assert.equal(fetch.rawCount, 28933);
  assert.equal(fetch.count, 23455);
  assert.equal(assemble.rawCount, undefined, '无处理过程的步骤不带 rawCount');
});

test('buildResultDiagnosis 全程为 0 时区分空结果与处理异常', () => {
  // 步骤全为正常返回，说明本就无数据，结论如实陈述为空，不引导排查
  const empty = buildResultDiagnosis([{ name: '收藏·列表', status: 'ok', outputs: { count: 0 } }]);
  assert.match(empty.conclusion, /最终返回 0 条收藏/);
  assert.match(empty.conclusion, /各步骤均正常返回/);
  assert.doesNotMatch(empty.conclusion, /确认原因/);

  // 无结果但无失败：给出排查入口，不武断判定为故障
  const noResult = buildResultDiagnosis([
    { name: '搜索·缓存查询', status: 'miss', outputs: { count: 0 } },
    { name: '搜索·逐源检索', status: 'empty', reason: '所有源均未返回可用候选', outputs: { count: 0 },
      changes: [{ label: '逐源检索结果', kind: 'stats', table: { columns: ['源'], rows: [{ 源: 'bilibili' }] } }] },
  ]);
  assert.match(noResult.conclusion, /逐源明细可查看各源返回情况/);
  assert.equal(noResult.zeroStep, '搜索·逐源检索');

  // 明确失败：指向该步骤并提示查看错误信息
  const failed = buildResultDiagnosis([
    { name: '搜索·逐源检索', status: 'fail', error: '请求超时', outputs: { count: 0 } },
  ]);
  assert.match(failed.conclusion, /在「搜索·逐源检索」步骤失败/);
});

test('buildResultDiagnosis 无数量时优先说明中断步骤', () => {
  // 限流、参数校验等请求在产出数量之前结束，结论应直接指出中断原因
  const limited = buildResultDiagnosis([
    { name: '弹幕·限流拦截', status: 'skip', reason: '超过限流阈值（1 分钟内 3/3 次）' },
  ]);
  assert.deepEqual(limited.chain, []);
  assert.equal(limited.zeroStep, '弹幕·限流拦截');
  assert.equal(limited.conclusion, '弹幕·限流拦截：超过限流阈值（1 分钟内 3/3 次）。');

  // 失败步骤没有 reason 时给出通用表述
  const failed = buildResultDiagnosis([{ name: '收藏·删除', status: 'fail' }]);
  assert.equal(failed.conclusion, '收藏·删除未产出结果。');
});

test('recordConfigEffect 记录首次生效步骤，与读取步骤区分', () => {
  useAsyncLocalStorage(StubStorage);
  const trace = createTrace('GET', '/api/v2/search/anime');
  runWithTrace(trace, () => {
    markStepActive('搜索·缓存查询');
    recordConfigAccess('sourceOrderArr', ['bilibili']);   // 早于生效的读取
    markStepActive('搜索·逐源检索');
    recordConfigEffect('SOURCE_ORDER', { label: '逐源检索结果', kind: 'stats' });
  });
  const entry = trace.configs.sourceOrderArr;
  assert.equal(entry.step, '搜索·缓存查询', '读取步骤保留首次读取位置');
  assert.equal(entry.effectStep, '搜索·逐源检索', '生效步骤单独记录');
});

test('buildResultDiagnosis 无数量时也指出未找到（miss）的步骤', () => {
  // 收藏删除/刷新等 404 用 miss 表达，结论应给出原因而非兜底文案
  const missing = buildResultDiagnosis([
    { name: '收藏·删除', status: 'miss', reason: '未找到该收藏' },
  ]);
  assert.equal(missing.zeroStep, '收藏·删除');
  assert.equal(missing.conclusion, '收藏·删除：未找到该收藏。');

  // 严重程度优先：fail 先于 miss
  const mixed = buildResultDiagnosis([
    { name: '收藏·删除', status: 'miss', reason: '未找到该收藏' },
    { name: '收藏·写入', status: 'fail', reason: '写入失败' },
  ]);
  assert.equal(mixed.zeroStep, '收藏·写入');
  assert.match(mixed.conclusion, /写入失败/);
});

test('buildResultDiagnosis 优先指出未找到目标的 empty 步骤', () => {
  // 真实弹幕请求：资源定位 empty（弹幕库 ID 未关联播放地址）才是根因，本地弹幕 miss 只是正常流转
  const blocked = buildResultDiagnosis([
    { name: '弹幕·资源定位', status: 'empty', reason: '该弹幕库 ID 未关联播放地址' },
    { name: '弹幕·本地弹幕', status: 'miss', reason: '未匹配到本地弹幕资源' },
  ]);
  assert.equal(blocked.zeroStep, '弹幕·资源定位');
  assert.equal(blocked.conclusion, '弹幕·资源定位：该弹幕库 ID 未关联播放地址。');
});

test('buildResultDiagnosis 不把中途未命中当作中断原因', () => {
  // 本地弹幕未命中后仍会继续网络抓取，若最终无结果，不应归咎于它
  const noData = buildResultDiagnosis([
    { name: '弹幕·本地弹幕', status: 'miss', reason: '未匹配到本地弹幕资源' },
    { name: '弹幕·缓存查询', status: 'miss', reason: '缓存未命中', outputs: { hit: false, count: 0 } },
  ]);
  assert.notEqual(noData.zeroStep, '弹幕·本地弹幕');
  assert.doesNotMatch(noData.conclusion, /未匹配到本地弹幕资源/);
});

test('buildResultDiagnosis 全程为 0 且存在跳过步骤时说明跳过原因', () => {
  const skipped = buildResultDiagnosis([
    { name: '搜索·缓存查询', status: 'skip', reason: '关键字为空，直接返回空结果', outputs: { count: 0 } },
  ]);
  assert.match(skipped.conclusion, /在「搜索·缓存查询」步骤跳过/);
  assert.match(skipped.conclusion, /关键字为空/);
  assert.doesNotMatch(skipped.conclusion, /各步骤均正常返回/);
});

test('buildResultDiagnosis 写操作成功时用步骤说明作为结论', () => {
  // 删除收藏、设置定时等没有数量输出，不应落到「未记录结果数量」的兜底文案
  const removed = buildResultDiagnosis([
    { name: '收藏·删除', status: 'ok', reason: '已删除收藏', outputs: { removed: '某剧' } },
  ]);
  assert.equal(removed.conclusion, '已删除收藏。');
  assert.doesNotMatch(removed.conclusion, /未记录结果数量/);

  const scheduled = buildResultDiagnosis([
    { name: '收藏·定时刷新', status: 'ok', reason: '关闭定时刷新' },
  ]);
  assert.equal(scheduled.conclusion, '关闭定时刷新。');
});

test('buildResultDiagnosis 忽略非有限的数量值', () => {
  for (const count of [NaN, Infinity, -Infinity, '3', null]) {
    const diagnosis = buildResultDiagnosis([{ name: '搜索·持久化与响应', outputs: { count } }]);
    assert.equal(diagnosis.chain.length, 0, `${String(count)} 不应进入数量链`);
    assert.match(diagnosis.conclusion, /未记录结果数量/);
  }
});

test('buildResultDiagnosis 按步骤前缀选择结果单位，未知前缀回退候选', () => {
  const withPrefix = [
    { name: '弹幕·响应组装', outputs: { count: 3 } },
    { name: '详情·响应组装', outputs: { count: 4 } },
    { name: '收藏·写入', outputs: { count: 5 } },
    { name: '搜索·持久化与响应', outputs: { count: 6 } },
    { name: '分集·详情组装', outputs: { count: 7 } },
    { name: '分段弹幕·响应组装', outputs: { count: 2 } },
  ];
  for (const [index, unit] of ['条弹幕', '集', '条收藏', '条候选', '集', '条弹幕'].entries()) {
    const diagnosis = buildResultDiagnosis(withPrefix.slice(0, index + 1));
    assert.ok(diagnosis.conclusion.includes(unit), `${withPrefix[index].name} 应使用 ${unit}`);
  }
  // 未声明前缀的新步骤沿用候选口径，诊断不会因新接口失效
  const unknown = buildResultDiagnosis([{ name: '其他接口·响应组装', outputs: { count: 2 } }]);
  assert.ok(unknown.conclusion.includes('条候选'));
});

test('finishTrace 重复调用只留存一次且钩子触发一次', () => {
  const hooks = [];
  setTracePersistHook(() => hooks.push(1));
  const trace = createTrace('GET', '/x');
  traceStep('搜索·缓存查询', Date.now(), { outputs: { count: 1 } });
  finishTrace(trace);
  finishTrace(trace);
  finishTrace(trace, false);
  const saved = getTraceRecords().filter(record => record.id === trace.id);
  assert.equal(saved.length, 1, '重复结束不产生重复记录');
  assert.equal(hooks.length, 1, '重复结束不重复触发落盘');
  assert.equal(trace.finished, true);
  setTracePersistHook(null);
});

test('setTracePersistHook 在留存详情后触发落盘钩子', () => {
  const calls = [];
  setTracePersistHook(() => calls.push(1));
  const trace = createTrace('GET', '/api/v2/search/anime');
  runWithTrace(trace, () => traceStep('搜索·缓存查询', Date.now(), { status: 'miss' }));
  finishTrace(trace);
  assert.equal(calls.length, 1, '留存详情应触发一次落盘钩子');
  finishTrace(trace, false);
  assert.equal(calls.length, 1, '未留存的详情不触发落盘');
  setTracePersistHook(null);
});

test('currentTrace 在无作用域时返回 null', () => {
  assert.equal(currentTrace(), null);
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => assert.equal(currentTrace(), trace));
  assert.equal(currentTrace(), null);
});
