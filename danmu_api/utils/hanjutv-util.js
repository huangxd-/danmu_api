import { md5, stringToUtf8Bytes, utf8BytesToString } from "./codec-util.js";

const HANJUTV_VERSION = "6.5.3";
const HANJUTV_VC = "a_7980";
const HANJUTV_UA = "HanjuTV/6.5.3 (Pixel 2 XL; Android 11; Scale/2.00)";
const HANJUTV_UK_KEY = "f349wghhe784tqwh";
const HANJUTV_UK_IV = "d3w8hf94fidk38lk";
const HANJUTV_RESPONSE_SECRET = "34F9Q53w/HJW8E6Q";
const UID_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

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
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const INV_SBOX = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[SBOX[i]] = i;
  return table;
})();

const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function utf8Encode(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  return stringToUtf8Bytes(text);
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  return utf8BytesToString(bytes);
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");

  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"));

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function pkcs7Pad(bytes, blockSize = 16) {
  const remain = bytes.length % blockSize;
  const padSize = remain === 0 ? blockSize : blockSize - remain;
  const result = new Uint8Array(bytes.length + padSize);
  result.set(bytes, 0);
  result.fill(padSize, bytes.length);
  return result;
}

function stripControlChars(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function rotWord(word) {
  return Uint8Array.from([word[1], word[2], word[3], word[0]]);
}

function subWord(word) {
  return Uint8Array.from(word.map((b) => SBOX[b]));
}

function keyExpansion(key) {
  const Nk = 4;
  const Nb = 4;
  const Nr = 10;
  const w = new Array(Nb * (Nr + 1));

  for (let i = 0; i < Nk; i++) {
    w[i] = key.slice(4 * i, 4 * i + 4);
  }

  for (let i = Nk; i < Nb * (Nr + 1); i++) {
    let temp = w[i - 1];
    if (i % Nk === 0) {
      temp = xorBytes(subWord(rotWord(temp)), Uint8Array.from([RCON[i / Nk], 0, 0, 0]));
    }
    w[i] = xorBytes(w[i - Nk], temp);
  }

  return w;
}

function addRoundKey(state, w, round) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[r + 4 * c] = state[r + 4 * c] ^ w[round * 4 + c][r];
    }
  }
  return out;
}

function subBytes(state) {
  return Uint8Array.from(state.map((b) => SBOX[b]));
}

function invSubBytes(state) {
  return Uint8Array.from(state.map((b) => INV_SBOX[b]));
}

function shiftRows(state) {
  const out = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r + 4 * c] = state[r + 4 * ((c + r) % 4)];
    }
  }
  return out;
}

function invShiftRows(state) {
  const out = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r + 4 * c] = state[r + 4 * ((c - r + 4) % 4)];
    }
  }
  return out;
}

function gfMul(a, b) {
  let p = 0;
  let aa = a;
  let bb = b;
  for (let i = 0; i < 8; i++) {
    if (bb & 1) p ^= aa;
    const hi = aa & 0x80;
    aa = (aa << 1) & 0xff;
    if (hi) aa ^= 0x1b;
    bb >>= 1;
  }
  return p;
}

function mixColumns(state) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    const col = state.slice(4 * c, 4 * c + 4);
    out[4 * c + 0] = gfMul(col[0], 0x02) ^ gfMul(col[1], 0x03) ^ col[2] ^ col[3];
    out[4 * c + 1] = col[0] ^ gfMul(col[1], 0x02) ^ gfMul(col[2], 0x03) ^ col[3];
    out[4 * c + 2] = col[0] ^ col[1] ^ gfMul(col[2], 0x02) ^ gfMul(col[3], 0x03);
    out[4 * c + 3] = gfMul(col[0], 0x03) ^ col[1] ^ col[2] ^ gfMul(col[3], 0x02);
  }
  return out;
}

function invMixColumns(state) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    const col = state.slice(4 * c, 4 * c + 4);
    out[4 * c + 0] = gfMul(col[0], 0x0e) ^ gfMul(col[1], 0x0b) ^ gfMul(col[2], 0x0d) ^ gfMul(col[3], 0x09);
    out[4 * c + 1] = gfMul(col[0], 0x09) ^ gfMul(col[1], 0x0e) ^ gfMul(col[2], 0x0b) ^ gfMul(col[3], 0x0d);
    out[4 * c + 2] = gfMul(col[0], 0x0d) ^ gfMul(col[1], 0x09) ^ gfMul(col[2], 0x0e) ^ gfMul(col[3], 0x0b);
    out[4 * c + 3] = gfMul(col[0], 0x0b) ^ gfMul(col[1], 0x0d) ^ gfMul(col[2], 0x09) ^ gfMul(col[3], 0x0e);
  }
  return out;
}

function aesEncryptBlock(input, w) {
  let state = new Uint8Array(input);
  state = addRoundKey(state, w, 0);

  for (let round = 1; round <= 9; round++) {
    state = subBytes(state);
    state = shiftRows(state);
    state = mixColumns(state);
    state = addRoundKey(state, w, round);
  }

  state = subBytes(state);
  state = shiftRows(state);
  state = addRoundKey(state, w, 10);
  return state;
}

