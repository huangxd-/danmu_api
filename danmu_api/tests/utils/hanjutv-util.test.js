// 韩剧TV（韩小圈/极速版）工具：UID、请求头签名、加密响应解密与剧集 ID 编解码
// 全部离线：随机 uid 注入或按实例断言，不发起任何请求。

import test from 'node:test';
import assert from 'node:assert';
import {
  createHanjutvUid, buildHanjutvSearchHeaders, buildLiteHeaders, decodeHanjutvEncryptedPayload,
  encodeMergedHanjutvEpisodeDanmuId, parseHanjutvEpisodeDanmuId, getHanjutvSourceLabel,
} from '../../utils/hanjutv-util.js';

test('hanjutv createHanjutvUid 按长度生成字母数字 uid', () => {
  assert.match(createHanjutvUid(), /^[0-9A-Za-z]{20}$/, '默认长度 20');
  assert.match(createHanjutvUid(8), /^[0-9A-Za-z]{8}$/, '长度可指定');
  assert.strictEqual(createHanjutvUid(0), '', '长度为 0 时返回空串');
  assert.notStrictEqual(createHanjutvUid(20), createHanjutvUid(20), '两次生成不应相同');
});

test('hanjutv buildHanjutvSearchHeaders 同入参稳定，reqTs 只影响 sign', async () => {
  const make = await buildHanjutvSearchHeaders(1700000000, 'FIXEDUID0123456789ab');
  const first = await make(1700000001);
  const again = await make(1700000001);
  const later = await make(1700000002);

  assert.strictEqual(first.uid, 'FIXEDUID0123456789ab', 'uid 使用注入值');
  assert.deepStrictEqual(again, first, '同 uid 同 reqTs 必须完全一致');
  assert.strictEqual(first.headers.app, 'hj');
  assert.strictEqual(first.headers['Accept-Encoding'], 'gzip');
  assert.ok(first.headers.said, 'said 必须存在');
  assert.ok(first.headers.uk, 'uk 必须存在');
  assert.ok(first.headers.sign, 'sign 必须存在');
  assert.strictEqual(later.headers.uk, first.headers.uk, 'uk 只与 uid/会话有关，不随 reqTs 变化');
  assert.notStrictEqual(later.headers.sign, first.headers.sign, 'sign 随 reqTs 变化');

  const otherUid = await buildHanjutvSearchHeaders(1700000000, 'OTHERUID0123456789a');
  assert.notStrictEqual((await otherUid(1700000001)).headers.uk, first.headers.uk, 'uid 变化后 uk 变化');
});

test('hanjutv buildLiteHeaders 返回 20 位 uid 与固定客户端标识', async () => {
  const make = await buildLiteHeaders(1700000000);
  const first = await make(1700000001);
  const again = await make(1700000001);

  assert.match(first.uid, /^[0-9A-Za-z]{20}$/, 'lite 版 uid 为 20 位字母数字');
  assert.deepStrictEqual(again, first, '同一实例内同 reqTs 必须一致');
  assert.strictEqual(first.headers.version, 'a_22570');
  assert.strictEqual(first.headers['version-name'], '1.7.2');
  assert.strictEqual(first.headers.channel, 'xiaomi');
  assert.strictEqual(first.headers.uid, '', 'lite 头里的 uid 字段固定为空');
  assert.ok(first.headers.di, 'di 必须存在');
  assert.ok(first.headers.rp, 'rp 必须存在');

  const other = await buildLiteHeaders(1700000000);
  assert.notStrictEqual((await other(1700000001)).uid, first.uid, '不同实例应生成不同 uid');
});

test('hanjutv decodeHanjutvEncryptedPayload 非加密响应原样返回', async () => {
  assert.strictEqual(await decodeHanjutvEncryptedPayload(null), null);
  assert.strictEqual(await decodeHanjutvEncryptedPayload('plain'), 'plain');
  const arrayPayload = [1, 2, 3];
  assert.strictEqual(await decodeHanjutvEncryptedPayload(arrayPayload), arrayPayload, '数组原样返回');

  const plainObject = { code: 200, data: 42 };
  assert.strictEqual(await decodeHanjutvEncryptedPayload(plainObject), plainObject, 'data 非字符串视为明文');
  const emptyData = { code: 200, data: '' };
  assert.strictEqual(await decodeHanjutvEncryptedPayload(emptyData), emptyData, 'data 为空串视为明文');
});

