import { log } from './log-util.js';
import { httpGet, httpPost } from './http-util.js';
import { applyOffset } from './offset-util.js';
import { globals } from '../configs/globals.js';

// NipaPlay 中转弹弹play服务端（官方弹弹play 网关）：主线路为香港域名，备用线路为国内 IP 直连。
// 应用密钥由 NipaPlay 中转弹弹play服务端保管并代为签名上游请求，本模块只需携带账号令牌。
const NIPAPLAY_GATEWAY_SERVERS = [
  'https://nipaplay.aimes-soft.com/dandanplay',
  'http://43.142.85.190/dandanplay',
];

// 主线路连续失败达到该次数后由备用线路接替
const GATEWAY_FAILURE_THRESHOLD = 3;
// 备用线路接替时长，到期后恢复主线路
const GATEWAY_FAILOVER_DURATION = 5 * 60 * 1000;
// 令牌距到期不足该时长时提前续期
const TOKEN_RENEW_AHEAD = 24 * 60 * 60 * 1000;

const NIPAPLAY_USER_AGENT = `LogVar Danmu API/${globals.version}`;

let primaryFailures = 0;  // 主线路连续失败次数
let failoverUntil = 0;    // 备用线路接替截止时间（毫秒时间戳）
let accountToken = null;  // 账号令牌
let tokenExpireTime = 0;  // 令牌到期时间（毫秒时间戳）
let tokenAccount = '';    // 令牌对应的账号，账号变更时令牌自动失效
let loginTask = null;     // 进行中的登录请求，避免并发重复登录

// 账号与密码同时配置后启用 NipaPlay 中转弹弹play服务端
function isNipaplayAccountConfigured() {
  return Boolean(globals.dandanplayAccount && globals.dandanplayPassword);
}

// 当前配置的账号，令牌只与账号绑定：改密码后原令牌仍有效，无需重新登录
function currentAccount() {
  return globals.dandanplayAccount || '';
}

// 当前生效的线路：备用线路接替期间使用备用线路，其余时间使用主线路
function activeGateway() {
  if (failoverUntil && Date.now() >= failoverUntil) {
    failoverUntil = 0;
    primaryFailures = 0;
    log('info', '[dandan] [nipaplay] NipaPlay 中转弹弹play服务端备用线路接替结束，恢复主线路');
  }
  return failoverUntil ? NIPAPLAY_GATEWAY_SERVERS[1] : NIPAPLAY_GATEWAY_SERVERS[0];
}

// 记录线路请求结果：主线路连续失败达到阈值后交由备用线路接替
function reportGatewayResult(success) {
  if (success) {
    primaryFailures = 0;
    return;
  }
  if (failoverUntil) return;
  primaryFailures++;
  if (primaryFailures < GATEWAY_FAILURE_THRESHOLD) return;
  primaryFailures = 0;
  failoverUntil = Date.now() + GATEWAY_FAILOVER_DURATION;
  log('info', `[dandan] [nipaplay] NipaPlay 中转弹弹play服务端主线路连续失败，临时切换备用线路: ${NIPAPLAY_GATEWAY_SERVERS[1]}`);
}

// 请求 NipaPlay 中转弹弹play服务端并记录线路健康状态
async function requestGateway(run) {
  const gateway = activeGateway();
  try {
    const result = await run(gateway);
    reportGatewayResult(true);
    return result;
  } catch (error) {
    reportGatewayResult(false);
    throw error;
  }
}

// 登录弹弹play账号换取令牌；NipaPlay 中转弹弹play服务端负责补齐 appId 与签名，本模块只提交账号与密码
async function loginAccount(account, password) {
  const resp = await requestGateway((gateway) => httpPost(
    `${gateway}/api/v2/login`,
    JSON.stringify({ userName: account, password }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': NIPAPLAY_USER_AGENT,
      },
      validStatusCodes: [200, 401],
      retries: 1,
    },
  ));
  return resp?.data || null;
}

// 令牌续期：NipaPlay 中转弹弹play服务端要求携带现有令牌以 GET 方式续期
async function renewAccountToken(token) {
  const resp = await requestGateway((gateway) => httpGet(`${gateway}/api/v2/login/renew`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': NIPAPLAY_USER_AGENT,
      'Authorization': `Bearer ${token}`,
    },
    validStatusCodes: [200, 401],
    retries: 1,
  }));
  return resp?.data || null;
}

