// 时间工具：年份转 ISO 起始日期（含回退当前年）与 “时:分:秒” 文本转秒

import test from 'node:test';
import assert from 'node:assert';
import { generateValidStartDate, time_to_second } from '../../utils/time-util.js';

test('generateValidStartDate 合法年份生成当年 1 月 1 日 UTC 起始时间', () => {
    assert.equal(generateValidStartDate(2020), '2020-01-01T00:00:00Z');
    assert.equal(generateValidStartDate(1900), '1900-01-01T00:00:00Z');
    assert.equal(generateValidStartDate(2100), '2100-01-01T00:00:00Z');
    assert.equal(generateValidStartDate('2024'), '2024-01-01T00:00:00Z');
});

test('generateValidStartDate 越界或非法年份回退到当前年份（断言按运行时当前年推导）', () => {
    const currentYear = new Date().getFullYear();
    const fallback = `${currentYear}-01-01T00:00:00Z`;
    for (const bad of [1899, 2101, 0, -5, 'abc', '', null, undefined, NaN]) {
        assert.equal(generateValidStartDate(bad), fallback, `year=${String(bad)} 应回退到当前年`);
    }
});

test('generateValidStartDate 非严格数字入参按 parseInt 截断解析', () => {
    assert.equal(generateValidStartDate('2020abc'), '2020-01-01T00:00:00Z');
    assert.equal(generateValidStartDate('2020.9'), '2020-01-01T00:00:00Z');
    assert.equal(generateValidStartDate(2020.9), '2020-01-01T00:00:00Z');
    assert.equal(generateValidStartDate('2020-05-06'), '2020-01-01T00:00:00Z');
});

test('time_to_second 三段/两段/单段分别按 时分秒 / 分秒 / 秒 解析', () => {
    assert.equal(time_to_second('01:02:03'), 3723);
    assert.equal(time_to_second('1:2:3'), 3723);
    assert.equal(time_to_second('00:00:00'), 0);
    assert.equal(time_to_second('10:30'), 630);
    assert.equal(time_to_second('0:00'), 0);
    assert.equal(time_to_second('90'), 90);
    assert.equal(time_to_second('0'), 0);
});

test('time_to_second 边界与非法输入的具体行为', () => {
    // 空串走单段分支，Number('') 为 0
    assert.equal(time_to_second(''), 0);
    // 超过三段时不报错，走 else 分支只取第一段（当前实现行为）
    assert.equal(time_to_second('1:2:3:4'), 1);
    // 负值直接参与运算
    assert.equal(time_to_second('-1:30'), -30);
    // 段落空白由 Number 忽略
    assert.equal(time_to_second(' 1:2 '), 62);
    // 非法数字段落产出 NaN 而不是抛错
    assert.ok(Number.isNaN(time_to_second('abc')));
    assert.ok(Number.isNaN(time_to_second('1:abc')));
    // 非字符串入参直接抛 TypeError
    assert.throws(() => time_to_second(123), { name: 'TypeError', message: 'time.split is not a function' });
    assert.throws(() => time_to_second(null), TypeError);
});
