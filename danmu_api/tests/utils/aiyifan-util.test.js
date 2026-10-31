// 爱壹帆工具（纯函数部分）：App 接口签名与网页年份解析
// App 签名链路（AiyifanAppSigningProvider 等）已有 sources/aiyifan.test.js 覆盖，这里只测可离线定值验证的纯函数。

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { computeAiyifanAppSign, parseAiyifanYear } from '../../utils/aiyifan-util.js';

const nodeMd5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');

test('aiyifan computeAiyifanAppSign = md5(query + timestamp + privateKey)', () => {
  const cases = [
    ['', 0, ''],
    ['keyword=%E7%B9%81%E8%8A%B1', 1700000000, 'private-key-1'],
    ['type=1&page=2', '1700000001', 'p#w'],
    ['中文参数=测试', 1700000002, '密钥'],
  ];
  for (const [query, timestamp, privateKey] of cases) {
    assert.strictEqual(computeAiyifanAppSign(query, timestamp, privateKey),
      nodeMd5(query + timestamp + privateKey), `签名拼接规则：${query} | ${timestamp}`);
  }

  const base = computeAiyifanAppSign('q', 1, 'k');
  assert.strictEqual(computeAiyifanAppSign('q', 1, 'k'), base, '同入参稳定');
  assert.notStrictEqual(computeAiyifanAppSign('q2', 1, 'k'), base, 'query 参与签名');
  assert.notStrictEqual(computeAiyifanAppSign('q', 2, 'k'), base, 'timestamp 参与签名');
  assert.notStrictEqual(computeAiyifanAppSign('q', 1, 'k2'), base, 'privateKey 参与签名');
  assert.match(base, /^[0-9a-f]{32}$/, '输出为 32 位小写十六进制');
});

test('aiyifan parseAiyifanYear 只接受 YYYY- 开头的合理年份', () => {
  assert.strictEqual(parseAiyifanYear('2024-01-02 10:00:00'), 2024);
  assert.strictEqual(parseAiyifanYear('1999-12-31'), 1999);
  assert.strictEqual(parseAiyifanYear('1900-01-01'), 1900, '下界包含');
  assert.strictEqual(parseAiyifanYear('2100-12-31'), 2100, '上界包含');

  assert.strictEqual(parseAiyifanYear('1899-12-31'), null, '低于 1900 视为无效');
  assert.strictEqual(parseAiyifanYear('2101-01-01'), null, '高于 2100 视为无效');
  assert.strictEqual(parseAiyifanYear('2024'), null, '无 “-” 分隔不算年份');
  assert.strictEqual(parseAiyifanYear('2024/01/02'), null);
  assert.strictEqual(parseAiyifanYear('  2024-01-02'), null, '前导空格不匹配');
  assert.strictEqual(parseAiyifanYear(''), null);
  assert.strictEqual(parseAiyifanYear(null), null);
  assert.strictEqual(parseAiyifanYear(undefined), null);
  assert.strictEqual(parseAiyifanYear(2024), null, '非字符串入参返回 null');
});
