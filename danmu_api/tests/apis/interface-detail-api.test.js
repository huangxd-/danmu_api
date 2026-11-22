// 接口详情服务端接口：全量配置覆盖、分类描述、结果诊断、非 admin 脱敏、未命中 404
// 经由 system-api.handleInterfaceDetail 验证 /api/interface-detail/:id 的响应字段与脱敏规则。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { handleInterfaceDetail } from '../../apis/system-api.js';
import { Globals, globals } from '../../configs/globals.js';
import {
  createTrace, finishTrace, TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS,
  recordConfigEffect, recordTitleDecision, runWithTrace, markStepActive, traceStep, useAsyncLocalStorage,
} from '../../utils/pipeline-trace.js';

function seedTrace() {
  const trace = createTrace('GET', '/api/v2/search/anime', '9.9.9.9');
  trace.query = '?keyword=%E8%91%AC%E9%80%81';
  trace.steps = [{
    name: '搜索·缓存查询',
    ms: 1,
    status: 'miss',
    inputs: { q: '葬送的芙莉莲', animeId: '123' },
    outputs: { hit: false },
    error: '缓存读取失败',
  }];
  finishTrace(trace);
  return trace;
}

function useToken(currentToken, adminToken) {
  Globals.init({ ADMIN_TOKEN: adminToken });
  globals.currentToken = currentToken;
  useAsyncLocalStorage(AsyncLocalStorage);
}

test('handleInterfaceDetail 透传追踪字段且不暴露内部计时字段', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = createTrace('GET', '/api/v2/search/anime');
  runWithTrace(trace, () => {
    traceStep('搜索·缓存查询', Date.now(), { status: 'miss' });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  assert.equal(body.trace.startedAt, undefined, '内部计时字段不进入详情');
  assert.equal(body.trace.finished, undefined, '结束标记不进入详情');
  assert.equal(body.trace.id, trace.id);
  assert.equal(body.trace.method, 'GET');
  // 追踪字段由剔除式 DTO 自动透传，无需逐字段登记
  trace.extraField = '透传值';
  const again = await (await handleInterfaceDetail(trace.id)).json();
  assert.equal(again.trace.extraField, '透传值');
});

test('handleInterfaceDetail 命中时返回全部配置项、分类描述与追踪字段', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = seedTrace();

  const response = await handleInterfaceDetail(trace.id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.trace, '命中时应返回 trace');
  assert.equal(body.trace.id, trace.id);
  assert.equal(body.trace.clientIp, '9.9.9.9');
  assert.equal(body.trace.method, 'GET');
  assert.equal(body.trace.path, '/api/v2/search/anime');
  assert.equal(body.trace.query, '?keyword=%E8%91%AC%E9%80%81');
  assert.equal(body.trace.steps[0].inputs.q, '葬送的芙莉莲');
  assert.deepEqual(Object.keys(body.trace).sort(), [
    'clientIp', 'configs', 'diagnosis', 'handlerMs', 'id', 'method', 'path', 'prepareMs', 'query', 'statusCode', 'steps', 'timestamp', 'totalMs',
  ]);

  const configs = body.trace.configs;
  const expected = Object.keys(TRACE_CONFIG_ACCESSORS).length + Object.keys(TRACE_RUNTIME_ACCESSORS).length;
  assert.equal(configs.length, expected);
  const names = configs.map((c) => c.name);
  for (const upName of Object.keys(TRACE_CONFIG_ACCESSORS)) {
    assert.ok(names.includes(upName), `缺少配置项 ${upName}`);
  }
  for (const c of configs) {
    assert.ok(typeof c.accessor === 'string');
    assert.ok(typeof c.value === 'string');
    assert.equal(typeof c.used, 'boolean');
    assert.ok(c.step === null || typeof c.step === 'string');
    assert.ok(typeof c.category === 'string');
    assert.ok(typeof c.description === 'string');
  }
  const runtime = configs.filter(c => c.category === 'runtime');
  assert.equal(runtime.length, 5);
  assert.ok(runtime.every(c => c.description.length > 0));
  assert.equal(configs.find(c => c.name === 'SOURCE_ORDER').category, 'source');
  assert.equal(configs.find(c => c.name === 'EPISODE_TITLE_FILTER').category, 'match');
});

