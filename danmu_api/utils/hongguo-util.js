import {
  aesCbcEncrypt, bytesToHex, bytesToBase64, hexToBytes, md5,
  pkcs7Pad, sm3Bytes, stringToUtf8Bytes,
} from "./codec-util.js";

export const COMMENT_WINDOW_MS = 30_000;
const COMMENT_IDENTITY_GOOD_ENOUGH = 100;
const COMMENT_IDENTITY_MIN_COUNT = 20;
// 一般档可达约 15.2%；18% 留出区分余量，同时避免把比例提高到 25%~30%。
const COMMENT_IDENTITY_GOOD_RATIO = 0.18;
const COMMENT_IDENTITY_SMALL_SAMPLE = 50;
export const MIN_IDENTITY_SAMPLE = 5;
const COMMENT_IDENTITY_SMALL_GOOD_RATIO = 0.50;

function randomDigits(length) {
  const bytes = randomBytes(length);
  let output = String(1 + (bytes[0] % 9));
  for (let index = 1; index < length; index++) output += String(bytes[index] % 10);
  return output;
}

function randomCdid() {
  const bytes = randomBytes(16);
  const hex = (start, count) => bytesToHex(bytes.slice(start, start + count));
  return `${hex(0, 4)}-${hex(4, 2)}-${hex(6, 2)}-${hex(8, 2)}-${hex(10, 6)}`;
}

export function createHongguoIdentity() {
  return { iid: randomDigits(16), device_id: randomDigits(16), cdid: randomCdid() };
}

export function maskHongguoIdentity(identity) {
  const iid = String((identity && identity.iid) || "");
  const did = String((identity && identity.device_id) || "");
  return `iid=${iid.slice(0, 3)}***${iid.slice(-3)} device_id=${did.slice(0, 3)}***${did.slice(-3)}`;
}

// 兼容三种后端返回值：Upstash 的 ["value"]/{result:value}、本地 Redis 的原始字符串、文件对象。
function unwrapCacheValue(raw) {
  let value = Array.isArray(raw) ? raw[0] : raw;
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "result")) {
    value = value.result;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function parseHongguoIdentity(value) {
  const parsed = unwrapCacheValue(value);
  if (parsed && typeof parsed === "object" && parsed.iid && parsed.device_id && parsed.cdid) {
    const identity = { iid: String(parsed.iid), device_id: String(parsed.device_id), cdid: String(parsed.cdid) };
    if (/^[1-9]\d{0,19}$/.test(identity.iid) && /^[1-9]\d{0,19}$/.test(identity.device_id)
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity.cdid)) return identity;
  }
  return null;
}

// 96 组随机身份、多剧复测：一般档可达 92/606，优质档常见 119~150 条。
// 声明量不是可下发上限（热门剧 149/1471 也属较高下发量），因此保留 100 条绝对达标线。
// 小样本采用更高比例，避免 6/13 之类的一般身份因百分比偏高而被提前选中。
export function isQualityDelivery(delivered, declared) {
  if (delivered >= COMMENT_IDENTITY_GOOD_ENOUGH) return true;
  if (declared > 0 && declared < COMMENT_IDENTITY_SMALL_SAMPLE) {
    return delivered >= MIN_IDENTITY_SAMPLE
      && delivered / declared >= COMMENT_IDENTITY_SMALL_GOOD_RATIO;
  }
  return declared > 0 && delivered >= COMMENT_IDENTITY_MIN_COUNT
    && delivered / declared >= COMMENT_IDENTITY_GOOD_RATIO;
}