function aesDecryptBlock(input, w) {
  let state = new Uint8Array(input);
  state = addRoundKey(state, w, 10);

  for (let round = 9; round >= 1; round--) {
    state = invShiftRows(state);
    state = invSubBytes(state);
    state = addRoundKey(state, w, round);
    state = invMixColumns(state);
  }

  state = invShiftRows(state);
  state = invSubBytes(state);
  state = addRoundKey(state, w, 0);
  return state;
}

function aesCbcEncryptPure(plainBytes, keyBytes, ivBytes) {
  const padded = pkcs7Pad(plainBytes, 16);
  const w = keyExpansion(keyBytes);
  const out = new Uint8Array(padded.length);
  let prev = new Uint8Array(ivBytes);

  for (let i = 0; i < padded.length; i += 16) {
    const block = padded.slice(i, i + 16);
    const mixed = xorBytes(block, prev);
    const cipherBlock = aesEncryptBlock(mixed, w);
    out.set(cipherBlock, i);
    prev = cipherBlock;
  }

  return out;
}

function aesCbcDecryptPureNoUnpad(cipherBytes, keyBytes, ivBytes) {
  if (cipherBytes.length % 16 !== 0) {
    throw new Error(`密文长度不是16的倍数: ${cipherBytes.length}`);
  }

  const w = keyExpansion(keyBytes);
  const out = new Uint8Array(cipherBytes.length);
  let prev = new Uint8Array(ivBytes);

  for (let i = 0; i < cipherBytes.length; i += 16) {
    const block = cipherBytes.slice(i, i + 16);
    const plainBlock = xorBytes(aesDecryptBlock(block, w), prev);
    out.set(plainBlock, i);
    prev = block;
  }

  return out;
}

async function aesCbcEncryptToBase64(plainText, key, iv) {
  const keyBytes = utf8Encode(key);
  const ivBytes = utf8Encode(iv);
  const plainBytes = utf8Encode(plainText);
  const cipherBytes = aesCbcEncryptPure(plainBytes, keyBytes, ivBytes);
  return bytesToBase64(cipherBytes);
}

async function aesCbcDecryptBase64NoPadding(cipherBase64, key, iv) {
  const keyBytes = utf8Encode(key);
  const ivBytes = utf8Encode(iv);
  const cipherBytes = base64ToBytes(cipherBase64);
  const plainBytes = aesCbcDecryptPureNoUnpad(cipherBytes, keyBytes, ivBytes);
  return utf8Decode(plainBytes);
}

function randomInt(max) {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function buildSearchSignPayload(uid, timestamp) {
  return JSON.stringify({
    emu: 0,
    ou: 0,
    it: timestamp,
    iit: timestamp,
    bs: 0,
    uid,
    pc: 0,
    tm: 0,
    d8m: "0,0,0,0,0,0,0,0",
    md: "Pixel 2 XL",
    maker: "Google",
    osv: "11",
    br: 100,
    rpc: 0,
    scc: 0,
    plc: 0,
    toc: 1,
    tsc: 0,
    ts: timestamp,
    pa: 1,
    nw: 2,
    px: "0",
    isp: "",
    ai: "ccffc2520864efdb",
    oa: "",
    dpc: 0,
    dsc: 0,
    qpc: 0,
    apad: 0,
    pk: "com.babycloud.hanju",
  });
}

export function createHanjutvUid(length = 20) {
  let uid = "";
  for (let i = 0; i < length; i++) uid += UID_CHARSET[randomInt(UID_CHARSET.length)];
  return uid;
}

export async function createHanjutvSearchHeaders(uid, timestamp = Date.now()) {
  const ts = Number(timestamp);
  const uidMd5 = md5(uid);
  const signPayload = buildSearchSignPayload(uid, ts);
  const sign = await aesCbcEncryptToBase64(signPayload, uidMd5.slice(0, 16), uidMd5.slice(16, 32));
  const uk = await aesCbcEncryptToBase64(uid, HANJUTV_UK_KEY, HANJUTV_UK_IV);

  return {
    app: "hj",
    ch: "qq",
    uk,
    "auth-uid": "",
    vn: HANJUTV_VERSION,
    sign,
    "User-Agent": HANJUTV_UA,
    vc: HANJUTV_VC,
    "auth-token": "",
    "Accept-Encoding": "gzip",
    Connection: "Keep-Alive",
  };
}

export async function decodeHanjutvEncryptedPayload(payload, uid = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (typeof payload.data !== "string" || payload.data.length === 0) return payload;

  const ts = payload.ts ?? "";
  let key = typeof payload.key === "string" && payload.key ? payload.key : "";
  if (!key && uid && ts !== "") key = md5(`${uid}${ts}`);
  if (!key) throw new Error("缺少解密 key，且无法通过 uid+ts 推导");

  const mix = md5(`${key}${HANJUTV_RESPONSE_SECRET}`);
  const aesKey = mix.slice(0, 16);
  const iv = mix.slice(16, 32);
  const plainText = await aesCbcDecryptBase64NoPadding(payload.data, aesKey, iv);
  const cleanedText = stripControlChars(plainText).trim();
  return JSON.parse(cleanedText);
}
