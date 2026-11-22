// 接口详情弹窗：加载态、全量配置覆盖分组与长值折叠、结果诊断、配置生效记录、处理流水线与注入边界

import { Globals } from '../../configs/globals.js';
import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestRecordsJsContent } from '../../ui/js/requestrecords.js';
import { mainJsContent } from '../../ui/js/main.js';
import { HTML_TEMPLATE } from '../../ui/template.js';
import { componentsCssContent } from '../../ui/css/components.css.js';
import { TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS } from '../../utils/pipeline-trace.js';
import { buildMatchScoring } from '../../apis/dandan-api.js';
import { buildSampleTrace, createRequestRecordsSandbox } from '../helpers/interface-detail.js';

// 追踪映射由配置目录注册，渲染夹具先完成一次配置加载
Globals.init({ LOG_LEVEL: 'error' });

test('渲染夹具的 escapeHtml 从 main.js 源码构造', () => {
  // 测试桩若与生产实现分叉，null/undefined 等边界会给出误导性结果
  const sourceMatch = mainJsContent.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/);
  assert.ok(sourceMatch, 'main.js 中应存在 escapeHtml');
  assert.ok(requestRecordsJsContent.indexOf('function escapeHtml') === -1, '本模块不应重复定义 escapeHtml');
});

test('切换页签刷新复用主脚本的 switchSection 机制', () => {
  // 主脚本按 section 调用各模块刷新函数，与日志页一致；不在请求记录模块包装全局函数
  assert.match(mainJsContent, /section === 'request-records'[\s\S]{0,160}renderRequestRecords\(\)/);
  assert.doesNotMatch(requestRecordsJsContent, /originalSwitchSection|window\.switchSection\s*=/);
  assert.doesNotMatch(requestRecordsJsContent, /setTimeout\(renderRequestRecords/);
});

test('HTML_TEMPLATE 内嵌接口详情弹窗的静态结构', () => {
  assert.match(HTML_TEMPLATE, /id="interface-detail-modal"/);
  assert.match(HTML_TEMPLATE, /id="interface-detail-loading"/);
  assert.match(HTML_TEMPLATE, /id="interface-detail-content"/);
  // 重试按钮按项目弹窗规范放在 footer，与清理缓存/重新部署等弹窗一致
  assert.match(HTML_TEMPLATE, /id="interface-detail-footer"[^>]*hidden[^>]*>[\s\S]*?retryInterfaceDetail\(\)/);
  assert.match(HTML_TEMPLATE, /closeInterfaceDetail\(\)/);
  assert.match(HTML_TEMPLATE, /openInterfaceDetail\(/);
  assert.match(HTML_TEMPLATE, /<h3>接口详情<\/h3>/);
});

test('openInterfaceDetail 慢响应不覆盖后打开的详情', async () => {
  const { context } = createRequestRecordsSandbox();
  // 第一条请求慢、第二条快：后打开的先返回，先打开的迟到响应应被丢弃
  const responses = {
    slow: { ok: true, json: async () => (await new Promise(r => setTimeout(r, 30)), { trace: { ...buildSampleTrace(), id: 'slow', path: '/slow' } }) },
    fast: { ok: true, json: async () => ({ trace: { ...buildSampleTrace(), id: 'fast', path: '/fast' } }) },
  };
  context.fetch = url => url.includes('slow') ? Promise.resolve(responses.slow) : Promise.resolve(responses.fast);
  const slow = context.openInterfaceDetail('slow');
  const fast = context.openInterfaceDetail('fast');
  await Promise.all([slow, fast]);
  const html = context.document.getElementById('interface-detail-content').innerHTML;
  assert.ok(html.includes('/fast'), '应展示后打开请求的内容');
  assert.ok(!html.includes('/slow'), '迟到的旧响应不应覆盖');
});

test('openInterfaceDetail 每次打开重置配置筛选', async () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.fetch = async () => ({ ok: true, json: async () => ({ trace: buildSampleTrace() }) });
  context.setInterfaceConfigFilter('hit');
  await context.openInterfaceDetail('1');
  const html = elements['interface-detail-content'].innerHTML;
  // 重置后展示全部配置，筛选按钮回到「全部」激活态
  assert.match(html, /class="id-filter-btn is-active"[^>]*data-config-filter="all"/);
});

test('openInterfaceDetail 打开时锁定页面滚动，关闭后解锁', async () => {
  const { context, getScrollLocks } = createRequestRecordsSandbox();
  context.fetch = async () => ({ ok: true, json: async () => ({ trace: buildSampleTrace() }) });
  assert.equal(getScrollLocks(), 0, '初始未锁定');
  await context.openInterfaceDetail('1');
  assert.equal(getScrollLocks(), 1, '打开后锁定，背景不随详情滚动');
  context.closeInterfaceDetail();
  assert.equal(getScrollLocks(), 0, '关闭后恢复页面滚动');
});

test('openInterfaceDetail 失败时给出重试入口', async () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ errorMessage: '服务异常' }) });
  await context.openInterfaceDetail('7');
  const html = elements['interface-detail-content'].innerHTML;
  assert.match(html, /加载失败：服务异常/);
  assert.doesNotMatch(html, /retryInterfaceDetail\(\)/, '重试按钮不属于错误文本');
  assert.equal(elements['interface-detail-footer'].hidden, false, '重试按钮在弹窗 footer 中显示');
});

