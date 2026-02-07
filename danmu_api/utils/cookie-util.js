import { jsonResponse } from './http-util.js';
import { log } from './log-util.js';
import { globals } from '../configs/globals.js';
import { HandlerFactory } from '../configs/handlers/handler-factory.js';

// ================================
// Bilibili Cookie 工具
// ================================

// 存储二维码登录会话（内存存储，仅用于短期轮询状态）
const qrLoginSessions = new Map();

/**
 * 从运行时环境获取当前已保存的 Cookie
 *
 * 说明：
 * - 不做任何“写入内存”持久化逻辑
 * - 仅从当前环境变量/进程环境/运行时配置中读取
 */
function getCookieFromRuntime() {
  // 1) 优先使用已加载到 globals 的配置（最常见）
  try {
    if (globals && typeof globals.bilibliCookie === 'string' && globals.bilibliCookie) {
      return globals.bilibliCookie;
    }
  } catch (_) {
    // ignore
  }

  // 2) 兜底：直接读运行时 env 对象或 process.env
  try {
    if (globals && globals.env && typeof globals.env.BILIBILI_COOKIE === 'string' && globals.env.BILIBILI_COOKIE) {
      return globals.env.BILIBILI_COOKIE;
    }
  } catch (_) {
    // ignore
  }

  if (typeof process !== 'undefined' && process.env && typeof process.env.BILIBILI_COOKIE === 'string' && process.env.BILIBILI_COOKIE) {
    return process.env.BILIBILI_COOKIE;
  }

  return '';
}

/**
 * 尝试从 Cookie 中解析过期时间（Unix 秒）
 *
 * 说明：
 * - B 站 SESSDATA 常见格式中会携带一个时间戳片段（不同场景可能不存在/格式不同）
 * - 解析失败时，为了兼容旧逻辑，返回“现在 + 30 天”的估算值
 */
function parseExpiresFromCookie(cookie) {
  try {
    const match = cookie.match(/SESSDATA=([^;]+)/);
    if (!match) {
      return Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    }

    const sessDataRaw = match[1];
    const decoded = decodeURIComponent(sessDataRaw);

    // 提取可能的时间戳（10位或更长的纯数字段），取最接近“未来”的合理值
    const now = Math.floor(Date.now() / 1000);
    const candidates = (decoded.match(/\d{10,}/g) || [])
      .map(s => Number(s))
      .filter(n => Number.isFinite(n));

    // 只保留未来且不超过 10 年的候选值
    const tenYears = 10 * 365 * 24 * 60 * 60;
    const future = candidates.filter(n => n > now && n < now + tenYears);

    if (future.length > 0) {
      // 一般越大越接近真实过期时间
      return Math.max(...future);
    }

    // 兼容旧实现：如果逗号分割第二段是时间戳
    if (decoded.includes(',')) {
      const parts = decoded.split(',');
      if (parts.length > 1) {
        const ts = parseInt(parts[1], 10);
        if (!isNaN(ts) && ts > now) {
          return ts;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // fallback：估算 30 天
  return Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
}

/**
 * 验证 Cookie 有效性
 */
async function verifyCookieValidity(cookie) {
  if (!cookie) {
    return { isValid: false, error: '缺少Cookie' };
  }

  // 简单格式检查
  if (!cookie.includes('SESSDATA') || !cookie.includes('bili_jct')) {
    return { isValid: false, error: 'Cookie格式不完整（需要包含 SESSDATA 和 bili_jct）' };
  }

  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });

    // 非 2xx 直接报错（B站有时会返回风控页/HTML）
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        isValid: false,
        error: `验证请求失败：HTTP ${response.status}${text ? ' - ' + text.slice(0, 80) : ''}`
      };
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      const text = await response.text().catch(() => '');
      return { isValid: false, error: `验证响应解析失败：${text ? text.slice(0, 80) : e.message}` };
    }

    // 登录成功
    if (data?.code === 0 && data?.data?.isLogin) {
      return {
        isValid: true,
        data: {
          uname: data.data.uname,
          mid: data.data.mid,
          face: data.data.face
        }
      };
    }

    // code=0 但未登录，message 经常是 "0"，需要单独处理
    if (data?.code === 0 && data?.data && data.data.isLogin === false) {
      return { isValid: false, error: '账号未登录（Cookie 已失效）' };
    }

    return { isValid: false, error: data?.message || 'Cookie无效或已过期' };
  } catch (error) {
    return { isValid: false, error: '验证请求失败: ' + error.message };
  }
}

/**
 * 统一 Cookie 校验响应
 */
async function buildCookieStatusResult(cookie, checked = 'saved') {
  if (!cookie) {
    return {
      success: true,
      data: {
        isValid: false,
        checked,
        error: '未配置Cookie'
      }
    };
  }

  const verifyResult = await verifyCookieValidity(cookie);

  if (!verifyResult.isValid) {
    return {
      success: true,
      data: {
        isValid: false,
        checked,
        error: verifyResult.error || 'Cookie无效或已失效'
      }
    };
  }

  return {
    success: true,
    data: {
      isValid: true,
      checked,
      uname: verifyResult.data?.uname || '未知用户',
      expiresAt: parseExpiresFromCookie(cookie)
    }
  };
}

/**
 * 获取当前保存的 Cookie 状态（读取环境变量）
 */
export async function handleCookieStatus() {
  try {
    const cookie = getCookieFromRuntime();
    const result = await buildCookieStatusResult(cookie, 'saved');
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 500);
  }
}

/**
 * 校验指定 Cookie（用于前端输入框实时检测）
 *
 * - body.cookie 存在：校验该 cookie
 * - body.cookie 不存在/全为*：校验当前已保存 cookie
 */