test('handleInterfaceDetail 敏感配置只显示已设置，不泄露取值', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = seedTrace();
  const body = await (await handleInterfaceDetail(trace.id)).json();
  const serialized = JSON.stringify(body.trace.configs);
  assert.equal(serialized.includes('admin-tok'), false);
  for (const name of ['TOKEN', 'ADMIN_TOKEN', 'AI_API_KEY', 'UPSTASH_REDIS_REST_URL']) {
    const c = body.trace.configs.find(item => item.name === name);
    assert.ok(c, `缺少 ${name}`);
    assert.ok(c.value === '已设置' || c.value === '未设置', `${name} 取值应为存在性标记`);
  }
  assert.equal(body.trace.configs.find(c => c.name === 'TOKEN').value, '已设置');
  assert.equal(body.trace.configs.find(c => c.name === 'AI_API_KEY').value, '未设置');
});

test('handleInterfaceDetail 远程映射地址对管理员也只显示存在性', async () => {
  Globals.init({
    ADMIN_TOKEN: 'admin-tok',
    TITLE_MAPPING_TABLE_URL: 'https://private.example/title.txt?token=title-secret',
    AUTO_MATCH_MAPPING_TABLE_URL: 'https://private.example/season.txt?sign=season-secret',
  });
  globals.currentToken = 'admin-tok';
  useAsyncLocalStorage(AsyncLocalStorage);
  const trace = seedTrace();
  const body = await (await handleInterfaceDetail(trace.id)).json();

  for (const name of ['TITLE_MAPPING_TABLE_URL', 'AUTO_MATCH_MAPPING_TABLE_URL']) {
    assert.equal(body.trace.configs.find(config => config.name === name)?.value, '已设置');
  }
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /private\.example|title-secret|season-secret/);
});

test('handleInterfaceDetail 结果归零诊断定位到具体步骤并保留配置生效记录', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    markStepActive('搜索·逐源检索');
    recordConfigEffect('TITLE_NOISE_FILTER', { label: '剧名杂音清理', before: '葬送的芙莉莲（真彩）', after: '葬送的芙莉莲', hit: true });
    recordTitleDecision({
      config: 'STRICT_TITLE_MATCH', label: '严格标题匹配', source: 'bilibili',
      value: '某某葬送的芙莉莲', matched: false, reason: '严格匹配：标题不以搜索词开头',
    });
    traceStep('搜索·逐源检索', Date.now(), {
      status: 'empty', reason: '所有源均未返回可用候选', outputs: { count: 0 },
    });
    traceStep('搜索·持久化与响应', Date.now(), { status: 'empty', outputs: { count: 0 } });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  assert.equal(body.trace.diagnosis.zeroStep, '搜索·逐源检索');
  assert.ok(body.trace.diagnosis.conclusion.includes('搜索·逐源检索'));
  assert.deepEqual(body.trace.diagnosis.chain, [
    { name: '搜索·逐源检索', count: 0, zero: true },
    { name: '搜索·持久化与响应', count: 0, zero: true },
  ]);
  assert.equal(body.trace.steps[0].changes.length, 2);
  assert.equal(body.trace.steps[0].changes[0].config, 'TITLE_NOISE_FILTER');
  assert.equal(body.trace.steps[0].changes[0].before, '葬送的芙莉莲（真彩）');
  const decision = body.trace.steps[0].changes[1];
  assert.equal(decision.config, 'STRICT_TITLE_MATCH');
  assert.equal(decision.removedCount, 1);
  assert.deepEqual(decision.removed, [{
    value: '某某葬送的芙莉莲', reason: '严格匹配：标题不以搜索词开头', source: 'bilibili',
  }]);
});

test('handleInterfaceDetail 缓存未命中的瞬时 0 不判为归零', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    traceStep('搜索·缓存查询', Date.now(), { status: 'miss', outputs: { count: 0 } });
    traceStep('搜索·逐源检索', Date.now(), { status: 'ok', outputs: { count: 6 } });
    traceStep('搜索·源合并与过滤', Date.now(), { status: 'empty', outputs: { count: 0 } });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  // 缓存未命中的 0 不进入数量链：归零点定位在真正的产出步骤，链中只剩缓存命中后的产出
  assert.equal(body.trace.diagnosis.zeroStep, '搜索·源合并与过滤');
  assert.ok(body.trace.diagnosis.conclusion.includes('由 6 条候选归零'));
  assert.deepEqual(body.trace.diagnosis.chain.map(item => item.zero), [false, true]);
});

