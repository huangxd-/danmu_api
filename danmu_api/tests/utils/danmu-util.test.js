// 弹幕工具：文本转换与屏蔽词
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import { convertToDanmakuJson, splitBlockedWords, parseBlockedWord, groupDanmusByMinute } from '../../utils/danmu-util.js';
import { resetSearchState } from '../helpers/context.js';

test('danmu text conversion should run after normalization and before filtering and grouping', () => {
    const baseEnv = {
      BLOCKED_WORDS: '',
      GROUP_MINUTE: '0',
      DANMU_LIMIT: '0',
      CONVERT_COLOR: 'default'
    };

    Globals.init({ ...baseEnv, DANMU_SIMPLIFIED_TRADITIONAL: 'simplified' });
    const simplified = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看能不能發彈幕' },
      { p: '2,1,16777215,[test]', m: '繁體彈幕' }
    ], 'bilibili1');
    assert.deepEqual(simplified.map(item => item.m), ['来看能不能发弹幕', '繁体弹幕']);

    Globals.init({
      ...baseEnv,
      DANMU_SIMPLIFIED_TRADITIONAL: 'simplified',
      BLOCKED_WORDS: '/来看/'
    });
    const filtered = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看' }
    ], 'bilibili1');
    assert.equal(filtered.length, 0);

    Globals.init({
      ...baseEnv,
      DANMU_SIMPLIFIED_TRADITIONAL: 'simplified',
      GROUP_MINUTE: '1'
    });
    const grouped = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看' },
      { p: '2,1,16777215,[test]', m: '来看' }
    ], 'bilibili1');
    assert.equal(grouped.length, 1);
    assert.match(grouped[0].m, /^来看.*2$/);

    Globals.init({ ...baseEnv, DANMU_SIMPLIFIED_TRADITIONAL: 'traditional' });
    const traditional = convertToDanmakuJson([
      { p: '1,1,16777215,[test]', m: '来看能不能发弹幕' }
    ], 'test');
    assert.equal(traditional[0].m, '來看能不能發彈幕');

    resetSearchState();
  });
test('BLOCKED_WORDS 屏蔽词解析与过滤', async () => {
    const baseEnv = {
      GROUP_MINUTE: '0',
      DANMU_LIMIT: '0',
      CONVERT_COLOR: 'default'
    };
    const sample = [
      { timepoint: '1.00', ct: 1, color: 16777215, content: '前方剧透警告' },
      { timepoint: '2.00', ct: 1, color: 16777215, content: '测试弹幕一' },
      { timepoint: '3.00', ct: 1, color: 16777215, content: 'AD广告内容' },
      { timepoint: '4.00', ct: 1, color: 16777215, content: '正常弹幕' },
    ];

    const filterWith = async (blockedWords, expectGone, expectKeep = ['正常弹幕']) => {
      Globals.init({ ...baseEnv, BLOCKED_WORDS: blockedWords });
      const out = await convertToDanmakuJson(structuredClone(sample), 'test');
      const texts = out.map(d => d.m);
      for (const word of expectGone) {
        assert.ok(!texts.some(t => t.includes(word)), `「${word}」应被屏蔽，实际剩余: ${JSON.stringify(texts)}`);
      }
      for (const word of expectKeep) {
        assert.ok(texts.some(t => t.includes(word)), `「${word}」不应被误屏蔽，实际剩余: ${JSON.stringify(texts)}`);
      }
    };

    // 标准正则 / 纯文本词 / 全角逗号 / 正则带 i 标志 / 逗号带空格 / 混合写法
    await filterWith('/剧透/,/广告/', ['剧透', '广告']);
    await filterWith('剧透,广告', ['剧透', '广告']);
    await filterWith('/剧透/，/广告/', ['剧透', '广告']);
    await filterWith('/ad/i,/^测试/', ['AD广告', '测试']);
    await filterWith('/剧透/, /广告/', ['剧透', '广告']);
    await filterWith('/^测试/, 剧透 ，/广告/', ['剧透', '广告', '测试']);

    // README 官方示例兼容性：应解析出 16 个正则且不抛错
    const readmeSample = "/.{20,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\\u4e00-\\u9fa5])\\1{2,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{6,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{5,}$/,/^(\\d)\\1{2,}/,/^\\d{1,4}$/,/(20[0-3][0-9])/,/(0?[1-9]|1[0-2])月/,/\\d{1,2}[.-]\\d{1,2}/,/[@#&$%^*+\\|/\\-_=<>°◆◇■□●○★☆▼▲♥♦♠♣①②③④⑤⑥⑦⑧⑨⑩]/,/[一二三四五六七八九十百\\d]+刷/,/第[一二三四五六七八九十百\\d]+/,/(全体成员|报到|报道|来啦|签到|刷|打卡|我在|来了|考古|爱了|挖坟|留念|你好|回来|哦哦|重温|复习|重刷|再看|在看|前排|沙发|有人看|板凳|末排|我老婆|我老公|撅了|后排|周目|重看|包养|DVD|同上|同样|我也是|俺也|算我|爱豆|我家爱豆|我家哥哥|加我|三连|币|新人|入坑|补剧|冲了|硬了|看完|舔屏|万人|牛逼|煞笔|傻逼|卧槽|tm|啊这|哇哦)/";
    const segs = splitBlockedWords(readmeSample);
    assert.equal(segs.length, 16, `README 官方示例应解析出 16 条规则，实际 ${segs.length}`);
    const regexes = segs.map(parseBlockedWord);
    assert.ok(regexes.every(r => r instanceof RegExp), '所有词条均应解析为正则');

    resetSearchState();
  });

test('danmu groupDanmusByMinute 未分组单源时按时间升序返回', () => {
  // 输入按弹幕源返回顺序给出（非时间序），输出应按弹幕时间升序
  const input = [
    { p: '30.00,1,16777215,[dandan]', m: '第三条', cid: 3, t: 30 },
    { p: '10.00,1,16777215,[dandan]', m: '第一条', cid: 1, t: 10 },
    { p: '20.00,1,16777215,[dandan]', m: '第二条', cid: 2, t: 20 },
  ];
  const out = groupDanmusByMinute(input, 0, false);
  assert.deepStrictEqual(out.map(d => d.t), [10, 20, 30]);
  assert.strictEqual(out.length, input.length, '不开启分组时不增删弹幕');
});

test('danmu groupDanmusByMinute 缺少 t 字段时按 p 解析时间并排序', () => {
  const input = [
    { p: '5.00,1,16777215,[dandan]', m: '后一条', cid: 2 },
    { p: '1.25,1,16777215,[dandan]', m: '前一条', cid: 1 },
  ];
  const out = groupDanmusByMinute(input, 0, false);
  assert.deepStrictEqual(out.map(d => d.t), [1.25, 5]);
});

test('danmu groupDanmusByMinute 分组路径同样按时间升序返回', () => {
  const input = [
    { p: '130.00,1,16777215,[dandan]', m: '第三条', cid: 3, t: 130 },
    { p: '1.00,1,16777215,[dandan]', m: '第一条', cid: 1, t: 1 },
    { p: '61.00,1,16777215,[dandan]', m: '第二条', cid: 2, t: 61 },
  ];
  const out = groupDanmusByMinute(input, 1, false);
  assert.ok(out.every((d, i) => i === 0 || out[i - 1].t <= d.t), '分组路径应保持时间升序');
});
