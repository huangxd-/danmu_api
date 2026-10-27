// 偏移工具：规则解析与匹配、@偏移 解析、时长与弹幕偏移换算
// 由原单文件测试 worker.test.js 机械拆分而来；规则解析、匹配与换算用例覆盖剧名归一、季集层级、来源优先级与完整片名匹配。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { parseOffsetRules, resolveOffsetRule, offsetDuration, stripLinkOffset, applyOffset } from '../../utils/offset-util.js';

test('stripLinkOffset 解析 @偏移 后缀（@秒数 / @%百分比 / 无偏移 / 合并链接仅取末段）', async () => {
    assert.deepEqual(stripLinkOffset('https://x.com/v/1'), { cleanUrl: 'https://x.com/v/1', offset: 0, percent: false });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@3197'), { cleanUrl: 'https://x.com/v/1', offset: 3197, percent: false });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@%50'), { cleanUrl: 'https://x.com/v/1', offset: 50, percent: true });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@-50'), { cleanUrl: 'https://x.com/v/1', offset: -50, percent: false });
    // 合并链接仅从整条 URL 尾部取末段子链接的 @偏移
    const merged = 'https://x.com/v/A$$$https://x.com/v/B@3197';
    assert.deepEqual(stripLinkOffset(merged), { cleanUrl: 'https://x.com/v/A$$$https://x.com/v/B', offset: 3197, percent: false });
    // 容错：非字符串入参不抛错
    assert.deepEqual(stripLinkOffset(null), { cleanUrl: '', offset: 0, percent: false });
  });
test('applyOffset 应用 @偏移 的端点语义（绝对 = 时间+偏移，百分比端点 = 最大时间+偏移）', async () => {
    const danmus = [{ p: '10,1,16777215,b' }, { p: '20,1,16777215,b' }];
    // 绝对偏移：每条弹幕时间整体平移 offset 秒
    assert.deepEqual(applyOffset(danmus, 50).map(d => d.p), ['60.00,1,16777215,b', '70.00,1,16777215,b']);
    // 百分比偏移：按时间轴缩放，scaleRatio=(maxTime+offset)/maxTime，端点 maxTime → maxTime+offset
    assert.deepEqual(applyOffset(danmus, 50, { usePercent: true, videoDuration: 20 }).map(d => d.p), ['35.00,1,16777215,b', '70.00,1,16777215,b']);
    // 合并时长端点一致性：单链接时长 3266、偏移 3197 时，合并时间轴末端为 6463
    assert.equal(applyOffset([{ t: 3266 }], 3197, { usePercent: false, videoDuration: 3266 })[0].t, 6463);
  });
test('applyOffset 覆盖毫秒时间字段、负数钳制与百分比无时长回退', () => {
    assert.deepStrictEqual(applyOffset([], 10), []);
    const original = [{ p: '10,1,1,b' }];
    assert.deepStrictEqual(applyOffset(original, 0), original, '偏移为 0 时原样返回');
    assert.deepStrictEqual(applyOffset([{ progress: 10000 }], 5).map(d => d.progress), [15000], 'progress 按毫秒平移');
    assert.deepStrictEqual(applyOffset([{ timepoint: 10 }], 5).map(d => d.timepoint), [15], 'timepoint 按秒平移');
    assert.deepStrictEqual(applyOffset([{ p: '1,1,1,b' }], -5).map(d => d.p), ['0.00,1,1,b'], '负偏移钳制到 0');
    assert.deepStrictEqual(applyOffset([{ p: '10,1,1,b' }, { p: '20,1,1,b' }], 50, { usePercent: true, videoDuration: 0 }).map(d => d.p),
      ['35.00,1,1,b', '70.00,1,1,b'], '未取到时长时以末条弹幕时间缩放');
    assert.deepStrictEqual(applyOffset([{ t: 20 }], 50, { usePercent: true, videoDuration: 0 }).map(d => d.t),
      [70], '无 p 字段时以 t 推断时长');
    assert.deepStrictEqual(applyOffset([{ m: '无时间字段' }], 50, { usePercent: true, videoDuration: 0 }),
      [{ m: '无时间字段' }], '无时间字段且未传时长时不缩放');
  });
