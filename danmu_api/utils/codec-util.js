import { log } from "./log-util.js";

// =====================
// 通用编码/解码工具
// =====================

// 简单的字符串哈希函数
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash >>> 0; // 确保为无符号 32 位整数
  }
  return hash.toString(16); // 转换为十六进制
}

// 辅助函数：序列化值，处理 Map 对象
export function serializeValue(key, value) {
  // 对于 lastSelectMap（Map 对象），需要转换为普通对象后再序列化
  if (key === 'lastSelectMap' && value instanceof Map) {
    return JSON.stringify(Object.fromEntries(value));
  }
  return JSON.stringify(value);
}

// md5.js 本地版本
export function md5(message) {
  // --- UTF-8 转换 ---
  function toUtf8(str) {
    let utf8 = "";
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      if (charCode < 0x80) {
        utf8 += String.fromCharCode(charCode);
      } else if (charCode < 0x800) {
        utf8 += String.fromCharCode(0xc0 | (charCode >> 6));
        utf8 += String.fromCharCode(0x80 | (charCode & 0x3f));
      } else {
        utf8 += String.fromCharCode(0xe0 | (charCode >> 12));
        utf8 += String.fromCharCode(0x80 | ((charCode >> 6) & 0x3f));
        utf8 += String.fromCharCode(0x80 | (charCode & 0x3f));
      }
    }
    return utf8;
  }

  message = toUtf8(message);

  function rotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }

  function addUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
      else return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    } else return lResult ^ lX8 ^ lY8;
  }

  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }

  function FF(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function GG(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function HH(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function II(a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function convertToWordArray(str) {
    const lMessageLength = str.length;
    const lNumberOfWords = (((lMessageLength + 8) >>> 6) + 1) * 16;
    const lWordArray = new Array(lNumberOfWords).fill(0);
    for (let i = 0; i < lMessageLength; i++) {
      lWordArray[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    }
    lWordArray[lMessageLength >> 2] |= 0x80 << ((lMessageLength % 4) * 8);
    lWordArray[lNumberOfWords - 2] = lMessageLength * 8;
    return lWordArray;
  }

  function wordToHex(lValue) {
    let wordToHexValue = "";
    for (let lCount = 0; lCount <= 3; lCount++) {
      const lByte = (lValue >>> (lCount * 8)) & 255;
      let wordToHexValueTemp = "0" + lByte.toString(16);
      wordToHexValue += wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
    }
    return wordToHexValue;
  }

  let x = convertToWordArray(message);
  let a = 0x67452301;
  let b = 0xEFCDAB89;
  let c = 0x98BADCFE;
  let d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    let AA = a, BB = b, CC = c, DD = d;

    // --- Round 1 ---
    a = FF(a, b, c, d, x[k + 0], 7, 0xD76AA478);
    d = FF(d, a, b, c, x[k + 1], 12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k + 2], 17, 0x242070DB);
    b = FF(b, c, d, a, x[k + 3], 22, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], 7, 0xF57C0FAF);
    d = FF(d, a, b, c, x[k + 5], 12, 0x4787C62A);
    c = FF(c, d, a, b, x[k + 6], 17, 0xA8304613);
    b = FF(b, c, d, a, x[k + 7], 22, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], 7, 0x698098D8);
    d = FF(d, a, b, c, x[k + 9], 12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k + 10], 17, 0xFFFF5BB1);
    b = FF(b, c, d, a, x[k + 11], 22, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], 7, 0x6B901122);
    d = FF(d, a, b, c, x[k + 13], 12, 0xFD987193);
    c = FF(c, d, a, b, x[k + 14], 17, 0xA679438E);
    b = FF(b, c, d, a, x[k + 15], 22, 0x49B40821);

    // --- Round 2 ---
    a = GG(a, b, c, d, x[k + 1], 5, 0xF61E2562);
    d = GG(d, a, b, c, x[k + 6], 9, 0xC040B340);
    c = GG(c, d, a, b, x[k + 11], 14, 0x265E5A51);
    b = GG(b, c, d, a, x[k + 0], 20, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], 5, 0xD62F105D);
    d = GG(d, a, b, c, x[k + 10], 9, 0x02441453);
    c = GG(c, d, a, b, x[k + 15], 14, 0xD8A1E681);
    b = GG(b, c, d, a, x[k + 4], 20, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], 5, 0x21E1CDE6);
    d = GG(d, a, b, c, x[k + 14], 9, 0xC33707D6);
    c = GG(c, d, a, b, x[k + 3], 14, 0xF4D50D87);
    b = GG(b, c, d, a, x[k + 8], 20, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], 5, 0xA9E3E905);
    d = GG(d, a, b, c, x[k + 2], 9, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k + 7], 14, 0x676F02D9);
    b = GG(b, c, d, a, x[k + 12], 20, 0x8D2A4C8A);

    // --- Round 3 ---
    a = HH(a, b, c, d, x[k + 5], 4, 0xFFFA3942);
    d = HH(d, a, b, c, x[k + 8], 11, 0x8771F681);
    c = HH(c, d, a, b, x[k + 11], 16, 0x6D9D6122);
    b = HH(b, c, d, a, x[k + 14], 23, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], 4, 0xA4BEEA44);
    d = HH(d, a, b, c, x[k + 4], 11, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k + 7], 16, 0xF6BB4B60);
    b = HH(b, c, d, a, x[k + 10], 23, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], 4, 0x289B7EC6);
    d = HH(d, a, b, c, x[k + 0], 11, 0xEAA127FA);
    c = HH(c, d, a, b, x[k + 3], 16, 0xD4EF3085);
    b = HH(b, c, d, a, x[k + 6], 23, 0x04881D05);
    a = HH(a, b, c, d, x[k + 9], 4, 0xD9D4D039);
    d = HH(d, a, b, c, x[k + 12], 11, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k + 15], 16, 0x1FA27CF8);
    b = HH(b, c, d, a, x[k + 2], 23, 0xC4AC5665);

    // --- Round 4 ---
    a = II(a, b, c, d, x[k + 0], 6, 0xF4292244);
    d = II(d, a, b, c, x[k + 7], 10, 0x432AFF97);
    c = II(c, d, a, b, x[k + 14], 15, 0xAB9423A7);
    b = II(b, c, d, a, x[k + 5], 21, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], 6, 0x655B59C3);
    d = II(d, a, b, c, x[k + 3], 10, 0x8F0CCC92);
    c = II(c, d, a, b, x[k + 10], 15, 0xFFEFF47D);
    b = II(b, c, d, a, x[k + 1], 21, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], 6, 0x6FA87E4F);
    d = II(d, a, b, c, x[k + 15], 10, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k + 6], 15, 0xA3014314);
    b = II(b, c, d, a, x[k + 13], 21, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], 6, 0xF7537E82);
    d = II(d, a, b, c, x[k + 11], 10, 0xBD3AF235);
    c = II(c, d, a, b, x[k + 2], 15, 0x2AD7D2BB);
    b = II(b, c, d, a, x[k + 9], 21, 0xEB86D391);

    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

