// 接口详情页面级校验：Node 渲染完整 HTML_TEMPLATE，验证四段结构、76 项配置分组与样式定义齐备

import { Globals } from '../../configs/globals.js';
import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HTML_TEMPLATE } from '../../ui/template.js';
import { componentsCssContent } from '../../ui/css/components.css.js';
import { responsiveCssContent } from '../../ui/css/responsive.css.js';
import { requestRecordsJsContent } from '../../ui/js/requestrecords.js';
import { TRACE_CONFIG_ACCESSORS, TRACE_RUNTIME_ACCESSORS } from '../../utils/pipeline-trace.js';
import { buildSampleTrace, renderInterfaceDetailHtml, renderInterfaceDetailPage } from '../helpers/interface-detail.js';

// 追踪映射由配置目录注册，渲染夹具先完成一次配置加载
Globals.init({ LOG_LEVEL: 'error' });

// 从页面里取出所有接口详情相关的 class，避免渲染出无样式的元素
function detailClasses(html) {
  const classes = new Set();
  for (const match of html.matchAll(/class="([^"]+)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token.startsWith('id-') || token.startsWith('interface-detail-') || token === 'is-collapsed') classes.add(token);
    }
  }
  return [...classes];
}

test('renderInterfaceDetailPage 渲染完整页面与四段结构', async () => {
  const html = await renderInterfaceDetailPage();
  const detailHtml = await renderInterfaceDetailHtml();
  assert.match(html, /<div class="modal active" id="interface-detail-modal" aria-hidden="false">/);
  assert.match(html, /id="interface-detail-loading" class="interface-detail-loading" hidden/);
  assert.match(html, /<div id="interface-detail-content" class="interface-detail-content">/);
  assert.ok(!html.includes('<div id="interface-detail-content" class="interface-detail-content" hidden>'));

  assert.ok(html.includes('总览'));
  assert.ok(html.includes('结果诊断'));
  const sample = buildSampleTrace();
  const readCount = sample.configs.filter(item => item.used).length;
  assert.ok(html.includes(`配置覆盖（${sample.configs.length} 项，本次读取 ${readCount} 项）`));
  assert.ok(html.includes('处理流水线'));
  const expected = Object.keys(TRACE_CONFIG_ACCESSORS).length + Object.keys(TRACE_RUNTIME_ACCESSORS).length;
  assert.equal(sample.configs.length, expected, '夹具应覆盖全部配置项');
  assert.equal((detailHtml.match(/class="id-config-row"/g) || []).length, expected);
  for (const name of Object.keys(TRACE_CONFIG_ACCESSORS)) {
    assert.ok(detailHtml.includes(name), `页面缺少配置项 ${name}`);
  }
  assert.ok(html.includes('状态码'));
  assert.ok(html.includes('200'));
  assert.ok(html.includes('192.168.1.20'));
  assert.ok(html.includes('keyword=%E8%91%AC'), '总览应展示完整请求接口');
  assert.ok(html.includes('486 ms'));
  assert.ok(html.includes('3 ms / 483 ms'));

  // 步骤时间线、配置生效记录与请求记录列表的关联入口
  assert.ok(html.includes('搜索·逐源检索'));
  assert.ok(html.includes('id-step-slow'));
  assert.ok(html.includes('id-kv-block'));
  assert.ok(html.includes('配置生效与过滤判定'));
  assert.ok(html.includes('data-request-id="42"'));
  assert.ok(html.includes('openInterfaceDetail(this.dataset.requestId)'));
});

test('renderInterfaceDetailHtml 输出的 class 均在 components.css.js 中定义', async () => {
  const detailHtml = await renderInterfaceDetailHtml();
  for (const token of detailClasses(detailHtml)) {
    assert.ok(componentsCssContent.includes('.' + token), `样式缺失: .${token}`);
  }
  for (const token of ['interface-detail-modal-content', 'interface-detail-loading', 'interface-detail-content']) {
    assert.ok(componentsCssContent.includes('.' + token), `样式缺失: .${token}`);
  }
});

test('componentsCss 接口详情在窄屏下切换为单列布局', () => {
  const mobileBlock = componentsCssContent.slice(componentsCssContent.indexOf('@media (max-width: 768px)', componentsCssContent.indexOf('.id-step-status-empty')));
  for (const rule of ['.interface-detail-modal-content', '.id-overview-grid', '.id-field', '.id-config-row', '.id-change-flow', '.id-change-item']) {
    assert.ok(mobileBlock.includes(rule), `窄屏适配缺少 ${rule}`);
  }
});

test('componentsCss 配置说明保留换行语义', () => {
  // 配置目录里的多行说明（账号/密码/中转服务）以换行分段，折叠成一行会降低可读性
  const start = componentsCssContent.indexOf('.id-config-description {');
  const block = componentsCssContent.slice(start, componentsCssContent.indexOf('}', start));
  assert.ok(block.includes('white-space: pre-line'), '配置说明应保留换行');
});

test('responsiveCss 不覆盖记录头布局，方法徽标保持胶囊形状', () => {
  // 记录头的窄屏布局由 componentsCss 的 grid 规则定义，responsiveCss 再改 flex 方向会互相覆盖
  assert.ok(!responsiveCssContent.includes('.record-header'), 'responsiveCss 不应重复定义 .record-header');
  // 徽标在窄屏保留最小宽度，宽度不足高度时 999px 圆角会退化为正圆
  const mobileBlock = componentsCssContent.slice(componentsCssContent.indexOf('@media (max-width: 768px)', componentsCssContent.indexOf('.record-item')));
  assert.ok(mobileBlock.includes('min-width: 44px'), '窄屏方法徽标应保留最小宽度');
});

test('traceStep 实际打点的状态值均有对应状态徽标样式', () => {
  const source = fs.readFileSync(new URL('../../apis/dandan-api.js', import.meta.url), 'utf8');
  const statuses = new Set([...source.matchAll(/traceStep\([^;]*?status:\s*'([^']+)'/gs)].map(m => m[1]));
  assert.ok(statuses.size > 0, '未从 dandan-api 源码中解析到状态值');
  for (const status of statuses) {
    assert.ok(componentsCssContent.includes('.id-step-status-' + status),
      `状态 ${status} 缺少样式 .id-step-status-${status}`);
  }
});

test('HTML_TEMPLATE 内联脚本包含接口详情的打开、关闭与渲染函数', () => {
  for (const fn of ['openInterfaceDetail', 'closeInterfaceDetail', 'renderInterfaceDetail',
    'renderInterfaceOverview', 'renderInterfaceConfigs', 'renderInterfaceSteps',
    'renderInterfaceDiagnosis', 'renderConfigChanges', 'renderDetailValue']) {
    assert.match(requestRecordsJsContent, new RegExp('function ' + fn + '\\('));
    assert.ok(HTML_TEMPLATE.includes('function ' + fn + '('), `页面未内联 ${fn}`);
  }
});

test('renderInterfaceDetailPage 空步骤与详情缺失时给出对应提示', async () => {
  const emptySteps = buildSampleTrace();
  emptySteps.steps = [];
  const emptyHtml = await renderInterfaceDetailPage(emptySteps, []);
  assert.ok(emptyHtml.includes('id-no-steps'));
  assert.ok(emptyHtml.includes('处理流水线'));

  const missingHtml = await renderInterfaceDetailPage(null, []);
  assert.ok(missingHtml.includes('interface-detail-error'));
  assert.ok(missingHtml.includes('未找到该请求的接口详情'));
});