test('modal-footer 的 hidden 属性有对应 CSS 显示规则', () => {
  // .modal-footer 的 display:flex 会覆盖浏览器默认 [hidden]，必须显式声明隐藏规则
  assert.match(componentsCssContent, /\.modal-footer\[hidden\]\s*\{[\s\S]*?display:\s*none/);
});

test('openInterfaceDetail 成功或重新打开时隐藏 footer', async () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ errorMessage: '失败' }) });
  await context.openInterfaceDetail('7');
  assert.equal(elements['interface-detail-footer'].hidden, false);

  context.fetch = async () => ({ ok: true, json: async () => ({ trace: buildSampleTrace() }) });
  await context.openInterfaceDetail('8');
  assert.equal(elements['interface-detail-footer'].hidden, true, '成功时不显示重试按钮');
});

test('renderInterfaceDetail 空详情走统一失败态并显示重试', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(null);
  assert.match(elements['interface-detail-content'].innerHTML, /未找到该请求的接口详情/);
  assert.equal(elements['interface-detail-footer'].hidden, false, '空详情也需要重试入口');
});

test('renderInterfaceDetail 正常渲染时不显示重试按钮', () => {
  const { context } = createRequestRecordsSandbox();
  context.document.getElementById('interface-detail-footer').hidden = false;
  context.renderInterfaceDetail(buildSampleTrace());
  assert.equal(context.document.getElementById('interface-detail-footer').hidden, true, '详情渲染成功后不显示重试');
});

test('renderInterfaceDetail 渲染后隐藏加载态，且 CSS 提供 [hidden] 显示规则', () => {
  assert.match(componentsCssContent, /\.interface-detail-loading\[hidden\][\s\S]*?display:\s*none/);
  assert.match(componentsCssContent, /\.interface-detail-content\[hidden\]\s*\{\s*display:\s*none/);
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  assert.equal(elements['interface-detail-loading'].hidden, true, '内容渲染后加载态必须隐藏');
  assert.equal(elements['interface-detail-content'].hidden, false);
});

test('requestRecordsJsContent 为合法 JS 且可被实例化', () => {
  assert.doesNotThrow(() => new Function(requestRecordsJsContent));
});

test('renderInterfaceDetail 渲染总览、结果诊断、处理流水线、配置覆盖四段且配置项齐全', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;

  assert.ok(html.includes('总览'), '缺少总览段');
  assert.ok(html.includes('结果诊断'), '缺少结果诊断段');
  const sample = buildSampleTrace();
  const readCount = sample.configs.filter(item => item.used).length;
  assert.ok(html.includes(`配置覆盖（${sample.configs.length} 项，本次读取 ${readCount} 项）`), '缺少配置覆盖段');
  assert.ok(html.includes('处理流水线'), '缺少处理流水线段');

  assert.ok(html.includes('GET'));
  assert.ok(html.includes('/api/v2/search/anime'));
  assert.ok(html.includes(trace.clientIp));
  assert.ok(html.includes('486 ms'));
  assert.ok(html.includes('3 ms / 483 ms'));

  assert.equal((html.match(/class="id-config-row"/g) || []).length, Object.keys(TRACE_CONFIG_ACCESSORS).length + Object.keys(TRACE_RUNTIME_ACCESSORS).length);
  for (const upName of Object.keys(TRACE_CONFIG_ACCESSORS)) {
    assert.ok(html.includes(upName), `配置覆盖缺少展示名 ${upName}`);
  }
  assert.ok(html.includes('id-badge-used'));
  assert.ok(html.includes('id-badge-unused'));
  assert.ok(html.includes('搜索·逐源检索'));

  for (const status of ['miss', 'ok', 'empty', 'fail', 'skip']) {
    assert.ok(html.includes('id-step-status-' + status), `缺少状态徽标 ${status}`);
  }
  assert.ok(html.includes('缓存未命中，进入逐源检索'));
  assert.ok(html.includes('id-step-slow'), '最慢步骤未被高亮');
  assert.ok(html.includes('id-kv-block'), '缺少输入/输出键值块');
  // 输入输出与配置生效记录共用同一套字段行渲染
  assert.ok(html.includes('id-field-key'), '输入输出应复用字段行渲染');
  assert.equal(html.includes('class="id-kv"'), false, '不应再单独实现键值行');
  assert.ok(html.includes('写入缓存失败'));
});

