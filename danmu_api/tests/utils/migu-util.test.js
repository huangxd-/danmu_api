// 咪咕弹幕解密工具：半字节置换密钥派生 + AES-256-ECB + PKCS#7 去填充 + UTF-8 校验
// 全部离线；AES 结果以 node:crypto 的 aes-256-ecb 作为权威对照，密文由 node:crypto 现场生成。

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { decrypt } from '../../utils/migu-util.js';

// 与源码一致的置换表常量（源码未导出，测试内独立声明以便用 node:crypto 反推「有效密钥」）
const KEY_NIBBLE_SUBSTITUTION = [3, 5, 7, 0, 15, 10, 13, 1, 11, 14, 4, 6, 9, 12, 8, 2];
const DEFAULT_GATEWAY_KEY = 'vwwLu7e6ug4HAQMAug8CsA8HD7oHDwuxAg4HAQG6DLA=';

// 把 base64 编码的 32 字节网关密钥按置换表映射成真正参与 AES 的密钥字节
function gatewayKeyBytes(encodedKey) {
  const source = Buffer.from(encodedKey, 'base64');
  return Buffer.from(Array.from(source, (value) =>
    (KEY_NIBBLE_SUBSTITUTION[value >>> 4] << 4) | KEY_NIBBLE_SUBSTITUTION[value & 0x0f]));
}

function aes256EcbEncrypt(plainBytes, keyBytes) {
  const cipher = crypto.createCipheriv('aes-256-ecb', keyBytes, null);
  return Buffer.concat([cipher.update(Buffer.from(plainBytes)), cipher.final()]);
}

function encryptForGateway(plainText, encodedKey = DEFAULT_GATEWAY_KEY) {
  return aes256EcbEncrypt(Buffer.from(plainText, 'utf8'), gatewayKeyBytes(encodedKey)).toString('base64');
}

// 原样加密一个 16 字节块（不做填充），用于伪造各种非法填充 / 非法 UTF-8 明文
function encryptRawBlock(blockBytes, encodedKey = DEFAULT_GATEWAY_KEY) {
  const cipher = crypto.createCipheriv('aes-256-ecb', gatewayKeyBytes(encodedKey), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(blockBytes)), cipher.final()]).toString('base64');
}

// 按 PKCS#7 补成合法的一整块，便于单独考察去填充之后的 UTF-8 校验分支
function paddedBlock(payloadBytes) {
  const payload = Buffer.from(payloadBytes);
  const paddingLength = 16 - payload.length;
  if (paddingLength < 1 || paddingLength > 16) throw new Error('辅助函数仅接受不足一块的载荷');
  return Buffer.concat([payload, Buffer.alloc(paddingLength, paddingLength)]);
}

test('migu decrypt 用默认网关密钥解出 AES-256-ECB/PKCS#7 密文（ASCII / 中文 / emoji / 空串 / 多块）', async () => {
  const cases = [
    'abc',
    '',
    '中文弹幕测试',
    'emoji😀 混排 danmu',
    'x'.repeat(100),
  ];

  for (const plain of cases) {
    const cipher = encryptForGateway(plain);
    assert.strictEqual(Buffer.from(cipher, 'base64').length % 16, 0, 'node:crypto 产出的密文应为整块');
    // key 省略、显式 undefined、显式 null 三种写法都应回落到默认网关密钥
    for (const keyArg of [undefined, null]) {
      const output = await decrypt(cipher, keyArg);
      assert.strictEqual(output, plain, `默认密钥应还原 ${JSON.stringify(plain.slice(0, 12))}`);
      assert.strictEqual(typeof output, 'string');
    }
  }

  // 空串只含一整块填充，说明去填充后长度为 0 而不是 16
  assert.strictEqual(Buffer.from(encryptForGateway(''), 'base64').length, 16);
  assert.strictEqual(await decrypt(encryptForGateway(''), undefined), '');
});

test('migu decrypt 按半字节置换表派生 32 字节密钥（0x00→0x33、0xFF→0x22，不是原样使用）', async () => {
  const zeroKey = Buffer.alloc(32, 0x00).toString('base64');
  const ffKey = Buffer.alloc(32, 0xff).toString('base64');
  assert.strictEqual(gatewayKeyBytes(zeroKey).toString('hex'), '33'.repeat(32));
  assert.strictEqual(gatewayKeyBytes(ffKey).toString('hex'), '22'.repeat(32));

  const plain = 'migu 密钥置换校验';
  // 用「置换后的有效密钥」加密：只有实现了 0x00→0x33 的映射才解得开
  const cipher = aes256EcbEncrypt(Buffer.from(plain, 'utf8'), Buffer.alloc(32, 0x33)).toString('base64');
  assert.strictEqual(await decrypt(cipher, zeroKey), plain);

  // 换另一把网关密钥（映射到 0x22）必须失败
  await assert.rejects(decrypt(cipher, ffKey), { name: 'Error', message: 'Error decrypting cipher text 2' });
  // 直接把未置换的 0x33 当作网关密钥也不行（置换表把 0x33 映射回 0x00）
  const unmapped = Buffer.alloc(32, 0x33).toString('base64');
  assert.strictEqual(gatewayKeyBytes(unmapped).toString('hex'), '00'.repeat(32));
  await assert.rejects(decrypt(cipher, unmapped), { name: 'Error', message: 'Error decrypting cipher text 2' });
});

