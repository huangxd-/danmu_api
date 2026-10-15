// 通用编解码工具：哈希、AES、Base64/Hex、Brotli、签名拼接与弹幕 proto 解析
// 全部为纯函数，离线验证；哈希/AES/Brotli 用 node:crypto 与 node:zlib 作为权威对照。

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  simpleHash, serializeValue, md5, hexToBytes, bytesToHex, pkcs7Pad, sm3Bytes, parseDanmakuBase64,
  convertToAsciiSum, aesCbcEncrypt, aesEcbDecrypt, base64ToBytes, decompressBrotli, utf8BytesToString,
  stringToUtf8Bytes, aesDecryptBase64, autoDecode, bytesToBase64, sha256, createHmacSha256,
  generateRandomSid, generateSign, generateXCaSign, decodeHtmlEntities,
} from '../../utils/codec-util.js';

const nodeMd5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');
const nodeSha256Bytes = (s) => Array.from(crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest());
const nodeHmacB64 = (key, msg) => crypto.createHmac('sha256', Buffer.from(key, 'utf8'))
  .update(Buffer.from(msg, 'utf8')).digest('base64');
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

test('codec md5 与 node:crypto 一致（ASCII / 中文 / emoji / 跨块长串）', () => {
  for (const input of ['', 'abc', '中文弹幕测试', 'emoji😀混排', 'x'.repeat(200)]) {
    assert.strictEqual(md5(input), nodeMd5(input), `md5("${input.slice(0, 12)}") 应与 node:crypto 一致`);
  }
  assert.strictEqual(md5('abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5 输出为小写十六进制');
});

test('codec sha256 与 node:crypto 一致，返回字节数组', () => {
  for (const input of ['', 'abc', 'a'.repeat(64), 'x'.repeat(200)]) {
    const out = sha256(input);
    assert.ok(Array.isArray(out), 'sha256 返回字节数组（Redis/签名链路按 byte 使用）');
    assert.deepStrictEqual(out, nodeSha256Bytes(input), `sha256("${input.slice(0, 12)}") 应与 node:crypto 一致`);
  }
});

test('codec createHmacSha256 与 node:crypto 一致，返回 base64', () => {
  // 短 key 直接补齐，长 key（> 64 字节）先做 sha256 再补齐，两条分支都要覆盖
  const cases = [['secret', 'message'], ['k'.repeat(80), 'long-key-branch'], ['', 'empty-key']];
  for (const [key, msg] of cases) {
    assert.strictEqual(createHmacSha256(key, msg), nodeHmacB64(key, msg),
      `hmac(key=${key.slice(0, 8)}…, msg=${msg}) 应与 node:crypto 一致`);
  }
});

test('codec sm3Bytes 命中 OpenSSL SM3（含填充边界长度）', () => {
  // 55/56/64 字节是 SM3 填充的分界长度
  for (const input of ['abc', '', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '中文SM3测试']) {
    const expected = crypto.createHash('sm3').update(Buffer.from(input, 'utf8')).digest('hex');
    assert.strictEqual(toHex(sm3Bytes(Buffer.from(input, 'utf8'))), expected, `sm3("${input.slice(0, 12)}") 应一致`);
  }
});

test('codec pkcs7Pad 补齐到整块并校验块大小', () => {
  assert.strictEqual(toHex(pkcs7Pad(new Uint8Array(0))), '10'.repeat(16), '空输入补满一整块 0x10');
  assert.strictEqual(toHex(pkcs7Pad(new Uint8Array([1, 2, 3]))), '010203' + '0d'.repeat(13), '不足一块按缺少数补齐');
  assert.strictEqual(toHex(pkcs7Pad(new Uint8Array(15))), '00'.repeat(15) + '01', '差 1 字节时补 0x01');
  assert.strictEqual(toHex(pkcs7Pad(new Uint8Array(16))), '00'.repeat(16) + '10'.repeat(16), '整块也要再补一块');
  assert.strictEqual(pkcs7Pad(new Uint8Array(2), 1).length, 3, '块大小 1 时补 1 字节');
  assert.throws(() => pkcs7Pad(new Uint8Array(1), 0), RangeError);
  assert.throws(() => pkcs7Pad(new Uint8Array(1), 256), RangeError);
});

test('codec AES-128-CBC 加密与 node:crypto 一致（含 PKCS#7 填充）', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8');
  const iv = Buffer.from('fedcba9876543210', 'utf8');
  for (const plain of ['', 'hello danmu', '中文弹幕内容测试', 'x'.repeat(31), 'y'.repeat(32)]) {
    const mine = aesCbcEncrypt(Buffer.from(plain, 'utf8'), key, iv);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv); // 默认 PKCS#7 填充
    const expected = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    assert.strictEqual(toHex(mine), expected.toString('hex'), `CBC 加密 "${plain.slice(0, 10)}" 应一致`);
  }
  assert.throws(() => aesCbcEncrypt(new Uint8Array(16), new Uint8Array(15), iv), RangeError, 'key 必须 16 字节');
  assert.throws(() => aesCbcEncrypt(new Uint8Array(16), key, new Uint8Array(8)), RangeError, 'iv 必须 16 字节');
});

