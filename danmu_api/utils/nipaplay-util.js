import { aesDecryptBase64, sha256, bytesToBase64, utf8BytesToString } from './codec-util.js';
import { log } from './log-util.js';
import { httpGet } from './http-util.js';
import { globals } from '../configs/globals.js';

// nipaplayv1 弹弹302关联链接凭证：NipaPlay 授权本项目的 dandan 源在 0 弹幕时，
// 借此向 api.dandanplay.net 换取跨平台（b站/巴哈）绑定链接并自行实时拉取。
// 凭证参数经运行时派生与重组还原，源码不出现可读明文（禁止滥用）。
const _keyMask = new Uint8Array([237, 67, 45, 109, 89, 4, 82, 107, 109, 211, 243, 208, 85, 182, 233, 79]);
const _keyXored = new Uint8Array([163, 42, 93, 12, 127, 72, 61, 12, 59, 178, 129, 246, 103, 84, 105, 196]);
const NIPAPLAY_AES_KEY = utf8BytesToString(new Uint8Array(_keyXored.map((b, i) => b ^ _keyMask[i])));

// 片段，运行期重组为完整值（禁止滥用）。
const _appIdFrag = ['wBQ0gL26', 'oPlbCiLn', 'f37+sQ=='];
const NIPAPLAY_APP_ID_CIPHERTEXT = _appIdFrag.join('');

// 片段，运行期重组为完整值（禁止滥用）。
const _secretFrag = ['9CB0Qo6tW1', 'CfUDx3jCtV', 'rUat/EMK+x', 'voco1Y2MF8', 'YQUuM14JDN', '1/wWqIRHP', 'H/buF'];
const NIPAPLAY_APP_SECRET_CIPHERTEXT = _secretFrag.join('');

export const NIPAPLAY_APP_ID = aesDecryptBase64(NIPAPLAY_APP_ID_CIPHERTEXT, NIPAPLAY_AES_KEY);
export const NIPAPLAY_APP_SECRET = aesDecryptBase64(NIPAPLAY_APP_SECRET_CIPHERTEXT, NIPAPLAY_AES_KEY);

// 由 nipaplayv1 凭证生成 dandanplay 开放接口所需的 X-Signature
export function generateNipaplaySignature(appId, timestamp, apiPath, appSecret) {
  return bytesToBase64(sha256(`${appId}${timestamp}${apiPath}${appSecret}`));
}

// 域名到内部源标识的映射，覆盖 dandanplay 允许绑定的全部平台，
// 使解析对未出现在 nipaplayv1 返回中的平台亦具备识别能力而不致静默丢失；
// 各平台均已接入对应采集源，分发阶段直接复用既有源拉取弹幕。
const RELATED_PLATFORM_BY_HOST = {
  'bilibili.com': 'bilibili',
  'b23.tv': 'bilibili',
  'gamer.com.tw': 'bahamut',
  'iqiyi.com': 'iqiyi',
  'youku.com': 'youku',
  'qq.com': 'tencent',
  'mgtv.com': 'imgo',
};

// 从 302 Location 解析 nipaplay 弹弹302关联链接：读取 urls（| 分隔）与 shift（, 分隔）两个参数，
// 按各 URL 主机名映射到内部源标识并还原时间偏移；平台标识由主机名推导，不依赖 302 自带的 related 字段。
// 返回的链接取决于用户在弹弹play客户端实际绑定的平台，可能覆盖 b站/巴哈/爱奇艺/
// 优酷/腾讯/芒果(Imgo) 中任意组合，上述全部平台均已接入对应采集源。
export function parseNipaplayRelatedLinks(location) {
  const result = { bilibili: [], bahamut: [], iqiyi: [], youku: [], tencent: [], imgo: [] };
  if (!location || typeof location !== 'string') return result;
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    return result;
  }
  const urlsParam = parsed.searchParams.get('urls');
  if (!urlsParam) return result;
  const urls = urlsParam.split('|').map((entry) => entry.trim()).filter(Boolean);
  const shifts = (parsed.searchParams.get('shift') || '')
    .split(',').map((value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; });
  for (let i = 0; i < urls.length; i++) {
    let host = '';
    try { host = new URL(urls[i]).host; } catch { host = ''; }
    const hostKey = Object.keys(RELATED_PLATFORM_BY_HOST)
      .find((key) => host.endsWith(key)) || null;
    if (!hostKey) {
      log('info', `[nipaplay] 弹弹302关联链接含未支持平台，跳过: ${urls[i]}`);
      continue;
    }
    const platform = RELATED_PLATFORM_BY_HOST[hostKey];
    const shift = shifts[i] || 0;
    if (platform === 'bilibili') {
      const bMatch = urls[i].match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i);
      const pMatch = urls[i].match(/[?&]p=(\d+)/);
      const clean = bMatch
        ? `https://www.bilibili.com/video/${bMatch[1]}` + (pMatch ? `?p=${pMatch[1]}` : '')
        : urls[i];
      result.bilibili.push({ url: clean, shift });
      continue;
    }
    result[platform].push({ url: urls[i], shift });
  }
  return result;
}