test('parseOffsetRules 解析剧名与季集路径（季节集补零）', () => {
    assert.deepStrictEqual(parseOffsetRules('overlord/S01:90, re-zero/S2:120, re-zero/S02/E3:10'), [
      { anime: 'overlord', season: 'S01', episode: null, sources: null, all: false, offset: 90, usePercent: false, raw: 'overlord/S01:90' },
      { anime: 're-zero', season: 'S02', episode: null, sources: null, all: false, offset: 120, usePercent: false, raw: 're-zero/S2:120' },
      { anime: 're-zero', season: 'S02', episode: 'E03', sources: null, all: false, offset: 10, usePercent: false, raw: 're-zero/S02/E3:10' },
    ]);
    assert.deepStrictEqual(parseOffsetRules('剧名:10')[0],
      { anime: '剧名', season: null, episode: null, sources: null, all: false, offset: 10, usePercent: false, raw: '剧名:10' });
  });
test('parseOffsetRules 解析来源限定、通配与百分比标记', () => {
    assert.deepStrictEqual(parseOffsetRules('剧名@BILIBILI&dandan:10')[0],
      { anime: '剧名', season: null, episode: null, sources: ['bilibili', 'dandan'], all: false, offset: 10, usePercent: false, raw: '剧名@BILIBILI&dandan:10' });
    assert.strictEqual(parseOffsetRules('剧名@ALL:20')[0].all, true);
    assert.strictEqual(parseOffsetRules('剧名@*:20')[0].all, true);
    assert.deepStrictEqual(parseOffsetRules('东方/S03/E02@tencent%:11')[0],
      { anime: '东方', season: 'S03', episode: 'E02', sources: ['tencent'], all: false, offset: 11, usePercent: true, raw: '东方/S03/E02@tencent%:11' });
    assert.strictEqual(parseOffsetRules('东方/S03/E02%:11')[0].usePercent, true, '路径末尾的 % 同样启用百分比');
    assert.deepStrictEqual(parseOffsetRules('剧名@tencent%:11')[0].sources, ['tencent']);
  });
test('parseOffsetRules 支持含 / 的剧名与负数偏移', () => {
    assert.deepStrictEqual(parseOffsetRules('Fate/stay night:10')[0],
      { anime: 'Fate/stay night', season: null, episode: null, sources: null, all: false, offset: 10, usePercent: false, raw: 'Fate/stay night:10' });
    assert.deepStrictEqual(parseOffsetRules('Fate/stay night/S01/E03:10')[0],
      { anime: 'Fate/stay night', season: 'S01', episode: 'E03', sources: null, all: false, offset: 10, usePercent: false, raw: 'Fate/stay night/S01/E03:10' });
    assert.strictEqual(parseOffsetRules('剧名:-30')[0].offset, -30);
  });
test('parseOffsetRules 过滤缺少剧名、偏移或非法数值的条目', () => {
    assert.deepStrictEqual(parseOffsetRules(''), []);
    assert.deepStrictEqual(parseOffsetRules(null), []);
    assert.deepStrictEqual(parseOffsetRules('无冒号, :10, 剧名:, 剧名:abc, 剧名@:10'), []);
    assert.strictEqual(parseOffsetRules('剧名:10, ,剧名2:20').length, 2, '空条目被忽略');
  });
test('resolveOffsetRule 按集级 > 季级 > 剧级顺序回退', () => {
    const rules = parseOffsetRules('剧/S01/E01:1, 剧/S01:2, 剧:3');
    const ctx = { anime: '剧', fullTitle: '剧', season: 'S01', episode: 'E01', source: 'bilibili' };
    assert.strictEqual(resolveOffsetRule(rules, ctx).offset, 1);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, episode: 'E02' }).offset, 2);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, season: 'S02', episode: 'E01' }).offset, 3);
  });