// 应用登录或续期结果：缓存令牌、到期时间与其对应的账号
function applyTokenData(data) {
  if (!data?.token) return null;
  accountToken = data.token;
  tokenAccount = currentAccount();
  const expire = Date.parse(data.tokenExpireTime);
  tokenExpireTime = Number.isFinite(expire) ? expire : 0;
  return accountToken;
}

// 清除令牌缓存，使下次请求重新登录
function clearAccountToken() {
  accountToken = null;
  tokenExpireTime = 0;
  tokenAccount = '';
}

// 获取可用令牌：账号变更、临近到期或缺失时重新获取，并发调用共用同一次请求
async function getAccountToken() {
  const account = currentAccount();
  const cached = accountToken
    && tokenAccount === account
    && (!tokenExpireTime || Date.now() < tokenExpireTime - TOKEN_RENEW_AHEAD);
  if (cached) return accountToken;

  if (!loginTask) {
    loginTask = (async () => {
      // 同一账号已有令牌时先尝试续期，续期失败再走完整登录
      if (accountToken && tokenAccount === account) {
        const renewed = applyTokenData(await renewAccountToken(accountToken));
        if (renewed) return renewed;
      }
      const data = await loginAccount(globals.dandanplayAccount, globals.dandanplayPassword);
      const token = applyTokenData(data);
      if (!token) throw new Error(data?.errorMessage || '账号登录未返回令牌');
      return token;
    })().finally(() => { loginTask = null; });
  }
  return loginTask;
}

// 域名到内部源标识的映射，覆盖 dandanplay 允许绑定的全部平台；各平台均已接入对应采集源，分发阶段直接复用既有源拉取弹幕。
const RELATED_PLATFORM_BY_HOST = {
  'bilibili.com': 'bilibili',
  'b23.tv': 'bilibili',
  'gamer.com.tw': 'bahamut',
  'iqiyi.com': 'iqiyi',
  'youku.com': 'youku',
  'qq.com': 'tencent',
  'mgtv.com': 'imgo',
};

// 从 302 Location 解析弹弹302关联链接：读取 urls（| 分隔）与 shift（, 分隔）两个参数，
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
      log('info', `[dandan] [nipaplay] 弹弹302关联链接含未支持平台，跳过: ${urls[i]}`);
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

// 解析弹弹302关联链接为 {source, realId}：平台识别复用 RELATED_PLATFORM_BY_HOST 的同一映射，
// 使解析与分发两处对平台域名（含裸域名与 b站短链 b23.tv）的识别保持一致；平台确定后按各源
// getEpisodeDanmu 入参契约还原 realId（如 bahamut 提取 sn 数字、其余平台直接传递完整 URL）。
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

// 对已格式化的弹幕应用弹弹302关联链接附带的时间偏移：复用通用偏移工具校正各时间字段（含非负钳制），
// 并标记为实时拉取，使 dandan 源的 formatComments 跳过 Dandan 专属转换。
export function applyShiftToDanmu(danmu, shift = 0) {
  if (!danmu || typeof danmu !== 'object') return danmu;
  const [shifted] = applyOffset([danmu], shift);
  return { ...shifted, isRealTimePulled: true };
}

// 弹弹play原生弹幕地址由 302 的 Location 给出，跟随该地址即得弹弹play 原生弹幕
async function fetchNativeComments(location) {
  const resp = await httpGet(location, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': NIPAPLAY_USER_AGENT,
    },
    retries: 1,
  });
  return Array.isArray(resp?.data?.comments) ? resp.data.comments : [];
}

// 经 NipaPlay 中转弹弹play服务端获取弹弹play 弹幕：一次请求同时得到原生弹幕与弹弹302关联链接，
// 原生弹幕跟随 302 重定向地址从原生地址获取，原生地址请求失败时记录错误并保留已解析的关联链接。
// 返回 { comments, relatedLinks }；账号未配置或请求失败时返回 null，由调用方决定后续处理。
export async function fetchNipaplayDanmaku(episodeId) {
  if (!isNipaplayAccountConfigured()) return null;
  try {
    return await requestNipaplayDanmaku(episodeId, false);
  } catch (error) {
    log('error', `[dandan] [nipaplay] NipaPlay 中转弹弹play服务端弹幕请求失败: ${error.message}`);
    return null;
  }
}