export async function handleCookieVerify(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      body = {};
    }

    const rawCookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
    const useSaved = !rawCookie || /^\*+$/.test(rawCookie);

    const cookie = useSaved ? getCookieFromRuntime() : rawCookie;
    const checked = useSaved ? 'saved' : 'input';

    const result = await buildCookieStatusResult(cookie, checked);
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 500);
  }
}

/**
 * 生成二维码
 */
export async function handleQRGenerate() {
  try {
    const response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    });

    const data = await response.json();

    if (data.code !== 0) {
      return jsonResponse({ success: false, message: data.message || '生成二维码失败' }, 500);
    }

    // 记录会话
    qrLoginSessions.set(data.data.qrcode_key, {
      createTime: Date.now(),
      status: 'generated'
    });

    return jsonResponse({
      success: true,
      data: data.data
    });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 500);
  }
}

/**
 * 从响应头 Set-Cookie 提取登录所需 Cookie
 */
function extractLoginCookieFromResponse(response) {
  const cookieMap = new Map();

  // 兼容 Cloudflare Workers / Node(undici) 的 Headers.getSetCookie()
  let setCookies = [];
  try {
    if (response?.headers && typeof response.headers.getSetCookie === 'function') {
      setCookies = response.headers.getSetCookie() || [];
    } else {
      const sc = response?.headers?.get?.('set-cookie');
      if (sc) setCookies = [sc];
    }
  } catch (_) {
    setCookies = [];
  }

  // 解析 name=value
  for (const sc of setCookies) {
    if (!sc || typeof sc !== 'string') continue;
    const first = sc.split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;
    cookieMap.set(name, value);
  }

  const sess = cookieMap.get('SESSDATA');
  const biliJct = cookieMap.get('bili_jct');
  const dede = cookieMap.get('DedeUserID');
  const dedeMd5 = cookieMap.get('DedeUserID__ckMd5');
  const sid = cookieMap.get('sid');

  if (!sess) {
    return null;
  }

  // 组装 Cookie（最小可用集合 + 常见字段）
  const parts = [`SESSDATA=${sess}`];
  if (biliJct) parts.push(`bili_jct=${biliJct}`);
  if (dede) parts.push(`DedeUserID=${dede}`);
  if (dedeMd5) parts.push(`DedeUserID__ckMd5=${dedeMd5}`);
  if (sid) parts.push(`sid=${sid}`);

  return parts.join('; ');
}

/**
 * 检查二维码扫描状态
 */
export async function handleQRCheck(request) {
  try {
    const body = await request.json();
    const qrcodeKey = body.qrcodeKey || body.qrcode_key;

    if (!qrcodeKey) {
      return jsonResponse({ success: false, message: '缺少qrcodeKey参数' }, 400);
    }

    const response = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.bilibili.com/'
        }
      }
    );

    const data = await response.json();
    let cookie = null;

    // 登录成功
    if (data?.data?.code === 0) {
      // 优先从 Set-Cookie 里拿
      cookie = extractLoginCookieFromResponse(response);

      // 兜底：极少数情况下可能从 url 参数拿到（保留旧逻辑）
      if (!cookie && data?.data?.url) {
        try {
          const url = new URL(data.data.url);
          const params = new URLSearchParams(url.search);
          const SESSDATA = decodeURIComponent(params.get('SESSDATA') || '');
          const bili_jct = decodeURIComponent(params.get('bili_jct') || '');
          const DedeUserID = decodeURIComponent(params.get('DedeUserID') || '');

          if (SESSDATA) {
            const parts = [`SESSDATA=${SESSDATA}`];
            if (bili_jct) parts.push(`bili_jct=${bili_jct}`);
            if (DedeUserID) parts.push(`DedeUserID=${DedeUserID}`);
            cookie = parts.join('; ');
          }
        } catch (_) {
          // ignore
        }
      }
    }

    const result = {
      success: true,
      data: {
        code: data?.data?.code,
        message: data?.data?.message || ''
      }
    };

    if (cookie) {
      result.data.cookie = cookie;
    }

    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 500);
  }
}

/**
 * 保存 Cookie（写入环境变量 BILIBILI_COOKIE）
 *
 * 重要：
 * - 不再写入 Globals/内存变量做“伪持久化”
 * - 与其它环境变量保持一致：通过 handler.setEnv 写入各部署平台
 */
export async function handleCookieSave(request) {
  try {
    const body = await request.json();
    const cookie = (body.cookie || '').trim();

    if (!cookie) {
      return jsonResponse({ success: false, message: '缺少cookie参数' }, 400);
    }

    if (!cookie.includes('SESSDATA') || !cookie.includes('bili_jct')) {
      return jsonResponse({ success: false, message: 'Cookie格式不正确' }, 400);
    }

    const verifyResult = await verifyCookieValidity(cookie);

    if (!verifyResult.isValid) {
      return jsonResponse({
        success: false,
        message: 'Cookie验证失败: ' + (verifyResult.error || '无效')
      }, 400);
    }

    // 与其它环境变量保持一致：调用各平台 handler 写入
    const deployPlatform = globals.deployPlatform;
    const handler = await HandlerFactory.getHandler(deployPlatform);
    if (!handler) {
      return jsonResponse({
        success: false,
        message: `Cookie保存失败：不支持的部署平台 ${deployPlatform || 'unknown'}`
      }, 400);
    }
    const ok = await handler.setEnv('BILIBILI_COOKIE', cookie);

    if (!ok) {
      return jsonResponse({ success: false, message: 'Cookie保存失败：环境变量写入失败' }, 500);
    }

    return jsonResponse({
      success: true,
      data: {
        uname: verifyResult.data?.uname
      },
      message: 'Cookie保存成功'
    });
  } catch (error) {
    return jsonResponse({ success: false, message: error.message }, 500);
  }
}