test('codec AES-ECB 解密与 node:crypto 一致（不做去填充）', () => {
  const key = Buffer.from('3b744389882a4067', 'utf8');
  const plain = Buffer.from('pad-check-0123456789', 'utf8'); // 非整块，走填充
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const cipherBytes = Buffer.concat([cipher.update(plain), cipher.final()]);

  const decrypted = aesEcbDecrypt(new Uint8Array(cipherBytes), new Uint8Array(key));
  const raw = crypto.createDecipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  const expected = Buffer.concat([raw.update(cipherBytes), raw.final()]);
  assert.strictEqual(toHex(decrypted), expected.toString('hex'), 'ECB 解密结果应保留填充字节');

  assert.throws(() => aesEcbDecrypt(new Uint8Array(15), new Uint8Array(key)), RangeError, '密文必须是整块');
  assert.throws(() => aesEcbDecrypt(new Uint8Array(16), new Uint8Array(15)), RangeError, 'key 长度非法');
});

test('codec aesDecryptBase64 还原 UTF-8 明文，非法输入返回 null', () => {
  const key = '3b744389882a4067';
  const plain = '弹幕解密😀 payload';
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  const b64 = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');

  assert.strictEqual(aesDecryptBase64(b64, key), plain, '应还原原始明文');
  assert.strictEqual(aesDecryptBase64('!!!not-base64!!!', key), null, '非法 base64 走 catch 返回 null');
});

test('codec Base64/Hex/UTF-8 编解码往返一致', () => {
  const allBytes = new Uint8Array(256).map((_, i) => i);
  assert.strictEqual(toHex(base64ToBytes(bytesToBase64(allBytes))), toHex(allBytes), 'base64 往返覆盖 0x00-0xFF');
  assert.strictEqual(toHex(hexToBytes(bytesToHex(allBytes))), toHex(allBytes), 'hex 往返覆盖 0x00-0xFF');
  assert.throws(() => hexToBytes('abc'), TypeError, '奇数长度十六进制应报错');
  assert.throws(() => hexToBytes('zz'), TypeError, '非十六进制字符应报错');

  for (const text of ['', 'plain', '中文标题', 'emoji😀🎉', 'a'.repeat(300)]) {
    assert.strictEqual(toHex(stringToUtf8Bytes(text)), Buffer.from(text, 'utf8').toString('hex'),
      `stringToUtf8Bytes("${text.slice(0, 8)}") 应与 Buffer utf8 一致`);
    assert.strictEqual(utf8BytesToString(Buffer.from(text, 'utf8')), text, 'utf8BytesToString 应还原原文');
  }
});

test('codec decompressBrotli 解压 zlib 产出的 Brotli 数据', () => {
  const raw = Buffer.from(JSON.stringify({ comments: [{ m: '中文弹幕', p: '1.0,1,16777215' }] }), 'utf8');
  const compressed = zlib.brotliCompressSync(raw);
  assert.strictEqual(Buffer.from(decompressBrotli(new Uint8Array(compressed))).toString('utf8'), raw.toString('utf8'));

  assert.throws(() => decompressBrotli(null), TypeError, '空输入应报错');
  assert.throws(() => decompressBrotli(new Uint8Array([1, 2, 3, 4])), Error, '非法 Brotli 数据应报错');
});

test('codec autoDecode 依次尝试 JSON / AES-ECB / 明文', () => {
  assert.deepStrictEqual(autoDecode('{"a":1}'), { a: 1 }, 'JSON 文本优先按 JSON 解析');
  assert.strictEqual(autoDecode('  plain text  '), 'plain text', '非 JSON 非密文时原样返回（去首尾空白）');

  const key = '3b744389882a4067';
  const encrypt = (text) => {
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
    return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('base64');
  };
  assert.deepStrictEqual(autoDecode(encrypt('{"type":"x"}')), { type: 'x' }, '密文解出 JSON 时返回对象');
  assert.strictEqual(autoDecode(encrypt('不是 JSON 的明文')), '不是 JSON 的明文', '密文解出普通文本时返回字符串');
});