test('resolveOffsetRule 同层级按特定来源 > 通配 > 通用取规则', () => {
    const rules = parseOffsetRules('剧:10, 剧@all:20, 剧@bilibili:30');
    const ctx = { anime: '剧', fullTitle: '剧', season: 'S01', episode: 'E01', source: 'bilibili' };
    assert.strictEqual(resolveOffsetRule(rules, ctx).offset, 30);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: 'dandan' }).offset, 20, '无特定来源时回落通配');
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: '' }).offset, 20, '来源为空时通配仍生效');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('剧:10'), { ...ctx, source: '' }).offset, 10, '无通配时使用通用规则');
  });
test('resolveOffsetRule 展开来源别名', () => {
    const rules = parseOffsetRules('剧@qq:10, 剧@qiyi:20, 剧@bilibili1:30');
    const ctx = { anime: '剧', fullTitle: '剧', season: 'S01', episode: 'E01' };
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: 'tencent' }).offset, 10);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: 'iqiyi' }).offset, 20);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: 'bilibili' }).offset, 30);
    assert.strictEqual(resolveOffsetRule(rules, { ...ctx, source: 'dandan&bilibili' }).offset, 30, '合并来源逐段展开');
  });
test('resolveOffsetRule 按完整片名匹配数字结尾的剧名', () => {
    const movieCtx = { anime: '钢铁侠', fullTitle: '钢铁侠2', season: 'S02', episode: 'E01', source: 'bilibili' };
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('钢铁侠2:270'), movieCtx).offset, 270, '电影完整片名命中');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('钢铁侠:270'), movieCtx).offset, 270, '基础名命中保持兼容');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('钢铁侠2/S02:270'), movieCtx).offset, 270, '完整片名可叠加季级约束');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('钢铁侠2:270'), { ...movieCtx, fullTitle: '钢铁侠' }), null, '完整片名不匹配时不得误命中');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('钢铁侠:270'), { ...movieCtx, fullTitle: undefined }).offset, 270, '未提供完整片名时按基础名匹配');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('某某2/S02:10'),
      { anime: '某某', fullTitle: '某某2', season: 'S02', episode: 'E01', source: 'bilibili' }).offset, 10, '数字结尾的季名同样可匹配');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('某某 第二季:10'),
      { anime: '某某', fullTitle: '某某第二季', season: 'S02', episode: 'E01', source: 'bilibili' }).offset, 10, '显式季名可匹配');
  });
test('resolveOffsetRule 剧名比较忽略繁简与符号差异', () => {
    const ctx = { anime: '無職轉生', fullTitle: '無職轉生', season: 'S03', episode: 'E01', source: 'bilibili' };
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('无职转生/S03:10'), ctx).offset, 10);
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('无职转生/S03:10'), { ...ctx, anime: '葬送的芙莉莲', fullTitle: '葬送的芙莉莲' }), null);
  });
test('resolveOffsetRule 无规则或缺少剧名时返回 null', () => {
    const ctx = { anime: '剧', fullTitle: '剧', season: 'S01', episode: 'E01', source: 'bilibili' };
    assert.strictEqual(resolveOffsetRule([], ctx), null);
    assert.strictEqual(resolveOffsetRule(null, ctx), null);
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('剧:10'), { ...ctx, anime: '' }), null);
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('剧/S01:10'), { ...ctx, season: 'S02' }), null, '季不匹配不命中');
    assert.strictEqual(resolveOffsetRule(parseOffsetRules('剧/S01/E02:10'), { ...ctx, season: 'S01' }), null, '集不匹配且无上级规则时不命中');
  });
test('offsetDuration 按偏移端点换算时长', () => {
    assert.strictEqual(offsetDuration(1000, 100), 1100, '绝对偏移直接叠加');
    assert.strictEqual(offsetDuration(1000, 100, true), 1100, '百分比偏移在时长端点同样落到 duration + offset');
    assert.strictEqual(offsetDuration(1000, -100, true), 900, '负向百分比偏移按时长端点缩减');
    assert.strictEqual(offsetDuration(1000, 0), 1000, '无偏移返回原时长');
    assert.strictEqual(offsetDuration(0, 100), 0, '时长未知时保持原值');
    assert.strictEqual(offsetDuration(100, -200), 0, '负向偏移钳制到 0');
  });