export function parseDanmakuBase64(base64) {
  const bytes = base64ToBytes(base64);
  const elems = [];

  let offset = 0;
  while (offset < bytes.length) {
    // 每个 DanmakuElem 在 elems 列表里是 length-delimited
    const key = bytes[offset++];
    if (key !== 0x0a) break; // field=1 (elems), wire=2
    const [msgBytes, nextOffset] = readLengthDelimited(bytes, offset);
    offset = nextOffset;

    let innerOffset = 0;
    const elem = {};

    while (innerOffset < msgBytes.length) {
      const tag = msgBytes[innerOffset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        // varint
        const [val, innerNext] = readVarint(msgBytes, innerOffset);
        innerOffset = innerNext;
        switch (fieldNumber) {
          case 1: elem.id = val; break;
          case 2: elem.progress = val; break;
          case 3: elem.mode = val; break;
          case 4: elem.fontsize = val; break;
          case 5: elem.color = val; break;
          case 8: elem.ctime = val; break;
          case 9: elem.weight = val; break;
          case 11: elem.pool = val; break;
          case 13: elem.attr = val; break;
          case 15: elem.like_num = val; break;
          case 17: elem.dm_type_v2 = val; break;
        }
      } else if (wireType === 2) {
        // length-delimited
        const [valBytes, innerNext] = readLengthDelimited(msgBytes, innerOffset);
        innerOffset = innerNext;
        switch (fieldNumber) {
          case 6: elem.midHash = utf8BytesToString(valBytes); break;
          case 7: elem.content = utf8BytesToString(valBytes); break;
          case 10: elem.action = utf8BytesToString(valBytes); break;
          case 12: elem.idStr = utf8BytesToString(valBytes); break;
          case 14: elem.animation = utf8BytesToString(valBytes); break;
          case 16: elem.color_v2 = utf8BytesToString(valBytes); break;
        }
      } else {
        // 其他类型不常用，忽略
        const [_, innerNext] = readVarint(msgBytes, innerOffset);
        innerOffset = innerNext;
      }
    }

    elems.push(elem);
  }

  return elems;
}