test('codec parseDanmakuBase64 按 proto 解析弹幕元素', () => {
  const varint = (value) => {
    const out = [];
    let v = value;
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
    return out;
  };
  const varintField = (field, value) => [(field << 3) | 0, ...varint(value)];
  const bytesField = (field, text) => {
    const payload = [...Buffer.from(text, 'utf8')];
    return [(field << 3) | 2, ...varint(payload.length), ...payload];
  };
  const elem = (progress, content, color) => {
    const body = [...varintField(2, progress), ...varintField(3, 1), ...varintField(5, color), ...bytesField(7, content)];
    return [0x0a, ...varint(body.length), ...body];
  };

  const one = new Uint8Array(elem(1234, '测试弹幕', 16777215));
  assert.deepStrictEqual(parseDanmakuBase64(Buffer.from(one).toString('base64')),
    [{ progress: 1234, mode: 1, color: 16777215, content: '测试弹幕' }]);

  const two = new Uint8Array([...elem(1, '第一条', 0), ...elem(2000, '第二条', 16711680)]);
  const parsed = parseDanmakuBase64(Buffer.from(two).toString('base64'));
  assert.strictEqual(parsed.length, 2, '应解析出两条弹幕');
  assert.strictEqual(parsed[1].content, '第二条');
  assert.strictEqual(parsed[1].progress, 2000);

  assert.deepStrictEqual(parseDanmakuBase64(''), [], '空 payload 返回空数组');
  assert.deepStrictEqual(parseDanmakuBase64(Buffer.from([0x12, 0x01, 0x00]).toString('base64')), [],
    '不含 elems 字段时返回空数组');
});

test('codec parseDanmakuBase64 正确解析字段标签占多字节的弹幕', () => {
  // 真实数据：该条含 field 22，其标签占两个字节（0xb2 0x01）。标签按单字节读取会漏掉第二个字节，
  // 使后续字段整体错位，content 会被解析成 field 22 的 JSON 参数
  const elemHex = '0880fe8df4dcf794e61e10948a2d180520192880feff073207393434366161373a15e7bca9e59cb0e68890e5afb8e5a4aae5b885e4ba864095d9a6d606480a621332323139323430373931303635343630343830688080427803a2010130aa010130b2015f7b226964223a32303032352c22636964223a302c22616476616e6365645f626c6f636b223a302c22616e696d6174696f6e5f61747472223a302c226d696d65223a227a6970222c227265736f75726365223a22222c227363616c65223a307dc80101d001b18884e79e01d80101';
  const elem = Buffer.from(elemHex, 'hex');
  const payload = Buffer.concat([Buffer.from([0x0a, 0xd2, 0x01]), elem]);
  const parsed = parseDanmakuBase64(payload.toString('base64'));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].content, '缩地成寸太帅了');
  assert.strictEqual(parsed[0].progress, 738580);
  assert.strictEqual(parsed[0].mode, 5);
});

test('codec parseDanmakuBase64 跳过未知字段与定长字段', () => {
  const elem = new Uint8Array([0x10, 0x7b, 0x3a, 0x0c, ...Buffer.from('正常弹幕', 'utf8')]);
  const payload = new Uint8Array([0x12, 0x01, 0x00, 0x0a, elem.length, ...elem]);
  const parsed = parseDanmakuBase64(Buffer.from(payload).toString('base64'));
  assert.strictEqual(parsed.length, 1, '外层未知字段应被跳过而不是终止解析');
  assert.strictEqual(parsed[0].content, '正常弹幕');

  // 外层字段标签占多字节时同样应被跳过（0xb2 0x01 = field 22, length-delimited）
  const outerElem = new Uint8Array([0x10, 0x7b, 0x3a, 0x0f, ...Buffer.from('外层多字节', 'utf8')]);
  const outerPayload = new Uint8Array([0xb2, 0x01, 0x01, 0x00, 0x0a, outerElem.length, ...outerElem]);
  const parsed3 = parseDanmakuBase64(Buffer.from(outerPayload).toString('base64'));
  assert.strictEqual(parsed3.length, 1, '外层多字节标签的字段应被整体跳过');
  assert.strictEqual(parsed3[0].content, '外层多字节');

  const withFixed = new Uint8Array([0x10, 0x2a, 0xa1, 0x01, 1, 2, 3, 4, 5, 6, 7, 8, 0x3a, 0x0c, ...Buffer.from('定长跳过', 'utf8')]);
  const parsed2 = parseDanmakuBase64(Buffer.from([0x0a, withFixed.length, ...withFixed]).toString('base64'));
  assert.strictEqual(parsed2[0].content, '定长跳过', '内层 64 位定长字段应整体跳过');

  assert.doesNotThrow(() => parseDanmakuBase64(Buffer.from([0x0a, 0x64, 0x08, 0x01]).toString('base64')),
    '截断数据不应抛出');
  assert.doesNotThrow(() => parseDanmakuBase64(Buffer.from([0x0a, 0x05, 0x0b, 0x00, 0x00, 0x00, 0x00]).toString('base64')),
    '内层遇到不支持的 wire type 不应抛出');
});