test('renderInterfaceConfigs 按分类分组并展示计数与描述', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  for (const label of ['API 配置', '源配置', '匹配配置', '弹幕配置', '缓存配置', '系统配置', '运行环境']) {
    assert.ok(html.includes(label), `缺少分类 ${label}`);
  }
  assert.equal((html.match(/class="id-config-group"/g) || []).length, 7);
  assert.ok(html.includes('id-config-group-count'));
  assert.ok(html.includes('剧集标题过滤规则'));
  assert.ok(html.includes('请求结束时的运行态'));
});

test('renderConfigChanges 配置名与说明同处行内文本流，复制不拆行', () => {
  // flex 子项之间的复制边界是换行，配置名与说明必须包在同一行内容器里才不被拆开
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-change-title'), '缺少行内标题容器');
  assert.ok(html.includes('</span> <span class="id-change-label">'), '配置名与说明之间应有空格文本节点');
});

test('renderRequestRecords 转义接口、IP 与参数中的注入内容', async () => {
  // 请求字段来自客户端输入，进入 innerHTML 前必须转义，避免请求记录页执行存储型脚本
  const records = [{
    requestId: '1',
    interface: '/api/v2/search/anime?keyword=%3Cimg%20src=x%20onerror=alert(1)%3E',
    method: 'GET<script>alert(2)</script>',
    clientIp: '<svg onload=alert(3)>',
    timestamp: '2026-01-01T00:00:00.000Z',
    params: { keyword: '<img src=x onerror=alert(4)>' },
  }];
  const { context, elements } = createRequestRecordsSandbox(records);
  await context.renderRequestRecords();
  const html = elements['request-records-list'].innerHTML;
  assert.ok(html.includes('&lt;img'), '接口路径中的脚本标签应转义');
  assert.ok(html.includes('&lt;script'), 'HTTP 方法中的脚本标签应转义');
  assert.ok(html.includes('&lt;svg'), '客户端 IP 中的注入应转义');
  assert.ok(html.includes('&lt;img src=x onerror=alert(4)&gt;'), '请求体参数应转义');
  assert.doesNotMatch(html, /<img|<script|<svg/, '不应产生真实注入元素');
});

test('renderInterfaceFailure 输出错误说明文本', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceFailure('该请求的接口详情已随记录容量淘汰，无法查看');
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('interface-detail-error'), '失败态应有错误样式容器');
  assert.ok(html.includes('已随记录容量淘汰'), '404 淘汰应说明原因而非仅报错');
});

test('renderInterfaceDetail 同一 trace 多次渲染输出一致', () => {
  // 渲染若依赖跨调用累积的全局状态（序号、筛选态），第二次打开会与第一次不同
  const { context } = createRequestRecordsSandbox();
  const content = context.document.getElementById('interface-detail-content');
  const trace = buildSampleTrace();
  const renders = [];
  for (let i = 0; i < 3; i++) {
    content.innerHTML = '';
    context.renderInterfaceDetail(trace);
    renders.push(content.innerHTML);
  }
  assert.equal(renders[0], renders[1], '第二次渲染应与第一次相同');
  assert.equal(renders[0], renders[2], '第三次渲染应与第一次相同');
});

test('renderInterfaceConfigs 优先展示配置的生效步骤', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  // 读取发生在缓存查询，真正生效在逐源检索
  trace.configs.SOURCE_ORDER = { ...trace.configs.SOURCE_ORDER, step: '搜索·缓存查询', effectStep: '搜索·逐源检索' };
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  const row = html.slice(html.indexOf('SOURCE_ORDER'));
  assert.ok(row.includes('搜索·逐源检索'), '应显示生效步骤，便于在流水线中对照');
  assert.ok(!row.slice(0, 400).includes('搜索·缓存查询'), '不应展示早于生效的读取步骤');
});

test('renderInterfaceConfigs 对长配置值折叠并给出展开按钮', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-long-value is-collapsed'), '超长配置值应默认折叠');
  assert.ok(html.includes('onclick="togglePreviewValue(this)"'), '折叠值应复用通用展开函数');
  assert.ok(html.includes('aria-controls="id-config-value-'), '展开按钮应通过 aria-controls 关联取值');
  assert.ok(html.includes('>展开</button>'));
  // 折叠按钮数量应与折叠值数量一致，且短值不生成按钮
  const collapsed = (html.match(/id-long-value is-collapsed/g) || []).length;
  const buttons = (html.match(/onclick="togglePreviewValue\(this\)"/g) || []).length;
  assert.ok(collapsed > 0);
  assert.equal(buttons, collapsed, '仅长值生成展开按钮');
});

test('renderInterfaceConfigs 短值不折叠', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.configs = trace.configs.map(c => ({ ...c, value: 'false' }));
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.equal(html.includes('is-collapsed'), false);
  assert.equal(html.includes('togglePreviewValue(this)'), false);
});