// null、空字符串、布尔值等表示未知，不能经 Number() 转成 0 后用于跳过窗口。
export function parseDeclaredCount(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

const SIGN_KEY = hexToBytes("ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c");
const ARGUS_HEADER = hexToBytes("3ccc");
const ARGUS_PREFIX = hexToBytes("a6e783ee7001100918");
const ARGUS_SUFFIX = hexToBytes("567b");
const ARGUS_XOR_WORD = hexToBytes("d04ffdff");
const LICENSE_ID = 1611921764;
const METASEC_APP_ID = 3019;
const SDK_VERSION = 135135744;
const COUNTER_VALUE = 1388734;
const SIMON_Z = word64(0x046d678b, 0x3dc94c3a);

function concatBytes(...parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part || []));
  const output = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of arrays) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function randomBytes(length) {
  const output = new Uint8Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(output);
    return output;
  }
  for (let i = 0; i < length; i++) output[i] = Math.floor(Math.random() * 256);
  return output;
}

function reverseBytes(bytes) {
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) output[i] = bytes[bytes.length - i - 1];
  return output;
}

function getHeader(headers, name) {
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === expected && value != null) return String(value);
  }
  return "";
}

function getQueryString(url) {
  const text = String(url || "");
  const question = text.indexOf("?");
  if (question < 0) return "";
  const hash = text.indexOf("#", question);
  return text.slice(question + 1, hash < 0 ? undefined : hash);
}

function getQueryParam(url, name) {
  return getEncodedParam(getQueryString(url), name);
}

function getEncodedParam(query, name) {
  const expected = String(name);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) === expected) {
      return decodeURIComponent(separator < 0 ? "" : pair.slice(separator + 1));
    }
  }
  return null;
}

