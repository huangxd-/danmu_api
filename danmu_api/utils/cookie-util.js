import { jsonResponse } from './http-util.js';
import { log } from './log-util.js';
import { Globals } from '../configs/globals.js';
import { Envs } from '../configs/envs.js';

// 存储二维码登录会话（内存存储）
const qrLoginSessions = new Map();

/**
 * 保存Cookie到环境变量
 */
function saveCookieToGlobals(cookie) {
    try {
        if (Globals.envs) {
            Globals.envs.bilibliCookie = cookie;
        }
        
        if (Envs.env) {
            Envs.env.BILIBILI_COOKIE = cookie;
        }
        
        if (Envs.originalEnvVars && typeof Envs.originalEnvVars.set === 'function') {
            Envs.originalEnvVars.set('BILIBILI_COOKIE', cookie);
        }
        
        log("info", `Cookie已保存，长度: ${cookie ? cookie.length : 0}`);
    } catch (err) {
        log("error", `保存Cookie失败: ${err.message}`);
    }
}

/**
 * 从多个位置获取Cookie
 */
function getCookieFromGlobals() {
    if (Globals.envs && Globals.envs.bilibliCookie) {
        return Globals.envs.bilibliCookie;
    }
    if (Envs.env && Envs.env.BILIBILI_COOKIE) {
        return Envs.env.BILIBILI_COOKIE;
    }
    if (typeof process !== 'undefined' && process.env && process.env.BILIBILI_COOKIE) {
        return process.env.BILIBILI_COOKIE;
    }
    return '';
}

/**
 * 验证 Cookie 有效性
 */
