import BaseSource from "./base.js";
import { globals } from "../configs/globals.js";
import { log } from "../utils/log-util.js";
import { httpGet, httpPost, buildQueryString } from "../utils/http-util.js";
import {
  aesCbcEncrypt,
  bytesToHex,
  bytesToBase64,
  convertToAsciiSum,
  hexToBytes,
  md5,
  pkcs7Pad,
  sm3Bytes,
  stringToUtf8Bytes,
} from "../utils/codec-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from "../models/dandan-model.js";

const CLIENT_CONFIG = {
  apiHosts: Object.freeze([
    "api5-normal-sinfonlinea.fqnovel.com",
    "api5-normal-sinfonlinec.fqnovel.com",
    "api5-normal-lf.fqnovel.com",
    "api5-normal-lq.fqnovel.com",
    "api5-normal-sinfonlineb.fqnovel.com",
    "api5-normal-hl.fqnovel.com",
  ]),
  baseQuery: {
    iid: "4439167111854618",
    device_id: "4439167111850522",
    channel: "huawei_8662_64",
    device_type: "V2284A",
    cdid: "6100e9f9-a1a0-4f65-ab47-94f5b41b8efb",
    aid: "8662",
    app_name: "novelread",
    version_code: "72932",
    version_name: "7.2.9.32",
    device_platform: "android",
    ac: "wifi",
    os: "android",
    ssmix: "a",
    device_brand: "vivo",
    language: "zh",
    os_api: "32",
    os_version: "12",
    manifest_version_code: "72932",
    resolution: "1080*1920",
    dpi: "280",
    update_version_code: "72932",
    host_abi: "arm64-v8a",
    dragon_device_type: "phone",
    pv_player: "72932",
    compliance_status: "0",
    need_personal_recommend: "1",
    player_so_load: "1",
    is_android_pad_screen: "1",
    rom_version: "V417IR+release-keys",
  },
  sessionHeaders: {
    cookie: "",
    "x-tt-token": "",
    "user-agent": "com.phoenix.read/72932 (Linux; U; Android 12; zh_CN; V2284A; Build/V417IR;tt-ok/3.12.13.20)",
    "x-tt-store-region": "cn-zj",
    "x-tt-store-region-src": "did",
    "passport-sdk-version": "5051452",
    "sdk-version": "2",
  },
};

const WEB_ORIGIN = "https://hongguoduanju.com";

function parseWebSearchResults(html) {
  const marker = '"searchList":';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "[") return [];
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
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  try { return JSON.parse(html.slice(i, end + 1)); } catch { return []; }
}

function parseWebSeriesDetail(html) {
  const marker = '"seriesDetail":';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = i;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  try { return JSON.parse(html.slice(i, end + 1)); } catch { return null; }
}

const COMMENT_SOURCE = 601;
const SERVER_CHANNEL = 1000;
const COMMENT_WINDOW_MS = 30_000;
const COMMENT_COUNT = 90;
const COMMENT_CONCURRENCY = 3;
// 弹幕请求的最小节流间隔（毫秒），随机抖动避免固定节律被平台识别
const COMMENT_THROTTLE_MS = 180;
const COMMENT_THROTTLE_JITTER_MS = 240;
const MAX_SEARCH_ITEMS = 20;
const IMAGE_SHRINK =
  "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1h\n" +
  "Z2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d\n";

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
  const expected = String(name);
  for (const pair of getQueryString(url).split("&")) {
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
    return false;
  }
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

