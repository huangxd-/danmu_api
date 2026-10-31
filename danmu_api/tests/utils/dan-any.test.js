// 弹幕格式转换工具：dan-any 适配层支持的格式清单与各目标格式的导出结构

import test from 'node:test';
import assert from 'node:assert';
import { convertDanAny, danAnyFormats } from '../../utils/dan-any.js';

// 固定输入：ddplay 结构的 3 条弹幕（显式给出 cid，避免依赖库内部生成的 ID）。
// 模式 1=普通、4=底部、5=顶部，用于验证各目标格式的模式映射。
const ddplayData = {
    comments: [
        { cid: 101, p: '1.5,1,16777215,uid-a', m: '普通弹幕' },
        { cid: 102, p: '12.25,4,255,uid-b', m: '底部弹幕' },
        { cid: 103, p: '90.5,5,16711680,uid-c', m: '顶部弹幕' }
    ]
};

test('danAnyFormats 暴露 8 个目标格式且顺序固定', () => {
    assert.deepEqual(danAnyFormats, [
        'artplayer.json',
        'baha.json',
        'bili.xml',
        'danuni.json',
        'danuni.binpb',
        'ddplay.json',
        'dplayer.json',
        'vod.json'
    ]);
});

test('convertDanAny 对每种支持格式返回对应的 type 与 data 载体', () => {
    const expectedTypes = {
        'artplayer.json': 'json',
        'baha.json': 'json',
        'bili.xml': 'xml',
        'danuni.json': 'json',
        'danuni.binpb': 'binary',
        'ddplay.json': 'json',
        'dplayer.json': 'json',
        'vod.json': 'json'
    };
    for (const format of danAnyFormats) {
        const result = convertDanAny(ddplayData, format);
        assert.notEqual(result, null, `${format} 不应返回 null`);
        assert.equal(result.type, expectedTypes[format], format);
        assert.notEqual(result.data, null, format);
        assert.equal(result.data === undefined, false, format);
    }
    assert.equal(convertDanAny(ddplayData, 'danuni.binpb').filename, 'danuni.binpb');
});

test('convertDanAny 遇到未知或大小写不匹配的 format 返回 null', () => {
    assert.equal(convertDanAny(ddplayData, 'not-a-format'), null);
    assert.equal(convertDanAny(ddplayData, ''), null);
    assert.equal(convertDanAny(ddplayData, undefined), null);
    assert.equal(convertDanAny(ddplayData, null), null);
    assert.equal(convertDanAny(ddplayData, 'JSON'), null);
    assert.equal(convertDanAny(ddplayData, 'DDPLAY.JSON'), null);
});

test('convertDanAny 可重复调用：共享 chunk 数据库不残留上一次的弹幕', () => {
    const first = convertDanAny(ddplayData, 'ddplay.json').data;
    const second = convertDanAny(ddplayData, 'ddplay.json').data;
    assert.deepEqual(second, first);
    assert.equal(second.count, 3);
});

test('ddplay.json 输出：count 与 comments 逐条回写，空输入得到空数组', () => {
    const { data } = convertDanAny(ddplayData, 'ddplay.json');
    assert.equal(data.count, 3);
    assert.deepEqual(data.comments, [
        { cid: 101, p: '1.5,1,16777215,uid-a', m: '普通弹幕' },
        { cid: 102, p: '12.25,4,255,uid-b', m: '底部弹幕' },
        { cid: 103, p: '90.5,5,16711680,uid-c', m: '顶部弹幕' }
    ]);
    // 无弹幕时没有来源标识，danuni.data 为 undefined
    const empty = convertDanAny({ comments: [] }, 'ddplay.json').data;
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.comments, []);
    assert.equal(empty.danuni.data, undefined);
});

test('artplayer.json 输出：普通/底部/顶部映射为 0/2/1，颜色转 #RRGGBB 大写', () => {
    const { data } = convertDanAny(ddplayData, 'artplayer.json');
    assert.deepEqual(data.danmuku, [
        { text: '普通弹幕', time: 1.5, mode: 0, color: '#FFFFFF', border: undefined, style: undefined },
        { text: '底部弹幕', time: 12.25, mode: 2, color: '#FF', border: undefined, style: undefined },
        { text: '顶部弹幕', time: 90.5, mode: 1, color: '#FF0000', border: undefined, style: undefined }
    ]);
});

test('dplayer.json 输出：[秒, 模式, 颜色, 发送者, 内容] 行结构与 code=0', () => {
    const { data } = convertDanAny(ddplayData, 'dplayer.json');
    assert.equal(data.code, 0);
    assert.deepEqual(data.data, [
        [1.5, 0, 16777215, 'uid-a@ddplay', '普通弹幕'],
        [12.25, 2, 255, 'uid-b@ddplay', '底部弹幕'],
        [90.5, 1, 16711680, 'uid-c@ddplay', '顶部弹幕']
    ]);
});

