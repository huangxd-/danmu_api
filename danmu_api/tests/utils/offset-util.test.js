// 偏移工具：@偏移 解析与应用
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { stripLinkOffset, applyOffset } from '../../utils/offset-util.js';

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
