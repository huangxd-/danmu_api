import { md5, stringToUtf8Bytes, utf8BytesToString, bytesToBase64, base64ToBytes, invSubBytes, subWord, keyExpansion, invShiftRows } from "./codec-util.js";

// 移动端参数
const HANJUTV_VERSION = "6.8.2";
const HANJUTV_VC = "a_8280";
const HANJUTV_CH = "xiaomi";
const HANJUTV_MODEL = "Redmi Note 12";
const HANJUTV_MAKER = "Xiaomi";
const HANJUTV_OSV = "14";
const HANJUTV_UA = `HanjuTV/${HANJUTV_VERSION} (${HANJUTV_MODEL}; Android ${HANJUTV_OSV}; Scale/2.00)`;
const HANJUTV_INSTALL_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const UID_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 共享加密参数
const UK_KEY = "f349wghhe784tqwh";
const UK_IV = "d3w8hf94fidk38lk";
const RESPONSE_SECRET = "34F9Q53w/HJW8E6Q";

// TV版本参数
const SAID = "fb3597b87601d5a7";

function utf8Encode(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  return stringToUtf8Bytes(text);
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  return utf8BytesToString(bytes);
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

function addRoundKey(state, w, round) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[r + 4 * c] = state[r + 4 * c] ^ w[round * 4 + c][r];
    }
  }
  return out;
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
    state = subWord(state);
    state = shiftRows(state);
    state = mixColumns(state);
    state = addRoundKey(state, w, round);
  }

  state = subWord(state);
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

export function createHanjutvUid(length = 20) {
  let uid = "";
  for (let i = 0; i < length; i++) uid += UID_CHARSET[randomInt(UID_CHARSET.length)];
  return uid;
}

function randomFrom(chars, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += chars[randomInt(chars.length)];
  return s;
}

function normalizePositiveTimestamp(value, fallbackValue = Date.now()) {
  const ts = Number(value);
  return Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : Math.trunc(Number(fallbackValue) || Date.now());
}

function createSearchContext(uid, sessionInitTs = Date.now()) {
  const initTs = normalizePositiveTimestamp(sessionInitTs);
  return {
    uid: uid || createHanjutvUid(),
    said: randomFrom("0123456789abcdef", 16),
    oa: randomFrom("0123456789abcdef", 16),
    installTs: Math.max(0, initTs - HANJUTV_INSTALL_AGE_MS),
  };
}

function buildSearchSignPayload(context, timestamp) {
  const ts = normalizePositiveTimestamp(timestamp, context.installTs + HANJUTV_INSTALL_AGE_MS);
  return JSON.stringify({ emu: 0, ou: 0, it: context.installTs, iit: context.installTs, bs: 0, uid: context.uid, pc: 0, tm: 81, d8m: "0,0,0,0,0,0,0,4", md: HANJUTV_MODEL, maker: HANJUTV_MAKER, osv: HANJUTV_OSV, br: 95, rpc: 0, scc: 2, plc: 6, toc: 19, tsc: 10, ts, pa: 1, crec: 0, nw: 2, px: "0", isp: "", ai: context.said, oa: context.oa, dpc: 0, dsc: 0, qpc: 0, apad: 0, pk: "com.babycloud.hanju" });
}

export async function buildHanjutvSearchHeaders(sessionInitTs = Date.now(), uid = createHanjutvUid()) {
  const searchContext = createSearchContext(uid, sessionInitTs);
  const uidMd5 = md5(searchContext.uid);
  const uk = await aesCbcEncryptToBase64(searchContext.uid, UK_KEY, UK_IV);

  return async function makeHeaders(reqTs = Date.now()) {
    const signPayload = buildSearchSignPayload(searchContext, reqTs);
    const sign = await aesCbcEncryptToBase64(signPayload, uidMd5.slice(0, 16), uidMd5.slice(16, 32));

    return {
      uid: searchContext.uid,
      headers: {
        app: "hj",
        ch: HANJUTV_CH,
        said: searchContext.said,
        uk,
        vn: HANJUTV_VERSION,
        sign,
        "User-Agent": HANJUTV_UA,
        vc: HANJUTV_VC,
        "Accept-Encoding": "gzip",
        Connection: "Keep-Alive",
      },
    };
  };
}

