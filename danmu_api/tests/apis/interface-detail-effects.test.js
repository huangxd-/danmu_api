// 接口详情排错能力：配置生效记录、标题过滤判定、映射命中与结果归零定位
// 覆盖上游原版不具备的结构化数据；断言落到具体字段内容，避免只校验存在性

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Globals } from '../../configs/globals.js';
import { titleMatches } from '../../utils/common-util.js';
import { setSearchCache } from '../../utils/cache-util.js';
import { searchAnime } from '../../apis/dandan-api.js';
import { getSourceByKey } from '../../sources/registry.js';
import {
  createTrace, runWithTrace, finishTrace, getInterfaceDetail, useAsyncLocalStorage, traceStep,
} from '../../utils/pipeline-trace.js';

function initGlobals(overrides = {}) {
  Globals.init(overrides);
  useAsyncLocalStorage(AsyncLocalStorage);
}

function searchUrl(keyword) {
  return new URL('http://localhost/api/v2/search/anime?keyword=' + encodeURIComponent(keyword));
}

function seedCache(keyword) {
  setSearchCache(keyword, [{
    animeId: 9101,
    bangumiId: 'EFFECT-9101',
    animeTitle: keyword,
    source: 'bilibili',
    episodes: [{ episodeId: 'E9101', episodeTitle: '第1集', episodeNumber: '1' }],
  }]);
}

// 在测试作用域内关闭当前步骤，使归并的配置生效记录落到 steps[0]
function traceStepForTest() {
  traceStep('测试步骤', Date.now(), { status: 'ok' });
}

test('titleMatches 严格模式登记被过滤与保留的候选及判定原因', () => {
  initGlobals({ STRICT_TITLE_MATCH: 'true' });
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    titleMatches('遮天', '遮天');
    titleMatches('古惑仔3之只手遮天', '遮天');
    traceStepForTest();
  });
  const change = trace.steps[0].changes.find(c => c.config === 'STRICT_TITLE_MATCH');
  assert.ok(change, '缺少严格匹配判定记录');
  assert.equal(change.keptCount, 1);
  assert.equal(change.removedCount, 1);
  assert.deepEqual(change.kept, [{ value: '遮天' }]);
  assert.equal(change.removed[0].value, '古惑仔3之只手遮天');
  assert.equal(change.removed[0].reason, '严格匹配：标题不以搜索词开头');
});

test('titleMatches 宽松模式登记季度校验拒绝原因', () => {
  initGlobals({});
  const trace = createTrace('GET', '/api/v2/search/anime');
  runWithTrace(trace, () => {
    titleMatches('某某 第二季', '某某 第一季');
    traceStepForTest();
  });
  const change = trace.steps[0].changes.find(c => c.label === '默认标题匹配（包含 / 相似度）');
  assert.ok(change, '缺少标题匹配规则判定记录');
  assert.equal(change.config, null, '默认规则不对应具体配置项');
  assert.equal(change.removedCount, 1);
  assert.match(change.removed[0].reason, /季度校验/);
});

test('titleMatches 的 forceNonStrict 偏好判定不登记为过滤', () => {
  initGlobals({ STRICT_TITLE_MATCH: 'true' });
  const trace = createTrace('GET', '/x');
  runWithTrace(trace, () => {
    titleMatches('古惑仔3之只手遮天', '遮天', null, true);
    traceStepForTest();
  });
  assert.equal(trace.steps[0].changes, undefined);
});

test('searchAnime 记录 TITLE_NOISE_FILTER 的处理前后具体取值', async () => {
  initGlobals({});
  const raw = '百花杀（真彩）';
  const clean = '百花杀';
  seedCache(clean);
  const trace = createTrace('GET', '/api/v2/search/anime');
  await runWithTrace(trace, () => searchAnime(searchUrl(raw)));
  const change = trace.steps[0].changes.find(c => c.config === 'TITLE_NOISE_FILTER');
  assert.ok(change, '缺少剧名杂音清理记录');
  assert.equal(change.before, raw);
  assert.equal(change.after, clean);
  assert.equal(change.hit, true);
});