function encodeVarint(value) {
  let remaining = Number(value);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new RangeError("protobuf varint must be a safe non-negative integer");
  const output = [];
  while (remaining >= 0x80) {
    output.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  output.push(remaining);
  return new Uint8Array(output);
}

function pbVarint(field, value) {
  return concatBytes(encodeVarint(field * 8), encodeVarint(value));
}

function pbBytes(field, value) {
  const encoded = value instanceof Uint8Array ? value : stringToUtf8Bytes(String(value));
  return concatBytes(encodeVarint(field * 8 + 2), encodeVarint(encoded.length), encoded);
}

function word64(lo, hi) {
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

function xor64(...values) {
  let lo = 0;
  let hi = 0;
  for (const value of values) {
    lo ^= value.lo;
    hi ^= value.hi;
  }
  return word64(lo, hi);
}

function and64(a, b) {
  return word64(a.lo & b.lo, a.hi & b.hi);
}

function not64(value) {
  return word64(~value.lo, ~value.hi);
}

function add64(a, b) {
  const lo = (a.lo + b.lo) >>> 0;
  return word64(lo, (a.hi + b.hi + (lo < a.lo ? 1 : 0)) >>> 0);
}

function rol64(value, count) {
  const shift = ((count % 64) + 64) % 64;
  if (shift === 0) return word64(value.lo, value.hi);
  if (shift < 32) {
    return word64(
      (value.lo << shift) | (value.hi >>> (32 - shift)),
      (value.hi << shift) | (value.lo >>> (32 - shift)),
    );
  }
  if (shift === 32) return word64(value.hi, value.lo);
  const rest = shift - 32;
  return word64(
    (value.hi << rest) | (value.lo >>> (32 - rest)),
    (value.lo << rest) | (value.hi >>> (32 - rest)),
  );
}

function ror64(value, count) {
  return rol64(value, 64 - (count % 64));
}

function readWord64LE(bytes, offset = 0) {
  const lo = (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const hi = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
  return word64(lo, hi);
}

function writeWord64LE(output, offset, value) {
  for (let i = 0; i < 4; i++) {
    output[offset + i] = (value.lo >>> (i * 8)) & 0xff;
    output[offset + 4 + i] = (value.hi >>> (i * 8)) & 0xff;
  }
}

function simonZBit(index) {
  return word64(index < 32 ? (SIMON_Z.lo >>> index) & 1 : (SIMON_Z.hi >>> (index - 32)) & 1, 0);
}

function simonRoundKeys(key) {
  const words = Array.from({ length: 4 }, (_, index) => readWord64LE(key, index * 8));
  for (let index = 4; index < 72; index++) {
    let mixed = xor64(ror64(words[index - 1], 3), words[index - 3]);
    mixed = xor64(mixed, ror64(mixed, 1));
    words.push(xor64(not64(words[index - 4]), mixed, simonZBit((index - 4) % 62), word64(3, 0)));
  }
  return words;
}

function simonEncrypt(block, roundKeys) {
  let left = readWord64LE(block, 0);
  let right = readWord64LE(block, 8);
  for (const key of roundKeys) {
    const oldRight = right;
    const nonlinear = and64(rol64(right, 1), rol64(right, 8));
    right = xor64(left, nonlinear, rol64(right, 2), key);
    left = oldRight;
  }
  const output = new Uint8Array(16);
  writeWord64LE(output, 0, left);
  writeWord64LE(output, 8, right);
  return output;
}

function argusProtobuf(query, stub, timestamp, options) {
  const bodyInput = /^[0-9a-f]{32}$/i.test(stub) ? hexToBytes(stub) : new Uint8Array(16);
  const randomValue = options.argusRandom == null ? readWord32LE(randomBytes(4)) : options.argusRandom >>> 0;
  const signCount = options.argusSignCount == null ? 2 + (randomBytes(1)[0] % 49) * 2 : options.argusSignCount;
  const nested = concatBytes(
    pbVarint(1, signCount),
    pbVarint(2, COUNTER_VALUE),
    pbVarint(3, COUNTER_VALUE),
    pbVarint(4, COUNTER_VALUE),
  );
  return concatBytes(
    pbVarint(1, 0x20200929 * 2),
    pbVarint(2, 2),
    pbVarint(3, randomValue),
    pbBytes(4, METASEC_APP_ID),
    pbBytes(6, LICENSE_ID),
    pbBytes(7, "6.8.1.32"),
    pbBytes(8, "v04.07.01-ml-android"),
    pbVarint(9, SDK_VERSION),
    pbBytes(10, new Uint8Array(8)),
    pbVarint(12, timestamp * 2),
    pbBytes(13, sm3Bytes(bodyInput).slice(0, 6)),
    pbBytes(14, sm3Bytes(stringToUtf8Bytes(query)).slice(0, 6)),
    pbBytes(15, nested),
    pbBytes(20, "none"),
    pbVarint(21, 738),
  );
}

function readWord32LE(bytes) {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

export function createArgus(query, stub, timestamp, options = {}) {
  const protobuf = pkcs7Pad(argusProtobuf(query, stub, timestamp, options));
  const simonKey = sm3Bytes(concatBytes(SIGN_KEY, ARGUS_HEADER, ARGUS_SUFFIX, SIGN_KEY));
  const roundKeys = simonRoundKeys(simonKey);
  const encrypted = [];
  for (let offset = 0; offset < protobuf.length; offset += 16) {
    encrypted.push(simonEncrypt(protobuf.slice(offset, offset + 16), roundKeys));
  }

  const xorKey = concatBytes(ARGUS_XOR_WORD, ARGUS_XOR_WORD);
  const encoded = concatBytes(xorKey, ...encrypted);
  for (let index = 8; index < encoded.length; index++) encoded[index] ^= encoded[index % 8];
  const container = concatBytes(ARGUS_PREFIX, reverseBytes(encoded), ARGUS_SUFFIX);
  const key = hexToBytes(md5(SIGN_KEY.slice(0, 16)));
  const iv = hexToBytes(md5(SIGN_KEY.slice(16)));
  return bytesToBase64(concatBytes(ARGUS_HEADER, aesCbcEncrypt(container, key, iv)));
}

function ladonRoundKeys(randomPrefix, aid) {
  const asciiDigest = stringToUtf8Bytes(md5(concatBytes(randomPrefix, stringToUtf8Bytes(String(aid)))));
  const table = new Uint8Array(288);
  table.set(asciiDigest);
  const queue = Array.from({ length: 4 }, (_, index) => readWord64LE(table, index * 8));
  let left = queue.shift();
  let right = queue.shift();
  for (let index = 0; index < 0x22; index++) {
    const mixed = xor64(add64(ror64(right, 8), left), word64(index, 0));
    queue.push(mixed);
    left = xor64(mixed, ror64(left, 61));
    writeWord64LE(table, (index + 1) * 8, left);
    right = queue.shift();
  }
  return Array.from({ length: 0x22 }, (_, index) => readWord64LE(table, index * 8));
}

function ladonEncryptBlock(block, roundKeys) {
  let left = readWord64LE(block, 0);
  let right = readWord64LE(block, 8);
  for (const key of roundKeys) {
    right = xor64(key, add64(left, ror64(right, 8)));
    left = xor64(right, ror64(left, 61));
  }
  const output = new Uint8Array(16);
  writeWord64LE(output, 0, left);
  writeWord64LE(output, 8, right);
  return output;
}

export function createLadon(timestamp, aid, options = {}) {
  const randomPrefix = options.ladonRandom == null
    ? randomBytes(4)
    : new Uint8Array(options.ladonRandom);
  if (randomPrefix.length !== 4) throw new RangeError("ladonRandom must be four bytes");
  const data = stringToUtf8Bytes(`${timestamp}-${LICENSE_ID}-${METASEC_APP_ID}`);
  const paddedSize = Math.ceil(data.length / 16) * 16;
  const padded = new Uint8Array(paddedSize);
  padded.set(data);
  const padding = 16 - (data.length % 16);
  if (data.length + padding <= paddedSize) padded.fill(padding, data.length);
  const roundKeys = ladonRoundKeys(randomPrefix, aid);
  const ciphertext = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    ciphertext.push(ladonEncryptBlock(padded.slice(offset, offset + 16), roundKeys));
  }
  return bytesToBase64(concatBytes(randomPrefix, ...ciphertext));
}

function md5Prefix(value) {
  const bytes = value instanceof Uint8Array ? value : stringToUtf8Bytes(String(value));
  return hexToBytes(md5(bytes)).slice(0, 4);
}

export function buildGorgonSeed(url, { headers = {}, body = null, khronos } = {}) {
  if (!Number.isInteger(khronos) || khronos < 0 || khronos > 0xffffffff) {
    throw new RangeError("khronos must be an unsigned 32-bit integer");
  }
  const stub = getHeader(headers, "x-ss-stub").trim();
  let bodyPrefix = new Uint8Array(4);
  if (/^[0-9a-f]{32}$/i.test(stub)) bodyPrefix = hexToBytes(stub.slice(0, 8));
  else if (body != null) {
    const bodyBytes = body instanceof Uint8Array ? body : stringToUtf8Bytes(String(body));
    if (bodyBytes.length > 0) bodyPrefix = md5Prefix(bodyBytes);
  }
  const cookie = getHeader(headers, "cookie");
  const timestamp = new Uint8Array([
    (khronos >>> 24) & 0xff,
    (khronos >>> 16) & 0xff,
    (khronos >>> 8) & 0xff,
    khronos & 0xff,
  ]);
  return concatBytes(
    md5Prefix(getQueryString(url)),
    bodyPrefix,
    cookie ? md5Prefix(cookie) : new Uint8Array(4),
    new Uint8Array([0x00, 0x01, 0x07, 0x04]),
    timestamp,
  );
}

function reverseBits(value) {
  let result = ((value << 1) & 0xaa) | ((value >>> 1) & 0x55);
  result = ((result << 2) & 0xcc) | ((result >>> 2) & 0x33);
  return ((result << 4) | (result >>> 4)) & 0xff;
}

export function transformGorgonSeed(seed, { headerByte2, headerByte3, parameter = 0 } = {}) {
  const input = seed instanceof Uint8Array ? seed : new Uint8Array(seed || []);
  if (input.length !== 20) throw new TypeError("seed must contain 20 bytes");
  const key = new Uint8Array([0x4a, parameter & 0xff, 0x16, headerByte3, 0x47, 0x6c, parameter >>> 8, headerByte2]);
  const sbox = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + sbox[i] + key[i & 7]) & 0xff;
    sbox[i] = sbox[j];
  }
  const payload = new Uint8Array(input);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < payload.length; offset++) {
    i = (i + 1) & 0xff;
    j = (j + sbox[i]) & 0xff;
    sbox[i] = sbox[j];
    payload[offset] ^= sbox[(sbox[i] + sbox[j]) & 0xff];
  }
  const lengthMask = (~payload.length) & 0xff;
  for (let offset = 0; offset < payload.length; offset++) {
    const swappedNibbles = ((payload[offset] << 4) | (payload[offset] >>> 4)) & 0xff;
    payload[offset] = reverseBits(swappedNibbles ^ payload[(offset + 1) % payload.length]) ^ lengthMask;
  }
  return concatBytes(new Uint8Array([0x84, 0x04, headerByte2, headerByte3, parameter & 0xff, parameter >>> 8]), payload);
}