function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (true) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [Number(result), pos];
}

function readLengthDelimited(bytes, offset) {
  const [length, newOffset] = readVarint(bytes, offset);
  const start = newOffset;
  const end = start + length;
  const slice = bytes.slice(start, end);
  return [slice, end];
}

// djb2 哈希算法将string转成id
export function convertToAsciiSum(sid) {
  let hash = 5381;
  for (let i = 0; i < sid.length; i++) {
    hash = (hash * 33) ^ sid.charCodeAt(i);
  }
  hash = (hash >>> 0) % 9999999;
  // 确保至少 5 位
  return hash < 10000 ? hash + 10000 : hash;
}

// ====================== AES-128-ECB 完整实现 ======================

// S盒
const SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
];

// 轮常量
const RCON = [
  0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36
];

// 字节异或
function xor(a,b) {
  const out = new Uint8Array(a.length);
  for(let i=0;i<a.length;i++) out[i]=a[i]^b[i];
  return out;
}

// 字循环左移
function rotWord(word){
  return Uint8Array.from([word[1],word[2],word[3],word[0]]);
}

// 字节代换
function subWord(word){
  return Uint8Array.from(word.map(b=>SBOX[b]));
}

// 扩展密钥 16 字节 -> 176 字节
function keyExpansion(key) {
  const Nk = 4, Nb=4, Nr=10;
  const w = new Array(Nb*(Nr+1));
  for(let i=0;i<Nk;i++){
    w[i] = key.slice(4*i,4*i+4);
  }
  for(let i=Nk;i<Nb*(Nr+1);i++){
    let temp = w[i-1];
    if(i%Nk===0) temp = xor(subWord(rotWord(temp)), Uint8Array.from([RCON[i/Nk],0,0,0]));
    w[i]=xor(w[i-Nk],temp);
  }
  return w;
}

// AES-128 解密单块 (16 字节)
function aesDecryptBlock(input, w) {
  const Nb=4, Nr=10;
  let state = new Uint8Array(input);
  state = addRoundKey(state, w.slice(Nr*Nb,(Nr+1)*Nb));
  for(let round=Nr-1;round>=1;round--){
    state = invShiftRows(state);
    state = invSubBytes(state);
    state = addRoundKey(state, w.slice(round*Nb,(round+1)*Nb));
    state = invMixColumns(state);
  }
  state = invShiftRows(state);
  state = invSubBytes(state);
  state = addRoundKey(state, w.slice(0,Nb));
  return state;
}

// AES 辅助函数
function addRoundKey(state, w){
  const out = new Uint8Array(16);
  for(let c=0;c<4;c++)
    for(let r=0;r<4;r++)
      out[r+4*c]=state[r+4*c]^w[c][r];
  return out;
}

function invSubBytes(state){
  const INV_SBOX = new Array(256);
  for(let i=0;i<256;i++) INV_SBOX[SBOX[i]]=i;
  return Uint8Array.from(state.map(b=>INV_SBOX[b]));
}

function invShiftRows(state){
  const out = new Uint8Array(16);
  for(let r=0;r<4;r++)
    for(let c=0;c<4;c++)
      out[r+4*c]=state[r+4*((c-r+4)%4)];
  return out;
}

function invMixColumns(state){
  function mul(a,b){
    let p=0;
    for(let i=0;i<8;i++){
      if(b&1) p^=a;
      let hi=(a&0x80);
      a=(a<<1)&0xFF;
      if(hi) a^=0x1b;
      b>>=1;
    }
    return p;
  }
  const out = new Uint8Array(16);
  for(let c=0;c<4;c++){
    const col = state.slice(4*c,4*c+4);
    out[4*c+0]=mul(col[0],0x0e)^mul(col[1],0x0b)^mul(col[2],0x0d)^mul(col[3],0x09);
    out[4*c+1]=mul(col[0],0x09)^mul(col[1],0x0e)^mul(col[2],0x0b)^mul(col[3],0x0d);
    out[4*c+2]=mul(col[0],0x0d)^mul(col[1],0x09)^mul(col[2],0x0e)^mul(col[3],0x0b);
    out[4*c+3]=mul(col[0],0x0b)^mul(col[1],0x0d)^mul(col[2],0x09)^mul(col[3],0x0e);
  }
  return out;
}