test('codec generateSign / generateXCaSign 拼接稳定（防签名漂移）', () => {
  // generateSign 的组成 = path + 't' + timestamp + 按 key 排序的 key+value 拼接 + secretKey，再做 md5
  assert.strictEqual(generateSign('/api/v2/x', 1700000000, { b: 2, a: 1 }, 'secret'),
    md5('/api/v2/xt1700000000a1b2secret'), '参数按 key 升序拼接到 path 之后，最后拼 secretKey');
  assert.strictEqual(generateSign('/api/v2/x', 1700000000, null, 'secret'),
    md5('/api/v2/xt1700000000secret'), '无参数时只拼 path、时间戳与 secretKey');
  assert.notStrictEqual(generateSign('/api/v2/x', 1700000000, { a: 1 }, 'secret'),
    generateSign('/api/v2/x', 1700000001, { a: 1 }, 'secret'), '时间戳参与签名');
  assert.notStrictEqual(generateSign('/api/v2/x', 1700000000, { a: 1 }, 'secret'),
    generateSign('/api/v2/x', 1700000000, { a: 1 }, 'other'), 'secretKey 参与签名');

  // generateXCaSign 的组成 = x-ca 固定头 + path(+query)，再用 HMAC-SHA256 取 base64
  const expected = createHmacSha256('secret', 'GET\n*/*\ngzip\n\nx-ca-method:1\n/api/v2/x?a=1&b=2');
  assert.strictEqual(generateXCaSign('/api/v2/x', 1700000000, 'a=1&b=2', 'secret'), expected);
  assert.strictEqual(generateXCaSign('/api/v2/x', 1700000000, '', 'secret'),
    createHmacSha256('secret', 'GET\n*/*\ngzip\n\nx-ca-method:1\n/api/v2/x'), '无 query 时不追加 ?');
});

test('codec convertToAsciiSum / simpleHash / generateRandomSid / serializeValue / decodeHtmlEntities', () => {
  // djb2 变体：结果恒 >= 10000 且同输入同输出
  assert.strictEqual(convertToAsciiSum(''), 15381, '空串哈希 5381 会抬到 10000 以上');
  assert.strictEqual(convertToAsciiSum('abc'), convertToAsciiSum('abc'), '同输入结果稳定');
  assert.notStrictEqual(convertToAsciiSum('abc'), convertToAsciiSum('abd'));
  assert.ok(convertToAsciiSum('a'.repeat(50)) >= 10000);

  assert.strictEqual(simpleHash('same'), simpleHash('same'), 'simpleHash 稳定');
  assert.notStrictEqual(simpleHash('same'), simpleHash('diff'));
  assert.ok(simpleHash('abc') >= 0 && simpleHash('abc') <= 0xffffffff, 'simpleHash 为无符号 32 位');

  for (let i = 0; i < 20; i++) {
    assert.match(generateRandomSid(), /^[a-z0-9]{12}$/);
  }
  assert.notStrictEqual(generateRandomSid(), generateRandomSid(), '两次生成的 sid 不应相同');

  assert.strictEqual(serializeValue('lastSelectMap', new Map([['a', 1]])), '{"a":1}', 'Map 需转普通对象');
  assert.strictEqual(serializeValue('favoriteCache', new Map([['x', { v: 1 }]])), '{"x":{"v":1}}');
  assert.strictEqual(serializeValue('animes', { list: [1, 2] }), '{"list":[1,2]}', '普通对象直接序列化');
  assert.strictEqual(serializeValue('episodeNum', 10001), '10001');

  assert.strictEqual(decodeHtmlEntities('&lt;a&gt;&amp;&quot;&apos;'), '<a>&"\'', '命名实体');
  assert.strictEqual(decodeHtmlEntities('&#65;&#x42;'), 'AB', '十进制与十六进制实体');
  assert.strictEqual(decodeHtmlEntities('&#128512;'), '😀', '十进制实体支持码点大于 BMP');
  assert.strictEqual(decodeHtmlEntities('&nbsp;'), '&nbsp;', '未知命名实体保持原样');
  assert.strictEqual(decodeHtmlEntities(''), '', '空串原样返回');
  assert.strictEqual(decodeHtmlEntities(null), null, 'null 原样返回');
});