async function requestNipaplayDanmaku(episodeId, retried) {
  const token = await getAccountToken();
  const resp = await requestGateway((gateway) => httpGet(
    `${gateway}/api/v2/comment/${episodeId}?withRelated=true&chConvert=0`,
    {
      headers: {
        'Accept': 'application/json',
        'User-Agent': NIPAPLAY_USER_AGENT,
        'Authorization': `Bearer ${token}`,
      },
      allow_redirects: false,
      validStatusCodes: [200, 302, 401],
      retries: 1,
    },
  ));

  // 令牌失效：清除缓存后重新登录并重试一次
  if (resp.status === 401) {
    if (retried) throw new Error('账号登录已失效');
    log('info', '[dandan] [nipaplay] NipaPlay 中转弹弹play服务端返回登录失效，重新登录后重试');
    clearAccountToken();
    return requestNipaplayDanmaku(episodeId, true);
  }

  const location = resp.headers?.location || resp.headers?.Location;
  const relatedLinks = resp.status === 302 && location ? parseNipaplayRelatedLinks(location) : null;
  let comments = [];
  if (resp.status === 200) {
    comments = Array.isArray(resp.data?.comments) ? resp.data.comments : [];
  } else if (location) {
    // 原生地址请求失败时记录错误并保留已解析的关联链接
    try {
      comments = await fetchNativeComments(location);
    } catch (error) {
      log('error', `[dandan] [nipaplay] 弹弹play 原生弹幕获取失败: ${error.message}`);
    }
  }
  return { comments, relatedLinks };
}

// 经 NipaPlay 中转弹弹play服务端获取作品详情：danmaku-anywhere 镜像弹弹play服务端详情接口未返回剧集时用作兜底。
// 账号未配置或请求失败时返回 null，由调用方沿用原详情数据。
export async function fetchNipaplayBangumiDetail(animeId) {
  if (!isNipaplayAccountConfigured()) return null;
  try {
    return await requestNipaplayBangumiDetail(animeId, false);
  } catch (error) {
    log('error', `[dandan] [nipaplay] NipaPlay 中转弹弹play服务端详情请求失败: ${error.message}`);
    return null;
  }
}

async function requestNipaplayBangumiDetail(animeId, retried) {
  const token = await getAccountToken();
  const resp = await requestGateway((gateway) => httpGet(
    `${gateway}/api/v2/bangumi/${animeId}`,
    {
      headers: {
        'Accept': 'application/json',
        'User-Agent': NIPAPLAY_USER_AGENT,
        'Authorization': `Bearer ${token}`,
      },
      validStatusCodes: [200, 401],
      retries: 1,
    },
  ));

  // 令牌失效：清除缓存后重新登录并重试一次
  if (resp.status === 401) {
    if (retried) throw new Error('账号登录已失效');
    log('info', '[dandan] [nipaplay] NipaPlay 中转弹弹play服务端详情返回登录失效，重新登录后重试');
    clearAccountToken();
    return requestNipaplayBangumiDetail(animeId, true);
  }

  return resp?.data?.bangumi || null;
}

// 校验弹弹play账号：以传入或已配置的账号密码登录，验证 NipaPlay 中转弹弹play服务端连通性与账号有效性；
// 返回 { ok, message }，不写入运行期令牌缓存。
export async function verifyNipaplayAccount(account, password) {
  const userName = account || globals.dandanplayAccount;
  const userPassword = password || globals.dandanplayPassword;
  if (!userName || !userPassword) {
    return { ok: false, message: '请先填写弹弹play账号与密码' };
  }
  try {
    const data = await loginAccount(userName, userPassword);
    if (!data?.token) {
      return { ok: false, message: `连通性测试失败: ${data?.errorMessage || '账号登录未返回令牌'}` };
    }
    return { ok: true, message: `连通性测试成功，账号: ${data.screenName || userName}` };
  } catch (error) {
    return { ok: false, message: `连通性测试失败: ${error.message}` };
  }
}