// ====================== ECB 模式解密 ======================
function aesDecryptECB(cipherBytes, keyBytes){
  const w = keyExpansion(keyBytes);
  const blockSize = 16;
  const result = new Uint8Array(cipherBytes.length);
  for(let i=0;i<cipherBytes.length;i+=blockSize){
    const block = cipherBytes.slice(i,i+blockSize);
    const decrypted = aesDecryptBlock(block,w);
    result.set(decrypted,i);
  }
  return result;
}

// ====================== PKCS#7 去填充 ======================
function pkcs7Unpad(data){
  const pad = data[data.length-1];
  return data.slice(0,data.length-pad);
}

// ====================== Base64 解码 ======================
function base64ToBytes(b64) {
  // 先把 Base64 字符串转换成普通字符
  const binaryString = (typeof atob === 'function')
    ? atob(b64) // 浏览器环境
    : BufferBase64Decode(b64); // Node / React Native 自定义

  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// 自定义 Base64 解码函数
function BufferBase64Decode(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let str = '';
  let buffer = 0, bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charAt(i);
    if (c === '=') break;
    const val = chars.indexOf(c);
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      str += String.fromCharCode((buffer >> bits) & 0xFF);
    }
  }
  return str;
}

// ====================== 主函数 ======================
// Uint8Array UTF-8 解码成字符串，替代 TextDecoder
function utf8BytesToString(bytes) {
  let str = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      str += String.fromCharCode(b1);
    } else if (b1 >= 0xc0 && b1 < 0xe0) {
      const b2 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 >= 0xe0 && b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if (b1 >= 0xf0) {
      // surrogate pair
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const codepoint = ((b1 & 0x07) << 18) |
                        ((b2 & 0x3f) << 12) |
                        ((b3 & 0x3f) << 6) |
                        (b4 & 0x3f);
      const cp = codepoint - 0x10000;
      str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return str;
}

// 同时替换 TextEncoder
function stringToUtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6));
      bytes.push(0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(0xe0 | (code >> 12));
      bytes.push(0x80 | ((code >> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    } else {
      // surrogate pair
      i++;
      const code2 = str.charCodeAt(i);
      const codePoint = 0x10000 + (((code & 0x3ff) << 10) | (code2 & 0x3ff));
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

// 修改后的 aesDecryptBase64
function aesDecryptBase64(cipherB64, keyStr) {
  try {
    const cipherBytes = base64ToBytes(cipherB64);
    const keyBytes = stringToUtf8Bytes(keyStr);
    const decryptedBytes = aesDecryptECB(cipherBytes, keyBytes);
    const unpadded = pkcs7Unpad(decryptedBytes);
    return utf8BytesToString(unpadded);
  } catch (e) {
    log("error", e);
    return null;
  }
}

export function autoDecode(anything) {
  const text = typeof anything === "string" ? anything.trim() : JSON.stringify(anything ?? "");
  try {
    return JSON.parse(text);
  } catch {}

  const AES_KEY = "3b744389882a4067"; // 直接传字符串
  const dec = aesDecryptBase64(text, AES_KEY); // aesDecryptBase64 内会 TextEncoder.encode
  if (dec != null) {
    try {
      return JSON.parse(dec);
    } catch {
      return dec;
    }
  }
  return text;
}

function str2bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6));
            bytes.push(0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12));
            bytes.push(0x80 | ((code >> 6) & 0x3f));
            bytes.push(0x80 | (code & 0x3f));
        }
    }
    return bytes;
}

// ===================== Base64 编码 =====================
function bytesToBase64(bytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
        result += chars[bytes[i] >> 2];
        result += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
        result += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
        result += chars[bytes[i + 2] & 63];
    }
    if (i < bytes.length) {
        result += chars[bytes[i] >> 2];
        if (i + 1 < bytes.length) {
            result += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
            result += chars[(bytes[i + 1] & 15) << 2];
            result += '=';
        } else {
            result += chars[(bytes[i] & 3) << 4];
            result += '==';
        }
    }
    return result;
}