test('renderInterfaceDiagnosis 展示候选数变化链与归零步骤', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-diagnosis-empty'), '结果归零应有醒目样式');
  assert.ok(html.includes('候选结果在「搜索·源合并与过滤」步骤由 11 条候选归零'));
  assert.equal((html.match(/id-diagnosis-node/g) || []).length, 6);
  assert.equal((html.match(/id-diagnosis-zero/g) || []).length, 3,
    '归零点及其后的 0 条步骤标为归零');
  assert.ok(html.includes('id-diagnosis-arrow'));
});

test('renderInterfaceDiagnosis 缓存未命中的 0 不标为归零', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  const cacheNode = html.match(/<span class="id-diagnosis-node[^"]*">搜索·缓存查询 <b>0<\/b><\/span>/);
  assert.ok(cacheNode, '缓存未命中节点应正常渲染');
  assert.equal(cacheNode[0].includes('id-diagnosis-zero'), false);
});

test('renderInterfaceDiagnosis 在非归零请求给出保留条数结论', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.diagnosis = {
    chain: [{ name: '搜索·持久化与响应', count: 8, zero: false }],
    zeroStep: null,
    conclusion: '本次请求最终保留 8 条候选结果。',
  };
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('本次请求最终保留 8 条候选结果'));
  assert.equal(html.includes('id-diagnosis-empty'), false);
});

test('renderConfigChanges 展示处理前后取值、命中规则与保留/剔除项', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('配置生效与过滤判定'));
  assert.ok(html.includes('id-change-config'));
  assert.ok(html.includes('TITLE_NOISE_FILTER'));
  assert.ok(html.includes('剧名杂音清理'));
  assert.ok(html.includes('葬送的芙莉莲（真彩）'));
  assert.ok(html.includes('处理前'));
  assert.ok(html.includes('处理后'));
  assert.ok(html.includes('id-change-arrow'));
  assert.ok(html.includes('id-change-hit-yes'));
  assert.ok(html.includes('默认标题匹配'));
  assert.ok(html.includes('包含匹配与相似度匹配均未命中'));
  assert.ok(html.includes('id-change-item-removed'));
});

test('renderConfigChanges 结构化表格逐源展示候选链路', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-change-table'));
  for (const column of ['源', '状态', '原始候选', '保留', '剔除', '说明']) {
    assert.ok(html.includes('>' + column + '</th>'), `缺少列 ${column}`);
  }
  // 数值列的表头与单元格都带 id-num，避免值右对齐而表头左对齐的错位
  for (const column of ['原始候选', '保留', '剔除']) {
    assert.ok(html.includes('<th class="id-num">' + column + '</th>'), `数值列 ${column} 表头未右对齐`);
  }
  assert.ok(html.includes('哔哩哔哩'));
  assert.ok(html.includes('Animeko'));
  assert.ok(html.includes('请求超时'));
  assert.ok(html.includes('3 个源共返回 7 条候选'));
});

test('renderConfigChanges 评分表结果说明列展示候选的评分依据', () => {
  // 表头取生产评分表定义、行取真实 buildMatchScoring：两端列名脱节时说明列会退回「—」
  const apiSource = fs.readFileSync(new URL('../../apis/dandan-api.js', import.meta.url), 'utf8');
  const columnsLiteral = apiSource.match(/columns:\s*(\[[^\]]*\]),\s*rows:\s*scoringRows/)[1];
  const columns = JSON.parse(columnsLiteral.replace(/'/g, '"'));
  const attempts = [{ platform: 'qq', selected: true, candidates: [
    { title: '钢铁侠2', source: 'iqiyi', episodeTitle: '第1集', score: -99, stage: '参与评分',
      detail: '无平台偏好 +1、单集兜底 -100、合计 -99' },
  ] }];
  const { rows } = buildMatchScoring(attempts, { animeTitle: '钢铁侠2' });
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '匹配·搜索与候选评分', ms: 2, status: 'ok',
    changes: [{ label: '评分明细', kind: 'stats', table: { columns, rows } }],
  }];
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('<th>结果说明</th>'), '评分表头应使用结果说明列');
  assert.ok(html.includes('单集兜底'), '评分依据应渲染到结果说明列，而非显示「—」');
});

test('renderConfigChanges 主标题与别名合并为一个判定结果', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  const removedBlock = html.slice(html.indexOf('id-change-item-removed'));
  assert.ok(removedBlock.includes('正反対な君と僕'), '应展示主标题');
  assert.ok(removedBlock.includes('别名：相反的你和我'), '别名单独展示');
  assert.ok(removedBlock.includes('id-change-item-source'));
  assert.ok(removedBlock.includes('animeko'));
  // 保留与剔除默认收起，避免判定明细撑满页面
  assert.ok(html.includes('<details class="id-change-items">'));
  assert.equal(html.includes('<details class="id-change-items" open>'), false);
  assert.ok(removedBlock.indexOf('正反対な君と僕') < removedBlock.indexOf('id-change-item-source'),
    '来源应排在标题之后');
});