function parseSearchCell(cell) {
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

function dedupeDanmus(items) {
  const seen = new Map();
  for (const item of items) {
    const key = item.commentId ? `id:${item.commentId}` : `anonymous:${item.offsetMs}:${item.text}`;
    seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => a.offsetMs - b.offsetMs || a.commentId.localeCompare(b.commentId) || a.text.localeCompare(b.text));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function getFragmentNumber(value, name) {
  const hashIndex = String(value || "").indexOf("#");
  if (hashIndex < 0) return null;
  const expected = String(name);
  const fragment = String(value).slice(hashIndex + 1);
  for (const pair of fragment.split("&")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) !== expected) continue;
    const number = Number(decodeURIComponent(separator < 0 ? "" : pair.slice(separator + 1)));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export default class HongguoSource extends BaseSource {
  constructor() {
    super();
    this.preferredApiHost = CLIENT_CONFIG.apiHosts[0];
    this.nextRequestAt = 0;
    this.playerEpisodeResolutions = new Map();
    this.activeCommentRequests = 0;
    this.commentRequestWaiters = [];
    this.lastDanmu = [];
    this.durationCache = new Map();
    this.pendingEpisodeDanmu = new Map();
  }

  buildUrl(path, extraQuery = {}, apiHost = this.preferredApiHost) {
    const query = { ...CLIENT_CONFIG.baseQuery, ...extraQuery, _rticket: String(Date.now()) };
    return `https://${apiHost || CLIENT_CONFIG.apiHosts[0]}${path}?${buildQueryString(query)}`;
  }

  getApiHosts() {
    const preferred = this.preferredApiHost;
    if (!preferred || !CLIENT_CONFIG.apiHosts.includes(preferred)) return [...CLIENT_CONFIG.apiHosts];
    return [preferred, ...CLIENT_CONFIG.apiHosts.filter((host) => host !== preferred)];
  }

  parseApiResponse(response) {
    const status = response && response.status != null ? `HTTP ${response.status}` : "未知 HTTP 状态";
    if (!response || !("data" in response)) throw new Error(`无效响应 (${status})`);
    const statusCode = response.status == null ? null : Number(response.status);
    if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
      throw new Error(`接口返回 ${status}`);
    }
    if (typeof response.data !== "string") {
      if (!response.data || typeof response.data !== "object") throw new Error(`无效响应 (${status})`);
      return response.data;
    }

    const text = response.data.trim();
    if (!text) throw new Error(`接口返回空响应 (${status})`);
    try {
      const result = JSON.parse(text);
      if (!result || typeof result !== "object") throw new Error("JSON 根节点不是对象");
      return result;
    } catch (error) {
      throw new Error(`接口返回无效 JSON (${status}): ${error.message}`);
    }
  }

  async throttle(baseMs = 600, jitterMs = 401) {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduled + baseMs + Math.floor(Math.random() * jitterMs);
    if (scheduled > now) await sleep(scheduled - now);
  }

  checkResponse(payload) {
    if (!payload || typeof payload !== "object") throw new Error("平台返回了无效响应");
    const code = payload.code;
    if (code == null || code === 0) return;
    const message = String(payload.message || payload.msg || "未知错误");
    const normalizedMessage = message.toLowerCase();
    const authFailed = [401, 403, 8, 1001].includes(Number(code)) ||
      ["token", "login", "登录", "未登录", "expire"].some((word) => normalizedMessage.includes(word));
    if (authFailed) throw new Error(`鉴权失败 code=${code}: ${message}`);
    // 频控冷却指令：服务端以 JSON 返回 {"min_ban_time": 3, "max_ban_time": 5, "ban_rate": 0}
    let coolDownMs = 0;
    try {
      const detail = JSON.parse(message);
      if (detail && typeof detail === "object") {
        coolDownMs = Math.max(0, Number(detail.min_ban_time) || Number(detail.max_ban_time) || 0) * 1000;
      }
    } catch { /* message 不是 JSON 时忽略 */ }
    if (coolDownMs > 0) {
      const error = new Error(`风控冷却: 需暂停 ${Math.round(coolDownMs / 1000)}s (code=${code})`);
      error.coolDownMs = coolDownMs;
      return error;
    }
    throw new Error(`风控或平台异常 code=${code}: ${message}`);
  }

  async request(method, path, { body = null, extraQuery = {}, comment = false } = {}) {
    const apiHosts = this.getApiHosts();
    const failures = [];
    const payload = body == null ? null : JSON.stringify(body);
    for (let index = 0; index < apiHosts.length; index++) {
      const apiHost = apiHosts[index];
      // 风控冷却是按设备身份生效的（与具体主机无关），在主机内做有限次退避重试，之后再切换线路
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const url = this.buildUrl(path, extraQuery, apiHost);
          const headers = {};
          for (const [key, value] of Object.entries(CLIENT_CONFIG.sessionHeaders)) {
            if (value) headers[key] = String(value);
          }
          headers["content-type"] = "application/json; charset=utf-8";
          if (comment) {
            headers["comment-source"] = String(COMMENT_SOURCE);
            headers["server-channel"] = String(SERVER_CHANNEL);
            headers["x-ss-stub"] = "";
          } else if (payload != null) {
            headers["x-ss-stub"] = md5(stringToUtf8Bytes(payload)).toUpperCase();
          }
          Object.assign(headers, signHongguoRequest(url, { headers }));
          const releaseCommentSlot = comment ? await this.acquireCommentSlot() : null;
          // 弹幕请求同样需要节流，避免分页/整剧连发触发风控
          if (comment) await this.throttle(COMMENT_THROTTLE_MS, COMMENT_THROTTLE_JITTER_MS);
          else await this.throttle();
          let response;
          try {
            response = method === "GET"
              ? await httpGet(url, { headers, timeout: 30000 })
              : await httpPost(url, payload, { headers, timeout: 30000 });
          } finally {
            if (releaseCommentSlot) releaseCommentSlot();
          }
          const result = this.parseApiResponse(response);
          const responseError = this.checkResponse(result);
          if (responseError) throw responseError;
          this.preferredApiHost = apiHost;
          return result;
        } catch (error) {
          if (error && error.coolDownMs) {
            // 遵守服务端给出的冷却时间并稍作随机，退避后重试当前主机
            log("warn", `[Hongguo] ${apiHost} 触发风控冷却 ${Math.round(error.coolDownMs / 1000)}s，退避后重试`);
            await sleep(error.coolDownMs + Math.floor(Math.random() * 1000));
            if (attempt < maxAttempts - 1) continue;
          }
          const message = error && error.message ? error.message : String(error);
          failures.push({ host: apiHost, message });
          const nextApiHost = apiHosts[index + 1];
          if (nextApiHost) {
            log("warn", `[Hongguo] ${apiHost} 请求失败，切换到 ${nextApiHost}: ${message}`);
          }
          break;
        }
      }
    }
    const details = failures.map(({ host, message }) => `${host}: ${message}`).join(" | ");
    const requestError = new Error(`红果请求失败，${apiHosts.length} 条线路均不可用: ${details}`);
    requestError.name = "HongguoHostError";
    requestError.failures = failures;
    throw requestError;
  }

  async search(keyword) {
    try {
      const response = await httpGet(`${WEB_ORIGIN}/search/${encodeURIComponent(keyword)}`, { headers: { accept: "text/html" }, timeout: 30000 });
      const items = parseWebSearchResults(typeof response.data === "string" ? response.data : "");
      if (items.length) return items.map((item) => {
        const data = item.video_data || {};
        return { seriesId: String(data.series_id || item.keyword || ""), name: String(data.series_name || data.series_title || item.name || ""), episodeCount: Number(data.episode_cnt) || 0, score: "", year: extractYearFromTimestamp(data.create_time), imageUrl: extractImageUrl(data.series_cover) };
      }).filter((item) => item.seriesId && item.name && item.episodeCount > 0).slice(0, MAX_SEARCH_ITEMS);
    } catch (error) { log("warn", `[Hongguo] web search unavailable: ${error.message}`); }
    try {
      const results = [];
      const seen = new Set();
      let offset = 0;
      let passback = "";
      let searchId = "";
      for (let page = 0; page < 12 && results.length < MAX_SEARCH_ITEMS; page++) {
        const params = {
          query: keyword,
          tab_name: "feed",
          search_source: "1",
          offset: String(offset),
          count: "0",
          use_correct: "true",
        };
        if (passback) params.passback = passback;
        if (searchId) params.search_id = searchId;
        const payload = await this.request("GET", "/reading/bookapi/search/tab/v", { extraQuery: params });
        const tabs = payload.search_tabs || [];
        if (!tabs.length) break;
        const tab = tabs[0];
        const data = tab.data || [];
        for (const cell of data) {
          const item = parseSearchCell(cell);
          if (!item || seen.has(item.seriesId)) continue;
          seen.add(item.seriesId);
          results.push(item);
          if (results.length >= MAX_SEARCH_ITEMS) break;
        }
        offset = tab.next_offset == null ? offset : tab.next_offset;
        passback = tab.passback || passback;
        searchId = tab.search_id || searchId;
        if (!tab.has_more || !data.length) break;
      }
      log("info", `[Hongguo] 搜索找到 ${results.length} 个结果`);
      return results;
    } catch (error) {
      log("error", `[Hongguo] 搜索失败: ${error.message}`);
      return [];
    }
  }

  async getEpisodes(seriesId) {
    const body = {
      biz_param: {
        detail_page_version: 0,
        disable_digg_stat: false,
        disable_video_relate_book: false,
        image_shrink_datas_str: IMAGE_SHRINK,
        need_all_video_definition: false,
        need_mp4_align: false,
        screen_width_px: "900",
        source: 7,
        use_os_player: false,
        use_server_dns: false,
      },
      series_id: String(seriesId),
    };

    const parseApiEpisodes = (payload) => {
      const responseData = payload && payload.data || {};
      const entry = responseData[String(seriesId)] || responseData;
      const videoData = entry && entry.video_data || {};
      const episodes = (videoData.video_list || []).map((item) => ({
        index: Number(item.vid_index) || 0,
        vid: String(item.vid || ""),
        title: String(item.episode_title || "").trim().slice(0, 30),
        duration: Math.max(0, Number(item.duration) || 0),
        commentCount: Math.max(0, Number(item.comment_count) || 0),
        imageUrl: extractImageUrl(item.episode_cover || item.cover),
      })).filter((item) => item.vid).sort((a, b) => a.index - b.index);
      if (!episodes.length) return null;
      return {
        episodes,
        year: extractYearFromTimestamp(videoData.create_time),
        imageUrl: extractImageUrl(videoData.series_cover) ||
          (episodes.find((episode) => episode.imageUrl) || {}).imageUrl ||
          "",
      };
    };

    try {
      const apiResult = parseApiEpisodes(await this.request("POST", "/novel/player/multi_video_detail/v1/", { body }));
      if (apiResult) return apiResult;
      log("warn", `[Hongguo] API detail returned no episodes for series ${seriesId}, falling back to web detail`);
    } catch (error) {
      log("warn", `[Hongguo] API detail unavailable: ${error.message}, falling back to web detail`);
    }

    try {
      const response = await httpGet(`${WEB_ORIGIN}/detail?series_id=${encodeURIComponent(seriesId)}`, { headers: { accept: "text/html" }, timeout: 30000 });
      const detail = parseWebSeriesDetail(typeof response.data === "string" ? response.data : "");
      if (detail && Array.isArray(detail.vid_list) && detail.vid_list.length) {
        return {
          episodes: detail.vid_list.map((item, index) => {
            const value = item && typeof item === "object" ? item : {};
            const vid = typeof item === "object"
              ? (value.vid || value.video_id || value.id || "")
              : item;
            if (!vid) return null;
            return {
              index: index + 1,
              vid: String(vid),
              title: String(value.episode_title || value.title || `第${index + 1}集`).trim().slice(0, 30),
              duration: Math.max(0, Number(value.duration || value.video_duration) || 0),
              commentCount: Math.max(0, Number(value.comment_count) || 0),
              imageUrl: extractImageUrl(value.episode_cover || value.cover),
            };
          }).filter(Boolean),
          year: extractYearFromTimestamp(detail.create_time),
          imageUrl: extractImageUrl(detail.series_cover),
        };
      }
    } catch (error) { log("warn", `[Hongguo] web detail unavailable: ${error.message}`); }
    return { episodes: [], year: null, imageUrl: "" };
  }

  async resolveEpisodeInfo(value) {
    let raw = typeof value === "object" && value !== null
      ? String(value.url || value.id || value.value || "")
      : String(value || "");
    raw = raw.trim();
    const embedded = raw.match(/hongguo:v1:[^\s#]+:[^\s#]+:\d+/);
    if (embedded) {
      try { return parseHongguoEpisodeId(embedded[0]); } catch { /* continue */ }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (raw.split("#", 1)[0].startsWith("hongguo:v1:")) return parseHongguoEpisodeId(raw);
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch { break; }
    }

    const player = parseHongguoPlayerUrl(raw);
    const cacheKey = `${player.seriesId}:${player.vid}`;
    let resolution = this.playerEpisodeResolutions.get(cacheKey);
    if (!resolution) {
      resolution = (async () => {
        const details = await this.getEpisodes(player.seriesId);
        const episode = details.episodes.find((item) => item.vid === player.vid);
        if (!episode) {
          throw new Error(`播放链接中的 vid ${player.vid} 不属于剧集 ${player.seriesId}`);
        }
        return {
          seriesId: player.seriesId,
          vid: player.vid,
          duration: episode.duration,
        };
      })();
      this.playerEpisodeResolutions.set(cacheKey, resolution);
    }

    try {
      return await resolution;
    } catch (error) {
      if (this.playerEpisodeResolutions.get(cacheKey) === resolution) {
        this.playerEpisodeResolutions.delete(cacheKey);
      }
      throw error;
    }
  }

  createCommentSlotRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.commentRequestWaiters.shift();
      if (next) {
        next(this.createCommentSlotRelease());
      } else {
        this.activeCommentRequests--;
      }
    };
  }

  async acquireCommentSlot() {
    if (this.activeCommentRequests < COMMENT_CONCURRENCY) {
      this.activeCommentRequests++;
      return this.createCommentSlotRelease();
    }
    return new Promise((resolve) => this.commentRequestWaiters.push(resolve));
  }

  resolveSeriesId(value) {
    if (isHongguoSeriesId(value)) return parseHongguoSeriesId(value).seriesId;
    if (String(value || "").split("#", 1)[0].startsWith("hongguo:v1:")) {
      return parseHongguoEpisodeId(value).seriesId;
    }
    return parseHongguoPlayerUrl(value).seriesId;
  }

  shouldMergeAllEpisodes(value) {
    return isHongguoSeriesId(value) || Boolean(globals.hongguoMergeAllEpisodes);
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    if (!Array.isArray(sourceAnimes)) return [];
    const transformed = [];
    const filtered = sourceAnimes.filter((item) => titleMatches(item.name, queryTitle, querySeason));
    for (const anime of filtered) {
      const details = await this.getEpisodes(anime.seriesId);
      const episodes = details.episodes;
      const links = globals.hongguoMergeAllEpisodes && episodes.length
        ? [{
            name: "全集",
            url: createHongguoSeriesId(anime.seriesId),
            title: "【hongguo】 全集",
          }]
        : episodes.map((episode) => {
            const episodeTitle = `第${episode.index}集${episode.title ? ` ${episode.title}` : ""}`;
            return {
              name: episodeTitle,
              url: createHongguoEpisodeId(anime.seriesId, episode.vid, episode.duration),
              title: `【hongguo】 ${episodeTitle}`,
            };
          });
      if (!links.length) continue;
      const year = Number.isInteger(anime.year)
        ? anime.year
        : (Number.isInteger(details.year) ? details.year : null);
      const item = {
        animeId: convertToAsciiSum(anime.seriesId),
        bangumiId: String(anime.seriesId),
        animeTitle: `${anime.name}${year ? `(${year})` : ""}【短剧】from hongguo`,
        type: "短剧",
        typeDescription: "短剧",
        imageUrl: anime.imageUrl || details.imageUrl || "",
        startDate: generateValidStartDate(year),
        episodeCount: links.length,
        rating: Number(anime.score) || 0,
        isFavorited: true,
        source: "hongguo",
      };
      transformed.push(item);
      addAnime({ ...item, links }, detailStore);
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }
    this.sortAndPushAnimesByYear(transformed, curAnimes);
    return transformed;
  }

  buildCommentBody(info, startMs, cursor) {
    return {
      comment_source: COMMENT_SOURCE,
      server_channel: SERVER_CHANNEL,
      group_id: info.vid,
      group_type: 30,
      comment_type: 20,
      sort: 1,
      business_param: {
        book_id: info.seriesId,
        start_offset_time: Math.max(0, Math.trunc(startMs)),
        playlet_item_duration: Math.max(0, Math.trunc(info.duration * 1000)),
        need_danmaku_guide_type: [1, 3, 4, 2],
      },
      count: COMMENT_COUNT,
      cursor: String(cursor || ""),
      aid: Number(CLIENT_CONFIG.baseQuery.aid),
      compliance_status: 0,
    };
  }

  async fetchCommentWindow(info, startMs, cursor = "") {
    const path = `/novel/commentapi/comment/list/${encodeURIComponent(info.vid)}/v1/`;
    const payload = await this.request("POST", path, {
      body: this.buildCommentBody(info, startMs, cursor),
      comment: true,
    });
    const data = payload.data || {};
    const listInfo = data.common_list_info || {};
    const extra = data.extra || {};
    let nextStart = Number(extra.next_query_danmaku_list_time);
    if (!Number.isFinite(nextStart)) nextStart = startMs + COMMENT_WINDOW_MS;
    if (nextStart <= startMs) nextStart = startMs + COMMENT_WINDOW_MS;
    return {
      comments: parseDanmuResponse(payload),
      nextStart,
      cursor: String(listInfo.cursor || ""),
      hasMore: Boolean(listInfo.has_more),
    };
  }

  async getDanmuForEpisode(info) {
    const durationMs = info.duration * 1000;
    const comments = [];
    const seenMarkers = new Set();
    let startMs = 0;
    let cursor = "";
    const maxRequests = Math.max(1, Math.ceil(durationMs / COMMENT_WINDOW_MS) + 5);
    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex++) {
      const marker = `${startMs}:${cursor}`;
      if (seenMarkers.has(marker)) break;
      seenMarkers.add(marker);
      const page = await this.fetchCommentWindow(info, startMs, cursor);
      comments.push(...page.comments);
      if (durationMs && page.nextStart >= durationMs) break;
      if (!page.hasMore && !durationMs) break;
      startMs = page.nextStart;
      cursor = page.cursor;
    }
    return comments;
  }

  async getSeriesDanmu(seriesId) {
    const details = await this.getEpisodes(seriesId);
    let cumulativeMs = 0;
    const episodeTasks = details.episodes.map((episode) => {
      const task = { episode, offsetMs: cumulativeMs };
      cumulativeMs += Math.max(0, Number(episode.duration) || 0) * 1000;
      return task;
    });
    const groupedComments = await mapWithConcurrency(episodeTasks, COMMENT_CONCURRENCY, async ({ episode, offsetMs }) => {
      const episodeComments = await this.getDanmuForEpisode({
        seriesId: String(seriesId),
        vid: episode.vid,
        duration: episode.duration,
      });
      return episodeComments.map((comment) => ({
        ...comment,
        offsetMs: comment.offsetMs + offsetMs,
      }));
    });
    const comments = [];
    for (const episodeComments of groupedComments) {
      comments.push(...episodeComments);
    }
    return dedupeDanmus(comments);
  }

  async getEpisodeDanmu(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmu(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const cacheKey = `${info.seriesId}:${info.vid}`;
      // in-flight 去重：同一集并发请求只抓取一次，避免重复命中接口加重风控
      const pending = this.pendingEpisodeDanmu.get(cacheKey);
      if (pending) {
        log("info", `[Hongguo] 复用进行中的整段弹幕请求: ${cacheKey}`);
        return pending;
      }
      const task = (async () => {
        const comments = dedupeDanmus(await this.getDanmuForEpisode(info));
        if (!info.duration && comments.length) {
          const maxOffset = Math.max(...comments.map((item) => Number(item.offsetMs) || 0));
          if (maxOffset > 0) this.durationCache.set(cacheKey, Math.ceil(maxOffset / 1000) + 30);
        }
        this.lastDanmu = comments;
        return comments;
      })().catch((error) => {
        // 仅网络/风控等抓取阶段失败才允许回退 lastDanmu
        const fetchError = new Error(`弹幕抓取失败: ${error.message}`);
        fetchError.danmuFetchFailed = true;
        throw fetchError;
      }).finally(() => {
        this.pendingEpisodeDanmu.delete(cacheKey);
      });
      this.pendingEpisodeDanmu.set(cacheKey, task);
      return task;
    } catch (error) {
      log("error", `[Hongguo] 获取弹幕失败(${String(id).slice(0, 80)}): ${error.message}`);
      // 链接/ID 解析失败等不应回退旧数据，避免误报并重复输出；仅抓取失败时回退最近一次成功结果
      if (error.danmuFetchFailed && this.lastDanmu && this.lastDanmu.length) return this.lastDanmu;
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmuSegments(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const episodeId = createHongguoEpisodeId(info.seriesId, info.vid, info.duration);
      const segmentList = [];
      // 详情页偶尔没有对应播放器页（通常是后续集），用 10 分钟窗口覆盖短剧常见时长；
      // 弹幕接口会在无更多数据时提前停止，不会实际请求完整 10 分钟。
      let effectiveDuration = info.duration > 0 ? info.duration : this.durationCache.get(`${info.seriesId}:${info.vid}`) || 0;
      if (!effectiveDuration) {
        const comments = await this.getDanmuForEpisode(info);
        const maxOffset = comments.reduce((max, item) => Math.max(max, Number(item.offsetMs) || 0), 0);
        effectiveDuration = maxOffset > 0 ? Math.ceil(maxOffset / 1000) + 30 : 600;
        this.durationCache.set(`${info.seriesId}:${info.vid}`, effectiveDuration);
      }
      for (let start = 0; start < effectiveDuration; start += COMMENT_WINDOW_MS / 1000) {
        segmentList.push({
          type: "hongguo",
          segment_start: start,
          segment_end: Math.min(start + COMMENT_WINDOW_MS / 1000, effectiveDuration),
          url: `${episodeId}#segment=${start}`,
        });
      }
      return new SegmentListResponse({ type: "hongguo", segmentList, duration: effectiveDuration });
    } catch (error) {
      log("error", `[Hongguo] 创建弹幕分段失败: ${error.message}`);
      return new SegmentListResponse({ type: "hongguo", segmentList: [] });
    }
  }

  async getSeriesDanmuSegments(seriesId) {
    const details = await this.getEpisodes(seriesId);
    const segmentList = [];
    let cumulativeSeconds = 0;
    for (const episode of details.episodes) {
      const duration = Math.max(0, Number(episode.duration) || 600);
      const episodeId = createHongguoEpisodeId(seriesId, episode.vid, duration);
      for (let start = 0; start < duration; start += COMMENT_WINDOW_MS / 1000) {
        const end = Math.min(start + COMMENT_WINDOW_MS / 1000, duration);
        segmentList.push({
          type: "hongguo",
          segment_start: cumulativeSeconds + start,
          segment_end: cumulativeSeconds + end,
          url: `${episodeId}#segment=${start}&offset=${cumulativeSeconds}`,
        });
      }
      cumulativeSeconds += duration;
    }
    return new SegmentListResponse({ type: "hongguo", segmentList, duration: cumulativeSeconds });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const segmentUrl = typeof segment === "string" ? segment : segment.url;
      const info = await this.resolveEpisodeInfo(segmentUrl);
      const globalOffsetSeconds = Math.max(0, getFragmentNumber(segmentUrl, "offset") || 0);
      const fragmentStart = getFragmentNumber(segmentUrl, "segment");
      const localStartSeconds = Math.max(0, fragmentStart == null
        ? Number(segment.segment_start || 0) - globalOffsetSeconds
        : fragmentStart);
      const segmentDurationSeconds = typeof segment === "string" ? COMMENT_WINDOW_MS / 1000 : Math.max(0, Number(segment.segment_end) - Number(segment.segment_start));
      const localEndSeconds = Math.min(info.duration > 0 ? info.duration : localStartSeconds + segmentDurationSeconds, localStartSeconds + segmentDurationSeconds);
      const startMs = localStartSeconds * 1000;
      const endMs = Math.max(startMs, localEndSeconds * 1000);
      const page = await this.fetchCommentWindow(info, startMs, "");
      const offsetMs = globalOffsetSeconds * 1000;
      return dedupeDanmus(page.comments
        .filter((item) => item.offsetMs >= startMs && item.offsetMs < endMs)
        .map((item) => ({ ...item, offsetMs: item.offsetMs + offsetMs })));
    } catch (error) {
      log("error", `[Hongguo] 获取分段弹幕失败: ${error.message}`);
      return [];
    }
  }

  formatComments(comments) {
    return comments.map((comment) => ({
      p: `${(comment.offsetMs / 1000).toFixed(2)},1,16777215,[hongguo]`,
      m: comment.text,
      t: comment.offsetMs / 1000,
      like: comment.diggCount,
    }));
  }
}