// 发起带签名的 nipaplayv1 弹弹302关联请求并截获 302 重定向地址；凭证、签名与解析均来自本模块，
// 使 dandan.js 只需消费解析后的弹弹302关联链接而无需感知 nipaplay 协议细节。
const NIPAPLAY_USER_AGENT = `LogVar Danmu API/${globals.version}`;
export async function fetchNipaplayRelatedLinks(episodeId) {
  if (!NIPAPLAY_APP_ID || !NIPAPLAY_APP_SECRET) {
    log('info', '[nipaplay] 凭证未就绪，跳过弹弹302关联兜底');
    return null;
  }
  const timestamp = Math.round(Date.now() / 1000);
  const apiPath = `/api/v2/comment/${episodeId}`;
  const signature = generateNipaplaySignature(NIPAPLAY_APP_ID, timestamp, apiPath, NIPAPLAY_APP_SECRET);
  const url = `https://api.dandanplay.net${apiPath}?withRelated=true&chConvert=0`;
  try {
    const resp = await httpGet(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': NIPAPLAY_USER_AGENT,
        'X-AppId': NIPAPLAY_APP_ID,
        'X-Timestamp': String(timestamp),
        'X-Signature': signature,
      },
      allow_redirects: false,
      validStatusCodes: [302],
      retries: 1,
    });
    if (resp.status !== 302 || !resp.headers.location) {
      log('info', `[nipaplay] 弹弹302关联链接未返回 302 (status=${resp.status})`);
      return null;
    }
    return parseNipaplayRelatedLinks(resp.headers.location);
  } catch (error) {
    log('error', `[nipaplay] 弹弹302关联链接请求失败: ${error.message}`);
    return null;
  }
}

// 解析 nipaplay 弹弹302关联链接为 {source, realId}：平台识别复用 RELATED_PLATFORM_BY_HOST 的同一映射（与 parseNipaplayRelatedLinks 的 host 推导一致），使解析与分发两处对平台域名的识别保持一致（含无 www 前缀的裸域名与 b站短链 b23.tv）。
// 平台确定后按各源 getEpisodeDanmu 入参契约还原 realId（如 bahamut 提取 sn 数字、其余平台直接传递完整 URL），使弹弹302关联兜底与各源入参契约保持一致。
export function resolveNipaplayLink(url) {
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  const hostKey = Object.keys(RELATED_PLATFORM_BY_HOST)
    .find((key) => host.endsWith(key)) || null;
  const platform = hostKey ? RELATED_PLATFORM_BY_HOST[hostKey] : null;
  if (platform === 'bahamut') {
    const snMatch = url.match(/sn=(\d+)/);
    return { source: 'bahamut', realId: snMatch ? snMatch[1] : url };
  }
  if (!platform) return { source: null, realId: url };
  return { source: platform, realId: url };
}

// 对已完成格式化的弹幕应用弹弹302关联链接附带的时间偏移：校正 p 的首字段（时间）与 t 字段
export function applyShiftToDanmu(danmu, shift = 0) {
  if (!danmu || typeof danmu !== 'object') return danmu;
  const next = { ...danmu };
  if (typeof next.p === 'string') {
    const parts = next.p.split(',');
    const time = parseFloat(parts[0]);
    if (!isNaN(time)) parts[0] = (time + shift).toFixed(2);
    next.p = parts.join(',');
  }
  if (typeof next.t === 'number') next.t += shift;
  next.isRealTimePulled = true;
  return next;
}