test('renderDetailValue 对象取值按中文字段名展示并保留原始键名', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-field-key'));
  assert.ok(html.includes('搜索词'));
  assert.ok(html.includes('判定规则'));
  assert.ok(html.includes('<span class="id-raw">q</span>'), '步骤输入应保留原始键名');
});

test('renderInterfaceConfigs 按分类折叠并叠加命中/未命中状态', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('<details class="id-config-group">'), '分类分组应使用可折叠容器');
  assert.equal(html.includes('<details class="id-config-group" open>'), false, '分类默认折叠');
  assert.ok(html.includes('id-badge-hit'), '命中配置应有已命中徽标');
  assert.ok(html.includes('id-badge-miss'), '未生效配置应有未命中徽标');
  const rowOf = name => {
    const start = html.indexOf('<div class="id-config-row"><div class="id-config-name">' + name + '</div>');
    assert.ok(start !== -1, `缺少配置行 ${name}`);
    const end = html.indexOf('<div class="id-config-row">', start + 1);
    return html.slice(start, end === -1 ? start + 2000 : end);
  };
  const hitRow = rowOf('TITLE_NOISE_FILTER');
  assert.ok(hitRow.includes('已读取'));
  assert.ok(hitRow.includes('已命中'));
  const missRow = rowOf('STRICT_TITLE_MATCH');
  assert.ok(missRow.includes('已读取'));
  assert.ok(missRow.includes('未命中'));
});

test('renderInterfaceDetail 配置覆盖位于处理流水线之后', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(buildSampleTrace());
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.indexOf('结果诊断') < html.indexOf('处理流水线'));
  assert.ok(html.indexOf('处理流水线') < html.indexOf('配置覆盖'));
});

test('renderInterfaceConfigs 支持按已读取与已命中筛选', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  const base = { category: 'system', description: 'x' };
  trace.configs = [
    { ...base, name: 'A', accessor: 'a', value: '1', used: true, hit: true },
    { ...base, name: 'B', accessor: 'b', value: '2', used: true, hit: false },
    { ...base, name: 'C', accessor: 'c', value: '3', used: false },
  ];
  const rowsOf = () => (elements['interface-detail-content'].innerHTML.match(/class="id-config-row"/g) || []).length;

  context.renderInterfaceDetail(trace);
  assert.equal(rowsOf(), 3, '默认展示全部配置');

  context.setInterfaceConfigFilter('used');
  assert.equal(rowsOf(), 2, '仅已读取只展示读取过的配置');

  context.setInterfaceConfigFilter('hit');
  assert.equal(rowsOf(), 1, '仅已命中只展示命中配置');

  context.setInterfaceConfigFilter('all');
  assert.equal(rowsOf(), 3, '切回全部恢复');
});

test('renderInterfaceConfigs 筛选结果为空时给出提示', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.configs = [{ name: 'A', accessor: 'a', category: 'system', description: 'x', value: '1', used: true, hit: false }];
  context.renderInterfaceDetail(trace);
  context.setInterfaceConfigFilter('hit');
  const html = elements['interface-detail-content'].innerHTML;
  assert.match(html, /当前筛选下没有配置项/);
});

test('renderInterfaceConfigs 未知分类仍展示不至于静默丢失', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  // 在详情接口返回的配置项中加入一个硬编码清单之外的新分类
  trace.configs.push({
    name: 'NEW_OPTION', accessor: 'newOption', category: 'newCategory',
    description: '新增分类配置', value: 'x', used: true,
  });
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('NEW_OPTION'), '新增分类的配置项应展示');
  assert.ok(html.includes('newCategory'), '未知分类以原始分类名作为分组标题');
});