test('migu decrypt 先剔除密文中的空白字符再解码（空格 / 换行 / 制表符等价于紧凑密文）', async () => {
  const plain = '空白容错 😀 弹幕';
  const compact = encryptForGateway(plain);
  const spaced = `${compact.slice(0, 8)} \n\t${compact.slice(8)}`;
  assert.notStrictEqual(spaced, compact);
  assert.strictEqual(await decrypt(spaced), plain);
  assert.strictEqual(await decrypt(`\n${compact}\t `), plain);
});

test('migu decrypt 非法密钥统一抛 Error Key（长度非 32 / 非法 base64 / 非字符串）', async () => {
  const validCipher = Buffer.alloc(16, 0x41).toString('base64');
  const invalidKeys = [
    Buffer.alloc(31, 0x01).toString('base64'),
    Buffer.alloc(33, 0x01).toString('base64'),
    Buffer.alloc(16, 0x01).toString('base64'),
    Buffer.alloc(0).toString('base64'),
    '!!!not-base64!!!',
    'AAA', // 长度不是 4 的倍数
    'AAAA', // 只有 3 字节
    new Uint8Array(32),
    123,
    {},
  ];

  for (const keyArg of invalidKeys) {
    await assert.rejects(
      decrypt(validCipher, keyArg),
      { name: 'Error', message: 'Error Key' },
      `非法密钥 ${String(keyArg).slice(0, 16)} 应报 Error Key`
    );
  }
});

test('migu decrypt 非法密文分两类报错（解码失败 1 / 解密失败 2，并校验非字符串入参）', async () => {
  const decodeError = { name: 'Error', message: 'Error decoding cipher text 1' };
  const decryptError = { name: 'Error', message: 'Error decrypting cipher text 2' };

  for (const badCipher of ['not base64!', 'AAA', 'AA=A', 'AAAAA', null, 123, {}, new Uint8Array(16)]) {
    await assert.rejects(
      decrypt(badCipher),
      decodeError,
      `非法密文 ${String(badCipher).slice(0, 12)} 应报解码失败`
    );
  }

  // 合法 base64 但不是 16 字节整数倍（含空串）→ 解密阶段报错
  for (const badCipher of ['', 'AAAA', 'A'.repeat(24), Buffer.alloc(8, 0x41).toString('base64')]) {
    await assert.rejects(
      decrypt(badCipher),
      decryptError,
      `非整块密文 ${JSON.stringify(badCipher.slice(0, 12))} 应报解密失败`
    );
  }

  // 32 字节整块但密钥错误时同样归入解密失败
  const wrongKeyCipher = Buffer.alloc(32, 0x41).toString('base64');
  await assert.rejects(decrypt(wrongKeyCipher, Buffer.alloc(32, 0x07).toString('base64')), decryptError);
});

test('migu decrypt 拒绝非法 PKCS#7 填充（尾字节超 16 / 为 0 / 与填充串不符）', async () => {
  const decryptError = { name: 'Error', message: 'Error decrypting cipher text 2' };
  const invalidBlocks = [
    Buffer.concat([Buffer.alloc(15, 0x41), Buffer.from([0x20])]), // 填充长度 32 > 16
    Buffer.concat([Buffer.alloc(15, 0x41), Buffer.from([0x00])]), // 填充长度 0
    Buffer.concat([Buffer.alloc(14, 0x41), Buffer.from([0x01, 0x02])]), // 声明 2 但前一字节不是 2
    Buffer.concat([Buffer.alloc(15, 0x41), Buffer.from([0x03])]), // 声明 3 但只有 1 字节匹配
  ];

  for (const block of invalidBlocks) {
    await assert.rejects(decrypt(encryptRawBlock(block)), decryptError, `非法填充 ${block.toString('hex')} 应报错`);
  }

  // 对照：整块 0x10 是合法填充，去填充后为空串（保证上面的失败不是「什么都失败」）
  assert.strictEqual(await decrypt(encryptRawBlock(Buffer.alloc(16, 0x10))), '');
  // 对照：尾部填充合法且载荷为 ASCII 时正常解出
  assert.strictEqual(await decrypt(encryptRawBlock(Buffer.concat([Buffer.from('ok'), Buffer.alloc(14, 0x0e)]))), 'ok');
});

test('migu decrypt 拒绝非法 UTF-8 明文（截断 / 过长编码 / 代理区码点 / 超 U+10FFFF / 孤立续字节）', async () => {
  const decryptError = { name: 'Error', message: 'Error decrypting cipher text 2' };
  const invalidPayloads = [
    [0xe4], // 三字节序列被截断
    [0xc0, 0x80], // 过长编码（0xc0 不是合法首字节）
    [0xed, 0xa0, 0x80], // 落在 UTF-16 代理区 U+D800
    [0xf4, 0x90, 0x80, 0x80], // 码点 0x110000 超出 U+10FFFF
    [0x80], // 孤立续字节
  ];

  for (const payload of invalidPayloads) {
    await assert.rejects(
      decrypt(encryptRawBlock(paddedBlock(payload))),
      decryptError,
      `非法 UTF-8 ${Buffer.from(payload).toString('hex')} 应报错`
    );
  }

  // 对照：同一构造路径上的合法四字节 emoji 能正常解出
  assert.strictEqual(await decrypt(encryptRawBlock(paddedBlock([0xf0, 0x9f, 0x98, 0x80]))), '😀');
});