// TV端headers
export async function buildLiteHeaders(sessionInitTs = Date.now()) {
  const uid = randomFrom("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 20);
  const oa = randomFrom("0123456789abcdef", 16);

  return async function makeHeaders(reqTs = Date.now()) {
    const uidMd5 = md5(uid);
    const rpPayload = JSON.stringify({
      emu: 0, ou: 0, it: sessionInitTs, iit: sessionInitTs, bs: 0, uid,
      isp: "", pc: 0, tm: 50, d8m: "0,0,0,0,0,0,14,7", md: "23127PN0CC",
      dn: "", osv: "16", br: 50, rpc: 0, scc: 1, plc: 1, toc: 5, tsc: 7,
      ts: reqTs, nw: 2, px: "0", ai: SAID, oa, dpc: 0, dsc: 0, qpc: 0, apad: 0,
    });

    const di = await aesCbcEncryptToBase64(uid, UK_KEY, UK_IV);
    const rp = await aesCbcEncryptToBase64(rpPayload, uidMd5.slice(0, 16), uidMd5.slice(16, 32));

    return {
      uid,
      headers: {
        version: "a_22570",
        "version-name": "1.7.2",
        channel: "xiaomi",
        "app-type": "ztv",
        "User-Agent": "ZTV/1.7.2 (23127PN0CC; Android 16; Scale/2.00)",
        said: SAID,
        di,
        token: "",
        uid: "",
        rp,
        "Accept-Encoding": "gzip",
        Connection: "Keep-Alive",
      },
    };
  };
}

export async function decodeHanjutvEncryptedPayload(payload, uid = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (typeof payload.data !== "string" || payload.data.length === 0) return payload;

  const ts = payload.ts ?? "";
  let key = typeof payload.key === "string" && payload.key ? payload.key : "";
  if (!key && uid && ts !== "") key = md5(`${uid}${ts}`);
  if (!key) throw new Error("缺少解密 key，且无法通过 uid+ts 推导");

  const mix = md5(`${key}${RESPONSE_SECRET}`);
  const aesKey = mix.slice(0, 16);
  const iv = mix.slice(16, 32);
  const plainText = await aesCbcDecryptBase64NoPadding(payload.data, aesKey, iv);
  const cleanedText = stripControlChars(plainText).trim();
  return JSON.parse(cleanedText);
}

function normalizeHanjutvEpisodeIdText(rawId = "") {
  const idText = String(rawId || "").trim();
  return idText.startsWith("hanjutv:") ? idText.slice("hanjutv:".length) : idText;
}

function encodeBase64UrlText(text = "") {
  return bytesToBase64(utf8Encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64UrlText(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return "";

  const base64 = normalized
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  return utf8Decode(base64ToBytes(base64));
}

function buildHanjutvEpisodeRef(id = "", preferTv = false) {
  const cleanId = String(id || "").trim();
  if (!cleanId) return null;

  return {
    id: cleanId,
    preferTv,
    rawId: `${preferTv ? "tv" : "hxq"}:${cleanId}`,
  };
}

function decodeMergedHanjutvEpisodeId(normalizedId = "") {
  if (!normalizedId.startsWith("merge:")) return null;

  try {
    const payloadText = decodeBase64UrlText(normalizedId.slice("merge:".length));
    const payload = JSON.parse(payloadText);
    const hxqId = String(payload?.hxq || "").trim();
    const tvId = String(payload?.tv || "").trim();

    if (!hxqId || !tvId) return null;
    return { hxqId, tvId };
  } catch (_) {
    return null;
  }
}

export function encodeMergedHanjutvEpisodeDanmuId(hxqId = "", tvId = "") {
  const cleanHxqId = String(hxqId || "").trim();
  const cleanTvId = String(tvId || "").trim();
  if (!cleanHxqId || !cleanTvId) return "";

  return `merge:${encodeBase64UrlText(JSON.stringify({
    hxq: cleanHxqId,
    tv: cleanTvId,
  }))}`;
}

export function parseHanjutvEpisodeDanmuId(rawId = "") {
  const normalizedId = normalizeHanjutvEpisodeIdText(rawId);
  if (!normalizedId) {
    return { id: "", preferTv: false, rawId: "", refs: [] };
  }

  const mergedIds = decodeMergedHanjutvEpisodeId(normalizedId);
  if (mergedIds) {
    const refs = [
      buildHanjutvEpisodeRef(mergedIds.hxqId, false),
      buildHanjutvEpisodeRef(mergedIds.tvId, true),
    ].filter(Boolean);

    return {
      id: refs[0]?.id || "",
      preferTv: false,
      rawId: normalizedId,
      refs,
    };
  }

  if (normalizedId.startsWith("tv:")) {
    const ref = buildHanjutvEpisodeRef(normalizedId.slice(3), true);
    return {
      id: ref?.id || "",
      preferTv: true,
      rawId: ref?.rawId || "",
      refs: ref ? [ref] : [],
    };
  }

  if (normalizedId.startsWith("hxq:")) {
    const ref = buildHanjutvEpisodeRef(normalizedId.slice(4), false);
    return {
      id: ref?.id || "",
      preferTv: false,
      rawId: ref?.rawId || "",
      refs: ref ? [ref] : [],
    };
  }

  const ref = buildHanjutvEpisodeRef(normalizedId, false);
  return {
    id: ref?.id || "",
    preferTv: false,
    rawId: ref?.rawId || "",
    refs: ref ? [ref] : [],
  };
}

export function getHanjutvSourceLabel(rawId = "") {
  const normalizedId = normalizeHanjutvEpisodeIdText(rawId);
  if (normalizedId.startsWith("merge:")) return "韩小圈＆极速版";
  return normalizedId.startsWith("tv:") ? "极速版" : "韩小圈";
}