async function verifyCookieValidity(cookie) {
    if (!cookie) {
        return { isValid: false, error: '缺少Cookie' };
    }
    
    if (!cookie.includes('SESSDATA') || !cookie.includes('bili_jct')) {
        return { isValid: false, error: 'Cookie格式不完整' };
    }
    
    try {
        const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
            method: 'GET',
            headers: {
                'Cookie': cookie,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const data = await response.json();
        
        if (data.code === 0 && data.data && data.data.isLogin) {
            return {
                isValid: true,
                data: {
                    uname: data.data.uname,
                    mid: data.data.mid,
                    face: data.data.face
                }
            };
        } else {
            return { isValid: false, error: data.message || 'Cookie无效或已过期' };
        }
    } catch (error) {
        return { isValid: false, error: '验证请求失败: ' + error.message };
    }
}

/**
 * 解析Cookie中的过期时间
 */
function parseExpiresFromCookie(cookie) {
    try {
        const sessdataMatch = cookie.match(/SESSDATA=([^;]+)/);
        if (sessdataMatch) {
            let sessdata = sessdataMatch[1];
            try {
                sessdata = decodeURIComponent(sessdata);
            } catch (e) {}
            
            const parts = sessdata.split(',');
            if (parts.length >= 2) {
                const timestamp = parseInt(parts[1], 10);
                const now = Math.floor(Date.now() / 1000);
                if (!isNaN(timestamp) && timestamp > now) {
                    return timestamp;
                }
            }
        }
    } catch (e) {}
    return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 默认30天
}

/**
 * 获取Cookie状态
 */
export async function handleCookieStatus() {
    try {
        const cookie = getCookieFromGlobals();
        
        if (!cookie) {
            return jsonResponse({
                success: true,
                data: { isValid: false }
            });
        }

        const verifyResult = await verifyCookieValidity(cookie);
        
        if (verifyResult.isValid) {
            const expiresAt = parseExpiresFromCookie(cookie);
            
            return jsonResponse({
                success: true,
                data: {
                    isValid: true,
                    uname: verifyResult.data.uname,
                    expiresAt: expiresAt
                }
            });
        } else {
            return jsonResponse({
                success: true,
                data: {
                    isValid: false,
                    error: verifyResult.error
                }
            });
        }
    } catch (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
    }
}

/**
 * 生成登录二维码
 */
export async function handleQRGenerate() {
    try {
        const response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.bilibili.com'
            }
        });

        const data = await response.json();
        
        if (data.code !== 0) {
            return jsonResponse({
                success: false,
                message: '生成二维码失败: ' + (data.message || '未知错误')
            }, 400);
        }

        const qrcodeKey = data.data.qrcode_key;
        const qrcodeUrl = data.data.url;

        // 存储session（5分钟有效期）
        qrLoginSessions.set(qrcodeKey, {
            createTime: Date.now(),
            status: 'pending'
        });

        // 清理过期session（超过5分钟）
        const now = Date.now();
        for (const [key, session] of qrLoginSessions.entries()) {
            if (now - session.createTime > 5 * 60 * 1000) {
                qrLoginSessions.delete(key);
            }
        }

        log("info", `生成二维码成功, qrcode_key: ${qrcodeKey}`);

        return jsonResponse({
            success: true,
            data: {
                qrcode_key: qrcodeKey,
                url: qrcodeUrl
            }
        });
    } catch (error) {
        log("error", `生成二维码异常: ${error.message}`);
        return jsonResponse({ success: false, message: error.message }, 500);
    }
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
                    'Referer': 'https://www.bilibili.com'
                }
            }
        );

        const data = await response.json();
        
        let cookie = null;
        let refresh_token = null;

        if (data.data.code === 0) {
            try {
                // 方法1: 从 URL 参数提取
                if (data.data.url) {
                    const url = new URL(data.data.url);
                    const params = new URLSearchParams(url.search);
                    const SESSDATA = params.get('SESSDATA') || '';
                    const bili_jct = params.get('bili_jct') || '';
                    const DedeUserID = params.get('DedeUserID') || '';
                    const DedeUserID__ckMd5 = params.get('DedeUserID__ckMd5') || '';
                    
                    if (SESSDATA) {
                        const decodedSESSDATA = decodeURIComponent(SESSDATA);
                        const decodedBiliJct = decodeURIComponent(bili_jct);
                        const decodedDedeUserID = decodeURIComponent(DedeUserID);
                        const decodedDedeUserID__ckMd5 = decodeURIComponent(DedeUserID__ckMd5);
                        
                        cookie = `SESSDATA=${decodedSESSDATA}; bili_jct=${decodedBiliJct}; DedeUserID=${decodedDedeUserID}; DedeUserID__ckMd5=${decodedDedeUserID__ckMd5}`;
                    }
                }
                
                // 方法2: 从 Set-Cookie 响应头提取（更可靠）
                const setCookieHeaders = response.headers.getSetCookie ? 
                    response.headers.getSetCookie() : 
                    [response.headers.get('set-cookie')].filter(Boolean);
                
                if (setCookieHeaders && setCookieHeaders.length > 0) {
                    let cookieParts = {};
                    
                    for (const setCookie of setCookieHeaders) {
                        if (setCookie) {
                            const parts = setCookie.split(';')[0].split('=');
                            if (parts.length >= 2) {
                                const key = parts[0].trim();
                                const value = parts.slice(1).join('=').trim();
                                if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(key)) {
                                    cookieParts[key] = value;
                                }
                            }
                        }
                    }
                    
                    if (Object.keys(cookieParts).length > 0) {
                        const cookieFromHeaders = Object.entries(cookieParts)
                            .map(([key, value]) => `${key}=${value}`)
                            .join('; ');
                        
                        if (cookieFromHeaders) {
                            cookie = cookieFromHeaders;
                            log("info", `从Set-Cookie响应头提取Cookie成功，长度: ${cookie.length}`);
                        }
                    }
                }
                
                // 提取 refresh_token
                if (data.data.refresh_token) {
                    refresh_token = data.data.refresh_token;
                }
            } catch (parseError) {
                log("error", `解析登录响应失败: ${parseError.message}`);
            }
        }

        if (qrLoginSessions.has(qrcodeKey)) {
            qrLoginSessions.get(qrcodeKey).status = data.data.code === 0 ? 'success' : 'pending';
        }

        const result = {
            success: true,
            data: {
                code: data.data.code,
                message: data.data.message || '',
                url: data.data.url || null,
                refresh_token: refresh_token
            }
        };
        
        if (cookie) {
            result.data.cookie = cookie;
        }

        return jsonResponse(result);
    } catch (error) {
        log("error", `检查二维码状态异常: ${error.message}`);
        return jsonResponse({ success: false, message: error.message }, 500);
    }
}

/**
 * 保存Cookie
 */
export async function handleCookieSave(request) {
    try {
        const body = await request.json();
        const cookie = body.cookie || '';

        if (!cookie) {
            return jsonResponse({ success: false, message: '缺少cookie参数' }, 400);
        }

        if (!cookie.includes('SESSDATA') || !cookie.includes('bili_jct')) {
            return jsonResponse({ 
                success: false, 
                message: 'Cookie格式不正确' 
            }, 400);
        }

        const verifyResult = await verifyCookieValidity(cookie);
        
        if (!verifyResult.isValid) {
            return jsonResponse({ 
                success: false, 
                message: 'Cookie验证失败: ' + (verifyResult.error || '无效')
            }, 400);
        }

        saveCookieToGlobals(cookie);

        return jsonResponse({
            success: true,
            data: {
                uname: verifyResult.data.uname
            },
            message: 'Cookie保存成功'
        });
    } catch (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
    }
}