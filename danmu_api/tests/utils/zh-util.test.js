// 简繁转换工具：opencc 驱动的简繁互转与“是否不含中文”区间判定

import test from 'node:test';
import assert from 'node:assert';
import { traditionalized, simplized, isNonChinese } from '../../utils/zh-util.js';

test('traditionalized 简体转繁体：逐字转换、tw 词语级替换与幂等性', () => {
    assert.equal(traditionalized('来看能不能发弹幕'), '來看能不能發彈幕');
    assert.equal(traditionalized('繁体字'), '繁體字');
    assert.equal(traditionalized('面条'), '面條');
    assert.equal(traditionalized('软件'), '軟件');
    // tw 词典会做词语级替换：单字“里”在繁体中文语境下写作“裡”
    assert.equal(traditionalized('里'), '裡');
    // 已是繁体时结果不变，重复转换保持幂等
    const once = traditionalized('來看能不能發彈幕');
    assert.equal(once, '來看能不能發彈幕');
    assert.equal(traditionalized(once), once);
    // 不含汉字的内容原样返回
    assert.equal(traditionalized('abc123'), 'abc123');
    assert.equal(traditionalized(''), '');
});

test('simplized 繁体转简体：逐字转换、词语级替换与简繁往返一致', () => {
    assert.equal(simplized('來看能不能發彈幕'), '来看能不能发弹幕');
    assert.equal(simplized('繁體字'), '繁体字');
    assert.equal(simplized('記憶體'), '记忆体');
    assert.equal(simplized('日本語'), '日本语');
    assert.equal(simplized('abc123'), 'abc123');
    assert.equal(simplized(''), '');
    // 先转繁体再转简体可回到原文
    assert.equal(simplized(traditionalized('来看能不能发弹幕')), '来看能不能发弹幕');
});

test('isNonChinese 按 U+4E00–U+9FFF 判定，覆盖区间边界与混合文本', () => {
    // 区间两端算汉字，紧邻的两个码位不算
    assert.equal(isNonChinese('\u4e00'), false);
    assert.equal(isNonChinese('\u9fff'), false);
    assert.equal(isNonChinese('\u4dff'), true);
    assert.equal(isNonChinese('\ua000'), true);
    // 混合文本只要含一个汉字即为“含中文”
    assert.equal(isNonChinese('中'), false);
    assert.equal(isNonChinese('abc中def'), false);
    // 纯非中文内容
    assert.equal(isNonChinese('abc123'), true);
    assert.equal(isNonChinese('한국어'), true);
    assert.equal(isNonChinese('　'), true); // 全角空格
    assert.equal(isNonChinese(''), true);
});

test('isNonChinese 非字符串入参先经 String 强制转换再判定', () => {
    assert.equal(isNonChinese(123), true); // '123'
    assert.equal(isNonChinese(['中']), false); // '中'
    assert.equal(isNonChinese([]), true); // ''
    assert.equal(isNonChinese({}), true); // '[object Object]'
});

test('非字符串入参的转换行为：数字/布尔得到空串，null/undefined 抛 TypeError', () => {
    assert.equal(traditionalized(123), '');
    assert.equal(simplized(123), '');
    assert.equal(traditionalized(true), '');
    assert.equal(simplized(false), '');
    assert.throws(() => traditionalized(null), TypeError);
    assert.throws(() => simplized(null), TypeError);
    assert.throws(() => traditionalized(undefined), TypeError);
    assert.throws(() => simplized(undefined), TypeError);
});