export function signHongguoRequest(url, options = {}) {
  const timestamp = options.timestamp == null
    ? (options.khronos == null ? Math.floor(Date.now() / 1000) : options.khronos)
    : options.timestamp;
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
    throw new RangeError("timestamp must be an unsigned 32-bit integer");
  }
  const aid = parseInt(getQueryParam(url, "aid"), 10);
  if (!Number.isSafeInteger(aid)) throw new TypeError("signed URL must contain a numeric aid parameter");
  const random = randomBytes(2);
  const headerByte2 = options.headerByte2 == null ? ((random[0] % 7) + 1) << 5 : options.headerByte2;
  const headerByte3 = options.headerByte3 == null ? 0xe0 | (random[1] & 0x0f) : options.headerByte3;
  const headers = options.headers || {};
  const seed = buildGorgonSeed(url, { headers, body: options.body, khronos: timestamp });
  return {
    "X-Argus": createArgus(getQueryString(url), getHeader(headers, "x-ss-stub").trim(), timestamp, options),
    "X-Gorgon": bytesToHex(transformGorgonSeed(seed, { headerByte2, headerByte3, parameter: options.parameter || 0 })),
    "X-Khronos": String(timestamp),
    "X-Ladon": createLadon(timestamp, aid, options),
  };
}

