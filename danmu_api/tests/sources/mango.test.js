// 芒果源：综艺上/下分部排序
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import MangoSource from '../../sources/mango.js';

test('mango variety episodes with trailing part markers should sort 上 before 下 within each 期', () => {
  Globals.init({});
  const source = new MangoSource();

  // 平台原始顺序为最新在前（每期"下"先于"上"），分部标记在末尾括号中，含全/半角括号混用
  const trailingParen = source._processVarietyEpisodes([
    { t1: '第2期：绝叫山庄Ⅱ（下）', t2: '2026-07-29', ts: '4' },
    { t1: '第2期：绝叫山庄Ⅱ（上）', t2: '2026-07-29', ts: '3' },
    { t1: '第1期：绝叫山庄Ⅰ（下)', t2: '2026-07-22', ts: '2' },
    { t1: '第1期：绝叫山庄Ⅰ（上）', t2: '2026-07-22', ts: '1' },
  ]);
  assert.deepEqual(trailingParen.map(ep => ep.t1), [
    '第1期：绝叫山庄Ⅰ（上）',
    '第1期：绝叫山庄Ⅰ（下)',
    '第2期：绝叫山庄Ⅱ（上）',
    '第2期：绝叫山庄Ⅱ（下）',
  ]);

  // 紧跟格式"第N期上/下"的既有排序行为保持不变
  const direct = source._processVarietyEpisodes([
    { t1: '第3期下', t2: '2026-08-05', ts: '6' },
    { t1: '第3期上', t2: '2026-08-05', ts: '5' },
  ]);
  assert.deepEqual(direct.map(ep => ep.t1), ['第3期上', '第3期下']);
});