test('searchAnime 记录 ANIME_TITLE_SIMPLIFIED 的处理前后具体取值', async () => {
  initGlobals({ ANIME_TITLE_SIMPLIFIED: 'true' });
  const raw = '葬送的芙莉蓮';
  const simplified = '葬送的芙莉莲';
  seedCache(simplified);
  const trace = createTrace('GET', '/api/v2/search/anime');
  await runWithTrace(trace, () => searchAnime(searchUrl(raw)));
  const change = trace.steps[0].changes.find(c => c.config === 'ANIME_TITLE_SIMPLIFIED');
  assert.ok(change, '缺少繁转简记录');
  assert.equal(change.before, raw);
  assert.equal(change.after, simplified);
});

test('Globals.resolveTitleMapping 记录本机映射命中与来源', () => {
  initGlobals({ TITLE_MAPPING_TABLE: '唐朝诡事录->唐朝诡事录之西行' });
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    Globals.resolveTitleMapping('唐朝诡事录');
    traceStepForTest();
  });
  const change = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE' && c.hit === true);
  assert.ok(change, '缺少本机映射命中记录');
  assert.equal(change.before.title, '唐朝诡事录');
  assert.equal(change.before.matchedKey, '唐朝诡事录');
  assert.equal(change.after.title, '唐朝诡事录之西行');
  assert.equal(change.after.origin, 'local');
  assert.equal(change.after.localRules, 1);
  assert.equal(trace.steps[0].changes.some(c => c.config === 'TITLE_MAPPING_TABLE_URL'), false,
    '未配置远程地址时不记录远程映射表');
});

test('Globals.resolveTitleMapping 本机命中且配置了远程地址时说明远程未参与', () => {
  initGlobals({
    TITLE_MAPPING_TABLE: '唐朝诡事录->唐朝诡事录之西行',
    TITLE_MAPPING_TABLE_URL: 'https://private.example/map.json?token=secret',
  });
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    Globals.resolveTitleMapping('唐朝诡事录');
    traceStepForTest();
  });
  const urlChange = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE_URL');
  assert.ok(urlChange, '缺少远程表未参与说明');
  assert.equal(urlChange.hit, false);
  assert.equal(urlChange.before.url, '已设置');
  assert.equal(urlChange.after.origin, 'local');
  assert.doesNotMatch(JSON.stringify(trace), /private\.example|token=secret/, '远程映射地址不得进入追踪记录');
});

test('Globals.resolveTitleMapping 记录远程映射命中与来源', () => {
  initGlobals({ TITLE_MAPPING_TABLE_URL: 'https://private.example/map.json?sign=secret' });
  Globals.remoteTitleMappingTable = new Map([['间谍过家家', '間諜家家酒']]);
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    Globals.resolveTitleMapping('间谍过家家');
    traceStepForTest();
  });
  const change = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE_URL' && c.hit === true);
  assert.ok(change, '缺少远程映射命中记录');
  assert.equal(change.before.title, '间谍过家家');
  assert.equal(change.after.title, '間諜家家酒');
  assert.equal(change.after.origin, 'remote');
  assert.equal(change.after.remoteRules, 1);
  assert.equal(change.before.url, '已设置');
  assert.doesNotMatch(JSON.stringify(trace), /private\.example|sign=secret/, '远程映射地址不得进入追踪记录');
});

test('Globals.resolveTitleMapping 记录未命中，便于定位配置未生效', () => {
  initGlobals({ TITLE_MAPPING_TABLE_URL: 'https://example.com/map.json' });
  Globals.remoteTitleMappingTable = new Map();
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    assert.equal(Globals.resolveTitleMapping('无映射剧名'), null);
    traceStepForTest();
  });
  const local = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE');
  assert.ok(local);
  assert.equal(local.hit, false);
  assert.deepEqual(local.before.triedKeys, ['无映射剧名']);
  const remote = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE_URL');
  assert.ok(remote);
  assert.equal(remote.hit, false);
  assert.equal(remote.after.remoteRules, 0);
});