export function createHongguoEpisodeId(seriesId, vid, durationSeconds) {
  return `hongguo:v1:${encodeURIComponent(String(seriesId))}:${encodeURIComponent(String(vid))}:${Math.max(0, Math.trunc(Number(durationSeconds) || 0))}`;
}

export function createHongguoSeriesId(seriesId) {
  return `hongguo:series:v1:${encodeURIComponent(String(seriesId))}`;
}

export function parseHongguoSeriesId(value) {
  const rawValue = String(value || "").split("#", 1)[0];
  const match = rawValue.match(/^hongguo:series:v1:([^:]+)$/);
  if (!match) throw new Error("无效的红果全集 ID");
  return { seriesId: decodeURIComponent(match[1]) };
}

export function isHongguoSeriesId(value) {
  try {
    parseHongguoSeriesId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseHongguoEpisodeId(value) {
  const rawValue = String(value || "").split("#", 1)[0];
  const match = rawValue.match(/^hongguo:v1:([^:]+):([^:]+):(\d+)$/);
  if (!match) throw new Error("无效的红果剧集 ID");
  return {
    seriesId: decodeURIComponent(match[1]),
    vid: decodeURIComponent(match[2]),
    duration: Number(match[3]),
  };
}

export function parseHongguoPlayerUrl(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/@%?-?\d+(?:\.\d+)?$/, "");
  if (normalized.split("#", 1)[0].startsWith("hongguo:v1:")) {
    const info = parseHongguoEpisodeId(normalized);
    return { seriesId: info.seriesId, vid: info.vid };
  }
  const match = normalized.match(
    /^https?:\/\/(?:www\.)?hongguoduanju\.com(?::\d+)?\/player\/(\d+)\/(\d+)\/?(?:\?[^#]*)?(?:#.*)?$/i,
  );
  if (!match) throw new Error("无效的红果短剧播放链接");
  return { seriesId: match[1], vid: match[2] };
}

export function isHongguoPlayerUrl(value) {
  try {
    parseHongguoPlayerUrl(value);
    return true;
  } catch {
    // 全集也属于红果链接，避免上层剥掉来源前缀。
    return isHongguoSeriesId(value);
  }
}

function parseEmbeddedJson(html, key, opening) {
  const marker = `"${key}":`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== opening) return null;
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = i;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === opening) depth++;
    else if (ch === closing && --depth === 0) break;
  }
  try { return JSON.parse(html.slice(i, end + 1)); } catch { return null; }
}