test('idFieldLabels 覆盖各接口打点的全部字段名', async () => {
  // 字段中文名是界面可读性的前提：打点字段漏配标签时在此失败
  const fs = await import('node:fs');
  const { requestRecordsJsContent } = await import('../../ui/js/requestrecords.js');
  const block = requestRecordsJsContent.slice(
    requestRecordsJsContent.indexOf('const idFieldLabels'),
    requestRecordsJsContent.indexOf('const idValueLabels'),
  );
  const labels = new Set([...block.matchAll(/([A-Za-z_$][\w$]*): '/g)].map(match => match[1]));
  // 遍历全部业务目录，任何打点字段漏配标签都会失败
  const collectSources = dir => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) out.push(...collectSources(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const sources = ['apis/', 'utils/', 'sources/', 'configs/']
    .flatMap(relative => collectSources(new URL('../../' + relative, import.meta.url)));
  const missing = new Set();
  let fieldCount = 0;
  for (const sourceUrl of sources) {
    const code = fs.readFileSync(sourceUrl, 'utf8');
    for (const match of code.matchAll(/(?:inputs|outputs):\s*\{([^}]*)\}/g)) {
      for (const part of match[1].split(',')) {
        const key = part.split(':')[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
        fieldCount++;
        if (!labels.has(key)) missing.add(key);
      }
    }
  }
  assert.ok(fieldCount > 20, `字段提取数量异常: ${fieldCount}`);
  assert.deepEqual([...missing].sort(), [], '打点字段缺少中文名');
});

test('renderConfigChanges 统计与判定类记录不展示处理前后', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·逐源检索', ms: 1, status: 'ok',
    changes: [
      {
        config: 'SOURCE_ORDER', label: '逐源检索结果', kind: 'stats',
        context: { 检索顺序: '哔哩哔哩 → Animeko' },
        summary: '2 个源共返回 5 条候选，保留 3 条',
        table: { columns: ['源', '保留'], rows: [{ 源: '哔哩哔哩', 保留: 3 }] },
      },
      {
        config: null, label: '默认标题匹配', kind: 'decision',
        context: { 搜索词: '测试' },
        summary: '共判定 2 次：命中 1 次、未命中 1 次',
        kept: [{ value: '测试' }], keptCount: 1,
        removed: [{ value: '别的标题', reason: '未命中' }], removedCount: 1,
      },
    ],
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.equal(html.includes('处理前'), false, '统计与判定类不应出现处理前');
  assert.equal(html.includes('处理后'), false, '统计与判定类不应出现处理后');
  assert.ok(html.includes('id-change-context'));
  assert.ok(html.includes('检索条件'));
  assert.ok(html.includes('判定条件'));
  assert.ok(html.includes('剔除的候选由下方的判定记录逐条说明'), '统计应与判定建立引用关系');
  assert.ok(html.includes('id-change-table'));
  assert.ok(html.includes('id-change-item-kept'));
});

test('renderConfigChanges 命中标记缺失时不展示命中/未命中徽标', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·缓存查询', ms: 1, status: 'miss',
    changes: [{
      config: 'SEARCH_CACHE_MINUTES', label: '搜索缓存键与有效期',
      before: { keyword: 'x', season: null }, after: { cacheKey: 'x', ttlMinutes: 3 },
    }],
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  const changesHtml = html.slice(html.indexOf('id-changes'), html.indexOf('id-section-title">配置覆盖'));
  assert.ok(changesHtml.includes('搜索缓存键与有效期'));
  assert.equal(changesHtml.includes('id-change-hit-yes'), false);
  assert.equal(changesHtml.includes('id-change-hit-no'), false);
});

test('renderConfigChanges 在样本超过上限时给出总数提示', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·逐源检索', ms: 1, status: 'ok',
    changes: [{
      config: 'STRICT_TITLE_MATCH', label: '严格标题匹配',
      kept: [{ value: '保留1' }], removed: [{ value: '剔除1', reason: '原因' }],
      keptCount: 12, removedCount: 20,
    }],
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-change-more'));
  assert.ok(html.includes('另有 19 项未显示'), '应给出剩余未显示的条数');
});

test('renderInterfaceDetail 对未记录步骤的请求给出空流水线提示', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('处理流水线'));
  assert.ok(html.includes('id-no-steps'), '空步骤应展示提示');
});

test('renderInterfaceDetail 在 trace 缺失时仅展示错误', () => {
  const { context, elements } = createRequestRecordsSandbox();
  context.renderInterfaceDetail(null);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('未找到该请求的接口详情'));
  assert.equal(elements['interface-detail-content'].hidden, false);
});

test('renderRequestRecords 为带 requestId 的记录渲染查看详情按钮，无 requestId 则不渲染', async () => {
  const withId = {
    interface: '/api/v2/search/anime',
    requestId: '99',
    method: 'GET',
    clientIp: '5.5.5.5',
    timestamp: 1700000000000,
    params: { q: 'a' },
  };
  const withoutId = {
    interface: '/api/v2/match',
    requestId: null,
    method: 'POST',
    clientIp: '6.6.6.6',
    timestamp: 1700000000000,
    params: {},
  };
  const { context, elements } = createRequestRecordsSandbox([withId, withoutId]);
  await context.renderRequestRecords();
  const html = elements['request-records-list'].innerHTML;
  assert.ok(html.includes('data-request-id="99"'), '带 requestId 的记录应携带数据属性');
  assert.ok(html.includes('openInterfaceDetail(this.dataset.requestId)'), '整行点击按数据属性打开详情');
  assert.ok(html.includes('record-item is-clickable'), '整条记录应可点击');
  assert.ok(html.includes('查看详情'));
  assert.ok(html.includes('btn-primary btn-detail'), '查看详情按钮复用主按钮样式');
  // 按钮只作为入口提示，事件由整行冒泡处理，避免重复打开
  assert.equal(html.includes('onclick="event.stopPropagation()'), false);
  assert.equal((html.match(/data-request-id=/g) || []).length, 1,
    '无 requestId 的记录不应出现查看详情按钮');
});