test('Globals.resolveTitleMapping 忽略尾部年份后重试并记录尝试过的键', () => {
  initGlobals({ TITLE_MAPPING_TABLE: '唐朝诡事录->唐朝诡事录之西行' });
  const trace = createTrace('POST', '/api/v2/match');
  runWithTrace(trace, () => {
    assert.equal(Globals.resolveTitleMapping('唐朝诡事录 (2022)'), '唐朝诡事录之西行');
    traceStepForTest();
  });
  const change = trace.steps[0].changes.find(c => c.config === 'TITLE_MAPPING_TABLE' && c.hit === true);
  assert.equal(change.before.title, '唐朝诡事录 (2022)');
  assert.equal(change.before.matchedKey, '唐朝诡事录');
});

test('finishTrace 保留配置生效记录并可由 getInterfaceDetail 检出', async () => {
  initGlobals({});
  const raw = '百花杀（真彩）';
  seedCache('百花杀');
  const trace = createTrace('GET', '/api/v2/search/anime');
  await runWithTrace(trace, () => searchAnime(searchUrl(raw)));
  finishTrace(trace);
  const detail = getInterfaceDetail(trace.id);
  const change = detail.steps[0].changes.find(c => c.config === 'TITLE_NOISE_FILTER');
  assert.ok(change);
  assert.equal(change.before, raw);
  assert.equal(change.after, '百花杀');
  assert.equal(detail.steps[0].outputs.count, 1);
});

test('searchAnime 结果归零时步骤带 empty 状态与原因', async () => {
  initGlobals({});
  const trace = createTrace('GET', '/api/v2/search/anime');
  await runWithTrace(trace, () => searchAnime(searchUrl('')));
  const step = trace.steps[0];
  assert.equal(step.status, 'skip');
  assert.equal(step.outputs.count, 0);
  assert.match(step.reason, /关键字为空/);
});

test('searchAnime 逐源检索表格记录每个源的耗时', async () => {
  initGlobals({ SOURCE_ORDER: 'bilibili' });
  const instance = getSourceByKey('bilibili');
  const originalSearch = instance.search;
  instance.search = async () => [];
  try {
    const trace = createTrace('GET', '/api/v2/search/anime');
    await runWithTrace(trace, () => searchAnime(searchUrl('耗时验证')));
    const stats = trace.steps.find(step => step.name === '搜索·逐源检索').changes
      .find(change => change.config === 'SOURCE_ORDER');
    assert.ok(stats.table, '缺少逐源统计表');
    assert.ok(stats.table.columns.includes('耗时(ms)'));
    const row = stats.table.rows.find(item => item['源'] === '哔哩哔哩');
    assert.ok(row, '缺少对应源的行');
    assert.equal(typeof row['耗时(ms)'], 'number');
    assert.ok(row['耗时(ms)'] >= 0, '耗时不能为负');
  } finally {
    instance.search = originalSearch;
  }
});

test('searchAnime 逐源检索抛出异常时记录 fail 步骤与错误信息', async () => {
  initGlobals({ SOURCE_ORDER: 'bilibili' });
  const instance = getSourceByKey('bilibili');
  const originalSearch = instance.search;
  instance.search = () => { throw new Error('模拟源站不可达'); };
  try {
    const trace = createTrace('GET', '/api/v2/search/anime');
    await runWithTrace(trace, () => searchAnime(searchUrl('异常验证')));
    const failStep = trace.steps.find(step => step.status === 'fail');
    assert.ok(failStep, '缺少失败步骤记录');
    assert.equal(failStep.name, '搜索·检索异常');
    assert.match(failStep.reason, /抛出异常/);
    assert.equal(failStep.error, '模拟源站不可达');
  } finally {
    instance.search = originalSearch;
  }
});