export function parseWebSearchResults(html) {
  return (parseEmbeddedJson(html, "searchList", "[") || []).map(parseWebSearchItem).filter(Boolean);
}

export function parseSearchSuggestions(payload) {
  const rows = payload.suggest_list || payload.data?.suggest_list;
  if (!Array.isArray(rows)) throw new Error("联想接口未返回有效剧目列表");
  return rows.filter(item => item?.word_type === "short_play_name").map(parseWebSearchItem).filter(Boolean);
}

export function parseHongguoResponse(response) {
  const status = response?.status == null ? "未知 HTTP 状态" : `HTTP ${response.status}`;
  if (!response || !("data" in response)) throw new Error(`无效响应 (${status})`);
  const statusCode = response.status == null ? null : Number(response.status);
  if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) throw new Error(`接口返回 ${status}`);

  let payload = response.data;
  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) throw new Error(`接口返回空响应 (${status})`);
    try {
      payload = JSON.parse(text);
      if (!payload || typeof payload !== "object") throw new Error("JSON 根节点不是对象");
    } catch (error) {
      throw new Error(`接口返回无效 JSON (${status}): ${error.message}`);
    }
  }
  if (!payload || typeof payload !== "object") throw new Error(`无效响应 (${status})`);
  if (payload.code == null || payload.code === 0) return payload;

  const message = String(payload.message || payload.msg || "未知错误");
  const normalizedMessage = message.toLowerCase();
  if ([401, 403, 8, 1001].includes(Number(payload.code)) ||
      ["token", "login", "登录", "未登录", "expire"].some(word => normalizedMessage.includes(word))) {
    throw new Error(`鉴权失败 code=${payload.code}: ${message}`);
  }
  let coolDownMs = 0;
  try {
    const detail = JSON.parse(message);
    coolDownMs = Math.max(0, Number(detail?.min_ban_time) || Number(detail?.max_ban_time) || 0) * 1000;
  } catch { /* 普通错误消息没有冷却数据 */ }
  if (coolDownMs > 0) {
    const error = new Error(`风控冷却: 需暂停 ${Math.round(coolDownMs / 1000)}s (code=${payload.code})`);
    error.coolDownMs = coolDownMs;
    throw error;
  }
  throw new Error(`风控或平台异常 code=${payload.code}: ${message}`);
}

function parseWebSearchItem(item) {
  if (!item || typeof item !== "object") return null;
  const data = item.video_data || {};
  // 联想接口的 series_id 是 19 位 JSON 数字；优先取完整字符串，拒绝已丢精度的数值 ID。
  const id = [data.series_id_str, item.keyword, data.series_id].find((value) =>
    typeof value === "string" ? /^[1-9]\d{0,31}$/.test(value)
      : Number.isSafeInteger(value) && value > 0);
  const name = String(data.series_name || data.series_title || item.name || "").trim();
  const episodeCount = Number(data.episode_cnt);
  if (id == null || !name || !Number.isSafeInteger(episodeCount) || episodeCount <= 0) return null;
  return {
    seriesId: String(id), name, episodeCount, score: "",
    year: extractYearFromTimestamp(data.create_time), imageUrl: extractImageUrl(data.series_cover),
  };
}