test('handleInterfaceDetail 全源失败时归零点定位逐源检索', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    traceStep('搜索·缓存查询', Date.now(), { status: 'miss', outputs: { hit: false, count: 0 } });
    traceStep('搜索·逐源检索', Date.now(), { status: 'empty', reason: '所有源均未返回可用候选', outputs: { count: 0 } });
    traceStep('搜索·持久化与响应', Date.now(), { status: 'empty', outputs: { count: 0 } });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  assert.equal(body.trace.diagnosis.zeroStep, '搜索·逐源检索');
  assert.match(body.trace.diagnosis.conclusion, /自「搜索·逐源检索」步骤起未获得结果/);
});

test('handleInterfaceDetail 无候选数时给出可解释的结论', async () => {
  useToken('admin-tok', 'admin-tok');
  const trace = seedTrace();
  const body = await (await handleInterfaceDetail(trace.id)).json();
  assert.equal(body.trace.diagnosis.zeroStep, null);
  assert.deepEqual(body.trace.diagnosis.chain, []);
  assert.ok(body.trace.diagnosis.conclusion.includes('未记录结果数量'));
});

test('handleInterfaceDetail 非 admin 隐藏表格文本但保留列名与数值', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    traceStep('匹配·搜索与候选评分', Date.now(), {
      status: 'ok',
      outputs: { candidateCount: 1, count: 1 },
      table: {
        columns: ['偏好组', '候选', '分数'],
        rows: [{ 偏好组: 'bilibili', 候选: '钢铁侠2', 分数: 100 }],
      },
    });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  const table = body.trace.steps[0].table;
  assert.deepEqual(table.columns, ['偏好组', '候选', '分数'], '列名保留');
  assert.equal(table.rows[0].候选, '***', '单元格文本脱敏');
  assert.equal(table.rows[0].分数, 100, '数值保留');
});

test('handleInterfaceDetail 结果诊断按接口选择数量表述', async () => {
  useToken('admin-tok', 'admin-tok');
  const cases = [
    { path: '/api/v2/comment/123', step: '弹幕·响应组装', expected: '本次请求最终返回 8398 条弹幕。', unit: '条弹幕' },
    { path: '/api/v2/bangumi/B1', step: '详情·响应组装', expected: '本次请求最终返回 12 集。', unit: '集' },
    { path: '/api/v2/search/anime?keyword=x', step: '搜索·持久化与响应', expected: '本次请求最终保留 5 条候选。', unit: '条候选' },
  ];
  for (const item of cases) {
    const trace = createTrace('GET', item.path);
    runWithTrace(trace, () => {
      traceStep(item.step, Date.now(), { status: 'ok', outputs: { count: item.unit === '集' ? 12 : item.unit === '条弹幕' ? 8398 : 5 } });
      finishTrace(trace);
    });
    const body = await (await handleInterfaceDetail(trace.id)).json();
    assert.equal(body.trace.diagnosis.conclusion, item.expected, `${item.path} 的数量表述不符`);
  }
});

test('handleInterfaceDetail 非 admin token 隐藏客户端 IP、接口查询值与步骤数据', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = seedTrace();

  const response = await handleInterfaceDetail(trace.id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.trace.clientIp, '*.*.*.*');
  assert.equal(body.trace.path, '/api/v2/search/anime');
  assert.equal(body.trace.query, '?keyword=***', '查询串取值需脱敏');
  const step = body.trace.steps[0];
  assert.equal(step.inputs.q, '***');
  assert.equal(step.inputs.animeId, '***');
  assert.equal(step.error, '***');
  assert.equal(step.name, '搜索·缓存查询');
  assert.equal(step.status, 'miss');
  const catalogSize = Object.keys(TRACE_CONFIG_ACCESSORS).length + Object.keys(TRACE_RUNTIME_ACCESSORS).length;
  assert.equal(body.trace.configs.length, catalogSize);
});

test('handleInterfaceDetail 未配置 ADMIN_TOKEN 时无 token 请求仍脱敏', async () => {
  // 空 adminToken 与空 currentToken 相等，鉴权必须要求 adminToken 非空，否则无 token 请求被当作 admin
  useToken('', '');
  const trace = seedTrace();

  const response = await handleInterfaceDetail(trace.id);
  const body = await response.json();
  assert.equal(body.trace.clientIp, '*.*.*.*', '无 token 请求不得看到明文 IP');
  assert.equal(body.trace.query, '?keyword=***', '无 token 请求不得看到明文查询值');
  assert.equal(body.trace.steps[0].inputs.q, '***');
});