test('renderRequestRecords 对 requestId 做属性转义，不把值拼进内联脚本', async () => {
  const malicious = '1" onmouseover="alert(1)';
  const { context, elements } = createRequestRecordsSandbox([{
    interface: '/api/v2/search/anime',
    requestId: malicious,
    method: 'GET',
    clientIp: '5.5.5.5',
    timestamp: 1700000000000,
    params: {},
  }]);
  await context.renderRequestRecords();
  const html = elements['request-records-list'].innerHTML;
  assert.ok(html.includes('&quot;'), '引号应转义为实体');
  assert.equal(html.includes('data-request-id="1" onmouseover='), false, '不得脱离属性边界');
  assert.equal((html.match(/openInterfaceDetail\(/g) || []).length, 1);
  assert.ok(html.includes('openInterfaceDetail(this.dataset.requestId)'));
});

test('renderInterfaceSteps 对状态徽标与文本做转义', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{ name: '<img src=x>', ms: 1, status: 'ok" onmouseover="alert(1)', reason: '<script>', inputs: { '<b>': '<i>' } }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.equal(html.includes('<img src=x>'), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<i>'), false);
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(html.includes('&quot;'), '状态徽标的 class 属性引号应转义');
});

test('renderInterfaceSteps 按记录顺序平铺展示并连续编号', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  // match 的真实记录顺序：搜索过程在评分之前完成，按此顺序展示才符合「先搜索后匹配」的因果
  trace.steps = [
    { name: '匹配·文件名解析', ms: 1, status: 'ok' },
    { name: '搜索·缓存查询', ms: 1, status: 'miss' },
    { name: '搜索·逐源检索', ms: 50, status: 'ok' },
    { name: '匹配·搜索与候选评分', ms: 5, status: 'ok' },
    { name: '匹配·结果组装', ms: 1, status: 'ok' },
  ];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  const entries = [...html.matchAll(/id-step-index[^>]*>([^<]+)<[^]*?id-step-name">([^<]+)/g)];
  assert.deepEqual(entries.map(m => [m[1], m[2]]), [
    ['1', '匹配·文件名解析'],
    ['2', '搜索·缓存查询'],
    ['3', '搜索·逐源检索'],
    ['4', '匹配·搜索与候选评分'],
    ['5', '匹配·结果组装'],
  ], '序号按记录顺序连续递增，不做父子重排');
});

test('renderRecordRow 按状态码区分成功与失败', () => {
  const { context } = createRequestRecordsSandbox();
  const base = { interface: '/api/v2/match', method: 'POST', timestamp: '2026-11-19T00:00:00.000Z', clientIp: '1.1.1.1' };

  const ok = context.renderRecordRow({ ...base, statusCode: 200 });
  assert.match(ok, /class="record-status">200</, '成功状态码不带警示样式');

  const failed = context.renderRecordRow({ ...base, statusCode: 429 });
  assert.match(failed, /class="record-status is-error">429</, '4xx 使用警示样式');

  const legacy = context.renderRecordRow(base);
  assert.match(legacy, /class="record-status is-pending">—</, '无状态码的历史记录显示占位');
});

test('renderInterfaceSteps 为每个步骤标注顺序号', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [
    { name: '搜索·缓存查询', ms: 1, status: 'miss' },
    { name: '搜索·逐源检索', ms: 2, status: 'ok' },
    { name: '搜索·源合并与过滤', ms: 3, status: 'empty' },
  ];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  for (const index of [1, 2, 3]) {
    const pattern = new RegExp('class="id-step-index[^"]*">' + index + '<');
    assert.ok(pattern.test(html), `缺少序号 ${index}`);
  }
  // 轨道连接线只出现在非末步骤之间
  assert.equal((html.match(/id-step-line/g) || []).length, 2);
});

test('renderInterfaceSteps 不再区分主线与子步骤形态', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  // 嵌套只是耗时核算概念：界面统一平铺，不出现缩进标记与「含子步骤」括号注解
  trace.steps = [
    { name: '搜索·逐源检索', ms: 100, status: 'ok', nested: true },
    { name: '匹配·搜索与候选评分', ms: 5, totalMs: 105, status: 'ok' },
  ];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.doesNotMatch(html, /id-step-nested/, '不产生缩进标记');
  assert.doesNotMatch(html, /含子步骤共/, '不展示含子步骤的总耗时括号');
  assert.ok(html.includes('100 ms'), '各步骤只展示自身耗时');
  assert.ok(html.includes('5 ms'), '父步骤展示独占耗时');
});

test('renderInterfaceDiagnosis 步骤内处理过程并列展示处理前后数量', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.diagnosis = {
    chain: [
      { name: '弹幕·抓取与过滤', count: 23455, rawCount: 28933 },
      { name: '弹幕·响应组装', count: 23455 },
    ],
    conclusion: 'x',
  };
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.match(html, /28933→23455/, '处理过程应并列展示处理前后数量');
});