test('hanjutv decodeHanjutvEncryptedPayload 缺少解密 key 时抛错', async () => {
  await assert.rejects(() => decodeHanjutvEncryptedPayload({ data: 'Y2lwaGVy' }), /缺少解密 key/,
    '既无 key 又无 uid/ts 时必须报错');
  await assert.rejects(() => decodeHanjutvEncryptedPayload({ data: 'Y2lwaGVy', ts: '' }, 'uid-1'), /缺少解密 key/,
    'ts 为空时无法推导 key');
});

test('hanjutv 剧集 ID 编解码：hxq/tv/merge 三种形态与标签', () => {
  assert.deepStrictEqual(parseHanjutvEpisodeDanmuId(''), { id: '', preferTv: false, rawId: '', refs: [] });
  assert.deepStrictEqual(parseHanjutvEpisodeDanmuId('hxq:123'),
    { id: '123', preferTv: false, rawId: 'hxq:123', refs: [{ id: '123', preferTv: false, rawId: 'hxq:123' }] });
  assert.deepStrictEqual(parseHanjutvEpisodeDanmuId('tv:456'),
    { id: '456', preferTv: true, rawId: 'tv:456', refs: [{ id: '456', preferTv: true, rawId: 'tv:456' }] });
  assert.deepStrictEqual(parseHanjutvEpisodeDanmuId('hanjutv:tv:789'),
    { id: '789', preferTv: true, rawId: 'tv:789', refs: [{ id: '789', preferTv: true, rawId: 'tv:789' }] },
    'hanjutv: 前缀先被剥离');
  assert.deepStrictEqual(parseHanjutvEpisodeDanmuId('  123  '),
    { id: '123', preferTv: false, rawId: 'hxq:123', refs: [{ id: '123', preferTv: false, rawId: 'hxq:123' }] },
    '裸 id 按韩小圈处理并 trim');

  const merged = parseHanjutvEpisodeDanmuId(encodeMergedHanjutvEpisodeDanmuId('hxq-1', 'tv-1'));
  assert.strictEqual(merged.id, 'hxq-1', '合并 ID 默认取韩小圈引用');
  assert.strictEqual(merged.preferTv, false);
  assert.deepStrictEqual(merged.refs.map((ref) => [ref.id, ref.preferTv]),
    [['hxq-1', false], ['tv-1', true]], '合并 ID 展开为两个引用，tv 引用带 preferTv');

  assert.strictEqual(encodeMergedHanjutvEpisodeDanmuId('', 'tv-1'), '', '缺任一 id 不生成合并 ID');
  assert.strictEqual(encodeMergedHanjutvEpisodeDanmuId('hxq-1', '   '), '');
  assert.match(encodeMergedHanjutvEpisodeDanmuId('hxq-1', 'tv-1'), /^merge:[A-Za-z0-9_-]+$/);

  const malformed = parseHanjutvEpisodeDanmuId('merge:@@@not-base64@@@');
  assert.strictEqual(malformed.rawId, 'hxq:merge:@@@not-base64@@@', '损坏的合并 ID 退化为韩小圈引用');

  assert.strictEqual(getHanjutvSourceLabel('hxq:1'), '韩小圈');
  assert.strictEqual(getHanjutvSourceLabel('tv:1'), '极速版');
  assert.strictEqual(getHanjutvSourceLabel('hanjutv:tv:1'), '极速版');
  assert.strictEqual(getHanjutvSourceLabel(encodeMergedHanjutvEpisodeDanmuId('a', 'b')), '韩小圈＆极速版');
  assert.strictEqual(getHanjutvSourceLabel(''), '韩小圈', '空 id 默认按韩小圈');
});