test('vod.json 输出：danum/name 与 [秒, 位置, 颜色, 空, 内容, 空, 空, 字号] 行结构', () => {
    const { data } = convertDanAny(ddplayData, 'vod.json');
    assert.equal(data.code, 0);
    assert.equal(data.name, 'def_ddplay+0@ddplay');
    assert.equal(data.danum, 3);
    assert.deepEqual(data.danmuku, [
        [1.5, 'right', '#FFFFFF', '', '普通弹幕', '', '', '25px'],
        [12.25, 'bottom', '#FF', '', '底部弹幕', '', '', '25px'],
        [90.5, 'top', '#FF0000', '', '顶部弹幕', '', '', '25px']
    ]);
});

test('baha.json 输出：time 取整秒、size 分档为 1、position 0/2/1 与 totalCount', () => {
    const { data } = convertDanAny(ddplayData, 'baha.json');
    assert.equal(data.data.totalCount, 3);
    assert.deepEqual(data.data.danmu, [
        { sn: 0, text: '普通弹幕', time: 15, color: '#FFFFFF', size: 1, position: 0, userid: '' },
        { sn: 0, text: '底部弹幕', time: 122, color: '#FF', size: 1, position: 2, userid: '' },
        { sn: 0, text: '顶部弹幕', time: 905, color: '#FF0000', size: 1, position: 1, userid: '' }
    ]);
});

test('danuni.json 输出：秒转毫秒、模式 0/1/2 与发送者/来源字段', () => {
    const before = Date.now();
    const { data } = convertDanAny(ddplayData, 'danuni.json');
    const after = Date.now();
    const expected = [
        { color: 16777215, progress: 1500, mode: 0, senderID: 'uid-a@ddplay', content: '普通弹幕', cid: 101, uid: 'uid-a' },
        { color: 255, progress: 12250, mode: 1, senderID: 'uid-b@ddplay', content: '底部弹幕', cid: 102, uid: 'uid-b' },
        { color: 16711680, progress: 90500, mode: 2, senderID: 'uid-c@ddplay', content: '顶部弹幕', cid: 103, uid: 'uid-c' }
    ];
    assert.equal(data.length, 3);
    data.forEach((entry, index) => {
        const item = expected[index];
        assert.equal(entry.SOID, 'def_ddplay+0@ddplay');
        assert.equal(entry.color, item.color);
        assert.equal(entry.progress, item.progress);
        assert.equal(entry.mode, item.mode);
        assert.equal(entry.senderID, item.senderID);
        assert.equal(entry.content, item.content);
        assert.equal(entry.platform, 'ddplay');
        assert.deepEqual(entry.extra, { ddplay: { cid: item.cid, uid: item.uid } });
        assert.deepEqual(entry.attr, []);
        assert.equal(entry.fontsize, 25);
        assert.equal(entry.weight, 0);
        assert.equal(entry.pool, 0);
        assert.match(entry.DMID, /^[0-9a-f]+$/);
        // ctime 由库在转换时生成，只能断言落在本次调用的时间窗口内
        const ctimeMs = entry.ctime instanceof Date ? entry.ctime.getTime() : Date.parse(entry.ctime);
        assert.ok(ctimeMs >= before && ctimeMs <= after, `ctime 应落在转换时间窗口内: ${String(entry.ctime)}`);
    });
});

test('bili.xml 输出：XML 头、chatid/maxlimit 与逐条 <d p> 属性（时间戳/DMID 用通配匹配）', () => {
    const { type, data } = convertDanAny(ddplayData, 'bili.xml');
    assert.equal(type, 'xml');
    assert.ok(data.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(data.includes('<chatserver>chat.bilibili.com</chatserver>'));
    assert.ok(data.includes('<chatid>def_ddplay+0@ddplay</chatid>'));
    assert.ok(data.includes('<maxlimit>3</maxlimit>'));
    assert.match(data, /<d p="1\.5,1,25,16777215,\d+\.\d+,Def,uid-a@ddplay,[0-9a-f]+,0">普通弹幕<\/d>/);
    assert.match(data, /<d p="12\.25,4,25,255,\d+\.\d+,Def,uid-b@ddplay,[0-9a-f]+,0">底部弹幕<\/d>/);
    assert.match(data, /<d p="90\.5,5,25,16711680,\d+\.\d+,Def,uid-c@ddplay,[0-9a-f]+,0">顶部弹幕<\/d>/);
});

test('danuni.binpb 输出：类型 binary、文件名固定且字节流内含弹幕内容', () => {
    const result = convertDanAny(ddplayData, 'danuni.binpb');
    assert.equal(result.type, 'binary');
    assert.equal(result.filename, 'danuni.binpb');
    assert.ok(result.data instanceof Uint8Array);
    const bytes = Buffer.from(result.data);
    assert.ok(bytes.length > 0);
    for (const text of ['普通弹幕', '底部弹幕', '顶部弹幕']) {
        assert.ok(bytes.includes(Buffer.from(text, 'utf8')), `二进制载荷应包含 ${text}`);
    }
});