test('handleInterfaceDetail 非 admin 的步骤说明不夹带具体剧名', async () => {
  // 说明文本不参与输入脱敏，因此具体文本应放在 inputs，由脱敏规则统一打码
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('GET', '/api/v2/comment/10212');
  runWithTrace(trace, () => {
    traceStep('弹幕·偏移处理', Date.now(), {
      status: 'ok',
      reason: '偏移规则未命中，请核对 DANMU_OFFSET 中的剧名是否与实际剧名相符',
      inputs: { ruleOffset: 0, matchedTitle: '某部具体剧名' },
      outputs: { count: 10 },
    });
  });
  finishTrace(trace);

  const body = await (await handleInterfaceDetail(trace.id)).json();
  const step = body.trace.steps[0];
  assert.doesNotMatch(step.reason, /某部具体剧名/, '说明文本不应包含具体剧名');
  assert.equal(step.inputs.matchedTitle, '***', '输入中的剧名应脱敏');
});

test('handleInterfaceDetail 非 admin 保留数量与布尔，脱敏 ID 与文本', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    traceStep('搜索·逐源检索', Date.now(), {
      status: 'ok',
      inputs: { animeId: 12345, q: '秘密关键词', segment: true },
      outputs: { count: 7, matched: true, source: 'bilibili', title: '某剧名' },
    });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  const step = body.trace.steps[0];
  // 数量与布尔不泄露内容，保留；ID 能反推具体条目，与文本一起打码
  assert.equal(step.outputs.count, 7);
  assert.equal(step.outputs.matched, true);
  assert.equal(step.inputs.segment, true);
  assert.equal(step.outputs.source, '***');
  assert.equal(step.outputs.title, '***');
  assert.equal(step.inputs.animeId, '***');
  assert.equal(step.inputs.q, '***');
});

test('handleInterfaceDetail 非 admin 诊断不含源名但保留候选数', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    traceStep('匹配·搜索与候选评分', Date.now(), {
      status: 'ok', outputs: { candidateCount: 12, matched: true, source: 'bilibili', count: 1 },
    });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  assert.match(body.trace.diagnosis.conclusion, /从 12 条候选中匹配到 1 条候选/);
  assert.doesNotMatch(body.trace.diagnosis.conclusion, /bilibili/, '结论不得泄露脱敏后的源名');
});

test('handleInterfaceDetail 非 admin token 隐藏配置生效记录中的候选项，保留结构与计数', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordConfigEffect('STRICT_TITLE_MATCH', {
      label: '严格标题匹配', before: '百花杀（真彩）', after: '百花杀',
      kept: ['百花杀'], removed: [{ value: '某某百花杀', reason: '严格匹配：标题不以搜索词开头' }],
      keptCount: 1, removedCount: 1, hit: true,
    });
    traceStep('搜索·逐源检索', Date.now(), { outputs: { count: 0 } });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  const change = body.trace.steps[0].changes[0];
  assert.equal(change.config, 'STRICT_TITLE_MATCH');
  assert.equal(change.label, '严格标题匹配');
  assert.equal(change.keptCount, 1);
  assert.equal(change.removedCount, 1);
  assert.equal(change.before, '***');
  assert.equal(change.after, '***');
  assert.deepEqual(change.kept, ['***']);
  assert.deepEqual(change.removed, [{ value: '***', reason: '***' }]);
});

test('handleInterfaceDetail 非 admin token 保留变换记录中的计数与标记', async () => {
  useToken('user-tok', 'admin-tok');
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    recordConfigEffect('BLOCKED_WORDS', {
      label: '屏蔽词过滤', hit: true,
      before: { 弹幕条数: 12, 生效规则数: 2 }, after: { 弹幕条数: 10 },
    });
    traceStep('弹幕·抓取与过滤', Date.now(), { outputs: { count: 10 } });
    finishTrace(trace);
  });
  const body = await (await handleInterfaceDetail(trace.id)).json();
  const change = body.trace.steps[0].changes[0];
  assert.deepEqual(change.before, { 弹幕条数: 12, 生效规则数: 2 }, '计数不属于隐私，应原样保留');
  assert.deepEqual(change.after, { 弹幕条数: 10 });
  assert.equal(change.hit, true);
});

test('handleInterfaceDetail 未命中时返回 404', async () => {
  const response = await handleInterfaceDetail('never-created-id');
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.errorCode, 404);
  assert.ok(body.errorMessage.includes('接口详情'));
});