export function positiveDuration(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function parseApiEpisodeDetails(payload, seriesId) {
  const data = payload?.data || {};
  const videoData = (data[String(seriesId)] || data).video_data || {};
  const episodes = (videoData.video_list || []).map(item => ({
    index: Number(item.vid_index) || 0,
    vid: String(item.vid || ""),
    title: String(item.episode_title || "").trim().slice(0, 30),
    duration: positiveDuration(item.duration),
    commentCount: Math.max(0, Number(item.comment_count) || 0),
    imageUrl: extractImageUrl(item.episode_cover || item.cover),
  })).filter(item => item.vid).sort((a, b) => a.index - b.index);
  if (!episodes.length) return null;
  return {
    episodes,
    year: extractYearFromTimestamp(videoData.create_time, videoData.first_visible_time),
    imageUrl: extractImageUrl(videoData.series_cover) || episodes.find(episode => episode.imageUrl)?.imageUrl || "",
  };
}

export function parseWebEpisodeDetails(html) {
  const detail = parseEmbeddedJson(html, "seriesDetail", "{");
  if (!Array.isArray(detail?.vid_list) || !detail.vid_list.length) return null;
  const episodes = detail.vid_list.map((item, index) => {
    const value = item && typeof item === "object" ? item : {};
    const vid = typeof item === "object" ? (value.vid || value.video_id || value.id) : item;
    if (!vid) return null;
    return {
      index: index + 1,
      vid: String(vid),
      title: String(value.episode_title || value.title || `第${index + 1}集`).trim().slice(0, 30),
      duration: positiveDuration(value.duration) || positiveDuration(value.video_duration),
      commentCount: Math.max(0, Number(value.comment_count) || 0),
      imageUrl: extractImageUrl(value.episode_cover || value.cover),
    };
  }).filter(Boolean);
  return {
    episodes,
    year: extractYearFromTimestamp(detail.create_time, detail.first_visible_time),
    imageUrl: extractImageUrl(detail.series_cover),
  };
}

export function parseWebPlayerDuration(html, info) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[1])) continue;
    try {
      const nodes = [JSON.parse(match[2])];
      while (nodes.length) {
        const node = nodes.pop();
        if (!node || typeof node !== "object") continue;
        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (types.includes("VideoObject")) {
          let matchesEpisode = false;
          for (const url of [node.url, node["@id"]]) {
            try {
              const player = parseHongguoPlayerUrl(url);
              if (player.seriesId === String(info.seriesId) && player.vid === String(info.vid)) matchesEpisode = true;
            } catch { /* 忽略其他集或非播放链接 */ }
          }
          const duration = String(node.duration || "").match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
          if (matchesEpisode && duration) {
            const seconds = positiveDuration(Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0));
            if (seconds) return seconds;
          }
        }
        for (const value of Object.values(node)) if (value && typeof value === "object") nodes.push(value);
      }
    } catch { /* 某个结构化数据块无效时继续查找 */ }
  }
  return 0;
}

function extractImageUrl(value) {
  if (typeof value === "string") {
    const url = value.trim();
    return url.startsWith("//") ? `https:${url}` : url;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImageUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["url", "main_url", "download_url", "url_list", "urlList", "urls"]) {
    const url = extractImageUrl(value[key]);
    if (url) return url;
  }
  return "";
}

function extractYearFromTimestamp(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000;
    const year = new Date(milliseconds).getUTCFullYear();
    if (year >= 1900 && year <= 2100) return year;
  }
  return null;
}