// ===================== SHA256 算法 =====================
// 纯 JS SHA256，返回字节数组
function sha256(ascii) {
    function rightRotate(n, x) { return (x >>> n) | (x << (32 - n)); }

    let maxWord = Math.pow(2, 32);
    let words = [], asciiBitLength = ascii.length * 8;

    for (let i = 0; i < ascii.length; i++) {
        words[i >> 2] |= ascii.charCodeAt(i) << ((3 - i) % 4 * 8);
    }

    words[ascii.length >> 2] |= 0x80 << ((3 - ascii.length % 4) * 8);
    words[((ascii.length + 8) >> 6) * 16 + 15] = asciiBitLength;

    let w = new Array(64), hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    const k = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];

    for (let j = 0; j < words.length; j += 16) {
        let a = hash[0], b = hash[1], c = hash[2], d = hash[3],
            e = hash[4], f = hash[5], g = hash[6], h = hash[7];

        for (let i = 0; i < 64; i++) {
            if (i < 16) w[i] = words[j + i] | 0;
            else {
                const s0 = rightRotate(7, w[i-15]) ^ rightRotate(18, w[i-15]) ^ (w[i-15]>>>3);
                const s1 = rightRotate(17, w[i-2]) ^ rightRotate(19, w[i-2]) ^ (w[i-2]>>>10);
                w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
            }
            const S1 = rightRotate(6, e) ^ rightRotate(11, e) ^ rightRotate(25, e);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + k[i] + w[i]) | 0;
            const S0 = rightRotate(2, a) ^ rightRotate(13, a) ^ rightRotate(22, a);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }

        hash[0] = (hash[0] + a) | 0;
        hash[1] = (hash[1] + b) | 0;
        hash[2] = (hash[2] + c) | 0;
        hash[3] = (hash[3] + d) | 0;
        hash[4] = (hash[4] + e) | 0;
        hash[5] = (hash[5] + f) | 0;
        hash[6] = (hash[6] + g) | 0;
        hash[7] = (hash[7] + h) | 0;
    }

    // 转为字节数组
    const bytes = [];
    for (let h of hash) {
        bytes.push((h >> 24) & 0xFF);
        bytes.push((h >> 16) & 0xFF);
        bytes.push((h >> 8) & 0xFF);
        bytes.push(h & 0xFF);
    }
    return bytes;
}

// ===================== HMAC-SHA256 =====================
export function createHmacSha256(key, message) {
    const blockSize = 64; // 512 bit
    let keyBytes = str2bytes(key);
    if (keyBytes.length > blockSize) keyBytes = sha256(key);
    if (keyBytes.length < blockSize) keyBytes = keyBytes.concat(Array(blockSize - keyBytes.length).fill(0));

    const oKeyPad = keyBytes.map(b => b ^ 0x5c);
    const iKeyPad = keyBytes.map(b => b ^ 0x36);

    const innerHash = sha256(String.fromCharCode(...iKeyPad) + message);
    const hmacBytes = sha256(String.fromCharCode(...oKeyPad) + String.fromCharCode(...innerHash));

    return bytesToBase64(hmacBytes);
}

// ========== 生成随机SID ==========
export function generateRandomSid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({length: 12}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ========== 签名生成函数 ==========
export function generateSign(path, timestamp, params, secretKey) {
    let signStr = path + "t" + timestamp;

    if (params) {
      const sortedKeys = Object.keys(params).sort();
      sortedKeys.forEach(key => {
          signStr += key + params[key];
      });
    }

    signStr += secretKey;
    return md5(signStr);
}

// ========== X-CA-Sign 生成函数 ==========
export function generateXCaSign(path, timestamp, queryString, secretKey) {
    let signStr = `GET\n*/*\ngzip\n\nx-ca-method:1\n${path}`;
    if (queryString) signStr += `?${queryString}`;

    return createHmacSha256(secretKey, signStr);
}

// 兼容版本的 fromCodePoint
function fromCodePoint(codePoint) {
  // BMP 范围内的字符可以直接用 fromCharCode
  if (codePoint <= 0xFFFF) {
    return String.fromCharCode(codePoint);
  }
  
  // 超出 BMP 的字符需要转换为代理对
  codePoint -= 0x10000;
  const highSurrogate = (codePoint >> 10) + 0xD800;
  const lowSurrogate = (codePoint & 0x3FF) + 0xDC00;
  return String.fromCharCode(highSurrogate, lowSurrogate);
}

/**
   * 将HTML实体转换为实际字符
   * @param {string} str - 包含HTML实体的字符串
   * @returns {string} 转换后的字符串
   */
export function decodeHtmlEntities(str) {
  // 处理十进制HTML实体 &#12345;
  return str.replace(/&#(\d+);/g, (match, num) => {
    return fromCodePoint(parseInt(num, 10));
  })
  // 处理十六进制HTML实体 &#x123A;
  .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
    return fromCodePoint(parseInt(hex, 16));
  });
}