test('renderInterfaceSteps 默认形态取值弱化显示，有内容的字段保持常规样式', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '匹配·搜索与候选评分', ms: 5, status: 'ok',
    outputs: { count: 1, 标题未命中: 2, 年份不符: 0, 无分集: 0, 应用映射: false },
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  // 计数为非零、或枚举为真值的字段保持常规显示
  assert.match(html, /<div class="id-field"><span class="id-field-key">数量/, '数量为正数时不弱化');
  assert.match(html, /id-field-key">标题未命中/, '非零计数不弱化');
  // 零值与 false 收弱化样式，视觉上退到次要位置
  const quietCount = (html.match(/<div class="id-field is-quiet">/g) || []).length;
  assert.equal(quietCount, 3, '年份不符、无分集、应用映射三处弱化');
});

test('renderChangeTable 数值单元格右对齐，文本单元格保持左对齐', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·逐源检索', ms: 5, status: 'ok',
    table: { columns: ['源', '数量'], rows: [{ 源: '豆瓣', 数量: 12 }] },
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('<td class="id-num">12</td>'), '数值列应带右对齐标记');
  assert.ok(html.includes('<td>豆瓣</td>'), '文本列不加对齐标记');
});

test('renderConfigChanges 判定类没有剔除项时不展示未命中徽标', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·逐源检索', ms: 1, status: 'ok',
    changes: [
      {
        config: null, label: '默认标题匹配（包含 / 相似度）', kind: 'decision', hit: false,
        context: { 搜索词: 'x' }, summary: '共 1 个判定结果：命中 1 个、未命中 0 个',
        kept: [{ value: 'x', source: 'tencent' }], keptCount: 1, removedCount: 0,
      },
    ],
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.equal(html.includes('id-change-hit-no'), false, '保留全部时不应显示未命中');
  assert.ok(html.includes('标题命中 1'));
});

test('renderInterfaceSteps 渲染步骤级明细表格', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '匹配·搜索与候选评分', ms: 3, status: 'ok',
    outputs: { candidateCount: 2, matched: true, source: 'bilibili' },
    table: {
      columns: ['偏好组', '候选', '命中集', '分数', '结果'],
      rows: [
        { 偏好组: 'bilibili', 候选: '钢铁侠2', 命中集: '第1集', 分数: 100, 结果: '选中' },
        { 偏好组: 'qq', 候选: '钢铁侠2 普通话', 命中集: '第1集', 分数: 0, 结果: '未选中' },
      ],
    },
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-change-table'), '步骤明细应渲染为表格');
  assert.ok(html.includes('命中集'));
  assert.ok(html.includes('偏好组'), '平台列应标明是偏好组');
  assert.ok(html.includes('选中'));
  assert.ok(html.includes('未选中'));
});

test('renderInterfaceSteps 以中文展示步骤状态', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [
    { name: '搜索·缓存查询', ms: 1, status: 'miss' },
    { name: '搜索·逐源检索', ms: 2, status: 'ok' },
    { name: '搜索·源合并与过滤', ms: 3, status: 'empty' },
    { name: '搜索·持久化与响应', ms: 4, status: 'fail' },
  ];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  for (const text of ['未命中', '成功', '无结果', '失败']) {
    assert.ok(html.includes('>' + text + '</span>'), `状态应显示为 ${text}`);
  }
  // 样式类沿用原始状态值，便于按状态着色
  assert.ok(html.includes('id-step-status-miss'));
  assert.ok(html.includes('id-step-status-empty'));
});

test('renderInterfaceSteps 渲染失败步骤的错误信息并转义', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{ name: '搜索·逐源检索', ms: 1, status: 'fail', reason: '抛出异常', error: '<b>源站不可达</b>' }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.ok(html.includes('id-step-status-fail'));
  assert.ok(html.includes('id-step-error'));
  assert.ok(html.includes('&lt;b&gt;源站不可达&lt;/b&gt;'));
  assert.equal(html.includes('<b>源站不可达</b>'), false);
});

test('renderConfigChanges 对候选项与原因做转义', () => {
  const { context, elements } = createRequestRecordsSandbox();
  const trace = buildSampleTrace();
  trace.steps = [{
    name: '搜索·逐源检索', ms: 1, status: 'ok',
    changes: [{
      config: 'STRICT_TITLE_MATCH', label: '<img src=x>',
      before: '<script>', after: '<b>',
      kept: [{ value: '<svg onload=alert(1)>' }], removed: [{ value: '<iframe>', reason: '<script>' }],
    }],
  }];
  context.renderInterfaceDetail(trace);
  const html = elements['interface-detail-content'].innerHTML;
  assert.equal(html.includes('<img src=x>'), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<svg onload=alert(1)>'), false);
  assert.equal(html.includes('<iframe>'), false);
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
});

test('renderDetailValue 折叠样式与配置预览共用同一套 CSS 类', () => {
  const preview = fs.readFileSync(new URL('../../ui/js/preview.js', import.meta.url), 'utf8');
  assert.match(preview, /function togglePreviewValue\(button\)/);
  assert.match(preview, /getAttribute\('aria-controls'\)/);
  assert.match(componentsCssContent, /\.preview-value\.is-collapsed/);
  assert.match(componentsCssContent, /\.id-long-value\.is-collapsed/);
});