export function parseSearchCell(cell) {
  const seriesId = cell && (cell.book_id || cell.search_result_id);
  if (!seriesId) return null;
  const detail = cell.video_detail || {};
  let videoData = cell.video_data;
  if (Array.isArray(videoData)) videoData = videoData[0] || {};
  if (!videoData || typeof videoData !== "object") videoData = {};
  const inner = videoData.video_detail || {};
  const albumInfo = videoData.album_info || inner.album_info || detail.album_info || {};
  const episodeCount = detail.episode_cnt || videoData.episode_cnt || inner.episode_cnt || albumInfo.episode_cnt || 0;
  if (!episodeCount) return null;
  const highlighted = cell.search_high_light && cell.search_high_light.title && cell.search_high_light.title.text;
  const title = String(highlighted || detail.series_title || videoData.title || inner.series_title || albumInfo.title || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  if (!title) return null;
  return {
    seriesId: String(seriesId),
    name: title,
    episodeCount: Number(episodeCount) || 0,
    score: videoData.score || inner.score || albumInfo.score || "",
    year: extractYearFromTimestamp(
      albumInfo.create_time,
      inner.create_time,
      videoData.create_time,
      detail.create_time,
      cell.create_time,
    ),
    imageUrl: extractImageUrl(
      inner.series_cover || videoData.cover || detail.series_cover || albumInfo.cover || cell.series_cover || cell.cover,
    ),
  };
}

function parseDanmuResponse(payload) {
  const output = [];
  const data = payload && payload.data;
  for (const item of (data && data.data_list) || []) {
    const comment = item.comment || {};
    const common = comment.common || {};
    const content = common.content || {};
    const expand = comment.expand || {};
    const text = String(content.text || "").trim();
    const offsetMs = Number(expand.offset_time);
    if (!text || !Number.isFinite(offsetMs)) continue;
    output.push({
      commentId: String(comment.comment_id || ""),
      offsetMs: Math.max(0, Math.trunc(offsetMs)),
      text,
      diggCount: Math.max(0, Math.trunc(Number((comment.stat || {}).digg_count) || 0)),
    });
  }
  return output;
}

export function dedupeDanmus(items) {
  const seen = new Map();
  for (const item of items) {
    const key = item.commentId ? `id:${item.commentId}` : `anonymous:${item.offsetMs}:${item.text}`;
    seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => a.offsetMs - b.offsetMs || a.commentId.localeCompare(b.commentId) || a.text.localeCompare(b.text));
}

export function parseCommentWindow(payload, startMs) {
  const data = payload.data || {};
  const listInfo = data.common_list_info || {};
  const extra = data.extra || {};
  let nextStart = Number(extra.next_query_danmaku_list_time);
  if (!Number.isFinite(nextStart) || nextStart <= startMs) nextStart = startMs + COMMENT_WINDOW_MS;
  // 解析服务端声明数据：当前窗口条数、整集窗口计数表与总数（用于优质档判定与空窗口跳过）
  let declaredWindowComments = 0;
  let declaredWindows = null;
  let declaredTotal = null;
  try {
    const cursorInfo = JSON.parse(String(listInfo.cursor || ""));
    const windowCounts = cursorInfo && cursorInfo.danmaku_window_count;
    if (windowCounts && typeof windowCounts === "object" && !Array.isArray(windowCounts)) {
      declaredWindows = Object.create(null);
      for (const [start, rawCount] of Object.entries(windowCounts)) {
        const count = parseDeclaredCount(rawCount);
        if (parseDeclaredCount(start) !== null && count !== null) declaredWindows[start] = count;
      }
      // 接口有时一次覆盖两个 30 秒窗口（例如 nextStart=60000），分母也必须覆盖同一范围。
      const starts = Object.keys(declaredWindows).map(Number)
        .filter(start => start >= startMs && start < nextStart && (start - startMs) % COMMENT_WINDOW_MS === 0);
      const expectedWindows = Math.ceil((nextStart - startMs) / COMMENT_WINDOW_MS);
      if (starts.length === expectedWindows) {
        declaredWindowComments = starts.reduce((total, start) => total + declaredWindows[String(start)], 0);
      }
    }
    declaredTotal = parseDeclaredCount(cursorInfo && cursorInfo.danmaku_count);
  } catch {
    // cursor 非 JSON（或无窗口计数）时按“无声明数据”处理
}
return {
  comments: parseDanmuResponse(payload),
  nextStart,
  cursor: String(listInfo.cursor || ""),
  hasMore: Boolean(listInfo.has_more),
  declaredWindowComments,
  declaredWindows,
  declaredTotal,
};
}

export function getFragmentNumber(value, name) {
  const text = String(value || "");
  const hashIndex = text.indexOf("#");
  if (hashIndex < 0) return null;
  const raw = getEncodedParam(text.slice(hashIndex + 1), name);
  if (raw === null) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}
